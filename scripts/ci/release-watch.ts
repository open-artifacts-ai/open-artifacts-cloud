// Release watch, measure only (cloud #264, Lane 5 PR1): how long each release
// takes, stage by stage, against each stage's usual time, and one comment, on
// the one open issue "release stuck", when a stage is seen still running past
// its limit, finished past it, or failed (each once per release and stage,
// never per refresh). It runs on events
// only, never a schedule or a poll: a stage that never finishes raises no
// event and is the release agent's to catch. The limit: the larger of alertFactor (2) x its
// usual time and its usual time plus alertFloor (5) minutes, so a stage that
// usually takes half a minute does not alert on a one-minute wait. Each stage
// is timed from its own start to its own end, so stages can overlap (the
// staging copy beside the staging deploy, cloud #471); one not started yet
// counts from what it waits on. A stage is done only once its own run or job
// completed green. Merge to every install is reported against e2eTarget, never
// alerted on: to the scheduler's fleet_done time once a later prod deploy
// records it (cloud #495), else to the prod deploy, labelled "fleet not yet
// measured". It gates
// nothing and is never a required check.
//
// Stateless: each tick rebuilds every recent release's timeline from GitHub
// timestamps, so a dropped or replaced tick loses nothing. The stages are data
// (.github/hosted/release-stages.json); changing the chain edits that file.
// Completed releases are kept in history.jsonl, which the workflow carries from
// one run's Actions artifact to the next; the per-stage p50/p90 and the ETAs
// come from it.
//
// Usage: node --experimental-strip-types scripts/ci/release-watch.ts tick --repo owner/name --out DIR
//          [--public owner/name] [--stages FILE] [--history FILE] [--since YYYY-MM-DD] [--no-issue]
// --since backfills: it reads every release published since that day and
// ignores --history (one run, about 2 reads per release). Without it the
// window is the last lookbackHours plus the newest release, however old, so a
// stalled release keeps being watched.
// Reads: the runs of four workflows on main, public's releases, and per
// release not yet in history its pin-bump PRs (by head branch), a compare and
// a commit's PRs on public (its merge time). While a release is not yet in
// history, the jobs (with their steps) of each hosted-release, hosted-publish
// and prod deploy run since it was published, one read per run: a recovery run
// on a later main commit names the release in its job names, a copy ends with
// its publish job, and the prod deploy's steps record the fleet finish. A
// release in history is done and not rebuilt, but one whose total stopped at
// the prod deploy has its prod deploys' jobs read in the window, and takes a
// later "Fleet done" for its tag. Writes, through gh() and only when a stage
// is past its limit or failed: the issue (created once) and one comment
// per release and stage; for a failed stage, its run's jobs are read (never
// its log).
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Exec, gh } from "./gh-retry.ts";
import { BRANCH_PREFIX, compareTags, PUBLIC_REPO } from "./pin-bump.ts";

/**
 * The one issue: a comment per release and stage that went past its limit,
 * once each (cloud #264; the release watcher's ask).
 */
export const ISSUE_TITLE = "release stuck";
const TAG_RE = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const MIN = 60_000;

export type Stage = {
  name: string;
  /** The stage's own start: an event, or the latest of several (all must have happened). */
  from: string | string[];
  /** The stage's own end. */
  to: string;
  /**
   * What the stage waits on before it starts (the earlier stages' ends). A
   * stage that has not started yet counts from here, so a stall still shows.
   */
  after?: string | string[];
  /** Minutes: the stage's median over the measured releases. Unset only for an optional stage. */
  usual?: number;
  mode?: "pr" | "direct";
  /** Measured only for a release whose runs record it (fleet: its finish). */
  optional?: boolean;
  measured?: boolean;
  todo?: string;
};
export type Config = {
  pinMode: "pr" | "direct";
  /** A stage past max(alertFactor x usual, usual + alertFloor) opens the issue. */
  alertFactor: number;
  /** Minutes: the least a stage may run past its usual time before it alerts. */
  alertFloor: number;
  /** Merge to every install, minutes: reported, never alerted on. */
  e2eTarget: number;
  lookbackHours: number;
  statsWindow: number;
  historySize: number;
  stages: Stage[];
};
/** One step of a job, as the jobs list's --jq slims it. */
export type JobStep = {
  name: string;
  status?: string;
  conclusion: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};
/** One job of a run's latest attempt, as the jobs list's --jq slims it. */
export type Job = {
  name: string;
  status?: string;
  conclusion: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  steps?: JobStep[];
};
/** One workflow run, as the runs list's --jq slims it. */
export type Run = {
  id: number;
  path: string;
  event: string;
  title: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  attempt: number;
  url: string;
  commitMessage: string;
  commitAt: string;
  /** Read only for hosted-release, hosted-publish and prod deploy runs while a release is in flight. */
  jobs?: Job[];
};
export type Pr = {
  number: number;
  ref: string;
  createdAt: string;
  mergedAt: string | null;
  url: string;
};
export type Release = { tag: string; publishedAt: string };
/** Where a group of runs stands: done (a success), running, red, or none yet. */
export type Step = {
  state: "done" | "running" | "red" | "none";
  startedAt?: string;
  doneAt?: string;
  url?: string;
  /** The run `url` names. */
  runId?: number;
  /** Every attempt of every run of the step. */
  attempts?: number;
  /**
   * fleet only: doneAt is the scheduler's own fleet_done time (a "Fleet done
   * of earlier releases" record); false: the "Fleet done" step's end, an
   * upper bound some seconds after it.
   */
  exact?: boolean;
};
export type StageRow = {
  name: string;
  /** Unset for an optional stage with no usual time yet: never alerted on. */
  usual?: number;
  startedAt?: string;
  endedAt?: string;
  minutes?: number;
  /** unmeasured: an optional stage this release's runs do not record. */
  state: "done" | "current" | "red" | "pending" | "unmeasured";
  /** Not started yet: startedAt is when what it waits on ended. */
  waiting?: boolean;
  url?: string;
  /** The stage's own run, and every attempt of its runs (a run stage only). */
  runId?: number;
  attempts?: number;
};
export type Timeline = {
  tag: string;
  mode: "pr" | "direct";
  mergedAt?: string;
  publishedAt: string;
  stages: StageRow[];
  doneAt?: string;
  /** When its prod deploy succeeded: a release that reached prod is never superseded. */
  prodAt?: string;
  /** What e2e runs to: "every install", or "prod deploy (fleet not yet measured)". */
  e2eTo?: string;
  /** A newer release reached the pin while this one never reached prod: it never ships alone. */
  supersededBy?: string;
  /** For a superseded release: when the newer release that carries it was done. */
  closedAt?: string;
  e2e?: number;
};
export type HistoryEntry = {
  tag: string;
  mode: "pr" | "direct";
  mergedAt?: string;
  publishedAt: string;
  doneAt: string;
  supersededBy?: string;
  e2e?: number;
  e2eTo?: string;
  stages: Record<string, number>;
};
export type Overrun = {
  tag: string;
  stage: string;
  /**
   * in_flight: the stage is still going past its limit; finished: it ended
   * past its limit; failed: its run failed (any time).
   */
  kind: "in_flight" | "finished" | "failed";
  /** Unknown for a finished release read back from history. */
  startedAt?: string;
  /** In flight and not started: startedAt is when what it waits on ended. */
  waiting?: boolean;
  /** red: the stage's run failed and it is past its limit. */
  red?: boolean;
  runId?: number;
  attempts?: number;
  minutes: number;
  usual: number;
  /** max(alertFactor x usual, usual + alertFloor). */
  limit: number;
  url?: string;
};
export type Red = { tag: string; stage: string; url?: string };

/** What a release's total runs to when its prod deploy recorded no fleet finish. */
export const NO_FLEET = "prod deploy (fleet not yet measured)";
/**
 * A total to the "Fleet done" step's end: an upper bound, the step running
 * some seconds after the scheduler's own mark. A later prod deploy's record
 * of the mark corrects it.
 */
export const FLEET_UPPER =
  "every install (upper bound: the Fleet done step's end)";
const ms = (iso: string) => Date.parse(iso);
const mins = (a: string, b: string) =>
  Math.max(0, Math.round(((ms(b) - ms(a)) / MIN) * 10) / 10);

/** The pin commit's subject names the tag: the PR's squash or the direct pin. */
export function pinSubject(message: string, tag: string): boolean {
  const s = message.split("\n")[0] ?? "";
  return (
    s.startsWith("chore(pin): ") &&
    new RegExp(`(^|\\s)${tag.replace(/\./g, "\\.")}(\\s|$)`).test(s)
  );
}
export const isDirectPin = (message: string, tag: string) =>
  pinSubject(message, tag) &&
  (message.split("\n")[0] ?? "").startsWith(
    `chore(pin): release public ${tag}`,
  );

