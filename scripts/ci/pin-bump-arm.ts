// Self-arm for a pin-only bump (cloud #264): the release bot's pin-bump PR is armed
// once it is provably nothing but a pin move and every required check on its current
// head is green. Anything else is left for a person.
// Usage: node --experimental-strip-types scripts/ci/pin-bump-arm.ts <plan|arm> --repo owner/name [--public owner/name]
// `plan` is read-only and prints `write=true|false` for $GITHUB_OUTPUT; `arm` re-decides
// on a fresh snapshot and enables auto-merge pinned to that head sha (a push in between
// makes GitHub refuse). Needs GH_TOKEN; `arm` runs with the release App's token.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { type Exec, type ExecResult, gh } from "./gh-retry.ts";
import {
  BRANCH_PREFIX,
  compareTags,
  PUBLIC_REPO,
  pinField,
  rewritePin,
} from "./pin-bump.ts";

export const BOT = "open-artifacts-release[bot]";
/** Files a pin-only bump may touch, each as a plain modification. */
export const PIN_FILES = ["PUBLIC_PIN", "SYNCED_FROM", "pnpm-lock.yaml"];
/** Required check names from GET /repos/{repo}/rules/branches/main; [] when unreadable (fails closed). */
export function requiredChecks(json: string): string[] {
  try {
    const rules = JSON.parse(json) as {
      type?: string;
      parameters?: { required_status_checks?: { context?: string }[] };
    }[];
    const names = rules
      .filter((r) => r.type === "required_status_checks")
      .flatMap((r) => r.parameters?.required_status_checks ?? [])
      .map((c) => String(c.context ?? ""))
      .filter(Boolean);
    return [...new Set(names)];
  } catch {
    return [];
  }
}
/** A bump branch: pin-bump/vX.Y.Z. */
export const BRANCH = /^pin-bump\/(v\d{1,6}\.\d{1,6}\.\d{1,6})$/;
const SHA = /^[0-9a-f]{40}$/;

export type PrFile = {
  filename: string;
  /** GitHub's status: added, removed, modified, renamed, copied, changed (mode), unchanged. */
  status: string;
  previous_filename?: string;
};
/** The committer GitHub records for a commit made through the API with an App token. */
export const WEB_FLOW = "web-flow";
/**
 * Pure: a commit the bot made and GitHub verified. The committer is the bot, or
 * web-flow (what GitHub records for an API-made App commit), but web-flow is
 * accepted only for a verified commit authored by exactly the bot.
 */
export const commitOk = (c: Commit) =>
  c.verified &&
  c.author === BOT &&
  (c.committer === BOT || c.committer === WEB_FLOW);
export type Commit = { author: string; committer: string; verified: boolean };
/** A root tree entry at the PR head. */
export type TreeEntry = { path: string; mode: string; type: string };
/** `app` is the slug of the app that ran the check; only github-actions counts. */
export type Check = {
  name: string;
  status: string;
  conclusion: string | null;
  app?: string;
};
/** A merge-queue (merge_group) CI run for one PR: when it was created and how it ended. */
export type QueueRun = {
  /** The run's page, https://github.com/<repo>/actions/runs/<id>; "" if unknown. */
  url?: string;
  createdAt: string;
  status: string;
  conclusion: string | null;
};
export type Input = {
  author: string;
  headRef: string;
  /** The head repo's full name; a fork never qualifies. */
  headRepo: string;
  repo: string;
  /** The PR's head sha now. */
  headOid: string;
  /** The sha the checks below were read for. */
  checksOid: string;
  files: PrFile[];
  /** PUBLIC_PIN and SYNCED_FROM at the head sha; PUBLIC_PIN on main. */
  pin: string;
  synced: string;
  mainPin: string;
  mainSynced: string;
  /** The commit the public repo's tag in PUBLIC_PIN points to, annotated tags peeled ("" if unresolved). */
  tagSha: string;
  /** The public repo has a published, non-prerelease release for that tag. */
  released: boolean;
  /** Root tree entries at the head sha. */
  tree: TreeEntry[];
  checks: Check[];
  /** Every commit on the PR, with the logins GitHub resolved for author and committer. */
  commits: Commit[];
  /** The required check names; none means unreadable, which fails closed. */
  required: string[];
  /** Auto-merge is enabled or the PR is queued. */
  armed: boolean;
  /** When the PR's head commit was made (ISO 8601); a queue run older than that is another head's. */
  headAt: string;
  /** The merge-queue CI runs for this PR, any head. */
  queueRuns: QueueRun[];
  /** Auto-merge was enabled (not queued), and by whom. */
  autoMergeBy?: string;
};
export type Decision = { arm: boolean; why: string };

