// Runs the live red-line suite and applies the gate.
//   node --experimental-strip-types scripts/redline.ts [--gate]
// (or REDLINE_GATE=1). Needs REDLINE_TARGETS. Exits non-zero on any failed
// case, and with the gate unless EVERY case is "pass".
//
// The files run in the lanes of src/lanes.ts: phases one after another, the
// lanes of a phase at the same time, each lane one vitest run whose files run
// one at a time. Each lane writes a part; this script builds the one report.
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
import {
  type Lane,
  type LaneResult,
  laneName,
  mergeLanes,
  planProblems,
  selectPlan,
} from "../src/lanes.ts";
import { LOCK_DIR_ENV, lockDirOf } from "../src/locks.ts";
import { exitCode, formatReport, gateOn, type Report } from "../src/report.ts";
import { finalReport, type LanePart, writeReport } from "../src/reporter.ts";

const pkg = join(import.meta.dirname, "..");
const gate = gateOn(process.argv.slice(2), process.env);
const reportFile =
  process.env.REDLINE_REPORT ||
  join(mkdtempSync(join(tmpdir(), "oa-redline-report-")), "report.json");
const partsDir = `${reportFile.replace(/\.json$/, "")}.lanes`;
const barrierDir = barrierDirOf(reportFile);
const lockDir = lockDirOf(reportFile);
const PLAN = selectPlan(process.env);
const bad = planProblems(PLAN);
if (bad.length) {
  console.error(`redline: the plan is wrong: ${bad.join("; ")}`);
  process.exit(1);
}

// A stale report, part or retry slot must never stand in for this run's.
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

const vitest = join(pkg, "node_modules", ".bin", "vitest");
const live = new Set<ChildProcess>();
const forward = (sig: NodeJS.Signals) => () => {
  for (const c of live) c.kill(sig);
};
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
process.on("SIGHUP", forward("SIGHUP"));

/** Copies `from` to `to` a whole line at a time, each line prefixed. */
function prefixed(
  from: NodeJS.ReadableStream,
  to: NodeJS.WriteStream,
  p: string,
) {
  let rest = "";
  from.setEncoding("utf8");
  from.on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) to.write(`${p}${l}\n`);
  });
  from.on("end", () => {
    if (rest) to.write(`${p}${rest}\n`);
  });
}

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

const results: LaneResult[] = [];
for (const [i, phase] of PLAN.entries()) {
  console.log(
    `redline: phase ${i + 1} of ${PLAN.length}: ${phase.map((l) => `${l.name}: ${l.files.join(", ")}`).join(" | ")}`,
  );
  results.push(
    ...(await Promise.all(phase.map((l) => runLane(l, phase.length > 1)))),
  );
}

const merged = mergeLanes(results);
let report: Report | null = null;
try {
  report = await finalReport(merged.cases, merged.fileNotes);
  process.stdout.write(`\n${writeReport(report, reportFile)}`);
} catch (e) {
  console.error(`redline: no report was written (${(e as Error).message})`);
  report = null;
}
if (report && gate)
  console.log(`\n[gate] ${formatReport(report).trimEnd().split("\n").pop()}`);
console.log(`redline: report at ${reportFile}`);
process.exit(exitCode(report, gate, merged.runExit));
