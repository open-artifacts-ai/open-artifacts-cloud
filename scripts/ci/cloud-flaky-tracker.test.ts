// cloud #447: the flaky tracker parses earlier attempts' job logs, records
// every sighting in the store issue, and opens or bumps one `flaky` issue per
// test seen in two runs within 7 days. Fixtures are excerpts of real job logs:
// run 45693977251 attempt 1 (t19), run 44935686580 attempt 1 (redline), and
// CI runs 45725455500 and 44612972455 attempt 1 (overlay shards).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  backlogLine,
  bumpedBody,
  COMMENT_MAX,
  caseName,
  codeSpan,
  e2ePackage,
  eligible,
  escapeId,
  type Failure,
  inert,
  isSummaryOf,
  issueKey,
  issueTitle,
  keyOf,
  LABEL,
  LIST_MAX,
  type ListedRun,
  listRuns,
  MAX_ISSUES_PER_RUN,
  MAX_STORE_COMMENTS,
  markerBlock,
  mergeSightings,
  newIssueBody,
  parseJob,
  parsePlaywright,
  parseRedline,
  parseSeen,
  parseStore,
  parseVitest,
  pendingRuns,
  pendingTries,
  plan,
  QUIET_DAYS,
  RECONCILE_CALLS,
  RECONCILE_LOGS,
  RECONCILE_MS,
  RERUN_DAYS,
  type RunInfo,
  readMarkers,
  reconcile,
  runFromArgs,
  type Sighting,
  STORE_AUTHOR,
  STORE_BODY,
  STORE_LABEL,
  sightingLine,
  storeComment,
  storeComments,
  storedRuns,
  TWICE_NOTE,
  titleText,
  track,
  twiceInWindow,
  UNREADABLE_TRIES,
  unreadableRuns,
} from "./cloud-flaky-tracker.ts";
import type { Exec } from "./gh-retry.ts";

const E = "\u001b";
const T19_LOG = [
  "2026-11-25T20:23:28.9681083Z   ✓   3 [rl-a] › e2e/staging/rl-a/comments.spec.ts:133:1 › live reply: an agent's reply shows with the page open, no reload @gate (7.6s)",
  "2026-11-25T20:23:44.7829094Z   ✘   6 [rl-a] › e2e/staging/rl-a/joins.spec.ts:133:1 › an invited member: Google is their way in, never a code; their session lands in the library @gate (4.6s)",
  "2026-11-25T20:25:16.4357581Z   1) [rl-a] › e2e/staging/rl-a/joins.spec.ts:133:1 › an invited member: Google is their way in, never a code; their session lands in the library @gate ",
  "2026-11-25T20:25:16.4358348Z ",
  "2026-11-25T20:25:16.4361809Z     Error: expect(received).toEqual(expected) // deep equality",
  "2026-11-25T20:25:16.4395881Z ",
  "2026-11-25T20:25:16.4396029Z   2 failed",
  "2026-11-25T20:25:16.4397468Z     [rl-a] › e2e/staging/rl-a/joins.spec.ts:133:1 › an invited member: Google is their way in, never a code; their session lands in the library @gate ",
  "2026-11-25T20:25:16.4397469Z     [rl-a] › e2e/staging/rl-a/comments.spec.ts:160:1 › live reply › shows @gate ",
  "2026-11-25T20:25:16.4398505Z   11 passed (2.0m)",
  "2026-11-25T20:25:16.5205511Z [ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command failed with exit code 1: playwright test",
].join("\n");

const fail = (name: string) =>
  `2026-11-21T18:34:28.2669083Z [surfaces] ${E}[41m${E}[1m FAIL ${E}[22m${E}[49m live/surfaces.test.ts${E}[2m > ${E}[22msurface probes (cross-install)${E}[2m > ${E}[22m${name}`;
const RL_LOG = [
  fail("org GET /api/v1/me/push/key [session]"),
  fail("org GET /api/v1/me/push/key [pat]"),
  // The in-job rerun's first report: never read, the final one is.
  "2026-11-21T18:30:00.0000000Z [first run] Red-line report (staging): 421 cases",
  "2026-11-21T18:30:00.0000000Z Not pass:",
  "2026-11-21T18:30:00.0000000Z   [infra] bus > dropped (no answer)",
  "2026-11-21T18:36:56.2441507Z Red-line report (staging): 421 cases",
  "2026-11-21T18:36:56.2441986Z   pass 411, fail 4, staging-only 0, not-applicable 0, unproven-live 6, infra 0, blocked 0",
  "2026-11-21T18:36:56.2442290Z Not pass:",
  "2026-11-21T18:36:56.2442956Z   [fail] surface probes (cross-install) > org GET /api/v1/me/push/key [session] (B's own credential at B (rl-b; expected allowed (the probe)): B's own credential at B: the probe failed (status 200, body sha256:d24165aa174d5648 (103 bytes); error sha256:f2ba1ce133fc8611))",
  "2026-11-21T18:36:56.2444206Z       leg: B's own credential at B at rl-b; expected allowed (the probe); got B's own credential at B: the probe failed",
  "2026-11-21T18:36:56.2445146Z   [fail] surface probes (cross-install) > org GET /api/v1/me/push/key [pat] (B's own credential at B (rl-b; expected allowed (the probe)))",
  "2026-11-21T18:36:56.2445147Z   [blocked] surface probes (cross-install) > later (a case it depends on did not pass)",
  "2026-11-21T18:36:56.2445148Z   [not-applicable] provisioning > P30: alert (pre-prod)",
  "2026-11-21T18:36:56.2445149Z   [infra] guard > hooks answer (fetch failed (no answer))",
  "2026-11-21T18:36:56.2445150Z   [fail] live/edge.test.ts: module error (error outside a test: boom)",
  "2026-11-21T18:36:56.2489048Z Notes:",
  "2026-11-21T18:36:56.2489049Z   [live/live.test.ts] pacing (lane front): 2 hook claim(s)",
  '2026-11-21T18:36:56.2492754Z Gate: FAIL (4 of 421 cases are not "pass"; 6 accepted unproven-live)',
  '2026-11-21T18:36:56.2493112Z [gate] Gate: FAIL (4 of 421 cases are not "pass"; 6 accepted unproven-live)',
].join("\n");

describe("parsePlaywright", () => {
  it("names each test of the `N failed` list, file and title, without the line", () => {
    expect(parsePlaywright(T19_LOG)).toEqual([
      {
        suite: "t19",
        id: "t19:e2e/staging/rl-a/joins.spec.ts:an invited member: Google is their way in, never a code; their session lands in the library @gate",
        title:
          "an invited member: Google is their way in, never a code; their session lands in the library @gate",
        file: "e2e/staging/rl-a/joins.spec.ts",
      },
      {
        suite: "t19",
        id: "t19:e2e/staging/rl-a/comments.spec.ts:live reply › shows @gate",
        title: "live reply › shows @gate",
        file: "e2e/staging/rl-a/comments.spec.ts",
      },
    ]);
  });

  it("finds nothing in a passing log or a log of another suite", () => {
    expect(parsePlaywright("  12 passed (2.0m)\n")).toEqual([]);
    expect(parsePlaywright(RL_LOG)).toEqual([]);
  });
});

describe("parseRedline", () => {
  it("reads the final report's fail cases, never infra, with the file from vitest's FAIL lines", () => {
    expect(parseRedline(RL_LOG)).toEqual([
      {
        suite: "redline",
        id: "redline:live/surfaces.test.ts:surface probes (cross-install) > org GET /api/v1/me/push/key [session]",
        title:
          "surface probes (cross-install) > org GET /api/v1/me/push/key [session]",
        file: "live/surfaces.test.ts",
      },
      {
        suite: "redline",
        id: "redline:live/surfaces.test.ts:surface probes (cross-install) > org GET /api/v1/me/push/key [pat]",
        title:
          "surface probes (cross-install) > org GET /api/v1/me/push/key [pat]",
        file: "live/surfaces.test.ts",
      },
      {
        suite: "redline",
        id: "redline:live/edge.test.ts:live/edge.test.ts: module error",
        title: "live/edge.test.ts: module error",
        file: "live/edge.test.ts",
      },
    ]);
  });

  it("finds nothing without a report, or in a T19 log", () => {
    expect(parseRedline("redline: no report was written (x)\n")).toEqual([]);
    expect(parseRedline(T19_LOG)).toEqual([]);
  });

  it("keys a case without a FAIL line on its name only, even when the cut reason's parens don't balance", () => {
    expect(caseName("a (b) > c (why (nested))")).toBe("a (b) > c");
    expect(caseName("a > b [pat]")).toBe("a > b [pat]");
    expect(caseName("a (b) > c (status 500 (body sha256:12…")).toBe(
      "a (b) > c",
    );
    expect(caseName("live/x.test.ts: module error (boom (")).toBe(
      "live/x.test.ts: module error",
    );
    const report = (reason: string) =>
      [
        "Red-line report (staging): 1 cases",
        "Not pass:",
        `  [fail] guard > hooks answer (${reason}`,
        "Gate: FAIL",
      ].join("\n");
    const a = parseRedline(report("status 500 (body sha256:aa)"));
    const b = parseRedline(report("timeout after 30s (lane front; cut…"));
    expect(a).toEqual([
      {
        suite: "redline",
        id: "redline::guard > hooks answer",
        title: "guard > hooks answer",
      },
    ]);
    expect(b).toEqual(a);
  });

  it("keys a case with a FAIL line on its file and name, whatever the reason says", () => {
    const report = (reason: string) =>
      [
        fail("org GET /x [pat]"),
        "Red-line report (staging): 1 cases",
        "Not pass:",
        `  [fail] surface probes (cross-install) > org GET /x [pat] (${reason}`,
        "Gate: FAIL",
      ].join("\n");
    const a = parseRedline(report("expected allowed (the probe))"));
    const b = parseRedline(report("got 500 (cut"));
    expect(a[0]?.id).toBe(
      "redline:live/surfaces.test.ts:surface probes (cross-install) > org GET /x [pat]",
    );
    expect(b).toEqual(a);
  });
});

