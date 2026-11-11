import { brokerNonce } from "@oa/auth-core";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handle as appHandle } from "../src/app.js";
import { csrfToken } from "../src/auth/csrf.js";
import { BROKER_GOOGLE_CLIENT_ID } from "../src/auth/google.js";
import type { SigninDeps } from "../src/auth/signin.js";
import {
  SIGNUP_COOKIE,
  SIGNUP_FLOW_COOKIE,
} from "../src/auth/signup-session.js";
import type { Env } from "../src/env.js";
import { admission, gateOf, isAllowed } from "../src/signup/gate.js";
import { NOTE_MAX } from "../src/signup/waitlist.js";
import { platformDb } from "./db.js";
import { APP, ctx, db, fakeEnv, insert, resetDb, SIGNUP } from "./fakes.js";

// SIGNUPS_ENABLED=invite (#2096): the allow list, the gate at create, the
// signed-in status and the waitlist join.

const NOW = 1_800_000_000_000;
const CID = BROKER_GOOGLE_CLIENT_ID.staging;
const IP = { "cf-connecting-ip": "192.0.2.10" };

let key: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  key = kp.privateKey;
  const pub = (await exportJWK(kp.publicKey)) as JWK;
  jwks = createLocalJWKSet({ keys: [{ ...pub, kid: "k1", alg: "RS256" }] });
});
beforeEach(async () => {
  await platformDb();
  await resetDb();
});

const allow = (...entries: string[]) =>
  Promise.all(
    entries.map((entry) =>
      insert("signup_allowlist", { entry, added_by: "t", added_at: 1 }),
    ),
  );

const deps = (): Partial<SigninDeps> => ({ now: () => NOW, jwks });
let idToken: () => Promise<string>;
const env = (over: Partial<Env> = {}) =>
  fakeEnv({
    SIGNUPS_ENABLED: "invite",
    AUTH_BROKER: {
      fetch: async () => Response.json({ id_token: await idToken() }),
    } as unknown as Fetcher,
    ...over,
  });
type E = ReturnType<typeof fakeEnv>;

const call = (e: E, url: string, init: RequestInit = {}) => {
  const h = new Headers(init.headers);
  for (const [k, v] of Object.entries(IP)) if (!h.has(k)) h.set(k, v);
  return appHandle(
    new Request(url, { ...init, headers: h }),
    e.env,
    ctx(),
    deps(),
  );
};

