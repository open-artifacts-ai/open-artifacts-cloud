import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PLANS, Refused, run } from "./stripe-prices.ts";

const KEY = "sk_test_FAKEfakeFAKEfake0123";
const ENV = {
  STRIPE_SECRET_KEY: KEY,
  STRIPE_PRICE_TEAM: "price_teamM",
  STRIPE_PRICE_BUSINESS: "price_bizM",
};

type Call = { method: string; path: string; form: Record<string, string> };

function world(
  existing: Record<string, Record<string, unknown>> = {},
  monthly: Record<string, unknown> = {},
) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    const method = String(init.method);
    const form = Object.fromEntries(
      new URLSearchParams(String(init.body ?? "")),
    );
    calls.push({ method, path, form });
    const json = (o: unknown) =>
      new Response(JSON.stringify(o), { status: 200 });
    if (method === "GET" && path.startsWith("/v1/prices?")) {
      const k = u.searchParams.get("lookup_keys[]") ?? "";
      return json({ data: existing[k] ? [existing[k]] : [] });
    }
    if (method === "GET") return json({ product: "prod_1", ...monthly });
    return json({ id: `price_new_${form.lookup_key}` });
  }) as unknown as typeof fetch;
  return { calls, logs, io: { fetch: f, log: (s: string) => logs.push(s) } };
}

const good = (key: string, cents: number) => ({
  id: `price_old_${key}`,
  unit_amount: cents,
  currency: "usd",
  billing_scheme: "per_unit",
  product: "prod_1",
  recurring: { interval: "year", interval_count: 1, usage_type: "licensed" },
});

describe("stripe-prices", () => {
  it("plans are $100 Team and $250 Business per year", () => {
    expect(PLANS.map((p) => [p.lookupKey, p.cents])).toEqual([
      ["oa_team_yearly", 10000],
      ["oa_business_yearly", 25000],
    ]);
  });

  it("creates the missing prices on the monthly price's product", async () => {
    const w = world();
    const ids = await run(ENV, w.io);
    expect(ids).toEqual({
      STRIPE_PRICE_TEAM_YEARLY: "price_new_oa_team_yearly",
      STRIPE_PRICE_BUSINESS_YEARLY: "price_new_oa_business_yearly",
    });
    const posts = w.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.form)).toEqual([
      {
        currency: "usd",
        unit_amount: "10000",
        "recurring[interval]": "year",
        product: "prod_1",
        lookup_key: "oa_team_yearly",
        nickname: "Team (yearly, per creator)",
      },
      {
        currency: "usd",
        unit_amount: "25000",
        "recurring[interval]": "year",
        product: "prod_1",
        lookup_key: "oa_business_yearly",
        nickname: "Business (yearly, per creator)",
      },
    ]);
    expect(w.logs.join("\n")).not.toContain(KEY);
  });

  it("finds existing prices and creates nothing", async () => {
    const w = world({
      oa_team_yearly: good("team", 10000),
      oa_business_yearly: good("biz", 25000),
    });
    const ids = await run(ENV, w.io);
    expect(ids.STRIPE_PRICE_TEAM_YEARLY).toBe("price_old_team");
    expect(ids.STRIPE_PRICE_BUSINESS_YEARLY).toBe("price_old_biz");
    expect(w.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("creates only the one that is missing", async () => {
    const w = world({ oa_team_yearly: good("team", 10000) });
    await run(ENV, w.io);
    expect(
      w.calls.filter((c) => c.method === "POST").map((c) => c.form.lookup_key),
    ).toEqual(["oa_business_yearly"]);
  });

  it("refuses an existing price with the wrong amount", async () => {
    const w = world({ oa_team_yearly: good("team", 9999) });
    await expect(run(ENV, w.io)).rejects.toThrow(Refused);
  });

  it("refuses an existing price that differs in any way, never reusing it", async () => {
    const base = good("team", 10000);
    for (const [field, over] of [
      [
        "interval_count",
        { recurring: { ...base.recurring, interval_count: 2 } },
      ],
      [
        "usage_type",
        { recurring: { ...base.recurring, usage_type: "metered" } },
      ],
      ["interval", { recurring: { ...base.recurring, interval: "month" } }],
      ["product", { product: "prod_other" }],
      ["currency", { currency: "eur" }],
      ["billing_scheme", { billing_scheme: "tiered" }],
      ["tax_behavior", { tax_behavior: "inclusive" }],
    ] as const) {
      const w = world({ oa_team_yearly: { ...base, ...over } });
      await expect(run(ENV, w.io)).rejects.toThrow(new RegExp(field));
      expect(w.calls.some((c) => c.method === "POST")).toBe(false);
    }
  });

  it("copies the monthly price's tax behavior on create, and matches it when found", async () => {
    const w = world({}, { tax_behavior: "exclusive" });
    await run(ENV, w.io);
    const posts = w.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    for (const c of posts) expect(c.form.tax_behavior).toBe("exclusive");
    const f = world(
      {
        oa_team_yearly: { ...good("team", 10000), tax_behavior: "exclusive" },
        oa_business_yearly: {
          ...good("biz", 25000),
          tax_behavior: "exclusive",
        },
      },
      { tax_behavior: "exclusive" },
    );
    await expect(run(ENV, f.io)).resolves.toBeTruthy();
    const u = world(
      { oa_team_yearly: good("team", 10000) },
      { tax_behavior: "exclusive" },
    );
    await expect(run(ENV, u.io)).rejects.toThrow(/tax_behavior/);
  });

  it("refuses a live or non-test key before any request", async () => {
    for (const k of [
      "sk_live_abcdefgh12345678",
      "rk_live_abcdefgh12345678",
      "",
    ]) {
      const w = world();
      await expect(run({ ...ENV, STRIPE_SECRET_KEY: k }, w.io)).rejects.toThrow(
        /test-mode key/,
      );
      expect(w.calls).toEqual([]);
    }
  });

  it("refuses a malformed monthly price id", async () => {
    const w = world();
    await expect(
      run({ ...ENV, STRIPE_PRICE_TEAM: "prod_1" }, w.io),
    ).rejects.toThrow(/STRIPE_PRICE_TEAM/);
  });

  it("dry run looks but never writes", async () => {
    const w = world();
    const ids = await run({ ...ENV, DRY_RUN: "1" }, w.io);
    expect(ids).toEqual({});
    expect(w.calls.every((c) => c.method === "GET")).toBe(true);
    expect(w.logs.join("\n")).toContain("dry run");
  });
});

describe("staging-stripe-prices.yml", () => {
  // biome-ignore lint/suspicious/noExplicitAny: untyped workflow YAML
  const w: any = parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../.github/workflows/staging-stripe-prices.yml",
      ),
      "utf8",
    ),
  );
  it("is dispatch only, staging only, main only", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual(["dry_run"]);
    expect(w.permissions).toEqual({ contents: "read" });
    expect(w.jobs.prices.environment).toBe("hosted-staging-deploy");
    expect(w.jobs.prices.steps[0].run).toContain("refs/heads/main");
  });
});
