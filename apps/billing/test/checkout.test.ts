import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { keyId, publicFromPkcs8, signRequest } from "@oa/auth-core";
import { signStripePayload } from "@oa/billing-core";
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
import billing, {
  BillingOperatorRpc,
  type Env,
  MAX_CREATORS,
  pricesCollide,
} from "../src/index.js";

// POST /checkout and POST /portal: signed like the other POSTs, redirect URLs
// built only from the gate's app host, the Stripe customer created and mapped
// here first, an Idempotency-Key on every Stripe call, and only a
// Stripe-hosted URL passed back. Stripe is a fake global fetch.

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
let env = baseEnv();

const A = "iabc123def45";
const B = "izzz999yyy88";
const HOST_A = "acme.open-artifacts-staging.app";
const HOST_B = "beta.open-artifacts-staging.app";
const ORIGIN = "https://billing.oa.internal";

beforeAll(async () => {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
});

// ------------------------------------------------------------ fake Stripe

type StripeCall = {
  method: string;
  path: string;
  key: string | null;
  auth: string | null;
  form: Record<string, string>;
  search: string;
};

type Override = (
  c: StripeCall,
) => Response | undefined | Promise<Response | undefined>;

/**
 * Stripe as far as billing-core uses it. Like Stripe, a repeated
 * Idempotency-Key replays the first answer.
 */
function fakeStripe(override?: Override) {
  const calls: StripeCall[] = [];
  const replay = new Map<string, unknown>();
  let n = 0;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input
          : (input as Request).url,
      );
      if (url.origin !== "https://api.stripe.com")
        throw new Error(`unexpected fetch ${url.origin}`);
      const h = new Headers(init?.headers);
      const c: StripeCall = {
        method: String(init?.method),
        path: url.pathname,
        key: h.get("idempotency-key"),
        auth: h.get("authorization"),
        form: Object.fromEntries(new URLSearchParams(String(init?.body))),
        search: url.search,
      };
      calls.push(c);
      const o = await override?.(c);
      if (o) return o;
      // A Checkout session read or expire (an open session is expired before
      // another is made).
      const sess =
        /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)(\/expire)?$/.exec(
          c.path,
        );
      if (sess)
        return Response.json({
          id: sess[1],
          status: sess[2] ? "expired" : "open",
        });
      const k = `${c.path} ${c.key}`;
      if (!replay.has(k)) {
        n++;
        replay.set(
          k,
          c.path === "/v1/customers"
            ? { id: `cus_fake${n}` }
            : c.path === "/v1/subscriptions"
              ? { id: `sub_fake${n}`, object: "subscription" }
              : c.path === "/v1/checkout/sessions"
                ? {
                    id: `cs_test_${n}`,
                    url: `https://checkout.stripe.com/c/pay/cs_test_${n}`,
                  }
                : {
                    id: `bps_${n}`,
                    url: `https://billing.stripe.com/p/session/test_${n}`,
                  },
        );
      }
      return Response.json(replay.get(k));
    });
  return { calls, spy };
}

// ------------------------------------------------------------ requests

const pk = (fill: number) =>
  b64u(
    new Uint8Array([
      ...[0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65],
      ...[0x70, 0x04, 0x22, 0x04, 0x20],
      ...new Uint8Array(32).fill(fill),
    ]),
  );
