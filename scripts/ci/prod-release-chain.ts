// The automatic prod release chain (#1343, prod-release-chain.yml): a green
// redline-staging dispatch for a release tag deploys that tag to the prod
// platform, and the scheduler's fleet duty (#955) takes it from there.
// Event-driven (cloud #264): each step starts on the previous step's
// workflow_run event and ends once it has started the next; nothing waits,
// sleeps or polls for a run.
//   redline-staging green  -> gate, then dispatch hosted-publish (prod), or
//                             the deploy when prod's bucket has the release
//   that publish completed -> check it, then dispatch deploy-hosted-platform
//   that deploy completed  -> check it, then the blocker issue
// `plan` classifies one workflow_run event from its own fields (no API call):
// which step, the tag, the run that ended. `tag` reads the tag from a red-line
// run's display title (redline-staging.yml's run-name, the shape
// staging-first-gate.sh matches); `fresh` says whether this event is the
// newest gated run for the tag; `newer` whether the tag is above what prod's
// scheduler runs. Both print `go=true|false`: false is a neutral skip (a
// stale or repeated event, a release prod already runs), not a failure.
// `require-newer` is the deploy's re-check, which fails instead. `child`
// reads the run that ended and checks it is the chain's own, for the tag;
// `start` decides what to dispatch next (never twice); `result` folds the
// jobs into one result and `report` keeps one `blocker` issue open while the
// chain is red.
// Usage: node --experimental-strip-types scripts/ci/prod-release-chain.ts plan --repo owner/name --switch <on> --workflow <path> --conclusion <c> --event <e> --branch <b> --head-repo <owner/name> --title <t> --actor <a> --run-id <id>
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts tag --title "<display_title>"
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts fresh --repo owner/name --tag vX.Y.Z --head-sha <sha>
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts newer --tag vX.Y.Z --current vX.Y.Z
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts require-newer --tag vX.Y.Z --current vX.Y.Z
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts published --repo owner/name --public-repo owner/name --tag vX.Y.Z
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts child --repo owner/name --workflow publish|deploy --run-id <id> --tag vX.Y.Z
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts start --repo owner/name --public-repo owner/name --after gate|publish --tag vX.Y.Z
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts result --step gate|deploy|report --plan <r> --gate <r> --start <r> --deploy <r> --finish <r> --state <s>
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts report --repo owner/name --tag vX.Y.Z --result success --run <url>
// Every other failure throws (exit 1): the chain fails closed. Needs GH_TOKEN for
// fresh, published, child, start and report.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** redline-staging.yml's run-name for one tag: `redline-staging ${{ inputs.tag }}`. */
export const TITLE_RE = /^redline-staging (v\d{1,6}\.\d{1,6}\.\d{1,6})$/;
const TAG_RE = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const ISSUE = "Prod release chain";
/**
 * The release App's public login: the actor of a run the chain dispatched
 * (staging-release-chain.ts holds the same). Not imported: deploy-hosted-platform.yml
 * copies this file alone to run require-newer.
 */
export const APP_ACTOR = "open-artifacts-release[bot]";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;
type Run = {
  id: number;
  status: string;
  conclusion: string | null;
  display_title?: string;
  head_branch?: string;
  head_sha?: string;
  event?: string;
  created_at?: string;
  head_repository?: { full_name?: string } | null;
};

function gh(exec: Exec, args: string[]): string {
  const r = exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}

/** The release tag a red-line run's display title names; anything else throws. */
export function tagOf(title: string): string {
  const m = TITLE_RE.exec(title);
  if (!m?.[1]) throw new Error("not a redline-staging run for a release tag");
  return m[1];
}

const parts = (tag: string): [number, number, number] => {
  if (!TAG_RE.test(tag)) throw new Error(`not a release tag: ${tag}`);
  const [a, b, c] = tag.slice(1).split(".").map(Number);
  return [a ?? 0, b ?? 0, c ?? 0];
};

