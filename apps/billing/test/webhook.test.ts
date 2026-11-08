import { applyD1Migrations } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { signStripePayload } from "@oa/billing-core";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import billing, { type Env } from "../src/index.js";

// POST /stripe/webhook, mounted from @oa/billing-core: the one route an
// internet request (cf-connecting-ip) reaches. Payloads are signed here with
// billing-core's signStripePayload and a test secret; no Stripe call is made.

const db = (testEnv as unknown as { BILLING_DB: D1Database }).BILLING_DB;
const registry = (testEnv as unknown as { BROKER_REGISTRY: KVNamespace })
  .BROKER_REGISTRY;
/** A test-only signing secret (not a real endpoint's). */
const SECRET = "whsec_test_billing_app_0123456789abcdef";
const env = {
  BILLING_DB: db,
  BROKER_REGISTRY: registry,
  STRIPE_WEBHOOK_SECRET: SECRET,
} as Env;

const A = "iabc123def45";
const B = "izzz999yyy88";
const CUS_A = "cus_TestA0001";
const CUS_B = "cus_TestB0002";
const NOW = Date.UTC(2026, 9, 29, 12, 0);
const T = Math.floor(NOW / 1000);
const ORIGIN = "https://billing.oa.internal";
const INTERNET = { "cf-connecting-ip": "1.2.3.4" };

beforeAll(async () => {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM tiers"),
    db.prepare("DELETE FROM usage"),
    db.prepare("DELETE FROM stripe_events"),
    db
      .prepare(
        "INSERT INTO tiers (install_id, tier, status, stripe_customer_id, version, updated_at) VALUES (?1, 'free', 'active', ?2, 1, 0), (?3, 'free', 'active', ?4, 1, 0)",
      )
      .bind(A, CUS_A, B, CUS_B),
  ]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const rowOf = (install: string) =>
  db.prepare("SELECT * FROM tiers WHERE install_id = ?1").bind(install).first();
const events = async () =>
  (
    await db.prepare("SELECT COUNT(*) AS n FROM stripe_events").first<{
      n: number;
    }>()
  )?.n;

/** A customer.subscription.updated event: active at `tier`. */
const subEvent = (id: string, customer: string, tier: string) =>
  JSON.stringify({
    id,
    object: "event",
    type: "customer.subscription.updated",
    livemode: false,
    created: T,
    data: {
      object: {
        id: "sub_TestA0001",
        object: "subscription",
        customer,
        status: "active",
        metadata: { tier },
      },
    },
  });

async function hook(
  body: string,
  opts: {
    secret?: string;
    headers?: Record<string, string>;
    method?: string;
  } = {},
) {
  const sig = await signStripePayload(body, opts.secret ?? SECRET, T);
  return new Request(`${ORIGIN}/stripe/webhook`, {
    method: opts.method ?? "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": sig,
      ...INTERNET,
      ...opts.headers,
    },
    ...((opts.method ?? "POST") === "POST" ? { body } : {}),
  });
}

const call = (req: Request, e: Env = env) =>
  billing.fetch(req as Parameters<typeof billing.fetch>[0], e);

