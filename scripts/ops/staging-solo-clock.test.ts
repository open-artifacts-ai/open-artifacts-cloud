import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  advance,
  cleanup,
  type Io,
  Refused,
  stripeClient,
} from "./staging-solo-clock.ts";

const KEY = "sk_test_FAKEfakeFAKEfake0123";
const A = "iabc123def45";
const TRIAL_END = 1_800_000_000;

type Call = { method: string; path: string; form: Record<string, string> };

function world(over: { subStatus?: string; clockStatus?: string[] } = {}) {
  const calls: Call[] = [];
  const queries: string[] = [];
  const rows: Record<string, unknown>[] = [
    {
      stripe_customer_id: "cus_1",
      stripe_test_clock_id: "clock_1",
      stripe_subscription_id: "sub_1",
    },
  ];
  const clockStatuses = over.clockStatus ?? ["advancing", "ready"];
  let t = 0;
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    const form = Object.fromEntries(
      new URLSearchParams(String(init.body ?? "")),
    );
    const method = String(init.method);
    calls.push({ method, path, form });
    const j = (o: unknown) => Response.json(o);
    if (path === "/v1/customers/cus_1" && method === "GET")
      return j({ id: "cus_1", test_clock: "clock_1" });
    if (path === "/v1/subscriptions/sub_1" && method === "GET")
      return j({ status: over.subStatus ?? "trialing", trial_end: TRIAL_END });
    if (path.startsWith("/v1/subscriptions/sub_1?"))
      return j({
        status: "active",
        items: {
          data: [
            {
              price: {
                id: "price_solo",
                unit_amount: 100,
                currency: "usd",
                recurring: { interval: "month" },
              },
            },
          ],
        },
        latest_invoice: {
          id: "in_1",
          status: "paid",
          amount_paid: 100,
          currency: "usd",
        },
      });
    if (path === "/v1/test_helpers/test_clocks/clock_1" && method === "GET") {
      if (t === 0)
        return j({ status: "ready", frozen_time: TRIAL_END - 30 * 86400 });
      return j({
        status: clockStatuses[Math.min(t++ - 1, clockStatuses.length - 1)],
        frozen_time: TRIAL_END + 3600,
      });
    }
    if (path.endsWith("/advance")) {
      t = 1;
      return j({ status: "advancing" });
    }
    if (path.endsWith("/attach")) return j({ id: "pm_9" });
    if (path === "/v1/customers/cus_1") return j({ id: "cus_1" });
    if (path.startsWith("/v1/test_helpers/test_clocks?"))
      return j({
        data: [
          { id: "clock_orphan", name: A },
          { id: "clock_x", name: "other" },
        ],
      });
    if (method === "DELETE") return j({ deleted: true });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const io: Io & { lines: string[] } = {
    lines: [],
    fetch: f,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: (s) => io.lines.push(s),
    db: {
      all: async (sql) => {
        queries.push(sql);
        if (sql.includes("solo_status"))
          return [
            {
              tier: "solo",
              status: "active",
              solo_status: "active",
              version: 3,
            },
          ];
        return rows;
      },
      exec: async (sql) => {
        queries.push(sql);
      },
    },
  };
  let clock = 0;
  return { io, calls, queries, rows, call: stripeClient(KEY, f) };
}

describe("stripeClient", () => {
  it("refuses a key that is not a test key", () => {
    expect(() => stripeClient("sk_live_FAKEfakeFAKE0123", fetch)).toThrow(
      Refused,
    );
    expect(() => stripeClient("", fetch)).toThrow(Refused);
  });
});

describe("advance", () => {
  it("attaches the card, advances to trial_end + 1h, waits for ready, and prints the proof", async () => {
    const w = world();
    await advance(w.io, w.call, A);
    const paths = w.calls.map((c) => `${c.method} ${c.path}`);
    expect(
      paths.indexOf("POST /v1/payment_methods/pm_card_visa/attach"),
    ).toBeGreaterThan(-1);
    const adv = w.calls.find((c) => c.path.endsWith("/advance"));
    expect(adv?.form.frozen_time).toBe(String(TRIAL_END + 3600));
    const dflt = w.calls.find(
      (c) => c.path === "/v1/customers/cus_1" && c.method === "POST",
    );
    expect(dflt?.form["invoice_settings[default_payment_method]"]).toBe("pm_9");
    // card, then default, then advance, then the reads
    expect(paths.findIndex((p) => p.endsWith("/attach"))).toBeLessThan(
      paths.findIndex((p) => p.endsWith("/advance")),
    );
    const out = w.io.lines.join("\n");
    expect(out).toContain("subscription.status: active");
    expect(out).toContain("invoice.amount_paid: 100");
    expect(out).toContain("invoice.currency: usd");
    expect(out).toContain("price_solo unit_amount 100 usd per month");
    expect(out).toContain("PROOF OK");
    expect(out).not.toContain(KEY);
  });

  it("stops when the clock never gets ready (bounded)", async () => {
    const w = world({ clockStatus: ["advancing"] });
    await expect(advance(w.io, w.call, A)).rejects.toThrow(/not become ready/);
  });

  it("refuses when the install has no clock customer yet, before any Stripe write", async () => {
    const w = world();
    w.rows.length = 0;
    await expect(advance(w.io, w.call, A)).rejects.toThrow(/no clock customer/);
    expect(w.calls).toEqual([]);
  });

  it("refuses a subscription that is not trialing", async () => {
    const w = world({ subStatus: "active" });
    await expect(advance(w.io, w.call, A)).rejects.toThrow(/not trialing/);
    expect(w.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("cleanup", () => {
  it("deletes the install's clocks (stored and orphans, never another's), then resets the rows", async () => {
    const w = world();
    await cleanup(w.io, w.call, A);
    const del = w.calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(del.sort()).toEqual([
      "/v1/test_helpers/test_clocks/clock_1",
      "/v1/test_helpers/test_clocks/clock_orphan",
    ]);
    expect(w.queries.at(-1)).toBe(
      `DELETE FROM tiers WHERE install_id = '${A}'`,
    );
  });
});

describe("staging-solo-clock.yml", () => {
  // biome-ignore lint/suspicious/noExplicitAny: untyped workflow YAML
  const w: any = parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../.github/workflows/staging-solo-clock.yml",
      ),
      "utf8",
    ),
  );
  it("is dispatch only, staging only, main only, with the two inputs", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual([
      "install_id",
      "action",
    ]);
    expect(w.permissions).toEqual({ contents: "read" });
    expect(w.jobs.clock.environment).toBe("hosted-staging-deploy");
    expect(w.jobs.clock.steps[0].run).toContain("refs/heads/main");
  });
});