/** True iff `tag` is a higher release than `current`; either malformed throws. */
export function isNewer(tag: string, current: string): boolean {
  const t = parts(tag);
  const c = parts(current);
  for (let i = 0; i < 3; i++)
    if ((t[i] ?? 0) !== (c[i] ?? 0)) return (t[i] ?? 0) > (c[i] ?? 0);
  return false;
}

/**
 * Whether the newest run staging-first-gate.sh would accept for `tag` (the
 * same filter: completed, success, dispatched, on main, this repository,
 * titled for the tag) has `headSha`. If not, this event is stale and an
 * event for the newer run acts instead: go is false. No such run at all, an
 * API error or a bad input throws. The 7-day window and the artifact are
 * staging-first-gate.sh's.
 */
export function fresh(o: {
  exec: Exec;
  repo: string;
  tag: string;
  headSha: string;
}): { run: number; go: boolean } {
  if (!TAG_RE.test(o.tag)) throw new Error(`not a release tag: ${o.tag}`);
  if (!SHA_RE.test(o.headSha)) throw new Error("the event has no head sha");
  const body = JSON.parse(
    gh(o.exec, [
      "api",
      "-X",
      "GET",
      "--jq",
      "{workflow_runs: [.workflow_runs[]? | {id, display_title, status, conclusion, event, head_branch, head_sha, created_at, html_url, actor: {login: .actor.login}, head_repository: {full_name: .head_repository.full_name}}]}",
      `repos/${o.repo}/actions/workflows/redline-staging.yml/runs?branch=main&status=success&event=workflow_dispatch&per_page=30`,
    ]),
  ) as { workflow_runs?: Run[] };
  if (!Array.isArray(body.workflow_runs))
    throw new Error("unparsable redline-staging.yml runs");
  const title = `redline-staging ${o.tag}`;
  const newest = body.workflow_runs
    .filter(
      (r) =>
        r.status === "completed" &&
        r.conclusion === "success" &&
        r.head_branch === "main" &&
        r.event === "workflow_dispatch" &&
        (r.head_repository?.full_name ?? "") === o.repo &&
        (r.display_title ?? "") === title,
    )
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
    .at(-1);
  if (!newest) throw new Error(`no green redline-staging run for ${o.tag}`);
  return { run: newest.id, go: newest.head_sha === o.headSha };
}

/** GitHub lists at most this many runs for one query (cloud-flaky-tracker.ts). */
export const LIST_MAX = 1000;
const PER_PAGE = 100;
const DAY_MS = 24 * 3600 * 1000;
const RUNS_JQ =
  "{total_count, workflow_runs: [.workflow_runs[]? | {id, display_title, status, conclusion, event, head_branch, head_sha, created_at, html_url, actor: {login: .actor.login}, head_repository: {full_name: .head_repository.full_name}}]}";

/**
 * The earliest time a run for `tag` can have been created: the committer
 * date of the tag's commit in the public repo, less a day for clock skew.
 * Nothing is dispatched for a tag before the tag exists, so every run for it
 * is newer. A missing, unparsable or future date throws.
 */