// CI's overlay shard c (run 45725455500) and shard a (run 44612972455)
// excerpts: a root-vitest failure after a step header, and a private
// package's failures inside its `test <pkg>` group.
const vfail = (file: string, ...names: string[]) =>
  `2026-11-19T21:00:49.3825912Z ${E}[41m${E}[1m FAIL ${E}[22m${E}[49m ${file}${names.map((n) => `${E}[2m > ${E}[22m${n}`).join("")}`;
const CI_LOG = [
  "2026-11-19T20:59:55.6142298Z ##[group]test tests/redline",
  "2026-11-19T20:59:56.0287736Z $ pnpm --filter @oa/provision build && vitest run",
  "2026-11-19T21:00:00.0154364Z      × cover every ROUTE_POLICY route, MCP tool and content route 15ms",
  "2026-11-19T21:00:00.0154365Z stdout | test/surfaces.test.ts > probe cases > not a failure",
  vfail(
    "test/surfaces.test.ts",
    "probe cases (derived from Backend's surfaces)",
    "cover every ROUTE_POLICY route, MCP tool and content route",
  ),
  vfail("test/broken.test.ts [ test/broken.test.ts ]"),
  "2026-11-19T21:00:49.4047929Z  Test Files  2 failed | 44 passed | 2 skipped (48)",
  "2026-11-19T21:00:49.4105994Z ##[error]AssertionError: expected [ …(3) ] to deeply equal []",
  "2026-11-26T00:01:08.4580013Z ##[group]Run set -euo pipefail",
  '2026-11-26T00:01:08.4580014Z mapfile -t t < "$PLAN/root-tests.txt"',
  "2026-11-26T00:01:08.4580015Z ##[endgroup]",
  vfail(
    "scripts/ci/pin-bump.test.ts",
    "pin-bump.yml",
    "direct mode (PIN_BUMP_DIRECT, cloud #264)",
    "CI runs in full on a push to pin-land/*",
  ),
  '2026-11-26T00:02:00.0000000Z ##[group]Run ../private/scripts/ci-public-tests.sh . "$PLAN"',
  "2026-11-26T00:02:00.0000001Z ##[endgroup]",
  "2026-11-26T00:02:01.0000000Z ci-public-tests: apps/dashboard [vitest.config (default)]: test/hosted.test.ts",
  vfail("test/hosted.test.ts", "hosted", "renders"),
].join("\n");

const E2E_LOG = [
  "2026-11-26T01:00:00.0000000Z   1) e2e/login.spec.ts:12:3 › login › shows the form ─────",
  "2026-11-26T01:00:00.0000001Z   1 failed",
  "2026-11-26T01:00:00.0000002Z     e2e/login.spec.ts:12:3 › login › shows the form ",
  "2026-11-26T01:00:00.0000003Z   9 passed (31.0s)",
].join("\n");

describe("CI logs", () => {
  it("names vitest's failures with repo-relative files, from the package each step runs", () => {
    expect(parseVitest(CI_LOG)).toEqual([
      {
        suite: "vitest",
        id: "vitest:tests/redline/test/surfaces.test.ts:probe cases (derived from Backend's surfaces) > cover every ROUTE_POLICY route, MCP tool and content route",
        title:
          "probe cases (derived from Backend's surfaces) > cover every ROUTE_POLICY route, MCP tool and content route",
        file: "tests/redline/test/surfaces.test.ts",
      },
      {
        suite: "vitest",
        id: "vitest:tests/redline/test/broken.test.ts:tests/redline/test/broken.test.ts: module error",
        title: "tests/redline/test/broken.test.ts: module error",
        file: "tests/redline/test/broken.test.ts",
      },
      {
        suite: "vitest",
        id: "vitest:scripts/ci/pin-bump.test.ts:pin-bump.yml > direct mode (PIN_BUMP_DIRECT, cloud #264) > CI runs in full on a push to pin-land/*",
        title:
          "pin-bump.yml > direct mode (PIN_BUMP_DIRECT, cloud #264) > CI runs in full on a push to pin-land/*",
        file: "scripts/ci/pin-bump.test.ts",
      },
      {
        suite: "vitest",
        id: "vitest:apps/dashboard/test/hosted.test.ts:hosted > renders",
        title: "hosted > renders",
        file: "apps/dashboard/test/hosted.test.ts",
      },
    ]);
  });

  it("names a CI e2e failure under its app, with no project in the line", () => {
    expect(parseJob("CI", "e2e (admin)", E2E_LOG)).toEqual([
      {
        suite: "e2e",
        id: "e2e:apps/admin/e2e/login.spec.ts:login › shows the form",
        title: "login › shows the form",
        file: "apps/admin/e2e/login.spec.ts",
      },
    ]);
    expect(e2ePackage("overlay (a)")).toBe("");
  });

  it("never reads a red-line log as plain vitest, so infra cases stay out", () => {
    expect(parseJob("redline-staging", "redline", RL_LOG)).toEqual(
      parseRedline(RL_LOG),
    );
    expect(parseJob("redline-staging", "t19", T19_LOG)).toEqual(
      parsePlaywright(T19_LOG),
    );
  });
});

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const run: RunInfo = {
  repo: "o/cloud",
  workflow: "redline-staging",
  runId: 900,
  attempt: 2,
  ref: "v0.246.0",
  url: "https://github.com/o/cloud/actions/runs/900",
};
const ciRun: RunInfo = { ...run, workflow: "CI", ref: SHA };
const NOW = Date.parse("2026-11-26T12:00:00Z");
const f: Failure = {
  suite: "t19",
  id: "t19:e2e/staging/rl-a/comments.spec.ts:live reply @gate",
  title: "live reply @gate",
  file: "e2e/staging/rl-a/comments.spec.ts",
};
const s900: Sighting = { at: "2026-11-26T11:00:00Z", run: 900, attempt: 1 };
const s800: Sighting = { at: "2026-11-24T10:00:00Z", run: 800, attempt: 1 };
const bodyWith = (seen: Sighting[]) =>
  newIssueBody({
    f,
    run,
    seen,
    owner: { login: "someone", assignable: false },
    ownerPath: "apps/dashboard/e2e/staging/rl-a/comments.spec.ts",
  });

describe("the sightings store", () => {
  it("reads back the machine lines it writes, one per test, by the bot only", () => {
    const g = { f, sighting: s900 };
    const body = storeComment(run, [g]);
    expect(body).toContain(sightingLine(keyOf(f.id), s900));
    expect(body).toContain("`live reply @gate`");
    expect(body).toContain("/runs/900/attempts/1");
    expect(parseStore([{ user: STORE_AUTHOR, body }])).toEqual(
      new Map([[keyOf(f.id), [s900]]]),
    );
    expect(parseStore([{ user: "someone", body }]).size).toBe(0);
  });

  it("keeps one sighting per run, its earliest attempt, oldest first", () => {
    expect(mergeSightings([{ ...s900, attempt: 2 }], [s900], [s800])).toEqual([
      s800,
      s900,
    ]);
  });
});

describe("plan: an issue only at the second run within 7 days", () => {
  it("only records a first sighting", () => {
    expect(plan({ f, sighting: s900, stored: [] }, [])).toMatchObject({
      kind: "record",
    });
    // The store already holding this run is still one run.
    expect(plan({ f, sighting: s900, stored: [s900] }, []).kind).toBe("record");
  });

  it("opens an issue with both runs at the second, but not when the first is 8 days old", () => {
    expect(plan({ f, sighting: s900, stored: [s800] }, [])).toEqual({
      kind: "create",
      f,
      seen: [s800, s900],
    });
    const old: Sighting = { ...s800, at: "2026-11-18T11:00:00Z" };
    expect(plan({ f, sighting: s900, stored: [old] }, []).kind).toBe("record");
  });

  it("bumps the open issue that carries the test's key, and never notes a run twice", () => {
    const issue = { number: 7, body: bodyWith([s800]) };
    expect(issueKey(issue.body)).toBe(keyOf(f.id));
    expect(plan({ f, sighting: s900, stored: [s800] }, [issue])).toMatchObject({
      kind: "bump",
      issue: 7,
      seen: [s800, s900],
      added: [s900],
    });
    const noted = { number: 7, body: bodyWith([s800, s900]) };
    expect(plan({ f, sighting: s900, stored: [s800] }, [noted])).toEqual({
      kind: "skip",
      f,
      issue: 7,
      why: "run 900 already noted",
    });
  });

  it("bumps only at 2 or more distinct runs in the last 7 days, this one counted", () => {
    const issue = { number: 7, body: bodyWith([]) };
    // This run alone, even at two attempts: no bump.
    expect(
      plan({ f, sighting: s900, stored: [{ ...s900, attempt: 2 }] }, [issue])
        .kind,
    ).toBe("record");
    // One earlier run within 7 days in the store: a bump.
    expect(plan({ f, sighting: s900, stored: [s800] }, [issue])).toMatchObject({
      kind: "bump",
      added: [s800, s900],
    });
    // The same earlier run, 8 days old: no bump.
    const old: Sighting = { ...s800, at: "2026-11-18T11:00:00Z" };
    expect(plan({ f, sighting: s900, stored: [old] }, [issue]).kind).toBe(
      "record",
    );
  });

  it("does not bump an open issue on a lone sighting in the window", () => {
    const old: Sighting = { ...s800, at: "2026-11-01T00:00:00Z" };
    const issue = { number: 7, body: bodyWith([old]) };
    expect(plan({ f, sighting: s900, stored: [] }, [issue]).kind).toBe(
      "record",
    );
  });

  it("notes 'fails twice in 7 days' for two runs within 7 days, not at 8", () => {
    const at = (d: string, r: number): Sighting => ({
      at: d,
      run: r,
      attempt: 1,
    });
    expect(twiceInWindow([s900])).toBe(false);
    expect(twiceInWindow([s900, { ...s900, attempt: 2 }])).toBe(false);
    expect(twiceInWindow([at("2026-11-20T12:00:00Z", 1), s900])).toBe(true);
    expect(twiceInWindow([at("2026-11-18T12:00:00Z", 1), s900])).toBe(false);
    const b = bumpedBody(f, bodyWith([at("2026-11-24T00:00:00Z", 1)]), [
      at("2026-11-24T00:00:00Z", 1),
      s900,
    ]);
    expect(b).toContain(`Seen in 2 runs; ${TWICE_NOTE}.`);
    expect(parseSeen(b)).toEqual([at("2026-11-24T00:00:00Z", 1), s900]);
  });

  it("puts a title with backticks, mentions and refs in a code span it can't leave", () => {
    expect(codeSpan("plain @gate #12")).toBe("`plain @gate #12`");
    expect(codeSpan("a ` @someone #1 `` b")).toBe("```a ` @someone #1 `` b```");
    expect(codeSpan("`x`")).toBe("`` `x` ``");
    const evil: Failure = { ...f, title: "x` @someone #1 `y" };
    const b = newIssueBody({
      f: evil,
      run,
      seen: [s800, s900],
      owner: null,
      ownerPath: "apps/dashboard/e2e/a`b.spec.ts",
    });
    expect(b).toContain("Test: ``x` @someone #1 `y``");
    expect(b).toContain("File: ``apps/dashboard/e2e/a`b.spec.ts``");
    expect(storeComment(run, [{ f: evil, sighting: s900 }])).toContain(
      "``x` @someone #1 `y``",
    );
  });

  it("lists every run's link and names an owner it can't assign in plain text", () => {
    const b = bodyWith([s800, s900]);
    expect(b).toContain("/runs/800/attempts/1");
    expect(b).toContain("/runs/900/attempts/1");
    expect(b).toContain("someone (named only");
    expect(b).not.toContain("@someone");
  });
});

describe("untrusted text can't forge a marker or escape a comment", () => {
  const hostile: Failure = {
    suite: "t19",
    id: "t19:e2e/x.spec.ts:x --> @someone <!-- flaky-tracker-markers",
    title:
      "x ---> @someone #1 <!-- flaky-tracker-markers\nkind: summary\nrun: 900\n--> --!> -->",
    file: "e2e/<!--a-->.spec.ts",
  };
  const forgedKey = `<!-- flaky-tracker-markers\nkind: test\nkey: ${keyOf(f.id)}\nseen: 2026-11-25T00:00:00Z 1/1; 2026-11-25T01:00:00Z 2/1\n-->`;

  it("inert() leaves no comment opener, closer or block name, and stays one line", () => {
    for (const t of [
      hostile.title,
      "--->",
      "<!---->",
      "<!--->",
      "----->>",
      "--!>",
      forgedKey,
    ]) {
      const out = inert(t);
      expect(out).not.toMatch(/<!--|--!?>|flaky-tracker-markers|\n/);
    }
    expect(inert("plain title @gate")).toBe("plain title @gate");
  });

  it("escapes every - < > in the id, so it can't close the comment it sits in", () => {
    const e = escapeId(hostile.id);
    expect(e).not.toMatch(/[-<>]/);
    expect(e).toContain("x %2D%2D%3E @someone");
    const b = newIssueBody({
      f: hostile,
      run,
      seen: [s800, s900],
      owner: null,
      ownerPath: hostile.file as string,
    });
    // The only comment closers are the status line's and the block's own.
    expect(b.match(/-->/g)).toHaveLength(3);
    const m = readMarkers(b);
    expect(m?.get("id")).toEqual([e]);
    expect(m?.get("kind")).toEqual(["test"]);
    expect(issueKey(b)).toBe(keyOf(hostile.id));
    expect(parseSeen(b)).toEqual([s800, s900]);
  });

  it("reads markers only from the trailing block: a title holding one is just text", () => {
    const evil: Failure = { ...f, id: "t19:x:y", title: forgedKey };
    const b = newIssueBody({
      f: evil,
      run,
      seen: [s900],
      owner: null,
      ownerPath: "x",
    });
    expect(issueKey(b)).toBe(keyOf(evil.id));
    expect(parseSeen(b)).toEqual([s900]);
    // A forged block anywhere but last is never read.
    expect(readMarkers(`${forgedKey}\nmore text`)).toBeNull();
    expect(issueKey(`${forgedKey}\n${bodyWith([s900])}`)).toBe(keyOf(f.id));
    // An open issue whose body only quotes a marker is no test's issue.
    expect(
      plan({ f, sighting: s900, stored: [s800] }, [
        { number: 4, body: `${forgedKey} x` },
      ]).kind,
    ).toBe("create");
  });

  it("a hostile title in the store can't add a sighting or a summary", () => {
    const evil: Failure = {
      ...f,
      title: `a\n${sightingLine(keyOf(f.id), s800)}\n-->\n${forgedKey}`,
    };
    const body = storeComment(run, [{ f: evil, sighting: s900 }]);
    expect(body.match(/<!--/g)).toHaveLength(1);
    expect(body.match(/-->/g)).toHaveLength(1);
    expect(parseStore([{ user: STORE_AUTHOR, body }])).toEqual(
      new Map([[keyOf(evil.id), [s900]]]),
    );
    const sum = newIssueBody({
      f: hostile,
      run,
      seen: [s900],
      owner: null,
      ownerPath: "x",
    });
    expect(isSummaryOf(sum, 900)).toBe(false);
  });

  it("puts no backtick, # or @ in an issue title", () => {
    const t = issueTitle({
      ...hostile,
      title: "a `b` #12 @someone",
      file: "e2e/#3@x`.spec.ts",
    });
    expect(t).not.toMatch(/[`#@]/);
    expect(t).toBe(
      "Flaky: a b \uFF0312 \uFF20someone (\uFF033\uFF20x.spec.ts)",
    );
    expect(titleText(hostile.title)).not.toMatch(/[`#@]|<!--|-->/);
  });
});

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
/** A run as the runs API lists it. */
type Listed = {
  id: number;
  run_attempt: number;
  conclusion: string;
  created_at: string;
  updated_at: string;
  name: string;
  event: string;
  head_branch: string;
  head_sha: string;
  display_title: string;
};
/** A listed run, created and last updated so long before NOW (1 day, 1 hour). */
const row = (
  r: ListedRun,
  o: { created?: number; updated?: number } = {},
): Listed => ({
  id: r.id,
  run_attempt: r.attempt,
  conclusion: "success",
  created_at: iso(NOW - (o.created ?? DAY)),
  updated_at: iso(NOW - (o.updated ?? HOUR)),
  name: r.name,
  event: r.event,
  head_branch: r.branch,
  head_sha: r.sha,
  display_title: r.title,
});
/**
 * list-workflow-runs, as GitHub answers it: the runs created in the query's
 * range (both ends included), newest first, the full total_count, but only
 * the first LIST_MAX of them reachable by page.
 */
function listPage(runs: Listed[], path: string): string {
  const q = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  const [a, b] = (q.get("created") ?? "").split("..");
  if (!a || !b) throw new Error(`no created range in ${path}`);
  const per = Number(q.get("per_page"));
  const page = Number(q.get("page"));
  const hit = runs
    .filter(
      (r) =>
        r.created_at >= a &&
        r.created_at <= b &&
        (q.get("status") !== "success" || r.conclusion === "success"),
    )
    .sort((x, y) => y.created_at.localeCompare(x.created_at));
  return JSON.stringify({
    total_count: hit.length,
    workflow_runs: hit.slice(0, LIST_MAX).slice((page - 1) * per, page * per),
  });
}
/** The created ranges listed, in order, once per range. */
const ranges = (calls: Call[]) => [
  ...new Set(
    calls
      .map((c) => c.args.find((x) => x.includes("/actions/workflows/")) ?? "")
      .filter(Boolean)
      .map((p) =>
        new URLSearchParams(p.slice(p.indexOf("?") + 1)).get("created"),
      ),
  ),
];

type Call = { args: string[] };
type Comment = { user: string; body: string };
function fakeGh(o: {
  open?: { number: number; body: string }[];
  // The open list on the nth `issue list --label flaky` call.
  openAt?: (n: number) => { number: number; body: string }[];
  // Store issues and their comments; none means the first run in the repo.
  stores?: {
    number: number;
    state?: string;
    closedAt?: string;
    // The issue's comment count, when more than its comments listed here.
    count?: number;
    comments: Comment[];
  }[];
  assignable?: boolean;
  labels?: string[];
  pinFails?: boolean;
  jobs?: { name: string; log: string; conclusion?: string }[];
  // attempt 1's conclusion, and the run's head repository (a fork's or ours).
  attempt1?: string;
  headRepo?: string;
  // The runs API's runs, per workflow file, for the reconcile's listing.
  listed?: Record<string, Listed[]>;
}) {
  let lists = 0;
  const calls: Call[] = [];
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const jobs = o.jobs ?? [{ name: "t19", log: T19_LOG }];
  const labels = new Set(o.labels ?? []);
  const val = (args: string[], k: string) => args[args.indexOf(k) + 1] ?? "";
  const stores = o.stores ?? [];
  const exec: Exec = (_cmd, args) => {
    calls.push({ args });
    const a = args.join(" ");
    const head_repository = { full_name: o.headRepo ?? "o/cloud" };
    if (a.endsWith("/runs/900/attempts/2"))
      return ok(
        JSON.stringify({
          conclusion: "success",
          head_sha: "abc",
          head_repository,
        }),
      );
    if (a.endsWith("/runs/900/attempts/1"))
      return ok(
        JSON.stringify({
          conclusion: o.attempt1 ?? "failure",
          head_sha: "abc",
          head_repository,
        }),
      );
    if (a.includes("/attempts/1/jobs"))
      return ok(
        JSON.stringify({
          jobs: [
            {
              id: 1,
              name: "platform-tags",
              conclusion: "success",
              completed_at: null,
            },
            ...jobs.map((j, i) => ({
              id: 10 + i,
              name: j.name,
              conclusion: j.conclusion ?? "failure",
              completed_at: "2026-11-26T11:00:00.123Z",
            })),
          ],
        }),
      );
    const wf = /actions\/workflows\/([\w.-]+)\/runs\?/.exec(a);
    if (wf)
      return ok(listPage(o.listed?.[wf[1] as string] ?? [], args[1] ?? ""));
    const log = /actions\/jobs\/(\d+)\/logs/.exec(a);
    if (log) return ok(jobs[Number(log[1]) - 10]?.log ?? "");
    if (a.startsWith("label list")) {
      const name = args[args.indexOf("--search") + 1];
      // As gh does: no match prints nothing, not `[]`.
      return ok(labels.has(name ?? "") ? JSON.stringify([{ name }]) : "");
    }
    if (a.startsWith("issue list") && a.includes(`--label ${STORE_LABEL}`))
      return ok(
        JSON.stringify(
          stores.map((s) => ({
            number: s.number,
            state: s.state ?? "OPEN",
            closedAt: s.closedAt ?? null,
            body: STORE_BODY,
          })),
        ),
      );
    if (a.startsWith("issue list"))
      return ok(JSON.stringify(o.openAt?.(lists++) ?? o.open ?? []));
    const count = /issues\/(\d+) --jq \.comments$/.exec(a);
    if (count) {
      const st = stores.find((s) => s.number === Number(count[1]));
      return ok(`${st?.count ?? st?.comments.length ?? 0}\n`);
    }
    const cm = /issues\/(\d+)\/comments\?since=/.exec(a);
    if (cm)
      return ok(
        (stores.find((s) => s.number === Number(cm[1]))?.comments ?? [])
          .map((c) => `${JSON.stringify([c.user, c.body])}\n`)
          .join(""),
      );
    if (a.includes("contents/PUBLIC_PIN"))
      return o.pinFails
        ? { code: 1, stdout: "", stderr: "HTTP 404: Not Found" }
        : ok("tag=v0.246.0\nsha=cfb23586cd1e3b59c7db1ad287d70ce3b68f4a52\n");
    if (a.includes("/commits?path="))
      return ok(JSON.stringify([{ author: { login: "writer" } }]));
    if (a.includes("/assignees/"))
      return o.assignable
        ? ok("")
        : { code: 1, stdout: "", stderr: "HTTP 404" };
    if (a.startsWith("label create")) {
      labels.add(args[2] ?? "");
      return ok("");
    }
    // As GitHub does: an issue can't take a label the repo doesn't have.
    if (a.startsWith("issue create") && !labels.has(val(args, "--label")))
      return {
        code: 1,
        stdout: "",
        stderr: `could not add label: '${val(args, "--label")}' not found`,
      };
    if (a.startsWith("issue create") && a.includes(`--label ${STORE_LABEL}`))
      return ok("https://github.com/o/cloud/issues/77\n");
    if (/^issue (create|comment|edit|close)/.test(a)) return ok("");
    return { code: 1, stdout: "", stderr: `unexpected: ${a}` };
  };
  return { exec, calls };
}

const T19 = parsePlaywright(T19_LOG);
const joins = T19[0] as Failure;
const comments = T19[1] as Failure;
/** A store holding run 800's sighting of each test given. */
const storeWith = (...fs: Failure[]) => [
  {
    number: 3,
    comments: [
      {
        user: STORE_AUTHOR,
        body: storeComment({ ...run, runId: 800 }, [
          ...fs.map((x) => ({ f: x, sighting: s800 })),
        ]),
      },
    ],
  },
];
const LABELS = [LABEL, STORE_LABEL];
const bodyOf = (c: Call | undefined) =>
  c?.args[c.args.indexOf("--body") + 1] ?? "";
/** A reconcile's pending list (its own tests check it). */
const isPendingList = (c: Call) =>
  readMarkers(bodyOf(c))?.get("kind")?.[0] === "pending";
/** Every write but the reconcile's pending lists. */
const writes = (g: { calls: Call[] }) =>
  g.calls.filter(
    (c) =>
      ((c.args[0] === "issue" && c.args[1] !== "list") ||
        (c.args[0] === "label" && c.args[1] === "create")) &&
      !(c.args[1] === "comment" && isPendingList(c)),
  );
/** An open flaky issue's body: a line of text and the marker block. */
const openBody = (id: string, seen: string) =>
  `Some text.\n${markerBlock([
    ["kind", "test"],
    ["key", keyOf(id)],
    ["seen", seen],
  ])}`;

describe("track", () => {
  it("records a first sighting in a new store issue, and opens no flaky issue", () => {
    const g = fakeGh({});
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done.map((d) => d.action)).toEqual(["record", "record"]);
    const w = writes(g).map((c) => c.args.slice(0, 3).join(" "));
    expect(w).toEqual([
      `label create ${LABEL}`,
      `label create ${STORE_LABEL}`,
      "issue create --repo",
      "issue comment 77",
    ]);
    const stored = bodyOf(writes(g)[3]);
    expect(stored).toContain(sightingLine(keyOf(joins.id), s900));
    expect(stored).toContain(sightingLine(keyOf(comments.id), s900));
    expect(stored).toContain("/runs/900/attempts/1");
  });

  it("opens one issue per test at its second run, assigned to the file's last author at the pinned public sha", () => {
    const g = fakeGh({
      labels: LABELS,
      assignable: true,
      stores: storeWith(joins, comments),
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done.map((d) => d.action)).toEqual(["create", "create"]);
    const commits = g.calls.find((c) =>
      c.args.join(" ").includes("commits?path="),
    );
    expect(commits?.args.join(" ")).toContain(
      "repos/open-artifacts-ai/open-artifacts/commits?path=apps%2Fdashboard%2Fe2e%2Fstaging%2Frl-a%2Fjoins.spec.ts&sha=cfb23586cd1e3b59c7db1ad287d70ce3b68f4a52",
    );
    const creates = g.calls.filter(
      (c) => c.args[0] === "issue" && c.args[1] === "create",
    );
    expect(creates).toHaveLength(2);
    expect(creates[0]?.args).toEqual(
      expect.arrayContaining(["--label", LABEL, "--assignee", "writer"]),
    );
    expect(bodyOf(creates[0])).toContain("/runs/800/attempts/1");
    expect(bodyOf(creates[0])).toContain("/runs/900/attempts/1");
    // The store was written before the issues, on the open store issue.
    const comment = g.calls.findIndex((c) => c.args[1] === "comment");
    expect(g.calls[comment]?.args[2]).toBe("3");
    expect(comment).toBeLessThan(
      g.calls.findIndex((c) => c.args[1] === "create"),
    );
  });

  it("files only the test seen twice; the other is recorded", () => {
    const g = fakeGh({ labels: LABELS, stores: storeWith(comments) });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done).toEqual([
      { action: "record", id: joins.id },
      { action: "create", id: comments.id },
    ]);
  });

  it("adds nothing to the store when a rerun of the tracker finds this run there", () => {
    const stores = storeWith(joins, comments);
    stores[0]?.comments.push({
      user: STORE_AUTHOR,
      body: storeComment(run, [
        { f: joins, sighting: s900 },
        { f: comments, sighting: s900 },
      ]),
    });
    const open = [
      {
        number: 5,
        body: bodyWith([s800, s900]).replace(keyOf(f.id), keyOf(joins.id)),
      },
      {
        number: 6,
        body: bodyWith([s800, s900]).replace(keyOf(f.id), keyOf(comments.id)),
      },
    ];
    const g = fakeGh({ labels: LABELS, stores, open });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done.map((d) => d.action)).toEqual(["skip", "skip"]);
    expect(writes(g)).toEqual([]);
  });

  it("ignores sightings a person wrote into the store", () => {
    const stores = storeWith(joins);
    (stores[0]?.comments[0] as Comment).user = "someone";
    const g = fakeGh({ labels: LABELS, stores });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done.map((d) => d.action)).toEqual(["record", "record"]);
  });

  it("does not assign an owner GitHub refuses, and bumps an open issue with the new run", () => {
    const open = [
      {
        number: 5,
        body: openBody(joins.id, "2026-11-22T00:00:00Z 700/1"),
      },
    ];
    const g = fakeGh({
      open,
      labels: LABELS,
      assignable: false,
      stores: storeWith(joins, comments),
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done).toEqual([
      { action: "bump", id: joins.id, issue: 5 },
      { action: "create", id: comments.id },
    ]);
    const edit = g.calls.findIndex((c) => c.args[1] === "edit");
    const bump = g.calls.findIndex(
      (c) => c.args[1] === "comment" && c.args[2] === "5",
    );
    // The body first, so a rerun after a failed comment never comments twice.
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(edit).toBeLessThan(bump);
    expect(bodyOf(g.calls[bump])).toContain(TWICE_NOTE);
    expect(bodyOf(g.calls[bump])).toContain("/runs/900/attempts/1");
    expect(bodyOf(g.calls[bump])).toContain("/runs/800/attempts/1");
    expect(parseSeen(bodyOf(g.calls[edit])).map((s) => s.run)).toEqual([
      700, 800, 900,
    ]);
    const create = g.calls.find(
      (c) => c.args[1] === "create" && c.args.includes(LABEL),
    );
    expect(create?.args).not.toContain("--assignee");
  });

  it("still opens the issue when the owner lookup fails, and says why in a note", () => {
    const g = fakeGh({
      labels: LABELS,
      assignable: true,
      pinFails: true,
      stores: storeWith(joins, comments),
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done.map((d) => d.action)).toEqual(["create", "create"]);
    const creates = g.calls.filter((c) => c.args[1] === "create");
    expect(creates[0]?.args).not.toContain("--assignee");
    expect(bodyOf(creates[0])).toContain(
      "unknown (no commit found, or the lookup failed)",
    );
    expect(
      r.notes.some((n) => n.includes("owner of") && n.includes("HTTP 404")),
    ).toBe(true);
  });

  it("lists the open issues once: tracker runs are serialized", () => {
    const g = fakeGh({
      labels: LABELS,
      assignable: true,
      stores: storeWith(joins, comments),
    });
    track({ exec: g.exec, run, nowMs: NOW });
    const lists = g.calls.filter(
      (c) =>
        c.args[0] === "issue" && c.args[1] === "list" && c.args.includes(LABEL),
    );
    expect(lists).toHaveLength(1);
  });

  it("counts a timed-out attempt and job like a failed one", () => {
    const g = fakeGh({
      labels: LABELS,
      attempt1: "timed_out",
      jobs: [{ name: "t19", log: T19_LOG, conclusion: "timed_out" }],
      stores: storeWith(joins),
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done).toEqual([
      { action: "create", id: joins.id },
      { action: "record", id: comments.id },
    ]);
    const cancelled = fakeGh({
      labels: LABELS,
      attempt1: "cancelled",
      stores: storeWith(joins),
    });
    expect(track({ exec: cancelled.exec, run, nowMs: NOW }).done).toEqual([]);
  });

  it("counts a fork's CI run (a PR from another repo) like any other", () => {
    const vitest = parseVitest(CI_LOG)[2] as Failure;
    const o = {
      labels: LABELS,
      jobs: [{ name: "overlay (c)", log: CI_LOG }],
      stores: storeWith(vitest),
    };
    const fork = fakeGh({ ...o, headRepo: "someone/fork" });
    const ours = fakeGh(o);
    const r = track({ exec: fork.exec, run: ciRun, nowMs: NOW });
    expect(r).toEqual(track({ exec: ours.exec, run: ciRun, nowMs: NOW }));
    expect(r.done).toContainEqual({ action: "create", id: vitest.id });
    expect(writes(fork).map((c) => c.args)).toEqual(
      writes(ours).map((c) => c.args),
    );
  });

  it(`closes a store past ${MAX_STORE_COMMENTS} comments, opens a new one, and still reads the old`, () => {
    const stores = storeWith(joins);
    (stores[0] as { count?: number }).count = MAX_STORE_COMMENTS + 1;
    const g = fakeGh({ labels: LABELS, stores });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    const w = writes(g).map((c) => c.args.slice(0, 3).join(" "));
    expect(w).toEqual([
      "issue create --repo",
      "issue close 3",
      "issue comment 77",
      "issue create --repo",
      // The run is marked handled only after its filing.
      "issue comment 77",
    ]);
    const close = writes(g)[1] as Call;
    expect(close.args[close.args.indexOf("--comment") + 1]).toContain("#77");
    // Run 800's sighting in the old store still counts: joins is filed.
    expect(r.done).toEqual([
      { action: "create", id: joins.id },
      { action: "record", id: comments.id },
    ]);
    expect(r.notes).toContain(
      `store #3 had ${MAX_STORE_COMMENTS + 1} comments: closed, new store #77`,
    );
    // At the limit, the store stays.
    const at = storeWith(joins);
    (at[0] as { count?: number }).count = MAX_STORE_COMMENTS;
    const g2 = fakeGh({ labels: LABELS, stores: at });
    track({ exec: g2.exec, run, nowMs: NOW });
    expect(writes(g2).map((c) => c.args.slice(0, 3).join(" "))).toEqual([
      "issue comment 3",
      "issue create --repo",
      "issue comment 3",
    ]);
  });

  it("reads a closed store only while it closed within 7 days, and writes the newest open one", () => {
    const old = storeWith(joins);
    const g = fakeGh({
      labels: LABELS,
      stores: [
        {
          ...(old[0] as (typeof old)[0]),
          number: 2,
          state: "CLOSED",
          closedAt: "2026-11-25T00:00:00Z",
        },
        {
          number: 4,
          state: "CLOSED",
          closedAt: "2026-11-01T00:00:00Z",
          comments: [],
        },
        { number: 6, comments: [] },
      ],
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done[0]).toEqual({ action: "create", id: joins.id });
    const reads = g.calls
      .map((c) => /issues\/(\d+)\/comments\?since/.exec(c.args.join(" "))?.[1])
      .filter(Boolean);
    expect(reads).toEqual(["2", "6"]);
    expect(writes(g)[0]?.args.slice(0, 3)).toEqual(["issue", "comment", "6"]);
  });

  it("CI: reads vitest and e2e failures, and the owner is this repo's last author at the head sha", () => {
    const vitest = parseVitest(CI_LOG)[2] as Failure;
    const g = fakeGh({
      labels: LABELS,
      assignable: true,
      jobs: [
        { name: "overlay (c)", log: CI_LOG },
        { name: "e2e (admin)", log: E2E_LOG },
        { name: "lint", log: "##[error]Process completed with exit code 1." },
      ],
      stores: storeWith(vitest),
    });
    const r = track({ exec: g.exec, run: ciRun, nowMs: NOW });
    expect(r.done).toEqual([
      { action: "record", id: expect.stringContaining("surfaces.test.ts") },
      { action: "record", id: expect.stringContaining("broken.test.ts") },
      { action: "create", id: vitest.id },
      { action: "record", id: expect.stringContaining("hosted.test.ts") },
      {
        action: "record",
        id: "e2e:apps/admin/e2e/login.spec.ts:login › shows the form",
      },
    ]);
    expect(r.notes).toContain("attempt 1: job lint failed outside the tests");
    const commits = g.calls.find((c) =>
      c.args.join(" ").includes("commits?path="),
    );
    expect(commits?.args.join(" ")).toContain(
      `repos/o/cloud/commits?path=scripts%2Fci%2Fpin-bump.test.ts&sha=${SHA}`,
    );
    expect(g.calls.some((c) => c.args.join(" ").includes("PUBLIC_PIN"))).toBe(
      false,
    );
    const create = g.calls.find(
      (c) => c.args[1] === "create" && c.args.includes(LABEL),
    );
    expect(bodyOf(create)).toContain(`CI at ${SHA.slice(0, 7)}`);
  });
});

describe("the per-run cap", () => {
  const many = (n: number) =>
    [
      `  ${n} failed`,
      ...Array.from(
        { length: n },
        (_, i) =>
          `    [rl-a] › e2e/staging/rl-a/t${i}.spec.ts:1:1 › case ${i} @gate`,
      ),
    ].join("\n");

  const id = (i: number) =>
    `t19:e2e/staging/rl-a/t${i}.spec.ts:case ${i} @gate`;
  const ids = (n: number) => Array.from({ length: n }, (_, i) => id(i));
  /** A store holding run 800's sighting of the first `n` of the many tests. */
  const storeOf = (n: number) => [
    {
      number: 3,
      comments: [
        {
          user: STORE_AUTHOR,
          body: storeComment(
            { ...run, runId: 800 },
            parsePlaywright(many(n)).map((x) => ({ f: x, sighting: s800 })),
          ),
        },
      ],
    },
  ];

  it("never opens anything on a first sighting, however many tests failed", () => {
    const g = fakeGh({
      labels: LABELS,
      jobs: [{ name: "t19", log: many(50) }],
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done).toHaveLength(50);
    expect(r.done.every((d) => d.action === "record")).toBe(true);
    const w = writes(g).map((c) => c.args.slice(0, 3).join(" "));
    expect(w).toEqual(["issue create --repo", "issue comment 77"]);
    expect(
      parseStore([{ user: STORE_AUTHOR, body: bodyOf(writes(g)[1]) }]).size,
    ).toBe(50);
  });

  it(`files each test when ${MAX_ISSUES_PER_RUN} reach their second sighting`, () => {
    const g = fakeGh({
      labels: LABELS,
      jobs: [{ name: "t19", log: many(20) }],
      stores: storeOf(MAX_ISSUES_PER_RUN),
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done.filter((d) => d.action === "create")).toHaveLength(
      MAX_ISSUES_PER_RUN,
    );
    expect(r.done.filter((d) => d.action === "record")).toHaveLength(15);
    expect(r.done.some((d) => d.action === "summary")).toBe(false);
  });

  it(`past ${MAX_ISSUES_PER_RUN} to file: records every sighting first, then one summary in place of only the opens and bumps`, () => {
    const g = fakeGh({
      labels: LABELS,
      jobs: [{ name: "t19", log: many(50) }],
      stores: storeOf(7),
      open: [
        { number: 5, body: openBody(id(0), "2026-11-22T00:00:00Z 700/1") },
      ],
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(
      r.done.filter((d) => d.action === "record").map((d) => d.id),
    ).toEqual(ids(50).slice(7));
    expect(r.done.at(-1)).toEqual({ action: "summary", id: "summary:900" });
    expect(r.done).toHaveLength(44);
    const w = writes(g);
    expect(w.map((c) => c.args.slice(0, 3).join(" "))).toEqual([
      "issue comment 3",
      "issue create --repo",
      // The run is marked handled only after the summary is filed.
      "issue comment 3",
    ]);
    // The store got all 50 sightings of this run.
    const stored = parseStore([{ user: STORE_AUTHOR, body: bodyOf(w[0]) }]);
    expect(stored.size).toBe(50);
    const body = bodyOf(w[1]);
    expect(isSummaryOf(body, 900)).toBe(true);
    expect(body).toContain("7 tests that failed");
    expect(body).toContain("`case 6 @gate`");
    expect(body).not.toContain("`case 7 @gate`");
    expect(body).toContain(
      "/runs/800/attempts/1, https://github.com/o/cloud/actions/runs/900/attempts/1",
    );
    expect(w[1]?.args[w[1].args.indexOf("--title") + 1]).toContain(
      "7 tests failed twice",
    );
  });

  it("opens the summary once, when a rerun of the tracker finds it open", () => {
    const stores = storeOf(6);
    stores[0]?.comments.push({
      user: STORE_AUTHOR,
      body: storeComment(
        run,
        parsePlaywright(many(6)).map((x) => ({ f: x, sighting: s900 })),
      ),
    });
    const g = fakeGh({
      labels: LABELS,
      jobs: [{ name: "t19", log: many(6) }],
      stores,
      open: [
        {
          number: 11,
          body: `six tests\n${markerBlock([
            ["kind", "summary"],
            ["run", "900"],
          ])}`,
        },
      ],
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done.at(-1)).toEqual({
      action: "skip",
      id: "summary:900",
      issue: 11,
    });
    expect(writes(g)).toEqual([]);
  });

  it("never counts infra cases toward the cap or records them", () => {
    const log = [
      "Red-line report (staging): 9 cases",
      "Not pass:",
      ...Array.from(
        { length: 8 },
        (_, i) => `  [infra] bus > c${i} (no answer)`,
      ),
      "  [fail] guard > real (boom)",
      "Gate: FAIL",
    ].join("\n");
    const g = fakeGh({ labels: LABELS, jobs: [{ name: "redline", log }] });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done).toEqual([{ action: "record", id: "redline::guard > real" }]);
  });
});

describe("store comments stay under GitHub's limit", () => {
  // 300 failing tests with long titles: about 400 KB of store text.
  const rows = Array.from({ length: 300 }, (_, i) => ({
    f: {
      suite: "t19" as const,
      id: `t19:e2e/staging/rl-a/t${i}.spec.ts:case ${i} ${"x".repeat(1200)}`,
      title: `case ${i} ${"x".repeat(1200)}`,
      file: `e2e/staging/rl-a/t${i}.spec.ts`,
    },
    sighting: s900,
  }));

  it(`splits 300 failing tests into comments under ${COMMENT_MAX} characters, each read back whole`, () => {
    const cs = storeComments(run, rows);
    expect(cs.length).toBeGreaterThan(1);
    for (const [i, c] of cs.entries()) {
      expect(c.length).toBeLessThan(COMMENT_MAX);
      // Only the last part marks the run recorded (a failed later part is retried).
      expect(readMarkers(c)?.get("run")).toEqual(
        i === cs.length - 1 ? ["900/2"] : undefined,
      );
    }
    expect(
      storedRuns(cs.slice(0, -1).map((body) => ({ user: STORE_AUTHOR, body }))),
    ).toEqual(new Set());
    const back = parseStore(cs.map((body) => ({ user: STORE_AUTHOR, body })));
    expect(back.size).toBe(300);
    for (const x of rows) expect(back.get(keyOf(x.f.id))).toEqual([s900]);
    expect(
      storedRuns(cs.map((body) => ({ user: STORE_AUTHOR, body }))),
    ).toEqual(new Set(["900/2"]));
  });

  it("keeps one comment when it fits, the same text storeComment writes", () => {
    expect(storeComments(run, rows.slice(0, 2))).toEqual([
      storeComment(run, rows.slice(0, 2)),
    ]);
    expect(storeComments(run, [])).toEqual([]);
  });

  it("track writes every part to the store, each under the limit", () => {
    const log = [
      "  300 failed",
      ...rows.map((x) => `    [rl-a] › ${x.f.file}:1:1 › ${x.f.title}`),
    ].join("\n");
    const g = fakeGh({ labels: LABELS, jobs: [{ name: "t19", log }] });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done).toHaveLength(300);
    const parts = writes(g).filter((c) => c.args[1] === "comment");
    expect(parts.length).toBeGreaterThan(1);
    for (const c of parts) expect(bodyOf(c).length).toBeLessThan(COMMENT_MAX);
    const back = parseStore(
      parts.map((c) => ({ user: STORE_AUTHOR, body: bodyOf(c) })),
    );
    expect(back.size).toBe(300);
  });
});

describe("reconcile", () => {
  const gate: ListedRun = {
    id: 900,
    attempt: 2,
    name: "redline-staging",
    event: "workflow_dispatch",
    branch: "main",
    sha: SHA,
    title: "redline-staging v0.246.0",
  };
  const listed = { "redline-staging.yml": [row(gate)] };

  it("lists the watched workflows' recent runs with small reads", () => {
    const g = fakeGh({ listed: {} });
    const r = reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW });
    expect(r).toEqual({
      tracked: [],
      notes: [],
      failed: 0,
      left: 0,
      dropped: [],
    });
    const lists = g.calls.map((c) => c.args.join(" "));
    // Created in the last 60 days and 26 hours (a rerun up to 30 days after
    // creation, up to 30 quiet days after it, and 26 hours of slack); one
    // page each, as neither reaches 1,000 runs.
    expect(RERUN_DAYS).toBe(30);
    const range = encodeURIComponent(
      "2026-09-26T10:00:00Z..2026-11-26T12:00:00Z",
    );
    // The two listings, then the store's issue list (for its pending list).
    expect(lists).toHaveLength(3);
    expect(lists[2]).toMatch(/^issue list .*--label flaky-sightings/);
    for (const [i, file] of ["ci.yml", "redline-staging.yml"].entries()) {
      expect(lists[i]).toContain(
        `repos/o/cloud/actions/workflows/${file}/runs?status=success&exclude_pull_requests=true&created=${range}&per_page=100&page=1`,
      );
      expect(lists[i]).toContain("--jq");
      expect(lists[i]).toContain("total_count");
    }
    // Nothing to track: nothing written.
    expect(writes(g)).toEqual([]);
  });

  it("finds every run created in the range that passed on a rerun, however long ago it passed", () => {
    const ci: ListedRun = {
      ...gate,
      name: "CI",
      event: "pull_request",
      branch: "x",
    };
    const g = fakeGh({
      listed: {
        "ci.yml": [
          // Created 4 days ago, passed on attempt 3 two hours ago.
          row(
            { ...ci, id: 901, attempt: 3 },
            { created: 4 * DAY, updated: 2 * HOUR },
          ),
          // Created 25 days ago: still inside GitHub's 30-day rerun period.
          row({ ...ci, id: 902 }, { created: 25 * DAY, updated: 3 * HOUR }),
          // Created 61 days and 3 hours ago: past 60 days plus 26 hours.
          row(
            { ...ci, id: 903 },
            { created: 61 * DAY + 3 * HOUR, updated: 3 * HOUR },
          ),
          // Updated 27 hours ago: still listed, as no update window applies.
          row({ ...ci, id: 904 }, { created: 2 * DAY, updated: 27 * HOUR }),
          // Passed on its first attempt: nothing to track.
          row({ ...ci, id: 905, attempt: 1 }, { created: 2 * DAY }),
        ],
      },
    });
    expect(
      listRuns(g.exec, "o/cloud", "CI", NOW).map((r) => [r.id, r.attempt]),
    ).toEqual([
      [904, 2],
      [901, 3],
      [902, 2],
    ]);
  });

  it("finds a legal rerun that passed 29d 23h 55m after creation, scanned 10 minutes later", () => {
    const MIN = 60 * 1000;
    const late = {
      created: 10 * MIN + 29 * DAY + 23 * HOUR + 55 * MIN,
      updated: 10 * MIN,
    };
    const g = fakeGh({
      listed: { "ci.yml": [row({ ...gate, name: "CI", attempt: 3 }, late)] },
    });
    expect(
      listRuns(g.exec, "o/cloud", "CI", NOW).map((r) => [r.id, r.attempt]),
    ).toEqual([[900, 3]]);
    // Still found 25 hours later: its creation is still in the range.
    const later = NOW + 25 * HOUR;
    expect(listRuns(g.exec, "o/cloud", "CI", later).map((r) => r.id)).toEqual([
      900,
    ]);
  });

  it("counts a 25-day-old run's failure by its job's completion time, not the run's creation", () => {
    // Run 900 was created 25 days ago; attempt 1's job failed at
    // 2026-11-26T11:00:00Z and attempt 2 passed an hour ago. With run 800's
    // sighting two days earlier, that is twice in 7 days.
    const g = fakeGh({
      labels: LABELS,
      listed: { "redline-staging.yml": [row(gate, { created: 25 * DAY })] },
      stores: storeWith(joins),
    });
    const r = reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW });
    expect(r.failed).toBe(0);
    expect(r.tracked[0]?.done).toContainEqual({
      action: "create",
      id: joins.id,
    });
    const posted = writes(g).filter((c) => c.args[1] === "comment");
    expect(bodyOf(posted[0])).toContain(sightingLine(keyOf(joins.id), s900));
  });

  it("splits a range whose listing reaches 1,000 runs, so none is missed", () => {
    // 999 runs that passed first time in the last day, and the oldest one, a
    // rerun from 20 days ago: 1,000 in the range, GitHub's limit.
    const once = { ...gate, attempt: 1 };
    const g = fakeGh({
      listed: {
        "redline-staging.yml": [
          ...Array.from({ length: LIST_MAX - 1 }, (_, i) =>
            row({ ...once, id: 10_000 + i }, { created: HOUR + i * 60_000 }),
          ),
          row(gate, { created: 20 * DAY }),
        ],
      },
    });
    expect(
      listRuns(g.exec, "o/cloud", "redline-staging", NOW).map((r) => r.id),
    ).toEqual([900]);
    expect(ranges(g.calls)).toEqual([
      "2026-09-26T10:00:00Z..2026-11-26T12:00:00Z",
      "2026-09-26T10:00:00Z..2026-10-26T23:00:00Z",
      "2026-10-26T23:00:01Z..2026-11-26T12:00:00Z",
      "2026-10-26T23:00:01Z..2026-11-11T05:30:00Z",
      "2026-11-11T05:30:01Z..2026-11-26T12:00:00Z",
    ]);
  });

  it("finds the oldest of 1,145 runs, past the 1,000 one listing returns", () => {
    // As public CI had for 9 to 15 November: one query reaches only the
    // newest 1,000.
    const once = { ...gate, attempt: 1 };
    const g = fakeGh({
      listed: {
        "redline-staging.yml": [
          ...Array.from({ length: 1144 }, (_, i) =>
            row(
              { ...once, id: 10_000 + i },
              { created: 2 * DAY + i * 300_000 },
            ),
          ),
          row({ ...gate, attempt: 3 }, { created: 8 * DAY, updated: 2 * HOUR }),
        ],
      },
    });
    expect(
      listRuns(g.exec, "o/cloud", "redline-staging", NOW).map((r) => [
        r.id,
        r.attempt,
      ]),
    ).toEqual([[900, 3]]);
    expect(ranges(g.calls).length).toBeGreaterThan(1);
  });

  it("fails loudly when one second holds 1,000 runs", () => {
    const g = fakeGh({
      listed: {
        "ci.yml": Array.from({ length: LIST_MAX }, (_, i) =>
          row({ ...gate, id: 10_000 + i }, { created: 5 * DAY }),
        ),
      },
    });
    const at = iso(NOW - 5 * DAY);
    expect(() => listRuns(g.exec, "o/cloud", "CI", NOW)).toThrow(
      `1000 runs created at ${at}: GitHub lists at most 1000 for one query`,
    );
    expect(() =>
      reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW }),
    ).toThrow(/1000 runs created at/);
  });

  it("records a run the tracker missed, with the same code as the event", () => {
    const g = fakeGh({ labels: LABELS, listed, stores: storeWith(joins) });
    const r = reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW });
    expect(r.failed).toBe(0);
    expect(r.tracked.map((t) => t.run)).toEqual([run]);
    expect(r.tracked[0]?.done).toEqual([
      { action: "create", id: joins.id },
      { action: "record", id: comments.id },
    ]);
    const posted = writes(g).filter((c) => c.args[1] === "comment");
    const stored = bodyOf(posted[0]);
    expect(stored).toContain(sightingLine(keyOf(joins.id), s900));
    expect(stored).toContain(sightingLine(keyOf(comments.id), s900));
    // The sightings come first, unmarked; the run is marked only after filing.
    expect(readMarkers(stored)?.get("run")).toBeUndefined();
    expect(readMarkers(bodyOf(posted.at(-1)))?.get("run")).toEqual(["900/2"]);
  });

  it("finds a release gate by its workflow, whatever its run-name says", () => {
    // The runs API's .name is the run-name, as on live run 45546499448.
    const named = { ...gate, name: "redline-staging v0.246.0" };
    const g = fakeGh({
      labels: LABELS,
      listed: { "redline-staging.yml": [row(named)] },
      stores: storeWith(joins),
    });
    const r = reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW });
    expect(r.tracked.map((t) => t.run.runId)).toEqual([900]);
  });

  it("a failed create leaves the run unmarked, so the next reconcile files it", () => {
    const g = fakeGh({ labels: LABELS, listed, stores: storeWith(joins) });
    const failing: Exec = (cmd, args) =>
      args[0] === "issue" && args[1] === "create"
        ? { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" }
        : g.exec(cmd, args);
    const r = reconcile({ exec: failing, repo: "o/cloud", nowMs: NOW });
    expect(r.failed).toBe(1);
    const posted = writes(g)
      .filter((c) => c.args[1] === "comment")
      .map((c) => ({ user: STORE_AUTHOR, body: bodyOf(c) }));
    // The sightings are stored, but the run is not marked recorded.
    expect(posted.length).toBeGreaterThan(0);
    expect(storedRuns(posted).has("900/2")).toBe(false);
  });

  it("tracks a run whose event was dropped when the next completion comes 3 days later", () => {
    // Gate run 900 passed on attempt 2 three days ago; its tracker event was
    // dropped and nothing completed since. Run 800 was marked 20 days ago, past
    // the 7-day window: its mark still hides it.
    const old = { ...gate, id: 800 };
    const stores = [
      {
        number: 3,
        comments: [
          {
            user: STORE_AUTHOR,
            body: storeComment({ ...run, runId: 800 }, [
              { f: joins, sighting: { ...s800, at: "2026-11-06T10:00:00Z" } },
            ]),
          },
        ],
      },
    ];
    const g = fakeGh({
      labels: LABELS,
      listed: {
        "redline-staging.yml": [
          row(old, { created: 21 * DAY, updated: 20 * DAY }),
          row(gate, { created: 4 * DAY, updated: 72 * HOUR }),
        ],
      },
      stores,
    });
    const r = reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW });
    expect(r.failed).toBe(0);
    expect(r.notes).toEqual(["run 800/2: in the store already"]);
    expect(r.tracked.map((t) => t.run.runId)).toEqual([900]);
    expect(r.tracked[0]?.done.map((d) => d.action)).toEqual([
      "record",
      "record",
    ]);
    // The reconcile read the store from the start of the whole range.
    const since = encodeURIComponent("2026-09-26T10:00:00.000Z");
    expect(
      g.calls.some((c) =>
        c.args.join(" ").includes(`issues/3/comments?since=${since}&`),
      ),
    ).toBe(true);
  });

  it("tracks a rerun on day 29 followed by 3 quiet days", () => {
    // Gate run 900 was created 32 days 23 hours ago; attempt 1 failed and
    // attempt 2 passed 29 days 23 hours after creation (inside GitHub's rerun
    // period). Its event was dropped and nothing completed for 3 days.
    const g = fakeGh({
      labels: LABELS,
      listed: {
        "redline-staging.yml": [
          row(gate, { created: 32 * DAY + 23 * HOUR, updated: 3 * DAY }),
        ],
      },
      stores: [{ number: 3, comments: [] }],
    });
    const r = reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW });
    expect(r.failed).toBe(0);
    expect(r.tracked.map((t) => t.run.runId)).toEqual([900]);
    expect(r.tracked[0]?.done.map((d) => d.action)).toEqual([
      "record",
      "record",
    ]);
  });

  it(`keeps a rerun on the last allowed day listed through ${QUIET_DAYS} days with no event`, () => {
    const g = fakeGh({
      listed: {
        "redline-staging.yml": [
          row(gate, {
            created: (RERUN_DAYS + QUIET_DAYS) * DAY,
            updated: QUIET_DAYS * DAY,
          }),
        ],
      },
    });
    expect(
      listRuns(g.exec, "o/cloud", "redline-staging", NOW).map((r) => r.id),
    ).toEqual([900]);
  });

  it("marks a run with no failed test, so later reconciles skip it", () => {
    // Attempt 1 failed only outside the tests: nothing to record.
    const g = fakeGh({
      labels: LABELS,
      listed: {
        "redline-staging.yml": [
          row(gate, { created: 3 * DAY, updated: 2 * DAY }),
        ],
      },
      jobs: [
        {
          name: "bring-up",
          log: "##[error]Process completed with exit code 1.",
        },
      ],
      stores: [{ number: 3, comments: [] }],
    });
    const r = reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW });
    expect(r.failed).toBe(0);
    expect(r.tracked[0]?.done).toEqual([]);
    const w = writes(g);
    expect(w.map((c) => c.args.slice(0, 3))).toEqual([
      ["issue", "comment", "3"],
    ]);
    const mark = bodyOf(w[0]);
    expect(storedRuns([{ user: STORE_AUTHOR, body: mark }])).toEqual(
      new Set(["900/2"]),
    );
    // With that comment in the store, the next reconcile, 5 days on, reads
    // nothing of the run and writes nothing.
    const again = fakeGh({
      labels: LABELS,
      listed: {
        "redline-staging.yml": [
          row(gate, { created: 3 * DAY, updated: 2 * DAY }),
        ],
      },
      stores: [{ number: 3, comments: [{ user: STORE_AUTHOR, body: mark }] }],
    });
    const r2 = reconcile({
      exec: again.exec,
      repo: "o/cloud",
      nowMs: NOW + 5 * DAY,
    });
    expect(r2.notes).toEqual(["run 900/2: in the store already"]);
    expect(writes(again)).toEqual([]);
    expect(
      again.calls.some((c) => c.args.join(" ").includes("/runs/900")),
    ).toBe(false);
  });

  it("reads a store closed 20 days ago for its marks", () => {
    const stores = [
      {
        number: 2,
        state: "CLOSED",
        closedAt: "2026-11-06T00:00:00Z",
        comments: [
          {
            user: STORE_AUTHOR,
            body: storeComment(run, [{ f: joins, sighting: s900 }]),
          },
        ],
      },
      { number: 4, comments: [] },
    ];
    const g = fakeGh({
      labels: LABELS,
      listed: {
        "redline-staging.yml": [
          row(gate, { created: 22 * DAY, updated: 21 * DAY }),
        ],
      },
      stores,
    });
    const r = reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW });
    expect(r.tracked).toEqual([]);
    expect(r.notes).toEqual(["run 900/2: in the store already"]);
    expect(writes(g)).toEqual([]);
  });

  it("is a no-op for a run already in the store: adds nothing, bumps nothing", () => {
    const stores = storeWith(joins);
    stores[0]?.comments.push({
      user: STORE_AUTHOR,
      body: storeComment(run, [{ f: joins, sighting: s900 }]),
    });
    // Its test's issue is open without run 900: a re-track would bump it.
    const open = [
      { number: 5, body: openBody(joins.id, "2026-11-24T10:00:00Z 800/1") },
    ];
    const g = fakeGh({ labels: LABELS, listed, stores, open });
    const r = reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW });
    expect(r.tracked).toEqual([]);
    expect(r.notes).toEqual(["run 900/2: in the store already"]);
    expect(writes(g)).toEqual([]);
    // It never read the run's attempts or logs.
    expect(g.calls.some((c) => c.args.join(" ").includes("/runs/900"))).toBe(
      false,
    );
  });

  it("does not count a person's comment that claims the run", () => {
    const g = fakeGh({
      labels: LABELS,
      listed,
      stores: [
        {
          number: 3,
          comments: [
            {
              user: "someone",
              body: storeComment(run, [{ f: joins, sighting: s900 }]),
            },
          ],
        },
      ],
    });
    const r = reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW });
    expect(r.tracked).toHaveLength(1);
  });

  it("keeps the event's rules: attempt 2 or later, a release gate only when dispatched on main", () => {
    expect(eligible(gate)).toBe(true);
    expect(
      eligible({ ...gate, name: "CI", event: "pull_request", branch: "x" }),
    ).toBe(true);
    expect(eligible({ ...gate, attempt: 1 })).toBe(false);
    expect(eligible({ ...gate, event: "workflow_call" })).toBe(false);
    expect(eligible({ ...gate, event: "schedule" })).toBe(false);
    expect(eligible({ ...gate, branch: "feature" })).toBe(false);
    expect(eligible({ ...gate, name: "other" })).toBe(false);
    const g = fakeGh({
      labels: LABELS,
      listed: { "redline-staging.yml": [row({ ...gate, attempt: 1 })] },
    });
    expect(
      reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW }).tracked,
    ).toEqual([]);
    // The two listings and the store's issue list: nothing else is read.
    expect(g.calls).toHaveLength(3);
  });

  it("tracks a fork's run it lists, whatever its head repository", () => {
    // The listing no longer reads the head repository at all.
    const fork = { ...gate, name: "CI", event: "pull_request", branch: "x" };
    const g = fakeGh({
      labels: LABELS,
      headRepo: "someone/fork",
      listed: { "ci.yml": [row(fork)] },
      stores: storeWith(joins),
    });
    const r = reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW });
    expect(r.failed).toBe(0);
    expect(r.tracked.map((t) => t.run.runId)).toEqual([900]);
    const list = g.calls.find((c) =>
      c.args.join(" ").includes("/workflows/ci.yml/runs"),
    );
    expect(list?.args.join(" ")).not.toContain("head_repository");
  });

  it("goes on past a run that fails to track, and counts it", () => {
    const g = fakeGh({
      labels: LABELS,
      listed: {
        "redline-staging.yml": [
          row({ ...gate, id: 901, title: "no tag" }),
          row(gate),
        ],
      },
    });
    const r = reconcile({ exec: g.exec, repo: "o/cloud", nowMs: NOW });
    expect(r.failed).toBe(1);
    expect(r.notes).toEqual([
      "run 901/2: the run's title names no release tag",
    ]);
    expect(r.tracked.map((t) => t.run.runId)).toEqual([900]);
  });
});

