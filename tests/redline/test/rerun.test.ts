import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUS_LANE_WORST_MS as BUS_SRC } from "../src/hosted-bus.ts";
import {
  REDLINE_JOB_MS as JOB_SRC,
  REVOKE_MARGIN_MS as MARGIN_SRC,
} from "../src/provisioning-live.ts";
import {
  buildReport,
  type CaseResult,
  exitCode,
  formatReport,
  isNoAnswerMessage,
  noAnswerOf,
  type Report,
  setupHookCase,
} from "../src/report.ts";
import {
  BUS_LANE_WORST_MS,
  planRerun,
  REDLINE_JOB_MS,
  RERUN_MARGIN_MS,
  REVOKE_MARGIN_MS,
  REVOKE_WORST_MS,
  type RerunIo,
  type RunOutcome,
  rerunDeadlineFromEnv,
  rerunDeadlineOf,
  runWithRerun,
} from "../src/rerun.ts";

const pass = (name: string): CaseResult => ({ name, level: "pass" });
const drop = (name: string): CaseResult => ({
  name,
  level: "infra",
  reason:
    "infra: no_response ECONNRESET GET /api/v1/x host ab12cd34, new socket",
  noAnswer: true,
});
const wrong = (name: string): CaseResult => ({
  name,
  level: "fail",
  reason: "expected 403, got 200",
});
const report = (...cases: CaseResult[]): Report =>
  buildReport(cases, "staging");
const outcome = (r: Report, runExit?: number): RunOutcome => ({
  report: r,
  runExit: runExit ?? (exitCode(r, true) === 0 ? 0 : 1),
});

/** A gate whose runs are scripted; records every run and write. */
function harness(...runs: RunOutcome[]) {
  const ran: number[] = [];
  const wrote: { where: string; report: Report }[] = [];
  const logs: string[] = [];
  const io: RerunIo = {
    run: async (attempt) => {
      ran.push(attempt);
      const next = runs.shift();
      if (!next) throw new Error("a third run was started");
      return next;
    },
    write: (r, where) => {
      wrote.push({ where, report: r });
      return where === "first" ? "report.run1.json" : "report.json";
    },
    log: (l) => logs.push(l),
  };
  return { io, ran, wrote, logs };
}

describe("which messages are a request that got no answer", () => {
  it.each([
    "infra: no_response ECONNRESET GET /api/v1/x host ab12cd34, reused socket, idle 900 ms, request 2 on it; retried once on a new connection, ECONNRESET again (new socket)",
    "infra: setup /__test/session no_response on rl-a (UND_ERR_SOCKET)",
    "infra: setup publish got no response on rl-a (ECONNRESET)",
    "infra: setup OAuth code flow got no response on rl-b (UND_ERR_SOCKET)",
    "infra: setup on rl-a got no response (ECONNRESET)",
    "infra: probe POST /x on app.example got no response (ECONNRESET; not idempotent, not retried)",
    "infra: probe GET /x on app.example got no response twice (UND_ERR_CLOSED)",
  ])("%s", (m) => expect(isNoAnswerMessage(m)).toBe(true));

  it.each([
    // A timeout or an abort is not a socket drop.
    "infra: setup publish timed out after 60s on rl-a",
    "infra: setup publish got no response on rl-a (AbortError)",
    "infra: setup publish got no response on rl-a (TimeoutError)",
    // An answer: a setup hook's refusal names a status and a body hash.
    "infra: setup /__test/session no_reason on rl-a (503, sha256:abcd)",
    "infra: setup /__test/session no_response on rl-a (503, sha256:abcd)",
    // Not infra at all, or unknown.
    "expected 403, got 200",
    "BREACH: B read A's data",
    "fetch failed",
    "infra: something else",
    "infra: no_response SOMETHING_ELSE GET /x",
    "",
  ])("not: %s", (m) => expect(isNoAnswerMessage(m)).toBe(false));

  it("a case is a drop only when every one of its errors is", () => {
    const d = {
      message: "infra: setup publish got no response on rl-a (ECONNRESET)",
    };
    expect(noAnswerOf([d, d])).toBe(true);
    expect(noAnswerOf([d, { message: "expected 403, got 200" }])).toBe(false);
    expect(noAnswerOf([d, { message: "infra: setup publish timed out" }])).toBe(
      false,
    );
    expect(noAnswerOf([])).toBe(false);
  });

  it("a fetch error tagged by the transport counts, an untagged one does not", () => {
    const tagged = Object.assign(new TypeError("fetch failed"), {
      redlineNoResponse:
        "infra: no_response ECONNRESET GET /x host ab12cd34, new socket",
    });
    expect(noAnswerOf([tagged])).toBe(true);
    expect(noAnswerOf([new TypeError("fetch failed")])).toBe(false);
  });

  it("a setup hook result is a drop only when every message behind it is", () => {
    const d = "infra: setup /__test/session no_response on rl-a (ECONNRESET)";
    const refused =
      "infra: setup /__test/seed refused on rl-a (500, sha256:abcd)";
    expect(setupHookCase("h", [d, d], "live/x.test.ts", ["a"]).noAnswer).toBe(
      true,
    );
    expect(
      setupHookCase("h", [d, refused], "live/x.test.ts", ["a"]).noAnswer,
    ).toBeUndefined();
  });
});