export function releasedSince(o: {
  exec: Exec;
  publicRepo: string;
  tag: string;
  nowMs: number;
}): string {
  if (!TAG_RE.test(o.tag)) throw new Error(`not a release tag: ${o.tag}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.publicRepo))
    throw new Error("--public-repo owner/name is required");
  const date = gh(o.exec, [
    "api",
    "-X",
    "GET",
    "--jq",
    ".commit.committer.date",
    `repos/${o.publicRepo}/commits/${o.tag}`,
  ]).trim();
  const ms = Date.parse(date);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(date) || Number.isNaN(ms))
    throw new Error(`no commit date for ${o.tag} in ${o.publicRepo}`);
  if (ms > o.nowMs + DAY_MS)
    throw new Error(`the commit date of ${o.tag} (${date}) is in the future`);
  return new Date(ms - DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Every run a list-workflow-runs query (`path`, with a query string but no
 * created, page or per_page) finds created at or after `since`, page by
 * page until a short page: one paged read, no waiting. It never returns a
 * partial list: a page that does not parse, a first page counting LIST_MAX
 * runs or more (GitHub lists no more for one query), more pages than that,
 * or fewer distinct runs than the first page counted (one deleted while
 * reading) all throw.
 */
export function allRuns(exec: Exec, path: string, since: string): Run[] {
  const created = encodeURIComponent(`>=${since}`);
  const byId = new Map<number, Run>();
  let total = 0;
  for (let p = 1; ; p++) {
    if (p > LIST_MAX / PER_PAGE)
      throw new Error(
        `more than ${LIST_MAX} runs of ${path}: refusing a partial list`,
      );
    const body = JSON.parse(
      gh(exec, [
        "api",
        "-X",
        "GET",
        "--jq",
        RUNS_JQ,
        `${path}&created=${created}&per_page=${PER_PAGE}&page=${p}`,
      ]),
    ) as { total_count?: unknown; workflow_runs?: unknown };
    const rows = body.workflow_runs;
    if (!Array.isArray(rows) || typeof body.total_count !== "number")
      throw new Error(`unparsable page ${p} of ${path}`);
    if (p === 1) {
      total = body.total_count;
      if (total >= LIST_MAX)
        throw new Error(
          `${total} runs of ${path}: GitHub lists at most ${LIST_MAX}, refusing a partial list`,
        );
    }
    for (const r of rows as Run[]) {
      if (!Number.isSafeInteger(r?.id))
        throw new Error(`unparsable page ${p} of ${path}`);
      byId.set(r.id, r);
    }
    if (rows.length < PER_PAGE) break;
  }
  if (byId.size < total)
    throw new Error(
      `read ${byId.size} of ${total} runs of ${path}: refusing a partial list`,
    );
  return [...byId.values()];
}

/**
 * Whether `tag`'s release is already in prod's bucket (#1412): a completed
 * hosted-publish.yml run on main, of this repository, whose publish-prod job
 * for the release succeeded (the job is named "publish-prod release <tag>").
 * Publishing is create-only, so the chain must not publish it twice. Every
 * run since the tag's release is read (allRuns), so an older publish on a
 * later page still counts. An API error, an unparsable or incomplete answer
 * throws.
 */
export function published(o: {
  exec: Exec;
  repo: string;
  tag: string;
  /** releasedSince: no run for the tag is older. */
  since: string;
}): boolean {
  if (!TAG_RE.test(o.tag)) throw new Error(`not a release tag: ${o.tag}`);
  const runs = allRuns(
    o.exec,
    `repos/${o.repo}/actions/workflows/hosted-publish.yml/runs?branch=main&status=completed`,
    o.since,
  );
  const name = `publish-prod release ${o.tag}`;
  for (const r of runs) {
    if (
      r.head_branch !== "main" ||
      r.status !== "completed" ||
      (r.head_repository?.full_name ?? "") !== o.repo
    )
      continue;
    const jobs = JSON.parse(
      gh(o.exec, [
        "api",
        "-X",
        "GET",
        `repos/${o.repo}/actions/runs/${r.id}/jobs?per_page=100`,
      ]),
    ) as { jobs?: { name?: string; conclusion?: string | null }[] };
    if (!Array.isArray(jobs.jobs))
      throw new Error(`unparsable jobs of run ${r.id}`);
    const ok = (n: string) =>
      jobs.jobs?.some((j) => j.name === n && j.conclusion === "success");
    if (ok(name)) return true;
    // Runs before the job was named for its tag (v0.142.0, v0.144.0): a plain
    // "publish-prod" that succeeded next to this tag's staging publish.
    if (ok("publish-prod") && ok(`publish-staging release ${o.tag}`))
      return true;
  }
  return false;
}

const WORKFLOW_DIR = ".github/workflows/";
/** The runs this chain dispatches, by step (scripts/ci/chain-dispatch.ts). */
const CHILD = {
  publish: {
    file: "hosted-publish.yml",
    // hosted-publish.yml's run-name for a chain dispatch (env prod, a tag, a chain id).
    title:
      /^hosted-publish prod (v\d{1,6}\.\d{1,6}\.\d{1,6}) \[(p[0-9]{1,20}-[0-9]{1,4})\]$/,
  },
  deploy: {
    file: "deploy-hosted-platform.yml",
    // deploy-hosted-platform.yml's run-name for a chain dispatch.
    title:
      /^deploy-hosted-platform prod (v\d{1,6}\.\d{1,6}\.\d{1,6}) \[(c[0-9]{1,20}-[0-9]{1,4})\]$/,
  },
} as const;
export type Child = keyof typeof CHILD;
const RUN_ID_RE = /^[1-9][0-9]{0,19}$/;

export type Step = "gate" | "deploy" | "report" | "none";
export type Plan =
  | { step: "gate"; tag: string }
  | { step: "deploy" | "report"; tag: string; child: string }
  | { step: "none"; why: string };

/**
 * Which step one workflow_run event starts, from the event's own fields only
 * (no API call, so an unrelated event can never fail the chain):
 *   - a redline-staging run, green, dispatched: the gate. Its tag is the
 *     display title's (empty if the title is not a release's: the gate's own
 *     tag step then fails red, as before);
 *   - a hosted-publish run this chain dispatched (event workflow_dispatch,
 *     the release App's bot, title `hosted-publish prod <tag> [p<run>-<n>]`),
 *     in any conclusion: `deploy`, which checks it and starts the deploy;
 *   - a deploy-hosted-platform run this chain dispatched (title
 *     `deploy-hosted-platform prod <tag> [c<run>-<n>]`): `report`.
 * Everything else is `none`: the switch is off, the run is not on main or
 * not this repository's, a staging copy or deploy, a hand dispatch, a floor.
 */
export function plan(o: {
  repo: string;
  /** The repo variable PROD_RELEASE_CHAIN: the chain runs only when it is `on`. */
  switch: string;
  /** The event run's workflow file (workflow_run.path): a run-name replaces the name. */
  workflow: string;
  conclusion: string;
  event: string;
  branch: string;
  headRepo: string;
  title: string;
  actor: string;
  runId: string;
}): Plan {
  const none = (why: string): Plan => ({ step: "none", why });
  if (o.switch !== "on") return none("PROD_RELEASE_CHAIN is not on");
  if (o.branch !== "main") return none("the run is not on main");
  if (o.headRepo !== o.repo) return none("the run is not this repository's");
  const file = o.workflow.replace(/@.*$/, "");
  if (file === `${WORKFLOW_DIR}redline-staging.yml`) {
    if (o.conclusion !== "success")
      return none(`the red-line run concluded ${o.conclusion}`);
    // The nightly calls redline-staging, so its runs never count.
    if (o.event !== "workflow_dispatch")
      return none("not a dispatched red-line run");
    return { step: "gate", tag: TITLE_RE.exec(o.title)?.[1] ?? "" };
  }
  for (const [which, step] of [
    ["publish", "deploy"],
    ["deploy", "report"],
  ] as const) {
    if (file !== WORKFLOW_DIR + CHILD[which].file) continue;
    const m = CHILD[which].title.exec(o.title);
    if (o.event !== "workflow_dispatch" || o.actor !== APP_ACTOR || !m?.[1])
      return none(`not a prod ${which} this chain dispatched`);
    if (!RUN_ID_RE.test(o.runId)) throw new Error("bad run id");
    return { step, tag: m[1], child: o.runId };
  }
  return none(`unexpected workflow ${o.workflow}`);
}

export type ChildState = {
  state: "success" | "running" | "failed";
  url: string;
  conclusion: string;
};

/**
 * The run whose end started this step, read again by id (its newest attempt,
 * so a rerun in progress is `running`, not the failure the event carried).
 * It must be the chain's own run of that workflow for exactly this tag: the
 * workflow file, event workflow_dispatch, the release App's bot, branch main,
 * this repository, and the chain's run name for the tag. Anything else
 * throws: the chain fails closed.
 */
export function child(o: {
  exec: Exec;
  repo: string;
  which: Child;
  runId: string;
  tag: string;
}): ChildState {
  if (!TAG_RE.test(o.tag)) throw new Error(`not a release tag: ${o.tag}`);
  if (!RUN_ID_RE.test(o.runId)) throw new Error("bad run id");
  const r = JSON.parse(
    // One run object (a few KB), not a list: no --jq needed.
    gh(o.exec, ["api", "-X", "GET", `repos/${o.repo}/actions/runs/${o.runId}`]),
  ) as Run & { path?: string; html_url?: string; actor?: { login?: string } };
  const c = CHILD[o.which];
  const ours =
    String(r.id) === o.runId &&
    (r.path ?? "").replace(/@.*$/, "") === WORKFLOW_DIR + c.file &&
    r.event === "workflow_dispatch" &&
    r.head_branch === "main" &&
    (r.head_repository?.full_name ?? "") === o.repo &&
    r.actor?.login === APP_ACTOR &&
    c.title.exec(r.display_title ?? "")?.[1] === o.tag;
  if (!ours)
    throw new Error(
      `run ${o.runId} is not this chain's prod ${o.which} of ${o.tag}`,
    );
  const url =
    r.html_url ?? `https://github.com/${o.repo}/actions/runs/${o.runId}`;
  if (r.status !== "completed")
    return { state: "running", url, conclusion: "" };
  const conclusion = r.conclusion ?? "none";
  return {
    state: conclusion === "success" ? "success" : "failed",
    url,
    conclusion,
  };
}

