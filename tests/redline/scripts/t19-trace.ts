// node --experimental-strip-types scripts/t19-trace.ts scrub [--secrets <dir>] <dir>...
// Scrubs every Playwright trace zip under the directories in place (src/t19-trace.ts).
// Exit 1 on any failure, after deleting every trace zip found: upload nothing.
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
try {
  const n = scrubDirs(dirs, secrets ? secretLiterals(secrets) : []);
  console.log(`t19 trace: ${n} trace zip(s) scrubbed`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
