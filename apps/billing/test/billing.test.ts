import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { keyId, publicFromPkcs8, signRequest } from "@oa/auth-core";
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
  TRIAL_MS,
} from "../src/index.js";

// The tier store's routes. Gate routes answer only over a binding (no
// cf-connecting-ip) and only for the install in x-oa-gate-install; every
// case also checks no other install's row is read or written. The POSTs also
// carry the install's Ed25519 signature (the auth broker's redeem scheme).

const db = (testEnv as unknown as { BILLING_DB: D1Database }).BILLING_DB;
const registry = (testEnv as unknown as { BROKER_REGISTRY: KVNamespace })
  .BROKER_REGISTRY;
const env = { BILLING_DB: db, BROKER_REGISTRY: registry } as Env;

beforeAll(async () => {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM tiers"),
    db.prepare("DELETE FROM usage"),
    db.prepare("DELETE FROM overage"),
    db.prepare("DELETE FROM stripe_events"),
  ]);
  clearRegistryCache();
  await register();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const A = "iabc123def45";
const B = "izzz999yyy88";
const NOW = Date.UTC(2026, 9, 29, 12, 0);
const ORIGIN = "https://billing.oa.internal";

type Row = {
  install: string;
  tier?: string;
  status?: string;
  trialEndsAt?: number | null;
  version?: number;
  /** A Stripe customer on the row (default true). */
  customer?: boolean;
};

async function seed(rows: Row[]) {
  await db.batch(
    rows.map((r) =>
      db
        .prepare(
          `INSERT INTO tiers (install_id, tier, status, trial_ends_at, stripe_customer_id, stripe_subscription_id, version, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)`,
        )
        .bind(
          r.install,
          r.tier ?? "solo",
          r.status ?? "active",
          r.trialEndsAt ?? null,
          r.customer === false ? null : `cus_${r.install}`,
          `sub_${r.install}`,
          r.version ?? 1,
        ),
    ),
  );
}

const rowOf = (install: string) =>
  db.prepare("SELECT * FROM tiers WHERE install_id = ?1").bind(install).first();
const usageOf = (install: string) =>
  db
    .prepare("SELECT * FROM usage WHERE install_id = ?1 ORDER BY month")
    .bind(install)
    .all()
    .then((r) => r.results);

/** A PKCS#8 Ed25519 private key from a fixed seed, base64url. */
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

/** The registry entries the auth broker reads: A and B, one key each. */
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

type Sign = {
  /** The key to sign with (default: the header install's). */
  key?: string;
  /** The path the signature covers (default: the request's). */
  path?: string;
  /** Sign this text instead of the body sent. */
  text?: string;
  /** Leave the request unsigned. */
  none?: boolean;
};

/**
 * A request as the gate sends it: the install header, no cf-connecting-ip.
 * A POST is signed as an install signs it: its object body gets `ts` (now)
 * unless it has one, and x-oa-kid/x-oa-sig cover the path and exact text.
 */
async function gated(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { "x-oa-gate-install": A },
  sign: Sign = {},
) {
  const text =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(
            typeof body === "object" && body !== null && !("ts" in body)
              ? { ...body, ts: Date.now() }
              : body,
          );
  const install = headers["x-oa-gate-install"] ?? A;
  const key = sign.key ?? KEYS[install] ?? KEYS[A];
  const sig: Record<string, string> =
    method === "POST" && text !== undefined && !sign.none && key
      ? {
          "x-oa-kid": await kidOf(key),
          "x-oa-sig": await signRequest(
            key,
            sign.path ?? path,
            await kidOf(key),
            sign.text ?? text,
          ),
        }
      : {};
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...sig,
      ...headers,
    },
    ...(text === undefined ? {} : { body: text }),
  });
}

const call = async (req: Request | Promise<Request>) =>
  billing.fetch((await req) as Parameters<typeof billing.fetch>[0], env);

const at = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
};

