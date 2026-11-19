// The mechanical half of a surfaces port (cloud #385, #387). A pin bump that adds
// a route needs a judgment (which list the route goes in: INTERACTIVE_ONLY,
// EXCLUDED_ROUTES, DROPPED, each citing a public test) in src/surfaces.ts, and
// three files that follow from it with no judgment left:
//   live/manifest.json        one entry per derived surfaces case
//   test/cases-added.ts       the manifest entries the frozen snapshot lacks
//   test/surfaces.test.ts     the deny-only and group-B counts
// This module computes those from a Plan (what derive() gives) and rewrites them.
// It is pure text work and imports nothing from surfaces.ts, so the pin-bump
// bot's `open` job (no install, no public tree) can apply a plan it was handed
// as data. Frozen: test/fixtures/main-cases.json and the recordings, never
// written.
export const SURFACES_FILE = "live/surfaces.test.ts";
export const SURFACE_PREFIX = "surface probes (cross-install) > ";
export const BLOCK_BEGIN =
  "// regen:begin (scripts/redline-regen.ts writes this block; do not edit it by hand)";
export const BLOCK_END = "// regen:end";

/** What derive() gives, reduced to what the three files need. */
export interface Plan {
  /** Every surfaces case name, in derive order, without SURFACE_PREFIX. */
  names: string[];
  /** Cases with no success leg (deny-only). */
  denyOnly: number;
  /** Cases with an A-at-B leg (the deny-only ones and the OAuth smoke). */
  atB: number;
}

export type Entry = { file: string; name: string };
type Manifest = { cases: Entry[]; [k: string]: unknown };

// Printable ASCII, but no quote, backtick, backslash or dollar sign: a name is
// written inside a string literal and a template.
const NAME = /^[ !#%-[\]-_a-~]{1,300}$/;

/** A plan is data from another job: every name must be plain text. */
export function validatePlan(p: unknown): Plan {
  const x = p as Partial<Plan> | null;
  if (!x || !Array.isArray(x.names) || x.names.length > 5000)
    throw new Error("plan: names is not a list");
  for (const n of x.names)
    if (typeof n !== "string" || !NAME.test(n))
      throw new Error(`plan: a case name is not plain text: ${String(n)}`);
  for (const k of ["denyOnly", "atB"] as const)
    if (!Number.isInteger(x[k]) || (x[k] as number) < 0)
      throw new Error(`plan: ${k} is not a count`);
  return {
    names: x.names,
    denyOnly: x.denyOnly as number,
    atB: x.atB as number,
  };
}

const key = (c: Entry) => `${c.file}\u0000${c.name}`;

/**
 * The manifest with its surfaces entries equal to the plan's. A missing case
 * goes right after the case before it in derive order (so a port lands where
 * the routes sit), an entry derive no longer makes is removed, and everything
 * else stays. A removed case that the frozen snapshot holds is a problem: the
 * suite must keep main's cases, so a person decides.
 */
export function regenManifest(
  text: string,
  plan: Plan,
  snapshot: readonly Entry[],
): { text: string; problems: string[] } {
  const m = JSON.parse(text) as Manifest;
  const want = plan.names.map((n) => SURFACE_PREFIX + n);
  const wantSet = new Set(want);
  const frozen = new Set(snapshot.map(key));
  const problems: string[] = [];
  let cases = m.cases.filter((c) => {
    if (c.file !== SURFACES_FILE || wantSet.has(c.name)) return true;
    if (frozen.has(key(c))) {
      problems.push(
        `the frozen snapshot holds a surfaces case derive() no longer makes: ${c.name}`,
      );
      return true;
    }
    return false;
  });
  want.forEach((name, i) => {
    if (cases.some((c) => c.file === SURFACES_FILE && c.name === name)) return;
    const prev = want[i - 1];
    const after = prev
      ? cases.findIndex((c) => c.file === SURFACES_FILE && c.name === prev)
      : -1;
    const at =
      after >= 0
        ? after + 1
        : (() => {
            const first = cases.findIndex((c) => c.file === SURFACES_FILE);
            return first === -1 ? cases.length : first;
          })();
    cases = [
      ...cases.slice(0, at),
      { file: SURFACES_FILE, name },
      ...cases.slice(at),
    ];
  });
  return { text: `${JSON.stringify({ ...m, cases }, null, 2)}\n`, problems };
}

const quote = (s: string) => JSON.stringify(s);

/** The `"..."` literals of a source slice (the hand-written lists use plain strings). */
function literalsOf(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/"((?:\\.|[^"\\\n])*)"/g))
    out.add(JSON.parse(`"${m[1]}"`) as string);
  return out;
}

