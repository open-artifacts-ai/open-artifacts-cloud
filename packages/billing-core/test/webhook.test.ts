import { applyD1Migrations } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  changeFor,
  GRACE_MS,
  handleStripeWebhook,
  MAX_WEBHOOK_BODY,
  parseEvent,
  parseSignatureHeader,
  pricesOf,
  pruneStripeEvents,
  STRIPE_EVENT_RETENTION_MS,
  STRIPE_TOLERANCE_S,
  signStripePayload,
  statusFromSubscription,
  tierFromSubscription,
  verifyStripeSignature,
  type WebhookEnv,
} from "../src/index.js";
import { unknownPrice } from "../src/webhook.js";

// The webhook against the tier store's real tables (#849 0001_init.sql).
// Signatures are made here with a test secret; no Stripe call is made.

const db = (testEnv as unknown as { BILLING_DB: D1Database }).BILLING_DB;
/** A test-only signing secret (not a real endpoint's). */
const SECRET = "whsec_test_billing_core_0123456789abcdef";
/** The state Stripe reports per subscription id (default: active). */
const subStatus: Record<string, string> = {};
/** A Stripe that reads subscriptions (the adoption check) and cancels them. */
const fakeStripeFetch = (async (url: string, init: RequestInit) => {
  const id = new URL(url).pathname.split("/").pop() as string;
  return Response.json({
    id,
    status: init.method === "GET" ? (subStatus[id] ?? "active") : "canceled",
  });
}) as unknown as typeof fetch;
const env: WebhookEnv = {
  BILLING_DB: db,
  STRIPE_WEBHOOK_SECRET: SECRET,
  STRIPE_SECRET_KEY: "sk_test_notarealkey0000",
  stripeFetch: fakeStripeFetch,
};
const NOW = Date.UTC(2026, 9, 29, 12, 0);
const T = Math.floor(NOW / 1000);
const A = "iabc123def45";
const B = "izzz999yyy88";
const CUS_A = "cus_TestA0001";
const CUS_B = "cus_TestB0002";

beforeAll(async () => {
  await applyD1Migrations(
    db,
    (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
});
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM tiers"),
    db.prepare("DELETE FROM stripe_events"),
    db.prepare("DELETE FROM pending_cancels"),
    db.prepare("DELETE FROM overage"),
  ]);
  await seed(A, CUS_A, "trial");
  await seed(B, CUS_B, "team");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(subStatus)) delete subStatus[k];
});

async function seed(install: string, customer: string, tier: string) {
  await db
    .prepare(
      "INSERT INTO tiers (install_id, tier, status, trial_ends_at, grace_until, stripe_customer_id, version, updated_at) VALUES (?, ?, 'active', NULL, NULL, ?, 1, 1)",
    )
    .bind(install, tier, customer)
    .run();
}
type Row = {
  install_id: string;
  tier: string;
  status: string;
  trial_ends_at: number | null;
  grace_until: number | null;
  stripe_subscription_id: string | null;
  version: number;
  updated_at: number;
  last_event_created: number | null;
  last_invoice_created: number | null;
  last_checkout_created: number | null;
  open_checkout_id: string | null;
  open_checkout_key: string | null;
};
const row = async (install: string) =>
  db
    .prepare("SELECT * FROM tiers WHERE install_id = ?")
    .bind(install)
    .first<Row>() as Promise<Row>;

// Each event is a second newer than the last unless a test says otherwise
// (Stripe's `created` is the ordering key).
let n = 0;
const event = (
  type: string,
  object: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id: `evt_test${++n}`,
  object: "event",
  type,
  livemode: false,
  created: T + n,
  data: { object },
  ...extra,
});
/** An invoice of the test subscription (sub_Test1). */
const inv = (o: Record<string, unknown> = {}) => ({
  customer: CUS_A,
  subscription: "sub_Test1",
  ...o,
});
/**
 * The row is on the paid team tier and holds the test subscription (invoices
 * apply only to it, and only a paid row goes past_due or lapsed).
 */
const ownSub = (install: string) =>
  db
    .prepare(
      "UPDATE tiers SET tier = 'team', stripe_subscription_id = 'sub_Test1' WHERE install_id = ?",
    )
    .bind(install)
    .run();
const sub = (o: Record<string, unknown> = {}) => ({
  id: "sub_Test1",
  object: "subscription",
  customer: CUS_A,
  status: "active",
  items: { data: [{ price: { id: "price_Team", lookup_key: "team" } }] },
  ...o,
});

/** The subscriptions queued for cancel (pending_cancels), oldest id first. */
const pending = async () =>
  (
    await db
      .prepare(
        "SELECT subscription_id FROM pending_cancels ORDER BY subscription_id",
      )
      .all<{ subscription_id: string }>()
  ).results.map((r) => r.subscription_id);

async function deliver(
  body: unknown,
  o: {
    t?: number;
    secret?: string;
    text?: string;
    now?: number;
    env?: WebhookEnv;
  } = {},
) {
  const text = o.text ?? JSON.stringify(body);
  const sig = await signStripePayload(text, o.secret ?? SECRET, o.t ?? T);
  return handleStripeWebhook(
    new Request("https://billing.example/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sig },
      body: text,
    }),
    o.env ?? env,
    o.now ?? NOW,
  );
}

