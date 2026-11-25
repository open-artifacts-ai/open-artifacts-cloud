// Release watch, measure only (cloud #264, Lane 5 PR1): how long each release
// takes, stage by stage, against a budget, and one `blocker` issue while a
// release is over budget. It gates nothing and is never a required check.
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
// Reads: the runs of four workflows on main, public's releases, this repo's
// pin-bump PRs, and per release not yet in history a compare and a commit's
// PRs on public (its merge time). Writes: only the one issue, through gh().
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

export const ISSUE_TITLE = "release over budget";
const TAG_RE = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const MIN = 60_000;

export type Stage = {
  name: string;
  from: string;
  to: string;
  budget: number;
  mode?: "pr" | "direct";
  measured?: boolean;
  todo?: string;
};
export type Config = {
  pinMode: "pr" | "direct";
  e2eTarget: number;
  e2eWorst: number;
  lookbackHours: number;
  statsWindow: number;
  historySize: number;
  stages: Stage[];
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
};
export type StageRow = {
  name: string;
  budget: number;
  startedAt?: string;
  endedAt?: string;
  minutes?: number;
  state: "done" | "current" | "red" | "pending";
  url?: string;
};
export type Timeline = {
  tag: string;
  mode: "pr" | "direct";
  mergedAt?: string;
  publishedAt: string;
  stages: StageRow[];
  doneAt?: string;
  /** A newer release reached the pin while this one was not done: it never ships alone. */
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
  stages: Record<string, number>;
};
export type Overrun = {
  tag: string;
  stage: string;
  kind: "in_flight" | "last_release";
  startedAt: string;
  minutes: number;
  budget: number;
  url?: string;
};
export type Red = { tag: string; stage: string; url?: string };

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
  if (ok)
    return { state: "done", startedAt, doneAt: ok.updatedAt, url: ok.url };
  const last = sorted[sorted.length - 1] as Run;
  const running = last.status !== "completed";
  return {
    state: running ? "running" : "red",
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

/** Pure: the runs of each step of one release. */
export function steps(tag: string, runs: Run[]): Record<string, Step> {
  const pinRuns = runs.filter(
    (r) =>
      file(r) === "hosted-release.yml" &&
      r.event === "push" &&
      pinSubject(r.commitMessage, tag),
  );
  const shas = new Set(pinRuns.map((r) => r.headSha));
  const by = (f: string, pred: (r: Run) => boolean) =>
    runs.filter((r) => file(r) === f && pred(r));
  return {
    hosted_release: step(pinRuns),
    staging_publish: step(
      by(
        "hosted-publish.yml",
        (r) => r.event === "workflow_run" && shas.has(r.headSha),
      ),
    ),
    staging_deploy: step(
      by("deploy-hosted-platform.yml", (r) =>
        titled(r.title, `deploy-hosted-platform staging ${tag}`),
      ),
    ),
    redline: step(
      by("redline-staging.yml", (r) => r.title === `redline-staging ${tag}`),
    ),
    prod_publish: step(
      by("hosted-publish.yml", (r) =>
        titled(r.title, `hosted-publish prod ${tag}`),
      ),
    ),
    prod_deploy: step(
      by("deploy-hosted-platform.yml", (r) =>
        titled(r.title, `deploy-hosted-platform prod ${tag}`),
      ),
    ),
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
  const st = steps(tag, o.runs);
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
  for (const [k, s] of Object.entries(st)) {
    ev[`${k}.started`] = s.startedAt;
    ev[`${k}.done`] = s.doneAt;
  }
  const rows: StageRow[] = [];
  let current = false;
  for (const s of measured(config, mode)) {
    const from = ev[s.from];
    const to = ev[s.to];
    const owner = st[s.to.split(".")[0] ?? ""];
    const url =
      owner?.url ??
      (s.to === "pin_opened" || s.to === "pinned"
        ? (merged ?? pr[pr.length - 1])?.url
        : undefined);
    if (current) {
      rows.push({ name: s.name, budget: s.budget, state: "pending" });
    } else if (from && to) {
      rows.push({
        name: s.name,
        budget: s.budget,
        startedAt: from,
        endedAt: to,
        minutes: mins(from, to),
        state: "done",
        url,
      });
    } else if (to) {
      // Ended, start unknown (no previous tag to date the merge): done, untimed.
      rows.push({
        name: s.name,
        budget: s.budget,
        endedAt: to,
        state: "done",
        url,
      });
    } else if (from) {
      current = true;
      rows.push({
        name: s.name,
        budget: s.budget,
        startedAt: from,
        minutes: mins(from, o.now),
        state: owner?.state === "red" ? "red" : "current",
        url,
      });
    } else {
      current = true;
      rows.push({ name: s.name, budget: s.budget, state: "pending" });
    }
  }
  const last = rows[rows.length - 1];
  const doneAt = last?.state === "done" ? last.endedAt : undefined;
  const start = o.mergedAt ?? release.publishedAt;
  return {
    tag,
    mode,
    mergedAt: o.mergedAt,
    publishedAt: release.publishedAt,
    stages: rows,
    doneAt,
    e2e: doneAt ? mins(start, doneAt) : undefined,
  };
}

/**
 * Pure: a release that is not done once a newer one is pinned never ships on
 * its own (the chain moves to the newest tag). It closes when that newer
 * release is done, and its e2e counts to then.
 */
export function supersede(tls: Timeline[]): Timeline[] {
  const byTag = [...tls].sort((a, b) => compareTags(a.tag, b.tag));
  return byTag.map((t, i) => {
    if (t.doneAt) return t;
    const newer = byTag
      .slice(i + 1)
      .find((n) =>
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
  { p50: number | null; p90: number | null; n: number; budget: number }
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
      budget: s.budget,
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
      worst: config.e2eWorst,
      last20: recent
        .filter((x) => typeof x.e2e === "number")
        .slice(-20)
        .map((x) => ({ tag: x.tag, e2e: x.e2e as number })),
    },
  };
}

/**
 * Pure: when an in-flight release should be done, at p50 and p90. The current
 * stage takes what is left of its own figure (never less than zero), each later
 * stage its whole figure; a stage with no samples yet uses its budget. A red
 * stage waits for a person: no ETA.
 */
export function eta(
  t: Timeline,
  st: Stats,
  now: string,
): { p50: string; p90: string } | null {
  const i = t.stages.findIndex((s) => s.state !== "done");
  if (i < 0) return null;
  const cur = t.stages[i] as StageRow;
  if (cur.state === "red") return null;
  const fig = (name: string, k: "p50" | "p90", budget: number) =>
    st[name]?.[k] ?? budget;
  const left = (k: "p50" | "p90") => {
    const elapsed = cur.state === "current" ? (cur.minutes ?? 0) : 0;
    let m = Math.max(0, fig(cur.name, k, cur.budget) - elapsed);
    for (const s of t.stages.slice(i + 1)) m += fig(s.name, k, s.budget);
    return new Date(ms(now) + Math.round(m * MIN)).toISOString();
  };
  return { p50: left("p50"), p90: left("p90") };
}

/**
 * Pure: what is over budget. An in-flight release (not superseded) over its
 * current stage's budget, or past e2eWorst since its merge; and the newest
 * finished release's own overruns, so the issue stays open until a release
 * completes within budget. A red stage is not an overrun: the red run's own
 * blocker covers it, and it is listed apart.
 */
export function overruns(
  tls: Timeline[],
  config: Config,
  now: string,
): { over: Overrun[]; red: Red[] } {
  const over: Overrun[] = [];
  const red: Red[] = [];
  const live = tls.filter((t) => !t.doneAt && !t.supersededBy);
  for (const t of live) {
    const cur = t.stages.find(
      (s) => s.state === "current" || s.state === "red",
    );
    if (cur?.state === "red") {
      red.push({ tag: t.tag, stage: cur.name, url: cur.url });
      continue;
    }
    if (cur?.startedAt && (cur.minutes ?? 0) > cur.budget)
      over.push({
        tag: t.tag,
        stage: cur.name,
        kind: "in_flight",
        startedAt: cur.startedAt,
        minutes: cur.minutes ?? 0,
        budget: cur.budget,
        url: cur.url,
      });
    const start = t.mergedAt ?? t.publishedAt;
    const e2e = mins(start, now);
    if (e2e > config.e2eWorst)
      over.push({
        tag: t.tag,
        stage: "e2e",
        kind: "in_flight",
        startedAt: start,
        minutes: e2e,
        budget: config.e2eWorst,
      });
  }
  const finished = tls
    .filter((t) => t.doneAt)
    .sort((a, b) => compareTags(a.tag, b.tag));
  const newest = finished[finished.length - 1];
  const newerLive = live.some(
    (t) => newest && compareTags(t.tag, newest.tag) > 0,
  );
  if (newest && !newerLive) {
    for (const s of newest.stages)
      if (s.startedAt && (s.minutes ?? 0) > s.budget)
        over.push({
          tag: newest.tag,
          stage: s.name,
          kind: "last_release",
          startedAt: s.startedAt,
          minutes: s.minutes ?? 0,
          budget: s.budget,
          url: s.url,
        });
    if ((newest.e2e ?? 0) > config.e2eWorst)
      over.push({
        tag: newest.tag,
        stage: "e2e",
        kind: "last_release",
        startedAt: newest.mergedAt ?? newest.publishedAt,
        minutes: newest.e2e ?? 0,
        budget: config.e2eWorst,
      });
  }
  return { over, red };
}

/**
 * Pure: the issue body. It holds no clock that moves between ticks (no
 * elapsed figure for an in-flight stage), so an unchanged state gives an
 * unchanged body and no edit.
 */
export function issueBody(over: Overrun[], red: Red[]): string {
  const lines = [
    "Release watch (cloud #264): a release stage is over its budget.",
    "Budgets: `.github/hosted/release-stages.json`. This issue closes itself once no release is over budget and the newest release finished within budget.",
    "",
  ];
  for (const o of over) {
    const run = o.url ? ` Run: ${o.url}` : "";
    lines.push(
      o.kind === "in_flight"
        ? `- ${o.tag} ${o.stage}: still going, budget ${o.budget} min, started ${o.startedAt}.${run}`
        : `- ${o.tag} ${o.stage}: took ${o.minutes} min, budget ${o.budget} min.${run}`,
    );
  }
  if (red.length > 0) {
    lines.push("", "Red, covered by that run's own blocker issue:");
    for (const r of red)
      lines.push(`- ${r.tag} ${r.stage}${r.url ? `: ${r.url}` : ""}`);
  }
  return lines.join("\n");
}

export type IssueAction =
  | { action: "none" }
  | { action: "create"; body: string }
  | { action: "edit"; number: number; body: string }
  | { action: "close"; number: number; comment: string };

/** Pure: what to do with the one issue, given the open ones titled ISSUE_TITLE. */
export function issuePlan(
  open: { number: number; title: string; body: string }[],
  over: Overrun[],
  red: Red[],
): IssueAction {
  const mine = open
    .filter((i) => i.title === ISSUE_TITLE)
    .sort((a, b) => a.number - b.number)[0];
  if (over.length === 0)
    return mine
      ? {
          action: "close",
          number: mine.number,
          comment:
            "Within budget again: no release is over budget and the newest release finished within budget.",
        }
      : { action: "none" };
  const body = issueBody(over, red);
  if (!mine) return { action: "create", body };
  if (mine.body.trim() === body.trim()) return { action: "none" };
  return { action: "edit", number: mine.number, body };
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
}) {
  const tls = supersede(
    o.releases.map((release) =>
      timeline({
        release,
        runs: o.runs,
        prs: o.prs,
        mergedAt: o.merges[release.tag],
        config: o.config,
        now: o.now,
      }),
    ),
  );
  const history = mergeHistory(
    o.history,
    tls.map(historyEntry).filter((e): e is HistoryEntry => !!e),
    o.config.historySize,
  );
  const s = stats(history, o.config);
  const { over, red } = overruns(tls, o.config, o.now);
  const inFlight = tls
    .filter((t) => !t.doneAt && !t.supersededBy)
    .map((t) => {
      const cur = t.stages.find((x) => x.state !== "done");
      const e = eta(t, s.stages, o.now);
      return {
        tag: t.tag,
        mode: t.mode,
        oldestMergeAt: t.mergedAt,
        stage: cur?.name,
        state: cur?.state,
        stageStartedAt: cur?.startedAt,
        elapsed: cur?.startedAt ? cur.minutes : undefined,
        budget: cur?.budget,
        etaP50: e?.p50,
        etaP90: e?.p90,
        runUrl: cur?.url,
      };
    });
  const unmeasured = o.config.stages
    .filter((x) => x.measured === false)
    .map((x) => ({ name: x.name, todo: x.todo ?? "" }));
  const current = {
    generatedAt: o.now,
    inFlight,
    stages: s.stages,
    e2e: s.e2e,
    unmeasured,
    overruns: over,
    red,
    releases: tls,
  };
  return { current, history, over, red };
}

/** Pure: the job summary, markdown. */
export function summary(c: ReturnType<typeof compute>["current"]): string {
  const f = (x: number | null | undefined) => (x == null ? "-" : String(x));
  const out = [`## Release watch (${c.generatedAt})`, ""];
  if (c.inFlight.length === 0) out.push("No release in flight.", "");
  else {
    out.push(
      "| Release | Stage | State | Started | Elapsed (min) | Budget | ETA p50 | ETA p90 |",
      "|---|---|---|---|---|---|---|---|",
    );
    for (const r of c.inFlight)
      out.push(
        `| ${r.tag} | ${r.stage ?? "-"} | ${r.state ?? "-"} | ${r.stageStartedAt ?? "-"} | ${f(r.elapsed)} | ${f(r.budget)} | ${r.etaP50 ?? "-"} | ${r.etaP90 ?? "-"} |`,
      );
    out.push("");
  }
  out.push("| Stage | p50 | p90 | n | Budget |", "|---|---|---|---|---|");
  for (const [k, v] of Object.entries(c.stages))
    out.push(`| ${k} | ${f(v.p50)} | ${f(v.p90)} | ${v.n} | ${v.budget} |`);
  out.push(
    `| e2e (merge to prod) | ${f(c.e2e.p50)} | ${f(c.e2e.p90)} | ${c.e2e.n} | target ${c.e2e.target}, worst ${c.e2e.worst} |`,
    "",
  );
  for (const u of c.unmeasured) out.push(`Not measured: ${u.name}, ${u.todo}.`);
  if (c.overruns.length > 0)
    out.push("", `Over budget: ${c.overruns.length}, see the blocker issue.`);
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

export function readPrs(exec: Exec, repo: string, all: boolean): Pr[] {
  return lines<Pr>(
    gh(exec, [
      "api",
      ...(all ? ["--paginate"] : []),
      "-X",
      "GET",
      "--jq",
      `.[] | select(.head.ref | startswith("${BRANCH_PREFIX}")) | {number, ref: .head.ref, createdAt: .created_at, mergedAt: .merged_at, url: .html_url} | tojson`,
      `repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100`,
    ]),
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

export function syncIssue(
  exec: Exec,
  repo: string,
  over: Overrun[],
  red: Red[],
) {
  const open = JSON.parse(
    gh(exec, [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--label",
      "blocker",
      "--limit",
      "100",
      "--json",
      "number,title,body",
    ]),
  ) as { number: number; title: string; body: string }[];
  const a = issuePlan(open, over, red);
  if (a.action === "create")
    gh(
      exec,
      [
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        ISSUE_TITLE,
        "--label",
        "blocker",
        "--body",
        a.body,
      ],
      { write: true },
    );
  else if (a.action === "edit")
    gh(
      exec,
      ["issue", "edit", String(a.number), "--repo", repo, "--body", a.body],
      { write: true, idempotent: true },
    );
  else if (a.action === "close")
    gh(
      exec,
      [
        "issue",
        "close",
        String(a.number),
        "--repo",
        repo,
        "--comment",
        a.comment,
      ],
      { write: true },
    );
  return a;
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
  const out = compute({
    releases,
    runs: readRuns(o.exec, o.repo, since),
    prs: readPrs(o.exec, o.repo, backfill),
    merges,
    history,
    config: o.config,
    now: o.now,
  });
  const issue = o.issue
    ? syncIssue(o.exec, o.repo, out.over, out.red)
    : { action: "skipped" };
  return { ...out, issue };
}

export function loadConfig(text: string): Config {
  const c = JSON.parse(text) as Config;
  if (!Array.isArray(c.stages) || c.stages.length === 0)
    throw new Error("release-stages.json: no stages");
  for (const s of c.stages)
    if (!s.name || !s.from || !s.to || !(s.budget > 0))
      throw new Error(`release-stages.json: bad stage ${JSON.stringify(s)}`);
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
