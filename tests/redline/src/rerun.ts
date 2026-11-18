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

export type RerunDecision =
  | { rerun: true; dropped: string[] }
  | { rerun: false; why: string };

/** Whether a finished run's report calls for the one rerun, and why not when it does not. */
export function planRerun(
  report: Report | null,
  o: { gate: boolean; runExit: number; run?: RunKind },
): RerunDecision {
  if (!report) return { rerun: false, why: "no report was written" };
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
}

/**
 * Runs the gate, and once more when the first run's only failures were
 * dropped connections. Returns the final outcome, and whether it reran.
 */
export async function runWithRerun(
  io: RerunIo,
  o: { gate: boolean; run?: RunKind },
): Promise<RunOutcome & { reran: boolean }> {
  const first = await io.run(1);
  const plan = planRerun(first.report, { ...o, runExit: first.runExit });
  if (!plan.rerun || !first.report) {
    if (first.report) io.write(first.report, "final");
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
