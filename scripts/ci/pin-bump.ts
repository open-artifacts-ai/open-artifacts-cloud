// The scheduled pin-bump opener (cloud #20). When public has a release newer
// than PUBLIC_PIN, one PR bumps the pin (and SYNCED_FROM, with the regenerated
// lockfile); CI's pin-check port check and equivalence check judge it. On the
// PR path this script never arms or merges anything, and never opens a second PR.
// Direct mode (cloud #264, repo variable PIN_BUMP_DIRECT=on) lands without a PR:
// `plan-direct` plans with no PR checks, `stage` pushes the pin commit to
// pin-land/<tag> (never main), and `land` fast-forwards main to that exact sha
// only when every required check of main's ruleset is green on it, the commit is
// the bot's verified one and it changes only PUBLIC_PIN, SYNCED_FROM and the
// lockfile. A bump that also ports surfaces goes to a PR for a person (`route`).
// Usage: node --experimental-strip-types scripts/ci/pin-bump.ts plan --repo owner/name [--public owner/name]
//        node --experimental-strip-types scripts/ci/pin-bump.ts plan-direct --repo owner/name [--public owner/name]
//        node --experimental-strip-types scripts/ci/pin-bump.ts route --repo owner/name --tag vX.Y.Z --direct on|off --surfaces changed|same [--branch b --supersede n]
//        node --experimental-strip-types scripts/ci/pin-bump.ts stage --repo owner/name --base <sha> --commit <sha> --tag vX.Y.Z --sha <sha>
//        node --experimental-strip-types scripts/ci/pin-bump.ts land --repo owner/name [--public owner/name]   (READ_TOKEN reads, GH_TOKEN writes)
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
// Used only inside functions: pin-bump-arm.ts imports this module too.
import { BOT, commitOk, requiredChecks } from "./pin-bump-arm.ts";

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
 * newer than PUBLIC_PIN and is not already staged on pin-land/<tag> (`land`
 * takes a staged one, or holds it red for a person). No PR is read.
 */