describe("runFromArgs", () => {
  const base = ["--repo", "o/cloud", "--run-id", "900", "--attempt", "2"];
  it("takes the tag from a release gate's title and the head sha for CI", () => {
    expect(
      runFromArgs([
        ...base,
        "--workflow",
        "redline-staging",
        "--title",
        "redline-staging v0.246.0",
        "--head-sha",
        SHA,
      ]).ref,
    ).toBe("v0.246.0");
    expect(
      runFromArgs([
        ...base,
        "--workflow",
        "CI",
        "--title",
        "any PR title $(x)",
        "--head-sha",
        SHA,
      ]),
    ).toEqual(ciRun);
  });
  it("refuses another workflow, a bad sha, or attempt 1", () => {
    expect(() =>
      runFromArgs([...base, "--workflow", "deploy", "--head-sha", SHA]),
    ).toThrow("bad --workflow");
    expect(() =>
      runFromArgs([...base, "--workflow", "CI", "--head-sha", "main"]),
    ).toThrow("bad --head-sha");
    expect(() =>
      runFromArgs([
        "--repo",
        "o/cloud",
        "--run-id",
        "900",
        "--attempt",
        "1",
        "--workflow",
        "CI",
        "--head-sha",
        SHA,
      ]),
    ).toThrow("bad --attempt");
  });
});

