// cloud #447: the flaky tracker parses earlier attempts' job logs and opens or
// bumps one `flaky` issue per test. Fixtures are excerpts of real job logs:
// run 45693977251 attempt 1 (t19) and run 44935686580 attempt 1 (redline).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  bumpedBody,
  type Failure,
  keyOf,
  newIssueBody,
  parsePlaywright,
  parseRedline,
  parseSeen,
  plan,
  type RunInfo,
  type Sighting,
  stripReason,
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
  it("reads the final report's fail and infra cases, with the file from vitest's FAIL lines", () => {
    expect(parseRedline(RL_LOG)).toEqual([
      {
        suite: "redline",
        id: "redline:surface probes (cross-install) > org GET /api/v1/me/push/key [session]",
        title:
          "surface probes (cross-install) > org GET /api/v1/me/push/key [session]",
        file: "live/surfaces.test.ts",
      },
      {
        suite: "redline",
        id: "redline:surface probes (cross-install) > org GET /api/v1/me/push/key [pat]",
        title:
          "surface probes (cross-install) > org GET /api/v1/me/push/key [pat]",
        file: "live/surfaces.test.ts",
      },
      {
        suite: "redline",
        id: "redline:guard > hooks answer",
        title: "guard > hooks answer",
      },
      {
        suite: "redline",
        id: "redline:live/edge.test.ts: module error",
        title: "live/edge.test.ts: module error",
        file: "live/edge.test.ts",
      },
    ]);
  });

  it("finds nothing without a report, or in a T19 log", () => {
    expect(parseRedline("redline: no report was written (x)\n")).toEqual([]);
    expect(parseRedline(T19_LOG)).toEqual([]);
  });

  it("strips only the trailing balanced reason", () => {
    expect(stripReason("a (b) > c (why (nested))")).toBe("a (b) > c");
    expect(stripReason("a > b [pat]")).toBe("a > b [pat]");
  });
});

const run: RunInfo = {
  repo: "o/cloud",
  runId: 900,
  attempt: 2,
  tag: "v0.246.0",
  url: "https://github.com/o/cloud/actions/runs/900",
};
const NOW = Date.parse("2026-11-26T12:00:00Z");
const f: Failure = {
  suite: "t19",
  id: "t19:e2e/staging/rl-a/comments.spec.ts:live reply @gate",
  title: "live reply @gate",
  file: "e2e/staging/rl-a/comments.spec.ts",
};
const s900: Sighting = { at: "2026-11-26T11:00:00Z", run: 900, attempt: 1 };
const bodyWith = (seen: Sighting[]) =>
  newIssueBody({
    f,
    run,
    seen,
    owner: { login: "someone", assignable: false },
    ownerPath: "apps/dashboard/e2e/staging/rl-a/comments.spec.ts",
    nowMs: NOW,
  });

describe("grouping and the 7-day note", () => {
  it("creates one issue per test, from its earliest failed attempt", () => {
    const later = { ...s900, attempt: 2 };
    const a = plan(
      [
        { f, sighting: later },
        { f, sighting: s900 },
      ],
      [],
    );
    expect(a).toEqual([{ kind: "create", f, seen: [s900] }]);
  });

  it("bumps the open issue that carries the test's key, and never notes a run twice", () => {
    const old: Sighting = { at: "2026-11-24T10:00:00Z", run: 800, attempt: 1 };
    const issue = { number: 7, body: bodyWith([old]) };
    expect(issue.body).toContain(`<!-- flaky-key: ${keyOf(f.id)} -->`);
    const [bump] = plan([{ f, sighting: s900 }], [issue]);
    expect(bump).toMatchObject({ kind: "bump", issue: 7, seen: [old, s900] });
    const noted = { number: 7, body: bodyWith([old, s900]) };
    expect(plan([{ f, sighting: s900 }], [noted])).toEqual([
      { kind: "skip", f, issue: 7, why: "run 900 already noted" },
    ]);
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

  it("names an owner it can't assign in plain text, never as a mention", () => {
    const b = bodyWith([s900]);
    expect(b).toContain("someone (named only");
    expect(b).not.toContain("@someone");
  });
});

type Call = { args: string[] };
function fakeGh(o: {
  open?: { number: number; body: string }[];
  // The open list on the nth `issue list` call, when it changes mid-run.
  openAt?: (n: number) => { number: number; body: string }[];
  assignable?: boolean;
  labelExists?: boolean;
  pinFails?: boolean;
}) {
  let lists = 0;
  const calls: Call[] = [];
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
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
            {
              id: 2,
              name: "t19",
              conclusion: "failure",
              completed_at: "2026-11-26T11:00:00.123Z",
            },
          ],
        }),
      );
    if (a.includes("actions/jobs/2/logs")) return ok(T19_LOG);
    if (a.startsWith("label list"))
      return ok(JSON.stringify(o.labelExists ? [{ name: "flaky" }] : []));
    if (a.startsWith("issue list"))
      return ok(JSON.stringify(o.openAt?.(lists++) ?? o.open ?? []));
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
    if (/^(issue (create|comment|edit)|label create)/.test(a)) return ok("");
    return { code: 1, stdout: "", stderr: `unexpected: ${a}` };
  };
  return { exec, calls };
}