describe("POST /stripe/webhook", () => {
  it("a signed event from the internet updates the customer's tier row only", async () => {
    const beforeB = await rowOf(B);
    const r = await call(await hook(subEvent("evt_TestOne1", CUS_A, "team")));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: true });
    expect(await rowOf(A)).toMatchObject({
      tier: "team",
      status: "active",
      grace_until: null,
      version: 2,
      last_event_created: T,
      updated_at: NOW,
    });
    expect(await rowOf(B)).toEqual(beforeB);
    expect(await events()).toBe(1);
    // A replay is acknowledged and changes nothing.
    const again = await call(
      await hook(subEvent("evt_TestOne1", CUS_A, "team")),
    );
    expect(again.status).toBe(200);
    expect((await rowOf(A))?.version).toBe(2);
    expect(await events()).toBe(1);
  });

  it("a bad signature is 400 and writes nothing", async () => {
    const before = await rowOf(A);
    const r = await call(
      await hook(subEvent("evt_TestBad1", CUS_A, "business"), {
        secret: "whsec_not_the_endpoint_secret",
      }),
    );
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "bad_signature" });
    expect(await rowOf(A)).toEqual(before);
    expect(await events()).toBe(0);
  });

  it("is reachable with cf-connecting-ip while every gate route with it is still 404", async () => {
    const r = await call(await hook(subEvent("evt_TestIp01", CUS_A, "team")));
    expect(r.status).toBe(200);
    for (const [m, p] of [
      ["GET", "/tier"],
      ["GET", "/health"],
      ["POST", "/trial/start"],
      ["POST", "/usage"],
      ["POST", "/checkout"],
      ["POST", "/portal"],
    ] as const) {
      const g = await call(
        new Request(`${ORIGIN}${p}`, {
          method: m,
          headers: { ...INTERNET, "x-oa-gate-install": A },
        }),
      );
      expect(g.status, `${m} ${p}`).toBe(404);
      expect(await g.text()).toBe("Not found");
    }
  });

  it("any other method on the webhook path is the plain 404, nothing written", async () => {
    for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
      const r = await call(
        await hook(subEvent("evt_TestGet1", CUS_A, "team"), { method }),
      );
      expect(r.status, method).toBe(404);
    }
    for (const p of ["/stripe/webhook/", "/stripe/Webhook", "/stripe"]) {
      const r = await call(
        new Request(`${ORIGIN}${p}`, { method: "POST", headers: INTERNET }),
      );
      expect(r.status, p).toBe(404);
    }
    expect(await events()).toBe(0);
  });

  it("a missing or empty secret is 500 config with the body unread", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    for (const secret of [undefined, ""]) {
      const req = await hook(subEvent("evt_TestCfg1", CUS_A, "team"));
      const reads = (
        ["arrayBuffer", "text", "json", "blob", "formData"] as const
      ).map((k) => vi.spyOn(req, k));
      const r = await call(req, { ...env, STRIPE_WEBHOOK_SECRET: secret });
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: "config" });
      // Cancelled, never read.
      for (const s of reads) expect(s).not.toHaveBeenCalled();
    }
    expect(lines).toEqual(["billing webhook config", "billing webhook config"]);
    expect((await rowOf(A))?.version).toBe(1);
    expect(await events()).toBe(0);
  });

  it("logs fixed categories only: never the secret, a Stripe id, a header or the body", async () => {
    const lines: string[] = [];
    for (const k of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
    const ok = await hook(subEvent("evt_TestLog1", CUS_A, "team"));
    const sig = ok.headers.get("stripe-signature") ?? "";
    await call(ok);
    await call(
      await hook(subEvent("evt_TestLog2", CUS_A, "team"), {
        secret: "whsec_wrong",
      }),
    );
    await call(await hook(subEvent("evt_TestLog3", "cus_Unknown9", "team")));
    await call(await hook(subEvent("evt_TestLog4", CUS_A, "team")), {
      ...env,
      STRIPE_WEBHOOK_SECRET: "",
    });
    expect(lines).toEqual([
      `billing webhook applied ${A}`,
      "billing webhook bad_signature_mismatch",
      "billing webhook unknown_customer",
      "billing webhook config",
    ]);
    const all = lines.join("\n");
    for (const bad of [
      SECRET,
      "whsec_",
      "evt_",
      "cus_",
      "sub_",
      sig,
      "v1=",
      "1.2.3.4",
      "subscription",
      "{",
    ])
      expect(all).not.toContain(bad);
  });
});