describe("gate routes answer only over a binding", () => {
  it("any request with cf-connecting-ip gets the plain 404, and reads or writes nothing", async () => {
    await seed([{ install: A }]);
    const before = await rowOf(A);
    for (const [m, p, b] of [
      ["GET", "/tier", undefined],
      ["GET", "/health", undefined],
      ["POST", "/trial/start", { install: A }],
      [
        "POST",
        "/usage",
        { install: A, month: "2026-10", creators: [], count: 0 },
      ],
    ] as [string, string, unknown][]) {
      const r = await call(
        gated(m, p, b, {
          "x-oa-gate-install": A,
          "cf-connecting-ip": "1.2.3.4",
        }),
      );
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("Not found");
    }
    expect(await rowOf(A)).toEqual(before);
    expect(await usageOf(A)).toEqual([]);
  });

  it("/health over a binding is ok, with or without an install header", async () => {
    for (const h of [{}, { "x-oa-gate-install": A }] as Record<
      string,
      string
    >[]) {
      const r = await call(gated("GET", "/health", undefined, h));
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
  });

  it("every other method or path is the plain 404", async () => {
    for (const [m, p] of [
      ["GET", "/"],
      ["GET", "/stripe/webhook"],
      ["POST", "/tier"],
      ["GET", "/trial/start"],
      ["GET", "/usage"],
      ["PUT", "/usage"],
      ["GET", "/tier/"],
      ["GET", "/Tier"],
      ["DELETE", "/tier"],
    ]) {
      const r = await call(gated(m as string, p as string));
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("Not found");
    }
  });
});

describe("the install id comes only from x-oa-gate-install", () => {
  it("no header or a malformed one is the plain 404", async () => {
    await seed([{ install: A }]);
    for (const h of [
      {},
      { "x-oa-gate-install": "" },
      { "x-oa-gate-install": A.toUpperCase() },
      { "x-oa-gate-install": `${A}x` },
      { "x-oa-gate-install": "../iabc123def4" },
    ] as Record<string, string>[]) {
      const r = await call(gated("GET", "/tier", undefined, h));
      expect(r.status).toBe(404);
    }
    expect((await rowOf(A))?.last_read_at).toBeNull();
  });

  it("a query or body naming another install never moves the read or write", async () => {
    at();
    await seed([{ install: A }, { install: B, tier: "team" }]);
    const r = await call(
      new Request(`${ORIGIN}/tier?install=${B}&install_id=${B}`, {
        headers: { "x-oa-gate-install": A },
      }),
    );
    expect(((await r.json()) as { tier: string }).tier).toBe("solo");
    expect((await rowOf(A))?.last_read_at).toBe(NOW);
    expect((await rowOf(B))?.last_read_at).toBeNull();

    // A body naming B is refused, and B is untouched.
    const t = await call(gated("POST", "/trial/start", { install: B }));
    expect(t.status).toBe(403);
    const u = await call(
      gated("POST", "/usage", {
        install: B,
        month: "2026-10",
        creators: ["c1"],
        count: 1,
      }),
    );
    expect(u.status).toBe(403);
    expect(await rowOf(B)).toMatchObject({ tier: "team", version: 1 });
    expect(await usageOf(B)).toEqual([]);
    expect(await usageOf(A)).toEqual([]);
  });
});

describe("the POSTs carry the gate install's signature", () => {
  const usage = { month: "2026-10", creators: ["u1"], count: 1 };
  const POSTS: [string, Record<string, unknown>][] = [
    ["/trial/start", { install: A }],
    ["/usage", { install: A, ...usage }],
  ];

  /** Nothing was written for A or B, and B's row is as seeded. */
  async function nothingWritten() {
    expect(await rowOf(A)).toMatchObject({ tier: "solo", version: 1 });
    expect(await rowOf(B)).toMatchObject({ tier: "team", version: 1 });
    expect(await usageOf(A)).toEqual([]);
    expect(await usageOf(B)).toEqual([]);
  }

  async function refused(req: Request | Promise<Request>) {
    const r = await call(req);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "bad_signature" });
  }

  beforeEach(async () => {
    await seed([{ install: A }, { install: B, tier: "team" }]);
  });

  it("a signed POST passes (the baseline for every refusal below)", async () => {
    at();
    expect(
      (await call(gated("POST", "/trial/start", { install: A }))).status,
    ).toBe(200);
    expect(
      (await call(gated("POST", "/usage", { install: A, ...usage }))).status,
    ).toBe(200);
    expect(await rowOf(A)).toMatchObject({ tier: "trial", version: 2 });
    expect(await usageOf(A)).toHaveLength(1);
  });

  it("no signature, or only half of one: 401, nothing written", async () => {
    for (const [path, body] of POSTS) {
      await refused(gated("POST", path, body, undefined, { none: true }));
      const full = await gated("POST", path, body);
      for (const drop of ["x-oa-kid", "x-oa-sig"]) {
        const h = new Headers(full.headers);
        h.delete(drop);
        await refused(
          new Request(full.url, {
            method: "POST",
            headers: h,
            body: await full.clone().text(),
          }),
        );
      }
    }
    await nothingWritten();
  });

  it("a bad signature: garbage, or one for another route, 401, nothing written", async () => {
    for (const [path, body] of POSTS) {
      const good = await gated("POST", path, body);
      const h = new Headers(good.headers);
      h.set("x-oa-sig", "A".repeat(86));
      await refused(
        new Request(good.url, {
          method: "POST",
          headers: h,
          body: await good.clone().text(),
        }),
      );
      // Signed for the other POST, or for the auth broker's redeem.
      for (const other of [
        path === "/usage" ? "/trial/start" : "/usage",
        "/google/redeem",
      ])
        await refused(gated("POST", path, body, undefined, { path: other }));
    }
    await nothingWritten();
  });

  it("a stale or missing ts: 401, nothing written", async () => {
    at();
    for (const [path, body] of POSTS)
      for (const ts of [NOW - 60_001, NOW + 60_001, "x", null, undefined]) {
        await refused(gated("POST", path, { ...body, ts }));
      }
    // At the edge of the window it still passes.
    expect(
      (
        await call(
          gated("POST", "/usage", { install: A, ...usage, ts: NOW - 60_000 }),
        )
      ).status,
    ).toBe(200);
    await db.prepare("DELETE FROM usage").run();
    await nothingWritten();
  });

  it("another install's kid and key: 401, nothing written (the kid is checked against the gate's install, never the body's)", async () => {
    for (const [path, body] of POSTS) {
      // B signs a body naming B, but the gate says A.
      await refused(
        gated("POST", path, { ...body, install: B }, undefined, {
          key: KEYS[B],
        }),
      );
      // B signs a body with no install at all.
      const { install: _, ...rest } = body;
      await refused(gated("POST", path, rest, undefined, { key: KEYS[B] }));
      // A key the registry doesn't know.
      await refused(gated("POST", path, body, undefined, { key: pk(9) }));
    }
    await nothingWritten();
  });

  it("an unknown or disabled install: 401, nothing written", async () => {
    const C = "iccc111ccc11";
    for (const [path, body] of POSTS)
      await refused(
        gated(
          "POST",
          path,
          { ...body, install: C },
          {
            "x-oa-gate-install": C,
          },
          { key: KEYS[A] },
        ),
      );
    const x = await publicFromPkcs8(KEYS[A] as string);
    await registry.put(
      `install:${A}`,
      JSON.stringify({
        installId: A,
        origin: "https://a.example.test",
        keys: [{ kid: await keyId(x), x }],
        disabled: true,
      }),
    );
    clearRegistryCache();
    for (const [path, body] of POSTS) await refused(gated("POST", path, body));
    expect(await rowOf(C)).toBeNull();
    await nothingWritten();
  });

  it("a body tampered with after signing: 401, nothing written", async () => {
    for (const [path, body] of POSTS) {
      const signedText = JSON.stringify({ ...body, ts: Date.now() });
      // The signature is over signedText; the body sent differs.
      const tampered =
        path === "/usage"
          ? JSON.stringify({
              ...body,
              creators: ["u1", "u2"],
              count: 2,
              ts: Date.now(),
            })
          : `${signedText} `;
      await refused(
        gated("POST", path, tampered, undefined, { text: signedText }),
      );
    }
    await nothingWritten();
  });

  it("GET /tier and GET /health need no signature", async () => {
    expect((await call(gated("GET", "/tier"))).status).toBe(200);
    expect((await call(gated("GET", "/health"))).status).toBe(200);
  });
});

