// The scheduled pin-bump PR opener (cloud #20). When public has a release newer
// than PUBLIC_PIN, one PR bumps the pin (and SYNCED_FROM, with the regenerated
// lockfile); CI's pin-check port check and equivalence check judge it. This
// script never arms or merges anything, and never opens a second PR.
// Direct mode (cloud #264, repo variable PIN_BUMP_DIRECT=on): `plan-direct`
// plans with no PR checks, and `land` moves main to the pin commit itself, after
// checking it changes only the pin files and names the planned tag and sha.
// Usage: node --experimental-strip-types scripts/ci/pin-bump.ts plan --repo owner/name [--public owner/name]
//        node --experimental-strip-types scripts/ci/pin-bump.ts plan-direct --repo owner/name [--public owner/name]
//        node --experimental-strip-types scripts/ci/pin-bump.ts land --repo owner/name --base <sha> --commit <sha> --tag vX.Y.Z --sha <sha>
//        node --experimental-strip-types scripts/ci/pin-bump.ts apply --tag vX.Y.Z --sha <40 hex> [--dir .]
//        node --experimental-strip-types scripts/ci/pin-bump.ts open-pr --repo owner/name --tag vX.Y.Z --sha <sha> --branch pin-bump/vX.Y.Z
// `plan` prints `bump=true|false`, `tag`, `sha`, `branch` for $GITHUB_OUTPUT.
// Any API error throws, so the run is red: a bump never fails quietly.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Exec, type ExecResult, gh } from "./gh-retry.ts";

export const PUBLIC_REPO = "open-artifacts-ai/open-artifacts";
/** Every bump branch starts with this; one open PR from such a branch is the limit. */
export const BRANCH_PREFIX = "pin-bump/";
/** An open bump PR older than this turns the run red: a stuck PR must not block later tags. */
export const STALE_PR_MS = 3 * 24 * 3_600_000;
export const branchOf = (tag: string) => `${BRANCH_PREFIX}${tag}`;

export type { Exec, ExecResult };
export type Plan = {
  bump: boolean;
  tag: string;
  sha: string;
  why: string;
  /** An open bump PR this bump replaces (#425): older tag, red, not armed. */
  supersede?: number;
};

const TAG = /^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const SHA = /^[0-9a-f]{40}$/;

const parts = (tag: string) => {
  const m = TAG.exec(tag);
  if (!m) throw new Error(`${tag} isn't vX.Y.Z`);
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
};
/** Negative when a is older than b. */
export function compareTags(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The value of a `key=value` line, or throws: a pin file without it is broken. */
export function pinField(text: string, key: "tag" | "sha"): string {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  if (!m) throw new Error(`no ${key}= line`);
  return (m[1] ?? "").trim();
}

/** Sets the tag= and sha= lines and keeps every other line (comments, list=). */
export function rewritePin(text: string, tag: string, sha: string): string {
  parts(tag);
  if (!SHA.test(sha)) throw new Error(`${sha} isn't a full sha`);
  pinField(text, "tag");
  pinField(text, "sha");
  return text
    .replace(/^tag=.*$/m, `tag=${tag}`)
    .replace(/^sha=.*$/m, `sha=${sha}`);
}

/** Writes the new pin into PUBLIC_PIN and SYNCED_FROM under dir. */
export function applyPin(dir: string, tag: string, sha: string) {
  for (const f of ["PUBLIC_PIN", "SYNCED_FROM"]) {
    const p = join(dir, f);
    writeFileSync(p, rewritePin(readFileSync(p, "utf8"), tag, sha));
  }
}

type Release = { tag_name: string; draft: boolean; prerelease: boolean };
type Pr = {
  number: number;
  headRefName: string;
  url: string;
  createdAt?: string;
};

/** Check conclusions that make a PR red. Cancelled, skipped and neutral give no verdict. */
const RED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "ERROR",
]);
type Rollup = { conclusion?: string | null; state?: string | null };

