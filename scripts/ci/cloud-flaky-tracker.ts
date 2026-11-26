// The flaky tracker (cloud #447, #264 lane 4 PR2). Tracking only: it changes
// no retry and nothing that blocks. cloud-flaky-tracker.yml runs it when a CI run or
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
// with sightings in two or more different runs within the last 7 days,
// counting this one. The sightings live in one open issue per repo labelled
// `flaky-sightings` (the store): each tracker run that finds new sightings
// adds one comment (more when one would pass COMMENT_MAX characters) with a
// readable list and, last, the bot's marker block holding the run
// (`run: <id>/<attempt that passed>`) and one
// `sighting: <time> <key> <run>/<attempt>` line per test. The
// store is read with `since` = 7 days ago, so a read is a page or two however
// old the issue gets, and only comments by github-actions[bot] count, so a
// person's comment can't add a sighting. Past MAX_STORE_COMMENTS comments the
// store is closed with a note and a new one opened; a closed store is still
// read for 7 days after it closed. Why this store: it needs no new service
// and no secret (the default token has issues: write); it is read back at
// once, unlike issue search, which lags its index and has its own rate limit;
// it is one issue, not an issue or a label hit per sighting; and it outlives
// what Actions keeps (caches go after 7 idle days and are per branch,
// artifacts are per run). cloud-flaky-tracker.yml runs one tracker at a time per
// repo, so two runs never write the store or an issue at once.
//
// One issue per test, keyed on the test's identity only (suite, file and
// name: `suite:file:name`), never on its error text. When more than
// MAX_ISSUES_PER_RUN tests would be filed (opened or bumped) by one run, one
// summary issue lists them instead; every sighting is still recorded first.
//
// Markers: every body and comment the bot writes ends with one marker block,
// `<!-- flaky-tracker-markers` then `name: value` lines then `-->`, and only
// that trailing block is ever parsed. A test's title, file or id is untrusted
// (it comes from a job log): before it is written anywhere, inert() breaks
// every `<!--`, `-->` and `--!>` in it and the block's name, so it can neither
// forge a marker nor open or close an HTML comment. The id in the block is
// percent-escaped (no `-`, `>` or `<` left). In an issue title, backticks are
// dropped and `#` and `@` replaced, so nothing renders as a ref or a mention.
// The owner is the last author of the test file at the commit under test
// (CI: this repo at the head sha; T19: public's file at the tag's PUBLIC_PIN;
// red-line: this repo's tests/redline at the tag). The owner is assigned when
// GitHub says they can be; otherwise the login is written in plain text,
// never as a mention.
//
// TODO(lane 3): when redline-staging runs as a reusable workflow (a queue gate
// calling it with workflow_call), workflow_run fires under the caller's name,
// not redline-staging, and this tracker never sees that run. Add the caller to
// cloud-flaky-tracker.yml's workflows and read its jobs (named `<caller job> /
// t19`, `<caller job> / redline`) the same way. Not built yet.
//
// Reconcile: GitHub keeps a bounded queue of pending runs per concurrency
// group, and a dropped tracker run would lose its sightings. So the same
// job runs --reconcile right after every tracker run, on each completion of a
// watched workflow and on dispatch, never on a clock (see reconcile()): it tracks
// every run created within RERUN_DAYS plus RECONCILE_HOURS (GitHub allows a
// rerun for RERUN_DAYS) that passed after a failed attempt and that the store
// doesn't hold yet, however long ago it passed, by the same rules and code.
// So a dropped event is caught by the next completion whenever it comes. A
// run whose earlier attempts hold no failed test is marked in the store too,
// so it is read once.
//
// Usage: node --experimental-strip-types scripts/ci/cloud-flaky-tracker.ts --repo o/n --workflow <CI|redline-staging> --run-id <id> --attempt <n> --head-sha <sha> [--title "redline-staging vX.Y.Z"]
//        node --experimental-strip-types scripts/ci/cloud-flaky-tracker.ts --repo o/n --reconcile
// Needs GH_TOKEN (actions: read, contents: read, issues: write).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type Exec, gh } from "./gh-retry.ts";