const file = (r: Run) => r.path.replace(/@.*$/, "").split("/").pop() ?? "";
const titled = (title: string, prefix: string) =>
  title === prefix || title.startsWith(`${prefix} [`);

const TAG_IN = "(v\\d{1,6}\\.\\d{1,6}\\.\\d{1,6})";
/** hosted-release.yml's marker (cloud #469): `hosted-built <tag> <sha>`, the commit it built. */
export const BUILT_RE = new RegExp(`^hosted-built ${TAG_IN} [0-9a-f]{40}$`);
/** hosted-publish.yml's job, named from its resolve job's verified tag. */
export const STAGING_RE = new RegExp(`^publish-staging release ${TAG_IN}$`);
export const PROD_RE = new RegExp(`^publish-prod release ${TAG_IN}$`);

/**
 * Pure: the release a run names in one of its jobs. A recovery run (a
 * dispatch, or a workflow_run on a later main commit) does not run on the pin
 * commit, so its head sha says nothing; the job name is the release the run
 * verified. undefined: the run's jobs were not read (or none are listed
 * yet); null: none names one (a run that published nothing). With `ok`, only
 * a successful job counts.
 */
export function namedTag(
  r: Run,
  re: RegExp,
  ok = false,
): string | null | undefined {
  if (!r.jobs || r.jobs.length === 0) return undefined;
  for (const j of r.jobs) {
    if (ok && j.conclusion !== "success") continue;
    const m = re.exec(j.name);
    if (m) return m[1] as string;
  }
  return null;
}

/** Pure: whether a hosted-release run built `tag`: its hosted-built job, else the pin commit it ran on. */
export function builds(r: Run, tag: string): boolean {
  if (file(r) !== "hosted-release.yml") return false;
  const named = namedTag(r, BUILT_RE, true);
  if (named) return named === tag;
  return r.event === "push" && pinSubject(r.commitMessage, tag);
}

/**
 * Pure: where a group of runs for one step stands. The first success is done
 * (its whole span, reruns included). With none, the newest run decides:
 * still going is running, ended any other way is red.
 */
export function step(runs: Run[]): Step {
  if (runs.length === 0) return { state: "none" };
  const sorted = [...runs].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const first = sorted[0] as Run;
  // A rerun's run_started_at is the last attempt's; its first start is lost,
  // so its span counts from when the run was created.
  const startedAt = first.attempt > 1 ? first.createdAt : first.startedAt;
  const ok = sorted.find(
    (r) => r.status === "completed" && r.conclusion === "success",
  );
  const attempts = sorted.reduce((n, r) => n + Math.max(1, r.attempt), 0);
  if (ok)
    return {
      state: "done",
      startedAt,
      doneAt: ok.updatedAt,
      url: ok.url,
      runId: ok.id,
      attempts,
    };
  const last = sorted[sorted.length - 1] as Run;
  const running = last.status !== "completed";
  return {
    state: running ? "running" : "red",
    runId: last.id,
    attempts,
    // A queued first attempt has not started: the step has not either.
    startedAt:
      running &&
      last.status !== "in_progress" &&
      sorted.length === 1 &&
      last.attempt === 1
        ? undefined
        : startedAt,
    url: last.url,
  };
}

/**
 * A run seen through one of its jobs: the job's state and end, the run's
 * start. The staging copy ends when its publish-staging job does, though the
 * run goes on (stage-prod).
 */
const asJob = (r: Run, j: Job): Run => ({
  ...r,
  status: j.status ?? (j.conclusion ? "completed" : "in_progress"),
  conclusion: j.conclusion,
  updatedAt: j.completedAt ?? r.updatedAt,
});
const jobOf = (r: Run, re: RegExp, tag: string) =>
  r.jobs?.find((j) => re.exec(j.name)?.[1] === tag);

/** The prod deploy's fleet steps (cloud #474). */
export const FLEET_WAKE_STEP = "Wake the fleet";
export const FLEET_WAIT_STEP = "Wait for the fleet to reach every install";
export const FLEET_DONE_STEP = "Fleet done";
/**
 * The fleet finish (cloud #474, #495): every prod deploy reads every
 * fleet_done mark the platform still holds and, when there
 * is any, runs a step named
 * `Fleet done of earlier releases (<tag> at <ISO time>, <tag> at <ISO time>, ...)`,
 * oldest first, the newest 20 at most (cloud #474, platform-db.ts
 * fleet-done-all). A release can be listed by many runs.
 */
export const EARLIER_FLEET_RE = /^Fleet done of earlier releases \((.+)\)$/;
const EARLIER_ENTRY_RE = new RegExp(
  `^${TAG_IN} at (\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d{1,3})?Z)$`,
);

/** Pure: the tags and times one step name lists; an entry of another shape is skipped. */
export function earlierFleetList(name: string): { tag: string; at: string }[] {
  const m = EARLIER_FLEET_RE.exec(name);
  if (!m) return [];
  const out: { tag: string; at: string }[] = [];
  for (const e of (m[1] as string).split(", ")) {
    const x = EARLIER_ENTRY_RE.exec(e);
    if (!x) continue;
    const t = Date.parse(x[2] as string);
    if (Number.isNaN(t)) continue;
    out.push({
      tag: x[1] as string,
      at: new Date(t).toISOString().replace(/\.000Z$/, "Z"),
    });
  }
  return out;
}

/**
 * Pure: the earliest fleet finish of `tag` that any prod deploy run (of any
 * release) recorded in a successful "Fleet done of earlier releases" step.
 */
export function lateFleetDone(
  runs: Run[],
  tag: string,
): { at: string; url: string } | undefined {
  let best: { at: string; url: string } | undefined;
  for (const r of runs) {
    if (
      file(r) !== "deploy-hosted-platform.yml" ||
      !r.title.startsWith("deploy-hosted-platform prod ")
    )
      continue;
    for (const j of r.jobs ?? [])
      for (const x of j.steps ?? []) {
        if (x.conclusion !== "success") continue;
        for (const e of earlierFleetList(x.name))
          if (e.tag === tag && (!best || ms(e.at) < ms(best.at)))
            best = { at: e.at, url: r.url };
      }
  }
  return best;
}
const ran = (x: JobStep | undefined): x is JobStep =>
  !!x && x.conclusion !== "skipped" && !!x.startedAt;

/**
 * Pure: the fleet finish. "Wake the fleet" starts once the deploy and its
 * verified mark are green: the fleet starts there and the deploy's own work
 * ends there. Since cloud #495 the deploy does not wait for the fleet: the
 * finish comes only from a later prod deploy's "Fleet done of earlier
 * releases" record (`late`), the scheduler's own time, and until then the
 * fleet is not measured (the total stays to prod deploy, fleet not yet
 * measured). Runs from before #495 also carry a wait step and a "Fleet done"
 * step, whose end is an upper bound (FLEET_UPPER) until a record is seen.
 * Every prod deploy run of the tag is read (a rerun, or a later deploy of the
 * same tag): the step finish is the earliest successful "Fleet done" across
 * them, so an earlier wait that ran out never hides a later success, and the
 * fleet starts at the earliest wake of any run. With no finish: running while
 * an old-shape wait is still going, else none (no record yet, no fleet steps,
 * jobs not read, or every old wait ran out), and the fleet is not measured
 * for that release.
 */
