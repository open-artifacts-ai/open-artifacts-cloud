import { parse as parseYaml } from "yaml";
import {
  SPLIT_RETIRED,
  type SurfaceCite,
  surfaceCiteGaps,
} from "./retired-split.ts";
import { type Citation, resolveCitations } from "./surfaces.ts";

// #1235: live cases taken out of the red-line run, each with the failure it
// was mapped to in the failure model (#1137, artifact hqiYYAsXZiP7Bxeu) and
// the tests that guard that failure instead. A retired case must not come
// back into live/manifest.json unnoticed, and every citation must resolve
// (retiredGaps, run by the fake suite on every PR).

/** A retired live case: its file, full name, the failure, and its replacements. */
export interface Retired {
  file: string;
  /** The full name the reporter gave it ("describe > test"). */
  name: string;
  /** The failure-model id it guarded, or "none". */
  guards: string;
  why: string;
  coveredBy: readonly Citation[];
}

const GUARD = "tests/redline/live/guard.test.ts";
const MATRIX = "apps/server/test/authz.surface-matrix.test.ts";
const HARNESS = "credentials (harness smoke)";

/** The matrix's foreign PAT on every data and storage route, and its proof (#1224). */
const FOREIGN_PAT_ON_DATA: Citation[] = [
  {
    file: MATRIX,
    describe: "refusal mode writes nothing on the world space",
    test: "every refusal-mode instance write, every caller, both target shapes",
  },
  {
    file: MATRIX,
    describe: "foreign credentials: another install's, valid there (#1137)",
    test: "each works at A, the install that issued it, as B's owner id; at B it is no one",
  },
];
/** The live PAT checks that stay: A's PAT at B on deployed installs (CRED-2). */
const LIVE_PAT: Citation[] = [
  {
    file: GUARD,
    describe: HARNESS,
    test: "A's admin PAT at B: /api/v1/me",
  },
];
/** The fake that proves a kept crossCheck fails when B accepts A's credential. */
const CROSS_FAILS: Citation = {
  file: "tests/redline/test/harness.test.ts",
  describe: "crossCheck",
  test: "fails when B accepts A's credential",
};

const DATA_WHY =
  "A's PAT reaches the data and storage routes only through enforcePolicy's resolveSession (apps/server/src/runtime/routes.ts: gate needs authzAt), so the route can't change the answer. The matrix runs the foreign PAT on each of them on every PR; the live PAT smokes stay";

const data = (name: string): Retired => ({
  file: "live/live.test.ts",
  name: `data API at B with A's PAT > ${name}`,
  guards: "CRED-2",
  why: DATA_WHY,
  coveredBy: [...FOREIGN_PAT_ON_DATA, ...LIVE_PAT, CROSS_FAILS],
});

