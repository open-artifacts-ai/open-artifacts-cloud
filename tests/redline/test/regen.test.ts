import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, hintsFor } from "../scripts/redline-regen.ts";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  regenAll,
  regenCasesAdded,
  regenCounts,
  regenManifest,
  SURFACE_PREFIX,
  SURFACES_FILE,
  validatePlan,
} from "../src/regen.ts";

const P = SURFACE_PREFIX;
const s = (n: string) => ({ file: SURFACES_FILE, name: P + n });
const other = { file: "live/bus.test.ts", name: "bus > x" };
const manifest = (cases: unknown[]) =>
  `${JSON.stringify({ cases, notes: ["keep"] }, null, 2)}\n`;
const plan = (names: string[], denyOnly = 1, atB = 2) => ({
  names,
  denyOnly,
  atB,
});

describe("the committed files are what surfaces.ts gives (the pin bump's port check)", () => {
  it("manifest.json, cases-added.ts and the counts match, and every route is classified", async () => {
    const c = await check();
    // Each hint names a route and the list it goes in (tests/redline/src/surfaces.ts).
    expect(c.hints, "classify these routes in src/surfaces.ts").toEqual([]);
    expect(c.problems).toEqual([]);
    expect(
      c.differs,
      "run: cd tests/redline && node --experimental-strip-types --no-warnings scripts/redline-regen.ts write",
    ).toEqual([]);
    expect(c.gaps).toEqual([]);
  });
});

describe("regenManifest", () => {
  it("puts a new case right after the case before it in derive order, and is idempotent", () => {
    const text = manifest([other, s("a"), s("c"), other]);
    const r = regenManifest(text, plan(["a", "b", "c"]), []);
    expect(JSON.parse(r.text).cases).toEqual([
      other,
      s("a"),
      s("b"),
      s("c"),
      other,
    ]);
    expect(JSON.parse(r.text).notes).toEqual(["keep"]);
    expect(regenManifest(r.text, plan(["a", "b", "c"]), []).text).toBe(r.text);
  });

  it("puts a new first case before the first surfaces case", () => {
    const r = regenManifest(manifest([other, s("b")]), plan(["a", "b"]), []);
    expect(JSON.parse(r.text).cases).toEqual([other, s("a"), s("b")]);
  });

  it("removes a surfaces case derive stopped making, but never one the snapshot holds", () => {
    const text = manifest([s("a"), s("gone"), s("frozen")]);
    const r = regenManifest(text, plan(["a"]), [s("frozen")]);
    expect(JSON.parse(r.text).cases).toEqual([s("a"), s("frozen")]);
    expect(r.problems).toEqual([
      `the frozen snapshot holds a surfaces case derive() no longer makes: ${P}frozen`,
    ]);
  });

  it("leaves other files' cases alone", () => {
    const r = regenManifest(manifest([other]), plan(["a"]), []);
    expect(JSON.parse(r.text).cases).toEqual([other, s("a")]);
  });
});

const added = (body: string) =>
  `export const CASES_ADDED_SINCE_1730: readonly { file: string; name: string }[] =\n  [\n    // hand\n    ...[\n      "org old [pat]",\n    ].map((n) => ({\n      file: "live/surfaces.test.ts",\n      name: \`${P}\${n}\`,\n    })),\n${body}  ];\n`;