export function fleetStep(
  prodRuns: Run[],
  late?: { at: string; url: string },
): {
  fleet: Step;
  deployEnd?: string;
  /** A run whose "Wake the fleet" failed or was cancelled, when none woke it. */
  wakeFailed?: Run;
} {
  let deployEnd: string | undefined;
  let done: { at: string; url: string } | undefined;
  let going: string | undefined;
  let wakeFailed: Run | undefined;
  for (const r of prodRuns)
    for (const j of r.jobs ?? []) {
      const by = (n: string) => j.steps?.find((x) => x.name === n);
      // A successful "Wake the fleet" anchors the fleet's start and the
      // deploy's end. One that failed or was cancelled fails the deploy
      // (cloud #495) and anchors nothing. One skipped on purpose (an older
      // tag with no queue consumer, a partial target list) anchors nothing
      // and raises nothing on its own: if the job failed before it, the
      // run's own failure says so. The wait and "Fleet done" steps are only
      // in runs before #495; the wait anchors only a run with no wake step.
      const wake = by(FLEET_WAKE_STEP);
      const wait = by(FLEET_WAIT_STEP);
      const fin = by(FLEET_DONE_STEP);
      if (
        wake &&
        (wake.conclusion === "failure" || wake.conclusion === "cancelled")
      ) {
        wakeFailed = wakeFailed ?? r;
        continue;
      }
      const start =
        wake?.conclusion === "success" && wake.startedAt
          ? wake.startedAt
          : !wake && ran(wait)
            ? wait.startedAt
            : undefined;
      if (!start) continue;
      if (!deployEnd || ms(start) < ms(deployEnd)) deployEnd = start;
      if (
        fin?.conclusion === "success" &&
        fin.status !== "in_progress" &&
        fin.completedAt
      ) {
        if (!done || ms(fin.completedAt) < ms(done.at))
          done = { at: fin.completedAt, url: r.url };
      } else if (
        ran(wait) &&
        (wait.status !== "completed" ||
          (!!fin && fin.conclusion === null && fin.status !== "completed"))
      )
        going = going ?? r.url;
    }
  // The scheduler's own mark, as a later deploy recorded it, is the exact
  // finish; the "Fleet done" step ends after the mark, so it is only an
  // upper bound until a record is seen. Never the time the watcher saw it.
  const fin = late
    ? { ...late, exact: true }
    : done
      ? { ...done, exact: false }
      : undefined;
  if (!deployEnd)
    return {
      ...(wakeFailed ? { wakeFailed } : {}),
      fleet: fin
        ? { state: "done", doneAt: fin.at, url: fin.url, exact: fin.exact }
        : { state: "none" },
    };
  if (fin)
    return {
      deployEnd,
      fleet: {
        state: "done",
        startedAt: deployEnd,
        doneAt: fin.at,
        url: fin.url,
        exact: fin.exact,
      },
    };
  return {
    deployEnd,
    fleet: going
      ? { state: "running", startedAt: deployEnd, url: going }
      : { state: "none" },
  };
}

/** The prod deploy runs of one release, by run name. */
const prodDeploys = (runs: Run[], tag: string) =>
  runs.filter(
    (r) =>
      file(r) === "deploy-hosted-platform.yml" &&
      titled(r.title, `deploy-hosted-platform prod ${tag}`),
  );

/**
 * Pure: a finished release in history whose total stopped at the prod deploy
 * (its fleet wait ran out, or was not read yet) takes a later successful
 * "Fleet done" for the same tag, and one to the "Fleet done" step's end (an
 * upper bound) takes the scheduler's exact mark once a later deploy records
 * it. A release measured to the exact mark, or one that never reached prod,
 * is left as it is.
 */
export function upgradeFleet(h: HistoryEntry, runs: Run[]): HistoryEntry {
  if (h.supersededBy || h.e2eTo === "every install") return h;
  const { fleet } = fleetStep(
    prodDeploys(runs, h.tag),
    lateFleetDone(runs, h.tag),
  );
  if (fleet.state !== "done" || !fleet.doneAt) return h;
  // An upper bound already recorded gives way only to the exact mark, or to
  // an earlier step end.
  if (
    h.e2eTo === FLEET_UPPER &&
    !fleet.exact &&
    ms(fleet.doneAt) >= ms(h.doneAt)
  )
    return h;
  return {
    ...h,
    doneAt: fleet.doneAt,
    e2e: h.mergedAt ? mins(h.mergedAt, fleet.doneAt) : h.e2e,
    e2eTo: fleet.exact ? "every install" : FLEET_UPPER,
    stages: {
      ...h.stages,
      ...(fleet.startedAt
        ? { fleet: mins(fleet.startedAt, fleet.doneAt) }
        : {}),
    },
  };
}

/**
 * Pure: the runs of each step of one release, the copies seen through their
 * publish job, and the steps they make. With `since`, a step counts only the
 * runs created once what it waits on ended (a minute's slack): an earlier run
 * was an attempt against an earlier upstream attempt.
 */
export function steps(
  tag: string,
  runs: Run[],
  since: Record<string, string | undefined> = {},
): Record<string, Step> {
  const g = groups(tag, runs);
  const after = (k: string) => {
    const t = since[k];
    const rs = g[k] ?? [];
    return t ? rs.filter((r) => ms(r.createdAt) >= ms(t) - MIN) : rs;
  };
  return {
    hosted_release: step(after("hosted_release")),
    staging_publish: step(after("staging_publish")),
    staging_deploy: step(after("staging_deploy")),
    redline: step(after("redline")),
    prod_publish: step(after("prod_publish")),
    ...prodSteps(after("prod_deploy"), lateFleetDone(runs, tag)),
  };
}

function groups(tag: string, runs: Run[]): Record<string, Run[]> {
  const pinRuns = runs.filter((r) => builds(r, tag));
  const shas = new Set(
    runs
      .filter((r) => builds(r, tag) && r.event === "push")
      .map((r) => r.headSha),
  );
  const by = (f: string, pred: (r: Run) => boolean) =>
    runs.filter((r) => file(r) === f && pred(r));
  return {
    hosted_release: pinRuns,
    // The publish job names the tag its resolve job verified, and its own
    // end is the copy's; only a run whose jobs were not read falls back to
    // the pin push's sha and the run's end.
    staging_publish: by("hosted-publish.yml", (r) => {
      const named = namedTag(r, STAGING_RE);
      if (named !== undefined) return named === tag;
      return r.event === "workflow_run" && shas.has(r.headSha);
    }).map((r) => {
      const j = jobOf(r, STAGING_RE, tag);
      return j ? asJob(r, j) : r;
    }),
    staging_deploy: by("deploy-hosted-platform.yml", (r) =>
      titled(r.title, `deploy-hosted-platform staging ${tag}`),
    ),
    redline: by(
      "redline-staging.yml",
      (r) => r.title === `redline-staging ${tag}`,
    ),
    prod_publish: by(
      "hosted-publish.yml",
      (r) =>
        titled(r.title, `hosted-publish prod ${tag}`) ||
        namedTag(r, PROD_RE) === tag,
    ).map((r) => {
      const j = jobOf(r, PROD_RE, tag);
      return j ? asJob(r, j) : r;
    }),
    prod_deploy: prodDeploys(runs, tag),
  };
}

/**
 * Pure: the prod deploy and the fleet. Once a successful "Wake the fleet" has
 * started, the deploy's own work is done (every step before it succeeded), so
 * the deploy ends there; before cloud #495 the run then waited for the fleet.
 * A wake that failed or was cancelled fails the deploy (#495), unless another
 * run of the tag woke the fleet; a skipped one leaves the run's own state.
 */
function prodSteps(
  prodRuns: Run[],
  late?: { at: string; url: string },
): { prod_deploy: Step; fleet: Step } {
  const base = step(prodRuns);
  const { fleet, deployEnd, wakeFailed } = fleetStep(prodRuns, late);
  // The wake failed or was cancelled, and no run woke the fleet: the deploy
  // failed (a release workflow, rerun its failed jobs).
  if (!deployEnd && wakeFailed)
    return {
      prod_deploy: {
        state: "red",
        startedAt: base.startedAt,
        url: wakeFailed.url,
        runId: wakeFailed.id,
        attempts: base.attempts ?? Math.max(1, wakeFailed.attempt),
      },
      fleet,
    };
  if (!deployEnd) return { prod_deploy: base, fleet };
  const doneAt =
    base.state === "done" && base.doneAt && ms(base.doneAt) < ms(deployEnd)
      ? base.doneAt
      : deployEnd;
  return {
    prod_deploy: { ...base, state: "done", doneAt },
    fleet,
  };
}

const measured = (c: Config, mode: "pr" | "direct") =>
  c.stages.filter((s) => s.measured !== false && (!s.mode || s.mode === mode));