/**
 * Why an open bump PR may be replaced by one for `newest` (#425), or the
 * reason it may not. Only a PR for an older tag, with no auto-merge (so not
 * armed and not in the queue) and at least one red check on its head. A green
 * or armed PR is never touched.
 */
export function supersedable(o: {
  exec: Exec;
  repo: string;
  pr: { number: number; headRefName: string };
  newest: string;
  /**
   * false in open-pr's re-check: the App token there has no checks read, and
   * the plan just found the PR red; armed and closed are what can change.
   */
  checks?: boolean;
}): { ok: true; why: string } | { ok: false; why: string } {
  const tag = o.pr.headRefName.slice(BRANCH_PREFIX.length);
  if (!TAG.test(tag) || compareTags(tag, o.newest) >= 0)
    return { ok: false, why: `its tag ${tag} is not older than ${o.newest}` };
  const v = JSON.parse(
    gh(o.exec, [
      "pr",
      "view",
      String(o.pr.number),
      "--repo",
      o.repo,
      "--json",
      o.checks === false
        ? "state,autoMergeRequest"
        : "state,autoMergeRequest,statusCheckRollup",
    ]),
  ) as {
    state: string;
    autoMergeRequest: unknown;
    statusCheckRollup: Rollup[] | null;
  };
  if (v.state !== "OPEN") return { ok: false, why: `it is ${v.state}` };
  if (v.autoMergeRequest) return { ok: false, why: "it is armed" };
  if (o.checks === false)
    return { ok: true, why: `${tag} is still open and not armed` };
  const red = (v.statusCheckRollup ?? []).filter(
    (c) => RED.has(c.conclusion ?? "") || RED.has(c.state ?? ""),
  );
  if (red.length === 0) return { ok: false, why: "no check on it is red" };
  return {
    ok: true,
    why: `${tag} is red (${red.length} checks) and not armed`,
  };
}

/** The newest stable vX.Y.Z public release, or throws. */
function newestRelease(exec: Exec, publicRepo: string): string {
  const releases = JSON.parse(
    gh(exec, ["api", `repos/${publicRepo}/releases?per_page=30`]),
  ) as Release[];
  const tags = releases
    .filter((r) => !r.draft && !r.prerelease && TAG.test(r.tag_name))
    .map((r) => r.tag_name);
  if (tags.length === 0) throw new Error("no stable vX.Y.Z public release");
  return tags.reduce((a, b) => (compareTags(a, b) >= 0 ? a : b));
}

function resolveSha(exec: Exec, publicRepo: string, tag: string): string {
  const sha = gh(exec, [
    "api",
    `repos/${publicRepo}/commits/${tag}`,
    "-q",
    ".sha",
  ]).trim();
  if (!SHA.test(sha))
    throw new Error(`${tag} resolved to '${sha}', not a full sha`);
  return sha;
}

/**
 * Direct mode's plan (cloud #264): a bump when the newest public release is
 * newer than PUBLIC_PIN. No PR is read: in direct mode the pin lands on main
 * itself, and `land` refuses a pin main already has.
 */
export function planDirect(o: {
  exec: Exec;
  publicRepo: string;
  pin: string; // PUBLIC_PIN's text
}): Plan {
  const current = pinField(o.pin, "tag");
  parts(current);
  const newest = newestRelease(o.exec, o.publicRepo);
  if (compareTags(newest, current) <= 0)
    return {
      bump: false,
      tag: "",
      sha: "",
      why: `PUBLIC_PIN ${current} is the newest release (${newest})`,
    };
  return {
    bump: true,
    tag: newest,
    sha: resolveSha(o.exec, o.publicRepo, newest),
    why: `${current} -> ${newest}, direct`,
  };
}