describe("signature", () => {
  it("accepts the right secret within 5 minutes, either way, and nothing else", async () => {
    const body = '{"a":1}';
    const h = await signStripePayload(body, SECRET, T);
    expect(await verifyStripeSignature(body, h, SECRET, NOW)).toEqual({
      ok: true,
      timestamp: T,
    });
    const edge = NOW + STRIPE_TOLERANCE_S * 1000;
    expect((await verifyStripeSignature(body, h, SECRET, edge)).ok).toBe(true);
    expect(await verifyStripeSignature(body, h, SECRET, edge + 1000)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(
      await verifyStripeSignature(
        body,
        h,
        SECRET,
        NOW - STRIPE_TOLERANCE_S * 1000 - 1000,
      ),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await verifyStripeSignature(`${body} `, h, SECRET, NOW)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await verifyStripeSignature(body, h, "whsec_other", NOW)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await verifyStripeSignature(body, null, SECRET, NOW)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await verifyStripeSignature(body, "v1=abc", SECRET, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(
      await verifyStripeSignature(body, `t=${T},v1=zz`, SECRET, NOW),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("any of several v1 signatures may match (secret rotation); v0 never counts", async () => {
    const body = "{}";
    const good = (await signStripePayload(body, SECRET, T)).split(
      ",",
    )[1] as string;
    const old = (await signStripePayload(body, "whsec_old", T)).split(
      ",",
    )[1] as string;
    expect(
      (await verifyStripeSignature(body, `t=${T},${old},${good}`, SECRET, NOW))
        .ok,
    ).toBe(true);
    expect(
      (
        await verifyStripeSignature(
          body,
          `t=${T},v0=${good.slice(3)}`,
          SECRET,
          NOW,
        )
      ).ok,
    ).toBe(false);
    expect(parseSignatureHeader(`t=${T},t=${T},${good}`)).toBeNull();
  });
});

describe("pure helpers", () => {
  it("parseEvent takes Stripe's event shape only", () => {
    expect(
      parseEvent(JSON.stringify(event("invoice.paid", { customer: CUS_A }))),
    ).toMatchObject({ type: "invoice.paid", livemode: false });
    expect(parseEvent("not json")).toBeNull();
    expect(
      parseEvent(
        JSON.stringify({
          object: "event",
          id: "nope",
          type: "x",
          livemode: false,
          data: { object: {} },
        }),
      ),
    ).toBeNull();
    expect(
      parseEvent(JSON.stringify({ ...event("x", {}), data: [] })),
    ).toBeNull();
    // `created` is the ordering key: required, a non-negative integer.
    for (const created of [undefined, "1", -1, 1.5])
      expect(
        parseEvent(JSON.stringify({ ...event("x", {}), created })),
      ).toBeNull();
  });

  it("with the price ids configured, only those ids name a tier; an unknown price falls to metadata", () => {
    const prices = { team: "price_T", business: "price_B" };
    const priced = (price: Record<string, unknown>, tier?: string) =>
      sub({
        items: { data: [{ price }] },
        ...(tier ? { metadata: { tier } } : {}),
      });
    // Price metadata or lookup_key from an unknown price is not trusted.
    expect(
      tierFromSubscription(
        priced({ id: "price_X", metadata: { tier: "business" } }),
        prices,
      ),
    ).toBeNull();
    expect(
      tierFromSubscription(
        priced({ id: "price_X", lookup_key: "business" }, "team"),
        prices,
      ),
    ).toBe("team");
    expect(
      tierFromSubscription(priced({ id: "price_B" }, "team"), prices),
    ).toBe("business");
    // Without the ids the order is unchanged.
    expect(
      tierFromSubscription(
        priced({ id: "price_X", metadata: { tier: "business" } }),
      ),
    ).toBe("business");
  });

  it("tierFromSubscription: the current price wins over the subscription's metadata (H1)", () => {
    // Plan switch: Business price, metadata still says team (and the reverse).
    const priced = (price: Record<string, unknown>, tier: string) =>
      sub({ items: { data: [{ price }] }, metadata: { tier } });
    expect(
      tierFromSubscription(
        priced({ id: "price_B", metadata: { tier: "business" } }, "team"),
      ),
    ).toBe("business");
    expect(
      tierFromSubscription(
        priced({ id: "price_T", metadata: { tier: "team" } }, "business"),
      ),
    ).toBe("team");
    expect(
      tierFromSubscription(
        priced({ id: "price_B", lookup_key: "business" }, "team"),
      ),
    ).toBe("business");
    // The webhook env's price ids name the tier too, and beat price metadata.
    const prices = { team: "price_T", business: "price_B" };
    expect(
      tierFromSubscription(priced({ id: "price_B" }, "team"), prices),
    ).toBe("business");
    expect(
      tierFromSubscription(priced({ id: "price_T" }, "business"), prices),
    ).toBe("team");
    expect(
      tierFromSubscription(
        priced({ id: "price_B", metadata: { tier: "team" } }, "team"),
        prices,
      ),
    ).toBe("business");
    // Metadata only when no price names a tier.
    expect(
      tierFromSubscription(priced({ id: "price_X" }, "business"), prices),
    ).toBe("business");
    expect(tierFromSubscription(sub())).toBe("team");
    expect(
      tierFromSubscription(
        sub({
          items: { data: [{ price: { metadata: { tier: "business" } } }] },
        }),
      ),
    ).toBe("business");
    expect(
      tierFromSubscription(
        sub({ items: { data: [] }, metadata: { tier: "business" } }),
      ),
    ).toBe("business");
    expect(
      tierFromSubscription(
        sub({ items: { data: [{ price: { lookup_key: "enterprise" } }] } }),
      ),
    ).toBeNull();
    expect(statusFromSubscription("trialing")).toBe("active");
    expect(statusFromSubscription("unpaid")).toBe("past_due");
    expect(statusFromSubscription("canceled")).toBe("lapsed");
    expect(statusFromSubscription("incomplete")).toBeNull();
    expect(
      changeFor({
        id: "evt_x",
        type: "charge.refunded",
        livemode: false,
        created: T,
        object: {},
      }),
    ).toBeNull();
  });
});

describe("handleStripeWebhook", () => {
  it("checkout completed, then the subscription: paid team, version bumped", async () => {
    expect(
      (
        await deliver(
          event("checkout.session.completed", {
            customer: CUS_A,
            subscription: "sub_Test1",
            mode: "subscription",
            payment_status: "paid",
          }),
        )
      ).status,
    ).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "trial",
      status: "active",
      stripe_subscription_id: "sub_Test1",
      version: 2,
      updated_at: NOW,
      last_event_created: T + n,
    });
    expect(
      (await deliver(event("customer.subscription.created", sub()))).status,
    ).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "active",
      grace_until: null,
      version: 3,
    });
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ items: { data: [{ price: { lookup_key: "business" } }] } }),
      ),
    );
    expect((await row(A)).tier).toBe("business");
  });

  it("payment failed starts grace once; paid ends it; deleted lapses; nothing is deleted", async () => {
    await ownSub(A);
    const first = event("invoice.payment_failed", inv());
    await deliver(first);
    expect(await row(A)).toMatchObject({
      status: "past_due",
      grace_until: first.created * 1000 + GRACE_MS,
    });
    await deliver(event("invoice.payment_failed", inv()), {
      now: NOW + 1000,
    });
    expect((await row(A)).grace_until).toBe(first.created * 1000 + GRACE_MS);
    await deliver(event("invoice.paid", inv()));
    expect(await row(A)).toMatchObject({ status: "active", grace_until: null });
    await deliver(event("customer.subscription.deleted", sub()));
    expect(await row(A)).toMatchObject({ tier: "team", status: "lapsed" });
    // An old invoice paid never revives a lapsed row.
    await deliver(event("invoice.paid", inv()));
    expect((await row(A)).status).toBe("lapsed");
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM tiers")
        .first<{ n: number }>(),
    ).toEqual({ n: 2 });
  });

  it("a Stripe trial sets trialEndsAt; past_due from the subscription sets grace", async () => {
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ status: "trialing", trial_end: T + 86_400 }),
      ),
    );
    expect((await row(A)).trial_ends_at).toBe((T + 86_400) * 1000);
    const failing = event(
      "customer.subscription.updated",
      sub({ status: "past_due" }),
    );
    await deliver(failing);
    expect(await row(A)).toMatchObject({
      status: "past_due",
      grace_until: failing.created * 1000 + GRACE_MS,
    });
  });

  it("grace runs from the event's created time, not from a late delivery (L1)", async () => {
    await ownSub(A);
    const created = T - 3 * 86_400;
    const late = { now: NOW + 3 * 86_400_000, t: T + 3 * 86_400 };
    await deliver(event("invoice.payment_failed", inv(), { created }), late);
    expect((await row(A)).grace_until).toBe(created * 1000 + GRACE_MS);
    await db
      .prepare(
        "UPDATE tiers SET status='active', grace_until=NULL WHERE install_id=?",
      )
      .bind(A)
      .run();
    await deliver(
      event("customer.subscription.updated", sub({ status: "past_due" }), {
        created: created + 10,
      }),
      late,
    );
    expect((await row(A)).grace_until).toBe((created + 10) * 1000 + GRACE_MS);
  });

  it("an unfinished first payment changes nothing; only a live status sets the tier (N9)", async () => {
    await db
      .prepare("UPDATE tiers SET tier = 'trial' WHERE install_id = ?")
      .bind(A)
      .run();
    const before = await row(A);
    // incomplete: no tier, no subscription id, no status.
    await deliver(
      event(
        "customer.subscription.created",
        sub({ status: "incomplete", metadata: { tier: "business" } }),
      ),
    );
    expect(await row(A)).toMatchObject({
      tier: "trial",
      status: "active",
      stripe_subscription_id: null,
    });
    // incomplete_expired with no matching id: nothing changes but the key.
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ status: "incomplete_expired" }),
      ),
    );
    expect(await row(A)).toMatchObject({
      tier: "trial",
      status: "active",
      stripe_subscription_id: null,
    });
    // A canceled subscription never lapses a row that is not on a paid tier.
    await deliver(
      event("customer.subscription.updated", sub({ status: "canceled" })),
    );
    expect(await row(A)).toMatchObject({ tier: "trial", status: "active" });
    expect(before.tier).toBe("trial");
    // incomplete_expired clears the row's id only when it is the event's.
    await db
      .prepare(
        "UPDATE tiers SET status = 'active', stripe_subscription_id = 'sub_Test1' WHERE install_id = ?",
      )
      .bind(A)
      .run();
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ id: "sub_Test1", status: "incomplete_expired" }),
      ),
    );
    expect(await row(A)).toMatchObject({
      status: "active",
      stripe_subscription_id: null,
    });
  });

  it("a resubscribe's checkout in the second its old subscription ended still applies (N6)", async () => {
    await ownSub(A);
    await deliver(
      event(
        "checkout.session.completed",
        { customer: CUS_A, subscription: "sub_Test1", payment_status: "paid" },
        { created: T + 50 },
      ),
    );
    await deliver(
      event("customer.subscription.deleted", sub(), { created: T + 100 }),
    );
    expect((await row(A)).status).toBe("lapsed");
    const checkout = (subscription: string, id: string) =>
      event(
        "checkout.session.completed",
        {
          customer: CUS_A,
          subscription,
          payment_status: "paid",
          metadata: { tier: "business" },
        },
        { created: T + 100, id },
      );
    // The old subscription's own checkout, same second: still skipped.
    await deliver(checkout("sub_Test1", "evt_n6_same"));
    expect((await row(A)).status).toBe("lapsed");
    // A different subscription: the resubscribe applies.
    await deliver(checkout("sub_Test2", "evt_n6_new"));
    expect(await row(A)).toMatchObject({
      status: "active",
      tier: "business",
      stripe_subscription_id: "sub_Test2",
    });
  });

  it("an unfinished first payment's invoice never moves a row that has no live subscription (N9c)", async () => {
    await db
      .prepare("UPDATE tiers SET tier = 'trial' WHERE install_id = ?")
      .bind(A)
      .run();
    await deliver(
      event("customer.subscription.created", sub({ status: "incomplete" })),
    );
    await deliver(event("invoice.payment_failed", inv()));
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ status: "incomplete_expired" }),
      ),
    );
    expect(await row(A)).toMatchObject({
      tier: "trial",
      status: "active",
      grace_until: null,
      stripe_subscription_id: null,
    });
  });

  it("an unpaid checkout, its failed payment and its expiry leave a trial row on trial/active, no grace (N9c, async path)", async () => {
    await db
      .prepare("UPDATE tiers SET tier = 'trial' WHERE install_id = ?")
      .bind(A)
      .run();
    await deliver(
      event("checkout.session.completed", {
        customer: CUS_A,
        subscription: "sub_Test1",
        payment_status: "unpaid",
        metadata: { tier: "team" },
      }),
    );
    await deliver(event("invoice.payment_failed", inv()));
    expect(await row(A)).toMatchObject({
      tier: "trial",
      status: "active",
      grace_until: null,
    });
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ status: "incomplete_expired" }),
      ),
    );
    expect(await row(A)).toMatchObject({
      tier: "trial",
      status: "active",
      grace_until: null,
      stripe_subscription_id: null,
    });
  });

  // Timeout 20s: 2 tiers x 3 orders x 8 signed deliveries (48), about 50 ms each unloaded, with room for a loaded CI runner (default 5s).
  it("on a free or trial row no non-activating event, in any order, changes tier or status or sets grace (invariant)", async () => {
    const events = () => [
      event("customer.subscription.created", sub({ status: "incomplete" })),
      event("invoice.payment_failed", inv()),
      event("invoice.paid", inv()),
      event("customer.subscription.updated", sub({ status: "canceled" })),
      event("customer.subscription.deleted", sub()),
      event(
        "customer.subscription.updated",
        sub({ status: "incomplete_expired" }),
      ),
      event("invoice.payment_failed", { customer: CUS_A }),
      event("invoice.paid", { customer: CUS_A }),
    ];
    const orders: ((i: number) => number)[] = [
      (i) => i,
      (i) => 7 - i,
      (i) => (i * 3) % 8,
    ];
    for (const tier of ["trial", "free"])
      for (const order of orders) {
        await db
          .prepare(
            "UPDATE tiers SET tier = ?, status = 'active', grace_until = NULL, stripe_subscription_id = NULL WHERE install_id = ?",
          )
          .bind(tier, A)
          .run();
        const evs = events();
        for (let i = 0; i < evs.length; i++) {
          const e = evs[order(i)];
          await deliver(e);
          expect(await row(A), `${tier} after ${e?.type}`).toMatchObject({
            tier,
            status: "active",
            grace_until: null,
          });
        }
      }
  }, 20000);

  it("with price ids configured, a subscription whose price matches none logs unknown_price once", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const configured = {
      ...env,
      STRIPE_PRICE_TEAM: "price_T",
      STRIPE_PRICE_BUSINESS: "price_B",
    };
    const post = async (body: unknown, e: WebhookEnv) => {
      const text = JSON.stringify(body);
      return handleStripeWebhook(
        new Request("https://billing.example/stripe/webhook", {
          method: "POST",
          headers: {
            "stripe-signature": await signStripePayload(text, SECRET, T),
          },
          body: text,
        }),
        e,
        NOW,
      );
    };
    const unknown = sub({ items: { data: [{ price: { id: "price_X" } }] } });
    await post(event("customer.subscription.updated", unknown), configured);
    expect(lines.filter((l) => l.includes("unknown_price"))).toEqual([
      "billing webhook unknown_price",
    ]);
    // A known price, or no ids configured: no such line.
    lines.length = 0;
    await post(
      event(
        "customer.subscription.updated",
        sub({ items: { data: [{ price: { id: "price_B" } }] } }),
      ),
      configured,
    );
    await post(event("customer.subscription.updated", unknown), env);
    expect(lines.filter((l) => l.includes("unknown_price"))).toEqual([]);
  });

  it("an invoice naming no subscription never moves the row (N7)", async () => {
    await db
      .prepare("UPDATE tiers SET tier = 'trial' WHERE install_id = ?")
      .bind(A)
      .run();
    const before = await row(A);
    for (const type of ["invoice.payment_failed", "invoice.paid"]) {
      expect((await deliver(event(type, { customer: CUS_A }))).status).toBe(
        200,
      );
      expect(await row(A)).toEqual(before);
    }
  });

  it("subscription events and checkout never overwrite a suspended row (M3)", async () => {
    await db
      .prepare(
        "UPDATE tiers SET status='suspended', grace_until=555, stripe_subscription_id='sub_Test1' WHERE install_id=?",
      )
      .bind(A)
      .run();
    const evs = [
      event("customer.subscription.updated", sub({ status: "active" })),
      event("customer.subscription.updated", sub({ status: "past_due" })),
      event("customer.subscription.updated", sub({ status: "canceled" })),
      event("customer.subscription.deleted", sub()),
      event("checkout.session.completed", {
        customer: CUS_A,
        subscription: "sub_Test1",
        payment_status: "paid",
        metadata: { tier: "business" },
      }),
    ];
    for (const e of evs) {
      expect((await deliver(e)).status).toBe(200);
      expect(await row(A)).toMatchObject({
        status: "suspended",
        grace_until: 555,
      });
    }
    // The tier still follows the subscription.
    expect((await row(A)).tier).toBe("business");
  });

  it("a body with no Content-Length is read only up to MAX_WEBHOOK_BODY, then refused", async () => {
    // A chunked stream that never ends on its own: the reader must stop at the cap.
    let sent = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += chunk.byteLength;
        c.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request("https://billing.example/stripe/webhook", {
      method: "POST",
      body: stream,
      headers: { "stripe-signature": "t=1,v1=00" },
      // @ts-expect-error: Node/workerd need duplex for a streamed body
      duplex: "half",
    });
    expect(req.headers.get("content-length")).toBeNull();
    const r = await handleStripeWebhook(req, env, NOW);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("bad_body");
    expect(sent).toBeLessThanOrEqual(MAX_WEBHOOK_BODY + 2 * chunk.byteLength);
    expect(cancelled).toBe(true);
  });

  it("idempotent: a replayed event id changes nothing", async () => {
    const ev = event("invoice.payment_failed", inv());
    await deliver(ev);
    const once = await row(A);
    expect((await deliver(ev, { now: NOW + 5000 })).status).toBe(200);
    expect(await row(A)).toEqual(once);
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM stripe_events")
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
  });

  it("one install's event never changes another install's row", async () => {
    const before = await row(B);
    // Customer A's events, one of them naming install B everywhere it can.
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ status: "canceled", metadata: { install: B, tier: "business" } }),
      ),
    );
    await deliver(
      event("invoice.payment_failed", {
        customer: CUS_A,
        subscription: "sub_Test1",
        metadata: { install: B },
      }),
    );
    await deliver(
      event("checkout.session.completed", {
        customer: CUS_A,
        client_reference_id: B,
        payment_status: "paid",
        metadata: { install: B },
      }),
    );
    expect(await row(B)).toEqual(before);
    // The canceled update names no subscription the row holds, so it no longer
    // applies (a lapse needs its own subscription, #1568); the invoice never
    // did: only the checkout moved A.
    expect((await row(A)).version).toBe(2);
  });

  it("an unknown customer is 409 and its event id is not recorded, so Stripe retries", async () => {
    await ownSub(A);
    const a = await row(A);
    const b = await row(B);
    const ev = event("invoice.payment_failed", inv({ customer: "cus_Nobody" }));
    const res = await deliver(ev);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "unknown_customer" });
    expect(await row(A)).toEqual(a);
    expect(await row(B)).toEqual(b);
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM stripe_events")
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    // Billing then writes the customer; Stripe's retry of the same event applies.
    await db
      .prepare("UPDATE tiers SET stripe_customer_id = ? WHERE install_id = ?")
      .bind("cus_Nobody", A)
      .run();
    expect((await deliver(ev)).status).toBe(200);
    expect((await row(A)).status).toBe("past_due");
  });

  it("an unknown customer's event older than an hour is recorded and answered 200 (M2)", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const a = await row(A);
    // Just under the hour: still 409, not recorded.
    const young = event(
      "invoice.payment_failed",
      { customer: "cus_Nobody" },
      { created: T - 3599 },
    );
    expect((await deliver(young)).status).toBe(409);
    // An hour old: recorded, 200, nothing changes, a fixed category only.
    const old = event(
      "invoice.payment_failed",
      { customer: "cus_Nobody" },
      { created: T - 3600 },
    );
    const res = await deliver(old);
    expect(res.status).toBe(200);
    expect(await row(A)).toEqual(a);
    expect(
      (
        await db
          .prepare("SELECT event_id FROM stripe_events")
          .all<{ event_id: string }>()
      ).results,
    ).toEqual([{ event_id: old.id }]);
    expect(lines).toEqual([
      "billing webhook unknown_customer",
      "billing webhook unknown_customer",
    ]);
    // Its retry is a replay.
    expect((await deliver(old)).status).toBe(200);
  });

  it("checkout completed unpaid leaves status and tier for the invoice events", async () => {
    await db
      .prepare("UPDATE tiers SET status = 'lapsed' WHERE install_id = ?")
      .bind(A)
      .run();
    for (const payment_status of ["unpaid", undefined]) {
      await deliver(
        event("checkout.session.completed", {
          customer: CUS_A,
          subscription: "sub_Test1",
          payment_status,
          metadata: { tier: "business" },
        }),
      );
      expect(await row(A)).toMatchObject({
        tier: "trial",
        status: "lapsed",
        stripe_subscription_id: "sub_Test1",
      });
    }
    // An incomplete subscription sets no tier either.
    await deliver(
      event(
        "customer.subscription.created",
        sub({ status: "incomplete", metadata: { tier: "business" } }),
      ),
    );
    expect(await row(A)).toMatchObject({ tier: "trial", status: "lapsed" });
    await deliver(
      event("checkout.session.completed", {
        customer: CUS_A,
        subscription: "sub_Test1",
        payment_status: "no_payment_required",
        metadata: { tier: "business" },
      }),
    );
    expect(await row(A)).toMatchObject({ tier: "business", status: "active" });
  });

  describe("event ordering (stale events)", () => {
    const at = (created: number) => ({ created });
    // The ordering tests run on a paid row (only those go past_due or lapse).
    beforeEach(() => ownSub(A).then(() => undefined));

    it("deleted, then a delayed older updated: stays lapsed", async () => {
      await deliver(event("customer.subscription.deleted", sub(), at(T + 100)));
      expect(await row(A)).toMatchObject({
        status: "lapsed",
        last_event_created: T + 100,
      });
      const before = await row(A);
      const late = await deliver(
        event(
          "customer.subscription.updated",
          sub({ status: "active", metadata: { tier: "business" } }),
          at(T + 50),
        ),
      );
      expect(late.status).toBe(200);
      expect(await row(A)).toEqual(before);
    });

    it("deleted, then an updated from the same second: stays lapsed", async () => {
      await deliver(event("customer.subscription.deleted", sub(), at(T + 100)));
      await deliver(event("customer.subscription.updated", sub(), at(T + 100)));
      await deliver(event("invoice.paid", inv(), at(T + 100)));
      expect((await row(A)).status).toBe("lapsed");
    });

    it("a retried checkout.session.completed after deletion never revives the row", async () => {
      const checkout = event(
        "checkout.session.completed",
        {
          customer: CUS_A,
          subscription: "sub_Test1",
          payment_status: "paid",
          metadata: { tier: "team" },
        },
        at(T + 10),
      );
      await deliver(checkout);
      expect((await row(A)).status).toBe("active");
      await deliver(event("customer.subscription.deleted", sub(), at(T + 100)));
      // Stripe's retry: the same event id, and a second delivery of an
      // older checkout under a fresh id (both carry the original created).
      await deliver(checkout, { now: NOW + 60_000 });
      await deliver({ ...checkout, id: "evt_retry_other" });
      expect(await row(A)).toMatchObject({
        status: "lapsed",
        last_event_created: T + 100,
      });
    });

    it("a subscription event older than the last invoice moves the tier, not status or grace (R8, M1, #862)", async () => {
      await deliver(event("customer.subscription.updated", sub(), at(T + 10)));
      await deliver(event("invoice.payment_failed", inv(), at(T + 100)));
      const failed = await row(A);
      expect(failed).toMatchObject({
        tier: "team",
        status: "past_due",
        grace_until: (T + 100) * 1000 + GRACE_MS,
        last_event_created: T + 10,
        last_invoice_created: T + 100,
      });
      // Delayed: the Team to Business upgrade made at T+50 (status active
      // as of then, before the failed payment).
      const late = await deliver(
        event(
          "customer.subscription.updated",
          sub({
            status: "active",
            items: {
              data: [
                { price: { id: "price_B", metadata: { tier: "business" } } },
              ],
            },
          }),
          at(T + 50),
        ),
      );
      expect(late.status).toBe(200);
      expect(await row(A)).toMatchObject({
        tier: "business",
        status: "past_due",
        grace_until: failed.grace_until,
        last_event_created: T + 50,
        last_invoice_created: T + 100,
      });
    });

    // Timeout 10s: a dozen deliveries, with room for a loaded CI runner (default 5s).
    it("a second subscription's events never move the row (H2)", async () => {
      await deliver(
        event("checkout.session.completed", {
          customer: CUS_A,
          subscription: "sub_Test1",
          payment_status: "paid",
          metadata: { tier: "team" },
        }),
      );
      const before = await row(A);
      const other = sub({ id: "sub_Other9" });
      for (const e of [
        event("customer.subscription.deleted", other),
        event("customer.subscription.updated", {
          ...other,
          status: "past_due",
        }),
        event("invoice.payment_failed", inv({ subscription: "sub_Other9" })),
        // An invoice naming no subscription can't be the row's either.
        event("invoice.payment_failed", { customer: CUS_A }),
        // Newer API shape.
        event("invoice.payment_failed", {
          customer: CUS_A,
          parent: { subscription_details: { subscription: "sub_Other9" } },
        }),
      ]) {
        expect((await deliver(e)).status).toBe(200);
        expect(await row(A)).toEqual(before);
      }
      // The row's own subscription still applies (also in the newer shape).
      await deliver(
        event("invoice.payment_failed", {
          customer: CUS_A,
          parent: { subscription_details: { subscription: "sub_Test1" } },
        }),
      );
      expect((await row(A)).status).toBe("past_due");
      await deliver(event("customer.subscription.deleted", sub()));
      expect((await row(A)).status).toBe("lapsed");
    }, 10000);

    it("a delayed invoice never undoes a newer subscription change, nor an older invoice a newer one (R8)", async () => {
      await deliver(event("customer.subscription.updated", sub(), at(T + 100)));
      const before = await row(A);
      // Older than the subscription's state: skipped.
      await deliver(event("invoice.payment_failed", inv(), at(T + 60)));
      expect(await row(A)).toEqual(before);
      // Newer: applies. Then an older invoice of its own stream: skipped.
      await deliver(event("invoice.payment_failed", inv(), at(T + 120)));
      await deliver(event("invoice.paid", inv(), at(T + 130)));
      expect((await row(A)).status).toBe("active");
      const paid = await row(A);
      await deliver(event("invoice.payment_failed", inv(), at(T + 125)));
      expect(await row(A)).toEqual(paid);
      expect(paid).toMatchObject({
        last_event_created: T + 100,
        last_invoice_created: T + 130,
      });
    });

    it("a stale event is recorded once, logged stale; a newer event still applies", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
      await deliver(event("customer.subscription.deleted", sub(), at(T + 100)));
      await deliver(event("customer.subscription.updated", sub(), at(T + 99)));
      expect(lines).toEqual([
        `billing webhook applied ${A}`,
        "billing webhook stale",
      ]);
      // A new subscription later on: newer, so it applies.
      await deliver(
        event(
          "checkout.session.completed",
          {
            customer: CUS_A,
            subscription: "sub_Test2",
            payment_status: "paid",
          },
          at(T + 200),
        ),
      );
      expect(await row(A)).toMatchObject({
        status: "active",
        stripe_subscription_id: "sub_Test2",
        last_event_created: T + 200,
      });
    });
  });

  it("refuses before parsing: bad or stale signature, wrong secret, oversize; nothing written", async () => {
    const ev = event("invoice.payment_failed", { customer: CUS_A });
    expect((await deliver(ev, { secret: "whsec_someone_else" })).status).toBe(
      400,
    );
    expect((await deliver(ev, { t: T - STRIPE_TOLERANCE_S - 1 })).status).toBe(
      400,
    );
    const big = await handleStripeWebhook(
      new Request("https://billing.example/stripe/webhook", {
        method: "POST",
        headers: {
          "content-length": String(2 * 1024 * 1024),
          "stripe-signature": "t=1,v1=00",
        },
        body: "x",
      }),
      env,
      NOW,
    );
    expect(big.status).toBe(400);
    // A signed body that isn't an event: signature first, then 400 bad_event.
    expect((await deliver(null, { text: '{"hello":1}' })).status).toBe(400);
    expect((await row(A)).version).toBe(1);
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM stripe_events")
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    const misconfigured = await handleStripeWebhook(
      new Request("https://billing.example/stripe/webhook", {
        method: "POST",
        body: "{}",
      }),
      { ...env, STRIPE_WEBHOOK_SECRET: "" },
      NOW,
    );
    expect(misconfigured.status).toBe(500);
  });

  it("a livemode event changes nothing (test mode only)", async () => {
    const before = await row(A);
    expect(
      (
        await deliver(
          event(
            "invoice.payment_failed",
            { customer: CUS_A },
            { livemode: true },
          ),
        )
      ).status,
    ).toBe(200);
    expect(await row(A)).toEqual(before);
  });

  it("logs carry fixed categories and install ids only: no body, header or Stripe id", async () => {
    const lines: string[] = [];
    for (const m of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
    await deliver(event("customer.subscription.updated", sub()));
    await deliver(event("invoice.paid", { customer: "cus_Nobody" }));
    await deliver(event("invoice.paid", { customer: CUS_A }), {
      secret: "whsec_bad",
    });
    const all = lines.join("\n");
    expect(lines).toEqual([
      `billing webhook applied ${A}`,
      "billing webhook unknown_customer",
      "billing webhook bad_signature_mismatch",
    ]);
    for (const s of [
      CUS_A,
      "cus_Nobody",
      "sub_Test1",
      "evt_test",
      SECRET,
      "price_Team",
    ])
      expect(all).not.toContain(s);
  });

  it("a past_due update sets the tier but never a free or trial row's status or grace (#1487, B3/B4)", async () => {
    for (const tier of ["trial", "free"]) {
      await db
        .prepare(
          "UPDATE tiers SET tier = ?, status = 'active', grace_until = NULL, stripe_subscription_id = NULL WHERE install_id = ?",
        )
        .bind(tier, A)
        .run();
      await deliver(
        event("customer.subscription.updated", sub({ status: "past_due" })),
      );
      // B4: the activating events were reordered behind this one; the row
      // no longer waits on a later active update for its tier.
      expect(await row(A), tier).toMatchObject({
        tier: "team",
        status: "active",
        grace_until: null,
        stripe_subscription_id: "sub_Test1",
      });
    }
  });

  it("a past_due Business row downgraded to Team in the Portal takes the Team tier (#1487, B3)", async () => {
    await db
      .prepare(
        "UPDATE tiers SET tier = 'business', stripe_subscription_id = 'sub_Test1' WHERE install_id = ?",
      )
      .bind(A)
      .run();
    const failed = event("invoice.payment_failed", inv());
    await deliver(failed);
    expect((await row(A)).status).toBe("past_due");
    await deliver(
      event("customer.subscription.updated", sub({ status: "past_due" })),
    );
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "past_due",
      grace_until: failed.created * 1000 + GRACE_MS,
    });
  });

  it("an unfinished first payment still never sets a tier (incomplete, #1487)", async () => {
    await deliver(
      event(
        "customer.subscription.created",
        sub({ status: "incomplete", metadata: { tier: "business" } }),
      ),
    );
    expect(await row(A)).toMatchObject({ tier: "trial", status: "active" });
  });
});