/** Pure: one release's timeline at `now`. */
export function timeline(o: {
  release: Release;
  runs: Run[];
  prs: Pr[];
  mergedAt?: string;
  config: Config;
  now: string;
}): Timeline {
  const { release, config } = o;
  const tag = release.tag;
  const pr = o.prs
    .filter((p) => p.ref === `${BRANCH_PREFIX}${tag}`)
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const merged = pr.find((p) => p.mergedAt);
  const pinRun = o.runs
    .filter(
      (r) =>
        file(r) === "hosted-release.yml" &&
        r.event === "push" &&
        pinSubject(r.commitMessage, tag),
    )
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt))[0];
  const mode: "pr" | "direct" =
    pr.length > 0
      ? "pr"
      : pinRun && isDirectPin(pinRun.commitMessage, tag)
        ? "direct"
        : config.pinMode;
  const ev: Record<string, string | undefined> = {
    merged: o.mergedAt,
    published: release.publishedAt,
    pin_opened: pr[0]?.createdAt,
    pinned: merged?.mergedAt ?? pinRun?.commitAt,
  };
  const keys = (k: string | string[] | undefined) =>
    k === undefined ? [] : Array.isArray(k) ? k : [k];
  // The latest of the events, once all have happened.
  const at = (k: string | string[] | undefined): string | undefined => {
    const v = keys(k).map((x) => ev[x]);
    if (v.length === 0 || v.some((x) => !x)) return undefined;
    return (v as string[]).reduce((a, b) => (ms(b) > ms(a) ? b : a));
  };
  const list = measured(config, mode);
  // In chain order, each step from the runs created once what it waits on
  // ended, so its events are known before a later stage reads them.
  const since: Record<string, string | undefined> = {};
  let st: Record<string, Step> = {};
  for (const s of list) {
    const k = s.to.split(".")[0] ?? "";
    if (s.after) since[k] = at(s.after);
    st = steps(tag, o.runs, since);
    for (const [n, x] of Object.entries(st)) {
      ev[`${n}.started`] = x.startedAt;
      ev[`${n}.done`] = x.doneAt;
    }
  }
  // The stages downstream of stage i: they start or wait on its end, transitively.
  const downstreamEnded = (i: number) => {
    const evs = new Set([(list[i] as Stage).to]);
    for (const s of list.slice(i + 1)) {
      if (![...keys(s.from), ...keys(s.after)].some((d) => evs.has(d)))
        continue;
      if (at(s.to)) return true;
      evs.add(s.to);
    }
    return false;
  };
  const rows: StageRow[] = list.map((s, i) => {
    const from = at(s.from);
    const to = at(s.to);
    const after = at(s.after);
    const owner = st[s.to.split(".")[0] ?? ""];
    const url =
      owner?.url ??
      (s.to === "pin_opened" || s.to === "pinned"
        ? (merged ?? pr[pr.length - 1])?.url
        : undefined);
    const base = {
      name: s.name,
      ...(s.usual ? { usual: s.usual } : {}),
      ...(owner?.runId
        ? { runId: owner.runId, attempts: owner.attempts ?? 1 }
        : {}),
    };
    const going = (since: string, waiting: boolean, red = false): StageRow => ({
      ...base,
      startedAt: since,
      minutes: mins(since, o.now),
      state: red ? "red" : "current",
      ...(waiting ? { waiting: true } : {}),
      url,
    });
    // Done only once its own run or job completed green (`to` is set then).
    if (to)
      return from
        ? {
            ...base,
            startedAt: from,
            endedAt: to,
            minutes: mins(from, to),
            state: "done",
            url,
          }
        : { ...base, endedAt: to, state: "done", url };
    // What it waits on has not happened (an upstream rerun is still going):
    // a run of it now is an earlier attempt's, so it counts as not started.
    if (s.after && !after)
      return downstreamEnded(i)
        ? { ...base, state: "done", url }
        : { ...base, state: "pending" };
    if (owner?.state === "red")
      return from ? going(from, false, true) : { ...base, state: "red", url };
    if (owner?.state === "running") {
      if (from) return going(from, false);
      if (after) return going(after, true);
      return { ...base, state: "pending" };
    }
    // No run seen, but a stage that waits on this one ended: it happened, untimed.
    if (downstreamEnded(i)) return { ...base, state: "done", url };
    if (s.optional) return { ...base, state: "unmeasured" };
    if (from) return going(from, false);
    if (after) return going(after, true);
    return { ...base, state: "pending" };
  });
  // Done when the last stage this release records is done: fleet once its
  // finish is recorded, else the prod deploy (fleet not yet measured).
  const tailAt = [...rows].reverse().findIndex((r) => r.state !== "unmeasured");
  const tail = tailAt < 0 ? undefined : rows[rows.length - 1 - tailAt];
  const doneAt = tail?.state === "done" ? tail.endedAt : undefined;
  const skipped = rows
    .filter((r) => r.state === "unmeasured")
    .map((r) => r.name);
  const e2eTo =
    skipped.length === 0
      ? st.fleet?.exact === false
        ? FLEET_UPPER
        : "every install"
      : `${(tail?.name ?? "").replace(/_/g, " ")} (${skipped.join(", ")} not yet measured)`;
  const prodAt = ev["prod_deploy.done"];
  // Merge to every install is measured from the code merge only. With no
  // merge time it stays unknown: publishing is later, so it would undercount.
  return {
    tag,
    mode,
    mergedAt: o.mergedAt,
    publishedAt: release.publishedAt,
    stages: rows,
    doneAt,
    ...(prodAt ? { prodAt } : {}),
    e2eTo,
    e2e: doneAt && o.mergedAt ? mins(o.mergedAt, doneAt) : undefined,
  };
}

/**
 * Pure: a release that never reached prod once a newer one is pinned never
 * ships on its own (the chain moves to the newest tag). It closes when that
 * newer release is done, and its e2e counts to then. A release whose prod
 * deploy succeeded is never superseded, however its runs were matched.
 */
export function supersede(tls: Timeline[]): Timeline[] {
  const byTag = [...tls].sort((a, b) => compareTags(a.tag, b.tag));
  return byTag.map((t, i) => {
    if (t.doneAt || t.closedAt || t.prodAt) return t;
    const newer = byTag
      .slice(i + 1)
      .find(
        (n) =>
          !!n.doneAt ||
          n.stages.some(
            (s) =>
              (s.name === "hosted_release" && s.startedAt) ||
              (s.name === "pin_merge" && s.endedAt) ||
              (s.name === "direct_pin" && s.endedAt),
          ),
      );
    if (!newer) return t;
    const closedAt = byTag.slice(i + 1).find((n) => n.doneAt)?.doneAt;
    return {
      ...t,
      supersededBy: newer.tag,
      closedAt,
      e2e: closedAt ? mins(t.mergedAt ?? t.publishedAt, closedAt) : undefined,
    };
  });
}

/** A timeline is finished (goes into history) when done or closed by a newer release. */
export function historyEntry(t: Timeline): HistoryEntry | undefined {
  const doneAt = t.doneAt ?? t.closedAt;
  if (!doneAt) return undefined;
  const stages: Record<string, number> = {};
  for (const s of t.stages)
    if (s.state === "done" && s.minutes !== undefined)
      stages[s.name] = s.minutes;
  return {
    tag: t.tag,
    mode: t.mode,
    mergedAt: t.mergedAt,
    publishedAt: t.publishedAt,
    doneAt,
    ...(t.supersededBy ? { supersededBy: t.supersededBy } : {}),
    e2e: t.e2e,
    ...(t.e2eTo ? { e2eTo: t.e2eTo } : {}),
    stages,
  };
}

/** Pure: merges new entries into history by tag (newer wins), newest `size` kept, oldest first. */
export function mergeHistory(
  old: HistoryEntry[],
  add: HistoryEntry[],
  size: number,
): HistoryEntry[] {
  const m = new Map<string, HistoryEntry>();
  for (const e of [...old, ...add]) m.set(e.tag, e);
  return [...m.values()].sort((a, b) => compareTags(a.tag, b.tag)).slice(-size);
}

/** Pure: nearest-rank percentile; null with no samples. */
export function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] as number;
}

export type Stats = Record<
  string,
  { p50: number | null; p90: number | null; n: number; usual?: number }
>;
/** Pure: p50/p90 per stage and e2e over the newest `statsWindow` finished releases. */
export function stats(history: HistoryEntry[], config: Config) {
  const recent = [...history]
    .sort((a, b) => compareTags(a.tag, b.tag))
    .slice(-config.statsWindow);
  const stages: Stats = {};
  for (const s of config.stages) {
    if (s.measured === false) continue;
    const v = recent
      .map((e) => e.stages[s.name])
      .filter((x): x is number => typeof x === "number");
    stages[s.name] = {
      p50: pct(v, 50),
      p90: pct(v, 90),
      n: v.length,
      ...(s.usual ? { usual: s.usual } : {}),
    };
  }
  // A superseded release's e2e waited on a newer one: it is real wait, kept.
  const e = recent
    .map((x) => x.e2e)
    .filter((x): x is number => typeof x === "number");
  return {
    stages,
    e2e: {
      p50: pct(e, 50),
      p90: pct(e, 90),
      n: e.length,
      target: config.e2eTarget,
      last20: recent
        .filter((x) => typeof x.e2e === "number")
        .slice(-20)
        .map((x) => ({
          tag: x.tag,
          e2e: x.e2e as number,
          // History from before this field ran to the prod deploy.
          to: x.e2eTo ?? NO_FLEET,
        })),
    },
  };
}