export function planDirect(o: {
  exec: Exec;
  repo: string;
  publicRepo: string;
  pin: string; // PUBLIC_PIN's text
}): Plan {
  const current = pinField(o.pin, "tag");
  parts(current);
  const newest = newestRelease(o.exec, o.publicRepo);
  const none = (why: string): Plan => ({ bump: false, tag: "", sha: "", why });
  if (compareTags(newest, current) <= 0)
    return none(`PUBLIC_PIN ${current} is the newest release (${newest})`);
  if (staged(o.exec, o.repo, newest))
    return none(`${landBranchOf(newest)} is already staged; land takes it`);
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
 * The files a direct-mode pin commit may change, each a plain modification:
 * exactly what pin-bump-arm.ts arms without a person (its PIN_FILES). A bump
 * that also ports surfaces (tests/redline/...) goes to a PR for review.
 */
export const DIRECT_FILES = ["PUBLIC_PIN", "SYNCED_FROM", "pnpm-lock.yaml"];
const REQUIRED_FILES = ["PUBLIC_PIN", "SYNCED_FROM"];
/** The surfaces-port files the workflow writes; any change sends the bump to a PR. */
export const SURFACES_FILES = [
  "tests/redline/live/manifest.json",
  "tests/redline/test/cases-added.ts",
  "tests/redline/test/surfaces.test.ts",
];
/** Direct mode's staging branches: CI runs on them before main moves. */
export const LAND_PREFIX = "pin-land/";
export const landBranchOf = (tag: string) => `${LAND_PREFIX}${tag}`;

/**
 * A change on main between the pin commit's base and now that would make its
 * lockfile or surfaces port stale, or that moved the pin itself.
 * private-paths.txt decides pre-split vs strict in overlay.sh --auto-split and
 * which public paths are removed before the lockfile is regenerated.
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
      "private-paths.txt",
      "scripts/overlay.sh",
    ].includes(path) ||
    path.startsWith("tests/redline/")
  );
}

/**
 * Direct mode or a PR, for a bump the open job has written (cloud #264). Not
 * direct: the PR plan's own branch and supersede, as before. Direct with an
 * empty surfaces port: stage it. Direct with a surfaces port: a person reviews
 * it in a PR, so the PR plan is taken now, for this same tag only (anything
 * else opens nothing).
 */
export function route(o: {
  direct: boolean;
  surfacesChanged: boolean;
  tag: string;
  planned: { branch: string; supersede?: number };
  prPlan: () => Plan;
}):
  | { route: "direct" }
  | {
      route: "pr";
      pr: boolean;
      branch: string;
      supersede?: number;
      why: string;
    } {
  if (!o.direct)
    return { route: "pr", pr: true, ...o.planned, why: "PIN_BUMP_DIRECT is off" };
  if (!o.surfacesChanged) return { route: "direct" };
  const p = o.prPlan();
  if (!p.bump || p.tag !== o.tag)
    return {
      route: "pr",
      pr: false,
      branch: "",
      why: p.bump ? `the PR plan is for ${p.tag}, not ${o.tag}` : p.why,
    };
  return {
    route: "pr",
    pr: true,
    branch: branchOf(p.tag),
    supersede: p.supersede,
    why: `the surfaces port is not empty: ${o.tag} goes to a PR for a person`,
  };
}

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
const ALREADY_EXISTS = /already exists/i;

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

const reader = (exec: Exec, repo: string) => {
  const api = (path: string, extra: string[] = []) =>
    gh(exec, ["api", `repos/${repo}/${path}`, ...extra]);
  return {
    api,
    json: <T>(path: string): T => JSON.parse(api(path)) as T,
    raw: (file: string, ref: string) =>
      api(`contents/${file}?ref=${ref}`, [
        "-H",
        "Accept: application/vnd.github.raw",
      ]),
    sha: (path: string) => {
      const s = api(path, ["-q", ".object.sha"]).trim();
      if (!SHA.test(s)) throw new Error(`${path} resolved to '${s}'`);
      return s;
    },
  };
};

/**
 * The pin commit is one step on `parent`, changes only DIRECT_FILES (PUBLIC_PIN
 * and SYNCED_FROM among them, each a plain modification), and both pin files
 * name exactly `tag` and `sha`. Returns the changed files.
 */
function checkPinCommit(
  r: ReturnType<typeof reader>,
  parent: string,
  commit: string,
  tag: string,
  sha: string,
): CompareFile[] {
  const diff = r.json<Compare>(`compare/${parent}...${commit}`);
  if (diff.status !== "ahead" || diff.ahead_by !== 1)
    throw new Error(
      `${commit} is not one commit ahead of ${parent} (${diff.status}, ${diff.ahead_by} ahead)`,
    );
  const files = diff.files ?? [];
  for (const f of files) {
    if (!DIRECT_FILES.includes(f.filename))
      throw new Error(
        `the pin commit changes ${f.filename}: only ${DIRECT_FILES.join(", ")} land without a person`,
      );
    if (f.status !== "modified")
      throw new Error(`the pin commit's ${f.filename} is ${f.status}`);
  }
  for (const f of REQUIRED_FILES)
    if (!files.some((x) => x.filename === f))
      throw new Error(`the pin commit does not change ${f}`);
  for (const f of REQUIRED_FILES) {
    const text = r.raw(f, commit);
    if (pinField(text, "tag") !== tag || pinField(text, "sha") !== sha)
      throw new Error(
        `${f} in the pin commit is ${pinField(text, "tag")} ${pinField(text, "sha")}, not ${tag} ${sha}`,
      );
  }
  return files;
}

/** Points `branch` at `sha`: creates it, or moves an existing one with force. */
function pointBranch(exec: Exec, repo: string, branch: string, sha: string) {
  try {
    gh(
      exec,
      [
        "api",
        "-X",
        "POST",
        `repos/${repo}/git/refs`,
        "-f",
        `ref=refs/heads/${branch}`,
        "-f",
        `sha=${sha}`,
      ],
      { write: true },
    );
  } catch (e) {
    if (!ALREADY_EXISTS.test(String(e))) throw e;
    gh(
      exec,
      [
        "api",
        "-X",
        "PATCH",
        `repos/${repo}/git/refs/heads/${branch}`,
        "-f",
        `sha=${sha}`,
        "-F",
        "force=true",
      ],
      { write: true, idempotent: true },
    );
  }
}

/**
 * Direct mode, step 1 (cloud #264): checks the fresh pin commit and pushes it to
 * pin-land/<tag>, where CI runs in full. Main does not move here: `land` moves
 * it only once every required check is green on that exact sha.
 */
export function stage(o: {
  exec: Exec;
  repo: string;
  base: string;
  commit: string;
  tag: string;
  sha: string;
}): { branch: string; sha: string } {
  parts(o.tag);
  for (const [k, v] of [
    ["base", o.base],
    ["commit", o.commit],
    ["sha", o.sha],
  ] as const)
    if (!SHA.test(v)) throw new Error(`--${k} ${v} isn't a full sha`);
  const r = reader(o.exec, o.repo);
  const c = r.json<GitCommit>(`git/commits/${o.commit}`);
  if (c.parents.length !== 1 || c.parents[0]?.sha !== o.base)
    throw new Error(
      `${o.commit}'s parents are [${c.parents.map((p) => p.sha).join(", ")}], not just ${o.base}`,
    );
  checkPinCommit(r, o.base, o.commit, o.tag, o.sha);
  const branch = landBranchOf(o.tag);
  pointBranch(o.exec, o.repo, branch, o.commit);
  return { branch, sha: o.commit };
}

export type LandResult =
  | { action: "landed"; sha: string }
  | { action: "retest"; sha: string; why: string }
  | { action: "waiting"; why: string }
  | { action: "already"; why: string };

/** Best effort: a branch left behind is deleted by the next run. */
function dropBranch(exec: Exec, repo: string, branch: string) {
  try {
    gh(exec, ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`], {
      write: true,
    });
  } catch (e) {
    console.error(`pin-bump: could not delete ${branch}: ${String(e)}`);
  }
}

/**
 * Direct mode, step 2 (cloud #264): lands one pin-land/<tag> branch. Its head
 * must be the release bot's verified commit, one step on its parent, changing
 * only DIRECT_FILES to the public tag's sha, with every required check of
 * main's ruleset green on that exact sha (pending waits; red throws, and the
 * branch stays for a person). Then main fast-forwards to it, never with force.
 * When main has moved off the parent on paths that cannot touch the lockfile,
 * the same blobs are committed on main's head and pushed to the branch, so CI
 * runs again on what would land; a lockfile-sensitive move drops the branch and
 * throws, so the next pin-bump run regenerates.
 * `exec` writes (the App token); `read` reads (the job token, checks: read).
 */
export function landBranch(o: {
  exec: Exec;
  read: Exec;
  repo: string;
  publicRepo: string;
  branch: string;
}): LandResult {
  const m = /^pin-land\/(v\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(o.branch);
  if (!m?.[1]) throw new Error(`${o.branch} is not ${LAND_PREFIX}vX.Y.Z`);
  const tag = m[1];
  const r = reader(o.read, o.repo);
  let main = r.sha("git/ref/heads/main");
  const mainTag = pinField(r.raw("PUBLIC_PIN", main), "tag");
  if (compareTags(mainTag, tag) >= 0) {
    dropBranch(o.exec, o.repo, o.branch);
    return {
      action: "already",
      why: `main's PUBLIC_PIN is ${mainTag}, not older than ${tag}`,
    };
  }
  const head = r.sha(`git/ref/heads/${o.branch}`);
  const hc = r.json<{
    author: { login?: string } | null;
    committer: { login?: string } | null;
    parents: { sha: string }[];
    commit: { message: string; verification?: { verified?: boolean } };
  }>(`commits/${head}`);
  const who = {
    author: hc.author?.login ?? "",
    committer: hc.committer?.login ?? "",
    verified: hc.commit.verification?.verified === true,
  };
  if (!commitOk(who))
    throw new Error(
      `${o.branch} at ${head} is not ${BOT}'s verified commit (${who.author}, ${who.committer}, verified ${who.verified}); left for a person`,
    );
  const parent = hc.parents.length === 1 ? hc.parents[0]?.sha : undefined;
  if (!parent)
    throw new Error(`${head} has ${hc.parents.length} parents, not one`);
  const sha = resolveSha(o.read, o.publicRepo, tag);
  const files = checkPinCommit(r, parent, head, tag, sha);

  // Every required check of main's ruleset, by GitHub Actions, on this sha.
  const required = requiredChecks(r.api("rules/branches/main"));
  if (required.length === 0)
    throw new Error("main's required checks could not be read");
  const runs = (
    JSON.parse(
      gh(o.read, [
        "api",
        "--paginate",
        "--slurp",
        `repos/${o.repo}/commits/${head}/check-runs?filter=latest&per_page=100`,
      ]),
    ) as {
      check_runs: {
        name: string;
        status: string;
        conclusion: string | null;
        app?: { slug?: string } | null;
      }[];
    }[]
  )
    .flatMap((pg) => pg.check_runs)
    .filter((c) => c.app?.slug === "github-actions");
  const pending: string[] = [];
  for (const name of required) {
    const got = runs.filter((c) => c.name === name);
    const red = got.find(
      (c) => c.status === "completed" && c.conclusion !== "success",
    );
    if (red)
      throw new Error(
        `required check ${name} is ${red.conclusion} on ${o.branch} at ${head}: a port may be needed (README, "Hand-porting a public fix"); the branch stays for a person`,
      );
    if (got.length === 0 || got.some((c) => c.status !== "completed"))
      pending.push(name);
  }
  if (pending.length > 0)
    return {
      action: "waiting",
      why: `${pending.join(", ")} not done on ${head}`,
    };

  if (main === parent) {
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
          `sha=${head}`,
          "-F",
          "force=false",
        ],
        { write: true, idempotent: true },
      );
      dropBranch(o.exec, o.repo, o.branch);
      return { action: "landed", sha: head };
    } catch (e) {
      // main moved between the read and the write: rebuild on the new main.
      if (!NOT_FAST_FORWARD.test(String(e))) throw e;
      main = r.sha("git/ref/heads/main");
    }
  }
  const moved = r.json<Compare>(`compare/${parent}...${main}`);
  const changed = moved.files ?? [];
  // compare lists at most 300 files: a list that long may be cut short.
  const why =
    moved.status !== "ahead" || moved.behind_by !== 0
      ? `main ${main} is not ahead of ${parent} (${moved.status})`
      : changed.length >= 300
        ? `main moved by ${changed.length} files or more`
        : changed
            .filter((f) => lockfileSensitive(f.filename))
            .map((f) => `a lockfile-sensitive change (${f.filename})`)[0];
  if (why) {
    dropBranch(o.exec, o.repo, o.branch);
    throw new Error(`${why}; the next pin-bump run regenerates ${tag}`);
  }
  // The same blobs, on main's tree, in a commit on main; CI runs on it next.
  const mainTree = r.json<GitCommit>(`git/commits/${main}`).tree.sha;
  const tree = post(o.exec, o.repo, "git/trees", {
    base_tree: mainTree,
    tree: files.map((f) => ({
      path: f.filename,
      mode: "100644",
      type: "blob",
      sha: f.sha,
    })),
  });
  const next = post(o.exec, o.repo, "git/commits", {
    message: hc.commit.message,
    tree,
    parents: [main],
  });
  pointBranch(o.exec, o.repo, o.branch, next);
  return {
    action: "retest",
    sha: next,
    why: `main moved to ${main}; ${o.branch} rebuilt on it, CI runs again`,
  };
}