/** What tonight does: nothing, or one bump to the newest public release. */
export function plan(o: {
  exec: Exec;
  repo: string;
  publicRepo: string;
  pin: string; // PUBLIC_PIN's text
  now?: number;
}): Plan {
  const current = pinField(o.pin, "tag");
  parts(current);
  const none = (why: string, tag = "", sha = ""): Plan => ({
    bump: false,
    tag,
    sha,
    why,
  });

  const open = (
    JSON.parse(
      gh(o.exec, [
        "pr",
        "list",
        "--repo",
        o.repo,
        "--state",
        "open",
        "--json",
        "number,headRefName,url,createdAt",
        "--limit",
        "100",
      ]),
    ) as Pr[]
  ).find((p) => p.headRefName.startsWith(BRANCH_PREFIX));
  const stale = () => {
    if (!open) return;
    const opened = Date.parse(open.createdAt ?? "");
    if (Number.isNaN(opened))
      throw new Error(
        `${open.url} has no createdAt; cannot tell if it is stuck`,
      );
    if ((o.now ?? Date.now()) - opened > STALE_PR_MS)
      throw new Error(
        `${open.url} has been open for over 3 days; merge or close it so later releases are not blocked`,
      );
  };

  const releases = JSON.parse(
    gh(o.exec, ["api", `repos/${o.publicRepo}/releases?per_page=30`]),
  ) as Release[];
  const tags = releases
    .filter((r) => !r.draft && !r.prerelease && TAG.test(r.tag_name))
    .map((r) => r.tag_name);
  if (tags.length === 0) {
    stale();
    throw new Error("no stable vX.Y.Z public release");
  }
  const newest = tags.reduce((a, b) => (compareTags(a, b) >= 0 ? a : b));
  if (compareTags(newest, current) <= 0) {
    stale();
    return none(`PUBLIC_PIN ${current} is the newest release (${newest})`);
  }

  let supersede: number | undefined;
  if (open) {
    const s = supersedable({ exec: o.exec, repo: o.repo, pr: open, newest });
    if (!s.ok) {
      stale();
      return none(
        `${open.url} (${open.headRefName}) is open; ${newest} waits for it (${s.why})`,
        newest,
      );
    }
    supersede = open.number;
  }

  const seen = JSON.parse(
    gh(o.exec, [
      "pr",
      "list",
      "--repo",
      o.repo,
      "--state",
      "all",
      "--head",
      branchOf(newest),
      "--json",
      "number,state",
    ]),
  ) as { number: number; state: string }[];
  if (seen.length > 0)
    return none(
      `PR ${seen[0]?.number} (${seen[0]?.state}) already took ${newest}`,
      newest,
    );

  const sha = resolveSha(o.exec, o.publicRepo, newest);
  return {
    bump: true,
    tag: newest,
    sha,
    why: supersede
      ? `${current} -> ${newest}, replacing #${supersede}`
      : `${current} -> ${newest}`,
    ...(supersede ? { supersede } : {}),
  };
}

/** Opens the PR. Re-checks for an open bump PR first: a race never makes two. */
export function openPr(o: {
  exec: Exec;
  repo: string;
  publicRepo: string;
  tag: string;
  sha: string;
  branch: string;
  /** The plan's superseded PR: closed here, after a fresh check, then replaced. */
  supersede?: number;
}): { action: "opened"; url: string } | { action: "left"; url: string } {
  const open = (
    JSON.parse(
      gh(o.exec, [
        "pr",
        "list",
        "--repo",
        o.repo,
        "--state",
        "open",
        "--json",
        "number,headRefName,url,createdAt",
        "--limit",
        "100",
      ]),
    ) as Pr[]
  ).find((p) => p.headRefName.startsWith(BRANCH_PREFIX));
  if (open) {
    if (open.number !== o.supersede) return { action: "left", url: open.url };
    // Checked again: someone may have armed or fixed it since the plan.
    const s = supersedable({
      exec: o.exec,
      repo: o.repo,
      pr: open,
      newest: o.tag,
      checks: false,
    });
    if (!s.ok) return { action: "left", url: open.url };
    gh(
      o.exec,
      [
        "pr",
        "close",
        String(open.number),
        "--repo",
        o.repo,
        "--comment",
        `Replaced by the bump to ${o.tag} (cloud #425): ${s.why}. A newer release carries this one's changes; the new PR runs CI again.`,
      ],
      { write: true },
    );
  }
  const body = [
    `Bumps PUBLIC_PIN and SYNCED_FROM to the public release ${o.tag} (${o.sha}), with the lockfile regenerated in the overlay (\`pnpm install --lockfile-only\`).`,
    "",
    `Release: https://github.com/${o.publicRepo}/releases/tag/${o.tag}`,
    "",
    'Opened by the pin-bump workflow. It never arms or merges. CI decides: pin-check (the port check against the base\'s SYNCED_FROM) and equivalence must pass. If public touched a hosted path, port it in this branch (README, "Hand-porting a public fix") before merging.',
  ].join("\n");
  const url = gh(
    o.exec,
    [
      "pr",
      "create",
      "--repo",
      o.repo,
      "--base",
      "main",
      "--head",
      o.branch,
      "--title",
      `chore(pin): bump PUBLIC_PIN to ${o.tag}`,
      "--body",
      body,
    ],
    { write: true },
  ).trim();
  return { action: "opened", url };
}

