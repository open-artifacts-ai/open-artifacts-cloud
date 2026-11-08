import { applyD1Migrations } from "cloudflare:test";
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
import billing, { type Env } from "../src/index.js";

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
  ]);
  clearRegistryCache();
  await register();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CHECKOUT = "/v1/checkout/sessions";
const PORTAL = "/v1/billing_portal/sessions";
const CUSTOMERS = "/v1/customers";

// ------------------------------------------------------------ tests

describe("POST /checkout", () => {
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
      success_url: `https://${HOST_A}/settings/billing?checkout=done`,
      cancel_url: `https://${HOST_A}/settings/billing?checkout=cancel`,
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
    // the other answers 503 retry (#1568); neither fails otherwise.
    const codes = rs.map((r) => r.status);
    expect(codes).toContain(200);
    for (const c of codes) expect([200, 503]).toContain(c);
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
    // the other answers 503 retry (#1568); neither fails otherwise.
    const codes = rs.map((r) => r.status);
    expect(codes).toContain(200);
    for (const c of codes) expect([200, 503]).toContain(c);
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
      [{ install: A, plan: "team", interval: "month" }, 400, "bad_plan"],
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
        auth: `Bearer ${SECRET}`,
        form: {
          customer: "cus_existingA",
          return_url: `https://${HOST_A}/settings/billing`,
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
      `https://${HOST_A}/settings/billing?checkout=done`,
      `https://${HOST_A}/settings/billing?checkout=cancel`,
      `https://${HOST_A}/settings/billing`,
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
      "https://acme.open-artifacts.app/settings/billing",
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

// ------------------------------------------------------------ POST /solo/start

describe("POST /solo/start (#1568)", () => {
  const NOW = Date.UTC(2026, 10, 9, 12, 0);
  const DAY = 86_400_000;
  const SUBS = "/v1/subscriptions";
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
  const start = (o: Opts = {}, body: Record<string, unknown> = {}) =>
    req("/solo/start", { install: A, ts: NOW, ...body }, o);

  it("no row: makes the solo row and customer, creates the 30-day no-card subscription on the monthly price, stores its id and the trial end", async () => {
    const s = fakeStripe();
    const r = await call(start());
    expect(r.status).toBe(200);
    expect(s.calls.map((c) => [c.path, c.key])).toEqual([
      [CUSTOMERS, `cust-${A}`],
      [SUBS, `solo-trial-${A}`],
    ]);
    expect(s.calls[1]?.form).toEqual({
      customer: "cus_fake1",
      "items[0][price]": "price_soloM1",
      trial_period_days: "30",
      "trial_settings[end_behavior][missing_payment_method]": "cancel",
      "metadata[tier]": "solo",
    });
    expect(await rowOf(A)).toMatchObject({
      tier: "solo",
      status: "active",
      stripe_customer_id: "cus_fake1",
      stripe_subscription_id: "sub_fake2",
      solo_trial_ends_at: NOW + 30 * DAY,
      version: 1,
    });
    // The answer carries no Stripe id.
    expect(JSON.stringify(await r.json())).not.toMatch(/cus_|sub_/);
  });

  it("twice, or concurrently: one subscription, one version bump, the same answer", async () => {
    const s = fakeStripe();
    const [x, y, z] = await Promise.all([
      call(start()),
      call(start()),
      call(start()),
    ]);
    expect([x.status, y.status, z.status]).toEqual([200, 200, 200]);
    // Racing calls share one Stripe key, so Stripe makes one subscription.
    const subCalls = () => s.calls.filter((c) => c.path === SUBS);
    expect(new Set(subCalls().map((c) => c.key))).toEqual(
      new Set([`solo-trial-${A}`]),
    );
    const raced = subCalls().length;
    const again = await call(start({}, { ts: NOW + 5 }));
    expect(again.status).toBe(200);
    // Once stored, a later start makes no call at all.
    expect(subCalls()).toHaveLength(raced);
    expect(await rowOf(A)).toMatchObject({
      stripe_subscription_id: "sub_fake2",
      version: 1,
    });
  });

  it("a row already on team, business or trial is 409 plan_conflict, with no Stripe call and no write", async () => {
    for (const tier of ["team", "business", "trial"]) {
      await seed(A, "cus_existingA", tier);
      const before = await rowOf(A);
      const s = fakeStripe();
      const r = await call(start());
      expect([r.status, await r.json()], tier).toEqual([
        409,
        { error: "plan_conflict" },
      ]);
      expect(s.calls).toEqual([]);
      expect(await rowOf(A)).toEqual(before);
      s.spy.mockRestore();
      await db.prepare("DELETE FROM tiers").run();
    }
  });

  it("a legacy free row becomes solo; a row that had a subscription or a Solo trial never gets another", async () => {
    await seed(A, "cus_existingA", "free");
    fakeStripe();
    await call(start());
    expect(await rowOf(A)).toMatchObject({
      tier: "solo",
      stripe_subscription_id: "sub_fake1",
    });
    await db.prepare("DELETE FROM tiers").run();
    // Its trial ended with no card: lapsed, id kept. No second trial.
    await seed(A, "cus_existingA", "solo");
    await db
      .prepare(
        "UPDATE tiers SET status = 'lapsed', stripe_subscription_id = 'sub_old1', solo_trial_ends_at = ?1 WHERE install_id = ?2",
      )
      .bind(NOW - DAY, A)
      .run();
    const s = fakeStripe();
    const r = await call(start());
    expect(r.status).toBe(200);
    expect(s.calls).toEqual([]);
    expect(await r.json()).toMatchObject({ tier: "solo", status: "lapsed" });
  });

  it("a webhook that got there first (the id is already stored) leaves it alone: no second subscription", async () => {
    await seed(A, "cus_existingA", "solo");
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = 'sub_hook1' WHERE install_id = ?1",
      )
      .bind(A)
      .run();
    const s = fakeStripe();
    expect((await call(start())).status).toBe(200);
    expect(s.calls).toEqual([]);
  });

  it("config: no key, a live key (sk or rk), an unfilled or malformed monthly price: 500 config, no Stripe call", async () => {
    const s = fakeStripe();
    for (const e of [
      { STRIPE_SECRET_KEY: undefined },
      { STRIPE_SECRET_KEY: "sk_live_abcdefgh12345678" },
      { STRIPE_SECRET_KEY: "rk_live_abcdefgh12345678" },
      { STRIPE_PRICE_SOLO_MONTHLY: "{{STRIPE_PRICE_SOLO_MONTHLY_STAGING}}" },
      { STRIPE_PRICE_SOLO_MONTHLY: "prod_1abc" },
    ]) {
      const r = await call(start(), { ...baseEnv(), ...e } as Env);
      expect([r.status, await r.json()]).toEqual([500, { error: "config" }]);
    }
    expect(s.calls).toEqual([]);
    expect(await rowOf(A)).toMatchObject({ stripe_subscription_id: null });
  });

  it("signed like the other POSTs: unsigned, wrong install key or stale is 401; extra fields 400; another install's name 403; Stripe errors 502", async () => {
    const s = fakeStripe();
    for (const o of [
      { unsigned: true },
      { signer: B },
      { signPath: "/trial/start" },
    ] as Opts[]) {
      const r = await call(start(o));
      expect(r.status).toBe(401);
    }
    expect(
      (await call(req("/solo/start", { install: A, ts: NOW - 3_600_000 })))
        .status,
    ).toBe(401);
    expect((await call(start({}, { plan: "team" }))).status).toBe(400);
    expect((await call(start({}, { install: B }))).status).toBe(403);
    expect(s.calls).toEqual([]);
    vi.restoreAllMocks();
    fakeStripe((c) =>
      c.path === SUBS
        ? Response.json({ error: { type: "api_error" } }, { status: 500 })
        : undefined,
    );
    const r = await call(start());
    expect([r.status, await r.json()]).toEqual([502, { error: "upstream" }]);
    // The customer is mapped, the subscription is not: a retry may try again.
    expect(await rowOf(A)).toMatchObject({
      stripe_customer_id: "cus_fake1",
      stripe_subscription_id: null,
    });
  });

  it("cf-connecting-ip: the plain 404", async () => {
    const s = fakeStripe();
    const r = await call(start({ headers: { "cf-connecting-ip": "1.2.3.4" } }));
    expect(r.status).toBe(404);
    expect(s.calls).toEqual([]);
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

  it("a past Solo trial cannot start again through /solo/start", async () => {
    await db.prepare("DELETE FROM tiers").run();
    await seed(A, "cus_existingA", "solo");
    await db
      .prepare(
        "UPDATE tiers SET solo_trial_ends_at = ?1, status = 'lapsed' WHERE install_id = ?2",
      )
      .bind(NOW - H, A)
      .run();
    const s = fakeStripe();
    const r = await call(req("/solo/start", { install: A, ts: NOW }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      tier: "solo",
      status: "lapsed",
      soloTrialEndsAt: null,
    });
    expect(s.calls).toEqual([]);
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

  it("two Checkouts racing: the one that loses the store expires its own session and answers 503 retry", async () => {
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
    expect([r.status, await r.json()]).toEqual([503, { error: "retry" }]);
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
