// The flaky tracker (cloud #447, #264 lane 4 PR2). Tracking only: it changes
// no retry and nothing that blocks. flaky-tracker.yml runs it when a CI run or
// a release gate (redline-staging) passes on a later attempt (2 or more) after
// an earlier attempt of the same run, so the same head sha, failed. Each test
// that failed on an earlier attempt failed and then passed with no change.
//
// Where the failures come from: the earlier attempt's job logs (one log per
// failed job; job ids are per attempt, artifacts are not):
//   - CI, vitest (the overlay shards): ` FAIL  <file> > <name>` lines. The
//     path is relative to the vitest root: the package of the enclosing
//     `::group::test <pkg>` (private packages), the package named by
//     `ci-public-tests: <pkg> [...]` (private tests in public packages), or
//     the overlay root (scripts/ci, scripts/ops, scripts/audit).
//   - CI, Playwright (`e2e (<app>)`): the epilogue under `  N failed`, one line
//     per test, `    e2e/<file>:L:C › <title>`, under apps/<app>.
//   - redline-staging, T19: the same epilogue with a project,
//     `    [project] › e2e/staging/<file>:L:C › <title>` (public's dashboard).
//   - redline-staging, red-line: the final `Red-line report (...)` block (src/
//     report.ts formatReport) lists `  [fail] <name> (<reason>)` under `Not
//     pass:`. The file comes from vitest's `FAIL  live/<file> > <name>` lines
//     in the same log. Only `fail` counts: `infra` is the environment, not the
//     test, and `blocked` follows another case.
// A failure outside the tests (bring-up, lint, a hand-off) parses to no test
// and is only listed in the step summary.
//
// Every sighting is recorded; an issue is opened or bumped only for a test
// seen in two different runs within 7 days. The sightings live in one issue
// per repo labelled `flaky-sightings` (the store): each tracker run that finds
// new sightings adds one comment holding one machine line per test,
// `flaky-sighting <time> <key> <run>/<attempt>`, inside an HTML comment, with a
// readable list above it. The store is read with `since` = 7 days ago, so a
// read is a page or two however old the issue gets, and only comments by
// github-actions[bot] count, so a person's comment can't add a sighting. Why
// this store: it needs no new service and no secret (the default token has
// issues: write); it is read back at once, unlike issue search, which lags
// its index and has its own rate limit; it is one issue, not an issue or a
// label hit per sighting; and it outlives what Actions keeps (caches go after
// 7 idle days and are per branch, artifacts are per run). Two tracker runs
// racing on an empty repo may each open a store: every store issue is read,
// and the lowest-numbered open one is written.
//
// One issue per test, keyed on the test's identity only (suite, file and
// name: `suite:file:name`), never on its error text. When more than
// MAX_ISSUES_PER_RUN tests failed in one run, the attempt was broken rather
// than flaky: one summary issue lists them, and no sighting is recorded. The
// issue body carries `<!-- flaky-key: K -->` (K is a hash of the test id) and
// `<!-- flaky-seen: ... -->`, one entry per run in it. A run already in the
// list is never noted twice. The owner is the last author of the test file at
// the commit under test (CI: this repo at the head sha; T19: public's file at
// the tag's PUBLIC_PIN; red-line: this repo's tests/redline at the tag). The
// owner is assigned when GitHub says they can be; otherwise the login is
// written in plain text, never as a mention.
//
// TODO(lane 3): when redline-staging runs as a reusable workflow (a queue gate
// calling it with workflow_call), workflow_run fires under the caller's name,
// not redline-staging, and this tracker never sees that run. Add the caller to
// flaky-tracker.yml's workflows and read its jobs (named `<caller job> /
// t19`, `<caller job> / redline`) the same way. Not built yet.
//
// Usage: node --experimental-strip-types scripts/ci/flaky-tracker.ts --repo o/n --workflow <CI|redline-staging> --run-id <id> --attempt <n> --head-sha <sha> [--title "redline-staging vX.Y.Z"]
// Needs GH_TOKEN (actions: read, contents: read, issues: write).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type Exec, gh } from "./gh-retry.ts";

export const LABEL = "flaky";
export const STORE_LABEL = "flaky-sightings";
export const STORE_MARKER = "<!-- flaky-sightings-store -->";
/** Only this author's store comments hold sightings. */
export const STORE_AUTHOR = "github-actions[bot]";
export const PUBLIC_REPO = "open-artifacts-ai/open-artifacts";
/** T19's specs sit in this package of public; Playwright prints paths from it. */
export const T19_PACKAGE = "apps/dashboard";
export const REDLINE_DIR = "tests/redline";
export const WINDOW_DAYS = 7;
export const TWICE_NOTE = "fails twice in 7 days";
/** More distinct tests than this in one run: one summary issue, no per-test ones. */
export const MAX_ISSUES_PER_RUN = 5;
/** Tests named in a summary issue; the rest are counted. */
const SUMMARY_LIST_MAX = 50;
const TAG_RE = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const TITLE_RE = /^redline-staging (v\d{1,6}\.\d{1,6}\.\d{1,6})$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DAY_MS = 24 * 3600 * 1000;