describe("Solo prices (#1568)", () => {
  const priced = {
    ...env,
    STRIPE_PRICE_TEAM: "price_team1",
    STRIPE_PRICE_BUSINESS: "price_business1",
    STRIPE_PRICE_SOLO_MONTHLY: "price_soloM1",
    STRIPE_PRICE_SOLO_YEARLY: "price_soloY1",
  } as Env;
  const solo = (id: string, type: string, status: string, price: string) =>
    JSON.stringify({
      id,
      object: "event",
      type,
      livemode: false,
      created: T,
      data: {
        object: {
          id: "sub_TestA0001",
          object: "subscription",
          customer: CUS_A,
          status,
          items: { data: [{ price: { id: price } }] },
        },
      },
    });
  const tierOf = () => rowOf(A);
  const read = async () =>
    (
      await billing.fetch(
        new Request(`${ORIGIN}/tier`, {
          headers: { "x-oa-gate-install": A },
        }) as Parameters<typeof billing.fetch>[0],
        priced,
      )
    ).json();

  it("the env's two Solo prices reach the webhook: either one makes the row solo", async () => {
    for (const [i, price] of ["price_soloM1", "price_soloY1"].entries()) {
      await db
        .prepare(
          "UPDATE tiers SET tier = 'trial', stripe_subscription_id = NULL, last_event_created = NULL WHERE install_id = ?1",
        )
        .bind(A)
        .run();
      const r = await call(
        await hook(
          solo(
            `evt_Solo${i}x1`,
            "customer.subscription.updated",
            "active",
            price,
          ),
        ),
        priced,
      );
      expect(r.status).toBe(200);
      expect(await tierOf(), price).toMatchObject({
        tier: "solo",
        status: "active",
      });
    }
  });

  it("a Solo whose no-card trial ended (canceled) is reported as lapsed, and a failed payment is past_due with grace", async () => {
    await call(
      await hook(
        solo(
          "evt_SoloTr1",
          "customer.subscription.created",
          "trialing",
          "price_soloM1",
        ),
      ),
      priced,
    );
    expect(await read()).toMatchObject({
      tier: "solo",
      status: "active",
      trialEndsAt: null,
    });
    const r = await call(
      await hook(
        solo(
          "evt_SoloDel1",
          "customer.subscription.deleted",
          "canceled",
          "price_soloM1",
        ),
      ),
      priced,
    );
    expect(r.status).toBe(200);
    expect(await read()).toMatchObject({
      tier: "solo",
      status: "lapsed",
      graceUntil: null,
    });
  });
});

describe("the upgrade's cancel goes through the Worker's Stripe key (#1568)", () => {
  const evCompleted = JSON.stringify({
    id: "evt_Upg00001",
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    created: T,
    data: {
      object: {
        customer: CUS_A,
        subscription: "sub_NewA0001",
        payment_status: "paid",
        metadata: { tier: "team" },
      },
    },
  });
  it("cancels the previous Solo subscription with STRIPE_SECRET_KEY, never a live key", async () => {
    await db
      .prepare(
        "UPDATE tiers SET tier = 'solo', stripe_subscription_id = 'sub_OldA0001' WHERE install_id = ?1",
      )
      .bind(A)
      .run();
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seen.push(
        `${init?.method} ${new URL(String(input)).pathname} ${new Headers(init?.headers).get("authorization")}`,
      );
      return Response.json(
        init?.method === "GET"
          ? { id: "sub_OldA0001", status: "active" }
          : { id: "sub_OldA0001", status: "canceled" },
      );
    });
    const key = "sk_test_FAKEfakeFAKEfake0123456789";
    const r = await call(await hook(evCompleted), {
      ...env,
      STRIPE_SECRET_KEY: key,
    } as Env);
    expect(r.status).toBe(200);
    expect(seen).toEqual([
      `GET /v1/subscriptions/sub_OldA0001 Bearer ${key}`,
      `DELETE /v1/subscriptions/sub_OldA0001 Bearer ${key}`,
    ]);
    expect(await rowOf(A)).toMatchObject({
      tier: "team",
      stripe_subscription_id: "sub_NewA0001",
    });
  });
});
