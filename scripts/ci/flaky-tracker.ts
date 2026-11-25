// The flaky tracker (cloud #447, #264 lane 4 PR2). Tracking only: it changes
// no retry and nothing that blocks. flaky-tracker.yml runs it when a
// redline-staging run passes on a later attempt (2 or more) after an earlier
// attempt of the same run, so the same commit and tag, failed. Each test that
// failed on an earlier attempt failed and then passed with no change, so it is
// flaky. For each one this opens or bumps one open issue labelled `flaky`.
//
// Where the failures come from: the earlier attempt's job logs (one log per
// failed job; job ids are per attempt, artifacts are not):
//   - T19: Playwright's list reporter ends with `  N failed`, then one line per
//     failed test: `    [project] › e2e/staging/<file>:L:C › <title>`.
//   - Red-line: the final `Red-line report (...)` block (src/report.ts
//     formatReport) lists `  [fail] <name> (<reason>)` under `Not pass:`. The
//     file comes from vitest's `FAIL  live/<file> > <name>` lines in the same
//     log. Only `fail` and `infra` count: `blocked` follows another case.
// A failure outside the tests (bring-up, a hand-off, platform-tags) parses to
// no test and is only listed in the step summary.
//
// One issue per test. The issue body carries `<!-- flaky-key: K -->` (K is a
// hash of the test id) and `<!-- flaky-seen: ... -->`, one entry per sighting
// (time, run/attempt). A run already in the list is never noted twice. When
// the test has failed in two different runs in the last 7 days, the issue and
// the comment say "fails twice in 7 days". The owner is the last author of the
// test file at the tag under test (T19: public's file at the tag's PUBLIC_PIN;
// red-line: this repo's tests/redline at the tag). The owner is assigned when
// GitHub says they can be; otherwise the login is written in plain text, never
// as a mention.
//
// TODO(lane 3): when redline-staging runs as a reusable workflow (a queue gate
// calling it with workflow_call), workflow_run fires under the caller's name,
// not redline-staging, and this tracker never sees that run. Add the caller to
// flaky-tracker.yml's workflows and read its jobs (named `<caller job> /
// t19`, `<caller job> / redline`) the same way. Not built yet.
//
// Usage: node --experimental-strip-types scripts/ci/flaky-tracker.ts --repo o/n --run-id <id> --attempt <n> --title "redline-staging vX.Y.Z"
// Needs GH_TOKEN (actions: read, contents: read, issues: write).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type Exec, gh } from "./gh-retry.ts";

export const LABEL = "flaky";
export const PUBLIC_REPO = "open-artifacts-ai/open-artifacts";
/** T19's specs sit in this package of public; Playwright prints paths from it. */
export const T19_PACKAGE = "apps/dashboard";
export const REDLINE_DIR = "tests/redline";
export const WINDOW_DAYS = 7;
export const TWICE_NOTE = "fails twice in 7 days";
const TAG_RE = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const TITLE_RE = /^redline-staging (v\d{1,6}\.\d{1,6}\.\d{1,6})$/;

export type Suite = "t19" | "redline";
export type Failure = {
  suite: Suite;
  id: string;
  title: string;
  file?: string;
};
export type Sighting = { at: string; run: number; attempt: number };

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

/** The tests Playwright's list reporter names under `N failed`. */
export function parsePlaywright(log: string): Failure[] {
  const out: Failure[] = [];
  const lines = logLines(log);
  for (let i = 0; i < lines.length; i++) {
    if (!/^ {2}\d+ failed\s*$/.test(lines[i] ?? "")) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^ {4}\[[^\]]*\] › (\S+?):\d+:\d+ › (.+?)\s*$/.exec(
        lines[j] ?? "",
      );
      if (!m) break;
      const file = m[1] as string;
      const title = m[2] as string;
      out.push({ suite: "t19", id: `t19:${file}:${title}`, title, file });
    }
  }
  return dedupe(out);
}

/** Drops ` (<reason>)` from a `Not pass:` entry: the last balanced group. */
export function stripReason(rest: string): string {
  if (!rest.endsWith(")")) return rest;
  let depth = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i] === ")") depth++;
    else if (rest[i] === "(" && --depth === 0)
      return rest[i - 1] === " " ? rest.slice(0, i - 1) : rest;
  }
  return rest;
}

