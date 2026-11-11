import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env as testEnv, exports } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { keyId, publicFromPkcs8 } from "@oa/auth-core";
import type { SoloStartResult } from "@oa/billing-core";
import { clearRegistryCache } from "@oa/broker-core";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import billing, { BillingProvisionerRpc, type Env } from "../src/index.js";

// BillingProvisionerRpc.soloStart (#1568): the provisioner's one call into
// billing, over a service binding with a named entrypoint. No signed body: the
// install must be in BROKER_REGISTRY (its entry is written by the provisioner,
// and KV is eventually consistent, so unknown is retryable). Stripe is a fake
// global fetch.

const db = (testEnv as unknown as { BILLING_DB: D1Database }).BILLING_DB;
const registry = (testEnv as unknown as { BROKER_REGISTRY: KVNamespace })
  .BROKER_REGISTRY;
const SECRET = "sk_test_FAKEfakeFAKEfake0123456789";
const baseEnv = (): Env => ({
  BILLING_DB: db,
  BROKER_REGISTRY: registry,
  OA_ENV: "staging",
  STRIPE_SECRET_KEY: SECRET,
  STRIPE_PRICE_TEAM: "price_team1",
  STRIPE_PRICE_BUSINESS: "price_business1",
  STRIPE_PRICE_SOLO_MONTHLY: "price_soloM1",
  STRIPE_PRICE_SOLO_YEARLY: "price_soloY1",
  STRIPE_PRICE_TEAM_YEARLY: "",
  STRIPE_PRICE_BUSINESS_YEARLY: "",
});
const A = "iabc123def45";
const B = "izzz999yyy88";
const NOW = Date.UTC(2026, 10, 9, 12, 0);
const DAY = 86_400_000;

const pk = () => {
  const bytes = new Uint8Array([
    ...[0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65],
    ...[0x70, 0x04, 0x22, 0x04, 0x20],
    ...new Uint8Array(32).fill(1),
  ]);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

beforeAll(async () => {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM tiers"),
    db.prepare("DELETE FROM usage"),
  ]);
  clearRegistryCache();
  // A is registered (the provisioner wrote its entry); B is not.
  await registry.delete(`install:${B}`);
  const x = await publicFromPkcs8(pk());
  await registry.put(
    `install:${A}`,
    JSON.stringify({
      installId: A,
      origin: `https://${A}.example.test`,
      keys: [{ kid: await keyId(x), x }],
    }),
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Call = { path: string; key: string | null; form: Record<string, string> };
/** Stripe as the Solo trial uses it; `override` can fail a call. */
function fakeStripe(override?: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  let n = 0;
  const replay = new Map<string, unknown>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const c: Call = {
      path: url.pathname,
      key: h.get("idempotency-key"),
      form: Object.fromEntries(new URLSearchParams(String(init?.body))),
    };
    calls.push(c);
    const o = override?.(c);
    if (o) return o;
    const k = `${c.path} ${c.key}`;
    if (!replay.has(k)) {
      n++;
      replay.set(
        k,
        c.path === "/v1/customers"
          ? { id: `cus_fake${n}` }
          : { id: `sub_fake${n}`, object: "subscription" },
      );
    }
    return Response.json(replay.get(k));
  });
  return calls;
}

const rowOf = (install = A) =>
  db.prepare("SELECT * FROM tiers WHERE install_id = ?1").bind(install).first();
const seed = (
  tier: string,
  status = "active",
  customer: string | null = "cus_x",
) =>
  db
    .prepare(
      "INSERT INTO tiers (install_id, tier, status, stripe_customer_id, version, updated_at) VALUES (?1, ?2, ?3, ?4, 3, 0)",
    )
    .bind(A, tier, status, customer)
    .run();
/** The entrypoint on a chosen env (a direct instance: the guards need to vary the env). */
const start = (install: string, e: Env = baseEnv()) =>
  new BillingProvisionerRpc(createExecutionContext(), e).soloStart(install);
const fail = (error: string, retryable: boolean) => ({
  ok: false,
  error,
  retryable,
});