describe("tiersOf matches GET /tier for an ended trial, and writes nothing (#2058)", () => {
  const cases: [string, string, string | null][] = [
    ["solo active", "active", "active"],
    ["solo past_due", "past_due", "active"],
    ["no solo subscription", "", "active"],
    ["suspended", "active", "suspended"],
  ];
  for (const [name, soloStatus, status] of cases)
    it(name, async () => {
      at();
      await seed([
        {
          install: A,
          tier: "trial",
          trialEndsAt: NOW - 1,
          status: status ?? "active",
        },
      ]);
      await db
        .prepare("UPDATE tiers SET solo_status = ?2 WHERE install_id = ?1")
        .bind(A, soloStatus === "" ? null : soloStatus)
        .run();
      const before = await rowOf(A);
      const rpc = new BillingOperatorRpc(createExecutionContext(), env);
      const r = await rpc.tiersOf([A]);
      expect(await rowOf(A)).toEqual(before);
      expect(before).toMatchObject({
        tier: "trial",
        version: 1,
        updated_at: 0,
      });
      const got = (await (await call(gated("GET", "/tier"))).json()) as {
        tier: string;
        status: string;
      };
      expect(r).toEqual({
        ok: true,
        tiers: { [A]: { tier: got.tier, status: got.status } },
      });
      expect(got.tier).toBe("solo");
    });
});

it("tiersOf leaves a team row with a past trial_ends_at as team, as GET /tier does (#2058)", async () => {
  at();
  await seed([{ install: A, tier: "team", trialEndsAt: NOW - 1 }]);
  const before = await rowOf(A);
  const rpc = new BillingOperatorRpc(createExecutionContext(), env);
  const r = await rpc.tiersOf([A]);
  expect(await rowOf(A)).toEqual(before);
  const got = (await (await call(gated("GET", "/tier"))).json()) as {
    tier: string;
    status: string;
  };
  expect(got.tier).toBe("team");
  expect(r).toEqual({
    ok: true,
    tiers: { [A]: { tier: "team", status: "active" } },
  });
});

