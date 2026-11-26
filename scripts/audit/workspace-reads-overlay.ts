// Undeclared cross-package reads over the overlay (cloud on public at
// PUBLIC_PIN), so the hosted packages are covered too (#17). Public's own
// check lists only the files git tracks, and cloud files are untracked in the
// overlay, so this lists them with `-co`. It reuses public's finder and
// reporter; the baseline is public's scripts/ci/workspace-reads-known.txt plus
// this repo's scripts/audit/workspace-reads-overlay-known.txt.
//   node --experimental-strip-types --no-warnings scripts/audit/workspace-reads-overlay.ts
// Run at the overlay root. Exit 1 on a new or stale entry. A stale line is
// reported against the file it is in: public's report() always names public's.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workspace } from "../ci/workspace-imports.ts";
import { parseKnown, reads, report } from "../ci/workspace-reads.ts";

const TOPS = ["apps", "packages", "scripts", "tests"];
const SOURCE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const PUBLIC_KNOWN = "scripts/ci/workspace-reads-known.txt";
const CLOUD_KNOWN = "scripts/audit/workspace-reads-overlay-known.txt";

const git = (root: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });

/** Source files in the overlay, tracked or not, so cloud's untracked ones count. */
export function listed(root: string): { path: string; text: string }[] {
  return git(root, [
    "ls-files",
    "-co",
    "--exclude-standard",
    "-z",
    "--",
    ...TOPS,
  ])
    .split("\0")
    .filter((p) => p && SOURCE.test(p) && !p.includes("/node_modules/"))
    .map((p) => ({ path: p, text: readFileSync(join(root, p), "utf8") }));
}

/** Packages with no public counterpart: their package.json is not tracked. */
export function cloudPackages(root: string, dirs: string[]): string[] {
  const tracked = new Set(
    git(root, [
      "ls-files",
      "-z",
      "--",
      ...TOPS.map((t) => `${t}/*/package.json`),
    ])
      .split("\0")
      .filter(Boolean),
  );
  return dirs.filter((d) => !tracked.has(`${d}/package.json`)).sort();
}

const UNTIL = /#.*\buntil (v\d+\.\d+\.\d+)\b/;
/** Known lines that carry "# until vX.Y.Z", with that tag. */
export function untilLines(text: string): { entry: string; until: string }[] {
  return text.split("\n").flatMap((l) => {
    const m = UNTIL.exec(l);
    const entry = l.split("#")[0].trim();
    return m && entry ? [{ entry, until: m[1] }] : [];
  });
}
/**
 * The public release in the overlay tree: the root package.json version (the
 * overlay keeps public's root package.json; PUBLIC_PIN is not copied), as
 * vX.Y.Z, or undefined.
 */
function pinTag(root: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      .version as unknown;
    return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v)
      ? `v${v}`
      : undefined;
  } catch {
    return undefined;
  }
}
/** a >= b for vX.Y.Z tags. */
export function newerOrSame(a: string, b: string): boolean {
  const n = (t: string) => t.slice(1).split(".").map(Number);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

export function check(root: string): {
  log: string[];
  lines: string[];
  code: number;
} {
  const files = listed(root);
  const pkgs = workspace(root);
  const findings = reads(pkgs, files);
  const publicKnown = parseKnown(
    readFileSync(join(root, PUBLIC_KNOWN), "utf8"),
  );
  const cloudText = readFileSync(join(root, CLOUD_KNOWN), "utf8");
  // A line ending "# until vX.Y.Z" is needed only while the tree's public
  // release (the root package.json version) is older than
  // that release (public changed the read in it). From that pin on it is
  // dropped from the baseline with a warning to delete it, so the same file
  // holds across the pin transition (pin-bump/* is protected; no hand port).
  // Every other stale line still exits 1 (#135).
  const pin = pinTag(root);
  const retired = untilLines(cloudText).filter(
    (u) => pin !== undefined && newerOrSame(pin, u.until),
  );
  const cloudKnown = parseKnown(cloudText).filter(
    (l) => !retired.some((u) => u.entry === l),
  );
  const known = [...publicKnown, ...cloudKnown];
  const out = report(findings, known, false);
  // report() words every stale line around public's file; name the cloud one.
  const own = new Set(cloudKnown.filter((l) => !publicKnown.includes(l)));
  const lines = out.lines.map((l) => {
    const entry = l.split(": stale entry in ")[0];
    return l.includes(": stale entry in ") && own.has(entry)
      ? l.replaceAll("workspace-reads-known.txt", CLOUD_KNOWN)
      : l;
  });
  const cloud = cloudPackages(
    root,
    pkgs.map((p) => p.dir),
  );
  const seen = new Set(
    files.map((f) => f.path.split("/").slice(0, 2).join("/")),
  );
  return {
    log: [
      `workspace-reads (overlay): ${files.length} source files, ${pkgs.length} packages, ${findings.length} cross-package read(s), ${known.length} known`,
      `checked cloud packages: ${cloud.filter((d) => seen.has(d)).join(" ")}`,
      ...retired.map(
        (u) =>
          `::warning file=${CLOUD_KNOWN}::"${u.entry}" is retired at ${u.until} (pin ${pin}); delete the line`,
      ),
    ],
    lines,
    code: out.code,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = check(process.cwd());
  for (const l of out.log) console.log(l);
  for (const l of out.lines) console.error(l);
  process.exit(out.code);
}