/**
 * cases-added.ts with the generated block holding every manifest surfaces case
 * the snapshot lacks and the hand-written part doesn't already declare.
 * Hand-written entries (they carry the port's reasons) are never touched.
 */
export function regenCasesAdded(
  text: string,
  manifestText: string,
  snapshot: readonly Entry[],
): { text: string; problems: string[] } {
  const b = text.indexOf(BLOCK_BEGIN);
  const e = text.indexOf(BLOCK_END);
  if ((b === -1) !== (e === -1) || e < b)
    throw new Error("cases-added.ts: the regen block markers are unpaired");
  let hand = text;
  if (b !== -1) {
    const from = text.lastIndexOf("\n", b) + 1;
    const to = text.indexOf("\n", e);
    hand = text.slice(0, from) + text.slice(to === -1 ? text.length : to + 1);
  }
  const m = JSON.parse(manifestText) as Manifest;
  const frozen = new Set(snapshot.map(key));
  const declared = literalsOf(hand);
  const problems: string[] = [];
  const fresh: string[] = [];
  for (const c of m.cases) {
    if (c.file !== SURFACES_FILE || frozen.has(key(c))) continue;
    if (!c.name.startsWith(SURFACE_PREFIX)) {
      problems.push(
        `a surfaces case lacks the "${SURFACE_PREFIX}" prefix: ${c.name}`,
      );
      continue;
    }
    const short = c.name.slice(SURFACE_PREFIX.length);
    if (!declared.has(short)) fresh.push(short);
  }
  // A hand-written surfaces entry the manifest dropped fails same-cases.test.ts.
  const inManifest = new Set(m.cases.map((c) => c.name));
  for (const n of declared)
    if (
      /^(org|artifact|space|content|tool) .*\[(session|pat|oauth)\]$/.test(n) &&
      !inManifest.has(SURFACE_PREFIX + n)
    )
      problems.push(`cases-added.ts declares a case the manifest lacks: ${n}`);
  const block =
    fresh.length === 0
      ? ""
      : [
          `    ${BLOCK_BEGIN}`,
          "    ...[",
          ...fresh.map((n) => `      ${quote(n)},`),
          "    ].map((n) => ({",
          `      file: ${quote(SURFACES_FILE)},`,
          `      name: \`${SURFACE_PREFIX}\${n}\`,`,
          "    })),",
          `    ${BLOCK_END}`,
          "",
        ].join("\n");
  const end = hand.lastIndexOf("\n  ];");
  if (end === -1) throw new Error("cases-added.ts: no closing `];` found");
  const at = end + 1;
  return { text: hand.slice(0, at) + block + hand.slice(at), problems };
}

const COUNT_ONLY = /(expect\(only\)\.toHaveLength\()\d+(\))/;
const COUNT_ATB =
  /(expect\(by\("atB"\)\.filter\(\(c\) => c\.denyOnly\)\)\.toHaveLength\()\d+(\))/;
const COUNT_OWN =
  /(expect\(by\("own"\)\)\.toHaveLength\(cases\.length - 2 - )\d+(\))/;

/** surfaces.test.ts with the three count constants set from the plan. */
export function regenCounts(text: string, plan: Plan): string {
  let out = text;
  for (const [re, n, what] of [
    [COUNT_ONLY, plan.denyOnly, "the deny-only count"],
    [COUNT_ATB, plan.denyOnly, "the group-B deny-only count"],
    [COUNT_OWN, plan.atB, "the group-B own count"],
  ] as const) {
    if (!re.test(out))
      throw new Error(
        `surfaces.test.ts: can't find ${what}; update src/regen.ts`,
      );
    out = out.replace(re, `$1${n}$2`);
  }
  return out;
}

export interface Files {
  manifest: string;
  casesAdded: string;
  surfacesTest: string;
}

/** The three files regenerated from a plan, plus anything a person must settle. */
export function regenAll(
  files: Files,
  plan: Plan,
  snapshot: readonly Entry[],
): { files: Files; problems: string[] } {
  const a = regenManifest(files.manifest, plan, snapshot);
  const b = regenCasesAdded(files.casesAdded, a.text, snapshot);
  return {
    files: {
      manifest: a.text,
      casesAdded: b.text,
      surfacesTest: regenCounts(files.surfacesTest, plan),
    },
    problems: [...a.problems, ...b.problems],
  };
}

/** The names of the files whose text differs. */
export function differing(a: Files, b: Files): (keyof Files)[] {
  return (Object.keys(a) as (keyof Files)[]).filter((k) => a[k] !== b[k]);
}
