import { keyId, publicFromPkcs8, signRequest } from "@oa/auth-core";
import { clearRegistryCache } from "@oa/broker-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ADDS_PER_HOUR,
  CHECKS_PER_MIN,
  mintToken,
  OPTOUT_ADD_ACTION,
  optout,
  storedHash,
  TOKEN_TTL_MS,
} from "../src/routes/optouts.js";
import { db, fakeEnv, pkcs8, resetDb, seedInstall } from "./fakes.js";

// Open-artifacts#2652: the hosted opt-out list, platform side. Requests are
// what dispatch's LoginGate forwards (install in x-oa-gate-install, body
// signed with an install registry key).

const KEY = pkcs8(41);
const OTHER_KEY = pkcs8(42);
const ORIGIN = "https://login.oa.internal";
const NOW = 1_800_000_000_000;
const STORE = "s".repeat(32);
const TOKEN_KEY = "t".repeat(32);
const H1 = "a".repeat(64);
const H1B = "b".repeat(64);

async function registry(keys: Record<string, string>) {
  const entries = new Map<string, unknown>();
  for (const [id, key] of Object.entries(keys)) {
    const x = await publicFromPkcs8(key);
    entries.set(`install:${id}`, {
      installId: id,
      origin: `https://${id}.example.test`,
      keys: [{ kid: await keyId(x), x }],
    });
  }
  return {
    get: async (k: string) => entries.get(k) ?? null,
  } as unknown as KVNamespace;
}

let n = 0;
const nonce = () => `nonce-${String(++n).padStart(12, "0")}`;

async function req(
  path: string,
  b: Record<string, unknown> | string,
  o: { install: string; key?: string; headers?: Record<string, string> },
): Promise<Request> {
  const text = typeof b === "string" ? b : JSON.stringify(b);
  const key = o.key ?? KEY;
  const kid = await keyId(await publicFromPkcs8(key));
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oa-gate-install": o.install,
      "x-oa-kid": kid,
      "x-oa-sig": await signRequest(key, path, kid, text),
      ...o.headers,
    },
    body: text,
  });
}

let id: string;
let otherId: string;
async function world(over: Record<string, unknown> = {}) {
  id = (await seedInstall({ vars: {} })).id;
  otherId = (await seedInstall({ vars: {} })).id;
  return fakeEnv({
    OPTOUT_LIST: "1",
    OPTOUT_STORE_KEY: STORE,
    OPTOUT_TOKEN_KEY: TOKEN_KEY,
    BROKER_REGISTRY: await registry({ [id]: KEY, [otherId]: OTHER_KEY }),
    ...over,
  }).env;
}
const call = (r: Request, e: Awaited<ReturnType<typeof world>>, now = NOW) =>
  optout(r, e, now);
const post = (
  path: string,
  e: Awaited<ReturnType<typeof world>>,
  b: Record<string, unknown>,
  o: { install?: string; key?: string; now?: number } = {},
) =>
  req(
    path,
    { ts: o.now ?? NOW, nonce: nonce(), ...b },
    {
      install: o.install ?? id,
      key: o.key,
    },
  ).then((r) => call(r, e, o.now ?? NOW));
const mint = async (e: Awaited<ReturnType<typeof world>>, h1 = H1) =>
  ((await (await post("/optouts/mint", e, { h1 })).json()) as { token: string })
    .token;
const rows = () =>
  db
    .prepare("SELECT * FROM email_optouts")
    .all<Record<string, unknown>>()
    .then((r) => r.results);

beforeEach(async () => {
  await resetDb();
  clearRegistryCache();
});

describe("check, mint and add", () => {
  it("checks one h1 to one bit, and add (with a minted token) flips it", async () => {
    const e = await world();
    const c1 = await post("/optouts/check", e, { h1: H1 });
    expect(await c1.json()).toEqual({ optedOut: false });
    const token = await mint(e);
    expect((await post("/optouts/add", e, { h1: H1, token })).status).toBe(204);
    expect(await (await post("/optouts/check", e, { h1: H1 })).json()).toEqual({
      optedOut: true,
    });
    expect(await (await post("/optouts/check", e, { h1: H1B })).json()).toEqual(
      { optedOut: false },
    );
    // Another install sees the same hosted-wide list.
    expect(
      await (
        await post(
          "/optouts/check",
          e,
          { h1: H1 },
          { install: otherId, key: OTHER_KEY },
        )
      ).json(),
    ).toEqual({ optedOut: true });
  });

  it("add is idempotent: first writer wins, one audit row, install id and hash prefix only", async () => {
    const e = await world();
    const token = await mint(e);
    expect((await post("/optouts/add", e, { h1: H1, token })).status).toBe(204);
    const tokenB = await mintToken(TOKEN_KEY, otherId, H1, NOW);
    expect(
      (
        await post(
          "/optouts/add",
          e,
          { h1: H1, token: tokenB },
          { install: otherId, key: OTHER_KEY },
        )
      ).status,
    ).toBe(204);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]?.first_install).toBe(id);
    expect(r[0]?.source).toBe("recipient");
    const audit = await db
      .prepare(
        "SELECT * FROM hosted_audit WHERE action = ?1 AND install_id IN (?2, ?3)",
      )
      .bind(OPTOUT_ADD_ACTION, id, otherId)
      .all<{ install_id: string; detail: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]?.install_id).toBe(id);
    expect(audit.results[0]?.detail).not.toContain(H1);
  });

  it("stores h2 = HMAC(store key, h1): never the address, never h1", async () => {
    const e = await world();
    const token = await mint(e);
    await post("/optouts/add", e, { h1: H1, token });
    const r = await rows();
    expect(r[0]?.addr_hash).toBe(await storedHash(STORE, H1));
    expect(r[0]?.addr_hash).not.toBe(H1);
    const all = JSON.stringify(
      (await db.prepare("SELECT * FROM hosted_audit").all()).results,
    );
    expect(all).not.toContain(H1);
    expect(JSON.stringify(r)).not.toContain(H1);
  });
});

