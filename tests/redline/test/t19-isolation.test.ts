import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// credentials' link cases compare rl-b's whole member list (and the member
// user's shares and artifacts) before and after. The plan (#1730) runs T19 and
// surfaces beside it, so neither may read or write that state: T19 stays on
// rl-a, and surfaces' org-level read cases judge a status, never a list body.
const root = join(import.meta.dirname, "../../..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("T19 targets only rl-a", () => {
  const files = [
    "apps/dashboard/playwright.staging.config.ts",
    "apps/dashboard/e2e/staging/targets.ts",
    "apps/dashboard/e2e/staging/gate.ts",
    "apps/dashboard/e2e/staging/hook-pace.ts",
  ];

  it("its config and targets name rl-a (and leo, anonymously), never rl-b", () => {
    const targets = read("apps/dashboard/e2e/staging/targets.ts");
    expect(targets).toMatch(/a\.name !== "rl-a"/);
    // Only REDLINE_TARGETS.a is read: no `.b` and no RL_B secret file.
    expect(targets).not.toMatch(/\bt\.b\b|raw\(\)\.b\b|REDLINE_RL_B|rl-b/i);
    for (const f of files)
      expect(read(f), f).not.toMatch(/rl-b|RL_B_|REDLINE_RL_B/i);
  });

  it("no T19 spec reaches rl-b or its members", () => {
    for (const dir of ["rl-a", "leo"])
      for (const f of readdirSync(
        join(root, "apps/dashboard/e2e/staging", dir),
      )) {
        const t = read(`apps/dashboard/e2e/staging/${dir}/${f}`);
        expect(t, `${dir}/${f}`).not.toMatch(/rl-b|RL_B_|REDLINE_RL_B/i);
      }
  });
});

describe("surfaces' org-level read cases check a status, never a list body", () => {
  it("the case builder hands every org read to the public probe and parses no body itself", () => {
    const s = read("tests/redline/src/surfaces.ts");
    const block = s.slice(
      s.indexOf("for (const s of ORG_SURFACES)"),
      s.indexOf("for (const s of SPACE_SURFACES)"),
    );
    expect(block.length).toBeGreaterThan(500);
    expect(block).toMatch(/s\.probe\(/);
    expect(block).not.toMatch(
      /JSON\.parse|\.json\(\)|\.text\(\)|readBody|getJson|toEqual/,
    );
  });

  it("the public probe's GET branch classifies by status and error code only", () => {
    const p = read("apps/server/test/authz/surfaces.ts");
    const start = p.indexOf("function orgProbe(");
    const get = p.slice(
      p.indexOf('if (method === "GET")', start),
      p.indexOf("if (!w) throw", start),
    );
    expect(get).toMatch(/classify\(route, r,/);
    expect(get).toMatch(/status\(\.\.\.okStatus\)/);
    expect(get).not.toMatch(/JSON\.parse|\.body\b|members/);
  });

  it("the member-list compare stays in credentials, under the exclusive lock", () => {
    const c = read("tests/redline/live/credentials.test.ts");
    expect(c).toMatch(/const memberList = async/);
    expect((c.match(/withLock\(MEMBERS_LOCK, "exclusive"/g) ?? []).length).toBe(
      2,
    );
    // No other live file or surfaces helper compares rl-b's whole member list.
    for (const f of [
      "live/surfaces.test.ts",
      "live/edge.test.ts",
      "live/signin.test.ts",
      "src/surfaces.ts",
    ]) {
      const t = read(`tests/redline/${f}`);
      expect(t, f).not.toMatch(
        /memberList|"\/api\/v1\/members"\)[\s\S]{0,80}toEqual/,
      );
    }
  });
});
