// One automatic rerun of the whole gate, when the first run failed only
// because requests got no answer at all (a dropped connection: a socket code,
// no status line, no frame). The user's rule (2026-11-18): rerun the whole
// gate once, automatically; never only the failed cases.
//
// The decision is strict. Any failure that is an answer (a wrong status or
// body, a breach, an assertion, a timeout, a setup refusal, a case that did
// not run, a lane that reported nothing) fails the gate at once. When it is
// unclear whether an answer was received, it counts as one. At most one rerun:
// the second run's result is final, whatever it is.
import {
  BREACH_MARK,
  type CaseResult,
  exitCode,
  gateFailures,
  type Report,
  type RerunNote,
  type RunKind,
} from "./report.ts";

// Copies, not imports: this file runs in the script's bare node process, and
// src/provisioning-live.ts and src/hosted-bus.ts need the built @oa/provision.
// test/rerun.test.ts pins each one to its source and to the workflow.
/** The redline job's timeout (src/provisioning-live.ts REDLINE_JOB_MS). */
export const REDLINE_JOB_MS = 150 * 60_000;
/** The margin the revoke keeps under it (src/provisioning-live.ts REVOKE_MARGIN_MS). */
export const REVOKE_MARGIN_MS = 5 * 60_000;
/** The bus lane's worst case, the longest a suite runs (src/hosted-bus.ts BUS_LANE_WORST_MS). */
export const BUS_LANE_WORST_MS = 1_865_000; // 31 min 5 s

/**
 * The R26 revoke of rl-a and rl-b can take up to 40 min, and it must end
 * inside the redline job's 150 min. A second run may start only if it, in its
 * worst case, ends before the revoke's window opens. The numbers are the
 * workflow's (the budget comment above the t19 job in redline-staging.yml;
 * test/rerun.test.ts pins them against that file).
 */
export const REVOKE_WORST_MS = 40 * 60_000;
/** Slack on top of the lane bound before the revoke's window. */
export const RERUN_MARGIN_MS = 5 * 60_000;

/**
 * The latest instant a rerun's worst case may end: the job's start + 150 min
 * - 40 min (revoke) - 5 min (REVOKE_MARGIN_MS) = start + 105 min.
 */
export const rerunDeadlineOf = (jobStartMs: number): number =>
  jobStartMs + REDLINE_JOB_MS - REVOKE_WORST_MS - REVOKE_MARGIN_MS;

/**
 * The rerun's deadline from the environment (REDLINE_JOB_STARTED_AT, epoch ms,
 * written by the workflow's first step in the redline job).
 * - a number: the deadline.
 * - undefined: no deadline, only for a run that is not the workflow (no
 *   GITHUB_ACTIONS): nothing there has a revoke to protect.
 * - null: unknown. In the workflow, a missing variable, or any unparsable
 *   one, means no rerun: the revoke is what is at risk.
 */
export function rerunDeadlineFromEnv(
  env: Record<string, string | undefined>,
): number | null | undefined {
  const raw = env.REDLINE_JOB_STARTED_AT;
  if (raw === undefined || raw === "")
    return env.GITHUB_ACTIONS === "true" ? null : undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? rerunDeadlineOf(n) : null;
}

export type RerunDecision =
  | { rerun: true; dropped: string[] }
  | { rerun: false; why: string };

/** Whether a finished run's report calls for the one rerun, and why not when it does not. */
export function planRerun(
  report: Report | null,
  o: {
    gate: boolean;
    runExit: number;
    run?: RunKind;
    /** A signal (a cancelled job, a Ctrl-C) reached a lane or this script. */
    signalled?: boolean;
    /** Now, epoch ms. */
    nowMs?: number;
    /** See rerunDeadlineFromEnv: a number, undefined for no limit, null for unknown. */
    deadlineMs?: number | null;
  },
): RerunDecision {
  if (!report) return { rerun: false, why: "no report was written" };
  if (o.signalled)
    return { rerun: false, why: "the run was signalled (cancelled)" };
  if (exitCode(report, o.gate, o.runExit) === 0)
    return { rerun: false, why: "the run did not fail" };
  // vitest ends 1 when a test fails. Anything else (a signal, a crash) is not
  // a drop we can name.
  if (o.runExit !== 0 && o.runExit !== 1)
    return { rerun: false, why: `a lane ended with exit ${o.runExit}` };
  if (report.counts.fail > 0)
    return { rerun: false, why: `${report.counts.fail} failed case(s)` };
  if (
    report.cases.some(
      (c) => c.reason?.includes(BREACH_MARK) || c.actual?.includes(BREACH_MARK),
    )
  )
    return { rerun: false, why: "a breach was reported" };
  const failing: CaseResult[] = gateFailures(report.cases, o.run);
  if (failing.length === 0)
    return { rerun: false, why: "no failed case explains the failure" };
  const other = failing.filter((c) => !(c.level === "infra" && c.noAnswer));
  if (other.length > 0)
    return {
      rerun: false,
      why: `${other.length} failed case(s) are not dropped connections: ${other.map((c) => c.name).join("; ")}`,
    };
  if (o.deadlineMs === null)
    return {
      rerun: false,
      why: "no time for a rerun: the job's start is unknown",
    };
  if (
    o.deadlineMs !== undefined &&
    (o.nowMs ?? Date.now()) + BUS_LANE_WORST_MS + RERUN_MARGIN_MS > o.deadlineMs
  )
    return {
      rerun: false,
      why: "no time for a rerun: a second run could not end before the revoke needs its time",
    };
  return { rerun: true, dropped: failing.map((c) => c.name) };
}

export interface RunOutcome {
  report: Report | null;
  runExit: number;
}

export interface RerunIo {
  /** One whole run of the gate: every lane, built into a report that is not yet written. */
  run: (attempt: 1 | 2) => Promise<RunOutcome>;
  /** Writes `report` as the run's report (`final`), or as the first run's kept copy (`first`). Returns its path. */
  write: (report: Report, where: "final" | "first") => string;
  log: (line: string) => void;
  /** True once a signal reached the run. Read after each run. */
  signalled?: () => boolean;
  /** Now, epoch ms. */
  now?: () => number;
}

/**
 * Runs the gate, and once more when the first run's only failures were
 * dropped connections. Returns the final outcome, and whether it reran.
 */
export async function runWithRerun(
  io: RerunIo,
  o: {
    gate: boolean;
    run?: RunKind;
    /** See rerunDeadlineFromEnv. */
    deadlineMs?: number | null;
  },
): Promise<RunOutcome & { reran: boolean }> {
  const first = await io.run(1);
  const plan = planRerun(first.report, {
    ...o,
    runExit: first.runExit,
    signalled: io.signalled?.() ?? false,
    nowMs: (io.now ?? Date.now)(),
  });
  if (!plan.rerun || !first.report) {
    if (first.report) io.write(first.report, "final");
    if (!plan.rerun && /^no time/.test(plan.why))
      io.log(`redline: ${plan.why}; the first run's result stands`);
    return { ...first, reran: false };
  }
  const firstPath = io.write(first.report, "first");
  io.log(
    `redline: the first run failed only on ${plan.dropped.length} dropped connection(s): ${plan.dropped.join("; ")}. Running the whole gate once more; the second run is final. First report: ${firstPath}`,
  );
  const second = await io.run(2);
  if (second.report) {
    const note: RerunNote = { dropped: plan.dropped, firstReport: firstPath };
    second.report = { ...second.report, rerun: note };
    io.write(second.report, "final");
  }
  return { ...second, reran: true };
}
