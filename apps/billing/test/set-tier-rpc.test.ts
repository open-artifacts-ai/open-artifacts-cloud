import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
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
import { BillingOperatorRpc, type Env } from "../src/index.js";

// BillingOperatorRpc.setTier (#66): an operator comps an install onto team,
// business or solo in billing's own D1. No Stripe call is ever made.

const db = (testEnv as unknown as { BILLING_DB: D1Database }).BILLING_DB;
const registry = (testEnv as unknown as { BROKER_REGISTRY: KVNamespace })
  .BROKER_REGISTRY;
const baseEnv = (): Env => ({
  BILLING_DB: db,
  BROKER_REGISTRY: registry,
  OA_ENV: "staging",
  STRIPE_SECRET_KEY: "sk_test_FAKEfakeFAKEfake0123456789",
  STRIPE_PRICE_TEAM: "price_team1",
  STRIPE_PRICE_BUSINESS: "price_business1",
  STRIPE_PRICE_SOLO_MONTHLY: "price_soloM1",
  STRIPE_PRICE_SOLO_YEARLY: "price_soloY1",
});
const A = "iabc123def45";
const B = "izzz999yyy88";
const NOW = Date.UTC(2026, 10, 10, 12, 0);

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

const rowOf = (install = A) =>
  db.prepare("SELECT * FROM tiers WHERE install_id = ?1").bind(install).first();
const seed = (o: {
  tier: string;
  status?: string;
  sub?: string | null;
  soloStatus?: string | null;
  graceUntil?: number | null;
  trialEndsAt?: number | null;
}) =>
  db
    .prepare(
      "INSERT INTO tiers (install_id, tier, status, stripe_customer_id, stripe_subscription_id, solo_status, grace_until, trial_ends_at, version, updated_at) VALUES (?1, ?2, ?3, 'cus_x', ?4, ?5, ?6, ?7, 3, 0)",
    )
    .bind(
      A,
      o.tier,
      o.status ?? "active",
      o.sub ?? null,
      o.soloStatus ?? null,
      o.graceUntil ?? null,
      o.trialEndsAt ?? null,
    )
    .run();
const set = (install: string, tier: string, e: Env = baseEnv()) =>
  new BillingOperatorRpc(createExecutionContext(), e).setTier(
    install,
    tier as "team",
  );

describe("setTier", () => {
  it("makes the row when there is none: tier, active, version 1, no previous", async () => {
    expect(await set(A, "team")).toEqual({
      ok: true,
      tier: "team",
      status: "active",
      version: 1,
      updatedAt: NOW,
      previous: null,
    });
    expect(await rowOf()).toMatchObject({
      tier: "team",
      status: "active",
      version: 1,
      updated_at: NOW,
    });
  });

  it("bumps version by one, sets updated_at, and reports the previous row", async () => {
    await seed({ tier: "team" });
    expect(await set(A, "business")).toEqual({
      ok: true,
      tier: "business",
      status: "active",
      version: 4,
      updatedAt: NOW,
      previous: { tier: "team", status: "active", version: 3 },
    });
    expect(await rowOf()).toMatchObject({
      tier: "business",
      version: 4,
      updated_at: NOW,
    });
  });

  it("accepts team and business, and a repeat bumps again", async () => {
    for (const [i, t] of ["team", "business", "team", "team"].entries()) {
      const r = await set(A, t);
      expect(r).toMatchObject({ ok: true, tier: t, version: i + 1 });
    }
  });

  it("revives a lapsed or past_due row and clears its grace and Solo-under-trial state", async () => {
    await seed({
      tier: "team",
      status: "past_due",
      graceUntil: NOW + 1000,
      soloStatus: "active",
    });
    expect(await set(A, "business")).toMatchObject({ ok: true });
    expect(await rowOf()).toMatchObject({
      tier: "business",
      status: "active",
      grace_until: null,
      solo_status: null,
    });
  });

  it("keeps trial_ends_at: the Business trial stays used up", async () => {
    await seed({ tier: "trial", trialEndsAt: NOW + 5000 });
    expect(await set(A, "team")).toMatchObject({ ok: true });
    expect((await rowOf())?.trial_ends_at).toBe(NOW + 5000);
  });

  it("leaves Stripe's own columns alone and calls no Stripe", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    await seed({ tier: "team", sub: null });
    await set(A, "business");
    expect(f).not.toHaveBeenCalled();
    expect(await rowOf()).toMatchObject({ stripe_customer_id: "cus_x" });
  });

  it("is refused while a live subscription holds the row, and nothing changes", async () => {
    for (const o of [
      { tier: "team", status: "active", sub: "sub_1" },
      { tier: "business", status: "past_due", sub: "sub_1" },
      { tier: "solo", status: "suspended", sub: "sub_1" },
      { tier: "trial", status: "active", sub: "sub_1", soloStatus: "active" },
    ]) {
      await db.prepare("DELETE FROM tiers").run();
      await seed(o);
      const before = await rowOf();
      expect(await set(A, "business"), JSON.stringify(o)).toEqual({
        ok: false,
        error: "subscription_active",
      });
      expect(await rowOf(), JSON.stringify(o)).toEqual(before);
    }
  });

  it("drops the dead subscription id, so the comp reads as not live: a second comp works", async () => {
    await seed({ tier: "team", status: "lapsed", sub: "sub_1" });
    expect(await set(A, "team")).toMatchObject({ ok: true });
    expect((await rowOf())?.stripe_subscription_id).toBeNull();
    expect(await set(A, "business")).toMatchObject({ ok: true, version: 5 });
  });

  it("is allowed when the stored subscription is no longer live", async () => {
    // lapsed: the subscription ended; a trial with no live Solo under it.
    await seed({ tier: "team", status: "lapsed", sub: "sub_1" });
    expect(await set(A, "business")).toMatchObject({ ok: true });
    await db.prepare("DELETE FROM tiers").run();
    await seed({ tier: "trial", sub: "sub_1", soloStatus: "lapsed" });
    expect(await set(A, "team")).toMatchObject({ ok: true });
  });

  it("refuses a tier outside team, business and solo (free, trial, junk) without writing", async () => {
    for (const t of ["solo", "free", "trial", "TEAM", "", "enterprise"])
      expect(await set(A, t), t).toEqual({ ok: false, error: "bad_tier" });
    expect(await set(A, undefined as unknown as string)).toEqual({
      ok: false,
      error: "bad_tier",
    });
    expect(await rowOf()).toBeNull();
  });

  it("refuses a malformed install id", async () => {
    for (const id of [
      "",
      "iabc123def4",
      "iabc123def456",
      "../x",
      "ABC123DEF456",
    ])
      expect(await set(id, "team"), id).toEqual({
        ok: false,
        error: "bad_install",
      });
    expect(await set(undefined as unknown as string, "team")).toEqual({
      ok: false,
      error: "bad_install",
    });
  });

  it("refuses an install the registry does not know, and writes no row", async () => {
    expect(await set(B, "team")).toEqual({
      ok: false,
      error: "unknown_install",
    });
    expect(await rowOf(B)).toBeNull();
  });

  it("answers unavailable on a D1 error, never throwing", async () => {
    const broken = {
      ...baseEnv(),
      BILLING_DB: {
        prepare: () => {
          throw new Error("D1_ERROR: secret detail");
        },
      } as unknown as D1Database,
    };
    expect(await set(A, "team", broken)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("is a named export with exactly constructor and setTier (every public method is callable over RPC)", () => {
    expect(
      Object.getOwnPropertyNames(BillingOperatorRpc.prototype).sort(),
    ).toEqual(["constructor", "setTier"]);
  });
});