describe("GET /tier", () => {
  it("returns the install's own row without Stripe ids, and records last_read_at", async () => {
    at();
    await seed([
      { install: A, tier: "trial", trialEndsAt: NOW + 5, version: 3 },
      { install: B, tier: "business" },
    ]);
    const r = await call(gated("GET", "/tier"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({
      tier: "trial",
      status: "active",
      trialEndsAt: NOW + 5,
      graceUntil: null,
      soloTrialEndsAt: null,
      hasCustomer: true,
      yearlyTeamBusiness: false,
      soloCheckedOut: false,
      overageDue: null,
      version: 3,
      asOf: NOW,
    });
    expect(JSON.stringify(body)).not.toMatch(/cus_|sub_/);
    expect(await rowOf(A)).toMatchObject({ last_read_at: NOW, version: 3 });
    expect((await rowOf(B))?.last_read_at).toBeNull();
  });

  it("hasCustomer is false without a Stripe customer, true with one, and never the id", async () => {
    at();
    await seed([{ install: A, customer: false }, { install: B }]);
    const a = await (await call(gated("GET", "/tier"))).json();
    expect(a).toMatchObject({ hasCustomer: false });
    expect(JSON.stringify(a)).not.toMatch(/cus_/);
    const b = await (
      await call(gated("GET", "/tier", undefined, { "x-oa-gate-install": B }))
    ).json();
    expect(b).toMatchObject({ hasCustomer: true });
  });

  it("soloCheckedOut is true only for a row with a card on file from Checkout (solo_checked_out = 1); false without a row or a column value", async () => {
    at();
    await seed([{ install: A }, { install: B }]);
    await db
      .prepare("UPDATE tiers SET solo_checked_out = 1 WHERE install_id = ?1")
      .bind(A)
      .run();
    const ask = async (install: string) =>
      (
        await call(
          gated("GET", "/tier", undefined, { "x-oa-gate-install": install }),
        )
      ).json();
    expect(await ask(A)).toMatchObject({ soloCheckedOut: true });
    expect(await ask(B)).toMatchObject({ soloCheckedOut: false });
  });

  it("yearlyTeamBusiness is true only when both yearly price ids are set", async () => {
    at();
    await seed([{ install: A }]);
    const ask = async (e: Env) =>
      (
        await billing.fetch(
          (await gated("GET", "/tier")) as Parameters<typeof billing.fetch>[0],
          e,
        )
      ).json();
    const both = {
      ...env,
      STRIPE_PRICE_TEAM_YEARLY: "price_t",
      STRIPE_PRICE_BUSINESS_YEARLY: "price_b",
    } as Env;
    expect(await ask(both)).toMatchObject({ yearlyTeamBusiness: true });
    expect(
      await ask({ ...both, STRIPE_PRICE_TEAM_YEARLY: "" } as Env),
    ).toMatchObject({ yearlyTeamBusiness: false });
    expect(
      await ask({ ...both, STRIPE_PRICE_BUSINESS_YEARLY: "" } as Env),
    ).toMatchObject({ yearlyTeamBusiness: false });
    for (const bad of [" ", "bogus"]) {
      expect(
        await ask({ ...both, STRIPE_PRICE_TEAM_YEARLY: bad } as Env),
      ).toMatchObject({ yearlyTeamBusiness: false });
      expect(
        await ask({ ...both, STRIPE_PRICE_BUSINESS_YEARLY: bad } as Env),
      ).toMatchObject({ yearlyTeamBusiness: false });
    }
    expect(await ask(env)).toMatchObject({ yearlyTeamBusiness: false });
  });

  it("a missing row is solo/active at version 0, and nothing is written", async () => {
    at();
    const r = await call(gated("GET", "/tier"));
    expect(await r.json()).toEqual({
      tier: "solo",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      soloTrialEndsAt: null,
      hasCustomer: false,
      yearlyTeamBusiness: false,
      soloCheckedOut: false,
      overageDue: null,
      version: 0,
      asOf: NOW,
    });
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM tiers").first())?.n,
    ).toBe(0);
  });
});

describe("trial/start and usage take the body's own fields only, like /checkout (L4)", () => {
  const usage = { month: "2026-10", creators: ["u1"], count: 1 };
  it("an extra field or a non-integer ts is 400 bad_body, nothing written", async () => {
    at();
    await seed([{ install: A }]);
    for (const [path, body] of [
      ["/trial/start", { install: A, plan: "team" }],
      ["/trial/start", { install: A, ts: Date.now() + 0.5 }],
      ["/usage", { install: A, ...usage, extra: 1 }],
      ["/usage", { install: A, ...usage, ts: Date.now() + 0.5 }],
    ] as [string, Record<string, unknown>][]) {
      const r = await call(gated("POST", path, body));
      expect([r.status, await r.json()]).toEqual([400, { error: "bad_body" }]);
    }
    expect(await rowOf(A)).toMatchObject({ tier: "solo", version: 1 });
    expect(await usageOf(A)).toEqual([]);
    // The exact fields still work.
    expect(
      (await call(gated("POST", "/usage", { install: A, ...usage }))).status,
    ).toBe(200);
  });
});

describe("POST /trial/start", () => {
  it("the answer carries hasCustomer for a row with no Stripe customer", async () => {
    at();
    await seed([{ install: A, customer: false }]);
    const r = await call(gated("POST", "/trial/start", { install: A }));
    expect(await r.json()).toMatchObject({ tier: "trial", hasCustomer: false });
  });

  it("from solo/active: trial for 30 days, version + 1; a second call changes nothing", async () => {
    at();
    await seed([{ install: A, version: 4 }, { install: B }]);
    const r = await call(gated("POST", "/trial/start", { install: A }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      tier: "trial",
      status: "active",
      trialEndsAt: NOW + TRIAL_MS,
      graceUntil: null,
      soloTrialEndsAt: null,
      hasCustomer: true,
      yearlyTeamBusiness: false,
      soloCheckedOut: false,
      overageDue: null,
      version: 5,
      asOf: NOW,
    });
    expect(TRIAL_MS).toBe(30 * 86_400_000);
    vi.setSystemTime(NOW + 1000);
    const again = await call(gated("POST", "/trial/start", { install: A }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      tier: "trial",
      trialEndsAt: NOW + TRIAL_MS,
      version: 5,
    });
    expect(await rowOf(B)).toMatchObject({ tier: "solo", version: 1 });
  });

  it("a row made before Solo (tier free) starts the trial too, once", async () => {
    at();
    await seed([{ install: A, tier: "free", version: 4 }]);
    const r = await call(gated("POST", "/trial/start", { install: A }));
    expect(await r.json()).toMatchObject({
      tier: "trial",
      trialEndsAt: NOW + TRIAL_MS,
      version: 5,
    });
  });

  it("never twice: back on solo after a trial, it doesn't start again", async () => {
    for (const tier of ["solo", "free"]) {
      await db.prepare("DELETE FROM tiers").run();
      await seed([{ install: A, tier, trialEndsAt: NOW - 1, version: 7 }]);
      const r = await call(gated("POST", "/trial/start", { install: A }));
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({
        tier,
        version: 7,
        trialEndsAt: NOW - 1,
      });
    }
  });

  it("any other state: 200 with the unchanged row", async () => {
    for (const [tier, status] of [
      ["team", "active"],
      ["business", "past_due"],
      ["solo", "lapsed"],
      ["solo", "past_due"],
      ["solo", "suspended"],
      ["free", "lapsed"],
      ["free", "suspended"],
      ["trial", "active"],
    ]) {
      await db.prepare("DELETE FROM tiers").run();
      await seed([{ install: A, tier, status, version: 2 }]);
      const before = await rowOf(A);
      const r = await call(gated("POST", "/trial/start", { install: A }));
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ tier, status, version: 2 });
      expect(await rowOf(A)).toEqual(before);
    }
  });

  it("no row (the free/active default): the trial starts and the row is created, once", async () => {
    at();
    const r = await call(gated("POST", "/trial/start", { install: A }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      tier: "trial",
      status: "active",
      trialEndsAt: NOW + TRIAL_MS,
      version: 1,
    });
    expect(await rowOf(A)).toMatchObject({ tier: "trial", version: 1 });
    const again = await call(gated("POST", "/trial/start", { install: A }));
    expect(await again.json()).toMatchObject({ tier: "trial", version: 1 });
    expect(await rowOf(B)).toBeNull();
  });

  it("concurrent starts bump the version once", async () => {
    await seed([{ install: A }]);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        call(gated("POST", "/trial/start", { install: A })),
      ),
    );
    expect(await rowOf(A)).toMatchObject({ tier: "trial", version: 2 });
  });

  it("a body that isn't a JSON object is 400", async () => {
    await seed([{ install: A }]);
    for (const b of ["", "[]", "null", "{"]) {
      const r = await call(gated("POST", "/trial/start", b));
      expect(r.status).toBe(400);
    }
    expect(await rowOf(A)).toMatchObject({ tier: "solo", version: 1 });
  });
});

