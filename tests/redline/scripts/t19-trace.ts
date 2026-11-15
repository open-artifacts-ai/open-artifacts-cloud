// node --experimental-strip-types scripts/t19-trace.ts scrub [--secrets <dir>] <dir>...
// Scrubs every Playwright trace zip under the directories in place (src/t19-trace.ts).
// On a scrub failure: deletes every trace zip found, logs "trace dropped: <code>", exits 0.
import {
  dropErrorContext,
  dropMedia,
  scanDirs,
  scrubDirs,
  secretLiterals,
} from "../src/t19-trace.ts";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "scrub" && cmd !== "scan") {
  console.error("usage: t19-trace.ts scrub|scan [--secrets <dir>] <dir>...");
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
  const lit = secrets ? secretLiterals(secrets) : [];
  if (cmd === "scan") {
    // Fail closed: an unreadable file is deleted, a hit stops the upload.
    const s = scanDirs(dirs, lit);
    for (const f of s.dropped) console.log(`dropped unreadable: ${f}`);
    for (const f of s.hits) console.log(`secret in report file: ${f}`);
    console.log(`t19 scan: ${s.scanned} file(s) scanned`);
    process.exit(s.hits.length ? 1 : 0);
  }
  const ec = dropErrorContext(dirs);
  if (ec) console.log(`dropped error-context: ${ec} file(s)`);
  const md = dropMedia(dirs);
  if (md) console.log(`dropped ${md} screenshots/videos`);
  const r = scrubDirs(dirs, lit);
  if (r.dropped) console.log(`trace dropped: ${r.dropped}`);
  else console.log(`t19 trace: ${r.scrubbed} trace zip(s) scrubbed`);
} catch (e) {
  console.error(`trace step crashed: ${(e as Error).message}`);
  process.exit(1);
}