export const LABEL = "flaky";
export const STORE_LABEL = "flaky-sightings";
/** Only this author's store comments hold sightings. */
export const STORE_AUTHOR = "github-actions[bot]";
export const PUBLIC_REPO = "open-artifacts-ai/open-artifacts";
/** T19's specs sit in this package of public; Playwright prints paths from it. */
export const T19_PACKAGE = "apps/dashboard";
export const REDLINE_DIR = "tests/redline";
export const WINDOW_DAYS = 7;
export const TWICE_NOTE = "fails twice in 7 days";
/** More tests than this filed (opened or bumped) by one run: one summary issue instead. */
export const MAX_ISSUES_PER_RUN = 5;
/** A store with more comments than this is closed and a new one opened. */
export const MAX_STORE_COMMENTS = 2000;
/** The longest store comment written: GitHub refuses one over 65536. */
export const COMMENT_MAX = 60000;
/** The longest test title or file shown in a store comment. */
const STORE_TEXT_MAX = 1000;
/** Job and attempt conclusions that count as a failed attempt. */
const FAILED = new Set(["failure", "timed_out"]);
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

const BLOCK_NAME = "flaky-tracker-markers";
const BLOCK_RE =
  /(?:^|\n)<!-- flaky-tracker-markers\n((?:[a-z]+: [^\n]*\n)*)-->\s*$/;

/**
 * The bot's marker block, written last in every body and comment it writes.
 * Values are machine text only: hex keys, run numbers, times, escaped ids.
 */
export function markerBlock(fields: [string, string][]): string {
  return [
    `<!-- ${BLOCK_NAME}`,
    ...fields.map(([k, v]) => `${k}: ${v.replace(/[\r\n]/g, " ")}`),
    "-->",
  ].join("\n");
}

/** The fields of the trailing marker block, or null when the text has none. */
export function readMarkers(text: string): Map<string, string[]> | null {
  const m = BLOCK_RE.exec(text.replace(/\r/g, ""));
  if (!m) return null;
  const out = new Map<string, string[]>();
  for (const line of (m[1] as string).split("\n")) {
    const kv = /^([a-z]+): (.*)$/.exec(line);
    if (kv)
      out.set(kv[1] as string, [
        ...(out.get(kv[1] as string) ?? []),
        kv[2] as string,
      ]);
  }
  return out;
}

const marker = (text: string, name: string) =>
  readMarkers(text)?.get(name)?.[0];
const kindOf = (text: string) => marker(text, "kind");

/** The text with its trailing marker block replaced (or added). */
function withMarkers(text: string, fields: [string, string][]): string {
  const m = BLOCK_RE.exec(text);
  const head = m ? text.slice(0, m.index) : text.replace(/\s+$/, "");
  return `${head}\n${markerBlock(fields)}`;
}

/**
 * Untrusted text (a test's title, file or id, from a job log) made inert:
 * one line, with every `<!--`, `-->` and `--!>` broken by a space until none
 * is left, and the marker block's name broken, so it can't forge a marker,
 * open an HTML comment or close one.
 */
export function inert(s: string): string {
  let out = s
    .replace(/[\r\n]+/g, " ")
    .replaceAll(BLOCK_NAME, "flaky tracker markers");
  for (;;) {
    const next = out.replace(/<!--/g, "<!- -").replace(/--(!?>)/g, "- -$1");
    if (next === out) return out;
    out = next;
  }
}

/** A test id for an HTML comment: `%`, `-`, `<` and `>` percent-escaped. */
export const escapeId = (id: string) =>
  id
    .replace(/[\r\n]+/g, " ")
    .replace(
      /[%<>-]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );

