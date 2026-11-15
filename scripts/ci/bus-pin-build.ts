// The hosted server build with the bus release pin (public #2586). The server
// build verifies the published @open-artifacts/bus release itself (Sigstore)
// and writes the pin into version.gen.ts (an older stable's, with a warning,
// when the release itself does not verify). This wrapper builds once and fails
// if the output has no pin: no unpinned hosted release.
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

const parts = (v: string): number[] =>
  (v.split(/[-+]/)[0] ?? "").split(".").map((n) => Number.parseInt(n, 10));
/** Negative when a < b (numeric x.y.z; pre-release suffixes are ignored). */
export function cmp(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const warnOf = (
  pin: string,
  version: string,
  why: string | null,
): string =>
  `::warning::bus pin is ${pin}, older than the release ${version}${why ? ` (${why})` : ""}`;

/**
 * Builds once (one short retry only if the build itself errors, as a
 * transient error), then requires a bus pin in the output: the release's
 * own or an older stable (warns). No pin, a newer pin, or another built
 * server version throws.
 */
export async function buildWithPin(
  version: string,
  d: Deps,
  retryMs = 10_000,
): Promise<Pin> {
  const log = d.log ?? (() => {});
  if (!d.build()) {
    log("the server build failed; retrying once");
    await d.sleep(retryMs);
    if (!d.build()) throw new Error("the server build failed twice");
  }
  const src = d.read();
  const { version: got, pin } = readPin(src);
  if (got !== version)
    throw new Error(`built server version ${got}, expected ${version}`);
  if (!pin)
    throw new Error(
      `no bus pin for ${version}: ${readWhy(src) ?? "the build recorded none"}`,
    );
  const c = cmp(pin.version, version);
  if (c > 0)
    throw new Error(
      `bus pin is ${pin.version}, newer than the release ${version}`,
    );
  const why = readWhy(src);
  const from = readFallbackFor(src);
  if (from)
    log(
      `::warning::bus pin fell back from ${from} to ${pin.version}${why ? ` (${why})` : ""}`,
    );
  else if (c < 0) log(warnOf(pin.version, version, why));
  return pin;
}

/** BUS_PKG_FALLBACK_FOR of a built version.gen.ts: the version that fell back, or null. */
export function readFallbackFor(src: string): string | null {
  const m = /^export const BUS_PKG_FALLBACK_FOR\b[^=]*= (.*);$/m.exec(src);
  try {
    const v = JSON.parse(m?.[1] ?? "null") as unknown;
    return typeof v === "string" && v !== "" ? v : null;
  } catch {
    return null;
  }
}

/** BUS_PKG_WHY of a built version.gen.ts, when non-empty. */
export function readWhy(src: string): string | null {
  const m = /^export const BUS_PKG_WHY = ("(?:[^"\\]|\\.)*");$/m.exec(src);
  const w = m ? (JSON.parse(m[1] as string) as string) : "";
  return w === "" ? null : w;
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