describe("POST /usage", () => {
  const ok = { install: A, month: "2026-10", creators: ["u1", "u2"], count: 2 };

  it("stores the month's list and count; a second report for the month replaces it", async () => {
    at();
    const r = await call(gated("POST", "/usage", ok));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, month: "2026-10", count: 2 });
    vi.setSystemTime(NOW + 1);
    await call(gated("POST", "/usage", { ...ok, creators: ["u3"], count: 1 }));
    await call(gated("POST", "/usage", { ...ok, month: "2026-11" }));
    expect(await usageOf(A)).toEqual([
      {
        install_id: A,
        month: "2026-10",
        creators_json: '["u3"]',
        count: 1,
        received_at: NOW + 1,
        applied_quantity: null,
        applied_at: null,
        apply_outcome: null,
        retried_at: null,
      },
      {
        install_id: A,
        month: "2026-11",
        creators_json: '["u1","u2"]',
        count: 2,
        received_at: NOW + 1,
        applied_quantity: null,
        applied_at: null,
        apply_outcome: null,
        retried_at: null,
      },
    ]);
    expect(await usageOf(B)).toEqual([]);
  });

  it("the install comes from the header even when the body omits it", async () => {
    const { install: _, ...rest } = ok;
    expect((await call(gated("POST", "/usage", rest))).status).toBe(200);
    expect((await usageOf(A)).length).toBe(1);
  });

  it("accepts MAX_CREATORS, refuses one more", async () => {
    const many = Array.from({ length: MAX_CREATORS + 1 }, (_, i) => `c${i}`);
    const fits = many.slice(0, MAX_CREATORS);
    expect(
      (
        await call(
          gated("POST", "/usage", {
            ...ok,
            creators: fits,
            count: fits.length,
          }),
        )
      ).status,
    ).toBe(200);
    const r = await call(
      gated("POST", "/usage", {
        ...ok,
        month: "2026-09",
        creators: many,
        count: many.length,
      }),
    );
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "bad_creators" });
  });

  it("refuses a bad month, bad creators or a count that isn't the list's length", async () => {
    const cases: [unknown, string][] = [
      [{ ...ok, month: "2026-13" }, "bad_month"],
      [{ ...ok, month: "2026-1" }, "bad_month"],
      [{ ...ok, month: 202610 }, "bad_month"],
      [{ ...ok, month: undefined }, "bad_month"],
      [{ ...ok, creators: "u1" }, "bad_creators"],
      [{ ...ok, creators: ["u1", 2], count: 2 }, "bad_creators"],
      [{ ...ok, creators: ["u1", "u1"], count: 2 }, "bad_creators"],
      [{ ...ok, creators: ["a b"], count: 1 }, "bad_creators"],
      [{ ...ok, creators: [""], count: 1 }, "bad_creators"],
      [{ ...ok, count: 3 }, "bad_count"],
      [{ ...ok, count: "2" }, "bad_count"],
      [{ ...ok, count: undefined }, "bad_count"],
    ];
    for (const [body, error] of cases) {
      const r = await call(gated("POST", "/usage", body));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error });
    }
    const text = await call(
      new Request(`${ORIGIN}/usage`, {
        method: "POST",
        headers: { "x-oa-gate-install": A, "content-type": "text/plain" },
        body: JSON.stringify(ok),
      }),
    );
    expect(text.status).toBe(400);
    expect(await usageOf(A)).toEqual([]);
  });
});