describe("the token", () => {
  it("refuses a forged, other-h1, other-install, expired or malformed token", async () => {
    const e = await world();
    const forged = await mintToken("x".repeat(32), id, H1, NOW);
    const otherH1 = await mintToken(TOKEN_KEY, id, H1B, NOW);
    const otherInstall = await mintToken(TOKEN_KEY, otherId, H1, NOW);
    const expired = await mintToken(TOKEN_KEY, id, H1, NOW - TOKEN_TTL_MS - 1);
    for (const token of [forged, otherH1, otherInstall, expired]) {
      const r = await post("/optouts/add", e, { h1: H1, token });
      expect(r.status).toBe(403);
    }
    expect(
      (await post("/optouts/add", e, { h1: H1, token: "garbage" })).status,
    ).toBe(400);
    expect(await rows()).toHaveLength(0);
  });
});

describe("strict bodies and trust path", () => {
  it("refuses extra fields, a plain address, and a batch", async () => {
    const e = await world();
    for (const b of [
      { h1: H1, extra: 1 },
      { h1: "me@example.com" },
      { addresses: ["a@b.co"] },
      { h1: [H1, H1B] },
      { address: "a@b.co" },
    ])
      expect((await post("/optouts/check", e, b)).status).toBe(400);
    expect(
      (await post("/optouts/mint", e, { h1: H1, token: "x" })).status,
    ).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses another install's key and a replayed nonce", async () => {
    const e = await world();
    const r = await post("/optouts/check", e, { h1: H1 }, { key: OTHER_KEY });
    expect(r.status).toBe(401);
    const q = await req(
      "/optouts/check",
      { ts: NOW, nonce: nonce(), h1: H1 },
      { install: id },
    );
    const again = q.clone() as unknown as Request;
    expect((await call(q, e)).status).toBe(200);
    expect((await call(again, e)).status).toBe(409);
  });

  it("is the plain 404 for the internet, a wrong path or method, and when off", async () => {
    const e = await world();
    const inet = await req(
      "/optouts/check",
      { ts: NOW, nonce: nonce(), h1: H1 },
      { install: id, headers: { "cf-connecting-ip": "1.2.3.4" } },
    );
    expect((await call(inet, e)).status).toBe(404);
    const other = await req("/optouts/remove", { h1: H1 }, { install: id });
    expect((await call(other, e)).status).toBe(404);
    const off = await world({ OPTOUT_LIST: "0" });
    const r = await post("/optouts/check", off, { h1: H1 });
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("Not found");
  });

  it("503s when a key is unset", async () => {
    const e = await world({ OPTOUT_STORE_KEY: undefined });
    expect((await post("/optouts/check", e, { h1: H1 })).status).toBe(503);
  });
});

describe("rate limits and the spike hook", () => {
  it("limits checks per install per minute and adds per hour", async () => {
    const e = await world();
    await db
      .prepare(
        "INSERT INTO rate_counters (key, window_start, count) VALUES (?1, ?2, ?3)",
      )
      .bind(`optout:check:${id}`, NOW - (NOW % 60_000), CHECKS_PER_MIN)
      .run();
    expect((await post("/optouts/check", e, { h1: H1 })).status).toBe(429);
    // Another install is unaffected.
    expect(
      (
        await post(
          "/optouts/check",
          e,
          { h1: H1 },
          { install: otherId, key: OTHER_KEY },
        )
      ).status,
    ).toBe(200);
    await db
      .prepare(
        "INSERT INTO rate_counters (key, window_start, count) VALUES (?1, ?2, ?3)",
      )
      .bind(`optout:add:${id}`, NOW - (NOW % 3_600_000), ADDS_PER_HOUR)
      .run();
    const token = await mintToken(TOKEN_KEY, id, H1, NOW);
    expect((await post("/optouts/add", e, { h1: H1, token })).status).toBe(429);
  });

  it("counts checks per install per day and logs optout_check_spike at the threshold", async () => {
    const e = await world({ OPTOUT_CHECK_SPIKE: "2" });
    const logs: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void logs.push(a);
    try {
      for (let i = 0; i < 3; i++) await post("/optouts/check", e, { h1: H1 });
    } finally {
      console.warn = orig;
    }
    expect(logs).toEqual([["optout_check_spike", id, 2]]);
    const day = await db
      .prepare("SELECT count FROM rate_counters WHERE key = ?1")
      .bind(`optout:checkday:${id}`)
      .first<number>("count");
    expect(day).toBe(3);
  });
});
