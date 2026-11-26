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
  bumpedBody,
  caseName,
  codeSpan,
  e2ePackage,
  type Failure,
  keyOf,
  LABEL,
  MAX_ISSUES_PER_RUN,
  mergeSightings,
  newIssueBody,
  parseJob,
  parsePlaywright,
  parseRedline,
  parseSeen,
  parseStore,
  parseVitest,
  plan,
  type RunInfo,
  runFromArgs,
  type Sighting,
  STORE_AUTHOR,
  STORE_LABEL,
  STORE_MARKER,
  sightingLine,
  storeComment,
  summaryMarker,
  TWICE_NOTE,
  track,
  twiceInWindow,
} from "./flaky-tracker.ts";
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
    nowMs: NOW,
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
    expect(plan({ f, sighting: s900, stored: [] }, [], NOW)).toMatchObject({
      kind: "record",
    });
    // The store already holding this run is still one run.
    expect(plan({ f, sighting: s900, stored: [s900] }, [], NOW).kind).toBe(
      "record",
    );
  });

  it("opens an issue with both runs at the second, but not when the first is 8 days old", () => {
    expect(plan({ f, sighting: s900, stored: [s800] }, [], NOW)).toEqual({
      kind: "create",
      f,
      seen: [s800, s900],
    });
    const old: Sighting = { ...s800, at: "2026-11-18T11:00:00Z" };
    expect(plan({ f, sighting: s900, stored: [old] }, [], NOW).kind).toBe(
      "record",
    );
  });

  it("bumps the open issue that carries the test's key, and never notes a run twice", () => {
    const issue = { number: 7, body: bodyWith([s800]) };
    expect(issue.body).toContain(`<!-- flaky-key: ${keyOf(f.id)} -->`);
    expect(
      plan({ f, sighting: s900, stored: [s800] }, [issue], NOW),
    ).toMatchObject({
      kind: "bump",
      issue: 7,
      seen: [s800, s900],
      added: [s900],
    });
    const noted = { number: 7, body: bodyWith([s800, s900]) };
    expect(plan({ f, sighting: s900, stored: [s800] }, [noted], NOW)).toEqual({
      kind: "skip",
      f,
      issue: 7,
      why: "run 900 already noted",
    });
  });

  it("does not bump an open issue on a lone sighting in the window", () => {
    const old: Sighting = { ...s800, at: "2026-11-01T00:00:00Z" };
    const issue = { number: 7, body: bodyWith([old]) };
    expect(plan({ f, sighting: s900, stored: [] }, [issue], NOW).kind).toBe(
      "record",
    );
  });

  it("notes 'fails twice in 7 days' for two runs within 7 days, not at 8", () => {
    const at = (d: string, r: number): Sighting => ({
      at: d,
      run: r,
      attempt: 1,
    });
    expect(twiceInWindow([s900], NOW)).toBe(false);
    expect(twiceInWindow([s900, { ...s900, attempt: 2 }], NOW)).toBe(false);
    expect(twiceInWindow([at("2026-11-20T12:00:00Z", 1), s900], NOW)).toBe(
      true,
    );
    expect(twiceInWindow([at("2026-11-18T12:00:00Z", 1), s900], NOW)).toBe(
      false,
    );
    const b = bumpedBody(
      bodyWith([at("2026-11-24T00:00:00Z", 1)]),
      [at("2026-11-24T00:00:00Z", 1), s900],
      NOW,
    );
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
      nowMs: NOW,
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

type Call = { args: string[] };
type Comment = { user: string; body: string };
function fakeGh(o: {
  open?: { number: number; body: string }[];
  // The open list on the nth `issue list --label flaky` call.
  openAt?: (n: number) => { number: number; body: string }[];
  // Store issues and their comments; none means the first run in the repo.
  stores?: { number: number; state?: string; comments: Comment[] }[];
  assignable?: boolean;
  labels?: string[];
  pinFails?: boolean;
  jobs?: { name: string; log: string }[];
}) {
  let lists = 0;
  const calls: Call[] = [];
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const jobs = o.jobs ?? [{ name: "t19", log: T19_LOG }];
  const stores = o.stores ?? [];
  const exec: Exec = (_cmd, args) => {
    calls.push({ args });
    const a = args.join(" ");
    if (a.endsWith("/runs/900/attempts/2"))
      return ok(JSON.stringify({ conclusion: "success", head_sha: "abc" }));
    if (a.endsWith("/runs/900/attempts/1"))
      return ok(JSON.stringify({ conclusion: "failure", head_sha: "abc" }));
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
              conclusion: "failure",
              completed_at: "2026-11-26T11:00:00.123Z",
            })),
          ],
        }),
      );
    const log = /actions\/jobs\/(\d+)\/logs/.exec(a);
    if (log) return ok(jobs[Number(log[1]) - 10]?.log ?? "");
    if (a.startsWith("label list")) {
      const name = args[args.indexOf("--search") + 1];
      return ok(
        JSON.stringify((o.labels ?? []).includes(name ?? "") ? [{ name }] : []),
      );
    }
    if (a.startsWith("issue list") && a.includes(`--label ${STORE_LABEL}`))
      return ok(
        JSON.stringify(
          stores.map((s) => ({
            number: s.number,
            state: s.state ?? "OPEN",
            body: `${STORE_MARKER}\nstore`,
          })),
        ),
      );
    if (a.startsWith("issue list"))
      return ok(JSON.stringify(o.openAt?.(lists++) ?? o.open ?? []));
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
    if (a.startsWith("issue create") && a.includes(`--label ${STORE_LABEL}`))
      return ok("https://github.com/o/cloud/issues/77\n");
    if (/^(issue (create|comment|edit)|label create)/.test(a)) return ok("");
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
const writes = (g: { calls: Call[] }) =>
  g.calls.filter(
    (c) =>
      (c.args[0] === "issue" && c.args[1] !== "list") ||
      (c.args[0] === "label" && c.args[1] === "create"),
  );