/** Untrusted text for an issue title: no backticks, no `#` or `@` to link. */
export const titleText = (s: string) =>
  inert(s).replace(/`/g, "").replace(/#/g, "\uFF03").replace(/@/g, "\uFF20");

export function parseSeen(body: string): Sighting[] {
  if (kindOf(body) !== "test") return [];
  return (marker(body, "seen") ?? "")
    .split(";")
    .map((s) => /^\s*(\S+) (\d+)\/(\d+)\s*$/.exec(s))
    .filter((x): x is RegExpExecArray => x !== null)
    .map((x) => ({
      at: x[1] as string,
      run: Number(x[2]),
      attempt: Number(x[3]),
    }));
}

const seenValue = (s: Sighting[]) =>
  s.map((x) => `${x.at} ${x.run}/${x.attempt}`).join("; ");

/** The marker fields of a test's issue. */
const testMarkers = (f: Failure, seen: Sighting[]): [string, string][] => [
  ["kind", "test"],
  ["key", keyOf(f.id)],
  ["id", escapeId(f.id)],
  ["seen", seenValue(seen)],
];

/** The test key of an open issue, from its marker block only. */
export const issueKey = (body: string) =>
  kindOf(body) === "test" ? marker(body, "key") : undefined;

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
  const where = f.file ? ` (${titleText(f.file.split("/").pop() ?? "")})` : "";
  const t = `Flaky: ${titleText(f.title)}${where}`;
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
    `A ${SUITE_NAME[f.suite]} test failed and then passed on a later attempt of the same run, with the same commit, in ${runs} runs within ${WINDOW_DAYS} days. Nothing changed between the attempts, so the test is flaky.`,
    "",
    `Test: ${codeSpan(inert(f.title))}`,
    `File: ${codeSpan(inert(o.ownerPath))}`,
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
    markerBlock(testMarkers(f, o.seen)),
  ].join("\n");
}

/** The body with the sighting list and the status line brought up to date. */
export function bumpedBody(
  f: Failure,
  body: string,
  seen: Sighting[],
  nowMs: number,
) {
  let b = withMarkers(body, testMarkers(f, seen));
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
    `Failed again, then passed on attempt ${o.run.attempt} of ${runLabel(o.run)}:`,
    ...sightingLines(o.run.repo, o.added),
    ...(o.twice ? ["", `This test ${TWICE_NOTE}.`] : []),
    "",
    markerBlock([
      ["kind", "bump"],
      ["run", `${o.run.runId}/${o.run.attempt}`],
    ]),
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
 * fewer than two different runs within the last 7 days (this one included)
 * saw it; at two or more, a new issue, or a bump of its open one; a skip when
 * that issue already notes this run. The open issue is found by the key in
 * its trailing marker block only.
 */
export function plan(
  x: Found & { stored: Sighting[] },
  open: Issue[],
  nowMs: number,
): Action {
  const { f, sighting } = x;
  const key = keyOf(f.id);
  const issue = open.find((i) => issueKey(i.body) === key);
  const prior = issue ? parseSeen(issue.body) : [];
  if (issue && prior.some((p) => p.run === sighting.run))
    return {
      kind: "skip",
      f,
      issue: issue.number,
      why: `run ${sighting.run} already noted`,
    };
  const window = mergeSightings(x.stored, prior, [sighting]).filter((s) =>
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

type Attempt = {
  conclusion: string | null;
  head_sha: string;
};
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
  // A fork's run (a PR from another repo) counts too. Its logs are only read
  // as text: parseJob() takes test names from them, and inert() makes those
  // safe before they are written anywhere. Nothing from the run is executed.
  for (let a = 1; a < run.attempt; a++) {
    const att = JSON.parse(
      gh(exec, ["api", `${base}/attempts/${a}`]),
    ) as Attempt;
    if (!FAILED.has(att.conclusion ?? "")) continue;
    if (att.head_sha !== last.head_sha) {
      notes.push(`attempt ${a}: another commit (${att.head_sha}), skipped`);
      continue;
    }
    const jobs = (
      JSON.parse(
        gh(exec, ["api", `${base}/attempts/${a}/jobs?per_page=100`]),
      ) as { jobs: Job[] }
    ).jobs.filter((j) => FAILED.has(j.conclusion ?? ""));
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

/** One sighting's marker line; the key is the test's, never its text. */
export const sightingLine = (key: string, s: Sighting) =>
  `sighting: ${s.at} ${key} ${s.run}/${s.attempt}`;
const SIGHTING_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) ([0-9a-f]{16}) (\d{1,20})\/(\d{1,4})$/;

const testLine = (f: Failure) =>
  `${SUITE_NAME[f.suite]}: ${codeSpan(inert(f.title))}${f.file ? ` in ${codeSpan(inert(f.file))}` : ""}`;

/** Untrusted text cut to `n` characters, after it was made inert. */
const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 3)}...` : s;

const storeTestLine = (f: Failure) =>
  `${SUITE_NAME[f.suite]}: ${codeSpan(clip(inert(f.title), STORE_TEXT_MAX))}${f.file ? ` in ${codeSpan(clip(inert(f.file), STORE_TEXT_MAX))}` : ""}`;

const storeRow = (run: RunInfo, x: Found) =>
  `- ${storeTestLine(x.f)}, failed on ${runLink(run, x.sighting.attempt)}`;
const storeMark = (x: Found): [string, string] => [
  "sighting",
  sightingLine(keyOf(x.f.id), x.sighting).slice("sighting: ".length),
];

/**
 * One store comment for these of this run's new sightings. Only the last part
 * of a split carries the run marker, so the reconcile treats a run as recorded
 * only once every part is posted (a failed later part is retried, and sightings
 * already stored are not fresh again).
 */
export function storeComment(
  run: RunInfo,
  fresh: Found[],
  last = true,
): string {
  return [
    `${runLabel(run)}, run ${run.runId}: failed, then passed on attempt ${run.attempt} (${runLink(run, run.attempt)}).`,
    "",
    ...fresh.map((x) => storeRow(run, x)),
    "",
    markerBlock([
      ["kind", "sightings"],
      ...(last
        ? [["run", `${run.runId}/${run.attempt}`] satisfies [string, string]]
        : []),
      ...fresh.map(storeMark),
    ]),
  ].join("\n");
}

/**
 * The store comment that marks this run recorded: written after every filing,
 * and on its own for a run whose earlier attempts hold no failed test.
 */
export const runDoneComment = (run: RunInfo) => storeComment(run, [], true);

/**
 * The store comments for this run's new sightings, split so each stays under
 * COMMENT_MAX characters (GitHub refuses a comment over 65536). Each is a
 * whole comment with its own marker block, so each is read on its own.
 */
export function storeComments(
  run: RunInfo,
  fresh: Found[],
  marksRun = true,
): string[] {
  const base = storeComment(run, []).length;
  const out: string[] = [];
  let part: Found[] = [];
  let size = base;
  for (const x of fresh) {
    // A row and its marker line, each with its newline.
    const add =
      storeRow(run, x).length + 1 + storeMark(x).join(": ").length + 1;
    if (part.length && size + add >= COMMENT_MAX) {
      out.push(storeComment(run, part, false));
      part = [];
      size = base;
    }
    part.push(x);
    size += add;
  }
  if (part.length) out.push(storeComment(run, part, marksRun));
  return out;
}

/**
 * The sightings per test key in the store comments: only comments by the
 * bot, and only their trailing marker block.
 */
export function parseStore(comments: StoreComment[]): Map<string, Sighting[]> {
  const out = new Map<string, Sighting[]>();
  for (const c of comments) {
    if (c.user !== STORE_AUTHOR) continue;
    const m = readMarkers(c.body);
    if (m?.get("kind")?.[0] !== "sightings") continue;
    for (const v of m.get("sighting") ?? []) {
      const x = SIGHTING_RE.exec(v);
      if (!x) continue;
      const key = x[2] as string;
      const s = {
        at: x[1] as string,
        run: Number(x[3]),
        attempt: Number(x[4]),
      };
      out.set(key, mergeSightings(out.get(key) ?? [], [s]));
    }
  }
  return out;
}

export const STORE_BODY = [
  "The flaky tracker's sightings (cloud #447): each comment by github-actions is one run that failed and then passed on a later attempt, with one line per test that failed. A test seen in two runs within 7 days gets its own issue labelled `flaky`.",
  "",
  `Kept by \`.github/workflows/cloud-flaky-tracker.yml\`. Leave this issue open and its comments as they are; only the bot's comments are read. Past ${MAX_STORE_COMMENTS} comments the tracker closes it and opens a new one.`,
  "",
  markerBlock([["kind", "store"]]),
].join("\n");

function createStore(exec: Exec, repo: string): number {
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
  return n;
}

/**
 * The store issues: the ones to read (open, or closed within the window) and
 * the open one to write (the newest). An open store past MAX_STORE_COMMENTS
 * comments is closed with a note pointing at a new one, which is then written;
 * the old one is still read.
 */
type StoreIssue = Issue & { state: string; closedAt?: string | null };

/**
 * The store issues, oldest first, and the ones to read: open, or closed
 * since `since` (by default the window's start). Reads only.
 */
function storeIssues(
  exec: Exec,
  repo: string,
  nowMs: number,
  since = nowMs - WINDOW_DAYS * DAY_MS,
): { all: StoreIssue[]; read: number[] } {
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
        "number,body,state,closedAt",
        "--limit",
        "50",
      ]),
    ) as StoreIssue[]
  )
    .filter((i) => kindOf(i.body) === "store")
    .sort((a, b) => a.number - b.number);
  const read = all
    .filter((i) => i.state === "OPEN" || Date.parse(i.closedAt ?? "") >= since)
    .map((i) => i.number);
  return { all, read };
}