// ---------------------------------------------------------------- Solo

describe("Solo (#1568)", () => {
  const SOLO_M = "price_SoloMonth1";
  const SOLO_Y = "price_SoloYear1";
  const soloEnv: WebhookEnv = {
    ...env,
    STRIPE_PRICE_TEAM: "price_T",
    STRIPE_PRICE_BUSINESS: "price_B",
    STRIPE_PRICE_SOLO_MONTHLY: SOLO_M,
    STRIPE_PRICE_SOLO_YEARLY: SOLO_Y,
  };
  const prices = {
    team: "price_T",
    business: "price_B",
    soloMonthly: SOLO_M,
    soloYearly: SOLO_Y,
  };
  const soloSub = (o: Record<string, unknown> = {}, price = SOLO_M) =>
    sub({ items: { data: [{ price: { id: price } }] }, ...o });
  const asSolo = () =>
    db
      .prepare(
        "UPDATE tiers SET tier = 'solo', status = 'active', stripe_subscription_id = 'sub_Test1' WHERE install_id = ?",
      )
      .bind(A)
      .run();

  it("the yearly Team and Business prices name team and business, and are not unknown (#2136)", () => {
    const yp = {
      ...prices,
      teamYearly: "price_TY",
      businessYearly: "price_BY",
    };
    const one = (id: string) => sub({ items: { data: [{ price: { id } }] } });
    expect(tierFromSubscription(one("price_TY"), yp)).toBe("team");
    expect(tierFromSubscription(one("price_BY"), yp)).toBe("business");
    expect(unknownPrice(one("price_TY"), yp)).toBe(false);
    expect(unknownPrice(one("price_BY"), yp)).toBe(false);
    expect(unknownPrice(one("price_Z"), yp)).toBe(true);
    // Unset (empty env) yearly ids match nothing, even an empty price id.
    expect(
      pricesOf({ STRIPE_PRICE_TEAM_YEARLY: "" } as never).teamYearly,
    ).toBeUndefined();
    expect(tierFromSubscription(one("price_TY"), prices)).toBeNull();
    expect(unknownPrice(one("price_TY"), prices)).toBe(true);
  });

  it("either Solo price names the tier solo; an unknown price does not", () => {
    expect(tierFromSubscription(soloSub(), prices)).toBe("solo");
    expect(tierFromSubscription(soloSub({}, SOLO_Y), prices)).toBe("solo");
    expect(
      tierFromSubscription(
        sub({
          items: { data: [{ price: { id: "price_X", lookup_key: "solo" } }] },
        }),
        prices,
      ),
    ).toBeNull();
    // Team and Business still map by their own ids.
    expect(
      tierFromSubscription(
        sub({ items: { data: [{ price: { id: "price_T" } }] } }),
        prices,
      ),
    ).toBe("team");
    // Without the ids: price metadata or the subscription's metadata.
    expect(
      tierFromSubscription(
        sub({
          items: {
            data: [{ price: { id: "price_X", metadata: { tier: "solo" } } }],
          },
        }),
      ),
    ).toBe("solo");
  });

  it("a no-card Solo trial: tier solo and active, the subscription kept, trial_ends_at left for the Business trial", async () => {
    await db
      .prepare(
        "UPDATE tiers SET tier = 'solo', stripe_subscription_id = NULL WHERE install_id = ?",
      )
      .bind(A)
      .run();
    const r = await deliver(
      event(
        "customer.subscription.created",
        soloSub({ status: "trialing", trial_end: T + 30 * 86_400 }),
      ),
      { env: soloEnv },
    );
    expect(r.status).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "active",
      grace_until: null,
      stripe_subscription_id: "sub_Test1",
      // Solo's trial end is not the Business trial's: a set
      // trial_ends_at would end the first invite's trial for good.
      trial_ends_at: null,
    });
  });

  it("the Solo trial ends with no card: the subscription is canceled and the row is lapsed", async () => {
    await asSolo();
    await deliver(
      event("customer.subscription.deleted", soloSub({ status: "canceled" })),
      { env: soloEnv },
    );
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "lapsed",
      grace_until: null,
    });
    // Buying again (a new Checkout) revives it.
    await deliver(
      event("checkout.session.completed", {
        customer: CUS_A,
        subscription: "sub_Test2",
        payment_status: "paid",
        metadata: { tier: "solo" },
      }),
      { env: soloEnv },
    );
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "active",
      stripe_subscription_id: "sub_Test2",
    });
  });

  it("the paid-tier invariant covers solo: a failed payment starts grace once, paid ends it", async () => {
    await asSolo();
    const failed = event("invoice.payment_failed", inv());
    await deliver(failed, { env: soloEnv });
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "past_due",
      grace_until: failed.created * 1000 + GRACE_MS,
    });
    await deliver(event("invoice.paid", inv()), { env: soloEnv });
    expect(await row(A)).toMatchObject({ status: "active", grace_until: null });
    const failing = event(
      "customer.subscription.updated",
      soloSub({ status: "past_due" }),
    );
    await deliver(failing, { env: soloEnv });
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "past_due",
      grace_until: failing.created * 1000 + GRACE_MS,
    });
  });

  it("a checkout for a Solo price completes into tier solo", async () => {
    await db
      .prepare("UPDATE tiers SET tier = 'solo' WHERE install_id = ?")
      .bind(A)
      .run();
    await deliver(
      event("checkout.session.completed", {
        customer: CUS_A,
        subscription: "sub_Test1",
        payment_status: "paid",
        metadata: { tier: "solo" },
      }),
      { env: soloEnv },
    );
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "active",
      stripe_subscription_id: "sub_Test1",
    });
  });

  // Timeout 10s: two rows, three deliveries each, with room for a loaded CI runner (default 5s).
  it("a trial or free row (no live subscription) still never moves: solo does not widen the invariant", async () => {
    for (const tier of ["trial", "free"]) {
      await db
        .prepare(
          "UPDATE tiers SET tier = ?, status = 'active', grace_until = NULL, stripe_subscription_id = NULL WHERE install_id = ?",
        )
        .bind(tier, A)
        .run();
      for (const e of [
        event("invoice.payment_failed", inv()),
        event("customer.subscription.updated", soloSub({ status: "canceled" })),
        event("customer.subscription.deleted", soloSub()),
      ]) {
        await deliver(e, { env: soloEnv });
        expect(await row(A), `${tier} after ${e.type}`).toMatchObject({
          tier,
          status: "active",
          grace_until: null,
        });
      }
    }
  }, 10000);

  it("a delayed active update after a payment failure leaves grace_until unchanged (#862)", async () => {
    await asSolo();
    const failed = event("invoice.payment_failed", inv(), { created: T + 100 });
    await deliver(failed, { env: soloEnv });
    const graced = await row(A);
    expect(graced.grace_until).toBe((T + 100) * 1000 + GRACE_MS);
    // The update was made before the failure (T+50) and arrives after it.
    await deliver(
      event("customer.subscription.updated", soloSub({ status: "active" }), {
        created: T + 50,
      }),
      { env: soloEnv },
    );
    expect(await row(A)).toMatchObject({
      status: "past_due",
      grace_until: graced.grace_until,
    });
    // A genuinely newer active update does end the grace.
    await deliver(
      event("customer.subscription.updated", soloSub({ status: "active" }), {
        created: T + 200,
      }),
      { env: soloEnv },
    );
    expect(await row(A)).toMatchObject({ status: "active", grace_until: null });
  });
});

