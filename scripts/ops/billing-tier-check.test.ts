import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tierProblemCount } from "./billing-tier-check.ts";

// Prod's BILLING bind guard: every active install's rendered vars need a TIER.
// The cloud repo's Actions logs are public: only a count is ever printed.
const root = join(import.meta.dirname, "../..");
const row = (id: string, vars: unknown, state = "active") => ({
  id,
  slug: `slug-${id}`,
  state,
  vars,
});

describe("tierProblemCount", () => {
  it("counts none for installs whose rendered vars carry trial, team or business", () => {
    expect(
      tierProblemCount([
        row("ia", JSON.stringify({ TIER: "trial" })),
        row("ib", JSON.stringify({ TIER: "team", OTHER: "x" })),
        row("ic", JSON.stringify({ TIER: "business" })),
      ]),
    ).toBe(0);
  });
  it("counts an active install with no TIER", () => {
    expect(
      tierProblemCount([
        row("ia", JSON.stringify({ TIER: "trial" })),
        row("ib", JSON.stringify({ FEATURES: "a,b" })),
        row("ic", JSON.stringify({})),
      ]),
    ).toBe(2);
  });
  it("fails closed: an empty, unknown or non-string TIER, and missing, null, non-JSON or non-object vars all count", () => {
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
      expect(tierProblemCount([row(`i${i}`, vars)]), String(vars)).toBe(1);
  });
  it("ignores deleted and deleting installs", () => {
    expect(
      tierProblemCount([
        row("ia", "{}", "deleted"),
        row("ib", null, "deleting"),
      ]),
    ).toBe(0);
  });
  it("refuses a suspended, upgrading, failed or provisioning install without a TIER", () => {
    for (const state of ["suspended", "upgrading", "failed", "provisioning"])
      expect(tierProblemCount([row("ia", "{}", state)]), state).toBe(1);
  });
  it("passes a deleted install without TIER next to a suspended one with TIER", () => {
    expect(
      tierProblemCount([
        row("ia", null, "deleted"),
        row("ib", JSON.stringify({ TIER: "team" }), "suspended"),
      ]),
    ).toBe(0);
  });
});

describe("the script", () => {
  const exec = (
    arg: string,
    env: Record<string, string>,
    args: string[] = [],
  ) =>
    spawnSync(
      "node",
      [
        "--experimental-strip-types",
        "--no-warnings",
        ...args,
        join(root, "scripts/ops/billing-tier-check.ts"),
        arg,
      ],
      { env, encoding: "utf8" },
    );
  const base = {
    PATH: process.env.PATH ?? "",
    CLOUDFLARE_API_TOKEN: "t",
    CLOUDFLARE_ACCOUNT_ID: "26ac346086d4405f7a976d48747a2a75",
    PLATFORM_DB_ID: "6ca9103e-507e-4541-b3bb-2485e699512b",
  };

  it("refuses before any call: not prod, no token, a bad account or database id", () => {
    expect(exec("staging", base).status).toBe(2);
    expect(exec("prod", { ...base, CLOUDFLARE_API_TOKEN: "" }).status).toBe(2);
    expect(exec("prod", { ...base, CLOUDFLARE_ACCOUNT_ID: "x" }).status).toBe(
      2,
    );
    expect(exec("prod", { ...base, PLATFORM_DB_ID: "x" }).status).toBe(2);
  });

  // D1 answered by a preloaded fetch stub: the run prints a count and the
  // pointer to oa-admin-prod, and no install id, slug or var value.
  const withRows = (rows: unknown[]) => {
    const dir = mkdtempSync(join(tmpdir(), "tier-check-"));
    const stub = join(dir, "stub.mjs");
    writeFileSync(
      stub,
      `globalThis.fetch = async () => Response.json({ success: true, result: [{ success: true, results: ${JSON.stringify(rows)} }] });`,
    );
    return stub;
  };
  it("a refusal prints no number, id, slug or var value, only the pointer to oa-admin-prod", () => {
    const stub = withRows([
      row("iSECRETidAAAA", JSON.stringify({ TIER: "trial" })),
      row(
        "iSECRETidBBBB",
        JSON.stringify({ SESSION_SECRET: "NEVERAPPEARvalue" }),
      ),
      row("iSECRETidCCCC", null),
    ]);
    const r = exec("prod", base, ["--import", stub]);
    expect(r.status).toBe(1);
    const all = r.stdout + r.stderr;
    expect(all).toContain(
      "refusing: a live install has no valid TIER; read the list with oa-admin-prod",
    );
    expect(all).not.toMatch(/\d/);
    expect(all).toContain("oa-admin-prod");
    for (const s of ["iSECRETid", "slug-", "NEVERAPPEARvalue"])
      expect(all).not.toContain(s);
  });
  it("passes and prints no names when every active install has a TIER", () => {
    const stub = withRows([
      row("iSECRETidAAAA", JSON.stringify({ TIER: "team" })),
    ]);
    const r = exec("prod", base, ["--import", stub]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("billing bind check: ok");
    expect(r.stdout + r.stderr).not.toContain("iSECRETid");
    expect(r.stdout + r.stderr).not.toContain("slug-");
  });
  it("fails closed when D1 cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "tier-check-"));
    const stub = join(dir, "stub.mjs");
    writeFileSync(
      stub,
      `globalThis.fetch = async () => { throw new Error("net"); };`,
    );
    const r = exec("prod", base, ["--import", stub]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("fail closed");
  });
});