/**
 * The chain's own runs of a workflow for a tag (its chain run name): every
 * dispatched run on main since the tag's release, all pages (allRuns).
 */
function chainRuns(
  exec: Exec,
  repo: string,
  which: Child,
  tag: string,
  since: string,
): Run[] {
  const c = CHILD[which];
  const runs = allRuns(
    exec,
    `repos/${repo}/actions/workflows/${c.file}/runs?event=workflow_dispatch&branch=main`,
    since,
  ) as (Run & { actor?: { login?: string } })[];
  return runs.filter(
    (r) =>
      r.event === "workflow_dispatch" &&
      r.head_branch === "main" &&
      (r.head_repository?.full_name ?? "") === repo &&
      r.actor?.login === APP_ACTOR &&
      c.title.exec(r.display_title ?? "")?.[1] === tag,
  );
}

export type Start = { go: true; next: Child } | { go: false; why: string };

/**
 * What the chain starts next for the tag, once: after the gate, the publish,
 * or the deploy straight away when prod's bucket already has the release
 * (publishing is create-only); after a green publish, the deploy, and the
 * bucket must have the release (else it throws: fail closed). Never twice:
 * nothing starts while the chain's publish or deploy of the tag is queued or
 * running (its end is the next event), or once the chain's deploy of the tag
 * succeeded. A failed earlier run does not block a new event. Every run
 * since the tag's release is read, all pages, so an earlier run on a later
 * page still counts; a read that is not complete throws and nothing is
 * dispatched. Called under the tag's concurrency group, right before the
 * dispatch.
 */