function b64u(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const KEYS: Record<string, string> = { [A]: pk(1), [B]: pk(2) };
const kidOf = async (key: string) => keyId(await publicFromPkcs8(key));

async function register() {
  for (const [id, key] of Object.entries(KEYS)) {
    const x = await publicFromPkcs8(key);
    await registry.put(
      `install:${id}`,
      JSON.stringify({
        installId: id,
        origin: `https://${id}.example.test`,
        keys: [{ kid: await keyId(x), x }],
      }),
    );
  }
}

type Opts = {
  install?: string;
  appHost?: string | null;
  headers?: Record<string, string>;
  /** Sign with this install's key (default: the header install's). */
  signer?: string;
  /** The path the signature covers (default: the request's). */
  signPath?: string;
  unsigned?: boolean;
  query?: string;
};

/** A signed POST as BillingGate forwards it. `ts` defaults to now. */
async function req(path: string, body: Record<string, unknown>, o: Opts = {}) {
  const install = o.install ?? A;
  const text = JSON.stringify(
    "ts" in body ? body : { ...body, ts: Date.now() },
  );
  const key = KEYS[o.signer ?? install] as string;
  const kid = await kidOf(key);
  const appHost =
    o.appHost === undefined ? (install === B ? HOST_B : HOST_A) : o.appHost;
  return new Request(`${ORIGIN}${path}${o.query ?? ""}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oa-gate-install": install,
      ...(appHost === null ? {} : { "x-oa-gate-app-host": appHost }),
      ...(o.unsigned
        ? {}
        : {
            "x-oa-kid": kid,
            "x-oa-sig": await signRequest(key, o.signPath ?? path, kid, text),
          }),
      ...o.headers,
    },
    body: text,
  });
}

const call = async (r: Request | Promise<Request>, e: Env = env) =>
  billing.fetch((await r) as Parameters<typeof billing.fetch>[0], e);

const rowOf = (install: string) =>
  db.prepare("SELECT * FROM tiers WHERE install_id = ?1").bind(install).first();
const customerOf = async (install: string) =>
  (await rowOf(install))?.stripe_customer_id ?? null;

async function seed(install: string, customer: string | null, tier = "free") {
  await db
    .prepare(
      "INSERT INTO tiers (install_id, tier, status, stripe_customer_id, version, updated_at) VALUES (?1, ?2, 'active', ?3, 3, 0)",
    )
    .bind(install, tier, customer)
    .run();
}

beforeEach(async () => {
  env = baseEnv();
  await db.batch([
    db.prepare("DELETE FROM tiers"),
    db.prepare("DELETE FROM usage"),
    db.prepare("DELETE FROM overage"),
  ]);
  clearRegistryCache();
  await register();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const CHECKOUT = "/v1/checkout/sessions";
const PORTAL = "/v1/billing_portal/sessions";
const CUSTOMERS = "/v1/customers";

// ------------------------------------------------------------ tests

describe("POST /checkout", () => {
  it("success, cancel and portal return URLs all use the dashboard plan path", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    await call(req("/checkout", { install: A, ts: Date.now(), plan: "team" }));
    await call(req("/portal", { install: A, ts: Date.now() }));
    const urls = s.calls.flatMap((c) =>
      [c.form.success_url, c.form.cancel_url, c.form.return_url].filter(
        Boolean,
      ),
    );
    expect(urls.length).toBe(3);
    for (const u of urls) {
      expect(new URL(u as string).pathname).toBe("/settings/plan");
    }
  });

  it("no row: makes the solo row, creates and maps the customer, then the session; answers {url} only", async () => {
    const s = fakeStripe();
    const ts = Date.now();
    const r = await call(req("/checkout", { install: A, ts, plan: "team" }));
    expect(r.status).toBe(200);
    const out = await r.json();
    expect(out).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_2" });
    expect(s.calls.map((c) => [c.path, c.key])).toEqual([
      [CUSTOMERS, `cust-${A}`],
      [CHECKOUT, `checkout-${A}-team-${ts}`],
    ]);
    expect(s.calls[0]?.form).toEqual({ "metadata[install_id]": A });
    expect(s.calls[1]?.form).toEqual({
      mode: "subscription",
      customer: "cus_fake1",
      "line_items[0][price]": "price_team1",
      "line_items[0][quantity]": "1",
      success_url: `https://${HOST_A}/settings/plan?checkout=done`,
      cancel_url: `https://${HOST_A}/settings/plan?checkout=cancel`,
      "metadata[tier]": "team",
      "subscription_data[metadata][tier]": "team",
    });
    for (const c of s.calls) expect(c.auth).toBe(`Bearer ${SECRET}`);
    expect(await rowOf(A)).toMatchObject({
      tier: "solo",
      status: "active",
      version: 0,
      stripe_customer_id: "cus_fake1",
    });
    expect(await rowOf(B)).toBeNull();
  });

  it("an existing mapping is used as is: no customer call, the row's tier untouched", async () => {
    await seed(A, "cus_existingA", "trial");
    const s = fakeStripe();
    const r = await call(req("/checkout", { install: A, plan: "business" }));
    expect(r.status).toBe(200);
    expect(s.calls.map((c) => c.path)).toEqual([CHECKOUT]);
    expect(s.calls[0]?.form.customer).toBe("cus_existingA");
    expect(s.calls[0]?.form["line_items[0][price]"]).toBe("price_business1");
    expect(s.calls[0]?.form["metadata[tier]"]).toBe("business");
    expect(await rowOf(A)).toMatchObject({ tier: "trial", version: 3 });
  });

  it("a row without a customer keeps its tier; the id is added only to it", async () => {
    await seed(A, null, "trial");
    fakeStripe();
    expect(
      (await call(req("/checkout", { install: A, plan: "team" }))).status,
    ).toBe(200);
    expect(await rowOf(A)).toMatchObject({
      tier: "trial",
      version: 3,
      stripe_customer_id: "cus_fake1",
    });
  });

  it("a row with an active or past_due subscription: 409 subscription_exists, no Stripe call (H2)", async () => {
    for (const status of ["active", "past_due"]) {
      await seed(A, "cus_existingA", "team");
      await db
        .prepare(
          "UPDATE tiers SET stripe_subscription_id = 'sub_live1', status = ?1 WHERE install_id = ?2",
        )
        .bind(status, A)
        .run();
      const s = fakeStripe();
      const r = await call(req("/checkout", { install: A, plan: "business" }));
      expect([r.status, await r.json()]).toEqual([
        409,
        { error: "subscription_exists" },
      ]);
      expect(s.calls).toEqual([]);
      s.spy.mockRestore();
      await db.prepare("DELETE FROM tiers").run();
    }
    // A lapsed (or never-subscribed) row may check out again.
    await seed(A, "cus_existingA", "team");
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = 'sub_old1', status = 'lapsed' WHERE install_id = ?1",
      )
      .bind(A)
      .run();
    fakeStripe();
    expect(
      (await call(req("/checkout", { install: A, plan: "business" }))).status,
    ).toBe(200);
  });

  it("the guard needs a paid tier: a trial or free row with a subscription id may check out (N9c)", async () => {
    for (const tier of ["free", "trial"]) {
      await seed(A, "cus_existingA", tier);
      await db
        .prepare(
          "UPDATE tiers SET stripe_subscription_id = 'sub_unpaid1' WHERE install_id = ?1",
        )
        .bind(A)
        .run();
      fakeStripe();
      expect(
        (await call(req("/checkout", { install: A, plan: "team" }))).status,
      ).toBe(200);
      await db.prepare("DELETE FROM tiers").run();
    }
  });

  it("after an operator comp the dead subscription id is gone: Team checkout is allowed (#66)", async () => {
    await seed(A, "cus_existingA", "team");
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = 'sub_dead1', status = 'lapsed' WHERE install_id = ?1",
      )
      .bind(A)
      .run();
    const set = await new BillingOperatorRpc(
      createExecutionContext(),
      env,
    ).setTier(A, "team");
    expect(set).toMatchObject({ ok: true });
    expect(
      (
        await db
          .prepare(
            "SELECT stripe_subscription_id AS s FROM tiers WHERE install_id = ?1",
          )
          .bind(A)
          .first<{ s: string | null }>()
      )?.s,
    ).toBeNull();
    const s = fakeStripe();
    const r = await call(req("/checkout", { install: A, plan: "team" }));
    expect(r.status).toBe(200);
    expect(s.calls.map((c) => c.path)).toContain(CHECKOUT);
  });

  it("a suspended row with a subscription is refused too (N10)", async () => {
    await seed(A, "cus_existingA", "team");
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = 'sub_live1', status = 'suspended' WHERE install_id = ?1",
      )
      .bind(A)
      .run();
    const s = fakeStripe();
    const r = await call(req("/checkout", { install: A, plan: "business" }));
    expect([r.status, await r.json()]).toEqual([
      409,
      { error: "subscription_exists" },
    ]);
    expect(s.calls).toEqual([]);
  });

  it("a first payment that never completes leaves a trial row free to retry (N9)", async () => {
    await seed(A, "cus_existingA", "trial");
    const hook = async (type: string, status: string, n: number) => {
      const body = JSON.stringify({
        id: `evt_n9_${n}`,
        object: "event",
        type,
        livemode: false,
        created: Math.floor(Date.now() / 1000) + n,
        data: {
          object: {
            id: "sub_Pending1",
            object: "subscription",
            customer: "cus_existingA",
            status,
            metadata: { tier: "team" },
          },
        },
      });
      const sig = await signStripePayload(
        body,
        "whsec_test_n9_0123456789",
        Math.floor(Date.now() / 1000),
      );
      return call(
        new Request(`${ORIGIN}/stripe/webhook`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "stripe-signature": sig,
            "cf-connecting-ip": "1.2.3.4",
          },
          body,
        }),
        { ...env, STRIPE_WEBHOOK_SECRET: "whsec_test_n9_0123456789" },
      );
    };
    expect(
      (await hook("customer.subscription.created", "incomplete", 1)).status,
    ).toBe(200);
    fakeStripe();
    expect(
      (await call(req("/checkout", { install: A, plan: "team" }))).status,
    ).toBe(200);
    expect(
      (await hook("customer.subscription.updated", "incomplete_expired", 2))
        .status,
    ).toBe(200);
    expect(await rowOf(A)).toMatchObject({
      tier: "trial",
      status: "active",
      stripe_subscription_id: null,
    });
  });

  it("a retried identical request (same ts) is the same customer and the same session", async () => {
    const s = fakeStripe();
    const body = { install: A, ts: Date.now(), plan: "team" };
    const r1 = await (await call(req("/checkout", body))).json();
    const r2 = await (await call(req("/checkout", body))).json();
    expect(r2).toEqual(r1);
    expect(s.calls.map((c) => c.key)).toEqual([
      `cust-${A}`,
      `checkout-${A}-team-${body.ts}`,
      `checkout-${A}-team-${body.ts}`,
    ]);
  });

  it("the same ts with another plan is another key and another session, not a 502", async () => {
    const s = fakeStripe();
    const ts = Date.now();
    const r1 = await call(req("/checkout", { install: A, ts, plan: "team" }));
    const r2 = await call(
      req("/checkout", { install: A, ts, plan: "business" }),
    );
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const [u1, u2] = (await Promise.all([r1.json(), r2.json()])) as {
      url: string;
    }[];
    expect(u1?.url).not.toBe(u2?.url);
    expect(
      s.calls.filter((c) => c.path === CHECKOUT).map((c) => c.key),
    ).toEqual([`checkout-${A}-team-${ts}`, `checkout-${A}-business-${ts}`]);
  });

  it("an unfilled or malformed price for the plan: 500 config before any customer is made", async () => {
    for (const e of [
      { STRIPE_PRICE_TEAM: "{{STRIPE_PRICE_TEAM_STAGING}}" },
      { STRIPE_PRICE_TEAM: "" },
      { STRIPE_PRICE_TEAM: "prod_1abc" },
    ]) {
      const s = fakeStripe();
      const r = await call(req("/checkout", { install: A, plan: "team" }), {
        ...baseEnv(),
        ...e,
      });
      expect([r.status, await r.json()]).toEqual([500, { error: "config" }]);
      expect(s.calls).toEqual([]);
      expect(await rowOf(A)).toBeNull();
      vi.restoreAllMocks();
    }
    // Only the requested plan's price is checked.
    const s = fakeStripe();
    const r = await call(req("/checkout", { install: A, plan: "business" }), {
      ...baseEnv(),
      STRIPE_PRICE_TEAM: "{{STRIPE_PRICE_TEAM_STAGING}}",
    });
    expect(r.status).toBe(200);
    expect(s.calls.map((c) => c.path)).toEqual([CUSTOMERS, CHECKOUT]);
  });

  it("the mapping write is retried once: a first failure, then success, is one customer, mapped", async () => {
    const s = fakeStripe();
    let fails = 1;
    const flaky = {
      prepare: (sql: string) => {
        const st = db.prepare(sql);
        if (!sql.startsWith("UPDATE tiers SET stripe_customer_id")) return st;
        return {
          bind: (...a: unknown[]) => {
            const b = st.bind(...a);
            return {
              run: () =>
                fails-- > 0
                  ? Promise.reject(new Error("D1_ERROR: transient"))
                  : b.run(),
            };
          },
        };
      },
    } as unknown as D1Database;
    const r = await call(req("/checkout", { install: A, plan: "team" }), {
      ...baseEnv(),
      BILLING_DB: flaky,
    });
    expect(r.status).toBe(200);
    expect(s.calls.filter((c) => c.path === CUSTOMERS)).toHaveLength(1);
    expect(await customerOf(A)).toBe("cus_fake1");
    // Two failures: the route's 503, and no session.
    vi.restoreAllMocks();
    await db.prepare("DELETE FROM tiers").run();
    const s2 = fakeStripe();
    fails = 2;
    const r2 = await call(req("/checkout", { install: A, plan: "team" }), {
      ...baseEnv(),
      BILLING_DB: flaky,
    });
    expect([r2.status, await r2.json()]).toEqual([
      503,
      { error: "unavailable" },
    ]);
    expect(s2.calls.map((c) => c.path)).toEqual([CUSTOMERS]);
  });

  it("concurrent first checkouts create one customer (cust-<install>) and both sessions use it", async () => {
    const s = fakeStripe();
    const now = Date.now();
    const rs = await Promise.all([
      call(req("/checkout", { install: A, ts: now, plan: "team" })),
      call(req("/checkout", { install: A, ts: now + 1, plan: "team" })),
    ]);
    // Two Checkouts at once leave one open session: the later store wins and
    // the other answers 409 checkout_in_progress (#1568); neither fails otherwise.
    const codes = rs.map((r) => r.status);
    expect(codes).toContain(200);
    for (const c of codes) expect([200, 409]).toContain(c);
    const cust = s.calls.filter((c) => c.path === CUSTOMERS);
    expect(new Set(cust.map((c) => c.key))).toEqual(new Set([`cust-${A}`]));
    const mapped = await customerOf(A);
    expect(
      s.calls.filter((c) => c.path === CHECKOUT).map((c) => c.form.customer),
    ).toEqual([mapped, mapped]);
  });

  it("two different customer answers racing: the first mapping wins, and both sessions use the winner (re-read)", async () => {
    // Both requests reach createCustomer before either writes; Stripe (as if
    // the key had expired) answers each with its own id.
    let arrived = 0;
    let release: () => void = () => {};
    const both = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const s = fakeStripe(async (c) => {
      if (c.path !== CUSTOMERS) return undefined;
      if (++arrived === 2) release();
      await both;
      return Response.json({ id: `cus_race${++n}` });
    });
    const now = Date.now();
    const rs = await Promise.all([
      call(req("/checkout", { install: A, ts: now, plan: "team" })),
      call(req("/checkout", { install: A, ts: now + 1, plan: "team" })),
    ]);
    // Two Checkouts at once leave one open session: the later store wins and
    // the other answers 409 checkout_in_progress (#1568); neither fails otherwise.
    const codes = rs.map((r) => r.status);
    expect(codes).toContain(200);
    for (const c of codes) expect([200, 409]).toContain(c);
    const mapped = await customerOf(A);
    expect(mapped).toMatch(/^cus_race[12]$/);
    expect(
      s.calls.filter((c) => c.path === CHECKOUT).map((c) => c.form.customer),
    ).toEqual([mapped, mapped]);
  });

  it("the customer is mapped before any session: a session failure still leaves the mapping", async () => {
    const s = fakeStripe((c) =>
      c.path === CHECKOUT
        ? Response.json({ error: { type: "api_error" } }, { status: 500 })
        : undefined,
    );
    const r = await call(req("/checkout", { install: A, plan: "team" }));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "upstream" });
    expect(s.calls.map((c) => c.path)).toEqual([CUSTOMERS, CHECKOUT]);
    expect(await customerOf(A)).toBe("cus_fake1");
  });

  it("a bad plan, a non-integer ts or a missing install: refused before any Stripe call", async () => {
    const s = fakeStripe();
    for (const [body, status, error] of [
      [{ install: A, plan: "free" }, 400, "bad_plan"],
      [{ install: A, plan: "trial" }, 400, "bad_plan"],
      [{ install: A }, 400, "bad_plan"],
      // Solo names its interval; no other plan takes one.
      [{ install: A, plan: "solo" }, 400, "bad_plan"],
      [{ install: A, plan: "solo", interval: "week" }, 400, "bad_plan"],
      [
        { install: A, plan: "solo", interval: "month", extra: 1 },
        400,
        "bad_body",
      ],
      [{ install: A, plan: "team", interval: "week" }, 400, "bad_plan"],
      [{ install: A, plan: "team", ts: Date.now() + 0.5 }, 400, "bad_body"],
      [{ plan: "team" }, 403, "install_mismatch"],
      [{ install: B, plan: "team" }, 403, "install_mismatch"],
    ] as [Record<string, unknown>, number, string][]) {
      const r = await call(req("/checkout", body));
      expect([r.status, await r.json()]).toEqual([status, { error }]);
    }
    expect(s.calls).toEqual([]);
    expect(await rowOf(A)).toBeNull();
  });
});