describe("cloud-flaky-tracker.yml", () => {
  const wf = parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../.github/workflows/cloud-flaky-tracker.yml",
      ),
      "utf8",
    ),
  );

  it("runs after every CI and redline-staging completion and on dispatch, never on a clock", () => {
    // cloud #264: event-only. The reconcile rides on each completion, so a
    // dropped tracker event is caught by the next CI completion.
    expect(wf.on).toEqual({
      workflow_run: {
        workflows: ["CI", "redline-staging"],
        types: ["completed"],
      },
      workflow_dispatch: null,
    });
    expect(wf.on.schedule).toBeUndefined();
    expect(wf.permissions).toEqual({});
    const cond = String(wf.jobs.track.if).replace(/\s+/g, " ").trim();
    expect(cond).toBe(
      "github.repository == 'open-artifacts-ai/open-artifacts-cloud' && github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion != 'cancelled' && github.event.workflow_run.conclusion != 'skipped'))",
    );
  });

  it("records the event's run only when it passed on a later attempt, then reconciles on every run", () => {
    const steps = wf.jobs.track.steps as {
      name?: string;
      if?: string;
      run?: string;
    }[];
    const record = steps.find((s) => s.name === "Record the flaky tests");
    const recon = steps.find(
      (s) => s.name === "Reconcile runs the tracker missed",
    );
    expect(String(record?.if).replace(/\s+/g, " ").trim()).toBe(
      "github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.run_attempt > 1 && (github.event.workflow_run.path == '.github/workflows/ci.yml' || (github.event.workflow_run.path == '.github/workflows/redline-staging.yml' && github.event.workflow_run.event == 'workflow_dispatch' && github.event.workflow_run.head_branch == 'main'))",
    );
    // No condition: it runs whenever the job does, after the record step.
    expect(recon?.if).toBeUndefined();
    expect(steps.indexOf(recon as (typeof steps)[number])).toBe(
      steps.indexOf(record as (typeof steps)[number]) + 1,
    );
    expect(recon?.run).toBe(
      'node --experimental-strip-types scripts/ci/cloud-flaky-tracker.ts --repo "$GITHUB_REPOSITORY" --reconcile',
    );
  });

  it("serializes tracker runs per repo: one group with no per-run part, never cancelled, every pending run kept", () => {
    // On the job, so a skipped run joins no group; the only job, so it is the
    // whole workflow's group.
    expect(Object.keys(wf.jobs)).toEqual(["track"]);
    expect(wf.concurrency).toBeUndefined();
    expect(wf.jobs.track.concurrency).toEqual({
      group: "flaky-tracker",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(String(wf.jobs.track.concurrency.group)).not.toContain("${{");
  });

  it("counts a fork's run but runs only this repo's code: the default branch, scripts/ci, no kept token", () => {
    expect(String(wf.jobs.track.if)).not.toContain("head_repository");
    const steps = wf.jobs.track.steps as {
      uses?: string;
      with?: Record<string, unknown>;
    }[];
    const checkouts = steps.filter((s) =>
      s.uses?.startsWith("actions/checkout@"),
    );
    expect(checkouts).toEqual([
      {
        uses: expect.any(String),
        with: {
          ref: "${{ github.sha }}",
          "sparse-checkout": "scripts/ci",
          "persist-credentials": false,
        },
      },
    ]);
  });

  it("uses the default token with read, read and issues, no secret, SHA-pinned actions, and values only through env", () => {
    const job = wf.jobs.track;
    expect(job.permissions).toEqual({
      actions: "read",
      contents: "read",
      issues: "write",
    });
    expect(job.environment).toBeUndefined();
    const text = JSON.stringify(job);
    expect(text).not.toContain("secrets.");
    for (const s of job.steps as { uses?: string; run?: string }[]) {
      if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
      if (s.run) expect(s.run).not.toContain("${{");
    }
  });
});

