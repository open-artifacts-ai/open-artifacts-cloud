import { createHash } from "node:crypto";
import { keyId, publicFromPkcs8, signRequest } from "@oa/auth-core";
import { clearRegistryCache } from "@oa/broker-core";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/app.js";
import {
  ADDS_PER_DAY,
  CHECKS_PER_DAY,
  CHECKS_PER_MIN,
  MINTS_PER_DAY,
  mintToken,
  OPTOUT_ADD_ACTION,
  OPTOUT_UNDO_ACTION,
  optout,
  storedHash,
  TOKEN_TTL_MS,
  UNSUB_CSP,
  UNSUB_PER_IP_HOUR,
  UNSUB_STYLE,
  UNSUB_STYLE_HASH,
} from "../src/routes/optouts.js";
import {
  ctx,
  db,
  fakeEnv,
  pkcs8,
  resetDb,
  SIGNUP,
  seedInstall,
} from "./fakes.js";

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

const unsub = (
  e: Awaited<ReturnType<typeof world>>,
  token: string,
  o: {
    method?: string;
    form?: boolean;
    ip?: string;
    now?: number;
    action?: string;
  } = {},
) => {
  const method = o.method ?? "POST";
  const url = `${SIGNUP}/unsubscribe${o.form ? "" : `?t=${token}`}`;
  return handle(
    new Request(url, {
      method,
      headers: {
        "cf-connecting-ip": o.ip ?? "203.0.113.7",
        ...(o.form
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body:
        method === "POST"
          ? o.form
            ? `t=${token}${o.action ? `&action=${o.action}` : ""}`
            : "List-Unsubscribe=One-Click"
          : undefined,
    }),
    e,
    ctx(),
  );
};

describe("check, mint and the public unsubscribe", () => {
  it("check is one h1, one bit; a one-click POST with the token only flips it for every install", async () => {
    const e = await world();
    expect(await (await post("/optouts/check", e, { h1: H1 })).json()).toEqual({
      optedOut: false,
    });
    const token = await mintToken(TOKEN_KEY, id, H1, Date.now());
    const r = await unsub(e, token);
    expect(r.status).toBe(200);
    expect(await (await post("/optouts/check", e, { h1: H1 })).json()).toEqual({
      optedOut: true,
    });
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
    expect(await (await post("/optouts/check", e, { h1: H1B })).json()).toEqual(
      { optedOut: false },
    );
  });

  it("mint returns a token that redeems; a form-body POST works too", async () => {
    const e = await world();
    const token = await mint(e);
    expect(token).toBeTruthy();
    const mintedNow = Date.now();
    void mintedNow;
    expect((await unsub(e, token, { form: true })).status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it("GET changes nothing, shows the confirm button, and sends the headers", async () => {
    const e = await world();
    const token = await mintToken(TOKEN_KEY, id, H1, Date.now());
    const r = await unsub(e, token, { method: "GET" });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Stop emails from all of Open Artifacts");
    expect(await rows()).toHaveLength(0);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("content-security-policy")).toBe(UNSUB_CSP);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(UNSUB_STYLE_HASH).toBe(
      `sha256-${createHash("sha256").update(UNSUB_STYLE).digest("base64")}`,
    );
  });

  it("a repeat POST answers the same page, adds nothing, one audit row with the minting install and an h2 prefix only", async () => {
    const e = await world();
    const token = await mintToken(TOKEN_KEY, id, H1, Date.now());
    const first = await unsub(e, token);
    const again = await unsub(e, token);
    expect(await again.text()).toBe(await first.text());
    expect(again.headers.get("cache-control")).toBe("no-store");
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]?.first_install).toBe(id);
    expect(r[0]?.source).toBe("recipient");
    const audit = await db
      .prepare(
        "SELECT * FROM hosted_audit WHERE action = ?1 AND install_id = ?2",
      )
      .bind(OPTOUT_ADD_ACTION, id)
      .all<{ detail: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]?.detail).toBe(
      JSON.stringify({
        hash: (await storedHash(STORE, H1)).slice(0, 8),
        scope: "all",
      }),
    );
  });

  it("stores h2 = HMAC(store key, h1): never the address, never h1", async () => {
    const e = await world();
    await unsub(e, await mintToken(TOKEN_KEY, id, H1, Date.now()));
    const r = await rows();
    expect(r[0]?.addr_hash).toBe(await storedHash(STORE, H1));
    expect(r[0]?.addr_hash).not.toBe(H1);
    const all = JSON.stringify(
      (await db.prepare("SELECT * FROM hosted_audit").all()).results,
    );
    expect(all).not.toContain(H1);
    expect(JSON.stringify(r)).not.toContain(H1);
  });

  it("is a plain 400 with no detail for a forged, expired, malformed or missing token", async () => {
    const e = await world();
    const now = Date.now();
    const forged = await mintToken("x".repeat(32), id, H1, now);
    const expired = await mintToken(
      TOKEN_KEY,
      id,
      H1,
      now - TOKEN_TTL_MS - 1000,
    );
    for (const token of [forged, expired, "garbage", ""]) {
      for (const method of ["GET", "POST"]) {
        const r = await unsub(e, token, { method });
        expect(r.status).toBe(400);
        expect(await r.text()).toBe("Bad request");
      }
    }
    expect(await rows()).toHaveLength(0);
  });

  it("the token lives a year", () => {
    expect(TOKEN_TTL_MS).toBe(365 * 86_400_000);
  });

  it("per minting install: a warn line at the threshold; past 200 the opt-out is still stored and that install's mint answers 429", async () => {
    const e = await world({ OPTOUT_ADD_SPIKE: "2" });
    const logs: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void logs.push(a);
    try {
      for (let i = 0; i < 2; i++)
        await unsub(
          e,
          await mintToken(TOKEN_KEY, id, i ? H1B : H1, Date.now()),
        );
      expect(logs).toEqual([["optout_add_spike", id, 2]]);
      expect(await rows()).toHaveLength(2);
      await db
        .prepare("UPDATE rate_counters SET count = ?2 WHERE key = ?1")
        .bind(`optout:addday:${id}`, ADDS_PER_DAY)
        .run();
      // At the cap, mint still works; one more redemption goes past it.
      const real = { now: Date.now() };
      expect((await post("/optouts/mint", e, { h1: H1 }, real)).status).toBe(
        200,
      );
      const h3 = "c".repeat(64);
      const r = await unsub(e, await mintToken(TOKEN_KEY, id, h3, Date.now()));
      expect(r.status).toBe(200);
      expect(await rows()).toHaveLength(2);
      // The over-cap one is install-scoped: true for the minting install, false for another.
      const h3h2 = await storedHash(STORE, h3);
      expect(
        await db
          .prepare(
            "SELECT install_id FROM email_optouts_install WHERE addr_hash = ?1",
          )
          .bind(h3h2)
          .all(),
      ).toMatchObject({ results: [{ install_id: id }] });
      expect(
        await db
          .prepare("SELECT 1 FROM email_optouts WHERE addr_hash = ?1")
          .bind(h3h2)
          .first(),
      ).toBeNull();
      expect(
        await (await post("/optouts/check", e, { h1: h3 }, real)).json(),
      ).toEqual({ optedOut: true });
      expect(
        await (
          await post(
            "/optouts/check",
            e,
            { h1: h3 },
            { ...real, install: otherId, key: OTHER_KEY },
          )
        ).json(),
      ).toEqual({ optedOut: false });
      // Under-cap ones are 'all': true for everyone.
      expect(
        await (
          await post(
            "/optouts/check",
            e,
            { h1: H1 },
            { ...real, install: otherId, key: OTHER_KEY },
          )
        ).json(),
      ).toEqual({ optedOut: true });
      expect(logs).toContainEqual(["optout_scoped", id, ADDS_PER_DAY + 1]);
      const blocked = await post("/optouts/mint", e, { h1: H1 }, real);
      expect(await blocked.json()).toEqual({ error: "mint_blocked" });
      expect(blocked.status).toBe(429);
      expect(logs.at(-1)).toEqual([
        "optout_mint_blocked",
        id,
        ADDS_PER_DAY + 1,
      ]);
      // Another install still mints.
      expect(
        (
          await post(
            "/optouts/mint",
            e,
            { h1: H1 },
            { install: otherId, key: OTHER_KEY, ...real },
          )
        ).status,
      ).toBe(200);
    } finally {
      console.warn = orig;
    }
  });

  it("valid tokens from one IP beyond the per-IP limit are all stored; invalid ones are IP-limited", async () => {
    const e = await world();
    const hs = Array.from({ length: UNSUB_PER_IP_HOUR + 5 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    for (const h of hs) {
      const r = await unsub(e, await mintToken(TOKEN_KEY, id, h, Date.now()));
      expect(r.status).toBe(200);
    }
    expect(await rows()).toHaveLength(hs.length);
    // (Same install: under its cap of 200.)
    let last = 0;
    for (let i = 0; i <= UNSUB_PER_IP_HOUR; i++)
      last = (await unsub(e, "garbage")).status;
    expect(last).toBe(429);
    // A valid token from that IP is still answered.
    expect(
      (await unsub(e, await mintToken(TOKEN_KEY, id, H1, Date.now()))).status,
    ).toBe(200);
    // Another IP's invalid token is a plain 400.
    expect((await unsub(e, "garbage", { ip: "198.51.100.9" })).status).toBe(
      400,
    );
  });

  const overCap = async (e: Awaited<ReturnType<typeof world>>, who: string) => {
    await db
      .prepare(
        "INSERT INTO rate_counters (key, window_start, count) VALUES (?1, ?2, ?3) ON CONFLICT (key, window_start) DO UPDATE SET count = ?3",
      )
      .bind(
        `optout:addday:${who}`,
        Date.now() - (Date.now() % 86_400_000),
        ADDS_PER_DAY,
      )
      .run();
    return who;
  };
  const scoped = (h2: string) =>
    db
      .prepare(
        "SELECT install_id FROM email_optouts_install WHERE addr_hash = ?1 ORDER BY install_id",
      )
      .bind(h2)
      .all<{ install_id: string }>()
      .then((r) => r.results.map((x) => x.install_id));
  const real = () => ({ now: Date.now() });

  it("two installs' install-scoped rows for one address coexist; a body-supplied install id is ignored", async () => {
    const e = await world();
    await overCap(e, id);
    await overCap(e, otherId);
    const h2 = await storedHash(STORE, H1);
    await unsub(e, await mintToken(TOKEN_KEY, id, H1, Date.now()));
    await unsub(e, await mintToken(TOKEN_KEY, otherId, H1, Date.now()));
    expect(await scoped(h2)).toEqual([id, otherId].sort());
    expect(await rows()).toHaveLength(0);
    // check is by the gate's install; a body naming another install is a strict-body 400.
    const bodyId = await post(
      "/optouts/check",
      e,
      { h1: H1, install: otherId },
      real(),
    );
    expect(bodyId.status).toBe(400);
  });

  it("a later under-cap add widens to all, and all is never narrowed", async () => {
    const e = await world();
    const h2 = await storedHash(STORE, H1);
    await overCap(e, id);
    await unsub(e, await mintToken(TOKEN_KEY, id, H1, Date.now()));
    expect(await scoped(h2)).toEqual([id]);
    // Another install, under its cap, redeems the same address: widened.
    await unsub(e, await mintToken(TOKEN_KEY, otherId, H1, Date.now()));
    expect(await rows()).toHaveLength(1);
    expect(await scoped(h2)).toEqual([]);
    expect(
      await (
        await post(
          "/optouts/check",
          e,
          { h1: H1 },
          { ...real(), install: otherId, key: OTHER_KEY },
        )
      ).json(),
    ).toEqual({ optedOut: true });
    // The first install, now over its cap again, never narrows the all row.
    await unsub(e, await mintToken(TOKEN_KEY, id, H1, Date.now()));
    expect(await rows()).toHaveLength(1);
    expect(await scoped(h2)).toEqual([]);
  });

  it("the documented operator clear widens a batch to all", async () => {
    const e = await world();
    await overCap(e, id);
    const h2 = await storedHash(STORE, H1);
    await unsub(e, await mintToken(TOKEN_KEY, id, H1, Date.now()));
    expect(await rows()).toHaveLength(0);
    // The operator SQL from docs/ops/hosted.md.
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO email_optouts (addr_hash, source, first_install, created_at) SELECT addr_hash, 'recipient', install_id, created_at FROM email_optouts_install WHERE install_id = ?1",
        )
        .bind(id),
      db
        .prepare("DELETE FROM email_optouts_install WHERE install_id = ?1")
        .bind(id),
    ]);
    expect(await rows()).toHaveLength(1);
    expect(
      await (
        await post(
          "/optouts/check",
          e,
          { h1: H1 },
          { ...real(), install: otherId, key: OTHER_KEY },
        )
      ).json(),
    ).toEqual({ optedOut: true });
    void h2;
  });

  it("is the plain 404 when OPTOUT_LIST is off, and add is gone from the gate", async () => {
    const off = await world({ OPTOUT_LIST: "0" });
    const token = await mintToken(TOKEN_KEY, id, H1, Date.now());
    expect((await unsub(off, token)).status).toBe(404);
    const e = await world();
    const add = await req(
      "/optouts/add",
      { ts: NOW, nonce: nonce(), h1: H1, token },
      { install: id },
    );
    expect((await call(add, e)).status).toBe(404);
  });
});

