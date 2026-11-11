import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  advance,
  cleanup,
  getOnly,
  type Io,
  inspect,
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
      return path.includes("starting_after=clock_orphan")
        ? j({ data: [{ id: "clock_orphan2", name: A }], has_more: false })
        : j({
            data: [
              { id: "clock_x", name: "other" },
              { id: "clock_orphan", name: A },
            ],
            has_more: true,
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
      all: async (sql, params) => {
        queries.push(params ? `${sql} <- ${JSON.stringify(params)}` : sql);
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
      "/v1/test_helpers/test_clocks/clock_orphan2",
    ]);
    // Parameterized, never interpolated.
    expect(w.queries.at(-1)).toBe(
      `DELETE FROM tiers WHERE install_id = ?1 <- ["${A}"]`,
    );
  });

  it("M1: refuses a row that has no test clock (a real install's): nothing deleted, nothing reset", async () => {
    const w = world();
    w.rows[0] = { stripe_customer_id: "cus_real", stripe_test_clock_id: null };
    await expect(cleanup(w.io, w.call, A)).rejects.toThrow(/no test clock/);
    expect(w.calls).toEqual([]);
    expect(w.queries.some((q) => q.startsWith("DELETE"))).toBe(false);
  });

  it("M1: with no row at all it sweeps orphan clocks only and resets nothing", async () => {
    const w = world();
    w.rows.length = 0;
    await cleanup(w.io, w.call, A);
    const del = w.calls.filter((c) => c.method === "DELETE");
    expect(del).toHaveLength(2);
    expect(w.queries.some((q) => q.startsWith("DELETE"))).toBe(false);
  });
});

describe("inspect", () => {
  function iw(
    row: Record<string, unknown>,
    events?: { status: number; body: unknown },
  ) {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      calls.push(`${init.method} ${u.pathname}${u.search}`);
      const j = (o: unknown) => Response.json(o);
      if (u.pathname === "/v1/subscriptions")
        return j({
          data: [
            {
              id: "sub_1",
              status: "active",
              created: 1_800_000_000,
              canceled_at: null,
              cancel_at_period_end: false,
              metadata: { tier: "solo" },
              items: {
                data: [
                  {
                    quantity: 2,
                    price: {
                      id: "price_solo",
                      recurring: { interval: "year" },
                    },
                  },
                ],
              },
            },
          ],
        });
      if (u.pathname === "/v1/customers/cus_1")
        return j({ balance: -500, currency: "usd" });
      if (u.pathname === "/v1/invoices")
        return j({
          data: [
            {
              id: "in_1",
              status: "paid",
              total: 100,
              amount_paid: 100,
              starting_balance: 0,
              ending_balance: -500,
              billing_reason: "subscription_update",
            },
          ],
        });
      if (u.pathname === "/v1/events" && events)
        return Response.json(events.body, { status: events.status });
      if (u.pathname === "/v1/events")
        return j({
          data: [
            {
              type: "invoice.paid",
              created: 1_800_000_100,
              pending_webhooks: 0,
              data: { object: { customer: "cus_1" } },
            },
            {
              type: "invoice.paid",
              created: 1_800_000_200,
              pending_webhooks: 1,
              data: { object: { customer: "cus_other" } },
            },
          ],
        });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const queries: string[] = [];
    const io: Io = {
      fetch: f,
      sleep: async () => {},
      now: () => 0,
      log: (s) => lines.push(s),
      db: {
        all: async (sql) => {
          queries.push(sql);
          return sql.includes("solo_status")
            ? [{ tier: "solo", version: 3 }]
            : [row];
        },
        exec: async (sql) => {
          queries.push(sql);
        },
      },
    };
    return { io, calls, lines, queries, f };
  }

  it("prints the row, subscriptions, balance, invoices and this customer's events, with GETs and SELECTs only", async () => {
    const w = iw({
      stripe_customer_id: "cus_1",
      stripe_test_clock_id: null,
      stripe_subscription_id: "sub_1",
    });
    await inspect(w.io, stripeClient(KEY, getOnly(w.f)), A);
    expect(w.calls.every((c) => c.startsWith("GET "))).toBe(true);
    expect(w.queries.every((q) => /^\s*SELECT/i.test(q))).toBe(true);
    const out = w.lines.join("\n");
    expect(out).toContain('"stripe_subscription_id":"sub_1"');
    expect(out).toContain("price_solo per year");
    expect(out).toContain("metadata.tier solo");
    expect(out).toContain("customer balance: -500");
    expect(out).toContain("billing_reason subscription_update");
    expect(out).toContain("event invoice.paid");
    expect(out).toContain("pending_webhooks 0");
    expect(out).not.toContain("pending_webhooks 1");
    expect(out).not.toContain(KEY);
  });

  const CUS = {
    stripe_customer_id: "cus_1",
    stripe_test_clock_id: null,
    stripe_subscription_id: "sub_1",
  };

  it("a 403 on the event list is skipped with a message and does not fail", async () => {
    const w = iw(CUS, {
      status: 403,
      body: { error: { code: "more_permissions_required" } },
    });
    await inspect(w.io, stripeClient(KEY, getOnly(w.f)), A);
    expect(w.lines.at(-1)).toBe(
      "events: not readable with this key (needs Events read); skipped",
    );
  });

  it("a 500 on the event list still fails", async () => {
    const w = iw(CUS, { status: 500, body: { error: { type: "api_error" } } });
    await expect(
      inspect(w.io, stripeClient(KEY, getOnly(w.f)), A),
    ).rejects.toThrow(/: 500 /);
  });

  it("no matching event says so for the account's last 100", async () => {
    const w = iw(CUS, { status: 200, body: { data: [] } });
    await inspect(w.io, stripeClient(KEY, getOnly(w.f)), A);
    expect(w.lines.at(-1)).toBe("no matching event in the account's last 100");
  });

  it("a row without a customer prints the row and no customer, with no Stripe call", async () => {
    const w = iw({ stripe_customer_id: null });
    await inspect(w.io, stripeClient(KEY, getOnly(w.f)), A);
    expect(w.lines.at(-1)).toBe("no customer");
    expect(w.calls).toEqual([]);
  });

  it("the inspect client refuses non-GET before any request", async () => {
    const w = iw({});
    const call = stripeClient(KEY, getOnly(w.f));
    await expect(
      call("POST", "/v1/customers/cus_1", { a: "b" }),
    ).rejects.toThrow(/read-only/);
    await expect(call("DELETE", "/v1/customers/cus_1")).rejects.toThrow(
      /read-only/,
    );
    expect(w.calls).toEqual([]);
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
