// Regenerates the mechanical files of a surfaces port from src/surfaces.ts
// (see src/regen.ts for what and why). Run in the overlaid tree, after
// `pnpm --filter "@oa/redline^..." build`, from tests/redline:
//   node --experimental-strip-types --no-warnings scripts/redline-regen.ts check
//       fails (exit 1) when the committed files differ from what surfaces.ts
//       gives, or surfaces.ts leaves a route unclassified; prints the exact
//       routes and the lists they need.
//   ... write                 rewrites the three files in place.
//   ... plan --out plan.json  computes the plan and writes it as data (the
//                             pin-bump bot's prepare job, which has the public tree).
//   ... apply --plan plan.json  validates the plan and rewrites the files; needs no
//                             install and no public tree (the bot's open job).
// The judgment (which list a new route goes in, and its citation) stays in
// src/surfaces.ts; the hints say where.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  differing,
  type Entry,
  type Files,
  type Plan,
  regenAll,
  validatePlan,
} from "../src/regen.ts";

const ROOT = join(import.meta.dirname, "..");
const PATHS = {
  manifest: "live/manifest.json",
  casesAdded: "test/cases-added.ts",
  surfacesTest: "test/surfaces.test.ts",
} as const;
const SNAPSHOT = "test/fixtures/main-cases.json";

export function readFiles(root = ROOT): Files {
  const r = (p: string) => readFileSync(join(root, p), "utf8");
  return {
    manifest: r(PATHS.manifest),
    casesAdded: r(PATHS.casesAdded),
    surfacesTest: r(PATHS.surfacesTest),
  };
}
export function writeFiles(files: Files, root = ROOT) {
  for (const k of Object.keys(PATHS) as (keyof Files)[])
    writeFileSync(join(root, PATHS[k]), files[k]);
}
export function readSnapshot(root = ROOT): Entry[] {
  return (
    JSON.parse(readFileSync(join(root, SNAPSHOT), "utf8")) as {
      manifest: Entry[];
    }
  ).manifest;
}

const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) \S+$/;

/**
 * Where each gap goes, in words a port author can act on. `interactive` is the
 * routes that answer only a browser session (read from apps/server/src), and
 * `exempt` the routes surfaces.test.ts already explains as partial or answer
 * routes.
 */
export function hintsFor(
  gaps: readonly string[],
  interactive: readonly string[],
  listed: readonly string[],
  exempt: readonly string[],
): string[] {
  const out: string[] = [];
  const hinted = new Set<string>();
  const forRoute = (r: string, why: string) => {
    hinted.add(r);
    out.push(
      interactive.includes(r)
        ? `${r} (${why}) answers only a browser session: add it to INTERACTIVE_ONLY and EXCLUDED_ROUTES, and "org ${r}" to DROPPED (why: "interactive-only", coveredBy [INSTANCE, <Citation of the public test that shows it>]) in tests/redline/src/surfaces.ts`
        : `${r} (${why}) is not interactive-only by the source scan: a probe in apps/server/test/authz/surfaces.ts (public) should reach it, or it needs an EXCLUDED_ROUTES entry and a real-only DROPPED entry with a Citation, in tests/redline/src/surfaces.ts`,
    );
  };
  for (const g of gaps) {
    const m = /^(no case|stale exclusion): (.+)$/.exec(g);
    const d = /^drop not recorded in DROPPED: (.+) \((.+)\)$/.exec(g);
    if (m && ROUTE.test(m[2] as string))
      m[1] === "no case"
        ? forRoute(m[2] as string, "no case reaches it")
        : out.push(
            `${m[2]} is in EXCLUDED_ROUTES but a case reaches it or no drop backs it: remove it from EXCLUDED_ROUTES (tests/redline/src/surfaces.ts) or record its drop`,
          );
    else if (d)
      out.push(
        `add "${d[1]}": { why: "${d[2]}", coveredBy: [<Citation of the public test>] } to DROPPED in tests/redline/src/surfaces.ts`,
      );
    else out.push(`${g}`);
  }
  for (const r of interactive)
    if (!listed.includes(r) && !exempt.includes(r) && !hinted.has(r))
      forRoute(r, "the server reads interactiveSession for it");
  return [...new Set(out)];
}