export function openStore(
  exec: Exec,
  repo: string,
  nowMs: number,
): { write: number; read: number[]; notes: string[] } {
  const { all, read } = storeIssues(exec, repo, nowMs);
  const open = all.filter((i) => i.state === "OPEN").pop();
  if (!open) {
    const n = createStore(exec, repo);
    return { write: n, read: [...read, n], notes: [] };
  }
  const count = Number(
    gh(exec, [
      "api",
      `repos/${repo}/issues/${open.number}`,
      "--jq",
      ".comments",
    ]).trim(),
  );
  if (!(count > MAX_STORE_COMMENTS))
    return { write: open.number, read, notes: [] };
  const n = createStore(exec, repo);
  gh(
    exec,
    [
      "issue",
      "close",
      String(open.number),
      "--repo",
      repo,
      "--comment",
      `This store has ${count} comments, more than ${MAX_STORE_COMMENTS}. New sightings go to #${n}; the tracker still reads this issue for ${WINDOW_DAYS} days after it closes.`,
    ],
    { write: true, idempotent: true },
  );
  return {
    write: n,
    read: [...read, n],
    notes: [
      `store #${open.number} had ${count} comments: closed, new store #${n}`,
    ],
  };
}

type StoreComment = { user: string; body: string };

/**
 * The store's comments since `fromMs` (by default the window's start), by
 * anyone (callers filter).
 */