describe("regenCasesAdded", () => {
  const snap = [s("frozen")];
  const m = manifest([s("frozen"), s("org old [pat]"), s("new [session]")]);

  it("adds a generated block for the cases neither the snapshot nor the hand-written part holds", () => {
    const r = regenCasesAdded(added(""), m, snap);
    expect(r.problems).toEqual([]);
    expect(r.text).toContain(BLOCK_BEGIN);
    expect(r.text).toContain('      "new [session]",');
    expect(r.text).not.toContain('"frozen"');
    expect(r.text.match(/"org old \[pat\]"/g)).toHaveLength(1);
    expect(r.text.indexOf(BLOCK_END)).toBeLessThan(r.text.lastIndexOf("  ];"));
  });

  it("is idempotent, shrinks when the manifest does, and leaves no block when nothing is new", () => {
    const once = regenCasesAdded(added(""), m, snap).text;
    expect(regenCasesAdded(once, m, snap).text).toBe(once);
    const m2 = manifest([s("frozen"), s("org old [pat]")]);
    expect(regenCasesAdded(once, m2, snap).text).toBe(added(""));
  });

  it("reports a hand-declared case the manifest lacks, and unpaired markers throw", () => {
    const r = regenCasesAdded(added(""), manifest([s("frozen")]), snap);
    expect(r.problems).toEqual([
      "cases-added.ts declares a case the manifest lacks: org old [pat]",
    ]);
    expect(() =>
      regenCasesAdded(added(`    ${BLOCK_BEGIN}\n`), m, snap),
    ).toThrow(/unpaired/);
  });
});

describe("regenCounts", () => {
  const t = `expect(only).toHaveLength(43);\nexpect(by("atB").filter((c) => c.denyOnly)).toHaveLength(43);\nexpect(by("own")).toHaveLength(cases.length - 2 - 44);\n`;
  it("sets the deny-only count twice and the group-B own count", () => {
    expect(regenCounts(t, plan([], 47, 48))).toBe(
      t.replace(/43/g, "47").replace("44", "48"),
    );
  });
  it("throws when the test no longer has a count, so the script can't drift quietly", () => {
    expect(() => regenCounts("nothing", plan([]))).toThrow(
      /deny-only count; update src\/regen.ts/,
    );
  });
});

describe("validatePlan: a plan is data from another job", () => {
  it("takes a plain plan", () => {
    expect(validatePlan(plan(["org GET /api/v1/me/x/:id [pat]"]))).toEqual(
      plan(["org GET /api/v1/me/x/:id [pat]"]),
    );
  });
  it("refuses a name that could break out of a string literal, and bad counts", () => {
    for (const bad of ['a"b', "a`b", "a${b}", "a\nb", "", "x".repeat(301)])
      expect(() => validatePlan(plan([bad]))).toThrow(/plain text/);
    expect(() => validatePlan({ names: [], denyOnly: -1, atB: 0 })).toThrow(
      /count/,
    );
    expect(() => validatePlan(null)).toThrow(/names/);
  });
});

describe("hintsFor: the routes and the lists they need", () => {
  it("names an interactive-only route and the three lists", () => {
    const h = hintsFor(
      ["no case: PUT /api/v1/me/x"],
      ["PUT /api/v1/me/x"],
      [],
      [],
    );
    expect(h).toHaveLength(1);
    expect(h[0]).toMatch(
      /PUT \/api\/v1\/me\/x .*INTERACTIVE_ONLY and EXCLUDED_ROUTES.*"org PUT \/api\/v1\/me\/x" to DROPPED/,
    );
  });
  it("asks for a scan hit that INTERACTIVE_ONLY lacks, unless the test exempts it", () => {
    const h = hintsFor(
      [],
      ["GET /a", "GET /b", "GET /c"],
      ["GET /a"],
      ["GET /b"],
    );
    expect(h).toHaveLength(1);
    expect(h[0]).toContain("GET /c");
  });
  it("tells a non-interactive route to get a probe or a real-only drop", () => {
    const h = hintsFor(["no case: GET /api/v1/y"], [], [], []);
    expect(h[0]).toMatch(
      /GET \/api\/v1\/y .*not interactive-only.*real-only DROPPED/,
    );
  });
  it("names a drop DROPPED lacks, and passes other gaps through", () => {
    expect(
      hintsFor(
        ["drop not recorded in DROPPED: org GET /z (real-only)", "other gap"],
        [],
        [],
        [],
      ),
    ).toEqual([
      'add "org GET /z": { why: "real-only", coveredBy: [<Citation of the public test>] } to DROPPED in tests/redline/src/surfaces.ts',
      "other gap",
    ]);
  });
});

