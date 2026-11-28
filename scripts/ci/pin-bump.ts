// The pin-bump opener (cloud #20). When public has a release newer
// than PUBLIC_PIN, one PR bumps the pin (and SYNCED_FROM, with the regenerated
// lockfile); CI's pin-check port check and equivalence check judge it. On the
// PR path this script never arms or merges anything, and never opens a second PR.
// Direct mode (cloud #264, repo variable PIN_BUMP_DIRECT=on) lands without a PR:
// `plan-direct` plans with no PR checks, `stage` pushes the pin commit to
// pin-land/<tag> (never main), and `land` fast-forwards main to that exact sha
// only when a full ci.yml push run on that branch and sha passed, the commit is
// the bot's verified one and it changes only PUBLIC_PIN, SYNCED_FROM and the
// lockfile.
// Both plan-direct and land wait on the release pipeline gate pin-bump-arm uses
// (readGate, gateRefusal). land writes with its own App (PIN_LAND_APP_*), the
// only bypass actor main's ruleset needs, never with the release App.
// Usage: node --experimental-strip-types scripts/ci/pin-bump.ts plan --repo owner/name [--public owner/name]
//        node --experimental-strip-types scripts/ci/pin-bump.ts plan-direct --repo owner/name [--public owner/name]
//        node --experimental-strip-types scripts/ci/pin-bump.ts stage --repo owner/name --base <sha> --commit <sha> --tag vX.Y.Z --sha <sha>
//        node --experimental-strip-types scripts/ci/pin-bump.ts land --repo owner/name [--public owner/name]   (READ_TOKEN reads, GH_TOKEN writes, LAND_BOT is the land App's bot)
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
import {
  BOT,
  commitOk,
  gateRefusal,
  readGate,
  requiredChecks,
  WEB_FLOW,
} from "./pin-bump-arm.ts";

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
 * takes a staged one, or holds it red for a person). No PR is read. The release
 * pipeline gate pin-bump-arm applies (gateRefusal) holds it too: while a gate
 * workflow runs, or main's pin has no prod deploy and was not rejected, nothing
 * is staged. A gate that cannot be read throws (a red run).
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
  const wait = gateRefusal(readGate(o.exec, o.repo, o.pin));
  if (wait) return none(`${newest} waits: ${wait}`);
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
 * exactly what pin-bump-arm.ts arms without a person (its PIN_FILES).
 */
export const DIRECT_FILES = ["PUBLIC_PIN", "SYNCED_FROM", "pnpm-lock.yaml"];
const REQUIRED_FILES = ["PUBLIC_PIN", "SYNCED_FROM"];
/** Direct mode's staging branches: CI runs on them before main moves. */
export const LAND_PREFIX = "pin-land/";
export const landBranchOf = (tag: string) => `${LAND_PREFIX}${tag}`;

/**
 * A change on main between the pin commit's base and now that would make its
 * lockfile stale, or that moved the pin itself.
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
    ].includes(path)
  );
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
 * it only once a full ci.yml push run passed on that exact sha.
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

/**
 * Pure: a verified commit by the land App's own bot (its rebuild of a staged
 * pin on a moved main), committer that bot or web-flow. Never the release bot's
 * login, and never without a land bot.
 */
export function landBotOk(
  c: { author: string; committer: string; verified: boolean },
  landBot: string | undefined,
): boolean {
  if (!landBot || !/^[a-z0-9][a-z0-9-]{0,62}\[bot\]$/.test(landBot))
    return false;
  return (
    c.verified &&
    c.author === landBot &&
    (c.committer === landBot || c.committer === WEB_FLOW)
  );
}