/**
 * Pure: when an in-flight release should be done, at p50 and p90. The current
 * stage takes what is left of its own figure (never less than zero), each later
 * stage its whole figure; a stage with no samples yet uses its usual time. A red
 * stage waits for a person: no ETA.
 */
export function eta(
  t: Timeline,
  st: Stats,
  now: string,
): { p50: string; p90: string } | null {
  const i = t.stages.findIndex(
    (s) => s.state !== "done" && s.state !== "unmeasured",
  );
  if (i < 0) return null;
  const cur = t.stages[i] as StageRow;
  if (cur.state === "red") return null;
  const fig = (name: string, k: "p50" | "p90", usual?: number) =>
    st[name]?.[k] ?? usual ?? 0;
  // Stages that overlap are summed as if in turn: an upper estimate.
  const left = (k: "p50" | "p90") => {
    const elapsed = cur.state === "current" ? (cur.minutes ?? 0) : 0;
    let m = Math.max(0, fig(cur.name, k, cur.usual) - elapsed);
    for (const s of t.stages.slice(i + 1))
      if (s.state !== "done" && s.state !== "unmeasured")
        m += Math.max(
          0,
          fig(s.name, k, s.usual) -
            (s.state === "current" ? (s.minutes ?? 0) : 0),
        );
    return new Date(ms(now) + Math.round(m * MIN)).toISOString();
  };
  return { p50: left("p50"), p90: left("p90") };
}

/**
 * A stage's limit, to a hundredth of a minute: the larger of alertFactor x its
 * usual time and its usual time plus alertFloor minutes. The floor keeps a
 * stage that usually takes half a minute (redline_queue) from alerting on a
 * one-minute wait.
 */
export const limitOf = (usual: number, config: Config) =>
  Math.round(
    Math.max(usual * config.alertFactor, usual + config.alertFloor) * 100,
  ) / 100;

/** The alert rule in words, from the config. */
export const ruleText = (config: Config) =>
  `the larger of ${config.alertFactor} x its usual time and its usual time plus ${config.alertFloor} min`;

/**
 * Pure: which stages are stuck, past their limit (limitOf): any
 * stage of a release in flight (not superseded), finished or still going, and
 * the newest finished release's, so the issue stays open until a release
 * completes with no stage past its limit. Merge to every install is never
 * alerted on. A red stage is not an overrun: the red run's own blocker covers
 * it, and it is listed apart.
 */
export function overruns(
  tls: Timeline[],
  config: Config,
): { over: Overrun[]; red: Red[]; failed: Overrun[] } {
  const over: Overrun[] = [];
  const red: Red[] = [];
  const failed: Overrun[] = [];
  const ids = (s: StageRow) =>
    s.runId ? { runId: s.runId, attempts: s.attempts ?? 1 } : {};
  const finishedOver = (t: Timeline) => {
    for (const s of t.stages)
      if (
        s.state === "done" &&
        s.usual !== undefined &&
        s.minutes !== undefined &&
        s.minutes > limitOf(s.usual, config)
      )
        over.push({
          tag: t.tag,
          stage: s.name,
          kind: "finished",
          startedAt: s.startedAt,
          ...ids(s),
          minutes: s.minutes,
          usual: s.usual,
          limit: limitOf(s.usual, config),
          url: s.url,
        });
  };
  const live = tls.filter((t) => !t.doneAt && !t.supersededBy);
  for (const t of live) {
    finishedOver(t);
    // Stages can overlap (the staging copy beside the staging deploy, #471):
    // each one going is timed from its own start, or from what it waits on.
    for (const cur of t.stages) {
      if (cur.state === "red") {
        red.push({ tag: t.tag, stage: cur.name, url: cur.url });
        failed.push({
          tag: t.tag,
          stage: cur.name,
          kind: "failed",
          red: true,
          ...(cur.startedAt ? { startedAt: cur.startedAt } : {}),
          ...ids(cur),
          minutes: cur.minutes ?? 0,
          usual: cur.usual ?? 0,
          limit: cur.usual !== undefined ? limitOf(cur.usual, config) : 0,
          url: cur.url,
        });
        continue;
      }
      if (
        cur.state === "current" &&
        cur.startedAt &&
        cur.usual !== undefined &&
        (cur.minutes ?? 0) > limitOf(cur.usual, config)
      )
        over.push({
          tag: t.tag,
          stage: cur.name,
          kind: "in_flight",
          startedAt: cur.startedAt,
          ...(cur.waiting ? { waiting: true } : {}),
          ...ids(cur),
          minutes: cur.minutes ?? 0,
          usual: cur.usual,
          limit: limitOf(cur.usual, config),
          url: cur.url,
        });
    }
  }
  const finished = tls
    .filter((t) => t.doneAt)
    .sort((a, b) => compareTags(a.tag, b.tag));
  const newest = finished[finished.length - 1];
  const newerLive = live.some(
    (t) => newest && compareTags(t.tag, newest.tag) > 0,
  );
  if (newest && !newerLive) finishedOver(newest);
  return { over, red, failed };
}

/** The hidden key that makes a comment once per release and stage. */
export const commentKey = (o: {
  tag: string;
  stage: string;
  kind?: Overrun["kind"];
}) =>
  o.kind === "in_flight"
    ? // Still running past its limit: its own key, so the finished (or
      // failed) comment can still follow.
      `<!-- release-watch ${o.tag} ${o.stage} running -->`
    : `<!-- release-watch ${o.tag} ${o.stage} -->`;

/**
 * Stages whose run is a test gate (redline-staging, with T19 in it): AGENTS.md
 * reruns test and CI workflows whole. Every other run stage is a release
 * workflow (hosted-release, hosted-publish, the deploys, the chains), rerun
 * for its failed jobs only.
 */
export const WHOLE_RERUN_STAGES = new Set(["redline", "redline_queue"]);

/**
 * Pure: what to do with the stage's run, by its workflow and state. Failed: a
 * test gate reruns whole, a release workflow its failed jobs only. Still
 * running or finished green: nothing to rerun.
 */
export function rerunAdvice(o: Overrun, repo: string): string {
  if (o.kind === "in_flight") return ", still running, nothing to rerun yet.";
  if (o.kind === "finished") return ", finished green, nothing to rerun.";
  return WHOLE_RERUN_STAGES.has(o.stage)
    ? `, failed. It is a test gate, so rerun it whole (AGENTS.md): open the run and choose "Re-run all jobs", or \`gh run rerun ${o.runId} -R ${repo}\`.`
    : `, failed. It is a release workflow, so rerun only its failed jobs (AGENTS.md): open the run and choose "Re-run failed jobs", or \`gh run rerun ${o.runId} --failed -R ${repo}\`.`;
}

/** What a failed stage's run says: its failed job and step, by name. */
export type Failure = { job: string; step?: string };

/**
 * Pure: one comment for a stage past its limit. The repo is public: it names
 * only the release, the stage, the run and its workflow-defined job and step
 * names, never a log line (one could name an install or a customer); the log
 * is behind the run link, and the rest is on the release-watch job summary.
 */
export function commentBody(
  o: Overrun,
  repo: string,
  config: Config,
  failure?: Failure,
): string {
  const usual = `usual ${o.usual} min, limit ${o.limit} min (${ruleText(config)})`;
  const head =
    o.kind === "failed"
      ? `**${o.tag} ${o.stage}** failed${o.startedAt ? ` ${o.minutes} min after it started (${o.startedAt})` : ""}; ${usual}.`
      : o.kind === "finished"
        ? `**${o.tag} ${o.stage}** finished past its limit: it took ${o.minutes} min; ${usual}.`
        : o.waiting
          ? `**${o.tag} ${o.stage}** is still running past its limit: it has not started ${o.minutes} min after what it waits on ended (since ${o.startedAt}); ${usual}.`
          : `**${o.tag} ${o.stage}** is still running past its limit: it has been going ${o.minutes} min (since ${o.startedAt}); ${usual}.`;
  const runUrl = o.runId
    ? `https://github.com/${repo}/actions/runs/${o.runId}`
    : undefined;
  const lines = [
    head,
    "",
    runUrl
      ? `- Run: [${o.runId}](${runUrl})${rerunAdvice(o, repo)}`
      : `- Run: none. This stage is a wait between events${o.url ? ` (${o.url})` : ""}.`,
  ];
  if (failure)
    lines.push(
      `- Failed job: \`${failure.job}\`${failure.step ? `, step \`${failure.step}\`` : ""}. Its log is on the run.`,
    );
  if (o.attempts) lines.push(`- Attempts: ${o.attempts}`);
  lines.push(
    "",
    `Every stage, time and ETA: the [release-watch job summary](https://github.com/${repo}/actions/workflows/release-watch.yml).`,
    commentKey(o),
  );
  return lines.join("\n");
}

