import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env as testEnv, exports } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { keyId, publicFromPkcs8 } from "@oa/auth-core";
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
import { BillingProvisionerRpc, type Env } from "../src/index.js";
import { isClockInstall, parseClockInstalls } from "../src/test-clock.js";

// Staging test clocks (M2 step 8). BillingProvisionerRpc.soloStart is the call into
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
function fakeStripe() {
  const calls: Call[] = [];
  let n = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const c: Call = {
      path: url.pathname,
      key: h.get("idempotency-key"),
      form: Object.fromEntries(new URLSearchParams(String(init?.body))),
    };
    calls.push(c);
    n++;
    if (c.path === "/v1/test_helpers/test_clocks")
      return Response.json({ id: `clock_fake${n}` });
    if (c.path === "/v1/customers")
      return Response.json({ id: `cus_fake${n}` });
    return Response.json({ id: `sub_fake${n}` });
  });
  return calls;
}
const rowOf = () =>
  db.prepare("SELECT * FROM tiers WHERE install_id = ?1").bind(A).first();
const start = (e: Env) =>
  new BillingProvisionerRpc(createExecutionContext(), e).soloStart(A);
const listed = (over: Partial<Env> = {}): Env => ({
  ...baseEnv(),
  STAGING_TEST_CLOCK_INSTALLS: A,
  ...over,
});

describe("parseClockInstalls (strict)", () => {
  it("accepts nothing, one id, or a comma list of exact ids", () => {
    expect(parseClockInstalls(undefined)).toEqual([]);
    expect(parseClockInstalls("")).toEqual([]);
    expect(parseClockInstalls(A)).toEqual([A]);
    expect(parseClockInstalls(`${A},${B}`)).toEqual([A, B]);
  });
  it("rejects spaces, empty entries, repeats, wrong shapes: the whole list", () => {
    for (const raw of [
      `${A} ,${B}`,
      ` ${A}`,
      `${A},`,
      `,${A}`,
      `${A},,${B}`,
      `${A},${A}`,
      "iabc123def4",
      "Iabc123def45",
      "*",
      `${A};${B}`,
    ])
      expect(parseClockInstalls(raw), raw).toBeNull();
  });
});

describe("isClockInstall (gating)", () => {
  it("is true only for a listed install on staging with a test key", () => {
    const e = { OA_ENV: "staging", STRIPE_SECRET_KEY: SECRET };
    expect(isClockInstall(e, A, A)).toBe(true);
    expect(isClockInstall(e, A, B)).toBe(false);
    expect(
      isClockInstall({ ...e, STRIPE_SECRET_KEY: "rk_test_FAKEfake0123" }, A, A),
    ).toBe(true);
  });
  it("is ignored (with one logged line) in prod or with a non-test key", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      isClockInstall({ OA_ENV: "prod", STRIPE_SECRET_KEY: SECRET }, A, A),
    ).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
    expect(
      isClockInstall(
        { OA_ENV: "staging", STRIPE_SECRET_KEY: "sk_live_x" },
        A,
        A,
      ),
    ).toBe(false);
    expect(isClockInstall({ OA_ENV: "staging" }, A, A)).toBe(false);
    expect(err).toHaveBeenCalledTimes(3);
  });
  it("is false for an empty list (no log) and a malformed one (ignored whole)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = { OA_ENV: "staging", STRIPE_SECRET_KEY: SECRET };
    expect(isClockInstall(e, "", A)).toBe(false);
    expect(isClockInstall(e, undefined, A)).toBe(false);
    expect(err).not.toHaveBeenCalled();
    expect(isClockInstall(e, `${A},bad`, A)).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
  });
});

describe("soloStart for a listed install", () => {
  it("makes the clock first (frozen now, named for the install), then the customer on it, and stores the clock id", async () => {
    const stripe = fakeStripe();
    const r = await start(listed());
    expect(r.ok).toBe(true);
    expect(stripe.map((c) => c.path)).toEqual([
      "/v1/test_helpers/test_clocks",
      "/v1/customers",
      "/v1/subscriptions",
    ]);
    expect(stripe[0]?.form).toEqual({
      frozen_time: String(Math.floor(NOW / 1000)),
      name: A,
    });
    expect(stripe[1]?.form.test_clock).toBe("clock_fake1");
    expect(await rowOf()).toMatchObject({
      stripe_test_clock_id: "clock_fake1",
      stripe_customer_id: "cus_fake2",
    });
  });

  it("reuses a stored clock on a retry: one clock per install", async () => {
    await db
      .prepare(
        "INSERT INTO tiers (install_id, tier, status, version, updated_at, stripe_test_clock_id) VALUES (?1, 'solo', 'active', 0, 0, 'clock_kept')",
      )
      .bind(A)
      .run();
    const stripe = fakeStripe();
    expect((await start(listed())).ok).toBe(true);
    expect(stripe.map((c) => c.path)).not.toContain(
      "/v1/test_helpers/test_clocks",
    );
    expect(stripe[0]?.form.test_clock).toBe("clock_kept");
  });

  it("refuses an existing customer that is not on a clock: no Stripe call, row unchanged", async () => {
    await db
      .prepare(
        "INSERT INTO tiers (install_id, tier, status, stripe_customer_id, version, updated_at) VALUES (?1, 'solo', 'active', 'cus_old', 0, 0)",
      )
      .bind(A)
      .run();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stripe = fakeStripe();
    expect(await start(listed())).toMatchObject({ ok: false });
    expect(stripe).toEqual([]);
    expect(await rowOf()).toMatchObject({
      stripe_customer_id: "cus_old",
      stripe_test_clock_id: null,
    });
  });

  it("keeps a customer already on a clock", async () => {
    await db
      .prepare(
        "INSERT INTO tiers (install_id, tier, status, stripe_customer_id, stripe_test_clock_id, version, updated_at) VALUES (?1, 'solo', 'active', 'cus_c', 'clock_c', 0, 0)",
      )
      .bind(A)
      .run();
    const stripe = fakeStripe();
    expect((await start(listed())).ok).toBe(true);
    expect(stripe.map((c) => c.path)).toEqual(["/v1/subscriptions"]);
  });
});

describe("soloStart where the list does not apply", () => {
  const plain = async (e: Env) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stripe = fakeStripe();
    expect((await start(e)).ok).toBe(true);
    expect(stripe.map((c) => c.path)).toEqual([
      "/v1/customers",
      "/v1/subscriptions",
    ]);
    expect(stripe[0]?.form.test_clock).toBeUndefined();
    expect(await rowOf()).toMatchObject({ stripe_test_clock_id: null });
  };
  it("an install not listed gets a plain customer", () =>
    plain(listed({ STAGING_TEST_CLOCK_INSTALLS: B })));
  it("prod ignores the var", () => plain(listed({ OA_ENV: "prod" })));
  it("a non-test key ignores the var (and billing-core refuses the key: no Stripe call at all)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stripe = fakeStripe();
    expect(
      await start(listed({ STRIPE_SECRET_KEY: "sk_live_FAKEfakeFAKE0123" })),
    ).toMatchObject({ ok: false });
    expect(stripe).toEqual([]);
  });
});