export function start(o: {
  exec: Exec;
  repo: string;
  publicRepo: string;
  after: "gate" | "publish";
  tag: string;
  nowMs?: number;
}): Start {
  if (!TAG_RE.test(o.tag)) throw new Error(`not a release tag: ${o.tag}`);
  const since = releasedSince({ ...o, nowMs: o.nowMs ?? Date.now() });
  const going = (r: Run) => r.status !== "completed";
  const deploys = chainRuns(o.exec, o.repo, "deploy", o.tag, since);
  if (deploys.some(going))
    return {
      go: false,
      why: `the chain's deploy of ${o.tag} is under way: its end is the next event`,
    };
  if (deploys.some((r) => r.conclusion === "success"))
    return { go: false, why: `the chain already deployed ${o.tag}` };
  const inBucket = published({ ...o, since });
  if (o.after === "publish") {
    if (!inBucket)
      throw new Error(
        `the publish of ${o.tag} is green but prod's bucket has no record of it`,
      );
    return { go: true, next: "deploy" };
  }
  if (inBucket) return { go: true, next: "deploy" };
  if (chainRuns(o.exec, o.repo, "publish", o.tag, since).some(going))
    return {
      go: false,
      why: `the chain's publish of ${o.tag} is under way: its end is the next event`,
    };
  return { go: true, next: "publish" };
}