describe("planRerun", () => {
  const plan = (r: Report | null, runExit = 1) =>
    planRerun(r, { gate: true, runExit });

  it("every failed case a drop: rerun, naming them", () => {
    expect(plan(report(pass("a"), drop("b"), drop("c")))).toEqual({
      rerun: true,
      dropped: ["b", "c"],
    });
  });

  it("one drop and one wrong answer: no rerun", () => {
    expect(plan(report(drop("b"), wrong("c"))).rerun).toBe(false);
  });

  it("a breach is an answer, wherever it is reported", () => {
    const breach: CaseResult = {
      name: "p",
      level: "fail",
      reason: "BREACH: B read A",
    };
    expect(plan(report(drop("b"), breach)).rerun).toBe(false);
    const sneaky: CaseResult = { ...drop("b"), reason: "BREACH: B read A" };
    expect(plan(report(sneaky)).rerun).toBe(false);
  });

  it("ambiguous is an answer: an infra case not marked a drop, a timeout", () => {
    const timeout: CaseResult = {
      name: "t",
      level: "infra",
      reason: "infra: setup publish timed out after 60s on rl-a",
    };
    expect(plan(report(drop("b"), timeout)).rerun).toBe(false);
    expect(plan(report(timeout)).rerun).toBe(false);
    const unmarked: CaseResult = { ...drop("u"), noAnswer: undefined };
    expect(plan(report(unmarked)).rerun).toBe(false);
  });

  it("a case that did not run, a blocked case or a lane with no part: no rerun", () => {
    const blocked: CaseResult = {
      name: "x",
      level: "blocked",
      reason: "needs y",
    };
    const lane: CaseResult = {
      name: "lane a: no results",
      level: "fail",
      reason: "the lane's vitest run wrote no part (exit 1)",
    };
    expect(plan(report(drop("b"), blocked)).rerun).toBe(false);
    expect(plan(report(drop("b"), lane)).rerun).toBe(false);
  });

  it("a run that passed, no report, or a crash exit: no rerun", () => {
    expect(plan(report(pass("a")), 0).rerun).toBe(false);
    expect(plan(null).rerun).toBe(false);
    expect(plan(report(drop("b")), 137).rerun).toBe(false);
    expect(plan(report(drop("b")), 130).rerun).toBe(false);
  });

  it("a not-applicable case the gate does not accept is not a drop", () => {
    const na: CaseResult = {
      name: "n",
      level: "not-applicable",
      reason: "skipped",
    };
    // Not accepted by name: the gate fails on it, so it is not a drop.
    expect(plan(report(drop("b"), na)).rerun).toBe(false);
  });
});

