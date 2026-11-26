// The red-line smoke, the blocking release check (src/smoke.ts):
//   node --experimental-strip-types scripts/smoke.ts             the two tracks
//   node --experimental-strip-types scripts/smoke.ts purge       (detached) the purge
//   node --experimental-strip-types scripts/smoke.ts purge-wait  the purge's result
// The first runs vitest once on vitest.smoke.config.ts (track 1 and track 2
// side by side; src/reporter.ts writes REDLINE_REPORT and applies the gate
// under REDLINE_GATE=1), then starts the fresh install's delete and purge in a
// detached process and exits with vitest's code: the purge never holds or
// fails the gate. purge-wait (the workflow's step before the secret files go)
// waits for it, prints its log, and exits 1 only when it did not end well.
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
} from "../src/smoke.ts";

const [cmd] = process.argv.slice(2);
const env = process.env;
const pkg = join(import.meta.dirname, "..");

async function main(): Promise<number> {
  if (cmd === "purge")
    return (await purgeFresh(smokeRun(env), smokeDir(env))) ? 0 : 1;
  if (cmd === "purge-wait") return (await purgeWait(smokeDir(env))) ? 0 : 1;
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