describe("the event path names the workflow by its file", () => {
  // workflow_run.name is the run-name: "redline-staging v0.247.0" (live run
  // 45740398112), so a name check would never match a release gate.
  const text = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../.github/workflows/cloud-flaky-tracker.yml",
    ),
    "utf8",
  );
  it("never reads workflow_run.name", () => {
    // Only in comments: no expression or condition reads it.
    expect(text).not.toMatch(
      /\$\{\{[^}]*workflow_run\.name|workflow_run\.name ==/,
    );
    expect(text).toContain(
      "WORKFLOW_PATH: ${{ github.event.workflow_run.path }}",
    );
    expect(text).toContain(
      ".github/workflows/redline-staging.yml) WORKFLOW=redline-staging ;;",
    );
    expect(text).toContain(".github/workflows/ci.yml) WORKFLOW=CI ;;");
  });
});

/**
 * A fake GitHub that keeps state: store and flaky issues are created, comments
 * written, bodies edited. Each comment is stamped with the fake clock, and a
 * comments read honors `since` as GitHub does (by update time). Any run id has
 * a failed attempt 1 and a passing attempt 2; its failed job completed at
 * jobAt[run].
 */
function liveGh(o: {
  listed: Record<string, Listed[]>;
  jobAt: Record<number, number>;
  log: string;
}) {
  const clock = { now: NOW };
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const labels = new Set<string>();
  const stores: { number: number; comments: (Comment & { at: number })[] }[] =
    [];
  const flaky: { number: number; title: string; body: string }[] = [];
  let next = 50;
  const val = (args: string[], k: string) => args[args.indexOf(k) + 1] ?? "";
  const exec: Exec = (_cmd, args) => {
    const a = args.join(" ");
    const att = /\/runs\/(\d+)\/attempts\/(\d+)$/.exec(a);
    if (att)
      return ok(
        JSON.stringify({
          conclusion: att[2] === "1" ? "failure" : "success",
          head_sha: SHA,
          head_repository: { full_name: "o/cloud" },
        }),
      );
    const jobs = /\/runs\/(\d+)\/attempts\/1\/jobs/.exec(a);
    if (jobs)
      return ok(
        JSON.stringify({
          jobs: [
            {
              id: 10,
              name: "overlay (c)",
              conclusion: "failure",
              completed_at: new Date(
                o.jobAt[Number(jobs[1])] ?? NaN,
              ).toISOString(),
            },
          ],
        }),
      );
    const wf = /actions\/workflows\/([\w.-]+)\/runs\?/.exec(a);
    if (wf) return ok(listPage(o.listed[wf[1] as string] ?? [], args[1] ?? ""));
    const one = /actions\/runs\/(\d+) --jq/.exec(a);
    if (one) {
      for (const [file, rows] of Object.entries(o.listed)) {
        const x = rows.find((r) => r.id === Number(one[1]));
        if (x)
          return ok(
            JSON.stringify({
              path: `.github/workflows/${file}`,
              run_attempt: x.run_attempt,
              conclusion: x.conclusion,
              event: x.event,
              head_branch: x.head_branch,
              head_sha: x.head_sha,
              display_title: x.display_title,
            }),
          );
      }
      return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    }
    if (/actions\/jobs\/10\/logs/.test(a)) return ok(o.log);
    if (a.startsWith("label list")) {
      const name = val(args, "--search");
      // As gh does: no match prints nothing, not `[]`.
      return ok(labels.has(name) ? JSON.stringify([{ name }]) : "");
    }
    if (a.startsWith("label create")) {
      labels.add(args[2] ?? "");
      return ok("");
    }
    if (a.startsWith("issue list") && a.includes(`--label ${STORE_LABEL}`))
      return ok(
        JSON.stringify(
          stores.map((s) => ({
            number: s.number,
            state: "OPEN",
            closedAt: null,
            body: STORE_BODY,
          })),
        ),
      );
    if (a.startsWith("issue list"))
      return ok(
        JSON.stringify(flaky.map(({ number, body }) => ({ number, body }))),
      );
    const count = /issues\/(\d+) --jq \.comments$/.exec(a);
    if (count)
      return ok(
        `${stores.find((s) => s.number === Number(count[1]))?.comments.length ?? 0}\n`,
      );
    const cm = /issues\/(\d+)\/comments\?since=([^&]+)&/.exec(a);
    if (cm) {
      const since = Date.parse(decodeURIComponent(cm[2] as string));
      return ok(
        (stores.find((s) => s.number === Number(cm[1]))?.comments ?? [])
          .filter((c) => c.at >= since)
          .map((c) => `${JSON.stringify([c.user, c.body])}\n`)
          .join(""),
      );
    }
    if (a.includes("/commits?path="))
      return ok(JSON.stringify([{ author: { login: "writer" } }]));
    if (a.includes("/assignees/")) return ok("");
    if (a.startsWith("issue create") && !labels.has(val(args, "--label")))
      return {
        code: 1,
        stdout: "",
        stderr: `could not add label: '${val(args, "--label")}' not found`,
      };
    if (a.startsWith("issue create")) {
      const n = next++;
      if (val(args, "--label") === STORE_LABEL) {
        stores.push({ number: n, comments: [] });
        return ok(`https://github.com/o/cloud/issues/${n}\n`);
      }
      flaky.push({
        number: n,
        title: val(args, "--title"),
        body: val(args, "--body"),
      });
      return ok("");
    }
    if (a.startsWith("issue comment")) {
      const n = Number(args[2]);
      const body = val(args, "--body");
      const st = stores.find((s) => s.number === n);
      if (st) st.comments.push({ user: STORE_AUTHOR, body, at: clock.now });
      else {
        const i = flaky.find((x) => x.number === n);
        if (!i) return { code: 1, stdout: "", stderr: "HTTP 404" };
      }
      return ok("");
    }
    if (a.startsWith("issue edit")) {
      const i = flaky.find((x) => x.number === Number(args[2]));
      if (i) i.body = val(args, "--body");
      return ok("");
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${a}` };
  };
  /** Everything written, comparable across replays (no clock stamps). */
  const state = () => ({
    stores: stores.map((s) => ({
      number: s.number,
      comments: s.comments.map(({ user, body }) => ({ user, body })),
    })),
    flaky: flaky.map((i) => ({ ...i })),
  });
  return { exec, clock, state };
}

describe("a late replay files like an immediate one", () => {
  // The same tests failed in CI run 800 (Nov 18) and run 801 six days later
  // (Nov 24). Then no event for 49 hours. Fake clocks only.
  const A = Date.parse("2026-11-18T10:00:00Z");
  const B = A + 6 * DAY;
  const LATE = B + 49 * HOUR;
  const tests = parseVitest(CI_LOG);
  const ci = (id: number, at: number): Listed => ({
    id,
    run_attempt: 2,
    conclusion: "success",
    created_at: iso(at - HOUR),
    updated_at: iso(at + 10 * 60 * 1000),
    name: "CI",
    event: "push",
    head_branch: "main",
    head_sha: SHA,
    display_title: "a commit",
  });
  const make = (bAt = B) =>
    liveGh({
      listed: { "ci.yml": [ci(800, A), ci(801, bAt)] },
      jobAt: { 800: A, 801: bAt },
      log: CI_LOG,
    });
  const runOf = (runId: number): RunInfo => ({
    repo: "o/cloud",
    workflow: "CI",
    runId,
    attempt: 2,
    ref: SHA,
    url: `https://github.com/o/cloud/actions/runs/${runId}`,
  });
  const reconcileAt = (g: ReturnType<typeof make>, ms: number) => {
    g.clock.now = ms;
    return reconcile({ exec: g.exec, repo: "o/cloud", nowMs: ms });
  };
  const trackAt = (g: ReturnType<typeof make>, id: number, ms: number) => {
    g.clock.now = ms;
    return track({ exec: g.exec, run: runOf(id), nowMs: ms });
  };

  /** Both events dropped; the next CI completion comes an hour after run 801. */
  const immediate = () => {
    const g = make();
    return { g, r: reconcileAt(g, B + HOUR) };
  };
  /** Both events dropped; the next CI completion comes 49 hours after run 801. */
  const delayed = () => {
    const g = make();
    return { g, r: reconcileAt(g, LATE) };
  };
  /** Run 800 tracked by its event; run 801's event dropped; 49 hours quiet. */
  const halfLate = () => {
    const g = make();
    expect(trackAt(g, 800, A + HOUR).done.map((d) => d.action)).toEqual(
      tests.map(() => "record"),
    );
    reconcileAt(g, A + HOUR);
    return { g, r: reconcileAt(g, LATE) };
  };

  it("has a few tests to file, each its own issue", () => {
    expect(tests.length).toBeGreaterThan(1);
    expect(tests.length).toBeLessThanOrEqual(MAX_ISSUES_PER_RUN);
  });

  for (const [name, replay] of [
    ["an immediate replay", immediate],
    ["a replay 49 hours late", delayed],
    ["a replay 49 hours late of a run whose sighting is 8 days old", halfLate],
  ] as const)
    it(`${name} files the second run, with both run links`, () => {
      const { g, r } = replay();
      const last = r.tracked.at(-1);
      expect(last?.run.runId).toBe(801);
      expect(last?.done.map((d) => d.action)).toEqual(
        tests.map(() => "create"),
      );
      const issues = g.state().flaky;
      expect(issues).toHaveLength(tests.length);
      for (const i of issues) {
        expect(parseSeen(i.body)).toEqual([
          { at: iso(A), run: 800, attempt: 1 },
          { at: iso(B), run: 801, attempt: 1 },
        ]);
        expect(i.body).toContain(`Seen in 2 runs; ${TWICE_NOTE}.`);
      }
    });

  it("an immediate and a late replay leave the same store and issues", () => {
    const now = immediate().g;
    const late = delayed().g;
    const half = halfLate().g;
    // The store and issues, but for the reconciles' pending lists (written
    // at each one's own time).
    const kept = (g: ReturnType<typeof make>) => {
      const st = g.state();
      return {
        ...st,
        stores: st.stores.map((x) => ({
          ...x,
          comments: x.comments.filter(
            (c) => readMarkers(c.body)?.get("kind")?.[0] !== "pending",
          ),
        })),
      };
    };
    expect(kept(late)).toEqual(kept(now));
    expect(kept(half)).toEqual(kept(now));
    // Delivered again, nothing more is written.
    for (const g of [now, late, half]) {
      const before = JSON.stringify(g.state());
      const r = reconcileAt(g, LATE + HOUR);
      expect(r.tracked).toEqual([]);
      expect(trackAt(g, 801, LATE + HOUR).done.map((d) => d.action)).toEqual(
        tests.map(() => "skip"),
      );
      expect(JSON.stringify(g.state())).toBe(before);
    }
  });

  it("files a pair tracked out of order: the older run's event comes last", () => {
    const g = make();
    expect(trackAt(g, 801, B + HOUR).done.map((d) => d.action)).toEqual(
      tests.map(() => "record"),
    );
    expect(trackAt(g, 800, LATE).done.map((d) => d.action)).toEqual(
      tests.map(() => "create"),
    );
  });

  it("still never pairs failures more than 7 days apart", () => {
    const far = A + 7 * DAY + 1000;
    const g = make(far);
    const r = reconcileAt(g, far + HOUR);
    expect(r.tracked.flatMap((t) => t.done.map((d) => d.action))).toEqual(
      [...tests, ...tests].map(() => "record"),
    );
    expect(g.state().flaky).toEqual([]);
  });
});