describe("logs", () => {
  it("carry fixed categories and the install id only: no body, header or URL", async () => {
    await seed([{ install: A }]);
    const lines: string[] = [];
    for (const k of ["log", "warn", "error"] as const)
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
    await call(gated("GET", "/tier"));
    // Refused for the extra field: nothing logged, least of all the value.
    await call(gated("POST", "/trial/start", { install: A, secret: "s3cret" }));
    await call(gated("POST", "/trial/start", { install: A }));
    await call(
      gated("POST", "/usage", {
        install: A,
        month: "2026-10",
        creators: ["creator-x"],
        count: 1,
      }),
    );
    expect(lines).toEqual([
      `billing tier row ${A}`,
      `billing trial started ${A}`,
      `billing usage ${A}`,
      // A closed month on a trial row: stored, its quantity skipped (#2123).
      `billing usage quantity trial ${A}`,
    ]);
  });

  it("a D1 error is a 503 with a fixed line", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const broken = {
      BILLING_DB: {
        prepare: () => {
          throw new Error("D1_ERROR: secret detail");
        },
      },
    } as unknown as Env;
    const r = await billing.fetch(
      (await gated("GET", "/tier")) as Parameters<typeof billing.fetch>[0],
      broken,
    );
    expect(r.status).toBe(503);
    expect(lines).toEqual([`billing db_error ${A}`]);
  });
});

describe("scheduled: prune stripe_events (#1479)", () => {
  const DAY = 86_400_000;
  const run = (time: number, e: Env = env) =>
    billing.scheduled(
      { scheduledTime: time, cron: "17 3 * * *", noRetry() {} },
      e,
    );
  const ids = async () =>
    (
      await db
        .prepare("SELECT event_id FROM stripe_events ORDER BY event_id")
        .all<{ event_id: string }>()
    ).results.map((r) => r.event_id);

  it("drops ids older than 30 days at the cron's scheduled time, keeps the rest, touches nothing else", async () => {
    await seed([{ install: A, tier: "team", version: 3 }]);
    await db.batch(
      [
        ["evt_old", NOW - 31 * DAY],
        ["evt_keep", NOW - 29 * DAY],
        ["evt_now", NOW],
      ].map(([id, at]) =>
        db
          .prepare(
            "INSERT INTO stripe_events (event_id, received_at) VALUES (?, ?)",
          )
          .bind(id, at),
      ),
    );
    const before = await rowOf(A);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    await run(NOW);
    expect(await ids()).toEqual(["evt_keep", "evt_now"]);
    expect(await rowOf(A)).toEqual(before);
    expect(lines).toEqual(["billing prune stripe_events 1"]);
  });

  it("a D1 failure is logged by category only and does not throw", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const broken = {
      ...env,
      BILLING_DB: {
        prepare: () => {
          throw new Error("D1_ERROR: secret detail");
        },
      },
    } as unknown as Env;
    await expect(run(NOW, broken)).resolves.toBeUndefined();
    expect(lines).toEqual(["billing retry db_error", "billing prune db_error"]);
  });
});