/**
 * The files a pin commit may change (the ones the workflow writes), each a plain
 * modification. PUBLIC_PIN and SYNCED_FROM must be among them.
 */
export const PIN_FILES = [
  "PUBLIC_PIN",
  "SYNCED_FROM",
  "pnpm-lock.yaml",
  "tests/redline/live/manifest.json",
  "tests/redline/test/cases-added.ts",
  "tests/redline/test/surfaces.test.ts",
] as const;
const REQUIRED_FILES = ["PUBLIC_PIN", "SYNCED_FROM"];

/**
 * A change on main between the pin commit's base and now that would make its
 * lockfile or surfaces port stale, or that moved the pin itself.
 */
export function lockfileSensitive(path: string): boolean {
  return (
    path === "package.json" ||
    path.endsWith("/package.json") ||
    [
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      ".pnpmfile.cjs",
      ".nvmrc",
      "PUBLIC_PIN",
      "SYNCED_FROM",
      "scripts/overlay.sh",
    ].includes(path) ||
    path.startsWith("tests/redline/")
  );
}

/** How many times a ref update that lost a race is tried again from a fresh read. */
export const LAND_ATTEMPTS = 3;

type CompareFile = { filename: string; status: string; sha: string };
type Compare = {
  status: string;
  ahead_by: number;
  behind_by: number;
  files?: CompareFile[];
};
type GitCommit = {
  sha: string;
  message: string;
  tree: { sha: string };
  parents: { sha: string }[];
};

const NOT_FAST_FORWARD = /not a fast.?forward/i;

/**
 * POSTs a JSON body (from a file: gh api reads a nested body only that way) and
 * returns the new object's sha. Used for trees and commits, which are content
 * data: a retried write makes a duplicate object, never a second ref move.
 */
function post(exec: Exec, repo: string, path: string, body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pin-land-"));
  const file = join(dir, "body.json");
  writeFileSync(file, JSON.stringify(body));
  const sha = gh(
    exec,
    ["api", `repos/${repo}/${path}`, "--input", file, "-q", ".sha"],
    { write: true, idempotent: true },
  ).trim();
  if (!SHA.test(sha)) throw new Error(`POST ${path} gave '${sha}', not a sha`);
  return sha;
}

/**
 * Direct mode (cloud #264): moves main to the pin commit, never with force.
 * Refuses unless the commit's one parent is `base`, it changes only PIN_FILES
 * (PUBLIC_PIN and SYNCED_FROM among them, each a plain modification), and both
 * pin files name exactly `tag` and `sha`. When main has moved on paths that
 * cannot touch the lockfile, the same file blobs are committed again on main's
 * head; a lockfile-sensitive move is refused, so the next run regenerates.
 * A main whose pin is already `tag` or newer is left alone.
 */