export const RETIRED: readonly Retired[] = [
  {
    file: "live/guard.test.ts",
    name: "agent guides > a: /llms.txt is on the app host only; robots.txt opens only the guides",
    guards: "none",
    why: "a product smoke with no isolation failure (failure model group C); the server's own tests pin the same text and statuses",
    coveredBy: [
      {
        file: "apps/server/test/llms.test.ts",
        describe: "GET /llms.txt",
        test: "app host: 200 plain text, cacheable, ETag/304, HEAD",
      },
      {
        file: "apps/server/test/llms.test.ts",
        describe: "GET /llms.txt",
        test: "content host: 404; every other method: 405",
      },
      {
        file: "apps/server/test/skeleton.test.ts",
        describe: "skeleton",
        test: "robots.txt on the app host: only the agent guides are open",
      },
      {
        file: "apps/server/test/skeleton.test.ts",
        describe: "skeleton",
        test: "robots.txt on the content host: everything is disallowed",
      },
    ],
  },
  {
    file: "live/guard.test.ts",
    name: "agent guides > b: /llms.txt is on the app host only; robots.txt opens only the guides",
    guards: "none",
    why: "the same as a: one release, one bundle",
    coveredBy: [
      {
        file: "apps/server/test/llms.test.ts",
        describe: "GET /llms.txt",
        test: "app host: 200 plain text, cacheable, ETag/304, HEAD",
      },
      {
        file: "apps/server/test/skeleton.test.ts",
        describe: "skeleton",
        test: "robots.txt on the content host: everything is disallowed",
      },
    ],
  },
  {
    file: "live/edge.test.ts",
    name: "scheduler > no /__oa/nightly route on either install",
    guards: "none",
    why: "the route was never built; enforcePolicy answers 404 for any route not in ROUTE_POLICY (failure model group C)",
    coveredBy: [
      {
        file: "apps/server/test/fixes.test.ts",
        describe: "app host SPA fallback",
        test: "API paths 404 as JSON, not SPA",
      },
      {
        file: MATRIX,
        describe: "coverage (derived from the router and the registries)",
        test: "every mounted app route is listed (artifact surface, instance route or public)",
      },
    ],
  },
  {
    file: "live/credentials.test.ts",
    name: "credentials > A's admin PAT at B: /api/v1/me",
    guards: "CRED-2",
    why: "the same crossCheck on the same request as the harness smoke, which stays",
    coveredBy: [LIVE_PAT[0] as Citation, CROSS_FAILS],
  },
  {
    file: "live/credentials.test.ts",
    name: "credentials > A's session cookie at B: replayed on B's app host",
    guards: "CRED-1",
    why: "the same crossCheck on the same request as the harness smoke, which stays",
    coveredBy: [
      {
        file: GUARD,
        describe: HARNESS,
        test: "A's session cookie at B: /api/v1/me",
      },
      CROSS_FAILS,
    ],
  },
  {
    file: "live/credentials.test.ts",
    name: "credentials > A's admin PAT at B: /api/v1/artifacts",
    guards: "CRED-2",
    why: "A's PAT is refused in resolveSession before the list route runs; the matrix runs the foreign PAT on the list route on every PR, and the live PAT smokes stay",
    coveredBy: [...FOREIGN_PAT_ON_DATA, ...LIVE_PAT, CROSS_FAILS],
  },
  data("GET data/:col/:doc"),
  data("GET data/:col (list)"),
  data("POST data/:col/query"),
  data("PUT data/:col/:doc: refused, and B's doc is unchanged"),
  data("PATCH data/:col/:doc: refused, and B's doc is unchanged"),
  data("DELETE data/:col/:doc: refused, and B's doc is unchanged"),
  data("PUT data (reset): refused, and B's data is unchanged"),
  data("GET storage (list)"),
  data("GET storage/:key"),
  data("PUT storage/:key: refused, and B's key is unchanged"),
  data("DELETE storage/:key: refused, and B's key is unchanged"),
  // Cloud #264 step 2: the cases the red-line page moves to PR CI or deletes.
  ...SPLIT_RETIRED,
];

/**
 * What's wrong with the retired list: a retired case back in the manifest
 * (by file and name), a duplicate, or a citation that doesn't resolve. Empty
 * when every retired case is out and accounted for.
 */
/** One describe or test declaration of a test file, with whether it is enabled. */
export interface Decl {
  kind: "describe" | "test";
  name: string;
  /** Its own modifier skips it: .skip, .todo, .skipIf, .runIf, or an x- name. */
  skipped: boolean;
  indent: number;
  parent: Decl | undefined;
}

/** Modifiers that disable a declaration, or make it run only sometimes. */
const DISABLING = new Set(["skip", "todo", "skipIf", "runIf"]);

/**
 * The describe and test declarations of a vitest (or Playwright) file, nested
 * by indentation, each with its literal title and whether its own modifiers
 * disable it. `describe.each(rows)("$name", ...)` and similar keep their
 * template title. Formatted source (biome) is assumed: one declaration per
 * line start.
 */
