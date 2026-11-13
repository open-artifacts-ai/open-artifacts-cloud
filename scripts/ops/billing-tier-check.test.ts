import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tierProblems } from "./billing-tier-check.ts";

// Prod's BILLING bind guard: every active install's rendered vars need a TIER.
const root = join(import.meta.dirname, "../..");
const row = (id: string, vars: unknown, state = "active") => ({
  id,
  slug: `slug-${id}`,
  state,
  vars,
});

describe("tierProblems", () => {
  it("passes installs whose rendered vars carry trial, team or business", () => {
    expect(
      tierProblems([
        row("ia", JSON.stringify({ TIER: "trial" })),
        row("ib", JSON.stringify({ TIER: "team", OTHER: "x" })),
        row("ic", JSON.stringify({ TIER: "business" })),
      ]),
    ).toEqual([]);
  });
  it("refuses an active install with no TIER, naming it", () => {
    const p = tierProblems([
      row("ia", JSON.stringify({ TIER: "trial" })),
      row("ib", JSON.stringify({ FEATURES: "a,b" })),
    ]);
    expect(p).toEqual([
      "install ib (slug-ib): its rendered vars have no valid TIER",
    ]);
  });
  it("fails closed: an empty, unknown or non-string TIER, and missing, null, non-JSON or non-object vars all refuse", () => {
    const bad = [
      JSON.stringify({ TIER: "" }),
      JSON.stringify({ TIER: "free" }),
      JSON.stringify({ TIER: 3 }),
      JSON.stringify({ TIER: null }),
      "{not json",
      "[]",
      "null",
      null,
      undefined,
    ];
    for (const [i, vars] of bad.entries())
      expect(tierProblems([row(`i${i}`, vars)]), String(vars)).toHaveLength(1);
  });
  it("ignores installs that are not active", () => {
    expect(
      tierProblems([row("ia", "{}", "deleted"), row("ib", null, "suspended")]),
    ).toEqual([]);
  });
  it("never prints a var value", () => {
    const p = tierProblems([
      row("ia", JSON.stringify({ SESSION_SECRET: "NEVERAPPEAR" })),
    ]);
    expect(p.join("\n")).not.toContain("NEVERAPPEAR");
  });
});

describe("the script", () => {
  it("refuses before any call: not prod, no token, a bad account or database id", () => {
    const base = {
      PATH: process.env.PATH ?? "",
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "26ac346086d4405f7a976d48747a2a75",
      PLATFORM_DB_ID: "6ca9103e-507e-4541-b3bb-2485e699512b",
    };
    const exec = (arg: string, env: Record<string, string>) =>
      spawnSync(
        "node",
        [
          "--experimental-strip-types",
          "--no-warnings",
          join(root, "scripts/ops/billing-tier-check.ts"),
          arg,
        ],
        { env, encoding: "utf8" },
      );
    expect(exec("staging", base).status).toBe(2);
    expect(exec("prod", { ...base, CLOUDFLARE_API_TOKEN: "" }).status).toBe(2);
    expect(exec("prod", { ...base, CLOUDFLARE_ACCOUNT_ID: "x" }).status).toBe(
      2,
    );
    expect(exec("prod", { ...base, PLATFORM_DB_ID: "x" }).status).toBe(2);
  });
});