/**
 * One result for the blocker issue from the run's job results. Red
 * (failure, cancelled, ...) opens or refreshes it; `success` closes it, and
 * only the deploy's own green end is a success; `skipped` (a neutral skip,
 * a step that started the next one, a rerun still going) leaves it.
 */
export function result(r: {
  step: string;
  plan: string;
  gate: string;
  start: string;
  deploy: string;
  finish: string;
  /** The ended deploy's state (child): success, running or failed. */
  state: string;
}): string {
  if (r.plan !== "success") return r.plan || "failure";
  if (r.step === "gate") {
    if (r.gate !== "success") return r.gate;
    return r.start === "success" || r.start === "skipped" ? "skipped" : r.start;
  }
  if (r.step === "deploy") return r.deploy === "success" ? "skipped" : r.deploy;
  if (r.step === "report") {
    if (r.finish !== "success") return r.finish;
    return r.state === "success" ? "success" : "skipped";
  }
  return "skipped";
}

export type Report =
  | { action: "none" }
  | { action: "closed"; issues: number[] }
  | { action: "refreshed"; issue: number }
  | { action: "opened" };

/** Red keeps one open `blocker` issue, refreshed; green closes it. */
export function report(o: {
  exec: Exec;
  repo: string;
  tag: string;
  result: string;
  run: string;
  /** The dispatched deploy run's link, when it started. */
  deployRun?: string;
  /** What the dispatch step said when it failed (one line). */
  deployNote?: string;
}): Report {
  // A neutral skip (a stale event, a release prod already runs) leaves the
  // issue as it is: it neither opens nor closes it.
  if (o.result === "skipped") return { action: "none" };
  const tag = TAG_RE.test(o.tag) ? o.tag : "";
  const open = (
    JSON.parse(
      gh(o.exec, [
        "issue",
        "list",
        "--repo",
        o.repo,
        "--label",
        "blocker",
        "--state",
        "open",
        "--json",
        "number,title",
        "--limit",
        "50",
      ]),
    ) as { number: number; title: string }[]
  ).filter((i) => i.title.startsWith(`${ISSUE} `));

  if (o.result === "success") {
    for (const i of open)
      gh(o.exec, [
        "issue",
        "close",
        String(i.number),
        "--repo",
        o.repo,
        "--comment",
        `Green on ${tag}: ${o.run}${o.deployRun ? ` (deploy run ${o.deployRun})` : ""}`,
      ]);
    return open.length
      ? { action: "closed", issues: open.map((i) => i.number) }
      : { action: "none" };
  }

  const title = `${ISSUE} failed: ${tag || "no release tag"}`;
  const body = [
    `The prod release chain ended with \`${o.result}\` before the fleet started.`,
    "",
    `Run: ${o.run}`,
    "",
    ...(o.deployRun ? [`Deploy run: ${o.deployRun}`, ""] : []),
    ...(o.deployNote ? [`Deploy step: ${o.deployNote}`, ""] : []),
    "The scheduler deploys last and its tag is the fleet's target. Whether it moved is not known from here: the deploy run's \"Every platform Worker runs the tag\" step reads every Worker's tag back, and runs even when a deploy step failed, so read it (or `platform-tags.sh prod`). If the scheduler runs the tag, the fleet follows it and the next chain run cannot undo that (forward only). The deploy re-runs the tagged scheduler deploy after a failed secret put, so an untagged scheduler is not expected; if the read-back still shows one, every later chain run fails at the tag-newer gate until it is repaired: dispatch deploy-hosted-platform.yml on main with the same tag, the full target list and require_newer false. Read the run: a gate refused the tag, or the deploy or its read-back failed. Forward only: fix the cause, cut a new release and red-line it; a green chain run closes this issue (docs/ops/hosted.md).",
  ].join("\n");
  const existing = open[0];
  if (existing) {
    gh(o.exec, [
      "issue",
      "edit",
      String(existing.number),
      "--repo",
      o.repo,
      "--title",
      title,
      "--body",
      body,
    ]);
    return { action: "refreshed", issue: existing.number };
  }
  // The label is shared: create it if it's missing, never reset it.
  const labels = JSON.parse(
    gh(o.exec, [
      "label",
      "list",
      "--repo",
      o.repo,
      "--search",
      "blocker",
      "--json",
      "name",
    ]),
  ) as { name: string }[];
  if (!labels.some((l) => l.name === "blocker"))
    gh(o.exec, [
      "label",
      "create",
      "blocker",
      "--repo",
      o.repo,
      "--color",
      "B60205",
      "--description",
      "A release or deploy is stuck",
    ]);
  gh(o.exec, [
    "issue",
    "create",
    "--repo",
    o.repo,
    "--title",
    title,
    "--body",
    body,
    "--label",
    "blocker",
  ]);
  return { action: "opened" };
}