/**
 * Pure: the stages to comment on, each release and stage once. A comment
 * already on the issue with the key, from a bot (this workflow's token), means
 * it was said; a refresh says nothing new.
 */
export function commentPlan(
  existing: { author: string; body: string }[],
  over: Overrun[],
): Overrun[] {
  const said = new Set(
    existing
      .filter((c) => c.author.endsWith("[bot]"))
      .flatMap((c) => [
        ...c.body.matchAll(/<!-- release-watch \S+ \S+(?: running)? -->/g),
      ])
      .map((m) => m[0]),
  );
  const out: Overrun[] = [];
  for (const o of over) {
    const k = commentKey(o);
    if (said.has(k)) continue;
    said.add(k);
    out.push(o);
  }
  return out;
}

/**
 * Pure: a release already finished in history, as a done timeline. It is not
 * rebuilt from GitHub: its pin PR or runs may since have left what a tick
 * reads, and rebuilding it then would show a finished release as stalled.
 */
export function fromHistory(h: HistoryEntry, config: Config): Timeline {
  const stages: StageRow[] = measured(config, h.mode).map((s) => ({
    name: s.name,
    ...(s.usual ? { usual: s.usual } : {}),
    state: s.optional && h.stages[s.name] === undefined ? "unmeasured" : "done",
    ...(h.stages[s.name] !== undefined ? { minutes: h.stages[s.name] } : {}),
  }));
  return {
    tag: h.tag,
    mode: h.mode,
    mergedAt: h.mergedAt,
    publishedAt: h.publishedAt,
    stages,
    ...(h.supersededBy
      ? { supersededBy: h.supersededBy, closedAt: h.doneAt }
      : { doneAt: h.doneAt }),
    e2e: h.e2e,
    e2eTo: h.e2eTo ?? NO_FLEET,
  };
}

/**
 * Pure: what a run comments on (events only, no poll): every stage that
 * finished past its limit, in every release this run sees (in flight, done,
 * superseded or read back from history), and every failed stage of a release
 * not done, and every stage of a release in flight that this run sees still
 * running past its limit (its own "still running" key, so the finished or
 * failed comment can follow). Each release is judged on its own runs: a newer
 * release in flight never hides an older one's. No poll looks again: a stage
 * that never finishes and raises no later event is the release agent's to
 * catch. The comments dedupe by release, stage and key (commentPlan).
 */
export function stuck(
  tls: Timeline[],
  config: Config,
  since?: string,
): Overrun[] {
  const out: Overrun[] = [];
  for (const t of [...tls].sort((a, b) => compareTags(a.tag, b.tag))) {
    if (since && ms(t.publishedAt) < ms(since)) continue;
    for (const s of t.stages) {
      const ids = s.runId ? { runId: s.runId, attempts: s.attempts ?? 1 } : {};
      if (
        s.state === "done" &&
        s.usual !== undefined &&
        s.minutes !== undefined &&
        s.minutes > limitOf(s.usual, config)
      )
        out.push({
          tag: t.tag,
          stage: s.name,
          kind: "finished",
          startedAt: s.startedAt,
          ...ids,
          minutes: s.minutes,
          usual: s.usual,
          limit: limitOf(s.usual, config),
          url: s.url,
        });
      else if (
        s.state === "current" &&
        !t.doneAt &&
        !t.supersededBy &&
        s.startedAt &&
        s.usual !== undefined &&
        (s.minutes ?? 0) > limitOf(s.usual, config)
      )
        // Seen still running past its limit on this event: an early heads-up
        // for the release agent, said once; no poll looks again.
        out.push({
          tag: t.tag,
          stage: s.name,
          kind: "in_flight",
          startedAt: s.startedAt,
          ...(s.waiting ? { waiting: true } : {}),
          ...ids,
          minutes: s.minutes ?? 0,
          usual: s.usual,
          limit: limitOf(s.usual, config),
          url: s.url,
        });
      else if (s.state === "red" && !t.doneAt)
        out.push({
          tag: t.tag,
          stage: s.name,
          kind: "failed",
          red: true,
          ...(s.startedAt ? { startedAt: s.startedAt } : {}),
          ...ids,
          minutes: s.minutes ?? 0,
          usual: s.usual ?? 0,
          limit: s.usual !== undefined ? limitOf(s.usual, config) : 0,
          url: s.url,
        });
    }
  }
  return out;
}

/** Pure: the whole tick from what was read. */
export function compute(o: {
  releases: Release[];
  runs: Run[];
  prs: Pr[];
  merges: Record<string, string | undefined>;
  history: HistoryEntry[];
  config: Config;
  now: string;
  /** Only releases published since then are commented on (a backfill's old ones are not). */
  notifySince?: string;
}) {
  // A recorded total to the prod deploy takes a later fleet finish.
  const prior = o.history.map((h) => upgradeFleet(h, o.runs));
  const known = new Map(prior.map((h) => [h.tag, h]));
  const all = supersede(
    o.releases.map((release) => {
      const h = known.get(release.tag);
      if (h) return fromHistory(h, o.config);
      return timeline({
        release,
        runs: o.runs,
        prs: o.prs,
        mergedAt: o.merges[release.tag],
        config: o.config,
        now: o.now,
      });
    }),
  );
  // Rebuilt ones only: a finished release stays as history has it.
  const tls = all.filter((t) => !known.has(t.tag));
  const history = mergeHistory(
    prior,
    tls.map(historyEntry).filter((e): e is HistoryEntry => !!e),
    o.config.historySize,
  );
  const s = stats(history, o.config);
  const { over, red } = overruns(all, o.config);
  // What a run comments on (events only, no poll): a stage that finished
  // past its limit, or failed. One still going is in the summary; one that
  // never finishes raises no event and is the release agent's to catch.
  const notify = stuck(all, o.config, o.notifySince);
  const inFlight = tls
    .filter((t) => !t.doneAt && !t.supersededBy)
    .map((t) => {
      const row = (x: StageRow) => ({
        stage: x.name,
        state: x.state,
        ...(x.waiting ? { waiting: true } : {}),
        stageStartedAt: x.startedAt,
        elapsed: x.startedAt ? x.minutes : undefined,
        usual: x.usual,
        limit: x.usual !== undefined ? limitOf(x.usual, o.config) : undefined,
        runUrl: x.url,
      });
      // Every stage going at once (they can overlap), else the next one.
      const going = t.stages.filter(
        (x) => x.state === "current" || x.state === "red",
      );
      const next = t.stages.find(
        (x) => x.state !== "done" && x.state !== "unmeasured",
      );
      const rows = (going.length > 0 ? going : next ? [next] : []).map(row);
      const e = eta(t, s.stages, o.now);
      return {
        tag: t.tag,
        mode: t.mode,
        oldestMergeAt: t.mergedAt,
        ...(rows[0] ?? {}),
        going: rows,
        etaP50: e?.p50,
        etaP90: e?.p90,
      };
    });
  const unmeasured = o.config.stages
    .filter((x) => x.measured === false || x.optional)
    .map((x) => ({ name: x.name, todo: x.todo ?? "" }));
  const current = {
    generatedAt: o.now,
    inFlight,
    stages: s.stages,
    limits: Object.fromEntries(
      Object.entries(s.stages).map(([k, v]) => [
        k,
        v.usual !== undefined ? limitOf(v.usual, o.config) : undefined,
      ]),
    ),
    e2e: s.e2e,
    unmeasured,
    overruns: over,
    red,
    releases: tls,
  };
  return { current, history, over, red, notify };
}