describe("a backlog larger than one reconcile drains over the next events", () => {
  // Twelve CI runs passed on a rerun, their failures 4 days apart, and no
  // event tracked any of them. Each run reads 1 job log.
  const ids = Array.from({ length: 12 }, (_, i) => 1000 + i);
  const start = Date.parse("2026-11-01T10:00:00Z");
  const ci = (id: number, at: number): Listed => ({
    id,
    run_attempt: 2,
    conclusion: "success",
    created_at: iso(at - HOUR),
    updated_at: iso(at + 10 * 60 * 1000),
    name: "CI",
    event: "push",
    head_branch: "main",
    head_sha: SHA,
    display_title: "a commit",
  });
  const make = () =>
    liveGh({
      listed: { "ci.yml": ids.map((id, i) => ci(id, start + i * 4 * DAY)) },
      jobAt: Object.fromEntries(ids.map((id, i) => [id, start + i * 4 * DAY])),
      log: CI_LOG,
    });
  const later = start + 12 * 4 * DAY;
  const marks = (g: ReturnType<typeof make>) =>
    g
      .state()
      .stores.flatMap((st) => [...storedRuns(st.comments)])
      .sort();
  const sightingRuns = (g: ReturnType<typeof make>) =>
    [...parseStore(g.state().stores.flatMap((st) => st.comments)).values()]
      .flat()
      .map((x) => x.run);
  const tests = parseVitest(CI_LOG).length;
  const reconcileAt = (
    g: ReturnType<typeof make>,
    ms: number,
    o: { logs?: number; calls?: number } = {},
  ) => {
    g.clock.now = ms;
    return reconcile({ exec: g.exec, repo: "o/cloud", nowMs: ms, ...o });
  };

  it("caps one reconcile well inside the job's limit", () => {
    expect(RECONCILE_MS).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(RECONCILE_CALLS).toBeLessThanOrEqual(150);
    expect(RECONCILE_LOGS).toBeLessThanOrEqual(25);
  });

  it("stops starting runs once its log budget is spent, oldest first, and says how many are left", () => {
    const g = make();
    const r = reconcileAt(g, later, { logs: 5 });
    expect(r.tracked.map((t) => t.run.runId)).toEqual(ids.slice(0, 5));
    expect(r.left).toBe(7);
    expect(backlogLine(r.left, r.failed)).toBe(
      "backlog: 7 new, 0 to retry (the next completion's reconcile carries on)",
    );
    expect(marks(g)).toEqual(ids.slice(0, 5).map((id) => `${id}/2`));
  });

  it("stops on its call budget too, but always starts one run", () => {
    const g = make();
    const r = reconcileAt(g, later, { calls: 1 });
    expect(r.tracked).toHaveLength(1);
    expect(r.left).toBe(11);
  });

  it("stops on its time budget, on a fake clock: each gh call takes 2 s", () => {
    const g = make();
    let t = 0;
    const slow: Exec = (cmd, args) => {
      t += 2000;
      return g.exec(cmd, args);
    };
    g.clock.now = later;
    const r = reconcile({
      exec: slow,
      repo: "o/cloud",
      nowMs: later,
      ms: 60_000,
      clock: () => t,
    });
    expect(r.tracked.length).toBeGreaterThan(0);
    expect(r.left).toBe(ids.length - r.tracked.length);
    expect(r.left).toBeGreaterThan(0);
  });

  it("drains over successive events with every run marked once, and no sighting twice", () => {
    const g = make();
    const left: number[] = [];
    for (let e = 0; e < 6; e++)
      left.push(reconcileAt(g, later + e * HOUR, { logs: 5 }).left);
    expect(left).toEqual([7, 2, 0, 0, 0, 0]);
    expect(marks(g)).toEqual(ids.map((id) => `${id}/2`));
    expect(sightingRuns(g).sort()).toEqual(
      ids.flatMap((id) => Array.from({ length: tests }, () => id)).sort(),
    );
    // Once drained, a reconcile only reads.
    const before = JSON.stringify(g.state());
    const r = reconcileAt(g, later + DAY);
    expect(r.tracked).toEqual([]);
    expect(r.left).toBe(0);
    expect(JSON.stringify(g.state())).toBe(before);
  });

  it("a reconcile cut off mid-run keeps what it saved, and the next one finishes without a duplicate", () => {
    const g = make();
    let calls = 0;
    const dying: Exec = (cmd, args) =>
      ++calls > 60
        ? { code: 1, stdout: "", stderr: "killed" }
        : g.exec(cmd, args);
    g.clock.now = later;
    // Its last write (the pending list) fails too, so the step fails.
    expect(() =>
      reconcile({ exec: dying, repo: "o/cloud", nowMs: later }),
    ).toThrow("killed");
    const saved = marks(g);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.length).toBeLessThan(ids.length);
    for (let e = 1; e <= 4; e++) reconcileAt(g, later + e * HOUR, { logs: 5 });
    expect(marks(g)).toEqual(ids.map((id) => `${id}/2`));
    expect(sightingRuns(g).sort()).toEqual(
      ids.flatMap((id) => Array.from({ length: tests }, () => id)).sort(),
    );
  });

  it("shows each run as it is worked on, before the reconcile ends", () => {
    const g = make();
    const seen: string[] = [];
    g.clock.now = later;
    reconcile({
      exec: g.exec,
      repo: "o/cloud",
      nowMs: later,
      logs: 2,
      onRun: (l) => seen.push(l[0] ?? ""),
    });
    expect(seen).toEqual([
      "Flaky tracker, CI at abcdef0, run 1000 (passed on attempt 2):",
      "Flaky tracker, CI at abcdef0, run 1001 (passed on attempt 2):",
    ]);
  });
});