const no = (why: string): Decision => ({ arm: false, why });
const field = (text: string, key: "tag" | "sha") => {
  try {
    return pinField(text, key);
  } catch {
    return "";
  }
};

/** Conclusions that hold a PR: the run itself failed. cancelled, skipped and neutral are no verdict. */
export const HOLDING = ["failure", "timed_out", "startup_failure"];
/** This many newest queue runs in a row, all cancelled, hold the PR (a cancel loop). */
export const CANCEL_LIMIT = 3;
export type QueueVerdict = {
  why: string;
  /** The run that decided, for the comment; absent for an unreadable date. */
  run?: QueueRun;
  /** Held by a run of cancelled queue runs, not by a failure. */
  cancels?: boolean;
};

/**
 * Pure: whether a PR's merge-queue history after its head commit holds it, or
 * undefined. Pin bumps run the whole suite only in the merge queue, so a failure
 * there drops the PR from the queue with every required check still green on the PR
 * head; arming it again would loop on the same head. Looking at the runs made after
 * the head commit, newest first: a newest run still going lets the PR through (a PR
 * in the queue reads armed first). Otherwise the newest run that ended failure,
 * timed_out or startup_failure holds it, unless a success is newer. cancelled,
 * skipped and neutral give no verdict: GitHub cancels a queued PR's run when a PR
 * ahead fails or the group is rebuilt, which is not this PR's fault. The one
 * exception is a loop: the newest CANCEL_LIMIT runs all cancelled also hold it. An
 * unreadable date fails closed.
 */
export function queueVerdict(
  headAt: string,
  runs: QueueRun[],
): QueueVerdict | undefined {
  const t = Date.parse(headAt);
  if (Number.isNaN(t)) return { why: "the head commit's date is unreadable" };
  const after: { r: QueueRun; at: number }[] = [];
  for (const r of runs) {
    const at = Date.parse(r.createdAt);
    if (Number.isNaN(at))
      return { why: "a merge queue run has no readable date" };
    if (at >= t) after.push({ r, at });
  }
  const newest = after.sort((a, b) => b.at - a.at).map((x) => x.r);
  const first = newest[0];
  if (!first || first.status !== "completed") return undefined;
  const top = newest.slice(0, CANCEL_LIMIT);
  if (
    top.length === CANCEL_LIMIT &&
    top.every((r) => r.status === "completed" && r.conclusion === "cancelled")
  )
    return {
      why: `its last ${CANCEL_LIMIT} merge queue runs on this head were all cancelled; a new commit or a person must act`,
      run: first,
      cancels: true,
    };
  const decisive = newest.find(
    (r) =>
      r.status === "completed" &&
      (r.conclusion === "success" || HOLDING.includes(r.conclusion ?? "")),
  );
  if (!decisive || decisive.conclusion === "success") return undefined;
  return {
    why: `its merge queue run on this head ended ${decisive.conclusion}; a new commit or a person must act`,
    run: decisive,
  };
}
/** Pure: the reason a queue run holds the PR, or undefined. */
export const queueFailure = (headAt: string, runs: QueueRun[]) =>
  queueVerdict(headAt, runs)?.why;

/** The hidden marker of the one comment per head sha that says a queue run failed. */
export const queueMarker = (head: string) =>
  `<!-- pin-bump-arm: merge queue failed head=${head} -->`;
/** Pure: the PR comment for a failed queue run. Only a github.com run page is linked. */
export function queueNotice(i: Input, repo: string): string {
  const v = queueVerdict(i.headAt, i.queueRuns);
  const run = v?.run;
  const url =
    run?.url && run.url.startsWith(`https://github.com/${repo}/actions/runs/`)
      ? run.url
      : "";
  const what = v?.cancels
    ? `was cancelled ${CANCEL_LIMIT} times in a row (GitHub cancels a run when a PR ahead fails or the group is rebuilt, so a loop of them needs a person)`
    : `ended ${run?.conclusion ?? "unknown"}`;
  return [
    queueMarker(i.headOid),
    `The merge queue run for this pin bump (head ${i.headOid.slice(0, 12)}) ${what}${url ? `: ${url}` : "."}`,
    "",
    "The checks on this PR were skipped on purpose (the suite runs once, in the merge queue), so it still looks green. pin-bump-arm will not arm this head again. A port or fix is needed. A new commit on this branch, or arming the PR by hand once the cause is fixed, is the way forward.",
  ].join("\n");
}