export function declarations(text: string): Decl[] {
  const out: Decl[] = [];
  const stack: Decl[] = [];
  const head = /^([ \t]*)(x?describe|x?it|test)\b/gm;
  for (let m = head.exec(text); m; m = head.exec(text)) {
    const indent = (m[1] as string).length;
    const word = m[2] as string;
    let i = m.index + m[0].length;
    const mods: string[] = [];
    let name: string | undefined;
    // Modifiers (.skip, .each, .concurrent...), then argument groups, until
    // the group whose first argument is the title string.
    for (let guard = 0; guard < 20 && name === undefined; guard++) {
      const dot = /^\.(\w+)/.exec(text.slice(i));
      if (dot) {
        mods.push(dot[1] as string);
        i += dot[0].length;
        continue;
      }
      if (text[i] !== "(") break;
      const lit = /^\(\s*(["'`])/.exec(text.slice(i));
      if (lit) {
        const q = lit[1] as string;
        const start = i + lit[0].length;
        let j = start;
        while (j < text.length && text[j] !== q) j += text[j] === "\\" ? 2 : 1;
        name = text.slice(start, j).replace(/\\(["'`\\])/g, "$1");
        break;
      }
      // A balanced argument group (each's rows, skipIf's condition).
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        const ch = text[j] as string;
        if (ch === '"' || ch === "'" || ch === "`") {
          j++;
          while (j < text.length && text[j] !== ch)
            j += text[j] === "\\" ? 2 : 1;
          continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")" && --depth === 0) break;
      }
      i = j + 1;
    }
    if (name === undefined) continue;
    while (stack.length && (stack.at(-1) as Decl).indent >= indent) stack.pop();
    const d: Decl = {
      kind: word.endsWith("describe") ? "describe" : "test",
      name,
      skipped: word.startsWith("x") || mods.some((x) => DISABLING.has(x)),
      indent,
      parent: stack.at(-1),
    };
    out.push(d);
    if (d.kind === "describe") stack.push(d);
  }
  return out;
}

/** True when `d` or any describe above it is disabled. */
const disabled = (d: Decl | undefined): boolean =>
  d !== undefined && (d.skipped || disabled(d.parent));

/**
 * What's wrong with one citation's test in its file's text: it must be a
 * declared test under a describe of that title (anywhere up its chain), and
 * not disabled there or above (.skip, .todo, .skipIf, .runIf, x-). Empty when
 * an enabled one exists.
 */
export function citedTestGaps(
  who: string,
  c: { file: string; describe: string; test?: string },
  text: string,
): string[] {
  if (!c.test) return [];
  const hits = declarations(text).filter((d) => {
    if (d.kind !== "test" || d.name !== c.test) return false;
    for (let p = d.parent; p; p = p.parent)
      if (p.name === c.describe) return true;
    return false;
  });
  if (hits.length === 0)
    return [`${who}: no test "${c.test}" under "${c.describe}" in ${c.file}`];
  if (hits.every((d) => disabled(d)))
    return [`${who}: the cited test "${c.test}" in ${c.file} is skipped`];
  return [];
}

/** The public CI that runs the matrix once more with hosted settings (#3158). */
export const HOSTED_MATRIX_CI = {
  file: ".github/workflows/ci.yml",
  text: "test:authz:hosted",
} as const;

const truthy = (v: unknown) => v === true || v === "true";

/** The workflow's events: `on` as a string, a list or a map. */
function eventsOf(on: unknown): Set<string> {
  if (typeof on === "string") return new Set([on]);
  if (Array.isArray(on)) return new Set(on.map(String));
  if (on && typeof on === "object") return new Set(Object.keys(on));
  return new Set();
}

/** The one step that runs the hosted matrix: exactly this run, nothing else. */
export const HOSTED_MATRIX_STEP = "pnpm --filter @oa/server test:authz:hosted";
/**
 * The one condition public's step may carry: its release-only skip, which
 * skips only when the change touches nothing but release files. Any other
 * condition (an event check, false) fails the guard.
 */
export const HOSTED_MATRIX_IF =
  "${{ steps.ro.outputs.release_only != 'true' }}";

/**
 * What keeps public's CI from running the hosted matrix as a blocking check
 * on every PR, read as YAML, matched exactly and never by pattern: the
 * workflow runs on pull_request and merge_group, and a job with no
 * job-level condition and no continue-on-error has a step whose run, once
 * trimmed, is exactly HOSTED_MATRIX_STEP (one line, no other text, so no
 * operator, pipe, subshell or second command), with no continue-on-error,
 * and no condition but exactly HOSTED_MATRIX_IF. Empty when one does.
 */
export function hostedMatrixCiGaps(text: string | null): string[] {
  const why = (s: string) => [
    `${HOSTED_MATRIX_CI.file}: ${s}: the matrix's hosted run is not a blocking PR check`,
  ];
  if (text === null) return why("unreadable");
  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(text) as Record<string, unknown>;
  } catch {
    return why("not YAML");
  }
  const events = eventsOf(doc?.on);
  for (const e of ["pull_request", "merge_group"])
    if (!events.has(e)) return why(`no ${e} trigger`);
  const jobs = (doc.jobs ?? {}) as Record<string, Record<string, unknown>>;
  for (const job of Object.values(jobs)) {
    // A job-level condition can leave PRs out (an event check) or never run.
    if (!job || job.if !== undefined || truthy(job["continue-on-error"]))
      continue;
    for (const st of (job.steps ?? []) as Record<string, unknown>[]) {
      if (typeof st?.run !== "string" || st.run.trim() !== HOSTED_MATRIX_STEP)
        continue;
      if (st["continue-on-error"] !== undefined) continue;
      if (st.if !== undefined && st.if !== HOSTED_MATRIX_IF) continue;
      return [];
    }
  }
  return why(`no blocking step runs ${HOSTED_MATRIX_CI.text}`);
}

export function retiredGaps(
  manifest: readonly { file: string; name: string }[],
  read: (repoPath: string) => string | null,
): string[] {
  const key = (x: { file: string; name: string }) => `${x.file} > ${x.name}`;
  const listed = new Set(manifest.map(key));
  const seen = new Set<string>();
  const gaps: string[] = [];
  for (const r of RETIRED) {
    if (listed.has(key(r))) gaps.push(`retired but still required: ${key(r)}`);
    if (seen.has(key(r))) gaps.push(`retired twice: ${key(r)}`);
    seen.add(key(r));
    if (r.guards !== "none" && !/^[A-Z]+-\d+$/.test(r.guards))
      gaps.push(`${key(r)}: guards no failure-model id (${r.guards})`);
  }
  // Cloud #264 step 2: every citation names its replacing test, never a file
  // or a describe alone; a surface citation's parameter must still be in the
  // matrix's table (src/retired-split.ts surfaceCiteGaps).
  for (const r of RETIRED)
    for (const c of r.coveredBy) {
      if (!c.test)
        gaps.push(
          `${key(r)}: a citation names no test (${c.file} "${c.describe}")`,
        );
      const each = (c as Partial<SurfaceCite>).each;
      if (each) gaps.push(...surfaceCiteGaps(key(r), c as SurfaceCite));
      // A skipped test is no replacement, nor one under a skipped describe.
      const text = read(c.file);
      if (text !== null) gaps.push(...citedTestGaps(key(r), c, text));
    }
  // The hosted matrix run must still be in public's CI for its citations.
  if (RETIRED.some((r) => r.coveredBy.some((c) => c.file === MATRIX)))
    gaps.push(...hostedMatrixCiGaps(read(HOSTED_MATRIX_CI.file)));
  return [
    ...gaps,
    ...resolveCitations(
      RETIRED.map((r) => [key(r), r.coveredBy] as const),
      read,
    ),
  ];
}