export type Workflow = "CI" | "redline-staging";
export const WORKFLOWS: readonly Workflow[] = ["CI", "redline-staging"];
export type Suite = "t19" | "redline" | "vitest" | "e2e";
const SUITE_NAME: Record<Suite, string> = {
  t19: "T19",
  redline: "red-line",
  vitest: "vitest",
  e2e: "Playwright e2e",
};
export type Failure = {
  suite: Suite;
  id: string;
  title: string;
  file?: string;
};
export type Sighting = { at: string; run: number; attempt: number };
export type Found = { f: Failure; sighting: Sighting };

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes in job logs
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
/** A red-line lane's output prefix (scripts/redline.ts prefixed()). */
const LANE = /^\[[A-Za-z0-9_-]{1,40}\] ?/;

/** A job log's lines without GitHub's timestamps and the terminal colours. */
export function logLines(log: string): string[] {
  return log
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(STAMP, "").replace(ANSI, ""));
}

const joinPath = (dir: string, file: string) => {
  const f = file.replace(/^\.\//, "");
  return dir ? `${dir.replace(/\/+$/, "")}/${f}` : f;
};

/**
 * The tests Playwright's epilogue names under `N failed` (list and dot
 * reporters alike), with `prefix` (the config's directory) put before the
 * printed path.
 */
export function parsePlaywright(
  log: string,
  suite: "t19" | "e2e" = "t19",
  prefix = "",
): Failure[] {
  const out: Failure[] = [];
  const lines = logLines(log);
  for (let i = 0; i < lines.length; i++) {
    if (!/^ {2}\d+ failed\s*$/.test(lines[i] ?? "")) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^ {4}(?:\[[^\]]*\] › )?(\S+?):\d+:\d+ › (.+?)\s*$/.exec(
        lines[j] ?? "",
      );
      if (!m) break;
      const file = joinPath(prefix, m[1] as string);
      const title = m[2] as string;
      out.push({ suite, id: `${suite}:${file}:${title}`, title, file });
    }
  }
  return dedupe(out);
}

/** `apps/<app>` for CI's `e2e (<app>)` job, else "". */
export function e2ePackage(jobName: string): string {
  const m = /^e2e \(([a-z0-9][a-z0-9-]{0,40})\)$/.exec(jobName);
  return m ? `apps/${m[1]}` : "";
}

const TEST_FILE = String.raw`[^\s|]+\.(?:test|spec)\.[cm]?[jt]sx?`;
const VITEST_FAIL = new RegExp(
  String.raw`^\s*FAIL\s+(?:\|[^|]*\|\s+)?(${TEST_FILE})(?: > (.+?))?\s*$`,
);
const VITEST_MODULE = new RegExp(
  String.raw`^\s*FAIL\s+(?:\|[^|]*\|\s+)?(${TEST_FILE}) \[ \S+ \]\s*$`,
);

/**
 * The tests vitest's ` FAIL  <file> > <name>` lines name in a CI job log, the
 * file made repo-relative from the package the log says is running. A file
 * that failed outside any test (` FAIL  <file> [ <file> ]`) is `<file>: module
 * error`, as red-line names it.
 */
