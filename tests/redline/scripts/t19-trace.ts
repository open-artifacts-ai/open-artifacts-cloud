// node --experimental-strip-types scripts/t19-trace.ts scrub [--secrets <dir>] <dir>...
// Scrubs every Playwright trace zip under the directories in place (src/t19-trace.ts).
// On a scrub failure: deletes every trace zip found, logs "trace dropped: <code>", exits 0.
import { scrubDirs, secretLiterals } from "../src/t19-trace.ts";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "scrub") {
  console.error("usage: t19-trace.ts scrub [--secrets <dir>] <dir>...");
  process.exit(2);
}
let secrets: string | undefined;
const dirs: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--secrets") secrets = rest[++i];
  else dirs.push(rest[i] as string);
}
// A scrub failure deletes every trace zip and still exits 0: the rest of the
// report goes up, never an unscrubbed trace. Exit 1 is only for a crash here.
try {
  const r = scrubDirs(dirs, secrets ? secretLiterals(secrets) : []);
  if (r.dropped) console.log(`trace dropped: ${r.dropped}`);
  else console.log(`t19 trace: ${r.scrubbed} trace zip(s) scrubbed`);
} catch (e) {
  console.error(`trace step crashed: ${(e as Error).message}`);
  process.exit(1);
}