/** Pure: should this PR be armed? Every rule must hold; the first that fails is the reason. */
export function decide(i: Input): Decision {
  if (i.author !== BOT) return no(`author is ${i.author}, not ${BOT}`);
  const m = BRANCH.exec(i.headRef);
  if (!m) return no(`branch ${i.headRef} is not ${BRANCH_PREFIX}vX.Y.Z`);
  if (i.headRepo !== i.repo)
    return no(`head is in ${i.headRepo}, not ${i.repo}`);
  if (i.armed) return no("already armed or queued");
  const failed = queueFailure(i.headAt, i.queueRuns);
  if (failed) return no(failed);

  if (i.commits.length === 0) return no("the PR has no commits to check");
  const human = i.commits.find((c) => !commitOk(c));
  if (human)
    return no(
      `not pin-only: a commit is by ${human.author || "unknown"}, committed by ${human.committer || "unknown"}${human.verified ? "" : ", unverified"}`,
    );
  if (i.required.length === 0)
    return no("the required checks could not be read");

  const names = i.files.map((f) => f.filename);
  const bad = i.files.filter(
    (f) =>
      f.status !== "modified" ||
      f.previous_filename !== undefined ||
      !PIN_FILES.includes(f.filename),
  );
  if (i.files.length === 0) return no("the PR changes no files");
  if (bad.length > 0)
    return no(
      `not pin-only: ${bad.map((f) => `${f.filename} (${f.status})`).join(", ")}`,
    );
  if (new Set(names).size !== names.length) return no("a file is listed twice");
  for (const f of ["PUBLIC_PIN", "SYNCED_FROM"])
    if (!names.includes(f)) return no(`${f} is not changed`);
  for (const f of names) {
    const e = i.tree.find((t) => t.path === f);
    if (!e || e.mode !== "100644" || e.type !== "blob")
      return no(`${f} is not a regular file (mode ${e?.mode ?? "missing"})`);
  }

  const tag = field(i.pin, "tag");
  const sha = field(i.pin, "sha");
  if (!/^v\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(tag) || !SHA.test(sha))
    return no("PUBLIC_PIN has no valid tag= and sha=");
  if (tag !== m[1])
    return no(`PUBLIC_PIN tag ${tag} is not the branch's ${m[1]}`);
  if (!SHA.test(i.tagSha) || i.tagSha !== sha)
    return no(
      `PUBLIC_PIN sha ${sha} is not what ${tag} points to (${i.tagSha || "unresolved"})`,
    );
  if (field(i.synced, "tag") !== tag || field(i.synced, "sha") !== sha)
    return no("SYNCED_FROM does not name the same tag and sha");
  const current = field(i.mainPin, "tag");
  if (!current) return no("main's PUBLIC_PIN has no tag=");
  if (compareTags(tag, current) <= 0)
    return no(`${tag} is not newer than main's ${current}`);
  if (!i.released)
    return no(`${tag} has no published, non-prerelease public release`);
  // Byte for byte what the pin-bump job writes: main's file with only tag= and sha= moved.
  for (const [name, head, main] of [
    ["PUBLIC_PIN", i.pin, i.mainPin],
    ["SYNCED_FROM", i.synced, i.mainSynced],
  ] as const) {
    let want: string;
    try {
      want = rewritePin(main, tag, sha);
    } catch {
      return no(`main's ${name} cannot be rewritten`);
    }
    if (head !== want)
      return no(`${name} is not main's content with only tag and sha moved`);
  }

  if (!SHA.test(i.headOid) || i.checksOid !== i.headOid)
    return no("the checks are not for the PR's current head");
  for (const name of i.required) {
    const runs = i.checks.filter(
      (c) => c.name === name && c.app === "github-actions",
    );
    if (runs.length === 0)
      return no(`required check ${name} has not run on this head`);
    if (
      runs.some((c) => c.status !== "completed" || c.conclusion !== "success")
    )
      return no(`required check ${name} is not green`);
  }
  return {
    arm: true,
    why: `pin-only ${tag}, ${i.required.length} required checks green on ${i.headOid}`,
  };
}