describe("runWithRerun", () => {
  const opts = { gate: true };

  it("all drops: the whole gate runs again, the second result is final, the first is kept", async () => {
    const first = report(pass("a"), drop("b"));
    const second = report(pass("a"), pass("b"));
    const h = harness(outcome(first), outcome(second));
    const out = await runWithRerun(h.io, opts);
    expect(h.ran).toEqual([1, 2]);
    expect(out.reran).toBe(true);
    expect(exitCode(out.report, true, out.runExit)).toBe(0);
    expect(h.wrote.map((w) => w.where)).toEqual(["first", "final"]);
    expect(h.wrote[0]?.report).toBe(first);
    expect(h.wrote[0]?.report.rerun).toBeUndefined();
    const text = formatReport(out.report as Report);
    expect(text).toContain(
      "RERUN: the first run failed only on 1 dropped connection(s)",
    );
    expect(text).toContain("b.");
    expect(text).toContain("SECOND run's and is final");
    expect(text).toContain("report.run1.json");
    expect(text).toContain("Gate: PASS");
    expect(h.logs.join("\n")).toContain("once more");
  });

  it("a drop and a wrong answer: no rerun, one run, the gate fails", async () => {
    const h = harness(outcome(report(drop("b"), wrong("c"))));
    const out = await runWithRerun(h.io, opts);
    expect(h.ran).toEqual([1]);
    expect(out.reran).toBe(false);
    expect(h.wrote.map((w) => w.where)).toEqual(["final"]);
    expect(exitCode(out.report, true, out.runExit)).toBe(1);
  });

  it("a drop on the second run: the gate fails and no third run starts", async () => {
    const h = harness(
      outcome(report(drop("b"))),
      outcome(report(pass("a"), drop("d"))),
    );
    const out = await runWithRerun(h.io, opts);
    expect(h.ran).toEqual([1, 2]);
    expect(exitCode(out.report, true, out.runExit)).toBe(1);
    expect(formatReport(out.report as Report)).toContain("RERUN:");
    expect(formatReport(out.report as Report)).toContain("Gate: FAIL");
  });

  it("a wrong answer on the second run fails the gate", async () => {
    const h = harness(outcome(report(drop("b"))), outcome(report(wrong("b"))));
    const out = await runWithRerun(h.io, opts);
    expect(h.ran).toEqual([1, 2]);
    expect(exitCode(out.report, true, out.runExit)).toBe(1);
  });

  it("a second run that writes no report fails the gate", async () => {
    const h = harness(outcome(report(drop("b"))), { report: null, runExit: 1 });
    const out = await runWithRerun(h.io, opts);
    expect(exitCode(out.report, true, out.runExit)).toBe(1);
  });

  it("a clean first run is not rerun", async () => {
    const h = harness(outcome(report(pass("a"))));
    const out = await runWithRerun(h.io, opts);
    expect(h.ran).toEqual([1]);
    expect(out.reran).toBe(false);
    expect(h.wrote.map((w) => w.where)).toEqual(["final"]);
    expect(formatReport(out.report as Report)).not.toContain("RERUN");
  });
});

const MIN = 60_000;