const mint = (claims: Record<string, unknown>) =>
  new SignJWT({
    iss: "https://accounts.google.com",
    aud: CID,
    sub: "g-100",
    email: "ana@acme.test",
    email_verified: true,
    hd: "acme.test",
    iat: NOW / 1000,
    exp: NOW / 1000 + 3600,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .sign(key);

const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? null;
const val = (c: string | null) => c?.split(";")[0]?.split("=")[1] ?? "";

async function signIn(e: E, claims: Record<string, unknown> = {}) {
  const s = await call(e, `${SIGNUP}/auth/start`);
  const loc = new URL(s.headers.get("location") ?? "");
  idToken = async () =>
    mint({
      nonce: await brokerNonce(
        "i00000signup",
        loc.searchParams.get("nonce") ?? "",
      ),
      ...claims,
    });
  const res = await call(
    e,
    `${SIGNUP}/auth/callback/google?code=C&state=${loc.searchParams.get("state")}&bstate=BS`,
    {
      headers: {
        cookie: `${SIGNUP_FLOW_COOKIE}=${val(cookieOf(s, SIGNUP_FLOW_COOKIE))}`,
      },
    },
  );
  return { sid: val(cookieOf(res, SIGNUP_COOKIE)) };
}

const csrfOf = (e: E, sid: string) => csrfToken(e.env, `signup\n${sid}`);

const create = async (e: E, sid: string) =>
  call(e, `${SIGNUP}/api/v1/installs`, {
    method: "POST",
    headers: {
      cookie: `${SIGNUP_COOKIE}=${sid}`,
      origin: SIGNUP,
      "content-type": "application/json",
      "x-csrf-token": await csrfOf(e, sid),
    },
    body: JSON.stringify({
      requestId: "su-0123456789abcdef0123",
      slug: "acme",
      turnstile: "tok",
    }),
  });

const status = async (e: E, sid: string) =>
  (await (
    await call(e, `${SIGNUP}/api/v1/signup`, {
      headers: { cookie: `${SIGNUP_COOKIE}=${sid}` },
    })
  ).json()) as { stage: string; gate?: string };

const WAITLIST = `${SIGNUP}/api/v1/signup/waitlist`;
const join = async (
  e: E,
  sid: string,
  body?: unknown,
  h: Record<string, string | null> = {},
) => {
  const headers: Record<string, string> = {
    cookie: `${SIGNUP_COOKIE}=${sid}`,
    origin: SIGNUP,
    "content-type": "application/json",
    "x-csrf-token": await csrfOf(e, sid),
  };
  for (const [k, v] of Object.entries(h))
    if (v === null) delete headers[k];
    else headers[k] = v;
  return call(e, WAITLIST, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};
const rows = () =>
  db.prepare("SELECT * FROM signup_waitlist").all<Record<string, unknown>>();
const code = async (r: Response) =>
  (
    (await r.json()) as {
      error: { code: string; details?: { reason?: string } };
    }
  ).error;

describe("isAllowed", () => {
  it("an exact email, case-insensitively", async () => {
    await allow("ana@acme.test");
    expect(await isAllowed(db, "ana@acme.test", true)).toBe(true);
    expect(await isAllowed(db, "  Ana@ACME.test ", true)).toBe(true);
    expect(await isAllowed(db, "bo@acme.test", true)).toBe(false);
  });

  it("a @domain entry admits that exact domain, case-insensitively", async () => {
    await allow("@acme.com");
    expect(await isAllowed(db, "bo@acme.com", true)).toBe(true);
    expect(await isAllowed(db, "BO@Acme.COM", true)).toBe(true);
  });

  it("a stored email entry is not a domain and a domain entry is not an email", async () => {
    await allow("ana@acme.test", "@other.test");
    expect(await isAllowed(db, "bo@acme.test", true)).toBe(false);
    expect(await isAllowed(db, "@other.test", true)).toBe(false);
    expect(await isAllowed(db, "other.test", true)).toBe(false);
  });

  it("look-alike domains are refused", async () => {
    await allow("@acme.com");
    for (const e of [
      "x@evil-acme.com",
      "x@acme.com.evil.com",
      "x@mail.acme.com",
      "x@acme.co",
      "x@acme.com@evil.com",
      "acme.com@evil.com",
      "x@xacme.com",
    ])
      expect(await isAllowed(db, e, true), e).toBe(false);
  });

  it("an unverified email, a missing one and a malformed one are refused", async () => {
    await allow("ana@acme.test", "@acme.com");
    expect(await isAllowed(db, "ana@acme.test", false)).toBe(false);
    expect(await isAllowed(db, "bo@acme.com", false)).toBe(false);
    expect(await isAllowed(db, null, true)).toBe(false);
    expect(await isAllowed(db, undefined, true)).toBe(false);
    expect(await isAllowed(db, "", true)).toBe(false);
    expect(await isAllowed(db, "@acme.com", true)).toBe(false);
    expect(await isAllowed(db, "bo@", true)).toBe(false);
  });
});

describe("admission by mode", () => {
  const user = (sub: string, email: string) =>
    ({
      kind: "user",
      actorKey: `user:${sub}`,
      rateKey: `user:${sub}`,
      label: email,
      scopes: [],
      sub,
      email,
    }) as const;
  const at = (
    mode: Env["SIGNUPS_ENABLED"],
    oa: "staging" | "prod" = "staging",
  ) => fakeEnv({ SIGNUPS_ENABLED: mode, OA_ENV: oa }).env;

  it("false is closed for everyone, listed or test user", async () => {
    await allow("ana@acme.test");
    const e = at("false");
    expect(await admission(e, user("g1", "ana@acme.test"))).toBe("closed");
    expect(await admission(e, user("rl-test-a", "t@x.test"))).toBe("closed");
  });

  it("true admits everyone", async () => {
    expect(await admission(at("true"), user("g1", "x@y.test"))).toBe(
      "admitted",
    );
  });

  it("test-users admits staging test users only; the allow list is ignored", async () => {
    await allow("ana@acme.test");
    const e = at("test-users");
    expect(await admission(e, user("rl-test-a", "t@x.test"))).toBe("admitted");
    expect(await admission(e, user("g1", "ana@acme.test"))).toBe("closed");
    expect(
      await admission(at("test-users", "prod"), user("rl-test-a", "t@x.test")),
    ).toBe("closed");
  });

  it("invite admits the allow list and staging test users; everyone else is not_invited", async () => {
    await allow("ana@acme.test", "@corp.test");
    const e = at("invite");
    expect(await admission(e, user("g1", "ana@acme.test"))).toBe("admitted");
    expect(await admission(e, user("g2", "bo@corp.test"))).toBe("admitted");
    expect(await admission(e, user("rl-test-b", "t@x.test"))).toBe("admitted");
    expect(await admission(e, user("g3", "cy@evil-corp.test"))).toBe(
      "not_invited",
    );
  });

  it("invite does not widen the test-user rule to prod", async () => {
    const p = at("invite", "prod");
    expect(await admission(p, user("rl-test-a", "t@x.test"))).toBe(
      "not_invited",
    );
  });

  it("gateOf: allowed, waitlist, waitlisted; absent while closed", async () => {
    await allow("ana@acme.test");
    const e = at("invite");
    expect(await gateOf(e, user("g1", "ana@acme.test"))).toBe("allowed");
    expect(await gateOf(e, user("g2", "bo@x.test"))).toBe("waitlist");
    await insert("signup_waitlist", {
      sub: "g2",
      email: "bo@x.test",
      joined_at: 1,
    });
    expect(await gateOf(e, user("g2", "bo@x.test"))).toBe("waitlisted");
    expect(await gateOf(at("false"), user("g2", "bo@x.test"))).toBeUndefined();
    expect(await gateOf(at("true"), user("g2", "bo@x.test"))).toBe("allowed");
  });
});

describe("create in invite mode", () => {
  it("an allowed email creates: 202, queued", async () => {
    await allow("ana@acme.test");
    const e = env();
    const { sid } = await signIn(e);
    expect((await create(e, sid)).status).toBe(202);
    expect(e.queued).toHaveLength(1);
  });

  it("an allowed domain creates", async () => {
    await allow("@acme.test");
    const e = env();
    const { sid } = await signIn(e);
    expect((await create(e, sid)).status).toBe(202);
  });

  it("someone not on the list is 403 not_invited; nothing is written or queued", async () => {
    await allow("@evil-acme.test", "bo@acme.test");
    const e = env();
    const { sid } = await signIn(e);
    const r = await create(e, sid);
    expect(r.status).toBe(403);
    const err = await code(r);
    expect(err.code).toBe("forbidden");
    expect(err.details?.reason).toBe("not_invited");
    expect(await db.prepare("SELECT 1 FROM signups").first()).toBeNull();
    expect(e.queued).toHaveLength(0);
  });

  it("a staging test user creates without being listed", async () => {
    const e = env();
    const { sid } = await signIn(e, { sub: "rl-test-a" });
    expect((await create(e, sid)).status).toBe(202);
  });

  it("removing an allow-list entry leaves the existing signup and install alone", async () => {
    await allow("ana@acme.test");
    const e = env();
    const { sid } = await signIn(e);
    expect((await create(e, sid)).status).toBe(202);
    const count = async (t: string) =>
      (
        await db
          .prepare(`SELECT COUNT(*) AS n FROM ${t}`)
          .first<{ n: number }>()
      )?.n;
    const before = [await count("signups"), await count("install_lifecycle")];
    await db.prepare("DELETE FROM signup_allowlist").run();
    expect([await count("signups"), await count("install_lifecycle")]).toEqual(
      before,
    );
    expect(before).toEqual([1, 1]);
    // The status still reports the sign-up; the gate now says waitlist.
    const s = await status(e, sid);
    expect(s.stage).toBe("queued");
    expect(s.gate).toBe("waitlist");
  });
});

describe("status gate", () => {
  it("allowed, waitlist, then waitlisted; the old fields stay", async () => {
    const e = env();
    const { sid } = await signIn(e);
    expect(await status(e, sid)).toEqual({ stage: "none", gate: "waitlist" });
    expect((await join(e, sid)).status).toBe(200);
    expect(await status(e, sid)).toEqual({ stage: "none", gate: "waitlisted" });
    await allow("ana@acme.test");
    expect(await status(e, sid)).toEqual({ stage: "none", gate: "allowed" });
  });

  it("is absent while sign-ups are closed", async () => {
    const e = env({ SIGNUPS_ENABLED: "false" });
    const { sid } = await signIn(e);
    expect(await status(e, sid)).toEqual({ stage: "none" });
  });

  it("the config reads open in invite mode", async () => {
    const r = await call(env(), `${SIGNUP}/api/v1/config`);
    expect(((await r.json()) as { open: boolean }).open).toBe(true);
  });
});

describe("POST /api/v1/signup/waitlist", () => {
  it("joins with the email and sub from the session; a body email or sub is ignored", async () => {
    const e = env();
    const { sid } = await signIn(e, { email: "Ana@Acme.test" });
    const r = await join(e, sid, {
      note: "  docs for my team  ",
      email: "evil@x.test",
      sub: "victim",
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ gate: "waitlisted" });
    const [row] = (await rows()).results;
    expect(row).toMatchObject({
      sub: "g-100",
      email: "ana@acme.test",
      note: "docs for my team",
      status: "waiting",
      joined_at: expect.any(Number),
    });
    expect((await rows()).results).toHaveLength(1);
  });

  it("the note is optional: no body, an empty body object or a blank note", async () => {
    for (const body of [undefined, {}, { note: "   " }]) {
      await resetDb();
      const e = env();
      const { sid } = await signIn(e);
      expect((await join(e, sid, body)).status, JSON.stringify(body)).toBe(200);
      expect((await rows()).results[0]?.note).toBeNull();
    }
  });

  it("caps the note at 280 characters: 280 passes, 281 is 400", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const bad = await join(e, sid, { note: "x".repeat(NOTE_MAX + 1) });
    expect(bad.status).toBe(400);
    expect((await code(bad)).code).toBe("invalid_input");
    expect((await rows()).results).toHaveLength(0);
    // Trimmed first: padding does not count.
    expect(
      (await join(e, sid, { note: ` ${"y".repeat(NOTE_MAX)} ` })).status,
    ).toBe(200);
    expect(String((await rows()).results[0]?.note).length).toBe(NOTE_MAX);
  });

  it("a non-string note or a non-object body is 400", async () => {
    const e = env();
    const { sid } = await signIn(e);
    expect((await join(e, sid, { note: 5 })).status).toBe(400);
    expect((await join(e, sid, ["x"])).status).toBe(400);
    expect((await join(e, sid, "x")).status).toBe(400);
  });

  it("is idempotent: a re-join keeps the first joined_at and note", async () => {
    const e = env();
    const { sid } = await signIn(e);
    await join(e, sid, { note: "first" });
    const first = (await rows()).results[0];
    const again = await join(e, sid, { note: "second" });
    expect(again.status).toBe(200);
    expect((await rows()).results).toEqual([first]);
  });

  it("a declined person re-joining stays declined, and still reads as waitlisted", async () => {
    const e = env();
    const { sid } = await signIn(e);
    await join(e, sid);
    await db
      .prepare(
        "UPDATE signup_waitlist SET status = 'declined', decided_by = 'me', decided_at = 5",
      )
      .run();
    const r = await join(e, sid, { note: "please" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ gate: "waitlisted" });
    expect((await rows()).results[0]).toMatchObject({
      status: "declined",
      decided_by: "me",
      decided_at: 5,
      note: null,
    });
    expect((await status(e, sid)).gate).toBe("waitlisted");
  });

  it("an allowed person cannot join: 409 invalid_state, nothing written", async () => {
    await allow("ana@acme.test");
    const e = env();
    const { sid } = await signIn(e);
    const r = await join(e, sid);
    expect(r.status).toBe(409);
    expect((await code(r)).details?.reason).toBe("already_allowed");
    expect((await rows()).results).toHaveLength(0);
  });

  it("outside invite mode it is 409 invalid_state, nothing written", async () => {
    for (const mode of ["true", "false", "test-users"] as const) {
      const e = env({ SIGNUPS_ENABLED: mode });
      const { sid } = await signIn(e);
      const r = await join(e, sid);
      expect(r.status, mode).toBe(409);
      expect((await code(r)).details?.reason).toBe("not_invite_mode");
    }
    expect((await rows()).results).toHaveLength(0);
  });

  it("needs a session: 401", async () => {
    const e = env();
    const r = await call(e, WAITLIST, {
      method: "POST",
      headers: { origin: SIGNUP, "content-type": "application/json" },
    });
    expect(r.status).toBe(401);
  });

  it("needs the exact Origin: none, another host or the admin host is 403", async () => {
    const e = env();
    const { sid } = await signIn(e);
    for (const origin of [
      null,
      "https://evil.test",
      `https://admin.${APP}`,
      `${SIGNUP}.evil.test`,
    ])
      expect(
        (await join(e, sid, undefined, { origin })).status,
        String(origin),
      ).toBe(403);
    expect(
      (await join(e, sid, undefined, { "sec-fetch-site": "cross-site" }))
        .status,
    ).toBe(403);
    expect((await rows()).results).toHaveLength(0);
  });

  it("needs the CSRF token: missing or wrong is 403", async () => {
    const e = env();
    const { sid } = await signIn(e);
    expect(
      (await join(e, sid, undefined, { "x-csrf-token": null })).status,
    ).toBe(403);
    expect(
      (await join(e, sid, undefined, { "x-csrf-token": "nope" })).status,
    ).toBe(403);
    expect((await rows()).results).toHaveLength(0);
  });

  it("is write rate limited", async () => {
    const e = env();
    const { sid } = await signIn(e);
    for (const l of Object.values(e.limits)) l.allow = false;
    expect((await join(e, sid)).status).toBe(429);
    expect((await rows()).results).toHaveLength(0);
  });

  it("only POST is served", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const r = await call(e, WAITLIST, {
      headers: { cookie: `${SIGNUP_COOKIE}=${sid}` },
    });
    expect(r.status).toBe(405);
  });

  it("is not served on the admin or api host", async () => {
    const e = env();
    expect(
      (
        await call(e, `https://api.${APP}/api/v1/signup/waitlist`, {
          method: "POST",
          headers: { origin: `https://api.${APP}` },
        })
      ).status,
    ).not.toBe(200);
    expect(
      (
        await call(e, `https://admin.${APP}/api/v1/signup/waitlist`, {
          method: "POST",
          headers: { origin: `https://admin.${APP}` },
        })
      ).status,
    ).not.toBe(200);
  });
});