export function land(o: {
  exec: Exec;
  repo: string;
  base: string;
  commit: string;
  tag: string;
  sha: string;
}):
  | { action: "landed"; sha: string; rebuilt: boolean }
  | { action: "already"; why: string } {
  parts(o.tag);
  for (const [k, v] of [
    ["base", o.base],
    ["commit", o.commit],
    ["sha", o.sha],
  ] as const)
    if (!SHA.test(v)) throw new Error(`--${k} ${v} isn't a full sha`);
  const api = (path: string, extra: string[] = []) =>
    gh(o.exec, ["api", `repos/${o.repo}/${path}`, ...extra]);
  const json = <T>(path: string): T => JSON.parse(api(path)) as T;
  const raw = (file: string, ref: string) =>
    api(`contents/${file}?ref=${ref}`, [
      "-H",
      "Accept: application/vnd.github.raw",
    ]);

  // a) The commit is one step on base and changes only the pin files.
  const c = json<GitCommit>(`git/commits/${o.commit}`);
  if (c.parents.length !== 1 || c.parents[0]?.sha !== o.base)
    throw new Error(
      `${o.commit}'s parents are [${c.parents.map((p) => p.sha).join(", ")}], not just ${o.base}`,
    );
  const diff = json<Compare>(`compare/${o.base}...${o.commit}`);
  if (diff.status !== "ahead" || diff.ahead_by !== 1)
    throw new Error(
      `${o.commit} is not one commit ahead of ${o.base} (${diff.status}, ${diff.ahead_by} ahead)`,
    );
  const files = diff.files ?? [];
  for (const f of files) {
    if (!(PIN_FILES as readonly string[]).includes(f.filename))
      throw new Error(`the pin commit changes ${f.filename}, not a pin file`);
    if (f.status !== "modified")
      throw new Error(`the pin commit's ${f.filename} is ${f.status}`);
  }
  for (const r of REQUIRED_FILES)
    if (!files.some((f) => f.filename === r))
      throw new Error(`the pin commit does not change ${r}`);
  // The pin files name the planned tag and sha.
  for (const f of REQUIRED_FILES) {
    const text = raw(f, o.commit);
    if (pinField(text, "tag") !== o.tag || pinField(text, "sha") !== o.sha)
      throw new Error(
        `${f} in the pin commit is ${pinField(text, "tag")} ${pinField(text, "sha")}, not ${o.tag} ${o.sha}`,
      );
  }

  for (let attempt = 1; ; attempt++) {
    // b) Where main is now.
    const main = gh(o.exec, [
      "api",
      `repos/${o.repo}/git/ref/heads/main`,
      "-q",
      ".object.sha",
    ]).trim();
    if (!SHA.test(main)) throw new Error(`main resolved to '${main}'`);
    if (main === o.commit)
      return { action: "already", why: `main is already ${o.commit}` };
    const mainTag = pinField(raw("PUBLIC_PIN", main), "tag");
    if (compareTags(mainTag, o.tag) >= 0)
      return {
        action: "already",
        why: `main's PUBLIC_PIN is ${mainTag}, not older than ${o.tag}`,
      };
    let target = o.commit;
    if (main !== o.base) {
      const moved = json<Compare>(`compare/${o.base}...${main}`);
      if (moved.status !== "ahead" || moved.behind_by !== 0)
        throw new Error(
          `main ${main} is not ahead of ${o.base} (${moved.status}); rerun pin-bump`,
        );
      const changed = moved.files ?? [];
      // compare lists at most 300 files: a list that long may be cut short.
      if (changed.length >= 300)
        throw new Error(
          `main moved by ${changed.length} files or more; rerun pin-bump`,
        );
      const hit = changed.find((f) => lockfileSensitive(f.filename));
      if (hit)
        throw new Error(
          `main moved under a lockfile-sensitive change (${hit.filename}); rerun pin-bump`,
        );
      // The same blobs, on main's tree, in a commit on main.
      const mainTree = json<GitCommit>(`git/commits/${main}`).tree.sha;
      const tree = post(o.exec, o.repo, "git/trees", {
        base_tree: mainTree,
        tree: files.map((f) => ({
          path: f.filename,
          mode: "100644",
          type: "blob",
          sha: f.sha,
        })),
      });
      target = post(o.exec, o.repo, "git/commits", {
        message: c.message,
        tree,
        parents: [main],
      });
    }
    try {
      // force=false: GitHub refuses anything but a fast-forward.
      gh(
        o.exec,
        [
          "api",
          "-X",
          "PATCH",
          `repos/${o.repo}/git/refs/heads/main`,
          "-f",
          `sha=${target}`,
          "-F",
          "force=false",
        ],
        { write: true, idempotent: true },
      );
      return { action: "landed", sha: target, rebuilt: target !== o.commit };
    } catch (e) {
      // c) main moved between the read and the write: read again.
      if (NOT_FAST_FORWARD.test(String(e)) && attempt < LAND_ATTEMPTS) continue;
      throw e;
    }
  }
}

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