// ---------------------------------------------------------------- prune

describe("pruning stripe_events (#1479)", () => {
  const ids = async () =>
    (
      await db
        .prepare("SELECT event_id FROM stripe_events ORDER BY event_id")
        .all<{ event_id: string }>()
    ).results.map((r) => r.event_id);

  it("deletes ids received more than 30 days ago and keeps the rest; answers how many", async () => {
    expect(STRIPE_EVENT_RETENTION_MS).toBe(30 * 86_400_000);
    const rows: [string, number][] = [
      ["evt_old1", NOW - STRIPE_EVENT_RETENTION_MS - 1],
      ["evt_old2", 0],
      ["evt_edge", NOW - STRIPE_EVENT_RETENTION_MS],
      ["evt_new1", NOW - 1000],
      ["evt_new2", NOW],
    ];
    await db.batch(
      rows.map(([id, at]) =>
        db
          .prepare(
            "INSERT INTO stripe_events (event_id, received_at) VALUES (?, ?)",
          )
          .bind(id, at),
      ),
    );
    expect(await pruneStripeEvents(db, NOW)).toBe(2);
    expect(await ids()).toEqual(["evt_edge", "evt_new1", "evt_new2"]);
    // Nothing left to prune: 0, and nothing else changes.
    expect(await pruneStripeEvents(db, NOW)).toBe(0);
    expect(await ids()).toEqual(["evt_edge", "evt_new1", "evt_new2"]);
  });

  it("touches no tiers row and no other table", async () => {
    const before = await row(A);
    await pruneStripeEvents(db, NOW + 400 * 86_400_000);
    expect(await row(A)).toEqual(before);
  });

  it("a pruned id arriving again is handled as any event: an older one never undoes newer state", async () => {
    await ownSub(A);
    const active = event("customer.subscription.updated", sub(), {
      created: T + 10,
    });
    await deliver(active);
    const deleted = event("customer.subscription.deleted", sub(), {
      created: T + 100,
    });
    await deliver(deleted);
    const lapsed = await row(A);
    expect(lapsed).toMatchObject({ status: "lapsed" });
    // 31 days on, both ids are pruned; Stripe (or a replayer with a fresh
    // signature) delivers the old active update again.
    const later = NOW + 31 * 86_400_000;
    expect(await pruneStripeEvents(db, later)).toBe(2);
    expect(await ids()).toEqual([]);
    const again = await deliver(active, {
      now: later,
      t: Math.floor(later / 1000),
    });
    expect(again.status).toBe(200);
    expect(await row(A)).toEqual(lapsed);
    // It is recorded again (as stale), so a third delivery is a plain replay.
    expect(await ids()).toEqual([active.id]);
    const third = await deliver(active, {
      now: later,
      t: Math.floor(later / 1000),
    });
    expect(third.status).toBe(200);
    expect(await row(A)).toEqual(lapsed);
  });

  it("a pruned id for the newest event applies once more, harmlessly, and then dedupes", async () => {
    await ownSub(A);
    const failed = event("invoice.payment_failed", inv(), { created: T + 5 });
    await deliver(failed);
    const first = await row(A);
    const later = NOW + 40 * 86_400_000;
    await pruneStripeEvents(db, later);
    const t = Math.floor(later / 1000);
    await deliver(failed, { now: later, t });
    // Same status and the same grace (grace is kept once set).
    expect(await row(A)).toMatchObject({
      status: "past_due",
      grace_until: first.grace_until,
    });
  });
});

// ---------------------------------------------------------------- upgrade

describe("Solo to Team or Business through Checkout (#1568)", () => {
  const KEY = "sk_test_notarealkey0000";
  const soloLive = () =>
    db
      .prepare(
        "UPDATE tiers SET tier = 'solo', status = 'active', stripe_subscription_id = 'sub_Old1', last_event_created = NULL, last_invoice_created = NULL WHERE install_id = ?",
      )
      .bind(A)
      .run();
  const completed = (sub: string, o: Record<string, unknown> = {}) =>
    event("checkout.session.completed", {
      customer: CUS_A,
      subscription: sub,
      payment_status: "paid",
      metadata: { tier: "team" },
      ...o,
    });
  /** Stripe as the cancel uses it: reads, then deletes; `del` can fail. */
  function stripe(o: { del?: number; state?: string } = {}) {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const m = String(init.method);
      calls.push(`${m} ${new URL(url).pathname}`);
      if (m === "GET")
        return Response.json({ id: "sub_Old1", status: o.state ?? "active" });
      return o.del
        ? Response.json({ error: { type: "api_error" } }, { status: o.del })
        : Response.json({ id: "sub_Old1", status: "canceled" });
    }) as unknown as typeof fetch;
    return {
      calls,
      e: { ...env, STRIPE_SECRET_KEY: KEY, stripeFetch: f } as WebhookEnv,
    };
  }

  it("a paid checkout for another subscription switches the row, then cancels the previous one", async () => {
    await soloLive();
    const s = stripe();
    const r = await deliver(completed("sub_New1"), { env: s.e });
    expect(r.status).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "active",
      stripe_subscription_id: "sub_New1",
    });
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      "DELETE /v1/subscriptions/sub_Old1",
    ]);

    expect(await pending()).toEqual([]);
  });

  it("the cancel fails: the webhook answers 500, the intent is kept, and Stripe's retry finishes it once", async () => {
    await soloLive();
    const bad = stripe({ del: 500 });
    const ev = completed("sub_New1");
    const first = await deliver(ev, { env: bad.e });
    expect(first.status).toBe(500);
    // The row moved on, so the old subscription's own events can't touch it.
    expect(await row(A)).toMatchObject({
      tier: "team",
      stripe_subscription_id: "sub_New1",
    });
    expect(await pending()).toEqual(["sub_Old1"]);
    // Stripe retries the same event id: a replay, which still settles the cancel.
    const good = stripe();
    const retry = await deliver(ev, { env: good.e });
    expect(retry.status).toBe(200);
    expect(good.calls).toEqual([
      "GET /v1/subscriptions/sub_Old1",
      "DELETE /v1/subscriptions/sub_Old1",
    ]);
    expect(await pending()).toEqual([]);
    // A third delivery cancels nothing more.
    const again = stripe();
    expect((await deliver(ev, { env: again.e })).status).toBe(200);
    expect(again.calls).toEqual([]);
  });

  it("no cancel when the previous subscription is dead or is the same one, and not for an unpaid checkout", async () => {
    // Same subscription.
    await soloLive();
    let s = stripe();
    await deliver(completed("sub_Old1"), { env: s.e });
    expect(s.calls).toEqual([]);
    // Previous lapsed: nothing left to cancel.
    await soloLive();
    await db
      .prepare("UPDATE tiers SET status = 'lapsed' WHERE install_id = ?")
      .bind(A)
      .run();
    s = stripe();
    await deliver(completed("sub_New2"), { env: s.e });
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    // Unpaid (async payment pending): the old one is kept.
    await soloLive();
    s = stripe();
    await deliver(completed("sub_New3", { payment_status: "unpaid" }), {
      env: s.e,
    });
    expect(s.calls).toEqual([]);
  });

  // Timeout 10s: three keys, each two deliveries, with room for a loaded CI runner (default 5s).
  it("a live Stripe key or no key never reaches Stripe: 500 before anything is written, so Stripe retries", async () => {
    for (const key of [
      "sk_live_abcdefgh12345678",
      "rk_live_abcdefgh12345678",
      undefined,
    ]) {
      await soloLive();
      const s = stripe();
      const ev = completed("sub_New1");
      const r = await deliver(ev, { env: { ...s.e, STRIPE_SECRET_KEY: key } });
      expect(r.status, String(key)).toBe(500);
      expect(s.calls).toEqual([]);
      // Nothing changed and the event is not recorded: the retry applies it.
      expect(await row(A)).toMatchObject({
        tier: "solo",
        stripe_subscription_id: "sub_Old1",
      });
      expect(await pending()).toEqual([]);
      expect((await deliver(ev, { env: s.e })).status).toBe(200);
      expect(await row(A)).toMatchObject({
        tier: "team",
        stripe_subscription_id: "sub_New1",
      });
    }
  }, 10000);

  it("a pruned id arriving again settles nothing new and never cancels the current subscription", async () => {
    await soloLive();
    const s = stripe();
    const ev = completed("sub_New1");
    await deliver(ev, { env: s.e });
    await pruneStripeEvents(db, NOW + 40 * 86_400_000);
    const later = NOW + 40 * 86_400_000;
    const again = stripe();
    await deliver(ev, {
      env: again.e,
      now: later,
      t: Math.floor(later / 1000),
    });
    expect(again.calls).toEqual([]);
    expect(await row(A)).toMatchObject({
      tier: "team",
      stripe_subscription_id: "sub_New1",
    });
  });
});

// ------------------------------------------------- the current subscription only