const MAX_BUFFER = 16 * 1024 * 1024;
const realExec: Exec = (cmd, args) => {
  // A runs list can pass spawnSync's 1 MiB default; the reads also ask gh for
  // a small --jq body, this is the backstop.
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: MAX_BUFFER });
  const code = r.status ?? 1;
  return {
    code,
    stdout: r.stdout ?? "",
    stderr:
      (r.stderr ?? "") +
      (r.status === null
        ? ` [${(r.error as NodeJS.ErrnoException | undefined)?.code ?? "killed"}: gh output over ${MAX_BUFFER} bytes or killed]`
        : ""),
  };
};

const flag = (argv: string[], name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? "" : (argv[i + 1] ?? "");
};
/** One line, no control characters, capped: safe for $GITHUB_OUTPUT and a workflow command. */
const oneLine = (s: string) =>
  [...s]
    .map((c) => (c.charCodeAt(0) < 32 || c === "\x7f" ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
/** A `key=value` line on stdout and in $GITHUB_OUTPUT (when set), so stdout stays free for notices. */
const emit = (key: string, value: string) => {
  const line = `${key}=${oneLine(value)}\n`;
  process.stdout.write(line);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, line);
};

function main(argv: string[]) {
  const [mode] = argv;
  if (mode === "result") {
    console.log(
      result({
        step: flag(argv, "step"),
        plan: flag(argv, "plan"),
        gate: flag(argv, "gate"),
        start: flag(argv, "start"),
        deploy: flag(argv, "deploy"),
        finish: flag(argv, "finish"),
        state: flag(argv, "state"),
      }),
    );
    return;
  }
  if (mode === "tag") {
    console.log(`tag=${tagOf(flag(argv, "title"))}`);
    return;
  }
  if (mode === "newer" || mode === "require-newer") {
    const tag = flag(argv, "tag");
    const current = flag(argv, "current");
    const go = isNewer(tag, current);
    if (!go && mode === "require-newer")
      throw new Error(`${tag} is not newer than prod's ${current}: refusing`);
    console.error(
      `prod-release-chain: ${tag} is ${go ? "" : "not "}newer than prod's ${current}`,
    );
    if (mode === "newer") console.log(`go=${go}`);
    return;
  }
  const repo = flag(argv, "repo");
  if (!repo) throw new Error("--repo owner/name is required");
  if (mode === "plan") {
    const p = plan({
      repo,
      switch: flag(argv, "switch"),
      workflow: flag(argv, "workflow"),
      conclusion: flag(argv, "conclusion"),
      event: flag(argv, "event"),
      branch: flag(argv, "branch"),
      headRepo: flag(argv, "head-repo"),
      title: flag(argv, "title"),
      actor: flag(argv, "actor"),
      runId: flag(argv, "run-id"),
    });
    emit("step", p.step);
    if (p.step === "none") {
      console.error(`prod-release-chain: nothing to do: ${oneLine(p.why)}`);
      return;
    }
    emit("tag", p.tag);
    if (p.step !== "gate") emit("child", p.child);
    return;
  }
  if (mode === "child") {
    const which = flag(argv, "workflow");
    if (which !== "publish" && which !== "deploy")
      throw new Error("--workflow publish|deploy");
    const c = child({
      exec: realExec,
      repo,
      which,
      runId: flag(argv, "run-id"),
      tag: flag(argv, "tag"),
    });
    emit("state", c.state);
    emit("url", c.url);
    if (c.state === "running") {
      console.log(
        `::notice title=Release chain waits for its event::the ${which} run ${c.url} is running again (a rerun): its end is the next event`,
      );
      return;
    }
    if (c.state === "failed") {
      const note = `${which} run ${flag(argv, "run-id")} concluded ${c.conclusion}: ${c.url}`;
      emit("note", note);
      throw new Error(note);
    }
    return;
  }
  if (mode === "start") {
    const after = flag(argv, "after");
    if (after !== "gate" && after !== "publish")
      throw new Error("--after gate|publish");
    const r = start({
      exec: realExec,
      repo,
      publicRepo: flag(argv, "public-repo"),
      after,
      tag: flag(argv, "tag"),
    });
    emit("go", String(r.go));
    if (r.go) emit("next", r.next);
    else console.log(`::notice title=Release chain skipped::${oneLine(r.why)}`);
    return;
  }
  if (mode === "fresh") {
    const r = fresh({
      exec: realExec,
      repo,
      tag: flag(argv, "tag"),
      headSha: flag(argv, "head-sha"),
    });
    console.error(
      r.go
        ? `prod-release-chain: run ${r.run} is the newest for the tag`
        : `prod-release-chain: a newer green run (${r.run}) for the tag has another head sha: this event is stale`,
    );
    console.log(`go=${r.go}`);
    return;
  }
  if (mode === "published") {
    const tag = flag(argv, "tag");
    const since = releasedSince({
      exec: realExec,
      publicRepo: flag(argv, "public-repo"),
      tag,
      nowMs: Date.now(),
    });
    const go = published({ exec: realExec, repo, tag, since });
    console.error(
      `prod-release-chain: ${flag(argv, "tag")} is ${go ? "" : "not "}in prod's bucket`,
    );
    console.log(`published=${go}`);
    return;
  }
  if (mode === "report") {
    const r = report({
      exec: realExec,
      repo,
      tag: flag(argv, "tag"),
      result: flag(argv, "result"),
      run: flag(argv, "run"),
      deployRun: flag(argv, "deploy-run"),
      deployNote: flag(argv, "deploy-note"),
    });
    console.error(`prod-release-chain: ${JSON.stringify(r)}`);
    return;
  }
  throw new Error(
    "usage: prod-release-chain.ts <plan|tag|fresh|newer|require-newer|published|child|start|result|report> ...",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