describe("regenAll", () => {
  it("regenerates the three files together", () => {
    const files = {
      manifest: manifest([s("frozen"), s("a")]),
      casesAdded: added(""),
      surfacesTest: `expect(only).toHaveLength(1);\nexpect(by("atB").filter((c) => c.denyOnly)).toHaveLength(1);\nexpect(by("own")).toHaveLength(cases.length - 2 - 2);\n`,
    };
    const r = regenAll(files, plan(["frozen", "a", "b"], 5, 6), [s("frozen")]);
    expect(r.files.manifest).toContain(`${P}b`);
    expect(r.files.casesAdded).toContain('"b",');
    expect(r.files.surfacesTest).toContain("toHaveLength(5)");
    expect(r.files.surfacesTest).toContain("2 - 6)");
  });
});

describe("scripts/redline-regen.ts apply (the bot's open job: no install, no public tree)", () => {
  const root = join(import.meta.dirname, "..");
  const run = (dir: string, planFile: string) =>
    spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        join(root, "scripts/redline-regen.ts"),
        "apply",
        "--plan",
        planFile,
        "--dir",
        dir,
      ],
      { encoding: "utf8" },
    );
  const tree = () => {
    const dir = mkdtempSync(join(tmpdir(), "regen-"));
    for (const f of [
      "live/manifest.json",
      "test/cases-added.ts",
      "test/surfaces.test.ts",
      "test/fixtures/main-cases.json",
    ]) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      cpSync(join(root, f), join(dir, f));
    }
    return dir;
  };

  it("adds a route's cases, counts and block from a plan, and a second apply changes nothing", () => {
    const dir = tree();
    try {
      const names = (
        JSON.parse(readFileSync(join(dir, "live/manifest.json"), "utf8")) as {
          cases: { file: string; name: string }[];
        }
      ).cases
        .filter((c) => c.file === SURFACES_FILE)
        .map((c) => c.name.slice(P.length));
      const planFile = join(dir, "plan.json");
      const p = plan(
        [...names, "org PUT /api/v1/me/new-thing [session]"],
        99,
        100,
      );
      writeFileSync(planFile, JSON.stringify({ plan: p }));
      const r = run(dir, planFile);
      expect(r.status, r.stderr).toBe(0);
      const m = readFileSync(join(dir, "live/manifest.json"), "utf8");
      expect(m).toContain("org PUT /api/v1/me/new-thing [session]");
      expect(readFileSync(join(dir, "test/cases-added.ts"), "utf8")).toContain(
        '"org PUT /api/v1/me/new-thing [session]",',
      );
      expect(
        readFileSync(join(dir, "test/surfaces.test.ts"), "utf8"),
      ).toContain("toHaveLength(99)");
      // The frozen snapshot is never written.
      expect(
        readFileSync(join(dir, "test/fixtures/main-cases.json"), "utf8"),
      ).toBe(readFileSync(join(root, "test/fixtures/main-cases.json"), "utf8"));
      const r2 = run(dir, planFile);
      expect(r2.status, r2.stderr).toBe(0);
      expect(readFileSync(join(dir, "live/manifest.json"), "utf8")).toBe(m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a plan with a name that isn't plain text, and writes nothing", () => {
    const dir = tree();
    try {
      const before = readFileSync(join(dir, "live/manifest.json"), "utf8");
      const planFile = join(dir, "plan.json");
      writeFileSync(
        planFile,
        JSON.stringify({ plan: plan(['x"; process.exit(0); "'], 1, 2) }),
      );
      const r = run(dir, planFile);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/plain text/);
      expect(readFileSync(join(dir, "live/manifest.json"), "utf8")).toBe(
        before,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