describe("subscription events apply only to the row's current subscription (#1568)", () => {
  const OLD = "sub_Old1";
  const NEW = "sub_New1";
  const KEY = "sk_test_notarealkey0000";
  const teamPrice = {
    items: { data: [{ price: { id: "price_Team", lookup_key: "team" } }] },
  };
  const soloPrice = {
    items: {
      data: [{ price: { id: "price_SoloX", metadata: { tier: "solo" } } }],
    },
  };
  const subOf = (id: string, o: Record<string, unknown> = {}) =>
    sub({ id, ...teamPrice, ...o });
  const soloOf = (id: string, o: Record<string, unknown> = {}) =>
    sub({ id, ...soloPrice, ...o });
  const solo = (id: string | null) =>
    db
      .prepare(
        "UPDATE tiers SET tier = 'solo', status = 'active', grace_until = NULL, stripe_subscription_id = ?, last_event_created = NULL, last_invoice_created = NULL WHERE install_id = ?",
      )
      .bind(id, A)
      .run();
  const paidCheckout = (sub: string, o: Record<string, unknown> = {}) =>
    event("checkout.session.completed", {
      customer: CUS_A,
      subscription: sub,
      payment_status: "paid",
      metadata: { tier: "team" },
      ...o,
    });
  const okStripe = () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      return Response.json({
        id: OLD,
        status: init.method === "GET" ? "active" : "canceled",
      });
    }) as unknown as typeof fetch;
    return {
      calls,
      e: { ...env, STRIPE_SECRET_KEY: KEY, stripeFetch: f } as WebhookEnv,
    };
  };

  // Timeout 10s: an upgrade then six deliveries, with room for a loaded CI runner (default 5s).
  it("after the upgrade, the old Solo subscription's deleted, canceled, past_due and active events change nothing", async () => {
    await solo(OLD);
    const s = okStripe();
    await deliver(paidCheckout(NEW), { env: s.e });
    const upgraded = await row(A);
    expect(upgraded).toMatchObject({
      tier: "team",
      status: "active",
      stripe_subscription_id: NEW,
    });
    for (const e of [
      event(
        "customer.subscription.deleted",
        soloOf(OLD, { status: "canceled" }),
      ),
      event(
        "customer.subscription.updated",
        soloOf(OLD, { status: "canceled" }),
      ),
      event(
        "customer.subscription.updated",
        soloOf(OLD, { status: "past_due" }),
      ),
      event("customer.subscription.updated", soloOf(OLD, { status: "active" })),
      event("invoice.payment_failed", inv({ subscription: OLD })),
      event("invoice.paid", inv({ subscription: OLD })),
    ]) {
      await deliver(e, { env: s.e });
      const now = await row(A);
      expect(now, e.type).toMatchObject({
        tier: "team",
        status: "active",
        grace_until: null,
        stripe_subscription_id: NEW,
      });
    }
  }, 10000);

  it("the new subscription's events arriving before checkout.session.completed are ignored, then the checkout applies", async () => {
    await solo(OLD);
    const s = okStripe();
    for (const e of [
      event("customer.subscription.created", subOf(NEW, { status: "active" })),
      event(
        "customer.subscription.updated",
        subOf(NEW, { status: "past_due" }),
      ),
      event("invoice.paid", inv({ subscription: NEW })),
    ])
      await deliver(e, { env: s.e });
    // The row is still the Solo's: nothing from the unconfirmed subscription.
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "active",
      grace_until: null,
      stripe_subscription_id: OLD,
    });
    expect(s.calls).toEqual([]);
    await deliver(paidCheckout(NEW), { env: s.e });
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "active",
      stripe_subscription_id: NEW,
    });
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      `DELETE /v1/subscriptions/${OLD}`,
    ]);
  });

  it("a row with no subscription takes the first live one in any order; a lapse needs its own subscription", async () => {
    await solo(null);
    await deliver(
      event(
        "customer.subscription.deleted",
        subOf(NEW, { status: "canceled" }),
      ),
    );
    await deliver(
      event(
        "customer.subscription.updated",
        subOf(NEW, { status: "canceled" }),
      ),
    );
    // A stray lapse never moves a row that holds no subscription.
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "active",
      stripe_subscription_id: null,
    });
    await deliver(
      event("customer.subscription.updated", subOf(NEW, { status: "active" })),
    );
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "active",
      stripe_subscription_id: NEW,
    });
    // The checkout for the same subscription then finds nothing to cancel.
    const s = okStripe();
    await deliver(paidCheckout(NEW), { env: s.e });
    expect(s.calls).toEqual([]);
    // A comped paid row without a subscription is not lapsed by a stray delete.
    await db
      .prepare(
        "UPDATE tiers SET tier = 'team', status = 'active', stripe_subscription_id = NULL, last_event_created = NULL WHERE install_id = ?",
      )
      .bind(A)
      .run();
    await deliver(event("customer.subscription.deleted", subOf("sub_Stray1")));
    expect(await row(A)).toMatchObject({ tier: "team", status: "active" });
  });

  it("async payment: an unpaid checkout leaves the live Solo as it is; its events are ignored; async_payment_succeeded then upgrades and cancels", async () => {
    await solo(OLD);
    const s = okStripe();
    await deliver(paidCheckout(NEW, { payment_status: "unpaid" }), {
      env: s.e,
    });
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "active",
      stripe_subscription_id: OLD,
    });
    for (const e of [
      event(
        "customer.subscription.updated",
        subOf(NEW, { status: "incomplete" }),
      ),
      event("invoice.payment_failed", inv({ subscription: NEW })),
      event("customer.subscription.updated", subOf(NEW, { status: "active" })),
      event("checkout.session.async_payment_failed", {
        customer: CUS_A,
        subscription: NEW,
      }),
    ])
      await deliver(e, { env: s.e });
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "active",
      grace_until: null,
      stripe_subscription_id: OLD,
    });
    expect(s.calls).toEqual([]);
    const ok = await deliver(
      event("checkout.session.async_payment_succeeded", {
        customer: CUS_A,
        subscription: NEW,
        payment_status: "paid",
        metadata: { tier: "team" },
      }),
      { env: s.e },
    );
    expect(ok.status).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "active",
      stripe_subscription_id: NEW,
    });
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      `DELETE /v1/subscriptions/${OLD}`,
    ]);
  });

  it("async payment on a row with no live subscription still records the pending one, so its invoices apply (N9c)", async () => {
    await solo(null);
    await deliver(paidCheckout(NEW, { payment_status: "unpaid" }));
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "active",
      stripe_subscription_id: NEW,
    });
  });
});

// ------------------------------------------------- Business trial over a Solo subscription

describe("the Business trial on top of a Solo subscription (#1568)", () => {
  const OLD = "sub_Old1";
  const NEW = "sub_New1";
  const KEY = "sk_test_notarealkey0000";
  const SOLO_END = (T + 20 * 86_400) * 1000;
  const TRIAL_END = (T + 10 * 86_400) * 1000;
  const soloPrice = {
    items: {
      data: [{ price: { id: "price_SoloX", metadata: { tier: "solo" } } }],
    },
  };
  const soloOf = (o: Record<string, unknown> = {}) =>
    sub({ id: OLD, ...soloPrice, ...o });
  /** A row in its 30-day Business trial that still holds a live Solo subscription. */
  const trialOverSolo = (solo: string | null = "active") =>
    db
      .prepare(
        "UPDATE tiers SET tier = 'trial', status = 'active', grace_until = NULL, trial_ends_at = ?, stripe_subscription_id = ?, solo_status = ?, solo_grace_until = NULL, solo_trial_ends_at = ?, last_event_created = NULL, last_invoice_created = NULL WHERE install_id = ?",
      )
      .bind(TRIAL_END, solo === null ? null : OLD, solo, SOLO_END, A)
      .run();
  type R = Row & {
    solo_status: string | null;
    solo_grace_until: number | null;
    solo_trial_ends_at: number | null;
  };
  const r = () => row(A) as Promise<R>;
  const stays = {
    tier: "trial",
    status: "active",
    grace_until: null,
    trial_ends_at: TRIAL_END,
  };
  const okStripe = () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      return Response.json({
        id: OLD,
        status: init.method === "GET" ? "active" : "canceled",
      });
    }) as unknown as typeof fetch;
    return {
      calls,
      e: { ...env, STRIPE_SECRET_KEY: KEY, stripeFetch: f } as WebhookEnv,
    };
  };

  it("Solo-priced events never end the trial or touch its dates; the Solo state is recorded beside it", async () => {
    await trialOverSolo();
    // Active, trialing with a new end, past due, then paid again, then canceled.
    await deliver(
      event(
        "customer.subscription.updated",
        soloOf({ status: "trialing", trial_end: T + 25 * 86_400 }),
      ),
    );
    expect(await r()).toMatchObject({
      ...stays,
      solo_status: "active",
      solo_trial_ends_at: (T + 25 * 86_400) * 1000,
      stripe_subscription_id: OLD,
    });
    const failing = event(
      "customer.subscription.updated",
      soloOf({ status: "past_due" }),
    );
    await deliver(failing);
    expect(await r()).toMatchObject({
      ...stays,
      solo_status: "past_due",
      solo_grace_until: failing.created * 1000 + GRACE_MS,
    });
    await deliver(
      event("customer.subscription.updated", soloOf({ status: "active" })),
    );
    expect(await r()).toMatchObject({
      ...stays,
      solo_status: "active",
      solo_grace_until: null,
    });
    await deliver(
      event("customer.subscription.deleted", soloOf({ status: "canceled" })),
    );
    // A lapse during the trial is recorded, not dropped: the trial still runs.
    expect(await r()).toMatchObject({ ...stays, solo_status: "lapsed" });
  });

  it("invoices of the Solo subscription during the trial are recorded the same way", async () => {
    await trialOverSolo();
    const failed = event("invoice.payment_failed", inv({ subscription: OLD }));
    await deliver(failed);
    expect(await r()).toMatchObject({
      ...stays,
      solo_status: "past_due",
      solo_grace_until: failed.created * 1000 + GRACE_MS,
    });
    await deliver(event("invoice.paid", inv({ subscription: OLD })));
    expect(await r()).toMatchObject({
      ...stays,
      solo_status: "active",
      solo_grace_until: null,
    });
    // No Solo subscription, no record: an unfinished first payment changes nothing (N9c).
    await trialOverSolo(null);
    await deliver(event("invoice.payment_failed", inv({ subscription: OLD })));
    expect(await r()).toMatchObject({ ...stays, solo_status: null });
  });

  it("a paid Solo checkout during the trial keeps the trial, records the new Solo, and cancels the old one", async () => {
    await trialOverSolo();
    const s = okStripe();
    await deliver(
      event("checkout.session.completed", {
        customer: CUS_A,
        subscription: NEW,
        payment_status: "paid",
        metadata: { tier: "solo" },
      }),
      { env: s.e },
    );
    expect(await r()).toMatchObject({
      ...stays,
      stripe_subscription_id: NEW,
      solo_status: "active",
    });
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      `DELETE /v1/subscriptions/${OLD}`,
    ]);
  });

  it("a Team checkout during the trial ends it for the paid plan and cancels the live Solo", async () => {
    await trialOverSolo();
    const s = okStripe();
    await deliver(
      event("checkout.session.completed", {
        customer: CUS_A,
        subscription: NEW,
        payment_status: "paid",
        metadata: { tier: "team" },
      }),
      { env: s.e },
    );
    expect(await r()).toMatchObject({
      tier: "team",
      status: "active",
      stripe_subscription_id: NEW,
      trial_ends_at: TRIAL_END,
    });
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      `DELETE /v1/subscriptions/${OLD}`,
    ]);
  });

  it("a trial row with no live Solo (an unfinished first payment) cancels nothing on a later checkout", async () => {
    await trialOverSolo(null);
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = 'sub_Unpaid1' WHERE install_id = ?",
      )
      .bind(A)
      .run();
    const s = okStripe();
    await deliver(
      event("checkout.session.completed", {
        customer: CUS_A,
        subscription: NEW,
        payment_status: "paid",
        metadata: { tier: "team" },
      }),
      { env: s.e },
    );
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });

  it("outside the trial a Solo event still moves the row as before (solo tier, status, grace)", async () => {
    await db
      .prepare(
        "UPDATE tiers SET tier = 'solo', status = 'active', trial_ends_at = ?, stripe_subscription_id = ?, solo_status = NULL, last_event_created = NULL WHERE install_id = ?",
      )
      .bind(TRIAL_END - 99 * 86_400_000, OLD, A)
      .run();
    const e = event(
      "customer.subscription.updated",
      soloOf({ status: "past_due" }),
    );
    await deliver(e);
    expect(await r()).toMatchObject({
      tier: "solo",
      status: "past_due",
      grace_until: e.created * 1000 + GRACE_MS,
      solo_status: null,
    });
  });
});

// ------------------------------------------------- paying during the Solo trial

describe("a Solo checkout during the no-card trial (#1568)", () => {
  const OLD = "sub_Old1";
  const NEW = "sub_New1";
  const KEY = "sk_test_notarealkey0000";
  const ENDS = (T + 10 * 86_400) * 1000;
  const trialing = () =>
    db
      .prepare(
        "UPDATE tiers SET tier = 'solo', status = 'active', trial_ends_at = NULL, stripe_subscription_id = ?, solo_trial_ends_at = ?, last_event_created = NULL, last_invoice_created = NULL WHERE install_id = ?",
      )
      .bind(OLD, ENDS, A)
      .run();
  const stripe = () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      return Response.json({
        id: OLD,
        status: init.method === "GET" ? "trialing" : "canceled",
      });
    }) as unknown as typeof fetch;
    return {
      calls,
      e: { ...env, STRIPE_SECRET_KEY: KEY, stripeFetch: f } as WebhookEnv,
    };
  };
  const completed = (payment_status: string) =>
    event("checkout.session.completed", {
      customer: CUS_A,
      subscription: NEW,
      payment_status,
      metadata: { tier: "solo" },
    });

  it("a Checkout that kept the free days (no_payment_required) keeps the trial end and cancels only the trialing subscription", async () => {
    await trialing();
    const s = stripe();
    await deliver(completed("no_payment_required"), { env: s.e });
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "active",
      stripe_subscription_id: NEW,
      solo_trial_ends_at: ENDS,
    });
    // Only the trialing Solo is touched: no other Stripe call moves money.
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      `DELETE /v1/subscriptions/${OLD}`,
    ]);

    // The new subscription's own trialing event sets the same end.
    await deliver(
      event(
        "customer.subscription.created",
        sub({
          id: NEW,
          status: "trialing",
          trial_end: ENDS / 1000,
          items: { data: [{ price: { id: "p", metadata: { tier: "solo" } } }] },
        }),
      ),
      { env: s.e },
    );
    expect(await row(A)).toMatchObject({
      solo_trial_ends_at: ENDS,
      stripe_subscription_id: NEW,
    });
  });

  it("a Checkout that charged now (paid) ends the Solo trial at the event time", async () => {
    await trialing();
    const s = stripe();
    const ev = completed("paid");
    await deliver(ev, { env: s.e });
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "active",
      stripe_subscription_id: NEW,
      solo_trial_ends_at: ev.created * 1000,
    });
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      `DELETE /v1/subscriptions/${OLD}`,
    ]);
  });

  it("a paid Solo during the Business trial ends the Solo trial too, and the Business trial runs on", async () => {
    await trialing();
    await db
      .prepare(
        "UPDATE tiers SET tier = 'trial', trial_ends_at = ?, solo_status = 'active' WHERE install_id = ?",
      )
      .bind(ENDS, A)
      .run();
    const ev = completed("paid");
    await deliver(ev, { env: stripe().e });
    expect(await row(A)).toMatchObject({
      tier: "trial",
      trial_ends_at: ENDS,
      solo_trial_ends_at: ev.created * 1000,
    });
  });

  it("a Team or Business checkout never touches solo_trial_ends_at", async () => {
    await trialing();
    await deliver(
      event("checkout.session.completed", {
        customer: CUS_A,
        subscription: NEW,
        payment_status: "paid",
        metadata: { tier: "team" },
      }),
      { env: stripe().e },
    );
    expect(await row(A)).toMatchObject({
      tier: "team",
      solo_trial_ends_at: ENDS,
    });
  });
});

