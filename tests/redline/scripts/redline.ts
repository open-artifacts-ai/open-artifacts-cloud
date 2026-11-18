// Runs the live red-line suite and applies the gate.
//   node --experimental-strip-types scripts/redline.ts [--gate]
// (or REDLINE_GATE=1). Needs REDLINE_TARGETS. Exits non-zero on any failed
// case, and with the gate unless EVERY case is "pass".
//
// The files run in the lanes of src/lanes.ts: phases one after another, the
// lanes of a phase at the same time, each lane one vitest run whose files run
// one at a time. Each lane writes a part; this script builds the one report.
// When the first run fails only on dropped connections (no answer received),
// the whole gate runs once more, automatically (src/rerun.ts); the second
// run's result is final and the first run's report is kept beside it.
// REDLINE_PLAN=serial runs the two-phase plan of before #1730 (the kill switch).
// Lanes share `${REPORT}.locks/` (src/locks.ts) and `${REPORT}.barriers/`
// (src/barrier.ts, with a `lane-exit.<name>` file written when a lane's vitest
// closes), both wiped at the start like the retry slots.
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BARRIER_DIR_ENV, barrierDirOf, laneExitFile } from "../src/barrier.ts";
import { type ControlStats, controlProbeFor } from "../src/edge-probe.ts";
import {
  type Lane,
  type LaneResult,
  laneName,
  mergeLanes,
  planProblems,
  selectPlan,
} from "../src/lanes.ts";
import { LOCK_DIR_ENV, lockDirOf } from "../src/locks.ts";
import { prefixed } from "../src/prefixed.ts";
import {
  exitCode,
  formatReport,
  gateOn,
  type Report,
  runKindOf,
} from "../src/report.ts";
import { finalReport, type LanePart, writeReport } from "../src/reporter.ts";
import { runWithRerun } from "../src/rerun.ts";

const pkg = join(import.meta.dirname, "..");
// When the current run began: the lanes (env below) and the control probe share it.
let suiteStart = Date.now();
const gate = gateOn(process.argv.slice(2), process.env);
const reportFile =
  process.env.REDLINE_REPORT ||
  join(mkdtempSync(join(tmpdir(), "oa-redline-report-")), "report.json");