export function parseVitest(log: string): Failure[] {
  const out: Failure[] = [];
  let pkg = "";
  for (const l of logLines(log)) {
    const group = /^##\[group\]test (\S+)\s*$/.exec(l);
    if (group) {
      pkg = group[1] as string;
      continue;
    }
    if (/^##\[(?:endgroup\]|group\]Run )/.test(l)) {
      pkg = "";
      continue;
    }
    const pub = /^ci-public-tests: (\S+) \[/.exec(l);
    if (pub) {
      pkg = pub[1] as string;
      continue;
    }
    const mod = VITEST_MODULE.exec(l);
    const m = mod ?? VITEST_FAIL.exec(l);
    if (!m || (!mod && !m[2])) continue;
    const file = joinPath(pkg, m[1] as string);
    const title = mod ? `${file}: module error` : (m[2] as string);
    out.push({ suite: "vitest", id: `vitest:${file}:${title}`, title, file });
  }
  return dedupe(out);
}

/**
 * The case name of a `Not pass:` entry (`<name> (<reason>)`) that vitest's FAIL
 * lines don't name. The reason is redacted and cut (src/report.ts MAX_REASON),
 * so its parens may not balance: never read it. A module error is
 * `<file>: module error`; any other name is cut at the first ` (` after its
 * last ` > `, so no error text can reach the test's key.
 */
export function caseName(rest: string): string {
  const mod = /^(live\/\S+\.test\.ts): module error(?: \(|$)/.exec(rest);
  if (mod) return `${mod[1]}: module error`;
  const gt = rest.lastIndexOf(" > ");
  const from = gt < 0 ? 0 : gt + 3;
  const cut = rest.indexOf(" (", from);
  return cut < 0 ? rest : rest.slice(0, cut);
}

/** The red-line cases the final report lists as fail (never infra). */
export function parseRedline(log: string): Failure[] {
  const lines = logLines(log).map((l) => l.replace(LANE, ""));
  const files = new Map<string, string>();
  for (const l of lines) {
    const m = /^\s*FAIL\s+(live\/\S+\.test\.ts) > (.+?)\s*$/.exec(l);
    if (m) files.set(m[2] as string, m[1] as string);
  }
  let start = -1;
  lines.forEach((l, i) => {
    if (/^Red-line report \(/.test(l)) start = i;
  });
  if (start < 0) return [];
  const names = [...files.keys()].sort((a, b) => b.length - a.length);
  const out: Failure[] = [];
  let inNotPass = false;
  for (const l of lines.slice(start + 1)) {
    if (/^Gate: /.test(l)) break;
    if (!/^\s/.test(l)) {
      inNotPass = l === "Not pass:";
      continue;
    }
    if (!inNotPass) continue;
    const m = /^ {2}\[fail\] (.+)$/.exec(l);
    if (!m) continue;
    const rest = (m[1] as string).trimEnd();
    const name =
      names.find((n) => rest === n || rest.startsWith(`${n} (`)) ??
      caseName(rest);
    const file =
      files.get(name) ??
      /^(live\/\S+\.test\.ts): module error$/.exec(name)?.[1];
    out.push({
      suite: "redline",
      id: `redline:${file ?? ""}:${name}`,
      title: name,
      ...(file ? { file } : {}),
    });
  }
  return dedupe(out);
}

/**
 * The failures in one failed job's log, by the workflow it ran in. Red-line
 * logs are never read as plain vitest: their FAIL lines include infra cases,
 * which only the report tells apart.
 */
export function parseJob(
  workflow: Workflow,
  jobName: string,
  log: string,
): Failure[] {
  if (workflow === "redline-staging")
    return [...parsePlaywright(log), ...parseRedline(log)];
  return [
    ...parseVitest(log),
    ...parsePlaywright(log, "e2e", e2ePackage(jobName)),
  ];
}

function dedupe(fs: Failure[]): Failure[] {
  const seen = new Set<string>();
  return fs.filter((f) => !seen.has(f.id) && seen.add(f.id));
}

/** The marker key of a test id: short, and safe inside an HTML comment. */
export const keyOf = (id: string) =>
  createHash("sha256").update(id).digest("hex").slice(0, 16);

const SEEN_RE = /<!-- flaky-seen: ([^>]*?) -->/;

export function parseSeen(body: string): Sighting[] {
  const m = SEEN_RE.exec(body);
  if (!m) return [];
  return (m[1] as string)
    .split(";")
    .map((s) => /^\s*(\S+) (\d+)\/(\d+)\s*$/.exec(s))
    .filter((x): x is RegExpExecArray => x !== null)
    .map((x) => ({
      at: x[1] as string,
      run: Number(x[2]),
      attempt: Number(x[3]),
    }));
}

const seenMarker = (s: Sighting[]) =>
  `<!-- flaky-seen: ${s.map((x) => `${x.at} ${x.run}/${x.attempt}`).join("; ")} -->`;

const inWindow = (s: Sighting, nowMs: number) =>
  Date.parse(s.at) >= nowMs - WINDOW_DAYS * DAY_MS;

/** Two different runs with this failure within the window, ending now. */
export function twiceInWindow(s: Sighting[], nowMs: number): boolean {
  const runs = new Set(s.filter((x) => inWindow(x, nowMs)).map((x) => x.run));
  return runs.size >= 2;
}

/** One sighting per run (its earliest failed attempt), oldest first. */
export function mergeSightings(...lists: Sighting[][]): Sighting[] {
  const byRun = new Map<number, Sighting>();
  for (const s of lists.flat()) {
    const had = byRun.get(s.run);
    if (!had || s.attempt < had.attempt) byRun.set(s.run, s);
  }
  return [...byRun.values()].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.run - b.run,
  );
}

const statusLine = (s: Sighting[], nowMs: number) => {
  const runs = new Set(s.map((x) => x.run)).size;
  return `<!-- flaky-status -->Seen in ${runs} run${runs === 1 ? "" : "s"}${twiceInWindow(s, nowMs) ? `; ${TWICE_NOTE}` : ""}.<!-- /flaky-status -->`;
};

export type Owner = { login: string; assignable: boolean } | null;

export type RunInfo = {
  repo: string;
  workflow: Workflow;
  runId: number;
  attempt: number;
  /** The commit under test: the release tag (redline-staging) or the head sha (CI). */
  ref: string;
  url: string;
};

/** How the issues name the run: `redline-staging v1.2.3`, or `CI at abc1234`. */
export const runLabel = (r: RunInfo) =>
  r.workflow === "CI" ? `CI at ${r.ref.slice(0, 7)}` : `${r.workflow} ${r.ref}`;

const refName = (r: RunInfo) =>
  SHA_RE.test(r.ref) ? r.ref.slice(0, 12) : r.ref;

const attemptLink = (repo: string, run: number, attempt: number) =>
  `https://github.com/${repo}/actions/runs/${run}/attempts/${attempt}`;
const runLink = (r: RunInfo, attempt: number) =>
  attemptLink(r.repo, r.runId, attempt);

export function issueTitle(f: Failure): string {
  const where = f.file ? ` (${f.file.split("/").pop()})` : "";
  const t = `Flaky: ${f.title}${where}`;
  return t.length > 240 ? `${t.slice(0, 237)}...` : t;
}

/**
 * `s` as an inline code span no backtick in it can end early, so a mention or
 * an issue ref in a test title stays inert text: the fence is one backtick
 * longer than the longest run inside, padded when `s` starts or ends with one.
 */
export function codeSpan(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

const sightingLines = (repo: string, seen: Sighting[]) =>
  seen.map(
    (s) => `- ${s.at}: failed on ${attemptLink(repo, s.run, s.attempt)}`,
  );

export function newIssueBody(o: {
  f: Failure;
  run: RunInfo;
  seen: Sighting[];
  owner: Owner;
  ownerPath: string;
  nowMs: number;
}): string {
  const { f, run } = o;
  const owner = o.owner
    ? o.owner.assignable
      ? `${o.owner.login} (assigned)`
      : `${o.owner.login} (named only: GitHub can't assign them here)`
    : "unknown (no commit found, or the lookup failed)";
  const runs = new Set(o.seen.map((s) => s.run)).size;
  return [
    `<!-- flaky-key: ${keyOf(f.id)} -->`,
    `A ${SUITE_NAME[f.suite]} test failed and then passed on a later attempt of the same run, with the same commit, in ${runs} runs within ${WINDOW_DAYS} days. Nothing changed between the attempts, so the test is flaky.`,
    "",
    `Test: ${codeSpan(f.title)}`,
    `File: ${codeSpan(o.ownerPath)}`,
    `Last author of the file at ${refName(run)}: ${owner}`,
    "",
    "Runs (the failed attempt; a later attempt of each passed):",
    ...sightingLines(run.repo, o.seen),
    `Latest pass: ${runLink(run, run.attempt)} (${runLabel(run)})`,
    "",
    statusLine(o.seen, o.nowMs),
    "",
    "This issue only tracks the flake: it changes no retry and blocks nothing. Fix the test, or the race it found, and close the issue. A later flake of the same test is noted here while it is open.",
    "",
    `<!-- flaky-id: ${f.id.replace(/--/g, "- -")} -->`,
    seenMarker(o.seen),
  ].join("\n");
}

/** The body with the sighting list and the status line brought up to date. */
export function bumpedBody(body: string, seen: Sighting[], nowMs: number) {
  const marker = seenMarker(seen);
  let b = SEEN_RE.test(body)
    ? body.replace(SEEN_RE, () => marker)
    : `${body}\n${marker}`;
  const status = statusLine(seen, nowMs);
  const STATUS_RE = /<!-- flaky-status -->.*?<!-- \/flaky-status -->/;
  b = STATUS_RE.test(b) ? b.replace(STATUS_RE, () => status) : b;
  return b;
}

export function bumpComment(o: {
  run: RunInfo;
  added: Sighting[];
  twice: boolean;
}): string {
  return [
    `<!-- run:${o.run.runId}/${o.run.attempt} -->`,
    `Failed again, then passed on attempt ${o.run.attempt} of ${runLabel(o.run)}:`,
    ...sightingLines(o.run.repo, o.added),
    ...(o.twice ? ["", `This test ${TWICE_NOTE}.`] : []),
  ].join("\n");
}

export type Issue = { number: number; body: string };

export type Action =
  | { kind: "create"; f: Failure; seen: Sighting[] }
  | {
      kind: "bump";
      f: Failure;
      issue: number;
      body: string;
      seen: Sighting[];
      added: Sighting[];
    }
  | { kind: "skip"; f: Failure; issue: number; why: string }
  | { kind: "record"; f: Failure; why: string };

/** One sighting per test: the earliest failed attempt that named it. */
export function firstSightings(found: Found[]): Found[] {
  const first = new Map<string, Found>();
  for (const x of found) {
    const had = first.get(x.f.id);
    if (!had || x.sighting.attempt < had.sighting.attempt) first.set(x.f.id, x);
  }
  return [...first.values()];
}

/**
 * What one test does, given its sightings in the store: only a record while
 * it has been seen in one run within 7 days; at two runs, a new issue, or a
 * bump of its open one; a skip when that issue already notes this run.
 */
export function plan(
  x: Found & { stored: Sighting[] },
  open: Issue[],
  nowMs: number,
): Action {
  const { f, sighting } = x;
  const marker = `<!-- flaky-key: ${keyOf(f.id)} -->`;
  const issue = open.find((i) => i.body.includes(marker));
  const prior = issue ? parseSeen(issue.body) : [];
  if (issue && prior.some((p) => p.run === sighting.run))
    return {
      kind: "skip",
      f,
      issue: issue.number,
      why: `run ${sighting.run} already noted`,
    };
  const window = mergeSightings(x.stored, [sighting]).filter((s) =>
    inWindow(s, nowMs),
  );
  if (!twiceInWindow(window, nowMs))
    return { kind: "record", f, why: `seen in 1 run in ${WINDOW_DAYS} days` };
  if (!issue) return { kind: "create", f, seen: window };
  const had = new Set(prior.map((p) => p.run));
  const added = window.filter((s) => !had.has(s.run));
  return {
    kind: "bump",
    f,
    issue: issue.number,
    body: issue.body,
    seen: mergeSightings(prior, added),
    added,
  };
}

/** The repo-relative path whose last author owns the test. */
export function ownerPath(f: Failure): string {
  if (f.suite === "t19") return `${T19_PACKAGE}/${f.file ?? "e2e/staging"}`;
  if (f.suite === "redline") return `${REDLINE_DIR}/${f.file ?? "live"}`;
  return f.file ?? "";
}

type Attempt = { conclusion: string | null; head_sha: string };
type Job = {
  id: number;
  name: string;
  conclusion: string | null;
  completed_at: string | null;
};

function jobLog(exec: Exec, repo: string, id: number): string {
  const path = `repos/${repo}/actions/jobs/${id}/logs`;
  // Newer gh refuses to print a log with terminal escapes without the flag;
  // older gh does not know it.
  try {
    return gh(exec, ["api", "--allow-escape-sequences", path]);
  } catch (e) {
    if (!/unknown flag/.test((e as Error).message)) throw e;
    return gh(exec, ["api", path]);
  }
}

/** Every failure of every earlier failed attempt with the same head sha. */
export function collect(
  exec: Exec,
  run: RunInfo,
): { found: Found[]; notes: string[] } {
  const base = `repos/${run.repo}/actions/runs/${run.runId}`;
  const last = JSON.parse(
    gh(exec, ["api", `${base}/attempts/${run.attempt}`]),
  ) as Attempt;
  const found: Found[] = [];
  const notes: string[] = [];
  for (let a = 1; a < run.attempt; a++) {
    const att = JSON.parse(
      gh(exec, ["api", `${base}/attempts/${a}`]),
    ) as Attempt;
    if (att.conclusion !== "failure") continue;
    if (att.head_sha !== last.head_sha) {
      notes.push(`attempt ${a}: another commit (${att.head_sha}), skipped`);
      continue;
    }
    const jobs = (
      JSON.parse(
        gh(exec, ["api", `${base}/attempts/${a}/jobs?per_page=100`]),
      ) as { jobs: Job[] }
    ).jobs.filter((j) => j.conclusion === "failure");
    for (const j of jobs) {
      const fs = parseJob(run.workflow, j.name, jobLog(exec, run.repo, j.id));
      if (!fs.length)
        notes.push(`attempt ${a}: job ${j.name} failed outside the tests`);
      const at = (j.completed_at ?? new Date().toISOString()).replace(
        /\.\d+Z$/,
        "Z",
      );
      for (const f of fs)
        found.push({ f, sighting: { at, run: run.runId, attempt: a } });
    }
  }
  return { found, notes };
}

function lastAuthor(
  exec: Exec,
  repo: string,
  path: string,
  ref: string,
): string | null {
  const commits = JSON.parse(
    gh(exec, [
      "api",
      `repos/${repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=1`,
    ]),
  ) as { author?: { login?: string } | null }[];
  return commits[0]?.author?.login ?? null;
}

/** The pinned public sha in this repo's PUBLIC_PIN at the tag. */
function publicPin(exec: Exec, repo: string, tag: string): string {
  const text = gh(exec, [
    "api",
    "-H",
    "Accept: application/vnd.github.raw",
    `repos/${repo}/contents/PUBLIC_PIN?ref=${encodeURIComponent(tag)}`,
  ]);
  const sha = /^sha=([0-9a-f]{40})$/m.exec(text)?.[1];
  if (!sha) throw new Error(`no sha in PUBLIC_PIN at ${tag}`);
  return sha;
}

export function ownerOf(exec: Exec, run: RunInfo, f: Failure): Owner {
  const path = ownerPath(f);
  const login =
    f.suite === "t19"
      ? lastAuthor(exec, PUBLIC_REPO, path, publicPin(exec, run.repo, run.ref))
      : lastAuthor(exec, run.repo, path, run.ref);
  if (!login) return null;
  if (login.endsWith("[bot]")) return { login, assignable: false };
  // 204 when they can be assigned here, 404 otherwise.
  const r = exec("gh", ["api", `repos/${run.repo}/assignees/${login}`]);
  return { login, assignable: r.code === 0 };
}

function ensureLabel(
  exec: Exec,
  repo: string,
  name: string,
  color: string,
  description: string,
) {
  const labels = JSON.parse(
    gh(exec, [
      "label",
      "list",
      "--repo",
      repo,
      "--search",
      name,
      "--json",
      "name",
    ]),
  ) as { name: string }[];
  if (labels.some((l) => l.name === name)) return;
  gh(
    exec,
    [
      "label",
      "create",
      name,
      "--repo",
      repo,
      "--color",
      color,
      "--description",
      description,
    ],
    { write: true },
  );
}

// ---- The sightings store ----

/** One machine line per sighting; the key is the test's, never its text. */
export const sightingLine = (key: string, s: Sighting) =>
  `flaky-sighting ${s.at} ${key} ${s.run}/${s.attempt}`;
const SIGHTING_RE =
  /^flaky-sighting (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) ([0-9a-f]{16}) (\d{1,20})\/(\d{1,4})$/gm;

/** The store comment for this run's new sightings. */
export function storeComment(run: RunInfo, fresh: Found[]): string {
  return [
    `<!-- flaky-sightings: ${run.runId}/${run.attempt} -->`,
    `${runLabel(run)}, run ${run.runId}: failed, then passed on attempt ${run.attempt} (${runLink(run, run.attempt)}).`,
    "",
    ...fresh.map(
      (x) =>
        `- ${SUITE_NAME[x.f.suite]}: ${codeSpan(x.f.title)}${x.f.file ? ` in ${codeSpan(x.f.file)}` : ""}, failed on ${runLink(run, x.sighting.attempt)}`,
    ),
    "",
    "<!--",
    ...fresh.map((x) => sightingLine(keyOf(x.f.id), x.sighting)),
    "-->",
  ].join("\n");
}

/** The sightings per test key in the store comments, only those by the bot. */
export function parseStore(
  comments: { user: string; body: string }[],
): Map<string, Sighting[]> {
  const out = new Map<string, Sighting[]>();
  for (const c of comments) {
    if (c.user !== STORE_AUTHOR) continue;
    for (const m of c.body.replace(/\r/g, "").matchAll(SIGHTING_RE)) {
      const key = m[2] as string;
      const s = {
        at: m[1] as string,
        run: Number(m[3]),
        attempt: Number(m[4]),
      };
      out.set(key, mergeSightings(out.get(key) ?? [], [s]));
    }
  }
  return out;
}

const STORE_BODY = [
  STORE_MARKER,
  "The flaky tracker's sightings (cloud #447): each comment by github-actions is one run that failed and then passed on a later attempt, with one line per test that failed. A test seen in two runs within 7 days gets its own issue labelled `flaky`.",
  "",
  "Kept by `.github/workflows/flaky-tracker.yml`. Leave this issue open and its comments as they are; only the bot's comments are read.",
].join("\n");

/** The store issues: every one to read, and the open one to write. */
function openStore(
  exec: Exec,
  repo: string,
): { write: number; read: number[] } {
  const all = (
    JSON.parse(
      gh(exec, [
        "issue",
        "list",
        "--repo",
        repo,
        "--label",
        STORE_LABEL,
        "--state",
        "all",
        "--json",
        "number,body,state",
        "--limit",
        "50",
      ]),
    ) as (Issue & { state: string })[]
  )
    .filter((i) => i.body.includes(STORE_MARKER))
    .sort((a, b) => a.number - b.number);
  const read = all.map((i) => i.number);
  const open = all.find((i) => i.state === "OPEN");
  if (open) return { write: open.number, read };
  const url = gh(
    exec,
    [
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      "Flaky tracker: sightings",
      "--body",
      STORE_BODY,
      "--label",
      STORE_LABEL,
    ],
    { write: true },
  );
  const n = Number(/\/issues\/(\d+)\s*$/.exec(url.trim())?.[1]);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error(`no issue number in: ${url.trim()}`);
  return { write: n, read: [...read, n] };
}

function readStore(
  exec: Exec,
  repo: string,
  issues: number[],
  nowMs: number,
): Map<string, Sighting[]> {
  const since = new Date(nowMs - WINDOW_DAYS * DAY_MS).toISOString();
  const comments: { user: string; body: string }[] = [];
  for (const n of issues) {
    const out = gh(exec, [
      "api",
      "--paginate",
      `repos/${repo}/issues/${n}/comments?since=${encodeURIComponent(since)}&per_page=100`,
      "--jq",
      ".[] | [.user.login, .body] | @json",
    ]);
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [user, body] = JSON.parse(line) as [string, string];
      comments.push({ user, body });
    }
  }
  return parseStore(comments);
}

export type Done = {
  action: Action["kind"] | "summary";
  id: string;
  issue?: number;
};

/** The marker of a run's summary issue, so a rerun of the tracker opens one. */
export const summaryMarker = (runId: number) =>
  `<!-- flaky-summary: ${runId} -->`;

/** One issue for a run whose earlier attempt failed too many tests to file. */
export function summaryIssue(
  run: RunInfo,
  tests: Found[],
): { title: string; body: string } {
  const attempts = [...new Set(tests.map((t) => t.sighting.attempt))].sort(
    (a, b) => a - b,
  );
  const list = tests
    .slice(0, SUMMARY_LIST_MAX)
    .map(
      (t) =>
        `- ${SUITE_NAME[t.f.suite]}: ${codeSpan(t.f.title)}${t.f.file ? ` in ${codeSpan(t.f.file)}` : ""}`,
    );
  const more = tests.length - list.length;
  return {
    title: `Flaky: ${tests.length} tests failed on ${runLabel(run)} run ${run.runId}, then passed`,
    body: [
      summaryMarker(run.runId),
      `${tests.length} tests failed on attempt ${attempts.join(", ")} of ${runLabel(run)} and the same run passed on attempt ${run.attempt}, with the same commit. More than ${MAX_ISSUES_PER_RUN} at once usually means the attempt itself was broken (an outage, a bad bring-up), not that each test is flaky, so no sighting was recorded and no issue was opened or bumped per test.`,
      "",
      ...attempts.map((a) => `Failed attempt: ${runLink(run, a)}`),
      `Passed on: ${runLink(run, run.attempt)}`,
      "",
      ...list,
      ...(more > 0 ? [`- and ${more} more`] : []),
      "",
      "Look at the failed attempt. If it was the environment, close this issue. If some of these tests are flaky on their own, they are recorded the next time they flake in a smaller set.",
    ].join("\n"),
  };
}

function listOpen(exec: Exec, repo: string): Issue[] {
  return JSON.parse(
    gh(exec, [
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      LABEL,
      "--state",
      "open",
      "--json",
      "number,body",
      "--limit",
      "500",
    ]),
  ) as Issue[];
}

export function track(o: { exec: Exec; run: RunInfo; nowMs: number }): {
  done: Done[];
  notes: string[];
} {
  const { exec, run } = o;
  const { found, notes } = collect(exec, run);
  if (!found.length) return { done: [], notes };
  ensureLabel(
    exec,
    run.repo,
    LABEL,
    "FBCA04",
    "A test that failed and then passed on a rerun of the same run",
  );
  const done: Done[] = [];
  const tests = firstSightings(found);
  if (tests.length > MAX_ISSUES_PER_RUN) {
    const marker = summaryMarker(run.runId);
    const had = listOpen(exec, run.repo).find((i) => i.body.includes(marker));
    if (had) {
      done.push({
        action: "skip",
        id: `summary:${run.runId}`,
        issue: had.number,
      });
      return { done, notes };
    }
    const { title, body } = summaryIssue(run, tests);
    gh(
      exec,
      [
        "issue",
        "create",
        "--repo",
        run.repo,
        "--title",
        title,
        "--body",
        body,
        "--label",
        LABEL,
      ],
      { write: true },
    );
    done.push({ action: "summary", id: `summary:${run.runId}` });
    return { done, notes };
  }
  // Record first: a sighting is kept even when an issue write below fails,
  // and a rerun of the tracker finds this run in the store and adds nothing.
  ensureLabel(
    exec,
    run.repo,
    STORE_LABEL,
    "EDEDED",
    "The flaky tracker's record of tests that failed and then passed",
  );
  const store = openStore(exec, run.repo);
  const stored = readStore(exec, run.repo, store.read, o.nowMs);
  const fresh = tests.filter(
    (t) =>
      !(stored.get(keyOf(t.f.id)) ?? []).some((s) => s.run === t.sighting.run),
  );
  if (fresh.length)
    gh(
      exec,
      [
        "issue",
        "comment",
        String(store.write),
        "--repo",
        run.repo,
        "--body",
        storeComment(run, fresh),
      ],
      { write: true },
    );
  // Then, for a test seen twice, a fresh list of the open issues right before
  // each write. Tracker runs are not serialized (a shared concurrency group
  // would let a newer event cancel a pending one), so another run may have
  // opened or bumped the issue a moment ago.
  for (const t of tests) {
    const x = { ...t, stored: stored.get(keyOf(t.f.id)) ?? [] };
    const pre = plan(x, [], o.nowMs);
    const a =
      pre.kind === "record" ? pre : plan(x, listOpen(exec, run.repo), o.nowMs);
    if (a.kind === "record") {
      done.push({ action: "record", id: a.f.id });
      continue;
    }
    if (a.kind === "skip") {
      done.push({ action: "skip", id: a.f.id, issue: a.issue });
      continue;
    }
    if (a.kind === "bump") {
      // The body first: it is what plan() reads, so a rerun after a failed
      // comment skips this run instead of commenting twice.
      gh(
        exec,
        [
          "issue",
          "edit",
          String(a.issue),
          "--repo",
          run.repo,
          "--body",
          bumpedBody(a.body, a.seen, o.nowMs),
        ],
        { write: true, idempotent: true },
      );
      gh(
        exec,
        [
          "issue",
          "comment",
          String(a.issue),
          "--repo",
          run.repo,
          "--body",
          bumpComment({
            run,
            added: a.added,
            twice: twiceInWindow(a.seen, o.nowMs),
          }),
        ],
        { write: true },
      );
      done.push({ action: "bump", id: a.f.id, issue: a.issue });
      continue;
    }
    // The owner is extra information: a failed lookup never stops the issue.
    let owner: Owner = null;
    try {
      owner = ownerOf(exec, run, a.f);
    } catch (e) {
      notes.push(`owner of ${a.f.id} unknown: ${(e as Error).message}`);
    }
    const body = newIssueBody({
      f: a.f,
      run,
      seen: a.seen,
      owner,
      ownerPath: ownerPath(a.f),
      nowMs: o.nowMs,
    });
    gh(
      exec,
      [
        "issue",
        "create",
        "--repo",
        run.repo,
        "--title",
        issueTitle(a.f),
        "--body",
        body,
        "--label",
        LABEL,
        ...(owner?.assignable ? ["--assignee", owner.login] : []),
      ],
      { write: true },
    );
    done.push({ action: "create", id: a.f.id });
  }
  return { done, notes };
}

const flag = (argv: string[], name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? "" : (argv[i + 1] ?? "");
};

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? String(r.error ?? ""),
  };
};