/** Best effort: a branch left behind is deleted by the next run. */
function dropBranch(exec: Exec, repo: string, branch: string) {
  try {
    gh(
      exec,
      ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`],
      {
        write: true,
      },
    );
  } catch (e) {
    console.error(`pin-bump: could not delete ${branch}: ${String(e)}`);
  }
}

/** The workflow whose push run on a pin-land branch is the evidence `land` needs. */
export const CI_WORKFLOW = ".github/workflows/ci.yml";
/** The step ci.yml's jobs run only on the pin-only short path (scripts/ci/pin-only.ts). */
export const PIN_ONLY_STEP = "pin-only bot PR";

type CiRun = {
  id: number;
  path: string;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
};
type CiJob = {
  name: string;
  status: string;
  conclusion: string | null;
  steps?: { name: string; conclusion: string | null }[];
};

/**
 * The evidence a staged pin needs (cloud #264): the newest ci.yml run with event
 * push, head_branch `branch` and head_sha `head` completed with success, every
 * job named by main's required checks is in it and succeeded (skipped does not
 * count), and no job took the pin-only short path. Check names on the sha alone
 * are not enough: a pin PR's run reports them green with lint and e2e skipped.
 * Returns why to wait (no such run yet, or still running); throws when the run
 * failed or was not full, and the branch stays for a person.
 */
function fullCiRun(
  r: ReturnType<typeof reader>,
  branch: string,
  head: string,
  required: string[],
): string | undefined {
  const wf = CI_WORKFLOW.split("/").pop();
  const runs = r
    .json<{ workflow_runs?: CiRun[] }>(
      `actions/workflows/${wf}/runs?event=push&branch=${encodeURIComponent(branch)}&head_sha=${head}&per_page=100`,
    )
    .workflow_runs?.filter(
      (x) =>
        x.path === CI_WORKFLOW &&
        x.event === "push" &&
        x.head_branch === branch &&
        x.head_sha === head,
    )
    .sort((a, b) => b.id - a.id);
  const run = runs?.[0];
  if (!run) return `no ${wf} push run on ${branch} at ${head} yet`;
  if (run.status !== "completed")
    return `${wf} run ${run.id} on ${branch} at ${head} is ${run.status}`;
  const left = `the branch stays for a person`;
  if (run.conclusion !== "success")
    throw new Error(
      `${wf} run ${run.id} on ${branch} at ${head} is ${run.conclusion}: a port may be needed (README, "Hand-porting a public fix"); ${left}`,
    );
  const jobs = (
    JSON.parse(
      r.api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`, [
        "--paginate",
        "--slurp",
      ]),
    ) as { jobs: CiJob[] }[]
  ).flatMap((pg) => pg.jobs);
  for (const name of required) {
    const job = jobs.find((j) => j.name === name);
    if (job?.status !== "completed" || job.conclusion !== "success")
      throw new Error(
        `required job ${name} is ${job ? job.conclusion : "missing"} in ${wf} run ${run.id} at ${head}; ${left}`,
      );
  }
  const short = jobs.find((j) =>
    (j.steps ?? []).some(
      (s) => s.name === PIN_ONLY_STEP && s.conclusion !== "skipped",
    ),
  );
  if (short)
    throw new Error(
      `job ${short.name} in ${wf} run ${run.id} at ${head} took the pin-only short path, not a full run; ${left}`,
    );
  return undefined;
}

/**
 * Direct mode, step 2 (cloud #264): lands one pin-land/<tag> branch. Its head
 * must be the release bot's verified commit, one step on its parent, changing
 * only DIRECT_FILES to the public tag's sha, and a full ci.yml push run on
 * that branch at that exact sha must have passed, every job main's ruleset
 * requires green in it (fullCiRun: no run yet or running waits; red, skipped or
 * the pin-only short path throws, and the branch stays for a person). Then main fast-forwards to it, never with force.
 * When main has moved off the parent on paths that cannot touch the lockfile,
 * the same blobs are committed on main's head and pushed to the branch, so CI
 * runs again on what would land; a lockfile-sensitive move drops the branch and
 * throws, so the next pin-bump run regenerates.
 * Before main moves (or the branch is rebuilt), the release pipeline gate
 * (pin-bump-arm's gateRefusal, on main's current pin) must be open; a refusal
 * waits, and the next run tries again.
 * `exec` writes (the land App token); `read` reads (the job token, actions: read).
 * `landBot` is the land App's bot login: a branch it rebuilt is its commit, not
 * the release bot's, and is accepted as such.
 */
export function landBranch(o: {
  exec: Exec;
  read: Exec;
  repo: string;
  publicRepo: string;
  branch: string;
  landBot?: string;
}): LandResult {
  const m = /^pin-land\/(v\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(o.branch);
  if (!m?.[1]) throw new Error(`${o.branch} is not ${LAND_PREFIX}vX.Y.Z`);
  const tag = m[1];
  const r = reader(o.read, o.repo);
  let main = r.sha("git/ref/heads/main");
  const mainPin = r.raw("PUBLIC_PIN", main);
  const mainTag = pinField(mainPin, "tag");
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
  if (!commitOk(who) && !landBotOk(who, o.landBot))
    throw new Error(
      `${o.branch} at ${head} is not ${BOT}'s (or the land App's) verified commit (${who.author}, ${who.committer}, verified ${who.verified}); left for a person`,
    );
  const parent = hc.parents.length === 1 ? hc.parents[0]?.sha : undefined;
  if (!parent)
    throw new Error(`${head} has ${hc.parents.length} parents, not one`);
  const sha = resolveSha(o.read, o.publicRepo, tag);
  const files = checkPinCommit(r, parent, head, tag, sha);

  // A full ci.yml push run on this branch at this exact sha, every required job green.
  const required = requiredChecks(r.api("rules/branches/main"));
  if (required.length === 0)
    throw new Error("main's required checks could not be read");
  const notYet = fullCiRun(r, o.branch, head, required);
  if (notYet) return { action: "waiting", why: notYet };
  // The same release pipeline gate a PR bump waits on before it is armed.
  const wait = gateRefusal(readGate(o.read, o.repo, mainPin));
  if (wait) return { action: "waiting", why: wait };

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
  landBot?: string;
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
      gh(exec, [
        "api",
        `repos/${repo}/git/matching-refs/heads/${landBranchOf(tag)}`,
      ]),
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
      landBot: process.env.LAND_BOT || undefined,
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
    "usage: pin-bump.ts <plan|plan-direct|stage|land|apply|open-pr> ...",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