/** Pure: the job summary, markdown. */
export function summary(c: ReturnType<typeof compute>["current"]): string {
  const f = (x: number | null | undefined) => (x == null ? "-" : String(x));
  const out = [`## Release watch (${c.generatedAt})`, ""];
  if (c.inFlight.length === 0) out.push("No release in flight.", "");
  else {
    out.push(
      "| Release | Stage | State | Started | Elapsed (min) | Usual | Alert past | ETA p50 | ETA p90 |",
      "|---|---|---|---|---|---|---|---|---|",
    );
    for (const r of c.inFlight)
      for (const g of r.going)
        out.push(
          `| ${r.tag} | ${g.stage} | ${g.waiting ? "waiting" : g.state} | ${g.stageStartedAt ?? "-"} | ${f(g.elapsed)} | ${f(g.usual)} | ${f(g.limit)} | ${r.etaP50 ?? "-"} | ${r.etaP90 ?? "-"} |`,
        );
    out.push("");
  }
  out.push(
    "| Stage | p50 | p90 | n | Usual | Alert past |",
    "|---|---|---|---|---|---|",
  );
  for (const [k, v] of Object.entries(c.stages))
    out.push(
      `| ${k} | ${f(v.p50)} | ${f(v.p90)} | ${v.n} | ${f(v.usual)} | ${f(c.limits[k])} |`,
    );
  out.push(
    "",
    `### Merge to every install, target ${c.e2e.target} min`,
    "",
    `Measured from the merge to every install where the prod deploy recorded the fleet finish (its "${FLEET_DONE_STEP}" step), else to ${NO_FLEET}; each release says which. Reported, never alerted on. p50 ${f(c.e2e.p50)}, p90 ${f(c.e2e.p90)}, n ${c.e2e.n}.`,
    "",
  );
  if (c.e2e.last20.length === 0) out.push("No finished release yet.", "");
  else {
    out.push(
      `| Release | Minutes | To | Against ${c.e2e.target} min |`,
      "|---|---|---|---|",
    );
    for (const r of c.e2e.last20) {
      const d = Math.round((r.e2e - c.e2e.target) * 10) / 10;
      out.push(
        `| ${r.tag} | ${r.e2e} | ${r.to} | ${d > 0 ? `${d} over` : "within"} |`,
      );
    }
    out.push("");
  }
  for (const u of c.unmeasured)
    out.push(`Measured only where recorded: ${u.name}, ${u.todo}.`);
  if (c.overruns.length > 0)
    out.push(
      "",
      `Stuck: ${c.overruns.length} stage(s) past their limit, each said once on the "${ISSUE_TITLE}" issue.`,
    );
  return `${out.join("\n")}\n`;
}

// ---- I/O ----------------------------------------------------------------

/** Parses history.jsonl, dropping any line that is not a well-formed entry. */
export function parseHistory(text: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as HistoryEntry;
      if (
        TAG_RE.test(e.tag) &&
        typeof e.doneAt === "string" &&
        typeof e.publishedAt === "string" &&
        e.stages &&
        typeof e.stages === "object" &&
        Object.values(e.stages).every((v) => typeof v === "number")
      )
        out.push(e);
    } catch {}
  }
  return out;
}

const lines = <T>(s: string): T[] =>
  s
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

export const WORKFLOWS = [
  "hosted-release.yml",
  "hosted-publish.yml",
  "deploy-hosted-platform.yml",
  "redline-staging.yml",
];
const RUN_JQ =
  '.workflow_runs[] | {id, path, event, title: .display_title, status, conclusion, headSha: .head_sha, createdAt: .created_at, startedAt: .run_started_at, updatedAt: .updated_at, attempt: .run_attempt, url: .html_url, commitMessage: (.head_commit.message // ""), commitAt: (.head_commit.timestamp // "")} | tojson';

export function readRuns(exec: Exec, repo: string, since: string): Run[] {
  return WORKFLOWS.flatMap((f) =>
    lines<Run>(
      gh(exec, [
        "api",
        "--paginate",
        "-X",
        "GET",
        "--jq",
        RUN_JQ,
        `repos/${repo}/actions/workflows/${f}/runs?branch=main&created=>=${since}&per_page=100`,
      ]),
    ),
  );
}

/**
 * The runs whose jobs are read: the workflows that name their release in a
 * job (cloud #469, hosted-publish.yml), and the prod deploy, whose steps
 * record the fleet finish (cloud #474).
 */
export const NAMED_WORKFLOWS = ["hosted-release.yml", "hosted-publish.yml"];
const jobsWanted = (r: Run) =>
  NAMED_WORKFLOWS.includes(file(r)) ||
  (file(r) === "deploy-hosted-platform.yml" &&
    r.title.startsWith("deploy-hosted-platform prod "));
const JOB_JQ =
  ".jobs[] | {name, status, conclusion, startedAt: .started_at, completedAt: .completed_at, steps: [(.steps // [])[] | {name, status, conclusion, startedAt: .started_at, completedAt: .completed_at}]} | tojson";

/** One run's latest attempt's jobs. */
export function readJobs(exec: Exec, repo: string, id: number): Job[] {
  return lines<Job>(
    gh(exec, [
      "api",
      "-X",
      "GET",
      "--jq",
      JOB_JQ,
      `repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`,
    ]),
  );
}

/**
 * Adds the jobs of each hosted-release, hosted-publish and prod deploy run
 * created since `from` (the oldest release not yet in history was
 * published). Nothing in flight reads nothing.
 */
export function withJobs(
  exec: Exec,
  repo: string,
  runs: Run[],
  from: number | undefined,
  fleetTags: string[] = [],
): Run[] {
  // Plus the prod deploys of finished releases whose fleet is not measured:
  // a later "Fleet done" for that tag counts.
  const want = (r: Run) =>
    (from !== undefined && jobsWanted(r) && ms(r.createdAt) >= from) ||
    fleetTags.some((t) => prodDeploys([r], t).length > 0);
  return runs.map((r) =>
    want(r) ? { ...r, jobs: readJobs(exec, repo, r.id) } : r,
  );
}

/** Stable public releases, oldest first. */
export function readReleases(
  exec: Exec,
  publicRepo: string,
  all: boolean,
): Release[] {
  const rel = lines<{ tag: string; publishedAt: string }>(
    gh(exec, [
      "api",
      ...(all ? ["--paginate"] : []),
      "-X",
      "GET",
      "--jq",
      ".[] | select((.draft | not) and (.prerelease | not)) | {tag: .tag_name, publishedAt: .published_at} | tojson",
      `repos/${publicRepo}/releases?per_page=100`,
    ]),
  );
  return rel
    .filter((r) => TAG_RE.test(r.tag) && r.publishedAt)
    .sort((a, b) => compareTags(a.tag, b.tag));
}

const PR_JQ = `.[] | select(.head.ref | startswith("${BRANCH_PREFIX}")) | {number, ref: .head.ref, createdAt: .created_at, mergedAt: .merged_at, url: .html_url} | tojson`;

/** Every pin-bump PR, all pages: for a backfill. */
export function readPrs(exec: Exec, repo: string): Pr[] {
  return lines<Pr>(
    gh(exec, [
      "api",
      "--paginate",
      "-X",
      "GET",
      "--jq",
      PR_JQ,
      `repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100`,
    ]),
  );
}

/**
 * Each tag's pin-bump PRs, looked up by head branch, so an old release's PR is
 * found however many PRs are newer.
 */
export function readPinPrs(exec: Exec, repo: string, tags: string[]): Pr[] {
  const owner = repo.split("/")[0] ?? "";
  return tags
    .filter((t) => TAG_RE.test(t))
    .flatMap((t) =>
      lines<Pr>(
        gh(exec, [
          "api",
          "-X",
          "GET",
          "--jq",
          PR_JQ,
          `repos/${repo}/pulls?state=all&head=${owner}:${BRANCH_PREFIX}${t}&per_page=100`,
        ]),
      ).filter((p) => p.ref === `${BRANCH_PREFIX}${t}`),
    );
}

/**
 * When the oldest change in a release merged: the merged_at of the PR of the
 * oldest commit in prev...tag that is not a release commit (a merge-queue
 * commit's date is when it was queued, not merged). The commit date if the
 * commit has no PR; undefined with no previous tag.
 */
export function readMerge(
  exec: Exec,
  publicRepo: string,
  prev: string | undefined,
  tag: string,
): string | undefined {
  if (!prev) return undefined;
  const commits = JSON.parse(
    gh(exec, [
      "api",
      "-X",
      "GET",
      "--jq",
      '[.commits[] | {sha, subject: (.commit.message | split("\\n")[0]), date: .commit.committer.date}]',
      `repos/${publicRepo}/compare/${prev}...${tag}`,
    ]),
  ) as { sha: string; subject: string; date: string }[];
  const first = commits.find(
    (c) => !/^chore\(main\): release /.test(c.subject),
  );
  if (!first || !/^[0-9a-f]{40}$/.test(first.sha)) return undefined;
  const merged = gh(exec, [
    "api",
    "-X",
    "GET",
    "--jq",
    "[.[] | .merged_at | select(.)] | min // empty",
    `repos/${publicRepo}/commits/${first.sha}/pulls`,
  ]).trim();
  return merged || first.date;
}