describe("POST /checkout, Solo (#1568)", () => {
  it("solo month and year use their own prices, tag tier solo, and key the session by interval", async () => {
    const s = fakeStripe();
    const ts = Date.now();
    for (const [interval, price] of [
      ["month", "price_soloM1"],
      ["year", "price_soloY1"],
    ] as const) {
      const r = await call(
        req("/checkout", { install: A, ts, plan: "solo", interval }),
      );
      expect(r.status, interval).toBe(200);
      const c = s.calls.filter((x) => x.path === CHECKOUT).at(-1);
      expect(c?.form["line_items[0][price]"]).toBe(price);
      expect(c?.form["metadata[tier]"]).toBe("solo");
      expect(c?.form["subscription_data[metadata][tier]"]).toBe("solo");
      expect(c?.form["line_items[0][quantity]"]).toBe("1");
      expect(c?.key).toBe(`checkout-${A}-solo-${interval}-${ts}`);
    }
    // Same ts, two intervals: two keys, so never Stripe's 400 for a reused key.
    expect(
      new Set(s.calls.filter((x) => x.path === CHECKOUT).map((x) => x.key))
        .size,
    ).toBe(2);
  });

  it("an unfilled or malformed Solo price: 500 config before any customer; the other plans' prices are not asked", async () => {
    for (const [interval, e] of [
      [
        "month",
        { STRIPE_PRICE_SOLO_MONTHLY: "{{STRIPE_PRICE_SOLO_MONTHLY_STAGING}}" },
      ],
      ["month", { STRIPE_PRICE_SOLO_MONTHLY: undefined }],
      ["year", { STRIPE_PRICE_SOLO_YEARLY: "prod_1abc" }],
    ] as const) {
      const s = fakeStripe();
      const r = await call(
        req("/checkout", { install: A, plan: "solo", interval }),
        { ...baseEnv(), ...e } as Env,
      );
      expect([r.status, await r.json()]).toEqual([500, { error: "config" }]);
      expect(s.calls).toEqual([]);
      expect(await rowOf(A)).toBeNull();
      vi.restoreAllMocks();
    }
    // The yearly price being unfilled does not stop a monthly checkout.
    fakeStripe();
    const ok = await call(
      req("/checkout", { install: A, plan: "solo", interval: "month" }),
      { ...baseEnv(), STRIPE_PRICE_SOLO_YEARLY: "{{x}}" },
    );
    expect(ok.status).toBe(200);
  });

  it("a live Stripe key or no key is 500 config for Solo too, with no Stripe call", async () => {
    await seed(A, "cus_existingA", "solo");
    const s = fakeStripe();
    for (const e of [
      { STRIPE_SECRET_KEY: undefined },
      { STRIPE_SECRET_KEY: "sk_live_abcdefgh12345678" },
      { STRIPE_SECRET_KEY: "rk_live_abcdefgh12345678" },
    ]) {
      const r = await call(
        req("/checkout", { install: A, plan: "solo", interval: "year" }),
        { ...baseEnv(), ...e },
      );
      expect([r.status, await r.json()]).toEqual([500, { error: "config" }]);
    }
    expect(s.calls).toEqual([]);
  });

  it("a live subscription refuses a second one: Solo on Solo, anything on Team or Business: 409 subscription_exists, no Stripe call", async () => {
    for (const status of ["active", "past_due"]) {
      for (const [held, plan] of [
        ["solo", "solo"],
        ["team", "team"],
        ["team", "solo"],
        ["business", "team"],
      ] as const) {
        await seed(A, "cus_existingA", held);
        await db
          .prepare(
            "UPDATE tiers SET stripe_subscription_id = 'sub_live1', status = ?1 WHERE install_id = ?2",
          )
          .bind(status, A)
          .run();
        const s = fakeStripe();
        const body =
          plan === "solo"
            ? { install: A, plan, interval: "month" }
            : { install: A, plan };
        const r = await call(req("/checkout", body));
        expect([r.status, await r.json()], `${status} ${plan}`).toEqual([
          409,
          { error: "subscription_exists" },
        ]);
        expect(s.calls).toEqual([]);
        s.spy.mockRestore();
        await db.prepare("DELETE FROM tiers").run();
      }
    }
  });

  it("a lapsed Solo (its trial ended with no card) can buy again; a Solo row with no subscription can too", async () => {
    await seed(A, "cus_existingA", "solo");
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = 'sub_old1', status = 'lapsed' WHERE install_id = ?1",
      )
      .bind(A)
      .run();
    fakeStripe();
    expect(
      (
        await call(
          req("/checkout", { install: A, plan: "solo", interval: "month" }),
        )
      ).status,
    ).toBe(200);
    await db.prepare("DELETE FROM tiers").run();
    await seed(A, "cus_existingA", "free");
    expect(
      (
        await call(
          req("/checkout", { install: A, plan: "solo", interval: "year" }),
        )
      ).status,
    ).toBe(200);
  });

  it("Solo is bought on a solo, free or trial row only: a Team or Business row is 409 plan_conflict, no Stripe call", async () => {
    for (const tier of ["team", "business"]) {
      await seed(A, "cus_existingA", tier);
      const s = fakeStripe();
      const r = await call(
        req("/checkout", { install: A, plan: "solo", interval: "month" }),
      );
      expect([r.status, await r.json()], tier).toEqual([
        409,
        { error: "plan_conflict" },
      ]);
      expect(s.calls).toEqual([]);
      s.spy.mockRestore();
      await db.prepare("DELETE FROM tiers").run();
    }
    fakeStripe();
    for (const tier of ["solo", "free", "trial"]) {
      await seed(A, "cus_existingA", tier);
      expect(
        (
          await call(
            req("/checkout", { install: A, plan: "solo", interval: "month" }),
          )
        ).status,
        tier,
      ).toBe(200);
      await db.prepare("DELETE FROM tiers").run();
    }
  });
});

describe("POST /portal", () => {
  it("no mapping: 409 no_customer, no Stripe call, nothing written", async () => {
    const s = fakeStripe();
    const r = await call(req("/portal", { install: A }));
    expect([r.status, await r.json()]).toEqual([409, { error: "no_customer" }]);
    await seed(A, null);
    const r2 = await call(req("/portal", { install: A }));
    expect(r2.status).toBe(409);
    expect(s.calls).toEqual([]);
    expect(await customerOf(A)).toBeNull();
  });

  it("with a mapping: the portal session for it, return URL from the app host, keyed portal-<install>-<ts>", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    const ts = Date.now();
    const r = await call(req("/portal", { install: A, ts }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      url: "https://billing.stripe.com/p/session/test_1",
    });
    expect(s.calls).toEqual([
      {
        method: "POST",
        path: PORTAL,
        key: `portal-${A}-${ts}`,
        search: "",
        auth: `Bearer ${SECRET}`,
        form: {
          customer: "cus_existingA",
          return_url: `https://${HOST_A}/settings/plan`,
        },
      },
    ]);
  });

  it("a body with any field beyond install and ts is 400 bad_body", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    for (const extra of [
      { return_url: "https://evil.example/" },
      { returnUrl: "https://evil.example/" },
      { plan: "team" },
    ]) {
      const r = await call(req("/portal", { install: A, ...extra }));
      expect([r.status, await r.json()]).toEqual([400, { error: "bad_body" }]);
    }
    expect(s.calls).toEqual([]);
  });
});

describe("the redirect origin comes only from the gate's app host", () => {
  it("a URL field in the body is 400 bad_body, before any Stripe call", async () => {
    const s = fakeStripe();
    for (const extra of [
      { success_url: "https://evil.example/" },
      { cancel_url: "https://evil.example/" },
      { successUrl: "https://evil.example/" },
      { return_url: "https://evil.example/" },
      { url: "https://evil.example/" },
      { origin: "https://evil.example" },
      { appHost: HOST_B },
    ]) {
      const r = await call(
        req("/checkout", { install: A, plan: "team", ...extra }),
      );
      expect([r.status, await r.json()]).toEqual([400, { error: "bad_body" }]);
    }
    expect(s.calls).toEqual([]);
    expect(await rowOf(A)).toBeNull();
  });

  it("a request header or query never changes the URLs", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    const evil = {
      host: HOST_B,
      origin: `https://${HOST_B}`,
      referer: `https://${HOST_B}/settings/billing`,
      "x-forwarded-host": HOST_B,
      "x-original-host": HOST_B,
    };
    const q = `?success_url=https://${HOST_B}/&return_url=https://${HOST_B}/&appHost=${HOST_B}`;
    for (const path of ["/checkout", "/portal"]) {
      const r = await call(
        req(
          path,
          {
            install: A,
            plan: "team",
            ...(path === "/portal" ? { plan: undefined } : {}),
          },
          { headers: evil, query: q },
        ),
      );
      expect(r.status).toBe(200);
    }
    const urls = s.calls.flatMap((c) =>
      ["success_url", "cancel_url", "return_url"]
        .map((k) => c.form[k])
        .filter((v) => v !== undefined),
    );
    expect(urls).toEqual([
      `https://${HOST_A}/settings/plan?checkout=done`,
      `https://${HOST_A}/settings/plan?checkout=cancel`,
      `https://${HOST_A}/settings/plan`,
    ]);
  });

  it("a missing app host, or one not on this env's app domain: 500 bad_app_host, no Stripe call", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    for (const appHost of [
      null,
      "",
      "acme.open-artifacts.app",
      "acme.open-artifacts-staging.page",
      "a.b.open-artifacts-staging.app",
      "Acme.open-artifacts-staging.app",
      "acme.open-artifacts-staging.app.evil.test",
      "evil.example",
    ])
      for (const path of ["/checkout", "/portal"]) {
        const r = await call(
          req(
            path,
            path === "/checkout"
              ? { install: A, plan: "team" }
              : { install: A },
            { appHost },
          ),
        );
        expect([r.status, await r.json()]).toEqual([
          500,
          { error: "bad_app_host" },
        ]);
      }
    expect(s.calls).toEqual([]);
  });

  it("prod checks the prod app domain", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    env = { ...baseEnv(), OA_ENV: "prod" };
    expect(
      (await call(req("/portal", { install: A }, { appHost: HOST_A }))).status,
    ).toBe(500);
    const r = await call(
      req("/portal", { install: A }, { appHost: "acme.open-artifacts.app" }),
    );
    expect(r.status).toBe(200);
    expect(s.calls[0]?.form.return_url).toBe(
      "https://acme.open-artifacts.app/settings/plan",
    );
  });
});

describe("signing and the gate rules hold for both routes", () => {
  it("cf-connecting-ip: the plain 404, nothing called or written", async () => {
    const s = fakeStripe();
    for (const path of ["/checkout", "/portal"]) {
      const r = await call(
        req(
          path,
          { install: A, plan: "team" },
          {
            headers: { "cf-connecting-ip": "1.2.3.4" },
          },
        ),
      );
      expect([r.status, await r.text()]).toEqual([404, "Not found"]);
    }
    expect(s.calls).toEqual([]);
    expect(await rowOf(A)).toBeNull();
  });

  it("unsigned, signed for another route, by another install, or stale: 401, nothing called or written", async () => {
    await seed(B, "cus_existingB");
    const s = fakeStripe();
    for (const path of ["/checkout", "/portal"]) {
      const body = { install: A, plan: "team" };
      for (const o of [
        { unsigned: true },
        { signPath: path === "/checkout" ? "/portal" : "/checkout" },
        { signPath: "/trial/start" },
        { signer: B },
      ] as Opts[]) {
        const r = await call(req(path, body, o));
        expect([r.status, await r.json()]).toEqual([
          401,
          { error: "bad_signature" },
        ]);
      }
      const stale = await call(
        req(path, { ...body, ts: Date.now() - 120_000 }),
      );
      expect(stale.status).toBe(401);
    }
    expect(s.calls).toEqual([]);
    expect(await rowOf(A)).toBeNull();
  });
});

describe("red-line: install A can never get a session for install B", () => {
  it("A's signed requests use A's customer and A's origin only, with B mapped", async () => {
    await seed(B, "cus_existingB");
    const s = fakeStripe();
    // A's portal: A has no customer, so 409, never B's.
    expect((await call(req("/portal", { install: A }))).status).toBe(409);
    // A's body naming B, A's header with B's body, B's header with A's key.
    expect(
      (await call(req("/checkout", { install: B, plan: "team" }))).status,
    ).toBe(403);
    expect(
      (await call(req("/portal", { install: B }, { install: B, signer: A })))
        .status,
    ).toBe(401);
    expect(s.calls).toEqual([]);
    // A's checkout: a new customer for A; B's mapping untouched.
    const r = await call(req("/checkout", { install: A, plan: "team" }));
    expect(r.status).toBe(200);
    const forms = s.calls.map((c) => c.form);
    expect(forms[0]).toEqual({ "metadata[install_id]": A });
    expect(forms[1]?.customer).toBe("cus_fake1");
    expect(JSON.stringify(s.calls)).not.toContain("cus_existingB");
    expect(JSON.stringify(s.calls)).not.toContain(HOST_B);
    expect(await customerOf(B)).toBe("cus_existingB");
    expect(await customerOf(A)).toBe("cus_fake1");
  });
});