/** Lands every pin-land/* branch in turn; any one that throws makes the whole run red. */
export function land(o: {
  exec: Exec;
  read: Exec;
  repo: string;
  publicRepo: string;
}): { branch: string; result?: LandResult; error?: string }[] {
  const refs = JSON.parse(
    gh(o.read, [
      "api",
      `repos/${o.repo}/git/matching-refs/heads/${LAND_PREFIX}`,
    ]),
  ) as { ref: string }[];
  return refs
    .map((x) => x.ref.replace(/^refs\/heads\//, ""))
    .map((branch) => {
      try {
        return { branch, result: landBranch({ ...o, branch }) };
      } catch (e) {
        return { branch, error: String(e instanceof Error ? e.message : e) };
      }
    });
}

/** Whether pin-land/<tag> exists (a staged bump that `land` has not finished). */
export function staged(exec: Exec, repo: string, tag: string): boolean {
  const want = `refs/heads/${landBranchOf(tag)}`;
  return (
    JSON.parse(
      gh(exec, ["api", `repos/${repo}/git/matching-refs/heads/${landBranchOf(tag)}`]),
    ) as { ref: string }[]
  ).some((x) => x.ref === want);
}

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

const gitShow = (spec: string) => {
  const r = spawnSync("git", ["show", spec], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git show ${spec}: ${r.stderr.trim()}`);
  return r.stdout;
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
      repo: flag(argv, "repo"),
      publicRepo: flag(argv, "public", PUBLIC_REPO),
      pin: readFileSync("PUBLIC_PIN", "utf8"),
    });
    console.error(`pin-bump: bump=${p.bump} ${p.why}`);
    console.log(
      `bump=${p.bump}\ntag=${p.tag}\nsha=${p.sha}\nbranch=${p.tag ? branchOf(p.tag) : ""}\nsupersede=`,
    );
    return;
  }
  if (mode === "route") {
    const surfaces = flag(argv, "surfaces");
    if (surfaces !== "changed" && surfaces !== "same")
      throw new Error(`--surfaces ${surfaces} isn't changed or same`);
    const repo = flag(argv, "repo");
    const r = route({
      direct: flag(argv, "direct") === "on",
      surfacesChanged: surfaces === "changed",
      tag: flag(argv, "tag"),
      planned: {
        branch: argv.includes("--branch") ? flag(argv, "branch") : "",
        supersede: supersedeOf(argv),
      },
      prPlan: () =>
        plan({
          exec: realExec,
          repo,
          publicRepo: flag(argv, "public", PUBLIC_REPO),
          // main's own pin: the working tree's was already moved by apply.
          pin: gitShow("HEAD:PUBLIC_PIN"),
        }),
    });
    if (r.route === "direct") {
      console.error("pin-bump: route=direct");
      console.log("route=direct\npr=false\nbranch=\nsupersede=");
    } else {
      console.error(`pin-bump: route=pr pr=${r.pr} ${r.why}`);
      console.log(
        `route=pr\npr=${r.pr}\nbranch=${r.branch}\nsupersede=${r.supersede ?? ""}`,
      );
    }
    return;
  }
  if (mode === "stage") {
    const r = stage({
      exec: realExec,
      repo: flag(argv, "repo"),
      base: flag(argv, "base"),
      commit: flag(argv, "commit"),
      tag: flag(argv, "tag"),
      sha: flag(argv, "sha"),
    });
    console.error(
      `pin-bump: staged ${r.sha} on ${r.branch}; main moves when CI is green on it`,
    );
    return;
  }
  if (mode === "land") {
    const token = process.env.READ_TOKEN;
    if (!token) throw new Error("land reads with READ_TOKEN, which is unset");
    const results = land({
      exec: realExec,
      read: (cmd, args) => {
        const r = spawnSync(cmd, args, {
          encoding: "utf8",
          env: { ...process.env, GH_TOKEN: token },
        });
        return {
          code: r.status ?? 1,
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
        };
      },
      repo: flag(argv, "repo"),
      publicRepo: flag(argv, "public", PUBLIC_REPO),
    });
    for (const x of results)
      console.error(
        x.error
          ? `pin-bump: ${x.branch}: ${x.error}`
          : `pin-bump: ${x.branch}: ${x.result?.action} ${JSON.stringify(x.result)}`,
      );
    if (results.length === 0) console.error("pin-bump: nothing staged");
    if (results.some((x) => x.error))
      throw new Error("a staged pin could not land (above)");
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
    "usage: pin-bump.ts <plan|plan-direct|route|stage|land|apply|open-pr> ...",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