describe("soloTrialEndsAt (#1568)", () => {
  it("GET /tier and /trial/start carry the Solo trial's end beside the Business trial's, never merged", async () => {
    at();
    await seed([{ install: A, tier: "solo", version: 2 }]);
    await db
      .prepare("UPDATE tiers SET solo_trial_ends_at = ?1 WHERE install_id = ?2")
      .bind(NOW + 30 * 86_400_000, A)
      .run();
    const r = await call(gated("GET", "/tier"));
    expect(await r.json()).toMatchObject({
      tier: "solo",
      trialEndsAt: null,
      soloTrialEndsAt: NOW + 30 * 86_400_000,
    });
    // The first invite starts the Business trial; both ends are reported.
    const t = await call(gated("POST", "/trial/start", { install: A }));
    expect(await t.json()).toMatchObject({
      tier: "trial",
      trialEndsAt: NOW + TRIAL_MS,
      soloTrialEndsAt: NOW + 30 * 86_400_000,
    });
  });
});

describe("the Business trial over a Solo subscription (#1568)", () => {
  const DAY = 86_400_000;
  const trialRow = async (o: {
    ends: number;
    solo: string | null;
    grace?: number | null;
    sub?: boolean;
    status?: string;
  }) => {
    await db.prepare("DELETE FROM tiers").run();
    await seed([
      {
        install: A,
        tier: "trial",
        status: o.status ?? "active",
        trialEndsAt: o.ends,
        version: 4,
      },
    ]);
    await db
      .prepare(
        "UPDATE tiers SET solo_status = ?1, solo_grace_until = ?2, solo_trial_ends_at = ?3, stripe_subscription_id = ?4 WHERE install_id = ?5",
      )
      .bind(
        o.solo,
        o.grace ?? null,
        NOW - 20 * DAY,
        o.sub === false ? null : `sub_${A}`,
        A,
      )
      .run();
  };
  const read = async () =>
    (await call(gated("GET", "/tier"))).json() as Promise<
      Record<string, unknown>
    >;

  it("starting the trial from a Solo with a live subscription snapshots its state; with none, nothing", async () => {
    at();
    await seed([
      { install: A, tier: "solo" },
      { install: B, tier: "solo" },
    ]);
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = 'sub_A1', solo_trial_ends_at = ?2 WHERE install_id = ?1",
      )
      .bind(A, NOW + 30 * 86_400_000)
      .run();
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = NULL WHERE install_id = ?1",
      )
      .bind(B)
      .run();
    await call(gated("POST", "/trial/start", { install: A }));
    expect(await rowOf(A)).toMatchObject({
      tier: "trial",
      solo_status: "active",
      trial_ends_at: NOW + TRIAL_MS,
    });
    await call(
      gated("POST", "/trial/start", { install: B }, { "x-oa-gate-install": B }),
    );
    expect(await rowOf(B)).toMatchObject({ tier: "trial", solo_status: null });
  });

  it("while the trial runs, the answer is the trial's, whatever the Solo subscription does", async () => {
    at();
    await trialRow({ ends: NOW + DAY, solo: "lapsed" });
    expect(await read()).toMatchObject({
      tier: "trial",
      status: "active",
      trialEndsAt: NOW + DAY,
      version: 4,
    });
  });

  it("once trial_ends_at has passed: solo/active if the Solo subscription is alive, lapsed if not or never there; version bumped once; the end stays set", async () => {
    at();
    for (const [solo, grace, sub, want] of [
      ["active", null, true, { status: "active", graceUntil: null }],
      [
        "past_due",
        NOW + 3 * DAY,
        true,
        { status: "past_due", graceUntil: NOW + 3 * DAY },
      ],
      ["lapsed", null, true, { status: "lapsed", graceUntil: null }],
      [null, null, false, { status: "lapsed", graceUntil: null }],
    ] as const) {
      await trialRow({ ends: NOW - 1000, solo, grace, sub });
      const a = await read();
      expect(a, String(solo)).toMatchObject({
        tier: "solo",
        ...want,
        trialEndsAt: NOW - 1000,
        version: 5,
      });
      // Reading again changes nothing: one bump for the passage of time.
      const b = await read();
      expect(b).toMatchObject({
        tier: "solo",
        ...want,
        trialEndsAt: NOW - 1000,
        version: 5,
      });
      expect(await rowOf(A)).toMatchObject({
        tier: "solo",
        trial_ends_at: NOW - 1000,
        version: 5,
      });
    }
  });

  it("the boundary: at trial_ends_at it is over; a millisecond before it is not", async () => {
    at();
    await trialRow({ ends: NOW + 1, solo: "active" });
    expect(await read()).toMatchObject({ tier: "trial", version: 4 });
    await trialRow({ ends: NOW, solo: "active" });
    expect(await read()).toMatchObject({
      tier: "solo",
      status: "active",
      version: 5,
    });
  });

  it("the Business trial never restarts, and /trial/start answers the ended trial's row", async () => {
    at();
    await trialRow({ ends: NOW - 1000, solo: "active" });
    const t = await call(gated("POST", "/trial/start", { install: A }));
    expect(await t.json()).toMatchObject({
      tier: "solo",
      status: "active",
      trialEndsAt: NOW - 1000,
      version: 5,
    });
    const again = await call(gated("POST", "/trial/start", { install: A }));
    expect(await again.json()).toMatchObject({
      tier: "solo",
      trialEndsAt: NOW - 1000,
      version: 5,
    });
  });

  it("a suspended row keeps its suspension through the passage of time", async () => {
    at();
    await trialRow({ ends: NOW - 1000, solo: "active", status: "suspended" });
    expect(await read()).toMatchObject({ tier: "solo", status: "suspended" });
  });

  it("another install's row and a team row are never touched by a read", async () => {
    at();
    await trialRow({ ends: NOW - 1000, solo: "active" });
    await seed([{ install: B, tier: "team", version: 9 }]);
    await read();
    expect(await rowOf(B)).toMatchObject({ tier: "team", version: 9 });
  });
});