function storeCommentsIn(
  exec: Exec,
  repo: string,
  issues: number[],
  nowMs: number,
  fromMs = nowMs - WINDOW_DAYS * DAY_MS,
): StoreComment[] {
  const since = new Date(fromMs).toISOString();
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
  return comments;
}

/**
 * The runs the store already holds, as `<run id>/<attempt>` (the attempt that
 * passed), from the bot's sightings comments' marker blocks only.
 */
export function storedRuns(comments: StoreComment[]): Set<string> {
  const out = new Set<string>();
  for (const c of comments) {
    if (c.user !== STORE_AUTHOR) continue;
    const m = readMarkers(c.body);
    if (m?.get("kind")?.[0] !== "sightings") continue;
    const r = m.get("run")?.[0] ?? "";
    if (/^\d{1,20}\/\d{1,4}$/.test(r)) out.add(r);
  }
  return out;
}

export type Done = {
  action: Action["kind"] | "summary";
  id: string;
  issue?: number;
};

/** True when the body is the summary issue of this run (by its marker block). */
export const isSummaryOf = (body: string, runId: number) =>
  kindOf(body) === "summary" && marker(body, "run") === String(runId);

type Filing = Extract<Action, { kind: "create" | "bump" }>;

/**
 * One issue in place of the per-test issues a run would open or bump, when
 * there are more than MAX_ISSUES_PER_RUN of them.
 */