/** Workflows that must be idle before a bump is armed (#309). */
export const GATE_WORKFLOWS = [
  "hosted-publish.yml",
  "staging-release-chain.yml",
  "deploy-hosted-platform.yml",
  "redline-staging.yml",
  "prod-release-chain.yml",
];
export const PROD_DEPLOY_WORKFLOW = "deploy-hosted-platform.yml";
export const PROD_TITLE = "deploy-hosted-platform prod ";
/** Pages of 100 successful dispatched deploy runs to look through for the pin's prod deploy. */
export const DEPLOY_PAGES = 5;
export const GATE_WORKFLOW = "redline-staging.yml";
/** The newest completed gate runs to look through for main's pin. */
export const GATE_RUNS = 20;
type GateRun = { t: string; c: string | null; a: number };
/**
 * Pure: main's pin `tag` was rejected by the gate. The newest completed run titled
 * `redline-staging <tag>` (the API lists newest first) failed on attempt 2 or later:
 * redline-retry has already rerun it once, so nothing will deploy it. A first-attempt
 * failure is not a rejection: the retry may still pass.
 */
export function gateRejected(runs: GateRun[], tag: string): boolean {
  const run = runs.find((r) => r.t === `redline-staging ${tag}`);
  return run !== undefined && run.c === "failure" && run.a >= 2;
}
/**
 * release-retry.yml reruns a failed release-chain run's failed jobs on attempts 1 and
 * 2; a failure on this attempt or later is never retried, so the stage is spent.
 */
export const RELEASE_RETRY_SPENT = 3;
/**
 * The release-chain stages before the gate whose runs carry main's pin commit as
 * their head (a push to PUBLIC_PIN, then workflow_run): hosted-release builds and
 * tags the release, hosted-publish publishes it, staging-release-chain dispatches
 * staging's deploy.
 */
export const PRE_GATE_WORKFLOWS = [
  "hosted-release.yml",
  "hosted-publish.yml",
  "staging-release-chain.yml",
];
/** Staging's chain deploy of `tag` (staging-release-chain dispatches it). */
export const stagingDeployTitle = (tag: string) =>
  `deploy-hosted-platform staging ${tag} [sc`;
export type StageRun = {
  /** status */
  s: string;
  /** conclusion */
  c: string | null;
  /** run_attempt */
  a: number;
  /** display_title */
  t: string;
};
/**
 * Pure: a release-chain stage's runs for main's pin (newest first) say it is spent:
 * the newest real run (dry runs aside) completed as a failure on attempt
 * RELEASE_RETRY_SPENT or later, so release-retry will not rerun it and the pin can
 * never reach prod. A run still queued, running or due a retry is not spent.
 */
export function stageSpent(runs: StageRun[]): boolean {
  const run = runs.find((r) => !r.t.includes("(dry run)"));
  return (
    run !== undefined &&
    run.s === "completed" &&
    run.c === "failure" &&
    run.a >= RELEASE_RETRY_SPENT
  );
}
/**
 * A full prod deploy of `tag`: the chain's run (prod-release-chain dispatches the
 * full target list, verify_only false, and puts its id in the run-name):
 * `deploy-hosted-platform prod vX.Y.Z [c<digits>-<n>]`. A title without the chain id
 * (a manual or partial run) never counts, and the tag must match whole: v0.18.0 is
 * not v0.18.0x, and a prefix of a longer tag never matches.
 */
export function isChainProdDeploy(title: string, tag: string): boolean {
  const head = `${PROD_TITLE}${tag} [`;
  return (
    title.startsWith(head) && /^c\d+-\d+\]$/.test(title.slice(head.length))
  );
}
export type Gate = {
  /** Gate workflows with a queued or in_progress run. */
  busy: string[];
  /** A successful full prod deploy (the chain's run) exists for main's current pin tag. */
  prodDeployed: boolean;
  /** main's current PUBLIC_PIN tag. */
  mainTag: string;
  /**
   * main's pin was rejected: its latest redline-staging run failed on a rerun (the
   * retry is spent), so it never reaches prod and must not hold the next bump (#448).
   */
  rejected?: boolean;
  /**
   * main's pin can't reach prod: a release-chain stage before the gate (named here)
   * failed with its retry spent (stageSpent), and no gate run of the pin passed.
   * v0.253.0's hosted-release is the case: its public npm pack failed.
   */
  dead?: string;
};
/** Pure: why a qualifying bump must wait (candidate open), or undefined. */
export function gateRefusal(g: Gate): string | undefined {
  if (g.busy.length > 0)
    return `candidate open: ${g.busy.join(", ")} queued or in progress`;
  if (!g.prodDeployed && !g.rejected && !g.dead)
    return `candidate open: main's pin ${g.mainTag} has no successful prod deploy yet`;
  return undefined;
}

