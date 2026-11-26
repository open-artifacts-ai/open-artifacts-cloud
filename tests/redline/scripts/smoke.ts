// The red-line smoke, the blocking release check (src/smoke.ts):
//   node --experimental-strip-types scripts/smoke.ts             the two tracks
//   node --experimental-strip-types scripts/smoke.ts purge       (detached) the purge
//   node --experimental-strip-types scripts/smoke.ts purge-report what they logged so far, no wait
//   node --experimental-strip-types scripts/smoke.ts purge-wait  the purge's and sweep's result (by hand)
//   node --experimental-strip-types scripts/smoke.ts sweep-start the leftover sweep, detached
//   node --experimental-strip-types scripts/smoke.ts sweep       (detached) the sweep
// The first runs vitest once on vitest.smoke.config.ts (track 1 and track 2
// side by side; src/reporter.ts writes REDLINE_REPORT and applies the gate
// under REDLINE_GATE=1), then starts the fresh install's delete and purge in a
// detached process and exits with vitest's code: the purge never holds or
// fails the gate. sweep-start (the workflow's step after the OIDC mint, in
// every gate and nightly run) starts the delete and purge of rl-n-* installs
// older than 2 h the same way, so a failed purge never piles up. The gate
// never waits for either: purge-report (the step before the secret files go)
// prints what they logged so far and exits 0. Cut off by the job's end, a
// purge leaves its install to the next run's sweep.
// Needs REDLINE_TARGETS, REDLINE_RELEASE, REDLINE_RUN_ID and REDLINE_SMOKE_DIR.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  purgeFresh,
  purgeWait,
  SMOKE_SCRIPT,
  SWEEP_DONE,
  smokeDir,
  smokeRun,
  spawnPurge,
  spawnSweep,
  sweepFresh,
  sweepWait,
} from "../src/smoke.ts";

const [cmd] = process.argv.slice(2);
const env = process.env;
const pkg = join(import.meta.dirname, "..");

async function main(): Promise<number> {
  if (cmd === "purge")
    return (await purgeFresh(smokeRun(env), smokeDir(env))) ? 0 : 1;
  if (cmd === "sweep")
    return (await sweepFresh(smokeRun(env), smokeDir(env))) ? 0 : 1;
  if (cmd === "sweep-start") {
    env.REDLINE_SMOKE_DIR = smokeDir(env);
    spawnSweep(env.REDLINE_SMOKE_DIR, SMOKE_SCRIPT);
    console.log(
      "smoke: the sweep of leftover rl-n installs started in the background",
    );
    return 0;
  }
  // The gate's report: what the detached purge and sweep have logged so far,
  // waiting for nothing and never failing. They run on past this step until
  // the job ends; whatever they leave, the next run's sweep removes.
  if (cmd === "purge-report") {
    const dir = smokeDir(env);
    await purgeWait(dir, { within: 0 });
    // A sweep that ended failed (a page it couldn't read, say) is loud: an
    // annotation on the run, still never a gate failure.
    if (
      !(await sweepWait(dir, { within: 0 })) &&
      existsSync(join(dir, SWEEP_DONE))
    )
      console.log(
        "::warning title=red-line sweep::the sweep of leftover rl-n installs failed; its log above says why",
      );
    return 0;
  }
  if (cmd === "purge-wait") {
    const dir = smokeDir(env);
    const purged = await purgeWait(dir);
    const swept = await sweepWait(dir);
    return purged && swept ? 0 : 1;
  }
  if (cmd !== undefined) {
    console.error(`smoke: unknown command ${cmd}`);
    return 2;
  }
  // One directory for the run and the purge it starts.
  env.REDLINE_SMOKE_DIR = smokeDir(env);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(
      join(pkg, "node_modules", ".bin", "vitest"),
      ["run", "-c", "vitest.smoke.config.ts"],
      { cwd: pkg, stdio: "inherit", env },
    );
    child.on("error", () => resolve(1));
    child.on("exit", (c, sig) => resolve(sig ? 1 : (c ?? 1)));
  });
  if (spawnPurge(env.REDLINE_SMOKE_DIR, SMOKE_SCRIPT))
    console.log("smoke: the fresh install's purge started in the background");
  return code;
}

main().then(
  (c) => {
    process.exitCode = c;
  },
  (e) => {
    console.error(`smoke: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