const bodyOf = (c: Call | undefined) =>
  c?.args[c.args.indexOf("--body") + 1] ?? "";

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
        body: `<!-- flaky-key: ${keyOf(joins.id)} -->\n<!-- flaky-seen: 2026-11-22T00:00:00Z 700/1 -->`,
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

  it("re-lists the open issues before each write, so an issue another run just opened is bumped", () => {
    const other = {
      number: 9,
      body: `<!-- flaky-key: ${keyOf(comments.id)} -->\n<!-- flaky-seen: 2026-11-26T10:00:00Z 901/1 -->`,
    };
    const g = fakeGh({
      labels: LABELS,
      assignable: true,
      stores: storeWith(joins, comments),
      openAt: (n) => (n === 0 ? [] : [other]),
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    const lists = g.calls.filter(
      (c) =>
        c.args[0] === "issue" && c.args[1] === "list" && c.args.includes(LABEL),
    );
    expect(lists).toHaveLength(2);
    expect(r.done).toEqual([
      { action: "create", id: joins.id },
      { action: "bump", id: comments.id, issue: 9 },
    ]);
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

  it(`records each test at ${MAX_ISSUES_PER_RUN}`, () => {
    const g = fakeGh({
      labels: LABELS,
      jobs: [{ name: "t19", log: many(MAX_ISSUES_PER_RUN) }],
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done.filter((d) => d.action === "record")).toHaveLength(
      MAX_ISSUES_PER_RUN,
    );
  });

  it("opens one summary issue, and records nothing and bumps nothing, past the cap", () => {
    const g = fakeGh({
      labels: LABELS,
      jobs: [{ name: "t19", log: many(50) }],
      stores: storeWith(),
      open: [
        {
          number: 5,
          body: `<!-- flaky-key: ${keyOf("t19:e2e/staging/rl-a/t0.spec.ts:case 0 @gate")} -->\n<!-- flaky-seen: 2026-11-22T00:00:00Z 700/1 -->`,
        },
      ],
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done).toEqual([{ action: "summary", id: "summary:900" }]);
    const w = writes(g);
    expect(w).toHaveLength(1);
    const body = bodyOf(w[0]);
    expect(body).toContain(summaryMarker(900));
    expect(body).toContain("50 tests failed on attempt 1");
    expect(body).toContain("/runs/900/attempts/1");
    expect(body).toContain("`case 49 @gate`");
  });

  it("opens the summary once, when a rerun of the tracker finds it open", () => {
    const g = fakeGh({
      labels: LABELS,
      jobs: [{ name: "t19", log: many(6) }],
      open: [{ number: 11, body: `${summaryMarker(900)}\nsix tests` }],
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done).toEqual([{ action: "skip", id: "summary:900", issue: 11 }]);
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

describe("flaky-tracker.yml", () => {
  const wf = parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../.github/workflows/flaky-tracker.yml",
      ),
      "utf8",
    ),
  );

  it("runs after CI and redline-staging, only for a run that passed on a later attempt", () => {
    expect(wf.on).toEqual({
      workflow_run: {
        workflows: ["CI", "redline-staging"],
        types: ["completed"],
      },
    });
    expect(wf.permissions).toEqual({});
    const cond = String(wf.jobs.track.if).replace(/\s+/g, " ");
    expect(cond).toBe(
      "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.run_attempt > 1 && (github.event.workflow_run.name == 'CI' || (github.event.workflow_run.name == 'redline-staging' && github.event.workflow_run.event == 'workflow_dispatch' && github.event.workflow_run.head_branch == 'main'))",
    );
    // Per event and on the job: a skipped run joins no group, and no newer
    // event can cancel a pending one.
    expect(wf.concurrency).toBeUndefined();
    expect(wf.jobs.track.concurrency).toEqual({
      group: "flaky-tracker-${{ github.event.workflow_run.id }}",
      "cancel-in-progress": false,
    });
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
