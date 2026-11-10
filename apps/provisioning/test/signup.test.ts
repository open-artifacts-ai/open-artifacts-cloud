import {
  brokerNonce,
  keyId,
  publicFromPkcs8,
  verifyBrokerTicket,
} from "@oa/auth-core";
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
import { FLOW_COOKIE } from "../src/auth/flow.js";
import { BROKER_GOOGLE_CLIENT_ID } from "../src/auth/google.js";
import { SESSION_COOKIE } from "../src/auth/session.js";
import type { SigninDeps } from "../src/auth/signin.js";
import {
  SIGNUP_COOKIE,
  SIGNUP_FLOW_COOKIE,
} from "../src/auth/signup-session.js";
import type { Env } from "../src/env.js";
import { hostKind } from "../src/hosts.js";
import { CLIENT_JS } from "../src/signup/client.js";
import { platformDb } from "./db.js";
import {
  ADMIN,
  APP,
  ctx,
  db,
  fakeEnv,
  insert,
  jobId,
  resetDb,
  SIGNUP,
  SIGNUP_BROKER_KEY,
  seedInstall,
} from "./fakes.js";

// The sign-up host (signup.<app>): its page, its own Google sign-in and
// host-only session/CSRF, and the three contract routes it serves.

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

const deps = (): Partial<SigninDeps> => ({ now: () => NOW, jwks });
let idToken: () => Promise<string>;
const env = (over: Partial<Env> = {}) =>
  fakeEnv({
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

/** Runs the whole sign-in; returns the sign-up cookie value. */
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
  return { res, sid: val(cookieOf(res, SIGNUP_COOKIE)) };
}

const csrfOf = (e: E, sid: string) => csrfToken(e.env, `signup\n${sid}`);

describe("host", () => {
  it("signup.<app> is its own host kind", () => {
    const { env: e } = fakeEnv();
    expect(hostKind(`signup.${APP}`, e)).toBe("signup");
    expect(hostKind(`SIGNUP.${APP}`, e)).toBe("signup");
    expect(hostKind(`admin.${APP}`, e)).toBe("admin");
    expect(hostKind(`x.signup.${APP}`, e)).toBeNull();
  });
});

describe("page and assets", () => {
  it("serves the document, script and styles with the sign-up CSP, never the admin SPA", async () => {
    const e = fakeEnv();
    const page = await call(e, `${SIGNUP}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain('<script src="/app.js">');
    expect(html).toContain('<link rel="stylesheet" href="/app.css">');
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(
      "script-src 'self' https://challenges.cloudflare.com",
    );
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const js = await call(e, `${SIGNUP}/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect((await call(e, `${SIGNUP}/app.css`)).status).toBe(200);
    expect(e.assets).toEqual([]);
  });

  it("anything else is 404 (no SPA fallback), and the admin bundle is not served here", async () => {
    const e = fakeEnv();
    for (const p of [
      "/installs",
      "/index.html",
      "/assets/x.js",
      "/api/v1/installs",
    ])
      expect((await call(e, `${SIGNUP}${p}`)).status).toBe(404);
    // A write without the page's Origin is refused before routing.
    expect((await call(e, `${SIGNUP}/`, { method: "POST" })).status).toBe(403);
    expect(
      (
        await call(e, `${SIGNUP}/`, {
          method: "POST",
          headers: { origin: SIGNUP },
        })
      ).status,
    ).toBe(404);
    expect(e.assets).toEqual([]);
  });

  it("the admin host is unchanged: the SPA, no sign-up page", async () => {
    const e = fakeEnv();
    const r = await call(e, `${ADMIN}/app.js`);
    expect(await r.text()).toBe("spa");
    expect(e.assets).toHaveLength(1);
  });

  it("browser hosts refuse Authorization", async () => {
    const r = await call(fakeEnv(), `${SIGNUP}/`, {
      headers: { authorization: "Bearer oat_x" },
    });
    expect(r.status).toBe(401);
  });

  it("the client script parses and builds text with textContent only", () => {
    expect(() => new Function(CLIENT_JS)).not.toThrow();
    expect(CLIENT_JS).not.toContain("innerHTML");
    expect(CLIENT_JS).not.toContain("eval(");
  });
});

describe("GET /api/v1/config", () => {
  it("open while sign-ups are enabled or test-users; closed while false", async () => {
    for (const [v, open] of [
      ["false", false],
      ["true", true],
      ["test-users", true],
    ] as const) {
      const e = fakeEnv({ SIGNUPS_ENABLED: v });
      const r = await call(e, `${SIGNUP}/api/v1/config`);
      const b = (await r.json()) as Record<string, unknown>;
      expect(b.open).toBe(open);
      expect(b.appDomain).toBe(APP);
      expect(b.turnstileSiteKey).toBe("0x4AAAAAAAtest");
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("sign-in on the sign-up host", () => {
  it("/auth/start: 302 to the broker as i00000signup with a ticket from SIGNUP_BROKER_KEY", async () => {
    const e = fakeEnv();
    const res = await call(e, `${SIGNUP}/auth/start`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(`${loc.origin}${loc.pathname}`).toBe(
      `https://auth.${APP}/google/authorize`,
    );
    expect(loc.searchParams.get("install")).toBe("i00000signup");
    const x = await publicFromPkcs8(SIGNUP_BROKER_KEY);
    expect(
      await verifyBrokerTicket(
        [{ kid: await keyId(x), x }],
        loc.searchParams.get("ticket") ?? "",
        {
          install: "i00000signup",
          state: loc.searchParams.get("state") ?? "",
          challenge: loc.searchParams.get("code_challenge") ?? "",
        },
        NOW,
      ),
    ).toBe(true);
    const flow = cookieOf(res, SIGNUP_FLOW_COOKIE) ?? "";
    expect(flow).toMatch(/Secure/);
    expect(flow).toMatch(/HttpOnly/);
    expect(flow).toMatch(/SameSite=Lax/);
    expect(flow).not.toMatch(/Domain=/);
    expect(cookieOf(res, FLOW_COOKIE)).toBeNull();
  });

  it("without SIGNUP_BROKER_KEY sign-in is 503", async () => {
    const e = fakeEnv({ SIGNUP_BROKER_KEY: undefined });
    expect((await call(e, `${SIGNUP}/auth/start`)).status).toBe(503);
    expect(
      (await call(e, `${SIGNUP}/auth/callback/google?code=C&state=s`)).status,
    ).toBe(503);
  });

  it("any Google account signs in (ADMIN_IDENTITIES is not read); the session is a host-only user session with hd", async () => {
    const e = env({ ADMIN_IDENTITIES: "" });
    const { res, sid } = await signIn(e);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${SIGNUP}/`);
    const c = cookieOf(res, SIGNUP_COOKIE) ?? "";
    expect(c).toMatch(/^__Host-oa-signup=[A-Za-z0-9_-]{43};/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).not.toMatch(/Domain=/);
    const row = await db
      .prepare("SELECT kind, host, email, sub, hd FROM sessions")
      .first();
    expect(row).toEqual({
      kind: "user",
      host: `signup.${APP}`,
      email: "ana@acme.test",
      sub: "g-100",
      hd: "acme.test",
    });
    expect(sid).toHaveLength(43);
  });

  it("a personal account signs in with hd null", async () => {
    const e = env();
    await signIn(e, { email: "ana@gmail.com", hd: undefined, sub: "g-200" });
    const row = await db
      .prepare("SELECT hd FROM sessions")
      .first<{ hd: string | null }>();
    expect(row?.hd).toBeNull();
  });

  it("a bad or missing flow goes back to the page with ?error=expired", async () => {
    const e = env();
    const r = await call(e, `${SIGNUP}/auth/callback/google?code=C&state=nope`);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`${SIGNUP}/?error=expired`);
    expect(await db.prepare("SELECT 1 FROM sessions").first()).toBeNull();
  });

  it("access_denied from Google goes back with ?error=denied", async () => {
    const e = env();
    const s = await call(e, `${SIGNUP}/auth/start`);
    const loc = new URL(s.headers.get("location") ?? "");
    const r = await call(
      e,
      `${SIGNUP}/auth/callback/google?error=access_denied&state=${loc.searchParams.get("state")}`,
      {
        headers: {
          cookie: `${SIGNUP_FLOW_COOKIE}=${val(cookieOf(s, SIGNUP_FLOW_COOKIE))}`,
        },
      },
    );
    expect(r.headers.get("location")).toBe(`${SIGNUP}/?error=denied`);
  });

  it("an admin flow cookie does not start a sign-up callback", async () => {
    const e = env();
    const a = await call(e, `${ADMIN}/auth/start`);
    const loc = new URL(a.headers.get("location") ?? "");
    const r = await call(
      e,
      `${SIGNUP}/auth/callback/google?code=C&state=${loc.searchParams.get("state")}`,
      {
        headers: { cookie: `${FLOW_COOKIE}=${val(cookieOf(a, FLOW_COOKIE))}` },
      },
    );
    expect(r.headers.get("location")).toBe(`${SIGNUP}/?error=expired`);
  });

  it("the sign-in is rate limited by RL_PV_SIGNIN_IP", async () => {
    const e = env();
    e.limits.RL_PV_SIGNIN_IP.allow = false;
    const r = await call(e, `${SIGNUP}/auth/start`);
    expect(r.headers.get("location")).toBe(`${SIGNUP}/?error=rate_limited`);
  });
});

describe("sessions do not cross hosts", () => {
  it("a sign-up cookie is no admin session, an admin cookie is no sign-up session", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const asAdmin = await call(e, `${ADMIN}/api/v1/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${sid}; ${SIGNUP_COOKIE}=${sid}` },
    });
    expect(asAdmin.status).toBe(401);
    const asSignup = await call(e, `${SIGNUP}/api/v1/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    });
    expect(asSignup.status).toBe(401);
  });

  it("GET /api/v1/me is the user principal with a per-session CSRF token", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const r = await call(e, `${SIGNUP}/api/v1/me`, {
      headers: { cookie: `${SIGNUP_COOKIE}=${sid}` },
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b).toMatchObject({
      principal: "user",
      email: "ana@acme.test",
      role: "user",
    });
    expect(b.csrf).toBe(await csrfOf(e, sid));
    expect(b.csrf).not.toBe(await csrfToken(e.env, sid));
  });

  it("only R1, R4 and R18 are served; the rest of the API is 404 here", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const headers = { cookie: `${SIGNUP_COOKIE}=${sid}` };
    for (const p of [
      "/api/v1/installs",
      "/api/v1/world",
      "/api/v1/tokens",
      "/api/v1/audit",
    ])
      expect((await call(e, `${SIGNUP}${p}`, { headers })).status).toBe(404);
    expect(
      (await call(e, `${SIGNUP}/api/v1/slugs/acme`, { headers })).status,
    ).toBe(200);
  });

  it("logout needs Origin and CSRF, then ends the session", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const cookie = `${SIGNUP_COOKIE}=${sid}`;
    const post = (h: Record<string, string>) =>
      call(e, `${SIGNUP}/auth/logout`, {
        method: "POST",
        headers: { cookie, ...h },
      });
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: SIGNUP })).status).toBe(403);
    expect(
      (await post({ origin: ADMIN, "x-csrf-token": await csrfOf(e, sid) }))
        .status,
    ).toBe(403);
    const ok = await post({
      origin: SIGNUP,
      "x-csrf-token": await csrfOf(e, sid),
    });
    expect(ok.status).toBe(204);
    expect(cookieOf(ok, SIGNUP_COOKIE)).toMatch(/Max-Age=0/);
    const me = await call(e, `${SIGNUP}/api/v1/me`, { headers: { cookie } });
    expect(me.status).toBe(401);
  });
});