/**
 * The failed job and step of a run, by name. Reads only the run's jobs
 * (actions: read), never a log.
 */
export function readFailure(
  exec: Exec,
  repo: string,
  runId: number,
): Failure | undefined {
  const jobs = lines<Job>(
    gh(exec, [
      "api",
      "-X",
      "GET",
      "--jq",
      ".jobs[] | {name, conclusion, steps: [(.steps // [])[] | {name, conclusion}]} | tojson",
      `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    ]),
  );
  const j = jobs.find((x) => x.conclusion === "failure");
  if (!j) return undefined;
  const step = j.steps?.find((x) => x.conclusion === "failure")?.name;
  return { job: j.name, ...(step ? { step } : {}) };
}

/**
 * One comment per release and stage past its limit, on the one open issue
 * titled ISSUE_TITLE, created (default token, issues: write) the first time
 * one is needed and reused after. It is never edited or closed by a tick, and
 * nothing is read or written while nothing is past its limit.
 */
export function notifyStuck(
  exec: Exec,
  repo: string,
  over: Overrun[],
  config: Config,
): { action: "none" | "comment"; issue?: number; posted: string[] } {
  if (over.length === 0) return { action: "none", posted: [] };
  const open = JSON.parse(
    gh(exec, [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "500",
      "--json",
      "number,title",
    ]),
  ) as { number: number; title: string }[];
  let issue = open
    .filter((i) => i.title === ISSUE_TITLE)
    .sort((a, b) => a.number - b.number)[0]?.number;
  const existing = issue
    ? lines<{ author: string; body: string }>(
        gh(exec, [
          "api",
          "--paginate",
          "-X",
          "GET",
          "--jq",
          ".[] | {author: .user.login, body} | tojson",
          `repos/${repo}/issues/${issue}/comments?per_page=100`,
        ]),
      )
    : [];
  const todo = commentPlan(existing, over);
  if (todo.length === 0) return { action: "none", issue, posted: [] };
  if (!issue) {
    const url = gh(
      exec,
      [
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        ISSUE_TITLE,
        "--body",
        `Release watch (cloud #264): one comment per release and stage that runs past its limit, ${ruleText(config)}. Usual times: \`.github/hosted/release-stages.json\`. Every stage, time and ETA: the [release-watch job summary](https://github.com/${repo}/actions/workflows/release-watch.yml).`,
      ],
      { write: true },
    ).trim();
    issue = Number(/\/issues\/(\d+)\s*$/.exec(url)?.[1]);
    if (!Number.isInteger(issue) || issue <= 0)
      throw new Error(`release-watch: no issue number in "${url}"`);
  }
  const posted: string[] = [];
  for (const o of todo) {
    const failure =
      o.red && o.runId ? readFailure(exec, repo, o.runId) : undefined;
    gh(
      exec,
      [
        "issue",
        "comment",
        String(issue),
        "--repo",
        repo,
        "--body",
        commentBody(o, repo, config, failure),
      ],
      { write: true },
    );
    posted.push(`${o.tag} ${o.stage}`);
  }
  return { action: "comment", issue, posted };
}

export function tick(o: {
  exec: Exec;
  repo: string;
  publicRepo: string;
  config: Config;
  history: HistoryEntry[];
  since?: string;
  now: string;
  issue: boolean;
}) {
  const backfill = !!o.since;
  const all = readReleases(o.exec, o.publicRepo, backfill);
  const from = backfill
    ? `${o.since}T00:00:00Z`
    : new Date(ms(o.now) - o.config.lookbackHours * 3_600_000).toISOString();
  const newest = all[all.length - 1];
  const releases = all.filter(
    (r) => ms(r.publishedAt) >= ms(from) || r === newest,
  );
  const oldest = releases.reduce(
    (m, r) => (ms(r.publishedAt) < m ? ms(r.publishedAt) : m),
    ms(from),
  );
  const since = new Date(oldest).toISOString().replace(/\.\d{3}Z$/, "Z");
  const history = backfill ? [] : o.history;
  const known = new Map(history.map((h) => [h.tag, h]));
  const merges: Record<string, string | undefined> = {};
  for (const r of releases) {
    const h = known.get(r.tag);
    if (h) {
      merges[r.tag] = h.mergedAt;
      continue;
    }
    const prev = all[all.indexOf(r) - 1]?.tag;
    merges[r.tag] = readMerge(o.exec, o.publicRepo, prev, r.tag);
  }
  const open = releases.filter((r) => !known.has(r.tag));
  const jobsFrom =
    open.length > 0
      ? Math.min(...open.map((r) => ms(r.publishedAt)))
      : undefined;
  const out = compute({
    releases,
    runs: withJobs(
      o.exec,
      o.repo,
      readRuns(o.exec, o.repo, since),
      jobsFrom,
      releases
        .map((r) => known.get(r.tag))
        .filter(
          (h): h is HistoryEntry =>
            !!h && !h.supersededBy && h.e2eTo !== "every install",
        )
        .map((h) => h.tag),
    ),
    prs: backfill
      ? readPrs(o.exec, o.repo)
      : readPinPrs(
          o.exec,
          o.repo,
          releases.filter((r) => !known.has(r.tag)).map((r) => r.tag),
        ),
    merges,
    history,
    config: o.config,
    now: o.now,
    // A backfill comments only on what a normal run would see.
    ...(backfill
      ? {
          notifySince: new Date(
            ms(o.now) - o.config.lookbackHours * 3_600_000,
          ).toISOString(),
        }
      : {}),
  });
  const issue = o.issue
    ? notifyStuck(o.exec, o.repo, out.notify, o.config)
    : { action: "skipped" };
  return { ...out, issue };
}

export function loadConfig(text: string): Config {
  const c = JSON.parse(text) as Config;
  if (!Array.isArray(c.stages) || c.stages.length === 0)
    throw new Error("release-stages.json: no stages");
  const evs = (k: unknown) =>
    typeof k === "string"
      ? !!k
      : Array.isArray(k) &&
        k.length > 0 &&
        k.every((x) => typeof x === "string" && !!x);
  for (const s of c.stages)
    if (
      !s.name ||
      !evs(s.from) ||
      !s.to ||
      (s.after !== undefined && !evs(s.after)) ||
      (s.measured !== false && !s.optional && !((s.usual ?? 0) > 0))
    )
      throw new Error(`release-stages.json: bad stage ${JSON.stringify(s)}`);
  if (
    !(c.alertFactor > 1) ||
    !(typeof c.alertFloor === "number" && c.alertFloor >= 0) ||
    !(c.e2eTarget > 0)
  )
    throw new Error(
      "release-stages.json: alertFactor > 1, alertFloor >= 0 and e2eTarget > 0",
    );
  return c;
}

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};
const flag = (argv: string[], name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? "" : (argv[i + 1] ?? "");
};

function main(argv: string[]): number {
  const repo = flag(argv, "repo");
  const outDir = flag(argv, "out");
  const since = flag(argv, "since");
  if (argv[0] !== "tick" || !repo || !outDir) {
    console.error(
      "usage: release-watch.ts tick --repo owner/name --out DIR [--public owner/name] [--stages FILE] [--history FILE] [--since YYYY-MM-DD] [--no-issue]",
    );
    return 2;
  }
  if (since && !/^20\d\d-\d\d-\d\d$/.test(since))
    throw new Error("--since is YYYY-MM-DD");
  const config = loadConfig(
    readFileSync(
      flag(argv, "stages") || ".github/hosted/release-stages.json",
      "utf8",
    ),
  );
  const hf = flag(argv, "history");
  const history =
    hf && existsSync(hf) ? parseHistory(readFileSync(hf, "utf8")) : [];
  const r = tick({
    exec: realExec,
    repo,
    publicRepo: flag(argv, "public") || PUBLIC_REPO,
    config,
    history,
    since: since || undefined,
    now: new Date().toISOString(),
    issue: !argv.includes("--no-issue"),
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "current.json"),
    `${JSON.stringify(r.current, null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, "history.jsonl"),
    r.history.map((h) => JSON.stringify(h)).join("\n") +
      (r.history.length ? "\n" : ""),
  );
  const md = summary(r.current);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.stdout.write(md);
  console.log(`issue: ${r.issue.action}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`release-watch: ${(e as Error).message}`);
    process.exit(1);
  }
}