/** The red-line cases the final report lists as fail or infra. */
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
    const m = /^ {2}\[(fail|infra)\] (.+)$/.exec(l);
    if (!m) continue;
    const rest = (m[2] as string).trimEnd();
    const name =
      names.find((n) => rest === n || rest.startsWith(`${n} (`)) ??
      stripReason(rest);
    const file =
      files.get(name) ??
      /^(live\/\S+\.test\.ts): module error$/.exec(name)?.[1];
    out.push({
      suite: "redline",
      id: `redline:${name}`,
      title: name,
      ...(file ? { file } : {}),
    });
  }
  return dedupe(out);
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

/** Two different runs with this failure within the window, ending now. */
export function twiceInWindow(s: Sighting[], nowMs: number): boolean {
  const from = nowMs - WINDOW_DAYS * 24 * 3600 * 1000;
  const runs = new Set(
    s.filter((x) => Date.parse(x.at) >= from).map((x) => x.run),
  );
  return runs.size >= 2;
}

const statusLine = (s: Sighting[], nowMs: number) => {
  const runs = new Set(s.map((x) => x.run)).size;
  return `<!-- flaky-status -->Seen in ${runs} run${runs === 1 ? "" : "s"}${twiceInWindow(s, nowMs) ? `; ${TWICE_NOTE}` : ""}.<!-- /flaky-status -->`;
};

export type Owner = { login: string; assignable: boolean } | null;

export type RunInfo = {
  repo: string;
  runId: number;
  attempt: number;
  tag: string;
  url: string;
};

const runLink = (r: RunInfo, attempt: number) => `${r.url}/attempts/${attempt}`;

export function issueTitle(f: Failure): string {
  const where = f.file ? ` (${f.file.split("/").pop()})` : "";
  const t = `Flaky: ${f.title}${where}`;
  return t.length > 240 ? `${t.slice(0, 237)}...` : t;
}