/** The run the tracker was started for, from its arguments. */
export function runFromArgs(argv: string[]): RunInfo {
  const repo = flag(argv, "repo");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("bad --repo");
  const workflow = flag(argv, "workflow") as Workflow;
  if (!WORKFLOWS.includes(workflow)) throw new Error("bad --workflow");
  const runId = Number(flag(argv, "run-id"));
  const attempt = Number(flag(argv, "attempt"));
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new Error("bad --run-id");
  if (!Number.isSafeInteger(attempt) || attempt < 2)
    throw new Error("bad --attempt: the tracker needs attempt 2 or later");
  let ref: string;
  if (workflow === "redline-staging") {
    ref = TITLE_RE.exec(flag(argv, "title"))?.[1] ?? "";
    if (!TAG_RE.test(ref))
      throw new Error("the run's title names no release tag");
  } else {
    ref = flag(argv, "head-sha");
    if (!SHA_RE.test(ref)) throw new Error("bad --head-sha");
  }
  return {
    repo,
    workflow,
    runId,
    attempt,
    ref,
    url: `https://github.com/${repo}/actions/runs/${runId}`,
  };
}

function main(argv: string[]) {
  const run = runFromArgs(argv);
  const { done, notes } = track({ exec: realExec, run, nowMs: Date.now() });
  const lines = [
    `Flaky tracker, ${runLabel(run)}, run ${run.runId} (passed on attempt ${run.attempt}):`,
    ...(done.length ? [] : ["  no failed test found in the earlier attempts"]),
    ...done.map((d) => `  ${d.action} ${d.issue ? `#${d.issue} ` : ""}${d.id}`),
    ...notes.map((n) => `  note: ${n}`),
  ];
  console.log(lines.join("\n"));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${lines.join("\n")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`flaky-tracker: ${(e as Error).message}`);
    process.exit(1);
  }
}