/** Computes the plan from the overlaid tree. Needs the packages built. */
export async function computePlan(root = ROOT): Promise<{
  plan: Plan;
  gaps: string[];
  hints: string[];
}> {
  const s = await import(join(root, "src/surfaces.ts"));
  const ir = await import(join(root, "test/interactive-routes.ts"));
  const d = s.derive();
  const gaps: string[] = s.coverageGaps(d);
  const cases = d.cases as { name: string; denyOnly?: boolean; legs: string }[];
  // Cloud #264 step 2: only KEPT_SURFACES run live; the static coverage case
  // and the rest moved to PR CI or were deleted (src/retired-split.ts). The
  // counts still describe every derived case (test/surfaces.test.ts).
  const rs = await import(join(root, "src/retired-split.ts"));
  const kept: ReadonlySet<string> = rs.KEPT_SURFACES;
  const plan: Plan = {
    names: cases.map((c) => c.name).filter((n) => kept.has(n)),
    denyOnly: cases.filter((c) => c.denyOnly).length,
    atB: cases.filter((c) => c.legs === "atB").length,
  };
  const testSrc = readFileSync(join(root, PATHS.surfacesTest), "utf8");
  const scanned: string[] = ir.interactiveRoutes(ir.serverSources());
  return {
    plan,
    gaps,
    hints: hintsFor(gaps, scanned, s.INTERACTIVE_ONLY, [
      ...exemptRoutes(testSrc),
      // Owner-only routes read interactiveSession too, and are recorded drops.
      ...(d.dropped as { name: string; routes: string[] }[])
        .filter((x) => s.DROPPED[x.name]?.why === "owner-only")
        .flatMap((x) => x.routes),
    ]),
  };
}

/** The routes in surfaces.test.ts's ANSWER_ROUTES and PARTIAL_ROUTES arrays. */
function exemptRoutes(testSrc: string): string[] {
  const out: string[] = [];
  for (const name of ["ANSWER_ROUTES", "PARTIAL_ROUTES"]) {
    const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(testSrc);
    if (m)
      for (const r of (m[1] as string).matchAll(/"([^"]+)"/g))
        out.push(r[1] as string);
  }
  return out;
}

export type Check = {
  ok: boolean;
  differs: (keyof Files)[];
  problems: string[];
  gaps: string[];
  hints: string[];
};

/** Is the committed state what surfaces.ts gives? */
export async function check(root = ROOT): Promise<Check> {
  const { plan, gaps, hints } = await computePlan(root);
  const files = readFiles(root);
  const r = regenAll(files, plan, readSnapshot(root));
  const differs = differing(files, r.files);
  return {
    ok: differs.length === 0 && r.problems.length === 0 && gaps.length === 0,
    differs,
    problems: r.problems,
    gaps,
    hints,
  };
}

const arg = (a: string[], f: string) => {
  const i = a.indexOf(f);
  return i === -1 ? undefined : a[i + 1];
};

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const root = arg(rest, "--dir") ?? ROOT;
  if (cmd === "check") {
    const c = await check(root);
    if (c.ok) return console.log("redline-regen: the committed files match");
    for (const h of c.hints) console.error(`classify: ${h}`);
    for (const p of c.problems) console.error(`problem: ${p}`);
    if (c.differs.length > 0)
      console.error(
        `redline-regen: out of date: ${c.differs.map((k) => PATHS[k]).join(", ")}. Run: node --experimental-strip-types --no-warnings scripts/redline-regen.ts write`,
      );
    process.exitCode = 1;
  } else if (cmd === "write") {
    const { plan, hints } = await computePlan(root);
    const r = regenAll(readFiles(root), plan, readSnapshot(root));
    writeFiles(r.files, root);
    for (const h of hints) console.error(`classify: ${h}`);
    for (const p of r.problems) console.error(`problem: ${p}`);
    console.log("redline-regen: wrote", Object.values(PATHS).join(", "));
  } else if (cmd === "plan") {
    const out = arg(rest, "--out");
    if (!out) throw new Error("plan needs --out <file>");
    const c = await computePlan(root);
    writeFileSync(out, `${JSON.stringify(c, null, 2)}\n`);
    for (const h of c.hints)
      console.log(
        `::warning::classify: ${h.replace(/[\r\n]+/g, " ").replaceAll("::", ": :")}`,
      );
    console.log(
      `redline-regen: plan of ${c.plan.names.length} cases in ${out}`,
    );
  } else if (cmd === "apply") {
    const f = arg(rest, "--plan");
    if (!f) throw new Error("apply needs --plan <file>");
    const plan = validatePlan(
      (JSON.parse(readFileSync(f, "utf8")) as { plan: unknown }).plan,
    );
    const r = regenAll(readFiles(root), plan, readSnapshot(root));
    writeFiles(r.files, root);
    for (const p of r.problems) console.log(`::warning::${p}`);
    console.log("redline-regen: applied the plan");
  } else {
    console.error(
      "usage: redline-regen.ts check|write|plan --out F|apply --plan F [--dir D]",
    );
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