describe("Stripe answers and errors", () => {
  it("only a Stripe-hosted URL is passed back (else 502 bad_upstream)", async () => {
    await seed(A, "cus_existingA");
    for (const [path, url] of [
      [CHECKOUT, "https://evil.example/c/pay"],
      [CHECKOUT, "http://checkout.stripe.com/c/pay"],
      [CHECKOUT, "https://billing.stripe.com/p/session/x"],
      [CHECKOUT, "https://checkout.stripe.com.evil.example/"],
      [PORTAL, "https://checkout.stripe.com/c/pay"],
      [PORTAL, "https://evil.example/"],
    ]) {
      vi.restoreAllMocks();
      fakeStripe((c) =>
        c.path === path ? Response.json({ id: "x_1", url }) : undefined,
      );
      const r = await call(
        req(
          path === CHECKOUT ? "/checkout" : "/portal",
          path === CHECKOUT ? { install: A, plan: "team" } : { install: A },
        ),
      );
      const text = await r.text();
      expect([r.status, text]).toEqual([
        502,
        JSON.stringify({ error: "bad_upstream" }),
      ]);
    }
  });

  it("config errors are 500 config with no Stripe call: no key, a live key, an unfilled price", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    for (const e of [
      { STRIPE_SECRET_KEY: undefined },
      { STRIPE_SECRET_KEY: "sk_live_abcdefgh12345678" },
      { STRIPE_PRICE_TEAM: "{{STRIPE_PRICE_TEAM_STAGING}}" },
    ]) {
      const r = await call(req("/checkout", { install: A, plan: "team" }), {
        ...baseEnv(),
        ...e,
      });
      expect([r.status, await r.json()]).toEqual([500, { error: "config" }]);
    }
    expect(s.calls).toEqual([]);
  });

  it("a Stripe error or a network failure is 502 upstream", async () => {
    await seed(A, "cus_existingA");
    for (const o of [
      () => Response.json({ error: { type: "card_error" } }, { status: 402 }),
      () => {
        throw new TypeError("network down");
      },
    ] as Override[]) {
      vi.restoreAllMocks();
      fakeStripe(o);
      for (const path of ["/checkout", "/portal"]) {
        const r = await call(
          req(
            path,
            path === "/checkout"
              ? { install: A, plan: "team" }
              : { install: A },
          ),
        );
        expect([r.status, await r.json()]).toEqual([
          502,
          { error: "upstream" },
        ]);
      }
    }
  });

  it("the HTTP routes still answer every Stripe error as 502 upstream, whatever its status (stripe_refused is the provisioner RPC's only)", async () => {
    await seed(A, "cus_existingA");
    for (const status of [400, 401, 403, 404, 429, 500]) {
      vi.restoreAllMocks();
      fakeStripe((c) =>
        c.path === CHECKOUT
          ? Response.json(
              { error: { type: "invalid_request_error" } },
              { status },
            )
          : undefined,
      );
      const r = await call(req("/checkout", { install: A, plan: "team" }));
      expect([r.status, await r.json()], String(status)).toEqual([
        502,
        { error: "upstream" },
      ]);
    }
  });

  it("Stripe's 409 (the same key still in progress) is 503 retry, on every call", async () => {
    const busy = () =>
      Response.json({ error: { type: "idempotency_error" } }, { status: 409 });
    // The customer call, then the session calls with a mapping.
    const s = fakeStripe(busy);
    const r = await call(req("/checkout", { install: A, plan: "team" }));
    expect([r.status, await r.json()]).toEqual([503, { error: "retry" }]);
    expect(s.calls.map((c) => c.path)).toEqual([CUSTOMERS]);
    await db.prepare("DELETE FROM tiers").run();
    await seed(A, "cus_existingA");
    for (const path of ["/checkout", "/portal"]) {
      const x = await call(
        req(
          path,
          path === "/checkout" ? { install: A, plan: "team" } : { install: A },
        ),
      );
      expect([x.status, await x.json()]).toEqual([503, { error: "retry" }]);
    }
  });
});

describe("logs", () => {
  it("fixed categories and install ids: never the secret, a Stripe id, a URL or a body", async () => {
    const lines: string[] = [];
    for (const k of ["log", "warn", "error"] as const)
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
    fakeStripe((c) =>
      c.key?.startsWith("portal-") && c.form.customer === "cus_fake1"
        ? Response.json(
            { error: { type: "api_error", message: SECRET } },
            { status: 500 },
          )
        : undefined,
    );
    await call(req("/checkout", { install: A, plan: "team" }));
    await call(req("/portal", { install: A }));
    await call(req("/portal", { install: B }, { install: B }));
    await call(
      req(
        "/checkout",
        { install: A, plan: "team" },
        { appHost: "evil.example" },
      ),
    );
    await call(req("/checkout", { install: A, plan: "team" }), {
      ...baseEnv(),
      STRIPE_SECRET_KEY: "sk_live_abcdefgh12345678",
    });
    expect(lines).toEqual([
      `billing customer mapped ${A}`,
      `billing checkout session ${A}`,
      `billing stripe upstream ${A}`,
      `billing portal no_customer ${B}`,
      `billing bad_app_host ${A}`,
      `billing stripe config ${A}`,
    ]);
    const all = lines.join("\n");
    for (const bad of [
      SECRET,
      "sk_live",
      "cus_",
      "cs_test",
      "https://",
      HOST_A,
    ])
      expect(all).not.toContain(bad);
  });
});

describe("POST /checkout, Solo in its no-card trial (#1568)", () => {
  const NOW = Date.UTC(2026, 10, 9, 12, 0);
  const DAY = 86_400_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
  const solo = async (set: string, ...binds: unknown[]) => {
    await seed(A, "cus_existingA", "solo");
    await db
      .prepare(
        `UPDATE tiers SET stripe_subscription_id = 'sub_trial1', ${set} WHERE install_id = ?${binds.length + 1}`,
      )
      .bind(...binds, A)
      .run();
  };
  const buy = (interval: "month" | "year" = "month") =>
    call(req("/checkout", { install: A, plan: "solo", interval }));

  it("while the Solo subscription is the no-card trial, Solo Checkout is allowed (the card is added through it)", async () => {
    await solo("solo_trial_ends_at = ?1", NOW + 10 * DAY);
    const s = fakeStripe();
    for (const interval of ["month", "year"] as const) {
      const r = await buy(interval);
      expect([r.status, interval]).toEqual([200, interval]);
    }
    expect(s.calls.filter((c) => c.path === CHECKOUT)).toHaveLength(2);
    // The trial's row is untouched by starting a Checkout.
    expect(await rowOf(A)).toMatchObject({
      tier: "solo",
      status: "active",
      stripe_subscription_id: "sub_trial1",
    });
  });

  it("a Solo that has paid keeps 409: its trial is over, or it never had one", async () => {
    for (const [why, set, bind] of [
      ["trial ended", "solo_trial_ends_at = ?1", NOW - DAY],
      ["bought through Checkout, no trial", "version = ?1", 3],
      [
        "trial window but past_due",
        "solo_trial_ends_at = ?1, status = 'past_due'",
        NOW + DAY,
      ],
    ] as const) {
      await db.prepare("DELETE FROM tiers").run();
      await solo(set, bind);
      const s = fakeStripe();
      const r = await buy();
      expect([r.status, await r.json(), why]).toEqual([
        409,
        { error: "subscription_exists" },
        why,
      ]);
      expect(s.calls).toEqual([]);
      s.spy.mockRestore();
    }
  });

  it("team and business Checkout are allowed while the Solo subscription is live, trial or paid or past_due (the upgrade)", async () => {
    for (const [why, set, bind] of [
      ["no-card trial", "solo_trial_ends_at = ?1", NOW + 10 * DAY],
      ["paid", "solo_trial_ends_at = ?1", NOW - DAY],
      ["past_due", "status = 'past_due'", 0],
    ] as const) {
      for (const plan of ["team", "business"] as const) {
        await db.prepare("DELETE FROM tiers").run();
        await solo(set, bind);
        const s = fakeStripe();
        const r = await call(req("/checkout", { install: A, plan }));
        expect([r.status, why, plan]).toEqual([200, why, plan]);
        expect(
          s.calls.filter((c) => c.path === CHECKOUT)[0]?.form["metadata[tier]"],
        ).toBe(plan);
        // Starting Checkout changes nothing: the Solo subscription is still the row's.
        expect(await rowOf(A)).toMatchObject({
          tier: "solo",
          stripe_subscription_id: "sub_trial1",
        });
        s.spy.mockRestore();
      }
    }
  });
});

describe("POST /checkout on a row in its Business trial over a Solo subscription (#1568)", () => {
  const NOW = Date.UTC(2026, 10, 9, 12, 0);
  const DAY = 86_400_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
  const trial = async (soloStatus: string | null, soloEnd: number | null) => {
    await seed(A, "cus_existingA", "trial");
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = 'sub_solo1', solo_status = ?1, solo_trial_ends_at = ?2, trial_ends_at = ?3 WHERE install_id = ?4",
      )
      .bind(soloStatus, soloEnd, NOW + 5 * DAY, A)
      .run();
  };
  const buy = (plan: string, interval?: string) =>
    call(
      req("/checkout", { install: A, plan, ...(interval ? { interval } : {}) }),
    );

  it("team and business are allowed (the upgrade); Solo only while the Solo subscription is its no-card trial", async () => {
    await trial("active", NOW + 10 * DAY);
    fakeStripe();
    for (const [plan, interval] of [
      ["team"],
      ["business"],
      ["solo", "month"],
    ] as const)
      expect((await buy(plan, interval)).status, plan).toBe(200);
    // A Solo that has paid: Solo again is 409, the upgrade is not.
    await db.prepare("DELETE FROM tiers").run();
    await trial("active", NOW - DAY);
    const s = fakeStripe();
    const r = await buy("solo", "month");
    expect([r.status, await r.json()]).toEqual([
      409,
      { error: "subscription_exists" },
    ]);
    expect((await buy("team")).status).toBe(200);
    expect(s.calls.filter((c) => c.path === CHECKOUT)).toHaveLength(1);
  });

  it("a trial row whose Solo subscription is dead or was never live may buy anything (N9c)", async () => {
    for (const solo of [null, "lapsed"]) {
      await db.prepare("DELETE FROM tiers").run();
      await trial(solo, NOW - DAY);
      fakeStripe();
      for (const [plan, interval] of [["team"], ["solo", "year"]] as const)
        expect((await buy(plan, interval)).status, `${solo} ${plan}`).toBe(200);
    }
  });
});