const create = async (
  e: E,
  sid: string,
  h: Record<string, string> = {},
  body: Record<string, unknown> = {},
) =>
  call(e, `${SIGNUP}/api/v1/installs`, {
    method: "POST",
    headers: {
      cookie: `${SIGNUP_COOKIE}=${sid}`,
      origin: SIGNUP,
      "content-type": "application/json",
      "x-csrf-token": await csrfOf(e, sid),
      ...h,
    },
    body: JSON.stringify({
      requestId: "su-0123456789abcdef0123",
      slug: "acme",
      turnstile: "tok",
      ...body,
    }),
  });

describe("create from the sign-up host (R4, self-serve policy)", () => {
  it("a Workspace user creates: 202, queued for the consumer, owner pinned to the Google sub", async () => {
    const e = env({ SIGNUPS_ENABLED: "true" });
    const { sid } = await signIn(e);
    const r = await create(e, sid);
    expect(r.status).toBe(202);
    const s = await db
      .prepare("SELECT source, owner_sub, slug, status, vars FROM signups")
      .first<{
        source: string;
        owner_sub: string;
        slug: string;
        status: string;
        vars: string;
      }>();
    expect(s).toMatchObject({
      source: "self-serve",
      owner_sub: "g-100",
      slug: "acme",
      status: "pending",
    });
    expect(JSON.parse(s?.vars ?? "{}")).toMatchObject({
      AUTH_DOMAINS: "acme.test",
    });
    expect(e.queued).toHaveLength(1);
  });

  it("CSRF: wrong Origin, no token, a token from the admin derivation are all 403", async () => {
    const e = env({ SIGNUPS_ENABLED: "true" });
    const { sid } = await signIn(e);
    expect((await create(e, sid, { origin: ADMIN })).status).toBe(403);
    expect((await create(e, sid, { origin: "https://evil.test" })).status).toBe(
      403,
    );
    expect((await create(e, sid, { "x-csrf-token": "" })).status).toBe(403);
    expect(
      (await create(e, sid, { "x-csrf-token": await csrfToken(e.env, sid) }))
        .status,
    ).toBe(403);
    expect(
      (await create(e, sid, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(await db.prepare("SELECT 1 FROM signups").first()).toBeNull();
  });

  it("a personal Gmail account (no hd) creates: 202, no domain, owner pinned to the sub", async () => {
    const e = env({ SIGNUPS_ENABLED: "true" });
    const { sid } = await signIn(e, {
      email: "ana@gmail.com",
      hd: undefined,
      sub: "g-300",
    });
    const r = await create(e, sid);
    expect(r.status).toBe(202);
    const s = await db
      .prepare("SELECT owner_sub, vars FROM signups")
      .first<{ owner_sub: string; vars: string }>();
    expect(s?.owner_sub).toBe("g-300");
    expect(JSON.parse(s?.vars ?? "{}")).toMatchObject({
      AUTH_PROVIDERS: "google,email",
      AUTH_DOMAINS: "",
    });
    expect(e.queued).toHaveLength(1);
  });

  it("a non-Gmail account with no hd is refused 403 with a clear message, nothing queued", async () => {
    const e = env({ SIGNUPS_ENABLED: "true" });
    const { sid } = await signIn(e, {
      email: "ana@corp.example",
      hd: undefined,
      sub: "g-310",
    });
    const r = await create(e, sid);
    expect(r.status).toBe(403);
    const b = (await r.json()) as { error: { code: string; message: string } };
    expect(b.error.code).toBe("forbidden");
    expect(b.error.message).toMatch(/Gmail/);
    expect(await db.prepare("SELECT 1 FROM signups").first()).toBeNull();
    expect(e.queued).toHaveLength(0);
  });

  it("while sign-ups are closed it is 503 signups_closed", async () => {
    const e = env({ SIGNUPS_ENABLED: "false" });
    const { sid } = await signIn(e);
    const r = await create(e, sid);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "signups_closed",
    );
  });

  it("a missing Turnstile token is 403 turnstile_failed", async () => {
    const e = env({ SIGNUPS_ENABLED: "true" });
    const { sid } = await signIn(e);
    const r = await create(e, sid, {}, { turnstile: "" });
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "turnstile_failed",
    );
  });

  it("a second sign-up for the account is 409 signup_limit, a taken slug 409 slug_taken", async () => {
    const e = env({ SIGNUPS_ENABLED: "true" });
    const { sid } = await signIn(e);
    expect((await create(e, sid)).status).toBe(202);
    const again = await create(
      e,
      sid,
      {},
      { requestId: "su-aaaaaaaaaaaaaaaaaaaa", slug: "acme2" },
    );
    expect(
      ((await again.json()) as { error: { code: string } }).error.code,
    ).toBe("signup_limit");
    const other = await signIn(e, { sub: "g-101", email: "bo@acme.test" });
    const taken = await create(
      e,
      other.sid,
      {},
      { requestId: "su-bbbbbbbbbbbbbbbbbbbb" },
    );
    expect(
      ((await taken.json()) as { error: { code: string } }).error.code,
    ).toBe("slug_taken");
  });
});

describe("GET /api/v1/slugs/:slug and /api/v1/signup", () => {
  it("slug checks answer ok, taken, invalid and reserved", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const headers = { cookie: `${SIGNUP_COOKIE}=${sid}` };
    const status = async (s: string) =>
      (
        (await (
          await call(e, `${SIGNUP}/api/v1/slugs/${s}`, { headers })
        ).json()) as { status: string }
      ).status;
    expect(await status("acme")).toBe("ok");
    expect(await status("Bad_Slug")).toBe("invalid");
    expect(await status("admin")).toBe("reserved");
    await insert("signups", {
      signup_id: jobId(),
      source: "admin",
      slug: "held",
      job_id: jobId(),
      vars: "{}",
      status: "queued",
      created_at: 1,
      updated_at: 1,
    });
    expect(await status("held")).toBe("taken");
  });

  it("slug checks need a session", async () => {
    const r = await call(env(), `${SIGNUP}/api/v1/slugs/acme`);
    expect(r.status).toBe(401);
  });

  it("status is none, then the caller's newest sign-up stage; pending shows as queued", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const headers = { cookie: `${SIGNUP_COOKIE}=${sid}` };
    const get = async () =>
      (await call(e, `${SIGNUP}/api/v1/signup`, { headers })).json();
    expect(await get()).toEqual({ stage: "none" });
    const id = jobId();
    await insert("signups", {
      signup_id: id,
      source: "self-serve",
      owner_sub: "g-100",
      slug: "acme",
      job_id: id,
      vars: "{}",
      status: "pending",
      created_at: 1,
      updated_at: 1,
    });
    expect(await get()).toEqual({
      stage: "queued",
      slug: "acme",
      host: `acme.${APP}`,
    });
    for (const st of ["queued", "waiting_cap", "creating", "ready", "failed"]) {
      await db
        .prepare("UPDATE signups SET status = ? WHERE signup_id = ?")
        .bind(st, id)
        .run();
      expect(((await get()) as { stage: string }).stage).toBe(st);
    }
  });

  describe("a deleted or purged instance is not live", () => {
    const seed = async (
      sub: string,
      o: { state: "active" | "deleted"; freed?: boolean },
    ) => {
      const inst = await seedInstall({ state: o.state });
      const id = jobId();
      await insert("signups", {
        signup_id: id,
        source: "self-serve",
        owner_sub: sub,
        slug: "acme",
        install_id: inst.id,
        job_id: id,
        vars: "{}",
        status: "ready",
        created_at: 1,
        updated_at: 1,
      });
      await insert("signup_accounts", {
        owner_sub: sub,
        signup_id: id,
        created_at: 1,
        freed_at: o.freed ? 5 : null,
      });
      return id;
    };
    const stage = async (e: E, sid: string) =>
      (
        (await (
          await call(e, `${SIGNUP}/api/v1/signup`, {
            headers: { cookie: `${SIGNUP_COOKIE}=${sid}` },
          })
        ).json()) as { stage: string }
      ).stage;

    it("a ready signup whose install is deleted is none", async () => {
      const e = env();
      const { sid } = await signIn(e);
      await seed("g-100", { state: "deleted" });
      expect(await stage(e, sid)).toBe("none");
    });

    it("a freed claim is none", async () => {
      const e = env();
      const { sid } = await signIn(e);
      await seed("g-100", { state: "active", freed: true });
      expect(await stage(e, sid)).toBe("none");
    });

    it("a live ready signup is ready", async () => {
      const e = env();
      const { sid } = await signIn(e);
      await seed("g-100", { state: "active" });
      expect(await stage(e, sid)).toBe("ready");
    });

    it("after a purge (claim freed) the same account can create again", async () => {
      const e = env({ SIGNUPS_ENABLED: "true" });
      const { sid } = await signIn(e);
      const id = await seed("g-100", { state: "deleted" });
      const blocked = await create(
        e,
        sid,
        {},
        { requestId: "su-aaaaaaaaaaaaaaaaaaaa", slug: "acme2" },
      );
      expect(
        ((await blocked.json()) as { error: { code: string } }).error.code,
      ).toBe("signup_limit");
      await db
        .prepare("UPDATE signup_accounts SET freed_at = 5 WHERE signup_id = ?")
        .bind(id)
        .run();
      expect(await stage(e, sid)).toBe("none");
      const again = await create(
        e,
        sid,
        {},
        { requestId: "su-bbbbbbbbbbbbbbbbbbbb", slug: "acme3" },
      );
      expect(again.status).toBe(202);
    });
  });

  it("status never shows another account's sign-up, and needs a session", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const id = jobId();
    await insert("signups", {
      signup_id: id,
      source: "self-serve",
      owner_sub: "someone-else",
      slug: "theirs",
      job_id: id,
      vars: "{}",
      status: "creating",
      created_at: 1,
      updated_at: 1,
    });
    const mine = await call(e, `${SIGNUP}/api/v1/signup`, {
      headers: { cookie: `${SIGNUP_COOKIE}=${sid}` },
    });
    expect(await mine.json()).toEqual({ stage: "none" });
    expect((await call(e, `${SIGNUP}/api/v1/signup`)).status).toBe(401);
  });
});