describe("pending cancels are a table, settled together (#1568)", () => {
  const KEY = "sk_test_notarealkey0000";
  const queue = (id: string, customer: string) =>
    db
      .prepare(
        "INSERT INTO pending_cancels (subscription_id, customer_id) VALUES (?, ?)",
      )
      .bind(id, customer)
      .run();
  /** Stripe where the subscriptions in `fail` can't be cancelled. */
  const stripe = (fail: string[] = []) => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const id = new URL(url).pathname.split("/").pop() as string;
      calls.push(`${init.method} ${id}`);
      if (init.method === "GET") return Response.json({ id, status: "active" });
      return fail.includes(id)
        ? Response.json({ error: { type: "api_error" } }, { status: 500 })
        : Response.json({ id, status: "canceled" });
    }) as unknown as typeof fetch;
    return {
      calls,
      e: { ...env, STRIPE_SECRET_KEY: KEY, stripeFetch: f } as WebhookEnv,
    };
  };
  const ping = () => event("invoice.paid", inv());

  it("every webhook for the customer settles all of its pending cancels, and only its own", async () => {
    await queue("sub_P1", CUS_A);
    await queue("sub_P2", CUS_A);
    await queue("sub_Q1", CUS_B);
    const s = stripe();
    expect((await deliver(ping(), { env: s.e })).status).toBe(200);
    expect(s.calls).toEqual([
      "GET sub_P1",
      "DELETE sub_P1",
      "GET sub_P2",
      "DELETE sub_P2",
    ]);
    expect(await pending()).toEqual(["sub_Q1"]);
  });

  it("a failure keeps that one and the rest still run; a later event finishes only what is left", async () => {
    await queue("sub_P1", CUS_A);
    await queue("sub_P2", CUS_A);
    await queue("sub_P3", CUS_A);
    const bad = stripe(["sub_P2"]);
    // A plain event did not queue them: it still tries, and answers 200.
    expect((await deliver(ping(), { env: bad.e })).status).toBe(200);
    expect(await pending()).toEqual(["sub_P2"]);
    expect(bad.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      "DELETE sub_P1",
      "DELETE sub_P2",
      "DELETE sub_P3",
    ]);
    const good = stripe();
    expect((await deliver(ping(), { env: good.e })).status).toBe(200);
    expect(good.calls).toEqual(["GET sub_P2", "DELETE sub_P2"]);
    expect(await pending()).toEqual([]);
  });

  it("a webhook answers 500 only when the event itself queued the failed cancel; other events still settle and answer 200", async () => {
    // A cancel left over from an earlier event keeps failing.
    await queue("sub_Left1", CUS_A);
    const bad = stripe(["sub_Left1"]);
    const other = await deliver(ping(), { env: bad.e });
    expect(other.status).toBe(200);
    expect(bad.calls).toContain("DELETE sub_Left1");
    expect(await pending()).toEqual(["sub_Left1"]);
    // An upgrade whose own queued cancel fails: 500 (Stripe retries it) ...
    await db
      .prepare(
        "UPDATE tiers SET tier = 'solo', status = 'active', stripe_subscription_id = 'sub_Old1' WHERE install_id = ?",
      )
      .bind(A)
      .run();
    const worse = stripe(["sub_Left1", "sub_Old1"]);
    const ev = event("checkout.session.completed", {
      customer: CUS_A,
      subscription: "sub_New1",
      payment_status: "paid",
      metadata: { tier: "team" },
    });
    expect((await deliver(ev, { env: worse.e })).status).toBe(500);
    // ... and so does its replay while it still fails.
    expect((await deliver(ev, { env: worse.e })).status).toBe(500);
    // Once it can be cancelled the replay settles it: 200.
    expect((await deliver(ev, { env: stripe(["sub_Left1"]).e })).status).toBe(
      200,
    );
    expect(await pending()).toEqual(["sub_Left1"]);
  });

  it("a queued id equal to the row's current subscription is dropped without any Stripe call: the row's own is never cancelled", async () => {
    await db
      .prepare(
        "UPDATE tiers SET tier = 'team', status = 'active', stripe_subscription_id = 'sub_Cur1' WHERE install_id = ?",
      )
      .bind(A)
      .run();
    await queue("sub_Cur1", CUS_A);
    await queue("sub_Gone1", CUS_A);
    const s = stripe();
    expect((await deliver(ping(), { env: s.e })).status).toBe(200);
    expect(s.calls).toEqual(["GET sub_Gone1", "DELETE sub_Gone1"]);
    expect(await pending()).toEqual([]);
    expect(await row(A)).toMatchObject({
      tier: "team",
      stripe_subscription_id: "sub_Cur1",
    });
  });

  it("an upgrade queues the replaced subscription in the same batch as the event; the row can never queue its own subscription", async () => {
    await db
      .prepare(
        "UPDATE tiers SET tier = 'solo', status = 'active', stripe_subscription_id = 'sub_Old1' WHERE install_id = ?",
      )
      .bind(A)
      .run();
    const bad = stripe(["sub_Old1"]);
    const r = await deliver(
      event("checkout.session.completed", {
        customer: CUS_A,
        subscription: "sub_New1",
        payment_status: "paid",
        metadata: { tier: "team" },
      }),
      { env: bad.e },
    );
    expect(r.status).toBe(500);
    expect(await pending()).toEqual(["sub_Old1"]);
    expect(await row(A)).toMatchObject({
      tier: "team",
      stripe_subscription_id: "sub_New1",
    });
  });
});

// ------------------------------------------------- checkout has its own order key

describe("a delayed upgrade Checkout is ordered against other Checkouts only (#1568)", () => {
  const OLD = "sub_Old1";
  const KEY = "sk_test_notarealkey0000";
  const soloPrice = {
    items: { data: [{ price: { id: "p", metadata: { tier: "solo" } } }] },
  };
  const teamPrice = {
    items: { data: [{ price: { id: "q", lookup_key: "team" } }] },
  };
  const solo = () =>
    db
      .prepare(
        "UPDATE tiers SET tier = 'solo', status = 'active', grace_until = NULL, trial_ends_at = NULL, stripe_subscription_id = ?, last_event_created = NULL, last_invoice_created = NULL, last_checkout_created = NULL WHERE install_id = ?",
      )
      .bind(OLD, A)
      .run();
  const stripe = () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const id = new URL(url).pathname.split("/").pop() as string;
      calls.push(`${init.method} ${id}`);
      return Response.json({
        id,
        status: init.method === "GET" ? "active" : "canceled",
      });
    }) as unknown as typeof fetch;
    return {
      calls,
      e: { ...env, STRIPE_SECRET_KEY: KEY, stripeFetch: f } as WebhookEnv,
    };
  };
  const checkout = (
    sub: string,
    created: number,
    o: Record<string, unknown> = {},
  ) =>
    event(
      "checkout.session.completed",
      {
        customer: CUS_A,
        subscription: sub,
        payment_status: "paid",
        metadata: { tier: "team" },
        ...o,
      },
      { created },
    );

  it("a newer event for the old subscription delivered first does not make the Checkout stale: it applies, and the old one is cancelled", async () => {
    await solo();
    const s = stripe();
    // Real order state: the old Solo's own update at T+50 is applied first.
    await deliver(
      event("customer.subscription.updated", sub({ id: OLD, ...soloPrice }), {
        created: T + 50,
      }),
      { env: s.e },
    );
    expect((await row(A)).last_event_created).toBe(T + 50);
    // The upgrade Checkout was made at T+10 and arrives late.
    const r = await deliver(checkout("sub_New1", T + 10), { env: s.e });
    expect(r.status).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "active",
      stripe_subscription_id: "sub_New1",
    });
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      `DELETE ${OLD}`,
    ]);
  });

  it("the new subscription's later events then apply: the old subscription's order keys do not hold them back", async () => {
    await solo();
    const s = stripe();
    await deliver(
      event("customer.subscription.updated", sub({ id: OLD, ...soloPrice }), {
        created: T + 50,
      }),
      { env: s.e },
    );
    await deliver(
      event("invoice.payment_failed", inv({ subscription: OLD }), {
        created: T + 40,
      }),
      { env: s.e },
    );
    await deliver(checkout("sub_New1", T + 10), { env: s.e });
    // After the Checkout (T+10) but before the old subscription's last event (T+50).
    const failed = event(
      "invoice.payment_failed",
      inv({ subscription: "sub_New1" }),
      { created: T + 20 },
    );
    await deliver(failed, { env: s.e });
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "past_due",
      grace_until: failed.created * 1000 + GRACE_MS,
    });
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ id: "sub_New1", ...teamPrice, status: "active" }),
        { created: T + 30 },
      ),
      { env: s.e },
    );
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "active",
      grace_until: null,
    });
  });

  // Timeout 10s: two checkouts with Stripe reads and a cancel, with room for a loaded CI runner (default 5s).
  it("an older Checkout never replaces a newer one", async () => {
    await solo();
    const s = stripe();
    await deliver(checkout("sub_New2", T + 60), { env: s.e });
    expect(await row(A)).toMatchObject({
      tier: "team",
      stripe_subscription_id: "sub_New2",
    });
    // The earlier session's Checkout arrives late.
    await deliver(
      checkout("sub_New1", T + 10, { metadata: { tier: "business" } }),
      { env: s.e },
    );
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "active",
      stripe_subscription_id: "sub_New2",
    });
  }, 10000);

  it("a retried Checkout of the current subscription, or of one the row left, never revives a lapse (N6 still holds)", async () => {
    await solo();
    const s = stripe();
    const c = checkout("sub_New1", T + 10);
    await deliver(c, { env: s.e });
    await deliver(
      event(
        "customer.subscription.deleted",
        sub({ id: "sub_New1", ...teamPrice, status: "canceled" }),
        { created: T + 100 },
      ),
      { env: s.e },
    );
    expect((await row(A)).status).toBe("lapsed");
    await deliver(c, { env: s.e });
    await deliver({ ...c, id: "evt_fresh_retry" }, { env: s.e });
    expect(await row(A)).toMatchObject({
      status: "lapsed",
      stripe_subscription_id: "sub_New1",
    });
  });
});

// ------------------------------------------------- Solo never replaces a live Team; later session wins

