// Undeclared cross-package reads over the overlay (cloud on public at
// PUBLIC_PIN), so the hosted packages are covered too (#17). Public's own
// check lists only the files git tracks, and cloud files are untracked in the
// overlay, so this lists them with `-co`. It reuses public's finder and
// reporter; the baseline is public's scripts/ci/workspace-reads-known.txt plus
// this repo's scripts/ci/workspace-reads-overlay-known.txt.
//   node --experimental-strip-types --no-warnings scripts/ci/workspace-reads-overlay.ts
// Run at the overlay root. Exit 1 on a new or stale entry.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workspace } from "./workspace-imports.ts";
import { parseKnown, reads, report } from "./workspace-reads.ts";

const TOPS = ["apps", "packages", "scripts", "tests"];
const SOURCE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const PUBLIC_KNOWN = "scripts/ci/workspace-reads-known.txt";
const CLOUD_KNOWN = "scripts/ci/workspace-reads-overlay-known.txt";

const root = process.cwd();
const files = execFileSync(
  "git",
  ["ls-files", "-co", "--exclude-standard", "-z", "--", ...TOPS],
  { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 },
)
  .split("\0")
  .filter((p) => p && SOURCE.test(p) && !p.includes("/node_modules/"))
  .map((p) => ({ path: p, text: readFileSync(join(root, p), "utf8") }));

const pkgs = workspace(root);
const findings = reads(pkgs, files);
const known = [PUBLIC_KNOWN, CLOUD_KNOWN].flatMap((k) =>
  parseKnown(readFileSync(join(root, k), "utf8")),
);
console.log(
  `workspace-reads (overlay): ${files.length} source files, ${pkgs.length} packages, ${findings.length} cross-package read(s), ${known.length} known`,
);
const out = report(findings, known, false);
for (const l of out.lines) console.error(l);
const CLOUD = new Set([
  "apps/admin",
  "apps/billing",
  "apps/dispatch",
  "apps/inventory",
  "apps/platform-db",
  "apps/provisioner",
  "apps/provisioning",
  "apps/scheduler",
  "packages/billing-core",
  "packages/gh-oidc",
  "packages/provision",
]);
const seen = new Set(files.map((f) => f.path.split("/").slice(0, 2).join("/")));
console.log(
  `checked cloud packages: ${[...CLOUD].filter((d) => seen.has(d)).join(" ")}`,
);
process.exit(out.code);