describe("signup_limit refusal copy", () => {
  it("points to the published contact as a mailto link", () => {
    expect(CLIENT_JS).toContain(
      "You already have an Open Artifacts instance with this Google account. Need help? Email ",
    );
    expect(CLIENT_JS).toContain('var HELP_EMAIL = "hello@open-artifacts.com"');
    expect(CLIENT_JS).toContain('href: "mailto:" + HELP_EMAIL');
    expect(CLIENT_JS).toMatch(/r\.code === "signup_limit"[\s\S]*LIMIT_ERR/);
  });
});

describe("CSP: no inline styles on the sign-up page", () => {
  it("the document, script and noscript carry no style attribute and write no .style", async () => {
    const html = await (await call(fakeEnv(), `${SIGNUP}/`)).text();
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(CLIENT_JS).not.toMatch(/style:\s*"/);
    expect(CLIENT_JS).not.toMatch(/["']style["']/);
    expect(CLIENT_JS).not.toMatch(
      /\.style\b|cssText|setAttribute\(\s*["']style/,
    );
  });

  it("every stage keeps a heading: no empty header branch", () => {
    for (const t of [
      '"Setting up ", nw(hostName)',
      'nw(hostName), " is ready"',
      '"We couldn\'t set up ", nw(hostName)',
    ])
      expect(CLIENT_JS).toContain(t);
    expect(CLIENT_JS).not.toContain("? [] :");
  });
});

describe("a purged address (cloud #108)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** A deleted self-serve install and its ready signup, purged `ago` ms ago. */
  const purged = async (slug: string, sub: string, ago: number) => {
    const { id } = await seedInstall({
      slug,
      state: "deleted",
      source: "self-serve",
      ownerSub: sub,
    });
    await db
      .prepare("UPDATE installs SET updated_at = ? WHERE id = ?")
      .bind(Date.now() - ago, id)
      .run();
    const sid = jobId();
    await insert("signups", {
      signup_id: sid,
      source: "self-serve",
      owner_sub: sub,
      slug,
      install_id: id,
      job_id: sid,
      vars: "{}",
      status: "ready",
      created_at: 1,
      updated_at: 1,
    });
    return { id, sid };
  };
  const check = async (e: E, sid: string, slug: string) =>
    (
      (await (
        await call(e, `${SIGNUP}/api/v1/slugs/${slug}`, {
          headers: { cookie: `${SIGNUP_COOKIE}=${sid}` },
        })
      ).json()) as { status: string }
    ).status;
  const errOf = async (r: Response) =>
    ((await r.json()) as { error: { code: string; message: string } }).error;

  it("the same Google account takes its old address back at once, and the old row's keys are released", async () => {
    const e = env({ SIGNUPS_ENABLED: "true" });
    const { sid } = await signIn(e);
    const old = await purged("acme", "g-100", 10 * 60 * 1000);
    expect(await check(e, sid, "acme")).toBe("ok");
    expect((await create(e, sid)).status).toBe(202);
    const live = await db
      .prepare("SELECT slug, status FROM signups WHERE signup_id <> ?")
      .bind(old.sid)
      .first<{ slug: string; status: string }>();
    expect(live).toEqual({ slug: "acme", status: "pending" });
    const dead = await db
      .prepare(
        "SELECT slug, app_host, content_host, state FROM installs WHERE id = ?",
      )
      .bind(old.id)
      .first<{
        slug: string;
        app_host: string;
        content_host: string;
        state: string;
      }>();
    expect(dead).toEqual({
      slug: `acme~${old.id}`,
      app_host: `acme.${APP}~${old.id}`,
      content_host: `acme.content.test~${old.id}`,
      state: "deleted",
    });
    expect(await check(e, sid, "acme")).toBe("taken");
  });

  it("the unmap settles first: inside 2 minutes it is taken, even for its owner", async () => {
    const e = env({ SIGNUPS_ENABLED: "true" });
    const { sid } = await signIn(e);
    await purged("acme", "g-100", 30 * 1000);
    expect(await check(e, sid, "acme")).toBe("taken");
    await expect(errOf(await create(e, sid))).resolves.toMatchObject({
      code: "slug_taken",
      message: "slug_taken",
    });
  });

  it("another account is refused within 30 days (cooling) and allowed after", async () => {
    const e = env({ SIGNUPS_ENABLED: "true" });
    const { sid } = await signIn(e, { sub: "g-200", email: "bo@acme.test" });
    await purged("acme", "g-100", 29 * DAY);
    expect(await check(e, sid, "acme")).toBe("cooling");
    expect(await errOf(await create(e, sid))).toMatchObject({
      code: "slug_taken",
      message: "slug_cooling",
    });
    await db
      .prepare("UPDATE installs SET updated_at = ?")
      .bind(Date.now() - 31 * DAY)
      .run();
    expect(await check(e, sid, "acme")).toBe("ok");
    expect((await create(e, sid)).status).toBe(202);
  });

  it("a live install stays taken, for its own account too", async () => {
    const e = env({ SIGNUPS_ENABLED: "true" });
    const { sid } = await signIn(e);
    await seedInstall({
      slug: "acme",
      state: "active",
      source: "self-serve",
      ownerSub: "g-100",
    });
    expect(await check(e, sid, "acme")).toBe("taken");
    expect(await errOf(await create(e, sid))).toMatchObject({
      code: "slug_taken",
      message: "slug_taken",
    });
  });

  it("a live signup whose install is not deleted stays taken", async () => {
    const e = env({ SIGNUPS_ENABLED: "true" });
    const { sid } = await signIn(e);
    const { id } = await seedInstall({
      slug: "acme",
      state: "deleted",
      ownerSub: "g-100",
    });
    await db.prepare("UPDATE installs SET updated_at = 1").run();
    const live = await seedInstall({ slug: "other", state: "active" });
    const s = jobId();
    await insert("signups", {
      signup_id: s,
      source: "self-serve",
      owner_sub: "g-100",
      slug: "acme",
      install_id: live.id,
      job_id: s,
      vars: "{}",
      status: "creating",
      created_at: 1,
      updated_at: 1,
    });
    expect(id).toBeTruthy();
    expect(await check(e, sid, "acme")).toBe("taken");
  });

  it("the client shows Product's copy for cooling and keeps the suggestions", () => {
    expect(CLIENT_JS).toContain(
      "was used recently and isn't available yet. Pick another address.",
    );
    expect(CLIENT_JS).toMatch(/a === "taken" \|\| a === "cooling"/);
    expect(CLIENT_JS).toContain('r.message === "slug_cooling"');
  });
});