describe("the rerun's deadline", () => {
  const dropped = () => report(drop("b"));
  const start = 1_000_000_000_000;
  const deadline = rerunDeadlineOf(start);
  const plan = (
    nowMin: number,
    deadlineMs: number | null | undefined = deadline,
  ) =>
    planRerun(dropped(), {
      gate: true,
      runExit: 1,
      nowMs: start + nowMin * MIN,
      deadlineMs,
    });

  it("is the job's start + 150 - 40 - 5 = 105 min", () => {
    expect(deadline - start).toBe(105 * MIN);
  });

  it("enough time: rerun; the latest start is about 69 min in (105 - 31 - 5)", () => {
    expect(plan(40).rerun).toBe(true);
    expect(plan(68).rerun).toBe(true);
  });

  it("not enough time: no rerun, and it says so", () => {
    const d = plan(69);
    expect(d.rerun).toBe(false);
    expect(d.rerun === false && d.why).toMatch(/^no time for a rerun/);
    expect(plan(100).rerun).toBe(false);
  });

  it("an unknown start: no rerun; no limit (undefined): rerun", () => {
    const d = plan(1, null);
    expect(d.rerun).toBe(false);
    expect(d.rerun === false && d.why).toMatch(/^no time for a rerun/);
    expect(
      planRerun(dropped(), {
        gate: true,
        runExit: 1,
        nowMs: start + 1000 * MIN,
        deadlineMs: undefined,
      }).rerun,
    ).toBe(true);
  });

  it("from the environment: a start is a deadline; missing or unparsable in CI is unknown", () => {
    expect(
      rerunDeadlineFromEnv({ REDLINE_JOB_STARTED_AT: String(start) }),
    ).toBe(deadline);
    for (const bad of ["abc", "0", "-5", "NaN", "Infinity"])
      expect(rerunDeadlineFromEnv({ REDLINE_JOB_STARTED_AT: bad })).toBeNull();
    expect(rerunDeadlineFromEnv({ GITHUB_ACTIONS: "true" })).toBeNull();
    expect(
      rerunDeadlineFromEnv({
        GITHUB_ACTIONS: "true",
        REDLINE_JOB_STARTED_AT: "",
      }),
    ).toBeNull();
    // Not the workflow: no revoke to protect, no deadline.
    expect(rerunDeadlineFromEnv({})).toBeUndefined();
    // A bad value is unknown even outside the workflow.
    expect(rerunDeadlineFromEnv({ REDLINE_JOB_STARTED_AT: "abc" })).toBeNull();
  });

  it("runWithRerun: too late means one run, the first result stands, and it logs why", async () => {
    const h = harness(outcome(report(drop("b"))));
    const out = await runWithRerun(
      { ...h.io, now: () => start + 90 * MIN },
      { gate: true, deadlineMs: deadline },
    );
    expect(h.ran).toEqual([1]);
    expect(out.reran).toBe(false);
    expect(exitCode(out.report, true, out.runExit)).toBe(1);
    expect(h.logs.join("\n")).toContain("no time for a rerun");
    expect(h.wrote.map((w) => w.where)).toEqual(["final"]);
  });

  it("runWithRerun: in time reruns", async () => {
    const h = harness(outcome(report(drop("b"))), outcome(report(pass("b"))));
    const out = await runWithRerun(
      { ...h.io, now: () => start + 40 * MIN },
      { gate: true, deadlineMs: deadline },
    );
    expect(h.ran).toEqual([1, 2]);
    expect(out.reran).toBe(true);
  });

  it("is pinned to the workflow: the job's 150 min, the revoke's 40, the lane's 31", () => {
    const text = readFileSync(
      join(
        import.meta.dirname,
        "../../../.github/workflows/redline-staging.yml",
      ),
      "utf8",
    );
    // The copies equal their sources.
    expect(REDLINE_JOB_MS).toBe(JOB_SRC);
    expect(REVOKE_MARGIN_MS).toBe(MARGIN_SRC);
    expect(BUS_LANE_WORST_MS).toBe(BUS_SRC);
    expect(REDLINE_JOB_MS).toBe(150 * MIN);
    expect(REVOKE_MARGIN_MS).toBe(5 * MIN);
    expect(REVOKE_WORST_MS).toBe(40 * MIN);
    expect(RERUN_MARGIN_MS).toBe(5 * MIN);
    expect(Math.round(BUS_LANE_WORST_MS / MIN)).toBe(31);
    // timeout-minutes of the redline job, the budget comment's numbers.
    expect(text).toMatch(/\n {2}redline:\n[\s\S]*?timeout-minutes: 150\n/);
    expect(text).toContain("revoke of rl-a and rl-b 40");
    expect(text).toContain("suite (bus lane) 31");
    expect(text).toContain("150 - 40 (revoke) - 5 = 105 min");
    expect(text).toContain("REDLINE_JOB_STARTED_AT");
  });
});

describe("a signalled run", () => {
  it("planRerun refuses, whatever else is true", () => {
    const d = planRerun(report(drop("b")), {
      gate: true,
      runExit: 1,
      signalled: true,
    });
    expect(d.rerun).toBe(false);
    expect(d.rerun === false && d.why).toMatch(/signalled/);
  });

  it("runWithRerun starts no second run", async () => {
    const h = harness(outcome(report(drop("b"))));
    const out = await runWithRerun(
      { ...h.io, signalled: () => true },
      { gate: true },
    );
    expect(h.ran).toEqual([1]);
    expect(out.reran).toBe(false);
    expect(exitCode(out.report, true, out.runExit)).toBe(1);
  });
});
