import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN } from "../src/lanes.ts";
import {
  ACCEPTED_UNPROVEN,
  buildReport,
  type CaseResult,
  exitCode,
  gateOn,
  gatePasses,
  parseManifest,
} from "../src/report.ts";
import { MAX_RETRIED_CASES } from "../src/retry.ts";
import {
  ACCEPTED_UNPROVEN_ADDED_SINCE_1730,
  CASES_ADDED_SINCE_1730,
} from "./cases-added.ts";

// #1730 changes when and beside what the cases run, never which cases there
// are or what passes. test/fixtures/main-cases.json is main's required cases
// and pass bar at the base of the change: this test holds the suite to them.
interface Main {
  manifest: { file: string; name: string }[];
  acceptedUnproven: { name: string; reason: string; file: string }[];
  maxRetriedCases: number;
}
const main = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/main-cases.json"), "utf8"),
) as Main;
const pkg = join(import.meta.dirname, "..");

const read = (f: string) => readFileSync(join(pkg, f), "utf8");

describe("the same cases", () => {
  it("manifest.json holds exactly main's 329 cases, in main's order, plus the declared additions", () => {
    const m = parseManifest(read("live/manifest.json"));
    const all = m.cases.map((c) => ({ file: c.file, name: c.name }));
    const key = (c: { file: string; name: string }) =>
      `${c.file}\u0000${c.name}`;
    const added = new Set(CASES_ADDED_SINCE_1730.map(key));
    const base = new Set(main.manifest.map(key));
    expect(main.manifest).toHaveLength(329);
    expect(added.size).toBe(CASES_ADDED_SINCE_1730.length);
    // Every declared addition is in the manifest and not already main's.
    for (const k of added) {
      expect(all.map(key)).toContain(k);
      expect(base.has(k)).toBe(false);
    }
    expect(all.filter((c) => !added.has(key(c)))).toEqual(main.manifest);
  });

  it("every manifest case runs in a lane, and the plan runs no file outside the manifest", () => {
    const files = new Set(
      [...main.manifest, ...CASES_ADDED_SINCE_1730].map((c) => c.file),
    );
    const lanes = new Set(PLAN.flat().flatMap((l) => l.files));
    expect(lanes).toEqual(files);
  });

  it("the static test titles of each live file are unchanged in count and names", () => {
    // Enumerate the literal `it("...")` titles of the live files statically
    // (the surfaces list is derived at run time from Backend's tables and is
    // held by the manifest above). A title missing from the manifest, or one
    // the manifest names that no file can produce, is a change of cases.
    const manifestNames = new Set(
      main.manifest.map((c) => `${c.file}\u0000${c.name}`),
    );
    const files = [...new Set(main.manifest.map((c) => c.file))].filter(
      (f) => f !== "live/surfaces.test.ts" && f !== "live/provisioning.test.ts",
    );
    let literal = 0;
    for (const f of files) {
      const text = read(f);
      for (const m of text.matchAll(/\bit\(\s*(["`])((?:\\.|(?!\1).)*)\1/g)) {
        if ((m[2] as string).includes("${")) continue;
        literal++;
        const name = (m[2] as string).replace(/\\(["'`\\])/g, "$1");
        const hit = [...manifestNames].some((k) => {
          const [file, n = ""] = k.split("\u0000");
          return file === f && n.endsWith(name);
        });
        expect(hit, `${f}: "${name}" is not a manifest case`).toBe(true);
      }
    }
    expect(literal).toBeGreaterThan(30);
  });
});

describe("the same pass bar", () => {
  it("ACCEPTED_UNPROVEN is main's four entries plus exactly the declared additions, by name, reason and file", () => {
    expect(
      ACCEPTED_UNPROVEN.map((e) => ({
        name: e.name,
        reason: e.reason,
        file: e.file,
      })),
    ).toEqual([
      ...main.acceptedUnproven,
      ...ACCEPTED_UNPROVEN_ADDED_SINCE_1730,
    ]);
    expect(main.acceptedUnproven).toHaveLength(4);
    expect(ACCEPTED_UNPROVEN_ADDED_SINCE_1730).toHaveLength(2);
  });

  it("MAX_RETRIED_CASES is 5 and the gate is read from --gate or REDLINE_GATE=1", () => {
    expect(MAX_RETRIED_CASES).toBe(main.maxRetriedCases);
    expect(MAX_RETRIED_CASES).toBe(5);
    expect(gateOn(["--gate"], {})).toBe(true);
    expect(gateOn([], { REDLINE_GATE: "1" })).toBe(true);
    expect(gateOn([], { REDLINE_GATE: "0" })).toBe(false);
  });

  const pass = (name: string): CaseResult => ({ name, level: "pass" });
  it("gatePasses: every case passes, or is an accepted unproven one by name and reason", () => {
    expect(gatePasses([])).toBe(false);
    expect(gatePasses([pass("a"), pass("b")])).toBe(true);
    for (const level of [
      "fail",
      "infra",
      "unproven-live",
      "staging-only",
    ] as const)
      expect(gatePasses([pass("a"), { name: "b", level }]), level).toBe(false);
    const a = main.acceptedUnproven[0];
    if (!a) throw new Error("no accepted entry");
    const acc: CaseResult = {
      name: a.name,
      file: `live/${a.file}`,
      level: "unproven-live",
      reason: a.reason,
    };
    expect(gatePasses([pass("x"), acc])).toBe(true);
    expect(gatePasses([pass("x"), { ...acc, reason: "another reason" }])).toBe(
      false,
    );
  });

  it("exitCode: a fail or infra case fails the run, a gated non-pass fails it, a lane's exit stands", () => {
    const ok = buildReport([pass("a")], "staging");
    expect(exitCode(ok, true, 0)).toBe(0);
    expect(exitCode(ok, true, 7)).toBe(7);
    const bad = buildReport(
      [pass("a"), { name: "b", level: "fail", reason: "x" }],
      "staging",
    );
    expect(exitCode(bad, false, 0)).not.toBe(0);
    const inf = buildReport(
      [pass("a"), { name: "b", level: "infra", reason: "x" }],
      "staging",
    );
    expect(exitCode(inf, false, 0)).not.toBe(0);
    const unp = buildReport(
      [pass("a"), { name: "b", level: "unproven-live", reason: "x" }],
      "staging",
    );
    expect(exitCode(unp, false, 0)).toBe(0);
    expect(exitCode(unp, true, 0)).not.toBe(0);
    expect(exitCode(null, true, 0)).toBe(1);
  });
});