describe("a backlog run that leaves the listing's range while it waits", () => {
  // The Prover's case: 32 CI runs created 60 days ago and rerun 30 days ago.
  // The first completion tracks 10 and leaves 22; the next comes 27 hours
  // later, when the listing no longer reaches them.
  const ids = Array.from({ length: 32 }, (_, i) => 2000 + i);
  const created = NOW - (RERUN_DAYS + QUIET_DAYS) * DAY;
  const ci = (id: number): Listed => ({
    id,
    run_attempt: 2,
    conclusion: "success",
    created_at: iso(created),
    updated_at: iso(NOW - RERUN_DAYS * DAY),
    name: "CI",
    event: "push",
    head_branch: "main",
    head_sha: SHA,
    display_title: "a commit",
  });
  const make = () =>
    liveGh({
      listed: { "ci.yml": ids.map(ci) },
      jobAt: Object.fromEntries(ids.map((id) => [id, NOW - RERUN_DAYS * DAY])),
      log: CI_LOG,
    });
  const marks = (g: ReturnType<typeof make>) =>
    g
      .state()
      .stores.flatMap((st) => [...storedRuns(st.comments)])
      .sort();
  const lastPending = (g: ReturnType<typeof make>) =>
    pendingRuns(g.state().stores.flatMap((st) => st.comments));
  const at = (g: ReturnType<typeof make>, ms: number) => {
    g.clock.now = ms;
    return ms;
  };

  it("is kept in the store's pending list and still tracked, every one, once", () => {
    const g = make();
    // 1 log a run: a budget of 10 logs tracks 10.
    const first = reconcile({
      exec: g.exec,
      repo: "o/cloud",
      nowMs: at(g, NOW),
      logs: 10,
      calls: 10_000,
    });
    expect(first.tracked).toHaveLength(10);
    expect(first.left).toBe(22);
    expect(lastPending(g)).toEqual(ids.slice(10).map((id) => `${id}/2`));
    // 27 hours on, the listing finds none of them.
    const later = at(g, NOW + 27 * HOUR);
    expect(listRuns(g.exec, "o/cloud", "CI", later)).toEqual([]);
    const next = reconcile({
      exec: g.exec,
      repo: "o/cloud",
      nowMs: later,
      logs: 100,
      calls: 10_000,
    });
    expect(next.tracked.map((t) => t.run.runId)).toEqual(ids.slice(10));
    expect(next.left).toBe(0);
    expect(next.failed).toBe(0);
    expect(marks(g)).toEqual(ids.map((id) => `${id}/2`).sort());
    // The list is emptied once all are marked, then nothing more is written.
    expect(lastPending(g)).toEqual([]);
    const before = JSON.stringify(g.state());
    const r = reconcile({
      exec: g.exec,
      repo: "o/cloud",
      nowMs: at(g, later + HOUR),
    });
    expect(r.tracked).toEqual([]);
    expect(JSON.stringify(g.state())).toBe(before);
  });

  it("drains on the default budgets over later completions, all past the listing's range", () => {
    const g = make();
    reconcile({ exec: g.exec, repo: "o/cloud", nowMs: at(g, NOW), logs: 10 });
    const left: number[] = [];
    for (let e = 1; e <= 4; e++)
      left.push(
        reconcile({
          exec: g.exec,
          repo: "o/cloud",
          nowMs: at(g, NOW + 27 * HOUR + e * HOUR),
        }).left,
      );
    expect(left.at(-1)).toBe(0);
    expect(marks(g)).toEqual(ids.map((id) => `${id}/2`).sort());
  });

  it("a runner killed right after its first mark loses none: the next completion, 27 h later, does the other 31, each once", () => {
    const g = make();
    // The job dies as soon as the first run is marked: every later call fails.
    let dead = false;
    const dying: Exec = (cmd, args) => {
      if (dead) return { code: 1, stdout: "", stderr: "killed" };
      const r = g.exec(cmd, args);
      if (marks(g).length) dead = true;
      return r;
    };
    expect(() =>
      reconcile({ exec: dying, repo: "o/cloud", nowMs: at(g, NOW) }),
    ).toThrow("killed");
    expect(marks(g)).toEqual(["2000/2"]);
    // The whole list was saved before the first run started.
    expect(lastPending(g)).toEqual(ids.map((id) => `${id}/2`));
    const later = at(g, NOW + 27 * HOUR);
    expect(listRuns(g.exec, "o/cloud", "CI", later)).toEqual([]);
    const next = reconcile({
      exec: g.exec,
      repo: "o/cloud",
      nowMs: later,
      logs: 100,
      calls: 10_000,
    });
    expect(next.tracked.map((t) => t.run.runId)).toEqual(ids.slice(1));
    expect(next.left).toBe(0);
    expect(next.failed).toBe(0);
    expect(marks(g)).toEqual(ids.map((id) => `${id}/2`).sort());
    const runsSeen = [
      ...parseStore(g.state().stores.flatMap((st) => st.comments)).values(),
    ]
      .flat()
      .map((x) => x.run);
    const per = parseVitest(CI_LOG).length;
    expect(runsSeen.sort()).toEqual(
      ids.flatMap((id) => Array.from({ length: per }, () => id)).sort(),
    );
    expect(lastPending(g)).toEqual([]);
  });

  it("keeps a failed run on the list until it is marked", () => {
    const g = make();
    let fail = true;
    const broken: Exec = (cmd, args) =>
      fail && args.join(" ").endsWith("/runs/2000/attempts/2")
        ? { code: 1, stdout: "", stderr: "HTTP 404: Not Found" }
        : g.exec(cmd, args);
    const r = reconcile({
      exec: broken,
      repo: "o/cloud",
      nowMs: at(g, NOW),
      logs: 1000,
      calls: 10_000,
    });
    expect(r.failed).toBe(1);
    expect(lastPending(g)).toEqual(["2000/2"]);
    fail = false;
    const again = reconcile({
      exec: g.exec,
      repo: "o/cloud",
      nowMs: at(g, NOW + 27 * HOUR),
    });
    expect(again.tracked.map((t) => t.run.runId)).toEqual([2000]);
    expect(lastPending(g)).toEqual([]);
  });
});