describe("recipient undo (#2665): only the link that added it", () => {
  const checkOf = async (e: Awaited<ReturnType<typeof world>>, h1 = H1) =>
    (
      (await (await post("/optouts/check", e, { h1 })).json()) as {
        optedOut: boolean;
      }
    ).optedOut;
  const undoAudit = () =>
    db
      // hosted_audit outlives resetDb: this world's installs only.
      .prepare(
        "SELECT * FROM hosted_audit WHERE action = ?1 AND install_id IN (?2, ?3)",
      )
      .bind(OPTOUT_UNDO_ACTION, id, otherId)
      .all<{ detail: string; install_id: string }>()
      .then((r) => r.results);

  it("the done page offers Undo; Undo removes the opt-out, audits a hash prefix, and offers to stop again", async () => {
    const e = await world();
    const token = await mintToken(TOKEN_KEY, id, H1, Date.now());
    const done = await (await unsub(e, token, { form: true })).text();
    expect(done).toContain('name="action" value="undo"');
    expect(await checkOf(e)).toBe(true);
    const r = await unsub(e, token, { form: true, action: "undo" });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("again");
    expect(text).toContain("Stop emails from all of Open Artifacts");
    expect(await rows()).toHaveLength(0);
    expect(await checkOf(e)).toBe(false);
    const a = await undoAudit();
    expect(a).toHaveLength(1);
    expect(a[0]?.install_id).toBe(id);
    expect(a[0]?.detail).toBe(
      JSON.stringify({ hash: (await storedHash(STORE, H1)).slice(0, 8) }),
    );
    expect(JSON.stringify(a)).not.toContain(H1);
    // A second Undo changes nothing and audits nothing more.
    await unsub(e, token, { form: true, action: "undo" });
    expect(await undoAudit()).toHaveLength(1);
    // Stop again works, and can be undone again.
    await unsub(e, token, { form: true });
    expect(await checkOf(e)).toBe(true);
  });

  it("a token minted later, by any install, can't undo an opt-out it didn't add", async () => {
    const e = await world();
    const first = await mintToken(TOKEN_KEY, id, H1, Date.now());
    await unsub(e, first);
    for (const [inst, at] of [
      [id, Date.now() + 1],
      [otherId, Date.now() + 2],
    ] as const) {
      const later = await mintToken(TOKEN_KEY, inst, H1, at);
      // Its POST adds nothing (already listed) and gets no Undo.
      expect(
        await (await unsub(e, later, { form: true })).text(),
      ).not.toContain('value="undo"');
      const r = await (
        await unsub(e, later, { form: true, action: "undo" })
      ).text();
      expect(r).toContain("You are unsubscribed");
      expect(r).not.toContain('value="undo"');
    }
    expect(await rows()).toHaveLength(1);
    expect(await checkOf(e)).toBe(true);
    expect(await undoAudit()).toHaveLength(0);
  });

  it("never removes a bounce or complaint row, or another address's", async () => {
    const e = await world();
    const token = await mintToken(TOKEN_KEY, id, H1, Date.now());
    const h2 = await storedHash(STORE, H1);
    const { undoKey } = await import("../src/routes/optouts.js");
    await db
      .prepare(
        "INSERT INTO email_optouts (addr_hash, source, first_install, created_at, undo_key) VALUES (?1, 'bounce', NULL, 1, ?2)",
      )
      .bind(h2, await undoKey(STORE, token))
      .run();
    await unsub(e, await mintToken(TOKEN_KEY, id, H1B, Date.now()));
    await unsub(e, token, { form: true, action: "undo" });
    expect((await rows()).map((r) => r.source).sort()).toEqual([
      "bounce",
      "recipient",
    ]);
    expect(await undoAudit()).toHaveLength(0);
  });

  it("an install-scoped opt-out (over the cap) is undone by its own link too", async () => {
    const e = await world();
    // One redemption makes the day's counter; then it is set to the cap.
    await unsub(e, await mintToken(TOKEN_KEY, id, H1B, Date.now()));
    await db
      .prepare("UPDATE rate_counters SET count = ?2 WHERE key = ?1")
      .bind(`optout:addday:${id}`, ADDS_PER_DAY)
      .run();
    const token = await mintToken(TOKEN_KEY, id, H1, Date.now());
    await unsub(e, token);
    const h2 = await storedHash(STORE, H1);
    const scoped = () =>
      db
        .prepare("SELECT * FROM email_optouts_install WHERE addr_hash = ?1")
        .bind(h2)
        .all()
        .then((r) => r.results);
    expect(await scoped()).toHaveLength(1);
    await unsub(e, token, { form: true, action: "undo" });
    expect(await scoped()).toHaveLength(0);
    expect(await undoAudit()).toHaveLength(1);
  });

  it("GET never writes: a later visit shows the done page with Undo, ?action=undo included", async () => {
    const e = await world();
    const token = await mintToken(TOKEN_KEY, id, H1, Date.now());
    expect(await (await unsub(e, token, { method: "GET" })).text()).toContain(
      "<h1>Unsubscribe</h1>",
    );
    await unsub(e, token);
    const later = await (await unsub(e, token, { method: "GET" })).text();
    expect(later).toContain("You are unsubscribed");
    expect(later).toContain('value="undo"');
    const r = await handle(
      new Request(`${SIGNUP}/unsubscribe?t=${token}&action=undo`, {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }),
      e,
      ctx(),
    );
    expect(r.status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it("a one-click POST (query token) never undoes, whatever its body says", async () => {
    const e = await world();
    const token = await mintToken(TOKEN_KEY, id, H1, Date.now());
    await unsub(e, token);
    await handle(
      new Request(`${SIGNUP}/unsubscribe?t=${token}`, {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.7",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "action=undo",
      }),
      e,
      ctx(),
    );
    expect(await rows()).toHaveLength(1);
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
    expect((await post("/optouts/check", e, { h1: [H1, H1B] })).status).toBe(
      400,
    );
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
  it("mint is capped at 150 per install per day", async () => {
    const e = await world();
    await db
      .prepare(
        "INSERT INTO rate_counters (key, window_start, count) VALUES (?1, ?2, ?3)",
      )
      .bind(`optout:mint:${id}`, NOW - (NOW % 86_400_000), MINTS_PER_DAY)
      .run();
    const r = await post("/optouts/mint", e, { h1: H1 });
    expect(r.status).toBe(429);
    expect(
      (
        await post(
          "/optouts/mint",
          e,
          { h1: H1 },
          { install: otherId, key: OTHER_KEY },
        )
      ).status,
    ).toBe(200);
  });

  it("limits checks per install per minute", async () => {
    const e = await world();
    await db
      .prepare(
        "INSERT INTO rate_counters (key, window_start, count) VALUES (?1, ?2, ?3)",
      )
      .bind(`optout:check:${id}`, NOW - (NOW % 60_000), CHECKS_PER_MIN)
      .run();
    expect((await post("/optouts/check", e, { h1: H1 })).status).toBe(429);
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
  });

  const seedCount = (key: string, ms: number, count: number) =>
    db
      .prepare(
        "INSERT INTO rate_counters (key, window_start, count) VALUES (?1, ?2, ?3)",
      )
      .bind(key, NOW - (NOW % ms), count)
      .run();
  const warns = async (f: () => Promise<unknown>) => {
    const logs: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void logs.push(a);
    try {
      await f();
    } finally {
      console.warn = orig;
    }
    return logs;
  };

  it("checks: warn line at the threshold, hard daily cap of 1000 (429)", async () => {
    const e = await world({ OPTOUT_CHECK_SPIKE: "2" });
    const logs = await warns(async () => {
      for (let i = 0; i < 3; i++) await post("/optouts/check", e, { h1: H1 });
    });
    expect(logs).toEqual([["optout_check_spike", id, 2]]);
    await seedCount(`optout:checkday:${id}`, 86_400_000, CHECKS_PER_DAY).catch(
      () =>
        db
          .prepare("UPDATE rate_counters SET count = ?2 WHERE key = ?1")
          .bind(`optout:checkday:${id}`, CHECKS_PER_DAY)
          .run(),
    );
    expect((await post("/optouts/check", e, { h1: H1 })).status).toBe(429);
  });
});