describe("through a service-binding-style stub (the way the provisioner reaches it)", () => {
  // ctx.exports gives the named entrypoint as a stub: arguments and results
  // cross the RPC boundary, so the result must be plain and serialisable.
  const stub = () =>
    (
      exports as unknown as {
        BillingProvisionerRpc: {
          soloStart(install: string): Promise<SoloStartResult>;
        };
      }
    ).BillingProvisionerRpc;

  it("started: ok with the view, the 30-day end, a row and one subscription; a repeat answers ok and makes no second Stripe call", async () => {
    const stripe = fakeStripe();
    const first = await stub().soloStart(A);
    expect(first).toEqual({
      ok: true,
      tier: "solo",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      soloTrialEndsAt: NOW + 30 * DAY,
      version: 1,
      asOf: NOW,
    });
    expect(JSON.stringify(first)).not.toMatch(/cus_|sub_/);
    expect(stripe.map((c) => c.path)).toEqual([
      "/v1/customers",
      "/v1/subscriptions",
    ]);
    const row = await rowOf();
    expect(row).toMatchObject({
      tier: "solo",
      solo_trial_ends_at: NOW + 30 * DAY,
    });
    const again = await stub().soloStart(A);
    expect(again).toEqual(first);
    expect(stripe.filter((c) => c.path === "/v1/subscriptions")).toHaveLength(
      1,
    );
    expect(await rowOf()).toEqual(row);
  });

  it("unknown install: ok false, retryable (the registry entry may not be visible yet); no Stripe call, no row", async () => {
    const stripe = fakeStripe();
    expect(await stub().soloStart(B)).toEqual(fail("unknown_install", true));
    expect(stripe).toEqual([]);
    expect(await rowOf(B)).toBeNull();
  });

  it("a bad install id: ok false, not retryable, before any lookup", async () => {
    const stripe = fakeStripe();
    for (const id of [
      "",
      "Iabc123def45",
      "iabc123def4",
      "iabc123def456",
      "i abc123def4",
      "../x",
    ])
      expect(await stub().soloStart(id), id).toEqual(
        fail("bad_install", false),
      );
    expect(await stub().soloStart(undefined as unknown as string)).toEqual(
      fail("bad_install", false),
    );
    expect(stripe).toEqual([]);
  });
});

describe("the entrypoint's surface", () => {
  it("is a named export with exactly constructor and soloStart (every public method is callable over RPC)", () => {
    expect(
      Object.getOwnPropertyNames(BillingProvisionerRpc.prototype).sort(),
    ).toEqual(["constructor", "soloStart"]);
  });

  it("the default export has no /solo/start any more: signed or not, binding-style or not, the plain 404", async () => {
    const stripe = fakeStripe();
    for (const headers of [
      {},
      { "x-oa-gate-install": A },
      {
        "x-oa-gate-install": A,
        "x-oa-kid": "k",
        "x-oa-sig": "s",
        "content-type": "application/json",
      },
      { "cf-connecting-ip": "1.2.3.4" },
    ] as Record<string, string>[]) {
      for (const method of ["POST", "GET"]) {
        const r = await billing.fetch(
          new Request("https://billing.oa.internal/solo/start", {
            method,
            headers,
            ...(method === "POST"
              ? { body: JSON.stringify({ install: A, ts: NOW }) }
              : {}),
          }) as Parameters<typeof billing.fetch>[0],
          baseEnv(),
        );
        expect(r.status, `${method} ${JSON.stringify(headers)}`).toBe(404);
      }
    }
    expect(stripe).toEqual([]);
    expect(await rowOf()).toBeNull();
  });
});