describe("soloTrialEndsAt is answered only while it is in the future (#1568)", () => {
  it("a Solo trial end in the past is null; one still ahead is the date", async () => {
    at();
    await seed([{ install: A, tier: "solo" }]);
    const set = (v: number) =>
      db
        .prepare(
          "UPDATE tiers SET solo_trial_ends_at = ?1 WHERE install_id = ?2",
        )
        .bind(v, A)
        .run();
    await set(NOW - 1);
    expect(await (await call(gated("GET", "/tier"))).json()).toMatchObject({
      soloTrialEndsAt: null,
    });
    await set(NOW);
    expect(await (await call(gated("GET", "/tier"))).json()).toMatchObject({
      soloTrialEndsAt: null,
    });
    await set(NOW + 1);
    expect(await (await call(gated("GET", "/tier"))).json()).toMatchObject({
      soloTrialEndsAt: NOW + 1,
    });
    // The column keeps the history: only the answer hides it.
    await set(NOW - 5);
    await call(gated("GET", "/tier"));
    expect(await rowOf(A)).toMatchObject({ solo_trial_ends_at: NOW - 5 });
  });
});

describe("the Business trial snapshots a Solo only when it is known live (#1568)", () => {
  it("a subscription id with no live evidence (an unfinished first payment: no solo_trial_ends_at) snapshots nothing", async () => {
    at();
    await seed([{ install: A, tier: "solo" }]);
    await db
      .prepare(
        "UPDATE tiers SET stripe_subscription_id = 'sub_pending1', solo_trial_ends_at = NULL WHERE install_id = ?1",
      )
      .bind(A)
      .run();
    await call(gated("POST", "/trial/start", { install: A }));
    expect(await rowOf(A)).toMatchObject({ tier: "trial", solo_status: null });
  });
});

describe("overageDue in the tier answer (#2246)", () => {
  const ask = async () => {
    const r = await billing.fetch(
      new Request("https://billing.oa.internal/tier", {
        headers: { "x-oa-gate-install": A },
      }) as Parameters<typeof billing.fetch>[0],
      env,
    );
    return (await r.json()) as Record<string, unknown>;
  };
  const put = (
    month: string,
    o: {
      failed?: number | null;
      paid?: number | null;
      voided?: number | null;
      due?: number | null;
      install?: string;
    },
  ) =>
    db
      .prepare(
        "INSERT INTO overage (install_id, month, seats, creators, quantity, unit_amount, invoice_id, outcome, failed_at, paid_at, voided_at, amount_due, payment_attempts, created_at, updated_at) VALUES (?1, ?2, 3, 5, 2, 1000, 'in_x', 'invoiced', ?3, ?4, ?5, ?6, 1, 0, 0)",
      )
      .bind(
        o.install ?? A,
        month,
        o.failed ?? null,
        o.paid ?? null,
        o.voided ?? null,
        o.due ?? null,
      )
      .run();

  it("is null with no failure; failed unpaid invoices show the total of their own amounts and the months, the plan untouched; paid or voided clears one", async () => {
    await seed([{ install: A, tier: "team" }]);
    expect(await ask()).toMatchObject({ overageDue: null });
    await put("2026-09", { failed: 5000, due: 2160 });
    await put("2026-10", { failed: 5000 });
    expect(await ask()).toMatchObject({
      tier: "team",
      status: "active",
      graceUntil: null,
      // 2026-09 uses its invoice's amount_due; 2026-10 falls back to 2 x $10.
      overageDue: { amountCents: 4160, months: ["2026-09", "2026-10"] },
    });
    await db
      .prepare("UPDATE overage SET paid_at = 6000 WHERE month = '2026-09'")
      .run();
    expect(await ask()).toMatchObject({
      overageDue: { amountCents: 2000, months: ["2026-10"] },
    });
    await db
      .prepare("UPDATE overage SET voided_at = 6000 WHERE month = '2026-10'")
      .run();
    expect(await ask()).toMatchObject({ tier: "team", overageDue: null });
  });

  it("another install's failed invoice is never shown", async () => {
    await seed([
      { install: A, tier: "team" },
      { install: B, tier: "team" },
    ]);
    await put("2026-10", { failed: 5000, install: B });
    expect(await ask()).toMatchObject({ overageDue: null });
  });
});