const flag = (argv: string[], name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : fallback;
  if (!v) throw new Error(`missing --${name}`);
  return v;
};

/** --supersede: empty (nothing to replace) or a PR number. */
const supersedeOf = (argv: string[]) => {
  const i = argv.indexOf("--supersede");
  const v = i >= 0 ? (argv[i + 1] ?? "") : "";
  if (v === "") return undefined;
  if (!/^[1-9]\d{0,6}$/.test(v))
    throw new Error(`--supersede ${v} isn't a PR number`);
  return Number(v);
};

function main(argv: string[]) {
  const [mode] = argv;
  if (mode === "plan") {
    const p = plan({
      exec: realExec,
      repo: flag(argv, "repo"),
      publicRepo: flag(argv, "public", PUBLIC_REPO),
      pin: readFileSync("PUBLIC_PIN", "utf8"),
    });
    console.error(`pin-bump: bump=${p.bump} ${p.why}`);
    console.log(
      `bump=${p.bump}\ntag=${p.tag}\nsha=${p.sha}\nbranch=${p.tag ? branchOf(p.tag) : ""}\nsupersede=${p.supersede ?? ""}`,
    );
    return;
  }
  if (mode === "plan-direct") {
    const p = planDirect({
      exec: realExec,
      publicRepo: flag(argv, "public", PUBLIC_REPO),
      pin: readFileSync("PUBLIC_PIN", "utf8"),
    });
    console.error(`pin-bump: bump=${p.bump} ${p.why}`);
    console.log(
      `bump=${p.bump}\ntag=${p.tag}\nsha=${p.sha}\nbranch=${p.tag ? branchOf(p.tag) : ""}\nsupersede=`,
    );
    return;
  }
  if (mode === "land") {
    const r = land({
      exec: realExec,
      repo: flag(argv, "repo"),
      base: flag(argv, "base"),
      commit: flag(argv, "commit"),
      tag: flag(argv, "tag"),
      sha: flag(argv, "sha"),
    });
    if (r.action === "landed") {
      console.error(
        `pin-bump: main is now ${r.sha}${r.rebuilt ? " (rebuilt on a moved main)" : ""}`,
      );
      console.log(`landed=${r.sha}`);
    } else {
      console.error(`pin-bump: nothing to land: ${r.why}`);
      console.log("landed=");
    }
    return;
  }
  if (mode === "apply") {
    applyPin(flag(argv, "dir", "."), flag(argv, "tag"), flag(argv, "sha"));
    return;
  }
  if (mode === "open-pr") {
    const r = openPr({
      exec: realExec,
      repo: flag(argv, "repo"),
      publicRepo: flag(argv, "public", PUBLIC_REPO),
      tag: flag(argv, "tag"),
      sha: flag(argv, "sha"),
      branch: flag(argv, "branch"),
      supersede: supersedeOf(argv),
    });
    console.error(`pin-bump: ${r.action} ${r.url}`);
    return;
  }
  throw new Error(
    "usage: pin-bump.ts <plan|plan-direct|apply|open-pr|land> ...",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