describe("the guards of the Solo trial start (moved from the old route)", () => {
  it("no row: makes the solo row and customer, creates the 30-day no-card subscription on the monthly price, keyed per install", async () => {
    const s = fakeStripe();
    const r = await start(A);
    expect(r).toMatchObject({
      ok: true,
      tier: "solo",
      soloTrialEndsAt: NOW + 30 * DAY,
    });
    expect(s.map((c) => [c.path, c.key])).toEqual([
      ["/v1/customers", `cust-${A}`],
      ["/v1/subscriptions", `solo-trial-${A}`],
    ]);
    expect(s[1]?.form).toEqual({
      customer: "cus_fake1",
      "items[0][price]": "price_soloM1",
      trial_period_days: "30",
      "trial_settings[end_behavior][missing_payment_method]": "cancel",
      "metadata[tier]": "solo",
    });
    expect(await rowOf()).toMatchObject({
      tier: "solo",
      status: "active",
      stripe_customer_id: "cus_fake1",
      stripe_subscription_id: "sub_fake2",
      solo_trial_ends_at: NOW + 30 * DAY,
      version: 1,
    });
  });

  it("concurrent starts: one subscription (one Stripe key), one version bump", async () => {
    const s = fakeStripe();
    const rs = await Promise.all([start(A), start(A), start(A)]);
    for (const r of rs) expect(r.ok).toBe(true);
    expect(
      new Set(
        s.filter((c) => c.path === "/v1/subscriptions").map((c) => c.key),
      ),
    ).toEqual(new Set([`solo-trial-${A}`]));
    expect(await rowOf()).toMatchObject({
      stripe_subscription_id: "sub_fake2",
      version: 1,
    });
  });

  it("a row on team, business or trial: plan_conflict, not retryable; no Stripe call, no write", async () => {
    for (const tier of ["team", "business", "trial"]) {
      await db.prepare("DELETE FROM tiers").run();
      await seed(tier);
      const before = await rowOf();
      const s = fakeStripe();
      expect(await start(A), tier).toEqual(fail("plan_conflict", false));
      expect(s).toEqual([]);
      expect(await rowOf()).toEqual(before);
      vi.restoreAllMocks();
    }
  });

  it("a lapsed, past_due or suspended row: not_active, not retryable; no customer, no Stripe call, nothing written", async () => {
    for (const status of ["lapsed", "past_due", "suspended"]) {
      await db.prepare("DELETE FROM tiers").run();
      await seed("solo", status, null);
      const before = await rowOf();
      const s = fakeStripe();
      expect(await start(A), status).toEqual(fail("not_active", false));
      expect(s, status).toEqual([]);
      expect(await rowOf(), status).toEqual(before);
      vi.restoreAllMocks();
    }
  });

  it("a legacy free row becomes solo; a webhook that got there first, or an ended Solo trial, is already held: ok, no Stripe call", async () => {
    await seed("free");
    fakeStripe();
    expect(await start(A)).toMatchObject({ ok: true, tier: "solo" });
    for (const [why, set] of [
      ["a subscription already stored", "stripe_subscription_id = 'sub_hook1'"],
      ["a Solo trial that ended", "solo_trial_ends_at = 1"],
    ] as const) {
      vi.restoreAllMocks();
      await db.prepare("DELETE FROM tiers").run();
      await seed("solo");
      await db
        .prepare(`UPDATE tiers SET ${set} WHERE install_id = ?1`)
        .bind(A)
        .run();
      const s = fakeStripe();
      const r = await start(A);
      expect(r.ok, why).toBe(true);
      expect(s, why).toEqual([]);
    }
  });

  it("an ended Solo trial's answer hides its date (null once past) and starts nothing", async () => {
    await seed("solo");
    await db
      .prepare("UPDATE tiers SET solo_trial_ends_at = ?1 WHERE install_id = ?2")
      .bind(NOW - 1000, A)
      .run();
    const s = fakeStripe();
    expect(await start(A)).toMatchObject({ ok: true, soloTrialEndsAt: null });
    expect(s).toEqual([]);
  });

  it("config: no key, a live key (sk or rk), an unfilled or malformed monthly price: config, not retryable, no Stripe call", async () => {
    const s = fakeStripe();
    for (const e of [
      { STRIPE_SECRET_KEY: undefined },
      { STRIPE_SECRET_KEY: "sk_live_abcdefgh12345678" },
      { STRIPE_SECRET_KEY: "rk_live_abcdefgh12345678" },
      { STRIPE_PRICE_SOLO_MONTHLY: "{{STRIPE_PRICE_SOLO_MONTHLY_STAGING}}" },
      { STRIPE_PRICE_SOLO_MONTHLY: "prod_1abc" },
    ])
      expect(
        await start(A, { ...baseEnv(), ...e } as Env),
        JSON.stringify(e),
      ).toEqual(fail("config", false));
    expect(s).toEqual([]);
    expect(await rowOf()).toMatchObject({ stripe_subscription_id: null });
  });

  it("Stripe errors: a failed subscription call is upstream, retryable, with the customer kept and no subscription stored; a bad answer is bad_upstream; the same key still in progress is retry", async () => {
    fakeStripe((c) =>
      c.path === "/v1/subscriptions"
        ? Response.json({ error: { type: "api_error" } }, { status: 500 })
        : undefined,
    );
    expect(await start(A)).toEqual(fail("upstream", true));
    expect(await rowOf()).toMatchObject({
      stripe_customer_id: "cus_fake1",
      stripe_subscription_id: null,
    });
    vi.restoreAllMocks();
    fakeStripe((c) =>
      c.path === "/v1/subscriptions"
        ? Response.json({ id: "nope" })
        : undefined,
    );
    expect(await start(A)).toEqual(fail("bad_upstream", true));
    vi.restoreAllMocks();
    fakeStripe((c) =>
      c.path === "/v1/subscriptions"
        ? Response.json(
            { error: { type: "idempotency_error" } },
            { status: 409 },
          )
        : undefined,
    );
    expect(await start(A)).toEqual(fail("retry", true));
    // The next try, with Stripe back, finishes the job.
    vi.restoreAllMocks();
    fakeStripe();
    expect(await start(A)).toMatchObject({ ok: true, tier: "solo" });
  });

  it("a permanent Stripe refusal is stripe_refused, not retryable: 400 (bad price), 401 (revoked key), 403 (a permission missing), 404 (no such customer), 422; on the customer call and on the subscription call", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      for (const path of ["/v1/customers", "/v1/subscriptions"]) {
        await db.prepare("DELETE FROM tiers").run();
        vi.restoreAllMocks();
        const lines: string[] = [];
        vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
          lines.push(a.map(String).join(" "));
        });
        fakeStripe((c) =>
          c.path === path
            ? Response.json(
                {
                  error: {
                    type: "invalid_request_error",
                    message: "secret detail",
                  },
                },
                { status },
              )
            : undefined,
        );
        expect(await start(A), `${status} ${path}`).toEqual(
          fail("stripe_refused", false),
        );
        // A fixed category, the install and the status number: no Stripe text.
        expect(lines, `${status} ${path}`).toContain(
          `billing solo stripe_refused ${A} ${status}`,
        );
        expect(lines.join("\n")).not.toContain("secret detail");
        expect(await rowOf()).toMatchObject({ stripe_subscription_id: null });
      }
    }
  });

  it("408, 424, 429 and 5xx stay upstream and retryable; 409 stays retry; a network error is upstream", async () => {
    for (const [status, want] of [
      [408, "upstream"],
      [424, "upstream"],
      [429, "upstream"],
      [500, "upstream"],
      [502, "upstream"],
      [503, "upstream"],
      [409, "retry"],
    ] as const) {
      await db.prepare("DELETE FROM tiers").run();
      vi.restoreAllMocks();
      fakeStripe((c) =>
        c.path === "/v1/subscriptions"
          ? Response.json({ error: { type: "api_error" } }, { status })
          : undefined,
      );
      expect(await start(A), String(status)).toEqual(fail(want, true));
    }
    await db.prepare("DELETE FROM tiers").run();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
    expect(await start(A)).toEqual(fail("upstream", true));
  });

  it("an unexpected error (a D1 failure) is unavailable, retryable, never thrown, and logs a fixed category only", async () => {
    const lines: string[] = [];
    for (const m of ["log", "error", "warn"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
    const broken = {
      ...baseEnv(),
      BILLING_DB: {
        prepare: () => {
          throw new Error(`D1_ERROR: ${SECRET} secret detail`);
        },
      },
    } as unknown as Env;
    expect(await start(A, broken)).toEqual(fail("unavailable", true));
    expect(lines).toEqual([`billing solo_start db_error ${A}`]);
    expect(lines.join("\n")).not.toContain("secret detail");
  });

  it("logs carry fixed categories and the install id only: never the key, a Stripe id or a body", async () => {
    const lines: string[] = [];
    for (const m of ["log", "error", "warn"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
    fakeStripe();
    await start(A);
    await start(A);
    await start(B);
    const all = lines.join("\n");
    for (const bad of [SECRET, "cus_", "sub_", "price_"])
      expect(all).not.toContain(bad);
  });
});