export function summaryIssue(
  run: RunInfo,
  filing: Filing[],
): { title: string; body: string } {
  const list = filing
    .slice(0, SUMMARY_LIST_MAX)
    .map(
      (a) =>
        `- ${testLine(a.f)}, failed on ${a.seen.map((s) => attemptLink(run.repo, s.run, s.attempt)).join(", ")}`,
    );
  const more = filing.length - list.length;
  return {
    title: `Flaky: ${filing.length} tests failed twice in ${WINDOW_DAYS} days, the last time on ${runLabel(run)} run ${run.runId}`,
    body: [
      `${filing.length} tests that failed on an earlier attempt of ${runLabel(run)} (it passed on attempt ${run.attempt}, with the same commit) have now failed in two or more runs within ${WINDOW_DAYS} days. That is more than ${MAX_ISSUES_PER_RUN} issues to open or bump from one run, so they are listed here instead, with the runs they failed in. Every sighting is recorded in the \`${STORE_LABEL}\` issue as usual.`,
      "",
      `Passed on: ${runLink(run, run.attempt)}`,
      "",
      ...list,
      ...(more > 0 ? [`- and ${more} more`] : []),
      "",
      "Look at the failed attempts. If it was the environment, close this issue. A test that flakes again later gets its own issue when its run files at most a few.",
      "",
      markerBlock([
        ["kind", "summary"],
        ["run", String(run.runId)],
      ]),
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

/**
 * A run whose earlier attempts hold no failed test (only failures outside the
 * tests): nothing to record, but the run is marked in the store, so the
 * reconcile, which looks back over the whole rerun period, never reads it
 * again.
 */
function markNoTest(
  exec: Exec,
  run: RunInfo,
  nowMs: number,
  notes: string[],
): { done: Done[]; notes: string[] } {
  ensureLabel(
    exec,
    run.repo,
    STORE_LABEL,
    "EDEDED",
    "The flaky tracker's record of tests that failed and then passed",
  );
  const store = openStore(exec, run.repo, nowMs);
  notes.push(...store.notes);
  const comments = storeCommentsIn(exec, run.repo, store.read, nowMs);
  if (!storedRuns(comments).has(`${run.runId}/${run.attempt}`))
    gh(
      exec,
      [
        "issue",
        "comment",
        String(store.write),
        "--repo",
        run.repo,
        "--body",
        runDoneComment(run),
      ],
      { write: true },
    );
  return { done: [], notes };
}

export function track(o: { exec: Exec; run: RunInfo; nowMs: number }): {
  done: Done[];
  notes: string[];
} {
  const { exec, run } = o;
  const { found, notes } = collect(exec, run);
  if (!found.length) return markNoTest(exec, run, o.nowMs, notes);
  ensureLabel(
    exec,
    run.repo,
    LABEL,
    "FBCA04",
    "A test that failed and then passed on a rerun of the same run",
  );
  ensureLabel(
    exec,
    run.repo,
    STORE_LABEL,
    "EDEDED",
    "The flaky tracker's record of tests that failed and then passed",
  );
  const done: Done[] = [];
  const tests = firstSightings(found);
  // Record first, every sighting: one is kept even when an issue write below
  // fails, and a rerun of the tracker finds this run in the store and adds
  // nothing.
  const store = openStore(exec, run.repo, o.nowMs);
  notes.push(...store.notes);
  const comments = storeCommentsIn(exec, run.repo, store.read, o.nowMs);
  const stored = parseStore(comments);
  const marked = storedRuns(comments).has(`${run.runId}/${run.attempt}`);
  const fresh = tests.filter(
    (t) =>
      !(stored.get(keyOf(t.f.id)) ?? []).some((s) => s.run === t.sighting.run),
  );
  // Tracker runs are serialized per repo (cloud-flaky-tracker.yml), so one list of
  // the open issues holds for the whole run.
  const open = listOpen(exec, run.repo);
  const actions = tests.map((t) =>
    plan({ ...t, stored: stored.get(keyOf(t.f.id)) ?? [] }, open, o.nowMs),
  );
  const filing = actions.filter(
    (a): a is Filing => a.kind === "create" || a.kind === "bump",
  );
  // The run marker says "this run is fully handled": the reconcile skips a
  // marked run. With nothing to file it rides on the last store part. With
  // filings it is written last (finish), so a failed create or bump leaves the
  // run unmarked and the next run's reconcile tracks it again; its sightings are
  // already stored, so nothing is stored twice, and plan() sees them.
  const post = (body: string) =>
    gh(
      exec,
      [
        "issue",
        "comment",
        String(store.write),
        "--repo",
        run.repo,
        "--body",
        body,
      ],
      { write: true },
    );
  const finish = () => {
    if (!marked && filing.length) post(runDoneComment(run));
    return { done, notes };
  };
  for (const body of storeComments(run, fresh, !filing.length)) post(body);
  const summarize = filing.length > MAX_ISSUES_PER_RUN;
  for (const a of actions) {
    if (a.kind === "record") {
      done.push({ action: "record", id: a.f.id });
      continue;
    }
    if (a.kind === "skip") {
      done.push({ action: "skip", id: a.f.id, issue: a.issue });
      continue;
    }
    if (summarize) continue;
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
          bumpedBody(a.f, a.body, a.seen, o.nowMs),
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
  if (!summarize) return finish();
  const had = open.find((i) => isSummaryOf(i.body, run.runId));
  if (had) {
    done.push({
      action: "skip",
      id: `summary:${run.runId}`,
      issue: had.number,
    });
    return finish();
  }
  const { title, body } = summaryIssue(run, filing);
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
  return finish();
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

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** A run to track, checked: the same rules for an event and a reconcile. */
export function runInfo(o: {
  repo: string;
  workflow: string;
  runId: number;
  attempt: number;
  headSha: string;
  title: string;
}): RunInfo {
  const { repo, runId, attempt } = o;
  if (!REPO_RE.test(repo)) throw new Error("bad --repo");
  const workflow = o.workflow as Workflow;
  if (!WORKFLOWS.includes(workflow)) throw new Error("bad --workflow");
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new Error("bad --run-id");
  if (!Number.isSafeInteger(attempt) || attempt < 2)
    throw new Error("bad --attempt: the tracker needs attempt 2 or later");
  let ref: string;
  if (workflow === "redline-staging") {
    ref = TITLE_RE.exec(o.title)?.[1] ?? "";
    if (!TAG_RE.test(ref))
      throw new Error("the run's title names no release tag");
  } else {
    ref = o.headSha;
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

/** The run the tracker was started for, from its arguments. */
export const runFromArgs = (argv: string[]): RunInfo =>
  runInfo({
    repo: flag(argv, "repo"),
    workflow: flag(argv, "workflow"),
    runId: Number(flag(argv, "run-id")),
    attempt: Number(flag(argv, "attempt")),
    headSha: flag(argv, "head-sha"),
    title: flag(argv, "title"),
  });

// ---- The reconcile ----

/**
 * The reconcile lists runs created up to RERUN_DAYS plus this many hours ago,
 * so a rerun that passed near the end of GitHub's rerun period stays listed.
 */
export const RECONCILE_HOURS = 26;
/** GitHub lets a run be rerun for this many days after it was created. */
export const RERUN_DAYS = 30;

/**
 * The start of the reconcile's range, in whole seconds: RERUN_DAYS plus
 * RECONCILE_HOURS ago.
 */
export const reconcileFrom = (nowMs: number) =>
  Math.floor(nowMs / 1000) * 1000 -
  RERUN_DAYS * DAY_MS -
  RECONCILE_HOURS * 3600 * 1000;
/** list-workflow-runs returns at most this many runs for one query. */
export const LIST_MAX = 1000;
const PER_PAGE = 100;
/** The watched workflows' files, for the runs API. */
export const WORKFLOW_FILES: Record<Workflow, string> = {
  CI: "ci.yml",
  "redline-staging": "redline-staging.yml",
};

/** A watched workflow's run, as the reconcile lists it. */
export type ListedRun = {
  id: number;
  attempt: number;
  name: string;
  event: string;
  branch: string;
  sha: string;
  title: string;
};

/**
 * The workflow_run path's rules, for a listed run whose latest attempt
 * succeeded: attempt 2 or later (a fork's run too), and redline-staging only
 * when dispatched on main (a release gate). collect() then reads only the
 * earlier attempts that failed or timed out on the same head sha.
 */
export const eligible = (r: ListedRun) =>
  r.attempt > 1 &&
  (r.name === "CI" ||
    (r.name === "redline-staging" &&
      r.event === "workflow_dispatch" &&
      r.branch === "main"));

const isoSec = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** A run as the runs API lists it, with only the fields the reconcile reads. */
type RunRow = {
  id: number;
  run_attempt: number;
  conclusion: string | null;
  event: string;
  head_branch: string;
  head_sha: string;
  display_title: string;
};

/**
 * Every run a list-workflow-runs query (`path`, with no created, page or
 * per_page) finds created from `from` to `to` (ms, whole seconds, both ends
 * included). GitHub returns at most LIST_MAX runs for one query, so a range
 * whose total_count is LIST_MAX or more is halved and each half listed the
 * same way. A one-second range that still has that many throws: the list
 * would be incomplete.
 */
export function listCreated(
  exec: Exec,
  path: string,
  from: number,
  to: number,
): RunRow[] {
  const range = encodeURIComponent(`${isoSec(from)}..${isoSec(to)}`);
  const page = (p: number) =>
    JSON.parse(
      gh(exec, [
        "api",
        `${path}&created=${range}&per_page=${PER_PAGE}&page=${p}`,
        "--jq",
        "{total_count, workflow_runs: [.workflow_runs[] | {id, run_attempt, conclusion, event, head_branch, head_sha, display_title}]}",
      ]),
    ) as { total_count: number; workflow_runs: RunRow[] };
  const first = page(1);
  if (first.total_count >= LIST_MAX) {
    if (to - from < 1000)
      throw new Error(
        `${first.total_count} runs created at ${isoSec(from)}: GitHub lists at most ${LIST_MAX} for one query, so the reconcile can't see them all`,
      );
    const mid = from + Math.floor((to - from) / 2000) * 1000;
    return [
      ...listCreated(exec, path, from, mid),
      ...listCreated(exec, path, mid + 1000, to),
    ];
  }
  const out = [...first.workflow_runs];
  for (let p = 2; (p - 1) * PER_PAGE < first.total_count; p++)
    out.push(...page(p).workflow_runs);
  return out;
}

/**
 * A watched workflow's runs created since reconcileFrom (a run can be rerun
 * up to RERUN_DAYS after it was created) whose latest attempt (2 or later)
 * passed, however long ago it passed. No update window: a run whose event was
 * dropped stays listed until the store marks it, so catching it never depends
 * on how soon the next event comes. Whether a failure counts toward "twice in
 * 7 days" is decided later, by the failed job's completion time, never by the
 * run's creation.
 */
export function listRuns(
  exec: Exec,
  repo: string,
  workflow: Workflow,
  nowMs: number,
): ListedRun[] {
  const to = Math.floor(nowMs / 1000) * 1000;
  const from = reconcileFrom(nowMs);
  return listCreated(
    exec,
    `repos/${repo}/actions/workflows/${WORKFLOW_FILES[workflow]}/runs?status=success&exclude_pull_requests=true`,
    from,
    to,
  )
    .filter((r) => r.conclusion === "success" && r.run_attempt > 1)
    .map((r) => ({
      id: r.id,
      attempt: r.run_attempt,
      // The API's .name is the run-name ("redline-staging v0.242.2"), not
      // the workflow's name: use the workflow this list was read for.
      name: workflow,
      event: r.event,
      branch: r.head_branch,
      sha: r.head_sha,
      title: r.display_title,
    }));
}

/**
 * The reconcile, after every tracker run: a tracker run GitHub dropped (its queue full, or the
 * runner gone) leaves a run unrecorded. This lists the watched workflows'
 * runs created since reconcileFrom whose latest attempt passed after an
 * earlier one, however long ago (listCreated splits a listing at GitHub's
 * limit), and tracks each the store doesn't hold yet (by run id and the
 * attempt that passed) with the same code as the event. The store is read
 * over the same range, so a run marked weeks ago is still known. A run the
 * store holds adds nothing and bumps nothing. A run that found no test (it
 * failed outside the tests) is marked once, so it is not read again.
 */
export function reconcile(o: { exec: Exec; repo: string; nowMs: number }): {
  tracked: { run: RunInfo; done: Done[]; notes: string[] }[];
  notes: string[];
  failed: number;
} {
  const { exec, repo, nowMs } = o;
  const notes: string[] = [];
  const listed = WORKFLOWS.flatMap((w) => listRuns(exec, repo, w, nowMs));
  const runs = listed.filter((r) => eligible(r));
  if (!runs.length) return { tracked: [], notes, failed: 0 };
  // Reads only: a store is created only when a run below is tracked. Every
  // listed run's mark was written after the run was created, so reading the
  // stores since reconcileFrom finds all of them.
  const from = reconcileFrom(nowMs);
  const { read } = storeIssues(exec, repo, nowMs, from);
  const have = storedRuns(storeCommentsIn(exec, repo, read, nowMs, from));
  const tracked: { run: RunInfo; done: Done[]; notes: string[] }[] = [];
  let failed = 0;
  for (const r of runs) {
    if (have.has(`${r.id}/${r.attempt}`)) {
      notes.push(`run ${r.id}/${r.attempt}: in the store already`);
      continue;
    }
    try {
      const run = runInfo({
        repo,
        workflow: r.name,
        runId: r.id,
        attempt: r.attempt,
        headSha: r.sha,
        title: r.title,
      });
      tracked.push({ run, ...track({ exec, run, nowMs }) });
    } catch (e) {
      // One run's failure never stops the others; the job still fails.
      failed++;
      notes.push(`run ${r.id}/${r.attempt}: ${(e as Error).message}`);
    }
  }
  return { tracked, notes, failed };
}

const runLines = (run: RunInfo, done: Done[], notes: string[]) => [
  `Flaky tracker, ${runLabel(run)}, run ${run.runId} (passed on attempt ${run.attempt}):`,
  ...(done.length ? [] : ["  no failed test found in the earlier attempts"]),
  ...done.map((d) => `  ${d.action} ${d.issue ? `#${d.issue} ` : ""}${d.id}`),
  ...notes.map((n) => `  note: ${n}`),
];

function main(argv: string[]) {
  let lines: string[];
  let failed = 0;
  if (argv.includes("--reconcile")) {
    const repo = flag(argv, "repo");
    if (!REPO_RE.test(repo)) throw new Error("bad --repo");
    const r = reconcile({ exec: realExec, repo, nowMs: Date.now() });
    failed = r.failed;
    lines = [
      `Flaky tracker reconcile, runs created in the last ${RERUN_DAYS} days and ${RECONCILE_HOURS} hours: ${r.tracked.length} run${r.tracked.length === 1 ? "" : "s"} tracked`,
      ...r.notes.map((n) => `  note: ${n}`),
      ...r.tracked.flatMap((t) => runLines(t.run, t.done, t.notes)),
    ];
  } else {
    const run = runFromArgs(argv);
    const { done, notes } = track({ exec: realExec, run, nowMs: Date.now() });
    lines = runLines(run, done, notes);
  }
  console.log(lines.join("\n"));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  // The step summary is markdown and the ids are untrusted: a fence longer
  // than any backtick run in them keeps it all plain text.
  const text = lines.map(inert).join("\n");
  const fence = "`".repeat(
    Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)),
  );
  if (summary) appendFileSync(summary, `${fence}\n${text}\n${fence}\n`);
  if (failed)
    throw new Error(`${failed} run(s) failed to track; see the notes`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`flaky-tracker: ${(e as Error).message}`);
    process.exit(1);
  }
}
