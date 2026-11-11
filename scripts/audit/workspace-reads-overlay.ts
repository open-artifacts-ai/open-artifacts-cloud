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
  const cloudKnown = parseKnown(readFileSync(join(root, CLOUD_KNOWN), "utf8"));
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