describe("a Solo Checkout never replaces a live Team or Business subscription (#1568)", () => {
  const KEY = "sk_test_notarealkey0000";
  const live = (tier: string, status = "active") =>
    db
      .prepare(
        "UPDATE tiers SET tier = ?, status = ?, grace_until = NULL, trial_ends_at = NULL, stripe_subscription_id = 'sub_Team1', solo_status = NULL, last_event_created = NULL, last_invoice_created = NULL, last_checkout_created = NULL WHERE install_id = ?",
      )
      .bind(tier, status, A)
      .run();
  const stripe = () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const id = new URL(url).pathname.split("/").pop() as string;
      calls.push(`${init.method} ${id}`);
      return Response.json({
        id,
        status: init.method === "GET" ? "active" : "canceled",
      });
    }) as unknown as typeof fetch;
    return {
      calls,
      e: { ...env, STRIPE_SECRET_KEY: KEY, stripeFetch: f } as WebhookEnv,
    };
  };
  const checkout = (
    sub: string,
    tierName: string,
    o: Record<string, unknown> = {},
    created?: number,
  ) =>
    event(
      "checkout.session.completed",
      {
        customer: CUS_A,
        subscription: sub,
        payment_status: "paid",
        metadata: { tier: tierName },
        ...o,
      },
      created === undefined ? {} : { created },
    );

  // Timeout 10s: three rows, each a checkout, a read and a cancel, with room for a loaded CI runner (default 5s).
  it("a Solo checkout on a live Team or Business row keeps the row and queues the NEW subscription for cancel", async () => {
    for (const [tier, status] of [
      ["team", "active"],
      ["business", "active"],
      ["team", "past_due"],
    ]) {
      await live(tier as string, status as string);
      await db
        .prepare("UPDATE tiers SET grace_until = ? WHERE install_id = ?")
        .bind(status === "past_due" ? 123 : null, A)
        .run();
      await db.prepare("DELETE FROM pending_cancels").run();
      const s = stripe();
      const before = await row(A);
      const r = await deliver(checkout("sub_Solo1", "solo"), { env: s.e });
      expect(r.status, `${tier} ${status}`).toBe(200);
      expect(await row(A), `${tier} ${status}`).toMatchObject({
        tier,
        status,
        grace_until: before.grace_until,
        stripe_subscription_id: "sub_Team1",
        trial_ends_at: null,
      });
      // The Solo is what is cancelled: never the live Team.
      expect(s.calls).toEqual(["GET sub_Solo1", "DELETE sub_Solo1"]);
      expect(await pending()).toEqual([]);
    }
  }, 10000);

  it("a suspended row's subscription is live too: a Solo session paid after suspension changes nothing and is queued; a Team session replaces and queues it", async () => {
    await live("team", "suspended");
    let s = stripe();
    await deliver(checkout("sub_Solo1", "solo"), { env: s.e });
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "suspended",
      stripe_subscription_id: "sub_Team1",
    });
    expect(s.calls).toEqual(["GET sub_Solo1", "DELETE sub_Solo1"]);
    s = stripe();
    await deliver(checkout("sub_Team2", "team"), { env: s.e });
    expect(await row(A)).toMatchObject({
      status: "suspended",
      stripe_subscription_id: "sub_Team2",
    });
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      "DELETE sub_Team1",
    ]);
  });

  it("a lapsed Team row that buys Solo adopts it (nothing is live to protect)", async () => {
    await live("team", "lapsed");
    const s = stripe();
    await deliver(checkout("sub_Solo1", "solo"), { env: s.e });
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "active",
      stripe_subscription_id: "sub_Solo1",
    });
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });

  // Timeout 10s: four checkouts with reads and cancels, with room for a loaded CI runner (default 5s).
  it("two paid Team sessions: the later wins and the earlier is cancelled, in either arrival order", async () => {
    await live("solo");
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = 'sub_Old1' WHERE install_id = ?",
      )
      .bind(A)
      .run();
    const s = stripe();
    await deliver(checkout("sub_T1", "team", {}, T + 10), { env: s.e });
    await deliver(checkout("sub_T2", "business", {}, T + 20), { env: s.e });
    expect(await row(A)).toMatchObject({
      tier: "business",
      stripe_subscription_id: "sub_T2",
    });
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      "DELETE sub_Old1",
      "DELETE sub_T1",
    ]);
    // Reversed arrival: the newer first, then the older one is not adopted and is cancelled.
    await live("solo");
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = 'sub_Old1' WHERE install_id = ?",
      )
      .bind(A)
      .run();
    const r = stripe();
    await deliver(checkout("sub_T4", "business", {}, T + 40), { env: r.e });
    await deliver(checkout("sub_T3", "team", {}, T + 30), { env: r.e });
    expect(await row(A)).toMatchObject({
      tier: "business",
      stripe_subscription_id: "sub_T4",
    });
    expect(r.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      "DELETE sub_Old1",
      "DELETE sub_T3",
    ]);
  }, 10000);

  it("an unpaid checkout is never queued; the row's own subscription's checkout replay queues nothing", async () => {
    await live("team");
    const s = stripe();
    await deliver(
      checkout("sub_Unpaid1", "team", { payment_status: "unpaid" }),
      { env: s.e },
    );
    await deliver(checkout("sub_Team1", "team"), { env: s.e });
    expect(s.calls).toEqual([]);
    expect(await pending()).toEqual([]);
  });

  it("completing a session clears it from the row's open session", async () => {
    await live("solo");
    await db
      .prepare(
        "UPDATE tiers SET open_checkout_id = 'cs_test_open1', open_checkout_key = 'k' WHERE install_id = ?",
      )
      .bind(A)
      .run();
    await deliver(checkout("sub_Solo1", "solo", { id: "cs_test_other" }), {
      env: stripe().e,
    });
    expect(await row(A)).toMatchObject({ open_checkout_id: "cs_test_open1" });
    await deliver(checkout("sub_Solo1", "solo", { id: "cs_test_open1" }), {
      env: stripe().e,
    });
    expect(await row(A)).toMatchObject({
      open_checkout_id: null,
      open_checkout_key: null,
    });
  });
});

// ------------------------------------------------- Solo bookkeeping edges

describe("Solo bookkeeping (#1568)", () => {
  const soloPrice = {
    items: { data: [{ price: { id: "p", metadata: { tier: "solo" } } }] },
  };
  const base = (set: string, ...binds: unknown[]) =>
    db
      .prepare(
        `UPDATE tiers SET ${set}, last_event_created = NULL, last_invoice_created = NULL, last_checkout_created = NULL WHERE install_id = ?`,
      )
      .bind(...binds, A)
      .run();

  it("incomplete_expired drops the subscription and its Solo state together, only when it is the row's", async () => {
    await base(
      "tier = 'trial', stripe_subscription_id = 'sub_Test1', solo_status = 'past_due', solo_grace_until = 99",
    );
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ id: "sub_Other1", status: "incomplete_expired" }),
      ),
    );
    expect(await row(A)).toMatchObject({
      stripe_subscription_id: "sub_Test1",
      solo_status: "past_due",
      solo_grace_until: 99,
    });
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ id: "sub_Test1", status: "incomplete_expired" }),
      ),
    );
    expect(await row(A)).toMatchObject({
      stripe_subscription_id: null,
      solo_status: null,
      solo_grace_until: null,
    });
  });

  it("a Solo active event caps the trial end at its own time: a trial ended early in Stripe keeps no free days", async () => {
    await base(
      "tier = 'solo', stripe_subscription_id = 'sub_Test1', solo_trial_ends_at = ?",
      (T + 20 * 86_400) * 1000,
    );
    const early = event(
      "customer.subscription.updated",
      sub({ id: "sub_Test1", ...soloPrice, status: "active" }),
      { created: T + 5 * 86_400 },
    );
    await deliver(early);
    expect(await row(A)).toMatchObject({
      solo_trial_ends_at: early.created * 1000,
    });
    // An end already in the past stays (the minimum).
    await base("solo_trial_ends_at = ?", (T - 86_400) * 1000);
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ id: "sub_Test1", ...soloPrice, status: "active" }),
        { created: T + 6 * 86_400 },
      ),
    );
    expect(await row(A)).toMatchObject({
      solo_trial_ends_at: (T - 86_400) * 1000,
    });
  });

  it("a Solo subscription that is active (not trialing) records when it went live, once; a trialing one records its end", async () => {
    await base(
      "tier = 'solo', stripe_subscription_id = NULL, solo_trial_ends_at = NULL",
    );
    const e = event(
      "customer.subscription.created",
      sub({ id: "sub_Test1", ...soloPrice, status: "active" }),
    );
    await deliver(e);
    expect(await row(A)).toMatchObject({
      solo_trial_ends_at: e.created * 1000,
    });
    await deliver(
      event(
        "customer.subscription.updated",
        sub({ id: "sub_Test1", ...soloPrice, status: "active" }),
        { created: T + 500 },
      ),
    );
    expect(await row(A)).toMatchObject({
      solo_trial_ends_at: e.created * 1000,
    });
    await deliver(
      event(
        "customer.subscription.updated",
        sub({
          id: "sub_Test1",
          ...soloPrice,
          status: "trialing",
          trial_end: T + 99,
        }),
        { created: T + 600 },
      ),
    );
    expect(await row(A)).toMatchObject({ solo_trial_ends_at: (T + 99) * 1000 });
  });
});

// ------------------------------------------------- only an adopted Checkout advances the key

describe("last_checkout_created moves only when a Checkout adopts its subscription (#1568)", () => {
  const KEY = "sk_test_notarealkey0000";
  const solo = () =>
    db
      .prepare(
        "UPDATE tiers SET tier = 'solo', status = 'active', grace_until = NULL, trial_ends_at = NULL, stripe_subscription_id = 'sub_Old1', solo_status = NULL, last_event_created = NULL, last_invoice_created = NULL, last_checkout_created = NULL WHERE install_id = ?",
      )
      .bind(A)
      .run();
  const stripe = () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const id = new URL(url).pathname.split("/").pop() as string;
      calls.push(`${init.method} ${id}`);
      return Response.json({
        id,
        status: init.method === "GET" ? "active" : "canceled",
      });
    }) as unknown as typeof fetch;
    return {
      calls,
      e: { ...env, STRIPE_SECRET_KEY: KEY, stripeFetch: f } as WebhookEnv,
    };
  };
  const checkout = (
    sub: string,
    created: number,
    o: Record<string, unknown> = {},
  ) =>
    event(
      "checkout.session.completed",
      {
        customer: CUS_A,
        subscription: sub,
        payment_status: "paid",
        metadata: { tier: "team" },
        ...o,
      },
      { created },
    );

  it("an unpaid async Checkout that leaves the row on Solo does not make a delayed paid Team Checkout stale", async () => {
    await solo();
    const s = stripe();
    await deliver(
      checkout("sub_Async1", T + 20, { payment_status: "unpaid" }),
      { env: s.e },
    );
    expect(await row(A)).toMatchObject({
      tier: "solo",
      stripe_subscription_id: "sub_Old1",
      last_checkout_created: null,
    });
    await deliver(checkout("sub_Paid1", T + 10), { env: s.e });
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "active",
      stripe_subscription_id: "sub_Paid1",
      last_checkout_created: T + 10,
    });
    // The paid Team is never the one cancelled; the replaced Solo is.
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      "DELETE sub_Old1",
    ]);
  });

  it("a Solo Checkout held by a live Team does not advance it either: an older paid Team Checkout still applies", async () => {
    await solo();
    const s = stripe();
    await deliver(checkout("sub_T1", T + 10), { env: s.e });
    expect((await row(A)).last_checkout_created).toBe(T + 10);
    await deliver(
      checkout("sub_Solo1", T + 40, { metadata: { tier: "solo" } }),
      { env: s.e },
    );
    expect(await row(A)).toMatchObject({
      tier: "team",
      stripe_subscription_id: "sub_T1",
      last_checkout_created: T + 10,
    });
    await deliver(checkout("sub_T2", T + 20), { env: s.e });
    expect(await row(A)).toMatchObject({
      stripe_subscription_id: "sub_T2",
      last_checkout_created: T + 20,
    });
  });

  it("an unpaid Checkout that records a pending id on a row with nothing live does not advance it", async () => {
    await solo();
    await db
      .prepare("UPDATE tiers SET status = 'lapsed' WHERE install_id = ?")
      .bind(A)
      .run();
    await deliver(
      checkout("sub_Async1", T + 20, { payment_status: "unpaid" }),
      { env: stripe().e },
    );
    expect(await row(A)).toMatchObject({
      stripe_subscription_id: "sub_Async1",
      last_checkout_created: null,
    });
  });
});

// ------------------------------------------------- the previous subscription is read inside the batch

describe("concurrent paid Checkouts cannot orphan a subscription (#1568)", () => {
  const KEY = "sk_test_notarealkey0000";
  // Timeout 10s: three concurrent checkouts with reads and cancels, with room for a loaded CI runner (default 5s).
  it("two paid Team Checkouts racing on a Solo row: the later wins, and both others are cancelled", async () => {
    await db
      .prepare(
        "UPDATE tiers SET tier = 'solo', status = 'active', stripe_subscription_id = 'sub_Old1', last_event_created = NULL, last_invoice_created = NULL, last_checkout_created = NULL WHERE install_id = ?",
      )
      .bind(A)
      .run();
    const cancelled: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const id = new URL(url).pathname.split("/").pop() as string;
      if (init.method === "DELETE") cancelled.push(id);
      return Response.json({
        id,
        status: init.method === "GET" ? "active" : "canceled",
      });
    }) as unknown as typeof fetch;
    const e = { ...env, STRIPE_SECRET_KEY: KEY, stripeFetch: f } as WebhookEnv;
    const mk = (sub: string, created: number) =>
      event(
        "checkout.session.completed",
        {
          customer: CUS_A,
          subscription: sub,
          payment_status: "paid",
          metadata: { tier: "team" },
        },
        { created },
      );
    const rs = await Promise.all([
      deliver(mk("sub_T1", T + 10), { env: e }),
      deliver(mk("sub_T2", T + 20), { env: e }),
      deliver(mk("sub_T3", T + 15), { env: e }),
    ]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await row(A)).toMatchObject({
      tier: "team",
      stripe_subscription_id: "sub_T2",
    });
    expect([...new Set(cancelled)].sort()).toEqual([
      "sub_Old1",
      "sub_T1",
      "sub_T3",
    ]);
    expect(await pending()).toEqual([]);
  }, 10000);
});

// ------------------------------------------------- adoption reads the subscription from Stripe

