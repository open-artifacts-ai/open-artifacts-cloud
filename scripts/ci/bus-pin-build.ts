// The hosted server build with the bus release pin (public #2586). The server
// build verifies the published @open-artifacts/bus release itself (Sigstore)
// and writes the pin into version.gen.ts; it gives no pin, without failing,
// when npm has not caught up with the public release yet. This wrapper runs
// that build again, bounded, until version.gen.ts carries a pin for the
// release's version, and fails if it never does: no unpinned hosted release.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type Pin = { version: string; integrity: string };

/** The pin and the version recorded in a built version.gen.ts. */
export function readPin(src: string): {
  version: string | null;
  pin: Pin | null;
} {
  const v = /^export const VERSION = ("(?:[^"\\]|\\.)*");$/m.exec(src);
  const p = /^export const BUS_PKG\b[^=]*= (.*);$/m.exec(src);
  let pin: Pin | null = null;
  if (p) {
    try {
      const j = JSON.parse(p[1] ?? "null") as Partial<Pin> | null;
      if (
        j &&
        typeof j.version === "string" &&
        typeof j.integrity === "string" &&
        /^sha512-[A-Za-z0-9+/]{86}==$/.test(j.integrity)
      )
        pin = { version: j.version, integrity: j.integrity };
    } catch {
      pin = null;
    }
  }
  return { version: v ? (JSON.parse(v[1] as string) as string) : null, pin };
}

export type Deps = {
  build: () => boolean;
  read: () => string;
  sleep: (ms: number) => Promise<void>;
  log?: (s: string) => void;
};

/** Builds until the output carries the bus pin for `version`; throws if never. */
export async function buildWithPin(
  version: string,
  d: Deps,
  attempts = 10,
  delayMs = 90_000,
): Promise<Pin> {
  const log = d.log ?? (() => {});
  let last = "the build did not run";
  for (let i = 1; i <= attempts; i++) {
    if (!d.build()) last = "the server build failed";
    else {
      const { version: got, pin } = readPin(d.read());
      if (got !== version)
        throw new Error(`built server version ${got}, expected ${version}`);
      if (pin && pin.version !== version)
        throw new Error(`bus pin is ${pin.version}, expected ${version}`);
      if (pin) return pin;
      last =
        "the build recorded no bus pin (npm may not have the release verified yet)";
    }
    log(`attempt ${i}/${attempts}: ${last}`);
    if (i < attempts) await d.sleep(delayMs);
  }
  throw new Error(
    `no bus pin for ${version} after ${attempts} attempts: ${last}`,
  );
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const [version, file, ...cmd] = process.argv.slice(2);
  if (!version || !file || cmd[0] !== "--" || cmd.length < 2) {
    console.error(
      "usage: bus-pin-build.ts <version> <version.gen.ts> -- <build command...>",
    );
    process.exit(2);
  }
  const [bin, ...args] = cmd.slice(1) as [string, ...string[]];
  try {
    const pin = await buildWithPin(version, {
      build: () => spawnSync(bin, args, { stdio: "inherit" }).status === 0,
      read: () => readFileSync(file, "utf8"),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (s) => console.log(s),
    });
    console.log(`bus pin recorded: ${pin.version} ${pin.integrity}`);
  } catch (e) {
    console.error(`::error::${(e as Error).message}`);
    process.exit(1);
  }
}