export type { Exec, ExecResult };

const raw = (exec: Exec, repo: string, path: string, ref: string) =>
  gh(exec, [
    "api",
    "-H",
    "Accept: application/vnd.github.raw",
    `repos/${repo}/contents/${path}?ref=${ref}`,
  ]);

/** The commit a public tag points to: git/ref/tags, peeling annotated tags. "" if unresolved. */
export function peelTag(exec: Exec, publicRepo: string, tag: string): string {
  let obj = JSON.parse(
    gh(exec, ["api", `repos/${publicRepo}/git/ref/tags/${tag}`]),
  ).object as {
    type: string;
    sha: string;
  };
  for (let n = 0; obj.type === "tag" && n < 5; n++)
    obj = JSON.parse(
      gh(exec, ["api", `repos/${publicRepo}/git/tags/${obj.sha}`]),
    ).object;
  return obj.type === "commit" ? obj.sha : "";
}

type Listed = {
  number: number;
  user: { login: string };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
};
type View = { oid: string; armed: boolean; autoMergeBy?: string };

/** Open PRs from the bot on a bump branch. Throws on an API error. */
function listBumpPrs(exec: Exec, repo: string): Listed[] {
  return (
    JSON.parse(
      gh(exec, [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/pulls?state=open&per_page=100`,
      ]),
    ).flat() as Listed[]
  ).filter((p) => p.user.login === BOT && p.head.ref.startsWith(BRANCH_PREFIX));
}

const VIEW_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      headRefOid
      isInMergeQueue
      autoMergeRequest { enabledBy { __typename login } }
    }
  }
}`;

/**
 * Pure: the PR state from the GraphQL answer. Throws on anything unexpected, so the
 * caller fails closed. GraphQL names a bot without "[bot]", so a Bot actor's login
 * gets it back and compares equal to BOT.
 */
export function parseView(json: string): View {
  const pr = JSON.parse(json)?.data?.repository?.pullRequest;
  if (!pr || !SHA.test(String(pr.headRefOid ?? "")))
    throw new Error("unreadable pull request state");
  const queued = pr.isInMergeQueue === true;
  const auto = pr.autoMergeRequest;
  const by = auto?.enabledBy;
  const login = String(by?.login ?? "");
  return {
    oid: pr.headRefOid,
    armed: queued || Boolean(auto),
    autoMergeBy:
      auto && !queued
        ? by?.__typename === "Bot" && !login.endsWith("[bot]")
          ? `${login}[bot]`
          : login
        : undefined,
  };
}

// `gh pr view --json` lacks some fields on older gh (isInMergeQueue), so the
// state is read through GraphQL, which the runner's gh always has.
function readView(exec: Exec, repo: string, n: number): View {
  const [owner, name] = repo.split("/");
  return parseView(
    gh(exec, [
      "api",
      "graphql",
      "-f",
      `query=${VIEW_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `n=${n}`,
    ]),
  );
}

function readCommits(exec: Exec, repo: string, n: number): Commit[] {
  return (
    JSON.parse(
      gh(exec, [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/pulls/${n}/commits?per_page=100`,
      ]),
    ).flat() as {
      author: { login: string } | null;
      committer: { login: string } | null;
      commit?: { verification?: { verified?: boolean } };
    }[]
  ).map((c) => ({
    author: c.author?.login ?? "",
    committer: c.committer?.login ?? "",
    verified: c.commit?.verification?.verified === true,
  }));
}
const botOnly = (cs: Commit[]) => cs.length > 0 && cs.every(commitOk);

/** Everything else decide needs. Throws on any API error (the caller treats that as "does not qualify"). */
function gather(
  exec: Exec,
  repo: string,
  publicRepo: string,
  p: Listed,
  view: View,
  commits: Commit[],
): Input {
  const oid = p.head.sha;
  const files = JSON.parse(
    gh(exec, [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/pulls/${p.number}/files?per_page=100`,
    ]),
  ).flat() as PrFile[];
  // A bump with more than 3 files is not pin-only; its contents are not read.
  const pinOnly = files.length <= PIN_FILES.length;
  const text = (f: string, ref: string) =>
    pinOnly ? raw(exec, repo, f, ref) : "";
  const pin = text("PUBLIC_PIN", oid);
  const synced = text("SYNCED_FROM", oid);
  const tag = field(pin, "tag");
  let tagSha = "";
  let released = false;
  if (/^v\d+\.\d+\.\d+$/.test(tag)) {
    tagSha = peelTag(exec, publicRepo, tag);
    const rel = JSON.parse(
      gh(exec, ["api", `repos/${publicRepo}/releases/tags/${tag}`]),
    );
    released = rel.draft === false && rel.prerelease === false;
  }
  const tree = (
    JSON.parse(gh(exec, ["api", `repos/${repo}/git/trees/${oid}`]))
      .tree as TreeEntry[]
  ).map((t) => ({ path: t.path, mode: t.mode, type: t.type }));
  const checks = (
    JSON.parse(
      gh(exec, [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/commits/${oid}/check-runs?filter=latest&per_page=100`,
      ]),
    ) as { check_runs: (Check & { app?: { slug?: string } | null })[] }[]
  )
    .flatMap((pg) => pg.check_runs)
    .map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      app: String(c.app?.slug ?? ""),
    }));
  const headAt = String(
    JSON.parse(gh(exec, ["api", `repos/${repo}/git/commits/${oid}`])).committer
      ?.date ?? "",
  );
  // Merge-queue runs are named gh-readonly-queue/<base>/pr-<n>-<base sha>; --jq keeps
  // the page small. The newest 100 are enough: arming makes a new run every time.
  const queueRuns = JSON.parse(
    gh(exec, [
      "api",
      `repos/${repo}/actions/workflows/ci.yml/runs?event=merge_group&per_page=100`,
      "--jq",
      `[.workflow_runs[] | select(.head_branch | startswith("gh-readonly-queue/main/pr-${p.number}-")) | {url: .html_url, createdAt: .created_at, status: .status, conclusion: .conclusion}]`,
    ]),
  ) as QueueRun[];
  let required: string[] = [];
  try {
    required = requiredChecks(
      gh(exec, ["api", `repos/${repo}/rules/branches/main`]),
    );
  } catch {}
  return {
    author: p.user.login,
    headRef: p.head.ref,
    headRepo: p.head.repo?.full_name ?? "",
    repo,
    headOid: view.oid,
    checksOid: oid,
    files,
    pin,
    synced,
    mainPin: raw(exec, repo, "PUBLIC_PIN", "main"),
    mainSynced: raw(exec, repo, "SYNCED_FROM", "main"),
    tagSha,
    released,
    tree,
    checks,
    commits,
    required,
    armed: view.armed,
    headAt,
    queueRuns,
    autoMergeBy: view.autoMergeBy,
  };
}