describe("a Checkout adopts a subscription only if Stripe says it is live (#1568)", () => {
  const KEY = "sk_test_notarealkey0000";
  const solo = () =>
    db
      .prepare(
        "UPDATE tiers SET tier = 'solo', status = 'active', grace_until = NULL, trial_ends_at = NULL, stripe_subscription_id = 'sub_Old1', solo_status = NULL, last_event_created = NULL, last_invoice_created = NULL, last_checkout_created = NULL WHERE install_id = ?",
      )
      .bind(A)
      .run();
  /** Stripe: `state` per subscription; every call is recorded. */
  const stripe = (
    state: Record<string, string> = {},
    fail: Record<string, number> = {},
  ) => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const id = new URL(url).pathname.split("/").pop() as string;
      calls.push(`${init.method} ${id}`);
      if (fail[id] && init.method === "GET")
        return Response.json(
          { error: { type: "api_error" } },
          { status: fail[id] },
        );
      return Response.json({
        id,
        status: init.method === "GET" ? (state[id] ?? "active") : "canceled",
      });
    }) as unknown as typeof fetch;
    return {
      calls,
      e: { ...env, STRIPE_SECRET_KEY: KEY, stripeFetch: f } as WebhookEnv,
    };
  };
  const checkout = (sub: string, o: Record<string, unknown> = {}) =>
    event("checkout.session.completed", {
      customer: CUS_A,
      subscription: sub,
      payment_status: "paid",
      metadata: { tier: "team" },
      ...o,
    });

  it("a subscription Stripe reports canceled (its deleted event arrived first and was dropped) is not adopted, and the row's current one is not cancelled", async () => {
    await solo();
    const s = stripe({ sub_Dead1: "canceled" });
    const ev = checkout("sub_Dead1");
    expect((await deliver(ev, { env: s.e })).status).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "active",
      stripe_subscription_id: "sub_Old1",
      last_checkout_created: null,
    });
    expect(s.calls).toEqual(["GET sub_Dead1"]);
    expect(await pending()).toEqual([]);
    // A replay changes nothing either.
    expect((await deliver(ev, { env: s.e })).status).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "solo",
      stripe_subscription_id: "sub_Old1",
    });
  });

  const recorded = async (id: string) =>
    (await db
      .prepare("SELECT 1 AS x FROM stripe_events WHERE event_id = ?")
      .bind(id)
      .first()) !== null;

  it("a terminal state (canceled, incomplete_expired) is recorded and not adopted", async () => {
    for (const state of ["canceled", "incomplete_expired"]) {
      await solo();
      await db.prepare("DELETE FROM stripe_events").run();
      const ev = checkout("sub_Dead1");
      expect(
        (await deliver(ev, { env: stripe({ sub_Dead1: state }).e })).status,
        state,
      ).toBe(200);
      expect(await row(A), state).toMatchObject({
        tier: "solo",
        stripe_subscription_id: "sub_Old1",
      });
      expect(await recorded(ev.id), state).toBe(true);
      expect(await pending()).toEqual([]);
    }
  });

  it("any other non-live state (incomplete, paused, one we do not know) answers 500 while the event is young, recording nothing", async () => {
    for (const state of ["incomplete", "paused", "something_new"]) {
      await solo();
      await db.prepare("DELETE FROM stripe_events").run();
      const ev = checkout("sub_Wait1");
      expect(
        (await deliver(ev, { env: stripe({ sub_Wait1: state }).e })).status,
        state,
      ).toBe(500);
      expect(await row(A), state).toMatchObject({
        tier: "solo",
        stripe_subscription_id: "sub_Old1",
      });
      expect(await recorded(ev.id), state).toBe(false);
    }
  });

  it("after the window it is answered 200 and not adopted, not queued and not recorded: a Dashboard resend once it is active adopts it and never cancels it", async () => {
    await solo();
    const ev = checkout("sub_Wait1");
    const later = NOW + 2 * 3_600_000;
    const late = { now: later, t: Math.floor(later / 1000) };
    const s = stripe({ sub_Wait1: "incomplete" });
    expect((await deliver(ev, { env: s.e, ...late })).status).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "solo",
      stripe_subscription_id: "sub_Old1",
    });
    expect(await pending()).toEqual([]);
    expect(await recorded(ev.id)).toBe(false);
    // Still not live on a second delivery: the same.
    expect((await deliver(ev, { env: s.e, ...late })).status).toBe(200);
    expect(await pending()).toEqual([]);
    // It became active; the resend of the same event adopts it.
    const live = stripe({ sub_Wait1: "active" });
    expect((await deliver(ev, { env: live.e, ...late })).status).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "active",
      stripe_subscription_id: "sub_Wait1",
    });
    // Only the replaced Solo is cancelled, never the adopted subscription.
    expect(live.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      "DELETE sub_Old1",
    ]);
    expect(await pending()).toEqual([]);
  });

  it("a 404 on the read is retried while the event is young (Stripe may not have the subscription yet), and counts as dead only after that", async () => {
    await solo();
    const ev = checkout("sub_Late1");
    // Young: 500, nothing written, the event not recorded.
    const young = await deliver(ev, { env: stripe({}, { sub_Late1: 404 }).e });
    expect(young.status).toBe(500);
    expect(await row(A)).toMatchObject({
      tier: "solo",
      stripe_subscription_id: "sub_Old1",
    });
    // The subscription shows up: the retry adopts it.
    expect((await deliver(ev, { env: stripe().e })).status).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "team",
      stripe_subscription_id: "sub_Late1",
    });
    // Old (over an hour): recorded, not adopted, the row's own kept.
    await solo();
    const old = checkout("sub_Gone1");
    const later = NOW + 2 * 3_600_000;
    const r = await deliver(old, {
      env: stripe({}, { sub_Gone1: 404 }).e,
      now: later,
      t: Math.floor(later / 1000),
    });
    expect(r.status).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "solo",
      stripe_subscription_id: "sub_Old1",
    });
    expect(await pending()).toEqual([]);
  });

  it("a past_due subscription is adopted as past_due, with grace from the event, and replaces the old one", async () => {
    await solo();
    const s = stripe({ sub_Late1: "past_due" });
    const ev = checkout("sub_Late1");
    await deliver(ev, { env: s.e });
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "past_due",
      grace_until: ev.created * 1000 + GRACE_MS,
      stripe_subscription_id: "sub_Late1",
    });
    expect(s.calls).toEqual([
      "GET sub_Late1",
      "GET sub_Old1",
      "DELETE sub_Old1",
    ]);
  });

  it("a Solo adopted as past_due on a row in its Business trial keeps the trial's status and grace, and is shadowed in solo_status", async () => {
    await solo();
    const END = (T + 10 * 86_400) * 1000;
    await db
      .prepare(
        "UPDATE tiers SET tier = 'trial', trial_ends_at = ?, solo_status = 'active' WHERE install_id = ?",
      )
      .bind(END, A)
      .run();
    const s = stripe({ sub_Late1: "past_due" });
    const ev = checkout("sub_Late1", { metadata: { tier: "solo" } });
    await deliver(ev, { env: s.e });
    expect(await row(A)).toMatchObject({
      tier: "trial",
      status: "active",
      grace_until: null,
      trial_ends_at: END,
      stripe_subscription_id: "sub_Late1",
      solo_status: "past_due",
      solo_grace_until: ev.created * 1000 + GRACE_MS,
    });
    expect(s.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      "DELETE sub_Old1",
    ]);
  });

  it("a Solo adopted as past_due on a Solo row is past_due with grace; a Team adopted as past_due on a trial row is past_due too", async () => {
    await solo();
    const ev = checkout("sub_Late1", { metadata: { tier: "solo" } });
    await deliver(ev, { env: stripe({ sub_Late1: "past_due" }).e });
    expect(await row(A)).toMatchObject({
      tier: "solo",
      status: "past_due",
      grace_until: ev.created * 1000 + GRACE_MS,
    });
    await solo();
    await db
      .prepare(
        "UPDATE tiers SET tier = 'trial', trial_ends_at = ?, solo_status = 'active' WHERE install_id = ?",
      )
      .bind((T + 10 * 86_400) * 1000, A)
      .run();
    const t = checkout("sub_Late2");
    await deliver(t, { env: stripe({ sub_Late2: "past_due" }).e });
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "past_due",
      grace_until: t.created * 1000 + GRACE_MS,
    });
  });

  it("trialing and active are live: adopted as active", async () => {
    for (const state of ["trialing", "active"]) {
      await solo();
      await deliver(checkout("sub_New1"), {
        env: stripe({ sub_New1: state }).e,
      });
      expect(await row(A), state).toMatchObject({
        tier: "team",
        status: "active",
        grace_until: null,
        stripe_subscription_id: "sub_New1",
      });
    }
  });

  it("a failed read answers 500 and writes nothing, so Stripe retries; the retry adopts", async () => {
    await solo();
    const ev = checkout("sub_New1");
    const bad = stripe({}, { sub_New1: 500 });
    expect((await deliver(ev, { env: bad.e })).status).toBe(500);
    expect(await row(A)).toMatchObject({
      tier: "solo",
      stripe_subscription_id: "sub_Old1",
    });
    expect((await deliver(ev, { env: stripe().e })).status).toBe(200);
    expect(await row(A)).toMatchObject({
      tier: "team",
      stripe_subscription_id: "sub_New1",
    });
  });

  it("no read for the row's own subscription, an unpaid checkout, or a Solo held by a live Team", async () => {
    await solo();
    let s = stripe();
    await deliver(checkout("sub_Old1"), { env: s.e });
    await deliver(checkout("sub_Unpaid1", { payment_status: "unpaid" }), {
      env: s.e,
    });
    expect(s.calls).toEqual([]);
    await db
      .prepare(
        "UPDATE tiers SET tier = 'team', stripe_subscription_id = 'sub_Team1' WHERE install_id = ?",
      )
      .bind(A)
      .run();
    s = stripe();
    await deliver(checkout("sub_Solo1", { metadata: { tier: "solo" } }), {
      env: s.e,
    });
    expect(s.calls).toEqual(["GET sub_Solo1", "DELETE sub_Solo1"]);
  });
});

describe("a yearly overage invoice never touches the plan (#2235)", () => {
  const overage = (o: Record<string, unknown> = {}) => ({
    customer: CUS_A,
    metadata: { kind: "overage", install: A, month: "2026-10" },
    ...o,
  });
  const setup = async () => {
    await ownSub(A);
    // A row mid-grace, so a stray paid event would visibly clear it.
    await db
      .prepare(
        "UPDATE tiers SET status = 'past_due', grace_until = ?, last_invoice_created = ? WHERE install_id = ?",
      )
      .bind(NOW + 1000, T - 100, A)
      .run();
    return row(A);
  };

  it("invoice.paid and invoice.payment_failed without a subscription change nothing", async () => {
    const before = await setup();
    await deliver(event("invoice.paid", overage()));
    await deliver(event("invoice.payment_failed", overage()));
    expect(await row(A)).toEqual(before);
  });

  it("even one that names the row's own subscription is ignored (metadata.kind overage)", async () => {
    const before = await setup();
    await deliver(
      event("invoice.paid", overage({ subscription: "sub_Test1" })),
    );
    await deliver(
      event(
        "invoice.payment_failed",
        overage({
          parent: { subscription_details: { subscription: "sub_Test1" } },
        }),
      ),
    );
    expect(await row(A)).toEqual(before);
  });

  it("a failed overage invoice does not move an active row", async () => {
    await ownSub(A);
    await deliver(event("invoice.payment_failed", overage()));
    expect(await row(A)).toMatchObject({
      tier: "team",
      status: "active",
      grace_until: null,
      last_invoice_created: null,
    });
  });

  it("a subscription invoice still applies (the skip is only for overage)", async () => {
    await ownSub(A);
    await deliver(event("invoice.payment_failed", inv()));
    expect(await row(A)).toMatchObject({ status: "past_due" });
  });
});

describe("overage invoice payment state is recorded on the overage row (#2246)", () => {
  const paidInv = (id = "in_ovg1", o: Record<string, unknown> = {}) => ({
    id,
    customer: CUS_A,
    metadata: { kind: "overage", install: A, month: "2026-10" },
    ...o,
  });
  const put = (invoice: string | null = "in_ovg1") =>
    db
      .prepare(
        "INSERT INTO overage (install_id, month, seats, creators, quantity, unit_amount, invoice_id, outcome, created_at, updated_at) VALUES (?1, '2026-10', 3, 5, 2, 1000, ?2, 'invoiced', 0, 0)",
      )
      .bind(A, invoice)
      .run();
  const ovg = () =>
    db
      .prepare(
        "SELECT paid_at, failed_at, payment_attempts FROM overage WHERE install_id = ?1",
      )
      .bind(A)
      .first();
  const planOf = async () => {
    const r = await row(A);
    return { ...r, version: 0, updated_at: 0 };
  };

  it("payment_failed sets failed_at and counts attempts, once per event; the plan row is untouched", async () => {
    await put();
    await ownSub(A);
    const before = await planOf();
    const e = event("invoice.payment_failed", paidInv());
    expect((await deliver(e)).status).toBe(200);
    expect(await ovg()).toEqual({
      paid_at: null,
      failed_at: e.created * 1000,
      payment_attempts: 1,
    });
    await deliver(e);
    expect((await ovg())?.payment_attempts).toBe(1);
    await deliver(event("invoice.payment_failed", paidInv()));
    expect((await ovg())?.payment_attempts).toBe(2);
    expect(await planOf()).toEqual(before);
  });

  it("invoice.paid records paid_at, later than the failure; tier, status and grace never move", async () => {
    await put();
    await ownSub(A);
    await db
      .prepare(
        "UPDATE tiers SET status = 'past_due', grace_until = ?, last_invoice_created = ? WHERE install_id = ?",
      )
      .bind(NOW + 1000, T - 100, A)
      .run();
    const before = await planOf();
    await deliver(event("invoice.payment_failed", paidInv()));
    const paid = event("invoice.paid", paidInv());
    await deliver(paid);
    expect(await ovg()).toMatchObject({ paid_at: paid.created * 1000 });
    expect(await planOf()).toEqual(before);
  });

  it("an event for another invoice, another install's row, or an unknown customer records nothing", async () => {
    await put();
    await deliver(event("invoice.payment_failed", paidInv("in_other")));
    await deliver(
      event(
        "invoice.payment_failed",
        paidInv("in_ovg1", {
          customer: CUS_B,
          metadata: { kind: "overage", install: A, month: "2026-10" },
        }),
      ),
    );
    expect(await ovg()).toMatchObject({
      failed_at: null,
      payment_attempts: 0,
    });
  });
});