describe("Solo Checkout during the no-card trial keeps the free days (#1568)", () => {
  const NOW = Date.UTC(2026, 10, 9, 12, 0);
  const H = 3_600_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
  const inTrial = async (ends: number) => {
    await db.prepare("DELETE FROM tiers").run();
    await seed(A, "cus_existingA", "solo");
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = 'sub_trial1', solo_trial_ends_at = ?1 WHERE install_id = ?2",
      )
      .bind(ends, A)
      .run();
  };
  const session = async (plan: string, interval?: string) => {
    const s = fakeStripe();
    const r = await call(
      req("/checkout", {
        install: A,
        ts: NOW,
        plan,
        ...(interval ? { interval } : {}),
      }),
    );
    expect(r.status).toBe(200);
    const c = s.calls.find((x) => x.path === CHECKOUT);
    s.spy.mockRestore();
    return c as StripeCall;
  };

  it("passes the trial's end (seconds) as subscription_data[trial_end]: no money moves until the free days end, the card is collected", async () => {
    const ends = NOW + 10 * 24 * H + 123;
    await inTrial(ends);
    for (const interval of ["month", "year"]) {
      const c = await session("solo", interval);
      expect(c.form["subscription_data[trial_end]"]).toBe(
        String(Math.floor(ends / 1000)),
      );
      // Collection stays at Stripe's default (always): the card is taken.
      expect(
        Object.keys(c.form).filter((k) => /payment_method_collection/.test(k)),
      ).toEqual([]);
    }
  });

  it("Stripe wants trial_end at least 48 hours out: from 49 hours (a safety hour) it is passed, under that it is omitted and the Checkout charges now", async () => {
    await inTrial(NOW + 49 * H);
    expect(
      (await session("solo", "month")).form["subscription_data[trial_end]"],
    ).toBe(String(Math.floor((NOW + 49 * H) / 1000)));
    for (const ends of [
      NOW + 49 * H - 1,
      NOW + 48 * H,
      NOW + 24 * H,
      NOW + 1000,
    ]) {
      await inTrial(ends);
      const c = await session("solo", "month");
      expect(
        Object.keys(c.form).filter((k) => /trial/.test(k)),
        String(ends - NOW),
      ).toEqual([]);
    }
  });

  it("a Checkout that is not Solo-in-trial never carries a trial: a fresh Solo, a Team upgrade", async () => {
    await db.prepare("DELETE FROM tiers").run();
    await seed(A, "cus_existingA", "solo");
    expect(
      Object.keys((await session("solo", "month")).form).filter((k) =>
        /trial/.test(k),
      ),
    ).toEqual([]);
    await inTrial(NOW + 10 * 24 * H);
    expect(
      Object.keys((await session("team")).form).filter((k) => /trial/.test(k)),
    ).toEqual([]);
  });

  it("the session key differs with and without a trial end, so a retry never reuses a key with other params", async () => {
    await inTrial(NOW + 10 * 24 * H);
    const withEnd = await session("solo", "month");
    await inTrial(NOW + 24 * H);
    const without = await session("solo", "month");
    expect(withEnd.key).not.toBe(without.key);
  });
});

describe("an open Checkout session is expired before another is made (#1568)", () => {
  const sessions = (s: ReturnType<typeof fakeStripe>) =>
    s.calls.filter((c) => c.path.startsWith("/v1/checkout/sessions"));
  const buy = (ts: number, plan = "team") =>
    call(req("/checkout", { install: A, ts, plan }));

  it("no open session on the row: nothing to expire; the new session's id and key are stored", async () => {
    const s = fakeStripe();
    const ts = Date.now();
    const r = await buy(ts);
    expect(r.status).toBe(200);
    expect(sessions(s).map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/checkout/sessions",
    ]);
    expect(await rowOf(A)).toMatchObject({
      open_checkout_id: "cs_test_2",
      open_checkout_key: `checkout-${A}-team-${ts}`,
    });
  });

  it("another Checkout expires the first one's session, before it creates its own; the new one is stored", async () => {
    const s = fakeStripe();
    const ts = Date.now();
    await buy(ts);
    await buy(ts + 1);
    expect(sessions(s).map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/checkout/sessions",
      "GET /v1/checkout/sessions/cs_test_2",
      "POST /v1/checkout/sessions/cs_test_2/expire",
      "POST /v1/checkout/sessions",
    ]);
    expect((await rowOf(A))?.open_checkout_id).toBe("cs_test_3");
  });

  it("the same request again (the same key) expires nothing: Stripe replays the same session", async () => {
    const s = fakeStripe();
    const ts = Date.now();
    await buy(ts);
    await buy(ts);
    expect(
      sessions(s).filter(
        (c) => c.path.includes("expire") || c.method === "GET",
      ),
    ).toEqual([]);
    expect((await rowOf(A))?.open_checkout_id).toBe("cs_test_2");
  });

  it("a session that already completed or expired is left alone, and the new one is made", async () => {
    await seed(A, "cus_existingA", "solo");
    await db
      .prepare(
        "UPDATE tiers SET open_checkout_id = 'cs_test_done', open_checkout_key = 'old-key-1234' WHERE install_id = ?1",
      )
      .bind(A)
      .run();
    for (const status of ["complete", "expired"]) {
      const s = fakeStripe((c) =>
        c.method === "GET" && c.path.endsWith("cs_test_done")
          ? Response.json({ id: "cs_test_done", status })
          : undefined,
      );
      expect((await buy(Date.now())).status).toBe(200);
      expect(
        sessions(s).some((c) => c.path.endsWith("/expire")),
        status,
      ).toBe(false);
      await db
        .prepare(
          "UPDATE tiers SET open_checkout_id = 'cs_test_done', open_checkout_key = 'old-key-1234' WHERE install_id = ?1",
        )
        .bind(A)
        .run();
      s.spy.mockRestore();
    }
  });

  it("an expire that fails stops the Checkout: 502, no new session, the stored one kept", async () => {
    await seed(A, "cus_existingA", "solo");
    await db
      .prepare(
        "UPDATE tiers SET open_checkout_id = 'cs_test_open', open_checkout_key = 'old-key-1234' WHERE install_id = ?1",
      )
      .bind(A)
      .run();
    const s = fakeStripe((c) =>
      c.path.endsWith("/expire")
        ? Response.json({ error: { type: "api_error" } }, { status: 500 })
        : undefined,
    );
    const r = await buy(Date.now());
    expect([r.status, await r.json()]).toEqual([502, { error: "upstream" }]);
    expect(
      s.calls.some(
        (c) => c.method === "POST" && c.path === "/v1/checkout/sessions",
      ),
    ).toBe(false);
    expect((await rowOf(A))?.open_checkout_id).toBe("cs_test_open");
  });

  it("a crash between the expire and the create leaves nothing open: the next try finds it expired and makes one session", async () => {
    await seed(A, "cus_existingA", "solo");
    await db
      .prepare(
        "UPDATE tiers SET open_checkout_id = 'cs_test_open', open_checkout_key = 'old-key-1234' WHERE install_id = ?1",
      )
      .bind(A)
      .run();
    let expired = false;
    let failed = false;
    const s = fakeStripe((c) => {
      if (c.path.endsWith("/expire")) expired = true;
      if (c.method === "GET" && c.path.endsWith("cs_test_open"))
        return Response.json({
          id: "cs_test_open",
          status: expired ? "expired" : "open",
        });
      // The create fails once (the Worker "crashes" after the expire).
      if (
        c.method === "POST" &&
        c.path === "/v1/checkout/sessions" &&
        expired &&
        !failed
      ) {
        failed = true;
        return Response.json({ error: { type: "api_error" } }, { status: 500 });
      }
      return undefined;
    });
    expect((await buy(Date.now())).status).toBe(502);
    expect((await rowOf(A))?.open_checkout_id).toBe("cs_test_open");
    s.calls.length = 0;
    expect((await buy(Date.now() + 1)).status).toBe(200);
    // Found expired: no second expire; one session created and stored.
    expect(
      sessions(s).map((c) => `${c.method} ${c.path.replace(/cs_\w+/, "cs_x")}`),
    ).toEqual(["GET /v1/checkout/sessions/cs_x", "POST /v1/checkout/sessions"]);
    expect((await rowOf(A))?.open_checkout_id).not.toBe("cs_test_open");
  });

  it("two Checkouts racing: the one that loses the store expires its own session and answers 409 checkout_in_progress", async () => {
    await seed(A, "cus_existingA", "solo");
    const s = fakeStripe((c) => {
      // While this call's session is being created, another call stores its own.
      if (c.method === "POST" && c.path === "/v1/checkout/sessions")
        return db
          .prepare(
            "UPDATE tiers SET open_checkout_id = 'cs_test_winner', open_checkout_key = 'winner-key-1234' WHERE install_id = ?1",
          )
          .bind(A)
          .run()
          .then(() => undefined);
      return undefined;
    });
    const r = await buy(Date.now());
    // 409, not 503: the server's automatic retry of a 503 reuses the same
    // request (the same key) and would get the dead session's URL back.
    expect([r.status, await r.json()]).toEqual([
      409,
      { error: "checkout_in_progress" },
    ]);
    expect((await rowOf(A))?.open_checkout_id).toBe("cs_test_winner");
    // Its own, orphaned session was expired.
    expect(
      sessions(s).some(
        (c) => c.method === "POST" && c.path.endsWith("/expire"),
      ),
    ).toBe(true);
  });

  it("no Stripe key or a live one: 500 config before anything is expired or created", async () => {
    await seed(A, "cus_existingA", "solo");
    await db
      .prepare(
        "UPDATE tiers SET open_checkout_id = 'cs_test_open', open_checkout_key = 'old-key-1234' WHERE install_id = ?1",
      )
      .bind(A)
      .run();
    const s = fakeStripe();
    for (const key of [undefined, "sk_live_abcdefgh12345678"]) {
      const r = await call(req("/checkout", { install: A, plan: "team" }), {
        ...baseEnv(),
        STRIPE_SECRET_KEY: key,
      });
      expect(r.status).toBe(500);
    }
    expect(s.calls).toEqual([]);
  });
});

// ------------------------------------------------------------ per creator

describe("Team and Business Checkout bill the instance's creators (#2123)", () => {
  it("creators is the line item's quantity and part of the key; 0 bills 1", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    const ts = Date.now();
    for (const [plan, creators, q] of [
      ["team", 7, "7"],
      ["business", 0, "1"],
      ["team", MAX_CREATORS, String(MAX_CREATORS)],
    ] as const) {
      const r = await call(
        req("/checkout", { install: A, ts, plan, creators }),
      );
      expect(r.status).toBe(200);
      const c = s.calls.at(-1);
      expect(c?.path).toBe(CHECKOUT);
      expect(c?.form["line_items[0][quantity]"]).toBe(q);
      expect(c?.key).toBe(`checkout-${A}-${plan}-q${q}-${ts}`);
    }
  });

  it("refuses creators on Solo, or one that isn't an integer in 0..10000, before any Stripe call", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    for (const body of [
      { plan: "solo", interval: "month", creators: 2 },
      { plan: "team", creators: -1 },
      { plan: "team", creators: MAX_CREATORS + 1 },
      { plan: "team", creators: 1.5 },
      { plan: "business", creators: "3" },
      { plan: "business", creators: null },
    ]) {
      const r = await call(req("/checkout", { install: A, ...body }));
      expect([r.status, await r.json()]).toEqual([
        400,
        { error: "bad_creators" },
      ]);
    }
    expect(s.calls).toEqual([]);
  });
});