/** True when the bot already left the failed-queue comment for this head. Throws on an API error. */
function hasQueueNotice(
  exec: Exec,
  repo: string,
  n: number,
  head: string,
): boolean {
  const marker = queueMarker(head);
  return (
    JSON.parse(
      gh(exec, [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/issues/${n}/comments?per_page=100`,
      ]),
    ).flat() as { user?: { login?: string } | null; body?: string }[]
  ).some((c) => c.user?.login === BOT && (c.body ?? "").includes(marker));
}

/** Small reads only: one count per workflow and status, one short title list. Throws on any error. */
export function readGate(exec: Exec, repo: string, mainPin: string): Gate {
  const mainTag = field(mainPin, "tag");
  if (!/^v\d+\.\d+\.\d+$/.test(mainTag))
    throw new Error("main's PUBLIC_PIN has no valid tag=");
  const busy: string[] = [];
  for (const wf of GATE_WORKFLOWS)
    for (const status of ["queued", "in_progress"]) {
      const n = Number(
        gh(exec, [
          "api",
          `repos/${repo}/actions/workflows/${wf}/runs?status=${status}&per_page=1`,
          "--jq",
          ".total_count",
        ]).trim(),
      );
      if (!Number.isInteger(n)) throw new Error(`no count for ${wf} ${status}`);
      if (n > 0 && !busy.includes(wf)) busy.push(wf);
    }
  // The API cannot filter by title, so page through the successful dispatched runs
  // (--jq keeps each page small) until main's pin tag shows up, up to a cap. Not
  // found within the cap means not deployed (fail closed).
  let prodDeployed = false;
  for (let page = 1; page <= DEPLOY_PAGES && !prodDeployed; page++) {
    const r = JSON.parse(
      gh(exec, [
        "api",
        `repos/${repo}/actions/workflows/${PROD_DEPLOY_WORKFLOW}/runs?status=success&event=workflow_dispatch&per_page=100&page=${page}`,
        "--jq",
        `{n: (.workflow_runs | length), t: [.workflow_runs[].display_title | select(startswith("${PROD_TITLE}"))]}`,
      ]),
    ) as { n: number; t: string[] };
    if (!Array.isArray(r.t) || !Number.isInteger(r.n))
      throw new Error("unreadable deploy runs");
    prodDeployed = r.t.some((t) => isChainProdDeploy(t, mainTag));
    if (r.n < 100) break;
  }
  let rejected = false;
  let dead: string | undefined;
  if (!prodDeployed) {
    const runs = JSON.parse(
      gh(exec, [
        "api",
        `repos/${repo}/actions/workflows/${GATE_WORKFLOW}/runs?status=completed&event=workflow_dispatch&per_page=${GATE_RUNS}`,
        "--jq",
        "[.workflow_runs[] | {t: .display_title, c: .conclusion, a: .run_attempt}]",
      ]),
    ) as GateRun[];
    if (!Array.isArray(runs)) throw new Error("unreadable gate runs");
    rejected = gateRejected(runs, mainTag);
    const gatePassed = runs.some(
      (r) => r.t === `redline-staging ${mainTag}` && r.c === "success",
    );
    if (!rejected && !gatePassed) dead = readDeadStage(exec, repo, mainTag);
  }
  return {
    busy,
    mainTag,
    prodDeployed,
    rejected,
    ...(dead === undefined ? {} : { dead }),
  };
}

const STAGE_JQ =
  "[.workflow_runs[] | {s: .status, c: .conclusion, a: .run_attempt, t: .display_title}]";

/**
 * The first release-chain stage before the gate that is spent for main's pin
 * (stageSpent), or undefined. Small reads: the pin's commit, then one short list per
 * stage. Throws on any error.
 */
function readDeadStage(
  exec: Exec,
  repo: string,
  tag: string,
): string | undefined {
  const sha = gh(exec, [
    "api",
    `repos/${repo}/commits?sha=main&path=PUBLIC_PIN&per_page=1`,
    "--jq",
    ".[0].sha",
  ]).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("no commit for main's pin");
  for (const wf of PRE_GATE_WORKFLOWS) {
    const runs = JSON.parse(
      gh(exec, [
        "api",
        `repos/${repo}/actions/workflows/${wf}/runs?head_sha=${sha}&per_page=20`,
        "--jq",
        STAGE_JQ,
      ]),
    ) as StageRun[];
    if (!Array.isArray(runs)) throw new Error(`unreadable ${wf} runs`);
    if (stageSpent(runs)) return wf;
  }
  const title = stagingDeployTitle(tag);
  const deploys = JSON.parse(
    gh(exec, [
      "api",
      `repos/${repo}/actions/workflows/${PROD_DEPLOY_WORKFLOW}/runs?event=workflow_dispatch&per_page=20`,
      "--jq",
      `[.workflow_runs[] | select(.display_title | startswith("${title}")) | {s: .status, c: .conclusion, a: .run_attempt, t: .display_title}]`,
    ]),
  ) as StageRun[];
  if (!Array.isArray(deploys))
    throw new Error("unreadable staging deploy runs");
  return stageSpent(deploys) ? "staging deploy" : undefined;
}

const msg = (e: unknown) => String(e instanceof Error ? e.message : e);

/**
 * Fail-safe per PR: any read error means "does not qualify". A PR this bot armed
 * then gets its auto-merge disabled; an unarmed one is left. A person's own arming
 * is never touched. The commits are read first for an armed PR, so the cheapest
 * fact disarms before anything else is read.
 */
export function run(o: {
  mode: "plan" | "arm";
  exec: Exec;
  repo: string;
  publicRepo: string;
  log: (line: string) => void;
}): {
  write: boolean;
  armed: number[];
  disarmed: number[];
  noticed: number[];
} {
  const armed: number[] = [];
  const disarmed: number[] = [];
  const noticed: number[] = [];
  let noticeError: unknown;
  let write = false;
  for (const p of listBumpPrs(o.exec, o.repo)) {
    let view: View;
    try {
      view = readView(o.exec, o.repo, p.number);
    } catch (e) {
      o.log(`#${p.number}: leave: cannot read its state: ${msg(e)}`);
      continue;
    }
    const ours = view.armed && view.autoMergeBy === BOT;
    let input: Input | undefined;
    let d: Decision;
    try {
      const commits = readCommits(o.exec, o.repo, p.number);
      if (ours && !botOnly(commits))
        d = no("a commit is not by the bot and verified");
      else {
        input = gather(o.exec, o.repo, o.publicRepo, p, view, commits);
        d = decide(input);
      }
    } catch (e) {
      d = no(`could not read what it needs: ${msg(e)}`);
    }
    o.log(`#${p.number}: ${d.arm ? "arm" : "leave"}: ${d.why}`);
    // One visible trace per head when a failed queue run is the only thing holding
    // the PR back (a PR the bump otherwise qualifies for): a comment, once per head
    // sha. The App token (pull-requests: write) posts it, so plan reports write.
    if (
      input &&
      (!input.armed || ours) &&
      queueFailure(input.headAt, input.queueRuns) &&
      decide({ ...input, armed: false, queueRuns: [] }).arm
    ) {
      try {
        if (!hasQueueNotice(o.exec, o.repo, p.number, input.headOid)) {
          write = true;
          if (o.mode === "arm") {
            gh(
              o.exec,
              [
                "api",
                "-X",
                "POST",
                `repos/${o.repo}/issues/${p.number}/comments`,
                "-f",
                `body=${queueNotice(input, o.repo)}`,
              ],
              { write: true },
            );
            noticed.push(p.number);
            o.log(`#${p.number}: commented that its merge queue run failed`);
          }
        }
      } catch (e) {
        // Logged now, thrown after the other PRs are judged: a notice that cannot
        // be left turns the run red, so it is not lost quietly.
        o.log(
          `#${p.number}: could not leave the queue failure notice: ${msg(e)}`,
        );
        noticeError ??= e;
      }
    }
    if (d.arm && input) {
      let wait: string | undefined;
      try {
        const g = readGate(o.exec, o.repo, input.mainPin);
        if (g.dead)
          o.log(
            `#${p.number}: main's pin ${g.mainTag} can't reach prod: ${g.dead} failed with its retry spent`,
          );
        wait = gateRefusal(g);
      } catch (e) {
        wait = `cannot read the release pipeline, not arming: ${msg(e)}`;
      }
      if (wait) {
        o.log(`#${p.number}: leave: ${wait}`);
        continue;
      }
      write = true;
      if (o.mode === "arm") {
        gh(
          o.exec,
          [
            "pr",
            "merge",
            String(p.number),
            "--auto",
            "--squash",
            "--match-head-commit",
            input.headOid,
            "--repo",
            o.repo,
          ],
          // Pinned to the head sha: a repeat after a 5xx enables the same
          // auto-merge again, or is refused if the head moved.
          { write: true, idempotent: true },
        );
        armed.push(p.number);
      }
      continue;
    }
    if (!ours) continue;
    // A busy pipeline never lands here: an already-armed bump is not disarmed
    // when the pipeline turns busy (arming queues it at once; the gate only
    // holds back arming).
    // Armed by this bot but not provably pin-only and green (an armed PR reads
    // "already armed" in decide, so judge it as if unarmed).
    const again = input ? decide({ ...input, armed: false }) : d;
    if (again.arm) continue;
    write = true;
    if (o.mode === "arm") {
      gh(
        o.exec,
        ["pr", "merge", String(p.number), "--disable-auto", "--repo", o.repo],
        { write: true, idempotent: true },
      );
      disarmed.push(p.number);
      o.log(`#${p.number}: disabled auto-merge: ${again.why}`);
    }
  }
  if (noticeError) throw noticeError;
  return { write, armed, disarmed, noticed };
}

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

function main(argv: string[]) {
  const [mode] = argv;
  const i = argv.indexOf("--repo");
  const repo = i >= 0 ? argv[i + 1] : "";
  const j = argv.indexOf("--public");
  const publicRepo = (j >= 0 && argv[j + 1]) || PUBLIC_REPO;
  if ((mode !== "plan" && mode !== "arm") || !repo) {
    console.error(
      "usage: pin-bump-arm.ts <plan|arm> --repo owner/name [--public owner/name]",
    );
    return 2;
  }
  const r = run({
    mode,
    exec: realExec,
    repo,
    publicRepo,
    log: (s) => console.error(`pin-bump-arm: ${s}`),
  });
  if (mode === "plan") console.log(`write=${r.write}`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