describe("a first reconcile on a repo with no label and no store", () => {
  it("creates the label, then the store, then saves its pending list and the run", () => {
    const listed = { "ci.yml": [ci1(900)] };
    const g = liveGh({ listed, jobAt: { 900: NOW - HOUR }, log: CI_LOG });
    const calls: string[] = [];
    const seen: Exec = (cmd, args) => {
      calls.push(args.slice(0, 2).join(" "));
      return g.exec(cmd, args);
    };
    const r = reconcile({ exec: seen, repo: "o/cloud", nowMs: NOW });
    expect(r.failed).toBe(0);
    expect(r.tracked.map((t) => t.run.runId)).toEqual([900]);
    const firstLabel = calls.indexOf("label create");
    const firstIssue = calls.indexOf("issue create");
    expect(firstLabel).toBeGreaterThanOrEqual(0);
    expect(firstLabel).toBeLessThan(firstIssue);
    expect(g.state().stores).toHaveLength(1);
    const comments = g.state().stores[0]?.comments ?? [];
    // The pending list (written before the run), then the run's sightings.
    expect(readMarkers(comments[0]?.body ?? "")?.get("kind")).toEqual([
      "pending",
    ]);
    expect([...storedRuns(comments)]).toEqual(["900/2"]);
  });
});

describe("a pending list while daily events go on", () => {
  // 32 CI runs created 2 days before day 0. Fake clock: one completion a day.
  const ids = Array.from({ length: 32 }, (_, i) => 3000 + i);
  const make = () =>
    liveGh({
      listed: { "ci.yml": ids.map((id) => ci1(id, NOW - 2 * DAY)) },
      jobAt: Object.fromEntries(ids.map((id) => [id, NOW - 2 * DAY])),
      log: CI_LOG,
    });
  const marks = (g: ReturnType<typeof make>) =>
    g
      .state()
      .stores.flatMap((st) => [...storedRuns(st.comments)])
      .sort();
  const day = (g: ReturnType<typeof make>, d: number) => {
    g.clock.now = NOW + d * DAY;
    return g.clock.now;
  };

  it("survives 40 days of daily events that each finish only part of it", () => {
    const g = make();
    const left: number[] = [];
    for (let d = 0; d < 40; d++)
      left.push(
        reconcile({ exec: g.exec, repo: "o/cloud", nowMs: day(g, d), logs: 1 })
          .left,
      );
    // One run a day (the log budget is 1; one run always starts).
    expect(left.slice(0, 3)).toEqual([31, 30, 29]);
    expect(left.at(-1)).toBe(0);
    expect(marks(g)).toEqual(ids.map((id) => `${id}/2`).sort());
    expect(pendingRuns(g.state().stores.flatMap((st) => st.comments))).toEqual(
      [],
    );
  });

  it("is still worked on day 63 after every run failed daily since day 0 and left the listing", () => {
    const g = make();
    // Each run fails daily, but not as unreadable (the read works and its
    // answer is garbage), so none is dropped.
    let broken = true;
    const exec: Exec = (cmd, args) =>
      broken && /\/runs\/\d+\/attempts\/2$/.test(args.join(" "))
        ? { code: 0, stdout: "<html>", stderr: "" }
        : g.exec(cmd, args);
    let last = { left: -1, failed: -1 };
    for (let d = 0; d < 63; d++)
      last = reconcile({
        exec,
        repo: "o/cloud",
        nowMs: day(g, d),
        calls: 10_000,
      });
    expect(marks(g)).toEqual([]);
    // All 32 failed and are saved to retry: the backlog says so.
    expect(backlogLine(last.left, last.failed)).toBe(
      "backlog: 0 new, 32 to retry (the next completion's reconcile carries on)",
    );
    broken = false;
    const t = day(g, 63);
    expect(listRuns(g.exec, "o/cloud", "CI", t)).toEqual([]);
    const r = reconcile({
      exec: g.exec,
      repo: "o/cloud",
      nowMs: t,
      logs: 1000,
      calls: 10_000,
    });
    expect(r.tracked).toHaveLength(32);
    expect(r.failed).toBe(0);
    expect(marks(g)).toEqual(ids.map((id) => `${id}/2`).sort());
  });
});

/** A CI run that passed on attempt 2, created at `at` (by default an hour before NOW). */
function ci1(id: number, at = NOW - HOUR): Listed {
  return {
    id,
    run_attempt: 2,
    conclusion: "success",
    created_at: iso(at - HOUR),
    updated_at: iso(at),
    name: "CI",
    event: "push",
    head_branch: "main",
    head_sha: SHA,
    display_title: "a commit",
  };
}

describe("runs whose logs can't be read", () => {
  // The Prover's case: 32 CI runs, the oldest 25 with a job log that answers
  // 404, the newest 7 readable. Default budgets.
  const ids = Array.from({ length: 32 }, (_, i) => 4000 + i);
  const bad = new Set(ids.slice(0, 25));
  const setup = () => {
    const g = liveGh({
      listed: {
        "ci.yml": ids.map((id, i) => ci1(id, NOW - (40 - i) * HOUR)),
      },
      jobAt: Object.fromEntries(
        ids.map((id, i) => [id, NOW - (40 - i) * HOUR]),
      ),
      log: CI_LOG,
    });
    // Which run's jobs were listed last: its job log is read next.
    let current = 0;
    const exec: Exec = (cmd, args) => {
      const a = args.join(" ");
      const m = /\/runs\/(\d+)\/attempts\/1\/jobs/.exec(a);
      if (m) current = Number(m[1]);
      if (bad.has(current) && /\/actions\/jobs\/10\/logs/.test(a))
        return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      return g.exec(cmd, args);
    };
    return { g, exec };
  };
  const comments = (g: ReturnType<typeof liveGh>) =>
    g.state().stores.flatMap((st) => st.comments);
  const marks = (g: ReturnType<typeof liveGh>) =>
    [...storedRuns(comments(g))].sort();
  const at = (g: ReturnType<typeof liveGh>, ms: number) => {
    g.clock.now = ms;
    return ms;
  };

  it("never starve the readable ones: all 7 are tracked on the first completion", () => {
    const { g, exec } = setup();
    const r = reconcile({ exec, repo: "o/cloud", nowMs: at(g, NOW) });
    expect(r.tracked.map((t) => t.run.runId)).toEqual(ids.slice(25));
    expect(r.failed).toBe(25);
    expect(backlogLine(r.left, r.failed)).toBe(
      "backlog: 0 new, 25 to retry (the next completion's reconcile carries on)",
    );
    expect(marks(g)).toEqual(
      ids
        .slice(25)
        .map((id) => `${id}/2`)
        .sort(),
    );
    expect(pendingTries(comments(g))).toEqual(
      Object.fromEntries(ids.slice(0, 25).map((id) => [`${id}/2`, 1])),
    );
  });

  it("are tried after the runs not yet tried", () => {
    const { g, exec } = setup();
    // First completion: only the 25 unreadable ones exist yet.
    const first = reconcile({
      exec,
      repo: "o/cloud",
      nowMs: at(g, NOW - 17 * HOUR),
    });
    expect(first.tracked).toEqual([]);
    expect(first.failed).toBe(25);
    // Next: the 7 readable ones are new, so they go first.
    const order: string[] = [];
    reconcile({
      exec,
      repo: "o/cloud",
      nowMs: at(g, NOW),
      onRun: (l) => order.push(l[0] ?? ""),
    });
    expect(order.slice(0, 7)).toEqual(
      ids
        .slice(25)
        .map(
          (id) =>
            `Flaky tracker, CI at abcdef0, run ${id} (passed on attempt 2):`,
        ),
    );
  });

  it(`are dropped visibly after ${UNREADABLE_TRIES} reconciles could not read them, and then skipped`, () => {
    const { g, exec } = setup();
    const seen: { failed: number; dropped: number }[] = [];
    let last = reconcile({ exec, repo: "o/cloud", nowMs: at(g, NOW) });
    seen.push({ failed: last.failed, dropped: last.dropped.length });
    for (let e = 1; e < UNREADABLE_TRIES; e++) {
      last = reconcile({ exec, repo: "o/cloud", nowMs: at(g, NOW + e * HOUR) });
      seen.push({ failed: last.failed, dropped: last.dropped.length });
    }
    expect(seen).toEqual([
      { failed: 25, dropped: 0 },
      { failed: 25, dropped: 0 },
      { failed: 0, dropped: 25 },
    ]);
    expect([...unreadableRuns(comments(g))].sort()).toEqual(
      [...bad].map((id) => `${id}/2`).sort(),
    );
    // The summary names each one it drops.
    expect(last.notes).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^run 4000/2: unreadable: could not be read on ${UNREADABLE_TRIES} reconciles: dropped, and marked unreadable in the store`,
        ),
      ),
    );
    expect(backlogLine(last.left, last.failed)).toBe(
      "backlog: 0 new, 0 to retry",
    );
    expect(pendingRuns(comments(g))).toEqual([]);
    // Later, they are skipped like marked runs, and nothing is written.
    const before = JSON.stringify(g.state());
    const later = reconcile({
      exec,
      repo: "o/cloud",
      nowMs: at(g, NOW + 10 * HOUR),
    });
    expect(later.tracked).toEqual([]);
    expect(later.failed + later.dropped.length).toBe(0);
    expect(JSON.stringify(g.state())).toBe(before);
  });

  it("a failure that is not a read of the run never drops it", () => {
    const g = liveGh({
      listed: { "ci.yml": [ci1(900)] },
      jobAt: { 900: NOW - HOUR },
      log: CI_LOG,
    });
    // Every store comment write for the run's sightings fails.
    const exec: Exec = (cmd, args) =>
      args[0] === "issue" &&
      args[1] === "comment" &&
      !(args[args.indexOf("--body") + 1] ?? "").includes("kind: pending")
        ? { code: 1, stdout: "", stderr: "HTTP 422: Validation Failed" }
        : g.exec(cmd, args);
    for (let e = 0; e <= UNREADABLE_TRIES; e++) {
      const r = reconcile({
        exec,
        repo: "o/cloud",
        nowMs: at(g, NOW + e * HOUR),
      });
      expect(r.failed).toBe(1);
      expect(r.dropped).toEqual([]);
    }
    expect([...unreadableRuns(comments(g))]).toEqual([]);
    expect(pendingRuns(comments(g))).toEqual(["900/2"]);
  });
});