const partsDir = `${reportFile.replace(/\.json$/, "")}.lanes`;
const barrierDir = barrierDirOf(reportFile);
const lockDir = lockDirOf(reportFile);
let PLAN: ReturnType<typeof selectPlan>;
try {
  PLAN = selectPlan(process.env);
} catch (e) {
  // An unknown REDLINE_PLAN fails closed, before any case starts.
  console.error(`redline: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
const bad = planProblems(PLAN);
if (bad.length) {
  console.error(`redline: the plan is wrong: ${bad.join("; ")}`);
  process.exit(1);
}

// The first run's kept report, when a rerun follows (src/rerun.ts).
const firstReportFile = `${reportFile.replace(/\.json$/, "")}.run1.json`;

// A stale report, part or retry slot must never stand in for this run's. Runs
// before every run of the gate, the rerun included (never the first run's kept
// copy: that one is removed only before the first run).
function prepare(attempt: 1 | 2): void {
  if (attempt === 1) {
    rmSync(firstReportFile, { force: true });
    rmSync(firstReportFile.replace(/\.json$/, ".txt"), { force: true });
  }
  rmSync(reportFile, { force: true });
  rmSync(reportFile.replace(/\.json$/, ".txt"), { force: true });
  rmSync(partsDir, { recursive: true, force: true });
  rmSync(barrierDir, { recursive: true, force: true });
  rmSync(lockDir, { recursive: true, force: true });
  const dir = dirname(reportFile);
  if (existsSync(dir))
    for (const f of readdirSync(dir))
      if (f.startsWith(`${basename(reportFile)}.retries`))
        rmSync(join(dir, f), { force: true });
  mkdirSync(partsDir, { recursive: true, mode: 0o700 });
  mkdirSync(barrierDir, { recursive: true, mode: 0o700 });
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
}

const vitest = join(pkg, "node_modules", ".bin", "vitest");
const live = new Set<ChildProcess>();
const forward = (sig: NodeJS.Signals) => () => {
  for (const c of live) c.kill(sig);
};
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
process.on("SIGHUP", forward("SIGHUP"));

function runLane(lane: Lane, prefix: boolean): Promise<LaneResult> {
  const name = laneName(lane);
  const part = join(partsDir, `${name}.json`);
  const child = spawn(
    vitest,
    ["run", "-c", "vitest.live.config.ts", ...lane.files],
    {
      cwd: pkg,
      stdio: prefix ? ["ignore", "pipe", "pipe"] : "inherit",
      // The reporter writes this lane's part and leaves the exit to us; the
      // retry budget (src/retry.ts) still counts beside REDLINE_REPORT.
      env: {
        ...process.env,
        ...lane.env,
        REDLINE_LANE: name,
        REDLINE_SUITE_START_MS: String(suiteStart),
        [BARRIER_DIR_ENV]: barrierDir,
        [LOCK_DIR_ENV]: lockDir,
        REDLINE_REPORT: reportFile,
        REDLINE_REPORT_PART: part,
        REDLINE_GATE: "0",
      },
    },
  );
  live.add(child);
  if (prefix && child.stdout && child.stderr) {
    prefixed(child.stdout, process.stdout, `[${name}] `);
    prefixed(child.stderr, process.stderr, `[${name}] `);
  }
  return new Promise((res) =>
    child.on("close", (code, sig) => {
      live.delete(child);
      // A lane that ended releases whoever waits on it (src/barrier.ts).
      writeFileSync(laneExitFile(barrierDir, name), String(code ?? sig), {
        mode: 0o600,
      });
      let p: LanePart | null = null;
      try {
        const v = JSON.parse(readFileSync(part, "utf8")) as LanePart;
        if (v?.v === 1 && Array.isArray(v.cases)) p = v;
      } catch {
        p = null;
      }
      res({ lane, exit: code ?? (sig ? 1 : 0), part: p });
    }),
  );
}

/** One whole run of the gate: every phase and lane, built into a report (not written). */
async function runOnce(
  attempt: 1 | 2,
): Promise<{ report: Report | null; runExit: number }> {
  prepare(attempt);
  suiteStart = Date.now();
  const results: LaneResult[] = [];
  let control: ControlStats | undefined;
  // Evidence only (src/edge-probe.ts): one control request a second to the edge
  // while the lanes run, once for each run. It never changes a verdict, and
  // is always stopped, however the lanes end. Lanes read the start time to say
  // when a reset happened (src/resets.ts).
  const probe = controlProbeFor(process.env, { startMs: suiteStart });
  process.once("exit", () => {
    probe?.stop();
  });
  try {
    probe?.start();
    for (const [i, phase] of PLAN.entries()) {
      console.log(
        `redline: phase ${i + 1} of ${PLAN.length}: ${phase.map((l) => `${l.name}: ${l.files.join(", ")}`).join(" | ")}`,
      );
      results.push(
        ...(await Promise.all(phase.map((l) => runLane(l, phase.length > 1)))),
      );
    }
  } finally {
    control = probe?.stop();
  }

  const merged = mergeLanes(results);
  try {
    let report = await finalReport(merged.cases, merged.fileNotes);
    if (control && control.sent > 0) report = { ...report, edge: { control } };
    return { report, runExit: merged.runExit };
  } catch (e) {
    console.error(`redline: no report was written (${(e as Error).message})`);
    return { report: null, runExit: merged.runExit };
  }
}

// A report that could not be written fails the run, as before.
let writeFailed = false;

function write(report: Report, where: "final" | "first"): string {
  const out = where === "first" ? firstReportFile : reportFile;
  try {
    process.stdout.write(
      `\n${where === "first" ? "[first run] " : ""}${writeReport(report, out)}`,
    );
  } catch (e) {
    writeFailed = true;
    console.error(`redline: no report was written (${(e as Error).message})`);
  }
  return out;
}

const outcome = await runWithRerun(
  { run: runOnce, write, log: (l) => console.log(l) },
  { gate, run: runKindOf(process.env) },
);
const report = outcome.report;
if (report && gate)
  console.log(`\n[gate] ${formatReport(report).trimEnd().split("\n").pop()}`);
console.log(`redline: report at ${reportFile}`);
process.exit(writeFailed ? 1 : exitCode(report, gate, outcome.runExit));