describe("POST /usage sets the monthly Team or Business quantity (#2123)", () => {
  const SUB = "sub_liveA";
  const SUBS = `/v1/subscriptions/${SUB}`;
  const ITEM = "/v1/subscription_items/si_itemA";
  /** The month before now's, YYYY-MM: a closed month. */
  const shift = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
      .toISOString()
      .slice(0, 7);
  };
  const closed = shift(-1);
  const report = (month: string, count: number) =>
    req("/usage", {
      install: A,
      month,
      creators: Array.from({ length: count }, (_, i) => `u${i}`),
      count,
    });
  async function live(tier = "team", status = "active") {
    await seed(A, "cus_existingA", tier);
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = ?1, status = ?2 WHERE install_id = ?3",
      )
      .bind(SUB, status, A)
      .run();
  }
  /** Stripe's subscription: one item at `price`, recurring `interval`. */
  const subscription = (
    o: {
      price?: string;
      interval?: string;
      quantity?: number;
      status?: string;
    } = {},
  ) =>
    Response.json({
      id: SUB,
      status: o.status ?? "active",
      items: {
        data: [
          {
            id: "si_itemA",
            quantity: o.quantity ?? 1,
            price: {
              id: o.price ?? "price_team1",
              recurring: { interval: o.interval ?? "month" },
            },
          },
        ],
      },
    });
  const fake = (o: Parameters<typeof subscription>[0] = {}, post?: Override) =>
    fakeStripe(async (c) => {
      if (c.method === "GET" && c.path === SUBS) return subscription(o);
      if (c.method === "POST" && c.path === ITEM) {
        const p = await post?.(c);
        return (
          p ??
          Response.json({ id: "si_itemA", quantity: Number(c.form.quantity) })
        );
      }
      return undefined;
    });
  const usageRow = (month: string) =>
    db
      .prepare(
        "SELECT count, applied_quantity, applied_at, apply_outcome FROM usage WHERE install_id = ?1 AND month = ?2",
      )
      .bind(A, month)
      .first();

  it("a closed month sets the quantity once, with no proration; a repeat is a no-op", async () => {
    await live();
    const s = fake();
    const r = await call(report(closed, 3));
    expect([r.status, await r.json()]).toEqual([
      200,
      { ok: true, month: closed, count: 3 },
    ]);
    expect(s.calls.map((c) => [c.method, c.path, c.key])).toEqual([
      ["GET", SUBS, null],
      [
        "POST",
        ITEM,
        expect.stringMatching(new RegExp(`^qty-${A}-${closed}-3-\\d+$`)),
      ],
    ]);
    expect(s.calls[1]?.form).toEqual({
      quantity: "3",
      proration_behavior: "none",
    });
    expect(await usageRow(closed)).toMatchObject({
      count: 3,
      applied_quantity: 3,
      apply_outcome: "updated",
    });
    s.calls.length = 0;
    expect((await call(report(closed, 3))).status).toBe(200);
    expect(s.calls).toEqual([]);
  });

  it("Business is set at its own price; an item already at the count is not written", async () => {
    await live("business");
    const s = fake({ price: "price_business1", quantity: 4 });
    expect((await call(report(closed, 4))).status).toBe(200);
    expect(s.calls.map((c) => [c.method, c.path])).toEqual([["GET", SUBS]]);
    expect(await usageRow(closed)).toMatchObject({
      applied_quantity: 4,
      apply_outcome: "unchanged",
    });
  });

  it("a month with no creators bills 1", async () => {
    await live();
    const s = fake({ quantity: 5 });
    expect((await call(report(closed, 0))).status).toBe(200);
    expect(s.calls[1]?.form.quantity).toBe("1");
    expect(await usageRow(closed)).toMatchObject({ applied_quantity: 1 });
  });

  it("a past_due subscription is still set", async () => {
    await live("team", "past_due");
    const s = fake({ status: "past_due" });
    expect((await call(report(closed, 2))).status).toBe(200);
    expect(s.calls.at(-1)?.form.quantity).toBe("2");
  });

  it("Solo, trial, lapsed, suspended and no-subscription rows are stored and skipped, with no Stripe call", async () => {
    for (const [setup, why] of [
      [() => live("solo"), "solo"],
      [() => live("free"), "solo"],
      [() => live("trial"), "trial"],
      [() => live("team", "lapsed"), "lapsed"],
      [() => live("business", "suspended"), "suspended"],
      [() => seed(A, "cus_existingA", "team"), "no_subscription"],
      [async () => undefined, "no_subscription"],
    ] as const) {
      await db.batch([
        db.prepare("DELETE FROM tiers"),
        db.prepare("DELETE FROM usage"),
      ]);
      await setup();
      const s = fake();
      const r = await call(report(closed, 2));
      expect(r.status, why).toBe(200);
      expect(s.calls, why).toEqual([]);
      expect(await usageRow(closed), why).toMatchObject({
        count: 2,
        applied_quantity: null,
        apply_outcome: why,
      });
      s.spy.mockRestore();
    }
  });

  it("the current month is stored only: its quantity waits until it closes", async () => {
    await live();
    const s = fake();
    expect((await call(report(shift(0), 3))).status).toBe(200);
    expect(s.calls).toEqual([]);
    expect(await usageRow(shift(0))).toMatchObject({
      count: 3,
      applied_quantity: null,
      apply_outcome: null,
    });
  });

  it("a yearly or unknown price is left alone (not_monthly)", async () => {
    for (const o of [
      { interval: "year" },
      { price: "price_teamY1", interval: "year" },
      { price: "price_business1" },
    ]) {
      await db.batch([
        db.prepare("DELETE FROM tiers"),
        db.prepare("DELETE FROM usage"),
      ]);
      await live();
      const s = fake(o);
      expect((await call(report(closed, 3))).status).toBe(200);
      expect(s.calls.map((c) => c.method)).toEqual(["GET"]);
      expect(await usageRow(closed)).toMatchObject({
        applied_quantity: null,
        apply_outcome: "not_monthly",
      });
      s.spy.mockRestore();
    }
  });

  it("an older month never overrides a later one already applied", async () => {
    await live();
    const s = fake();
    expect((await call(report(closed, 3))).status).toBe(200);
    s.calls.length = 0;
    expect((await call(report(shift(-2), 9))).status).toBe(200);
    expect(s.calls).toEqual([]);
    expect(await usageRow(shift(-2))).toMatchObject({
      count: 9,
      applied_quantity: null,
      apply_outcome: "stale",
    });
  });

  it("a Stripe outage keeps the report, answers 502 so the instance re-sends, and the re-send applies it", async () => {
    await live();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let down = true;
    const s = fakeStripe(async (c) => {
      if (down)
        return Response.json({ error: { type: "api_error" } }, { status: 500 });
      if (c.method === "GET" && c.path === SUBS) return subscription();
      if (c.method === "POST" && c.path === ITEM)
        return Response.json({ id: "si_itemA" });
      return undefined;
    });
    const r = await call(report(closed, 3));
    expect([r.status, await r.json()]).toEqual([502, { error: "upstream" }]);
    expect(await usageRow(closed)).toMatchObject({
      count: 3,
      applied_quantity: null,
      apply_outcome: "failed",
    });
    down = false;
    s.calls.length = 0;
    expect((await call(report(closed, 3))).status).toBe(200);
    expect(s.calls.map((c) => [c.method, c.path, c.key])).toEqual([
      ["GET", SUBS, null],
      [
        "POST",
        ITEM,
        expect.stringMatching(new RegExp(`^qty-${A}-${closed}-3-\\d+$`)),
      ],
    ]);
    expect(await usageRow(closed)).toMatchObject({
      applied_quantity: 3,
      apply_outcome: "updated",
    });
  });

  it("a Stripe 409 (the same write in progress) is 503 retry; a 429 is 502", async () => {
    await live();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [status, want] of [
      [409, [503, { error: "retry" }]],
      [429, [502, { error: "upstream" }]],
    ] as const) {
      const s = fake({}, () =>
        Response.json({ error: { type: "x" } }, { status }),
      );
      const r = await call(report(closed, 3));
      expect([r.status, await r.json()]).toEqual(want);
      s.spy.mockRestore();
    }
  });

  it("a Stripe 4xx a retry can't fix keeps the report and answers 200 (later months still report); the next report tries again", async () => {
    await live();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    let refuse = true;
    const s = fake({}, () =>
      refuse
        ? Response.json(
            { error: { type: "invalid_request_error" } },
            { status: 400 },
          )
        : undefined,
    );
    expect((await call(report(closed, 3))).status).toBe(200);
    expect(await usageRow(closed)).toMatchObject({
      applied_quantity: null,
      apply_outcome: "failed",
    });
    expect(errors).toContain(`billing usage quantity failed ${A}`);
    refuse = false;
    s.calls.length = 0;
    expect((await call(report(closed, 3))).status).toBe(200);
    expect(s.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(await usageRow(closed)).toMatchObject({
      applied_quantity: 3,
      apply_outcome: "updated",
    });
  });

  it("a Stripe 401 or 403 (a revoked or rotated key) is retried: 502, never a 200 that moves the server past the month", async () => {
    await live();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const status of [401, 403]) {
      const s = fakeStripe(() =>
        Response.json({ error: { type: "invalid_request_error" } }, { status }),
      );
      const r = await call(report(closed, 3));
      expect([r.status, await r.json()], String(status)).toEqual([
        502,
        { error: "upstream" },
      ]);
      expect(await usageRow(closed)).toMatchObject({
        count: 3,
        applied_quantity: null,
        apply_outcome: "failed",
      });
      s.spy.mockRestore();
    }
  });

  it("3 -> 5 -> 3 within a day ends at 3 in Stripe: each report's write has its own key", async () => {
    await live();
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2026, 10, 11, 12, 0);
    vi.setSystemTime(t0);
    const month = "2026-10";
    // Stripe as it is: the item's quantity, and a key's first answer replayed
    // for 24 hours without applying the write again.
    let quantity = 1;
    const seen = new Set<string>();
    const s = fakeStripe((c) => {
      if (c.method === "GET" && c.path === SUBS)
        return subscription({ quantity });
      if (c.method === "POST" && c.path === ITEM) {
        if (!seen.has(c.key as string)) {
          seen.add(c.key as string);
          quantity = Number(c.form.quantity);
        }
        return Response.json({ id: "si_itemA", quantity });
      }
      return undefined;
    });
    for (const [i, n] of [3, 5, 3].entries()) {
      vi.setSystemTime(t0 + i * 3_600_000);
      expect((await call(report(month, n))).status).toBe(200);
      expect(quantity).toBe(n);
      expect(await usageRow(month)).toMatchObject({
        applied_quantity: n,
        applied_at: t0 + i * 3_600_000,
        apply_outcome: "updated",
      });
    }
    const keys = s.calls.filter((c) => c.method === "POST").map((c) => c.key);
    expect(keys).toEqual([
      `qty-${A}-${month}-3-${t0}`,
      `qty-${A}-${month}-5-${t0 + 3_600_000}`,
      `qty-${A}-${month}-3-${t0 + 7_200_000}`,
    ]);
    vi.useRealTimers();
  });

  it("a changed count for an applied month is applied again", async () => {
    await live();
    const s = fake();
    await call(report(closed, 3));
    s.calls.length = 0;
    expect((await call(report(closed, 5))).status).toBe(200);
    expect(s.calls.at(-1)?.key).toMatch(
      new RegExp(`^qty-${A}-${closed}-5-\\d+$`),
    );
    expect(await usageRow(closed)).toMatchObject({ applied_quantity: 5 });
  });
});