export function newIssueBody(o: {
  f: Failure;
  run: RunInfo;
  seen: Sighting[];
  owner: Owner;
  ownerPath: string;
  nowMs: number;
}): string {
  const { f, run } = o;
  const s = o.seen.at(-1) as Sighting;
  const owner = o.owner
    ? o.owner.assignable
      ? `${o.owner.login} (assigned)`
      : `${o.owner.login} (named only: GitHub can't assign them here)`
    : "unknown (no commit found, or the lookup failed)";
  return [
    `<!-- flaky-key: ${keyOf(f.id)} -->`,
    `A ${f.suite === "t19" ? "T19" : "red-line"} test failed on attempt ${s.attempt} of redline-staging ${run.tag} and the same run passed on attempt ${run.attempt}, with the same commit and tag. Nothing changed between the attempts, so the test is flaky.`,
    "",
    `Test: \`${f.title}\``,
    `File: \`${o.ownerPath}\``,
    `Last author of the file at ${run.tag}: ${owner}`,
    "",
    `First failure: ${runLink(run, s.attempt)}`,
    `Passed on: ${runLink(run, run.attempt)}`,
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
  f: Failure;
  run: RunInfo;
  sighting: Sighting;
  twice: boolean;
}): string {
  return [
    `<!-- run:${o.sighting.run}/${o.sighting.attempt} -->`,
    `Failed again on attempt ${o.sighting.attempt} of redline-staging ${o.run.tag}, passed on attempt ${o.run.attempt}: ${runLink(o.run, o.sighting.attempt)}`,
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
      sighting: Sighting;
    }
  | { kind: "skip"; f: Failure; issue: number; why: string };

/**
 * What each failure does: a new issue, a bump of its open one, or a skip when
 * that issue already notes this run. One sighting per failure: the earliest
 * failed attempt that named it.
 */
export function plan(
  found: { f: Failure; sighting: Sighting }[],
  open: Issue[],
): Action[] {
  const first = new Map<string, { f: Failure; sighting: Sighting }>();
  for (const x of found) {
    const had = first.get(x.f.id);
    if (!had || x.sighting.attempt < had.sighting.attempt) first.set(x.f.id, x);
  }
  const actions: Action[] = [];
  for (const { f, sighting } of first.values()) {
    const marker = `<!-- flaky-key: ${keyOf(f.id)} -->`;
    const issue = open.find((i) => i.body.includes(marker));
    if (!issue) {
      actions.push({ kind: "create", f, seen: [sighting] });
      continue;
    }
    const prior = parseSeen(issue.body);
    if (prior.some((p) => p.run === sighting.run)) {
      actions.push({
        kind: "skip",
        f,
        issue: issue.number,
        why: `run ${sighting.run} already noted`,
      });
      continue;
    }
    actions.push({
      kind: "bump",
      f,
      issue: issue.number,
      body: issue.body,
      seen: [...prior, sighting],
      sighting,
    });
  }
  return actions;
}

/** The repo-relative path whose last author owns the test. */
export function ownerPath(f: Failure): string {
  if (f.suite === "t19") return `${T19_PACKAGE}/${f.file ?? "e2e/staging"}`;
  return `${REDLINE_DIR}/${f.file ?? "live"}`;
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
): { found: { f: Failure; sighting: Sighting }[]; notes: string[] } {
  const base = `repos/${run.repo}/actions/runs/${run.runId}`;
  const last = JSON.parse(
    gh(exec, ["api", `${base}/attempts/${run.attempt}`]),
  ) as Attempt;
  const found: { f: Failure; sighting: Sighting }[] = [];
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
      const log = jobLog(exec, run.repo, j.id);
      const fs = [...parsePlaywright(log), ...parseRedline(log)];
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
      ? lastAuthor(exec, PUBLIC_REPO, path, publicPin(exec, run.repo, run.tag))
      : lastAuthor(exec, run.repo, path, run.tag);
  if (!login) return null;
  if (login.endsWith("[bot]")) return { login, assignable: false };
  // 204 when they can be assigned here, 404 otherwise.
  const r = exec("gh", ["api", `repos/${run.repo}/assignees/${login}`]);
  return { login, assignable: r.code === 0 };
}

function ensureLabel(exec: Exec, repo: string) {
  const labels = JSON.parse(
    gh(exec, [
      "label",
      "list",
      "--repo",
      repo,
      "--search",
      LABEL,
      "--json",
      "name",
    ]),
  ) as { name: string }[];
  if (labels.some((l) => l.name === LABEL)) return;
  gh(
    exec,
    [
      "label",
      "create",
      LABEL,
      "--repo",
      repo,
      "--color",
      "FBCA04",
      "--description",
      "A test that failed and then passed on a rerun of the same run",
    ],
    { write: true },
  );
}

export type Done = { action: Action["kind"]; id: string; issue?: number };

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
  ensureLabel(exec, run.repo);
  const done: Done[] = [];
  // One sighting per test, then a fresh list of the open issues right before
  // each write. Tracker runs are not serialized (a shared concurrency group
  // would let a newer event cancel a pending one), so another run may have
  // opened or bumped the issue a moment ago.
  for (const first of plan(found, [])) {
    if (first.kind !== "create") continue;
    const sighting = first.seen[0] as Sighting;
    const a = plan([{ f: first.f, sighting }], listOpen(exec, run.repo))[0];
    if (!a) continue;
    if (a.kind === "skip") {
      done.push({ action: "skip", id: a.f.id, issue: a.issue });
      continue;
    }
    if (a.kind === "bump") {
      const twice = twiceInWindow(a.seen, o.nowMs);
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
          bumpComment({ f: a.f, run, sighting: a.sighting, twice }),
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

function main(argv: string[]) {
  const repo = flag(argv, "repo");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("bad --repo");
  const runId = Number(flag(argv, "run-id"));
  const attempt = Number(flag(argv, "attempt"));
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new Error("bad --run-id");
  if (!Number.isSafeInteger(attempt) || attempt < 2)
    throw new Error("bad --attempt: the tracker needs attempt 2 or later");
  const tag = TITLE_RE.exec(flag(argv, "title"))?.[1] ?? "";
  if (!TAG_RE.test(tag))
    throw new Error("the run's title names no release tag");
  const run: RunInfo = {
    repo,
    runId,
    attempt,
    tag,
    url: `https://github.com/${repo}/actions/runs/${runId}`,
  };
  const { done, notes } = track({ exec: realExec, run, nowMs: Date.now() });
  const lines = [
    `Flaky tracker, redline-staging ${tag}, run ${runId} (passed on attempt ${attempt}):`,
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
