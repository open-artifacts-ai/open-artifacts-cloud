// The red-line smoke, the blocking release check (src/smoke.ts):
//   node --experimental-strip-types scripts/smoke.ts             the two tracks
//   node --experimental-strip-types scripts/smoke.ts purge       (detached) the purge
//   node --experimental-strip-types scripts/smoke.ts purge-wait  the purge's and sweep's result
//   node --experimental-strip-types scripts/smoke.ts sweep-start the leftover sweep, detached
//   node --experimental-strip-types scripts/smoke.ts sweep       (detached) the sweep
// The first runs vitest once on vitest.smoke.config.ts (track 1 and track 2
// side by side; src/reporter.ts writes REDLINE_REPORT and applies the gate
// under REDLINE_GATE=1), then starts the fresh install's delete and purge in a
// detached process and exits with vitest's code: the purge never holds or
// fails the gate. sweep-start (the workflow's step after the OIDC mint, in
// every gate and nightly run) starts the delete and purge of rl-n-* installs
// older than 2 h the same way, so a failed purge never piles up. purge-wait
// (the step before the secret files go) waits for both, prints their logs,
// and exits 1 only when one did not end well.
// Needs REDLINE_TARGETS, REDLINE_RELEASE, REDLINE_RUN_ID and REDLINE_SMOKE_DIR.
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  purgeFresh,
  purgeWait,
  SMOKE_SCRIPT,
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