describe("Team and Business yearly Checkout sells prepaid seats (#2136)", () => {
  const yearlyEnv = (): Env => ({
    ...baseEnv(),
    STRIPE_PRICE_TEAM_YEARLY: "price_teamY1",
    STRIPE_PRICE_BUSINESS_YEARLY: "price_businessY1",
  });

  it("year + seats uses the yearly price, quantity = seats, and interval and seats are in the key", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    const ts = Date.now();
    for (const [plan, seats, price] of [
      ["team", 5, "price_teamY1"],
      ["business", 1, "price_businessY1"],
      ["team", MAX_CREATORS, "price_teamY1"],
    ] as const) {
      const r = await call(
        req("/checkout", { install: A, ts, plan, interval: "year", seats }),
        yearlyEnv(),
      );
      expect(r.status).toBe(200);
      const c = s.calls.at(-1);
      expect(c?.path).toBe(CHECKOUT);
      expect(c?.form["line_items[0][price]"]).toBe(price);
      expect(c?.form["line_items[0][quantity]"]).toBe(String(seats));
      expect(c?.key).toBe(`checkout-${A}-${plan}-year-s${seats}-${ts}`);
    }
  });

  it("interval month is the monthly price, as when absent", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    const r = await call(
      req("/checkout", { install: A, plan: "team", interval: "month" }),
      yearlyEnv(),
    );
    expect(r.status).toBe(200);
    expect(s.calls.at(-1)?.form["line_items[0][price]"]).toBe("price_team1");
  });

  it("refuses bad seats, seats with month, year without seats or with creators, before any Stripe call", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    for (const [body, error] of [
      [{ plan: "team", seats: 3 }, "bad_seats"],
      [{ plan: "team", interval: "month", seats: 3 }, "bad_seats"],
      [{ plan: "team", interval: "year" }, "bad_seats"],
      [{ plan: "team", interval: "year", seats: 0 }, "bad_seats"],
      [
        { plan: "team", interval: "year", seats: MAX_CREATORS + 1 },
        "bad_seats",
      ],
      [{ plan: "business", interval: "year", seats: 1.5 }, "bad_seats"],
      [{ plan: "business", interval: "year", seats: "3" }, "bad_seats"],
      [{ plan: "business", interval: "year", seats: null }, "bad_seats"],
      [{ plan: "solo", interval: "year", seats: 3 }, "bad_seats"],
      [
        { plan: "team", interval: "year", seats: 3, creators: 3 },
        "bad_creators",
      ],
    ] as [Record<string, unknown>, string][]) {
      const r = await call(
        req("/checkout", { install: A, ...body }),
        yearlyEnv(),
      );
      expect([r.status, await r.json()]).toEqual([400, { error }]);
    }
    expect(s.calls).toEqual([]);
  });

  it("yearly with the price id unset is a 503 config error, never an empty price", async () => {
    await seed(A, "cus_existingA");
    const s = fakeStripe();
    for (const plan of ["team", "business"]) {
      const r = await call(
        req("/checkout", { install: A, plan, interval: "year", seats: 2 }),
        baseEnv(),
      );
      expect([r.status, await r.json()]).toEqual([503, { error: "config" }]);
    }
    expect(s.calls).toEqual([]);
  });
});