describe("track", () => {
  it("opens one issue per failed test, assigned to the file's last author at the pinned public sha", () => {
    const g = fakeGh({ assignable: true });
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
      expect.arrayContaining(["--label", "flaky", "--assignee", "writer"]),
    );
    expect(
      g.calls.some((c) => c.args.join(" ").startsWith("label create flaky")),
    ).toBe(true);
  });

  it("does not assign an owner GitHub refuses, and bumps an open issue instead of opening one", () => {
    const joins = parsePlaywright(T19_LOG)[0] as Failure;
    const open = [
      {
        number: 5,
        body: `<!-- flaky-key: ${keyOf(joins.id)} -->\n<!-- flaky-seen: 2026-11-22T00:00:00Z 700/1 -->`,
      },
    ];
    const g = fakeGh({ open, labelExists: true, assignable: false });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done).toEqual([
      { action: "bump", id: joins.id, issue: 5 },
      { action: "create", id: expect.stringContaining("comments.spec.ts") },
    ]);
    const comment = g.calls.find((c) => c.args[1] === "comment");
    expect(comment?.args.join(" ")).toContain(TWICE_NOTE);
    expect(comment?.args.join(" ")).toContain("/runs/900/attempts/1");
    const create = g.calls.find((c) => c.args[1] === "create");
    expect(create?.args).not.toContain("--assignee");
    expect(
      g.calls.some((c) => c.args[0] === "label" && c.args[1] === "create"),
    ).toBe(false);
  });

  it("edits the body before the comment, so a rerun after a failed comment never comments twice", () => {
    const joins = parsePlaywright(T19_LOG)[0] as Failure;
    const open = [
      {
        number: 5,
        body: `<!-- flaky-key: ${keyOf(joins.id)} -->\n<!-- flaky-seen: 2026-11-22T00:00:00Z 700/1 -->`,
      },
    ];
    const g = fakeGh({ open, labelExists: true, assignable: true });
    track({ exec: g.exec, run, nowMs: NOW });
    const edit = g.calls.findIndex((c) => c.args[1] === "edit");
    const comment = g.calls.findIndex((c) => c.args[1] === "comment");
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(edit).toBeLessThan(comment);
  });

  it("still opens the issue when the owner lookup fails, and says why in a note", () => {
    const g = fakeGh({ labelExists: true, assignable: true, pinFails: true });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    expect(r.done.map((d) => d.action)).toEqual(["create", "create"]);
    const creates = g.calls.filter((c) => c.args[1] === "create");
    expect(creates[0]?.args).not.toContain("--assignee");
    expect(creates[0]?.args.join(" ")).toContain("unknown (no commit found, or the lookup failed)");
    expect(r.notes.some((n) => n.includes("owner of") && n.includes("HTTP 404"))).toBe(true);
  });

  it("re-lists the open issues before each write, so an issue another run just opened is bumped", () => {
    // The second test: another run opens its issue while the first is created.
    const second = parsePlaywright(T19_LOG)[1] as Failure;
    const other = {
      number: 9,
      body: `<!-- flaky-key: ${keyOf(second.id)} -->\n<!-- flaky-seen: 2026-11-26T10:00:00Z 901/1 -->`,
    };
    const g = fakeGh({
      labelExists: true,
      assignable: true,
      openAt: (n) => (n === 0 ? [] : [other]),
    });
    const r = track({ exec: g.exec, run, nowMs: NOW });
    const lists = g.calls.filter((c) => c.args[0] === "issue" && c.args[1] === "list");
    expect(lists).toHaveLength(2);
    expect(r.done).toEqual([
      { action: "create", id: expect.stringContaining("joins.spec.ts") },
      { action: "bump", id: second.id, issue: 9 },
    ]);
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

  it("runs after redline-staging, only for a gate that passed on a later attempt", () => {
    expect(wf.on).toEqual({
      workflow_run: { workflows: ["redline-staging"], types: ["completed"] },
    });
    expect(wf.permissions).toEqual({});
    const cond = String(wf.jobs.track.if);
    for (const c of [
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.run_attempt > 1",
      "github.event.workflow_run.event == 'workflow_dispatch'",
      "github.event.workflow_run.head_branch == 'main'",
    ])
      expect(cond).toContain(c);
    expect(cond).not.toMatch(/\|\|/);
    // Per event and on the job: a skipped run joins no group, and no newer
    // event can cancel a pending one.
    expect(wf.concurrency).toBeUndefined();
    expect(wf.jobs.track.concurrency).toEqual({
      group: "flaky-tracker-${{ github.event.workflow_run.id }}",
      "cancel-in-progress": false,
    });
  });

  it("uses the default token with read, read and issues, no secret, and SHA-pinned actions", () => {
    const job = wf.jobs.track;
    expect(job.permissions).toEqual({
      actions: "read",
      contents: "read",
      issues: "write",
    });
    expect(job.environment).toBeUndefined();
    const text = JSON.stringify(job);
    expect(text).not.toContain("secrets.");
    for (const s of job.steps as { uses?: string }[])
      if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
  });
});