describe("POST /usage bills a yearly subscription's creators above its seats (#2235)", () => {
  const SUB = "sub_yearA";
  const SUBS = `/v1/subscriptions/${SUB}`;
  const shift = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
      .toISOString()
      .slice(0, 7);
  };
  const closed = shift(-1);
  const label = new Date(`${closed}-01T00:00:00Z`).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const yEnv = (): Env => ({
    ...baseEnv(),
    STRIPE_PRICE_TEAM_YEARLY: "price_teamY1",
    STRIPE_PRICE_BUSINESS_YEARLY: "price_businessY1",
  });
  const report = (month: string, count: number) =>
    req("/usage", {
      install: A,
      month,
      creators: Array.from({ length: count }, (_, i) => `u${i}`),
      count,
    });
  const send = (month: string, count: number) =>
    call(report(month, count), yEnv());
  async function live(tier = "team", status = "active") {
    await seed(A, "cus_existingA", tier);
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = ?1, status = ?2 WHERE install_id = ?3",
      )
      .bind(SUB, status, A)
      .run();
  }
  const subscription = (
    o: { price?: string; interval?: string; seats?: number } = {},
  ) =>
    Response.json({
      id: SUB,
      status: "active",
      items: {
        data: [
          {
            id: "si_itemA",
            quantity: o.seats ?? 3,
            price: {
              id: o.price ?? "price_teamY1",
              recurring: { interval: o.interval ?? "year" },
            },
          },
        ],
      },
    });
  /**
   * A small Stripe that remembers invoices and items, so a retry can find
   * what an earlier attempt made. `fail` maps "METHOD /path" to a status
   * answered before any effect; with `lose` the effect happens and the
   * answer is a 500 (the answer was lost).
   */
  type Ledger = {
    n: number;
    invoices: {
      id: string;
      status: string;
      metadata: Record<string, string>;
    }[];
    items: { id: string; invoice: string; metadata: Record<string, string> }[];
  };
  const newLedger = (): Ledger => ({ n: 0, invoices: [], items: [] });
  type Opts = {
    sub?: Parameters<typeof subscription>[0];
    ledger?: Ledger;
    fail?: Record<string, number>;
    lose?: Record<string, boolean>;
  };
  const metaOf = (form: Record<string, string>) => ({
    kind: form["metadata[kind]"] ?? "",
    install: form["metadata[install]"] ?? "",
    month: form["metadata[month]"] ?? "",
  });
  const fake = (o: Opts = {}) => {
    const L = o.ledger ?? newLedger();
    const s = fakeStripe((c) => {
      const key = `${c.method} ${c.path}`;
      const bad = o.fail?.[key];
      if (bad !== undefined)
        return Response.json({ error: { type: "x" } }, { status: bad });
      let out: Response | undefined;
      if (key === `GET ${SUBS}`) return subscription(o.sub);
      if (key === "POST /v1/invoices") {
        const id = `in_inv${++L.n}`;
        L.invoices.push({ id, status: "draft", metadata: metaOf(c.form) });
        out = Response.json({ id });
      } else if (key === "GET /v1/invoices") {
        out = Response.json({
          data: L.invoices.filter((i) => i.status === "draft"),
        });
      } else if (key === "POST /v1/invoiceitems") {
        const id = `ii_item${++L.n}`;
        L.items.push({
          id,
          invoice: c.form.invoice ?? "",
          metadata: metaOf(c.form),
        });
        out = Response.json({ id });
      } else if (key === "GET /v1/invoiceitems") {
        const inv = new URLSearchParams(c.search).get("invoice");
        out = Response.json({
          data: L.items.filter((i) => i.invoice === inv),
        });
      } else {
        const m = /^\/v1\/invoices\/(in_\w+)(\/finalize)?$/.exec(c.path);
        const inv = L.invoices.find((i) => i.id === m?.[1]);
        if (!m) return undefined;
        if (!inv)
          return Response.json({ error: { type: "x" } }, { status: 404 });
        if (m[2]) inv.status = "open";
        out = Response.json({ id: inv.id, status: inv.status });
      }
      return o.lose?.[key]
        ? Response.json({ error: { type: "x" } }, { status: 500 })
        : out;
    });
    return Object.assign(s, { L });
  };
  const paths = (s: { calls: { method: string; path: string }[] }) =>
    s.calls.map((c) => `${c.method} ${c.path}`);
  const overageRow = () =>
    db
      .prepare(
        "SELECT seats, creators, quantity, unit_amount, item_id, invoice_id, outcome FROM overage WHERE install_id = ?1 AND month = ?2",
      )
      .bind(A, closed)
      .first();
  const outcomeOf = async () =>
    (
      await db
        .prepare(
          "SELECT apply_outcome AS o, applied_quantity AS q FROM usage WHERE install_id = ?1 AND month = ?2",
        )
        .bind(A, closed)
        .first<{ o: string; q: number | null }>()
    )?.o;
  /** The nth step write (1 = invoice recorded, 2 = item recorded) throws. */
  const failStepWrite = (nth: number) => {
    let n = 0;
    const real = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("coalesce(?3, item_id)") && ++n === nth)
        throw new Error("d1 down");
      return real(sql);
    });
  };
  const FINALIZE = "POST /v1/invoices/in_inv1/finalize";

  it("bills the extra creators at the monthly price: draft invoice, its item, finalize", async () => {
    await live();
    const s = fake();
    const r = await send(closed, 5);
    expect([r.status, await r.json()]).toEqual([
      200,
      { ok: true, month: closed, count: 5 },
    ]);
    expect(paths(s)).toEqual([
      `GET ${SUBS}`,
      "GET /v1/invoices",
      "POST /v1/invoices",
      "GET /v1/invoiceitems",
      "POST /v1/invoiceitems",
      FINALIZE,
    ]);
    const meta = {
      "metadata[kind]": "overage",
      "metadata[install]": A,
      "metadata[month]": closed,
    };
    // The invoice takes no pending items; the item is attached to it.
    expect(s.calls[2]?.form).toEqual({
      customer: "cus_existingA",
      collection_method: "charge_automatically",
      pending_invoice_items_behavior: "exclude",
      ...meta,
    });
    expect(s.calls[4]?.form).toEqual({
      customer: "cus_existingA",
      invoice: "in_inv1",
      currency: "usd",
      unit_amount: "1000",
      quantity: "2",
      description: `Extra creators, ${label}: 2 × $10`,
      ...meta,
    });
    expect([2, 4, 5].map((i) => s.calls[i]?.key)).toEqual([
      `ovg-inv-${A}-${closed}`,
      `ovg-item-${A}-${closed}`,
      `ovg-fin-${A}-${closed}`,
    ]);
    expect(await overageRow()).toEqual({
      seats: 3,
      creators: 5,
      quantity: 2,
      unit_amount: 1000,
      item_id: "ii_item2",
      invoice_id: "in_inv1",
      outcome: "invoiced",
    });
    expect(await outcomeOf()).toBe("overage_invoiced");
    // The subscription's own quantity is never written.
    expect(paths(s).some((p) => p.includes("subscription_items"))).toBe(false);
  });

  it("Business bills $25 a creator", async () => {
    await live("business");
    const s = fake({ sub: { price: "price_businessY1", seats: 1 } });
    expect((await send(closed, 3)).status).toBe(200);
    expect(s.calls[4]?.form).toMatchObject({
      unit_amount: "2500",
      quantity: "2",
      description: `Extra creators, ${label}: 2 × $25`,
    });
  });

  it("no overage (count at or under seats) makes no billing call and records none", async () => {
    await live();
    for (const count of [3, 1, 0]) {
      const s = fake();
      expect((await send(closed, count)).status).toBe(200);
      expect(paths(s)).toEqual([`GET ${SUBS}`]);
      expect(await overageRow()).toBeNull();
      expect(await outcomeOf()).toBe("overage_none");
    }
  });

  it("a repeat report for an invoiced month never bills again, even with a changed count", async () => {
    await live();
    const s = fake();
    await send(closed, 5);
    s.calls.length = 0;
    for (const count of [5, 9, 2])
      expect((await send(closed, count)).status).toBe(200);
    expect(s.calls).toEqual([]);
    expect((await overageRow())?.quantity).toBe(2);
  });

  it("a failed invoice create leaves nothing; the retry makes the one invoice and item", async () => {
    await live();
    const L = newLedger();
    fake({ ledger: L, fail: { "POST /v1/invoices": 500 } });
    expect((await send(closed, 5)).status).toBe(502);
    expect(await overageRow()).toMatchObject({
      invoice_id: null,
      item_id: null,
      outcome: "pending",
    });
    expect(await outcomeOf()).toBe("overage_failed");
    fake({ ledger: L });
    expect((await send(closed, 7)).status).toBe(200);
    expect([L.invoices.length, L.items.length]).toEqual([1, 1]);
    // The row keeps the quantity it first computed (5 - 3).
    expect(await overageRow()).toMatchObject({
      quantity: 2,
      outcome: "invoiced",
    });
  });

  it("the invoice's answer is lost: the retry finds the draft and makes no second invoice", async () => {
    await live();
    const L = newLedger();
    fake({ ledger: L, lose: { "POST /v1/invoices": true } });
    expect((await send(closed, 5)).status).toBe(502);
    expect(L.invoices).toHaveLength(1);
    expect(await overageRow()).toMatchObject({ invoice_id: null });
    const s = fake({ ledger: L });
    expect((await send(closed, 5)).status).toBe(200);
    expect(paths(s)).not.toContain("POST /v1/invoices");
    expect(L.invoices).toHaveLength(1);
    expect(L.items).toHaveLength(1);
    expect(await overageRow()).toMatchObject({
      invoice_id: "in_inv1",
      outcome: "invoiced",
    });
  });

  it("the item's answer is lost and the retry comes after the key expired: no second item", async () => {
    await live();
    const L = newLedger();
    fake({ ledger: L, lose: { "POST /v1/invoiceitems": true } });
    expect((await send(closed, 5)).status).toBe(502);
    expect(L.items).toHaveLength(1);
    expect(await overageRow()).toMatchObject({
      invoice_id: "in_inv1",
      item_id: null,
      outcome: "invoice_created",
    });
    // This Stripe keeps no idempotency keys: the key has expired.
    const s = fake({ ledger: L });
    expect((await send(closed, 5)).status).toBe(200);
    expect(paths(s)).toEqual([
      `GET ${SUBS}`,
      "GET /v1/invoices/in_inv1",
      "GET /v1/invoiceitems",
      FINALIZE,
    ]);
    expect(L.items).toHaveLength(1);
    expect(await overageRow()).toMatchObject({
      item_id: "ii_item2",
      outcome: "invoiced",
    });
  });

  it("the D1 write that records the invoice fails: the retry finds the draft", async () => {
    await live();
    const L = newLedger();
    fake({ ledger: L });
    failStepWrite(1);
    expect((await send(closed, 5)).status).toBe(503);
    vi.mocked(db.prepare).mockRestore();
    expect(L.invoices).toHaveLength(1);
    expect(L.items).toHaveLength(0);
    expect(await overageRow()).toMatchObject({ invoice_id: null });
    const s = fake({ ledger: L });
    expect((await send(closed, 5)).status).toBe(200);
    expect(paths(s)).not.toContain("POST /v1/invoices");
    expect([L.invoices.length, L.items.length]).toEqual([1, 1]);
    expect((await overageRow())?.outcome).toBe("invoiced");
  });

  it("the D1 write that records the item fails: the retry finds the item", async () => {
    await live();
    const L = newLedger();
    fake({ ledger: L });
    failStepWrite(2);
    expect((await send(closed, 5)).status).toBe(503);
    vi.mocked(db.prepare).mockRestore();
    expect(L.items).toHaveLength(1);
    expect(await overageRow()).toMatchObject({
      invoice_id: "in_inv1",
      item_id: null,
    });
    const s = fake({ ledger: L });
    expect((await send(closed, 5)).status).toBe(200);
    expect(paths(s)).not.toContain("POST /v1/invoiceitems");
    expect([L.invoices.length, L.items.length]).toEqual([1, 1]);
    expect((await overageRow())?.outcome).toBe("invoiced");
  });

  it("a failed finalize is retried by finalizing the same draft", async () => {
    await live();
    const L = newLedger();
    fake({ ledger: L, fail: { [FINALIZE]: 503 } });
    expect((await send(closed, 5)).status).toBe(502);
    expect(await overageRow()).toMatchObject({
      invoice_id: "in_inv1",
      outcome: "item_created",
    });
    const s = fake({ ledger: L });
    expect((await send(closed, 5)).status).toBe(200);
    expect(paths(s)).toEqual([
      `GET ${SUBS}`,
      "GET /v1/invoices/in_inv1",
      FINALIZE,
    ]);
    expect([L.invoices.length, L.items.length]).toEqual([1, 1]);
  });

  it("a finalize whose answer was lost is not finalized again", async () => {
    await live();
    const L = newLedger();
    fake({ ledger: L, lose: { [FINALIZE]: true } });
    expect((await send(closed, 5)).status).toBe(502);
    expect(L.invoices[0]?.status).toBe("open");
    const s = fake({ ledger: L });
    expect((await send(closed, 5)).status).toBe(200);
    expect(paths(s)).toEqual([`GET ${SUBS}`, "GET /v1/invoices/in_inv1"]);
    expect((await overageRow())?.outcome).toBe("invoiced");
  });

  it("an invoice deleted in Stripe is made again, with its item, instead of leaving the row stuck", async () => {
    await live();
    const L = newLedger();
    fake({ ledger: L, fail: { [FINALIZE]: 503 } });
    await send(closed, 5);
    // The draft and its attached item are gone.
    L.invoices.length = 0;
    L.items.length = 0;
    const s = fake({ ledger: L });
    expect((await send(closed, 5)).status).toBe(200);
    expect(paths(s)).toContain("POST /v1/invoices");
    expect(paths(s)).toContain("POST /v1/invoiceitems");
    expect(L.invoices.map((i) => [i.id, i.status])).toEqual([
      ["in_inv3", "open"],
    ]);
    expect(L.items).toHaveLength(1);
    expect(await overageRow()).toMatchObject({
      invoice_id: "in_inv3",
      outcome: "invoiced",
    });
  });

  it("401, 403, 409, 429, 5xx and network errors are retried; other 4xx are logged and the 200 stands", async () => {
    for (const [status, answer] of [
      [401, 502],
      [403, 502],
      [409, 503],
      [429, 502],
      [500, 502],
      [503, 502],
      [400, 200],
      [402, 200],
      [404, 200],
    ] as const) {
      await db.batch([
        db.prepare("DELETE FROM tiers"),
        db.prepare("DELETE FROM usage"),
        db.prepare("DELETE FROM overage"),
      ]);
      await live();
      fake({ fail: { "POST /v1/invoices": status } });
      const r = await send(closed, 5);
      expect([status, r.status]).toEqual([status, answer]);
      expect(await outcomeOf()).toBe("overage_failed");
    }
    await db.batch([
      db.prepare("DELETE FROM tiers"),
      db.prepare("DELETE FROM usage"),
      db.prepare("DELETE FROM overage"),
    ]);
    await live();
    fakeStripe((c) => {
      if (c.path === SUBS) return subscription();
      throw new TypeError("network");
    });
    expect((await send(closed, 5)).status).toBe(502);
  });

  it("a permanent failure is tried again by the next report", async () => {
    await live();
    const L = newLedger();
    fake({ ledger: L, fail: { "POST /v1/invoiceitems": 400 } });
    expect((await send(closed, 5)).status).toBe(200);
    expect(await outcomeOf()).toBe("overage_failed");
    fake({ ledger: L });
    expect((await send(closed, 5)).status).toBe(200);
    expect([L.invoices.length, L.items.length]).toEqual([1, 1]);
    expect((await overageRow())?.outcome).toBe("invoiced");
  });

  it("a monthly subscription is untouched by overage (its quantity follows the count)", async () => {
    await live();
    const s = fakeStripe((c) =>
      c.method === "GET" && c.path === SUBS
        ? Response.json({
            id: SUB,
            status: "active",
            items: {
              data: [
                {
                  id: "si_itemA",
                  quantity: 1,
                  price: {
                    id: "price_team1",
                    recurring: { interval: "month" },
                  },
                },
              ],
            },
          })
        : Response.json({ id: "si_itemA" }),
    );
    expect((await send(closed, 5)).status).toBe(200);
    expect(paths(s)).toEqual([
      `GET ${SUBS}`,
      "POST /v1/subscription_items/si_itemA",
    ]);
    expect(await overageRow()).toBeNull();
  });

  it("a yearly price that is not this tier's, a monthly interval, or an unset yearly price is left alone", async () => {
    await live();
    for (const [sub, e] of [
      [{ price: "price_businessY1" }, yEnv()],
      [{ price: "price_other" }, yEnv()],
      [{}, baseEnv()],
    ] as const) {
      const s = fake({ sub });
      expect((await call(report(closed, 5), e)).status).toBe(200);
      expect(paths(s)).toEqual([`GET ${SUBS}`]);
      expect(await outcomeOf()).toBe("not_monthly");
    }
    expect(await overageRow()).toBeNull();
  });

  it("the open month, and trial, lapsed, suspended and Solo rows, make no Stripe call", async () => {
    await live();
    let s = fake();
    expect((await send(shift(0), 9)).status).toBe(200);
    expect(s.calls).toEqual([]);
    for (const [tier, status] of [
      ["trial", "active"],
      ["solo", "active"],
      ["team", "lapsed"],
      ["team", "suspended"],
    ] as const) {
      await db.batch([
        db.prepare("DELETE FROM tiers"),
        db.prepare("DELETE FROM usage"),
      ]);
      await live(tier, status);
      s = fake();
      expect((await send(closed, 9)).status).toBe(200);
      expect(s.calls).toEqual([]);
    }
    expect(await overageRow()).toBeNull();
  });
});

describe("two plans sharing a price id fail closed (#2235)", () => {
  it("pricesCollide ignores unset ids and finds a repeated one", () => {
    const e = baseEnv();
    expect(pricesCollide(e)).toBe(false);
    expect(
      pricesCollide({ ...e, STRIPE_PRICE_TEAM_YEARLY: "price_team1" }),
    ).toBe(true);
    expect(
      pricesCollide({
        ...e,
        STRIPE_PRICE_TEAM_YEARLY: "price_y",
        STRIPE_PRICE_BUSINESS_YEARLY: "price_y",
      }),
    ).toBe(true);
  });

  it("the gate and webhook routes answer 500 config; /health still answers", async () => {
    const bad: Env = { ...baseEnv(), STRIPE_PRICE_BUSINESS: "price_team1" };
    const s = fakeStripe();
    const r = await call(req("/checkout", { install: A, plan: "team" }), bad);
    expect([r.status, await r.json()]).toEqual([500, { error: "config" }]);
    const w = await billing.fetch(
      new Request(`${ORIGIN}/stripe/webhook`, {
        method: "POST",
        headers: { "cf-connecting-ip": "1.2.3.4" },
        body: "{}",
      }) as Parameters<typeof billing.fetch>[0],
      bad,
    );
    expect(w.status).toBe(500);
    expect(s.calls).toEqual([]);
  });
});
