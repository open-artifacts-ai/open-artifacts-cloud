import {
  brokerNonce,
  keyId,
  publicFromPkcs8,
  SILENT_TICKET_TTL_MS,
  verifyBrokerTicket,
  verifySilentTicket,
} from "@oa/auth-core";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handle as appHandle } from "../src/app.js";
import { csrfToken } from "../src/auth/csrf.js";
import { BROKER_GOOGLE_CLIENT_ID } from "../src/auth/google.js";
import type { SigninDeps } from "../src/auth/signin.js";
import { SILENT_MIN_VERSION, versionAtLeast } from "../src/auth/signup-open.js";
import {
  SIGNUP_COOKIE,
  SIGNUP_FLOW_COOKIE,
} from "../src/auth/signup-session.js";
import type { Env } from "../src/env.js";
import { platformDb } from "./db.js";
import {
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

const signupKeys = async () => {
  const x = await publicFromPkcs8(SIGNUP_BROKER_KEY);
  return [{ kid: await keyId(x), x }];
};

/** A ready self-serve sign-up for `sub` on a fresh install at `version`. */
async function seedReady(sub: string, version: string | null) {
  const inst = await seedInstall({ version, state: "active" });
  const id = jobId();
  await insert("signups", {
    signup_id: id,
    source: "self-serve",
    owner_sub: sub,
    slug: inst.slug,
    job_id: id,
    vars: "{}",
    status: "ready",
    install_id: inst.id,
    created_at: 1,
    updated_at: 1,
  });
  return inst;
}

const open = async (
  e: E,
  sid: string,
  o: { csrf?: string | null; origin?: string | null; body?: unknown } = {},
) => {
  const headers: Record<string, string> = {
    cookie: `${SIGNUP_COOKIE}=${sid}`,
  };
  if (o.origin !== null) headers.origin = o.origin ?? SIGNUP;
  const csrf = o.csrf === undefined ? await csrfOf(e, sid) : o.csrf;
  if (csrf !== null) headers["x-csrf-token"] = csrf;
  return call(e, `${SIGNUP}/auth/open`, {
    method: "POST",
    headers,
    ...(o.body ? { body: JSON.stringify(o.body) } : {}),
  });
};

describe("POST /auth/open (silent ticket)", () => {
  it("mints a ticket for the caller's own ready install, bound to its id, origin and sub", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const inst = await seedReady("g-100", SILENT_MIN_VERSION);
    const r = await open(e, sid);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const b = (await r.json()) as { url: string; silent: boolean };
    const u = new URL(b.url);
    expect(b.silent).toBe(true);
    expect(`${u.origin}${u.pathname}`).toBe(
      `https://${inst.slug}.${APP}/auth/login/google`,
    );
    expect(u.searchParams.get("next")).toBe("/");
    const t = u.searchParams.get("silent") as string;
    const aud = `https://${inst.slug}.${APP}`;
    const ok = await verifySilentTicket(
      await signupKeys(),
      t,
      { install: inst.id, aud },
      NOW,
    );
    expect(ok).toEqual({ sub: "g-100" });
    // At most 60 s ahead, and not for another install or origin.
    expect(
      await verifySilentTicket(
        await signupKeys(),
        t,
        { install: inst.id, aud },
        NOW + SILENT_TICKET_TTL_MS + 1,
      ),
    ).toBeNull();
    expect(
      await verifySilentTicket(
        await signupKeys(),
        t,
        { install: "other", aud },
        NOW,
      ),
    ).toBeNull();
    expect(
      await verifySilentTicket(
        await signupKeys(),
        t,
        { install: inst.id, aud: "https://evil.test" },
        NOW,
      ),
    ).toBeNull();
  });

  it("the ticket never verifies as a broker ticket", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const inst = await seedReady("g-100", SILENT_MIN_VERSION);
    const b = (await (await open(e, sid)).json()) as { url: string };
    const t = new URL(b.url).searchParams.get("silent") as string;
    expect(
      await verifyBrokerTicket(
        await signupKeys(),
        t,
        { install: inst.id, state: "s", challenge: "c" },
        NOW,
      ),
    ).toBe(false);
  });

  it("needs a session, the exact Origin and the session's CSRF token", async () => {
    const e = env();
    const { sid } = await signIn(e);
    await seedReady("g-100", SILENT_MIN_VERSION);
    expect(
      (
        await call(e, `${SIGNUP}/auth/open`, {
          method: "POST",
          headers: { origin: SIGNUP },
        })
      ).status,
    ).toBe(401);
    for (const o of [
      { csrf: null },
      { csrf: "wrong" },
      { origin: null },
      { origin: "https://evil.test" },
      { origin: `https://admin.${APP}` },
    ])
      expect((await open(e, sid, o)).status, JSON.stringify(o)).toBe(403);
    expect((await open(e, sid)).status).toBe(200);
  });

  it("takes the install and sub only from the caller's own signup: submitted values are ignored, another owner's install is never used", async () => {
    const e = env();
    const { sid } = await signIn(e);
    // Someone else's ready install; the caller (g-100) has none.
    await seedReady("g-other", SILENT_MIN_VERSION);
    const r = await open(e, sid, {
      body: { sub: "g-other", host: "x.hosted.test", install: "iabc" },
    });
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("silent=");
    // With her own install, a submitted sub still cannot change the ticket's.
    const mine = await seedReady("g-100", SILENT_MIN_VERSION);
    const b = (await (
      await open(e, sid, { body: { sub: "g-other" } })
    ).json()) as { url: string };
    const t = new URL(b.url).searchParams.get("silent") as string;
    expect(
      await verifySilentTicket(
        await signupKeys(),
        t,
        { install: mine.id, aud: `https://${mine.slug}.${APP}` },
        NOW,
      ),
    ).toEqual({ sub: "g-100" });
  });

  it("a signup that isn't ready has no link", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const inst = await seedReady("g-100", SILENT_MIN_VERSION);
    await db
      .prepare("UPDATE signups SET status = 'creating' WHERE install_id = ?")
      .bind(inst.id)
      .run();
    expect((await open(e, sid)).status).toBe(404);
  });

  it("an instance older than the release that supports it gets the plain link, no ticket", async () => {
    const e = env();
    const { sid } = await signIn(e);
    const inst = await seedReady("g-100", "0.153.9");
    expect(await (await open(e, sid)).json()).toEqual({
      url: `https://${inst.slug}.${APP}/`,
      silent: false,
    });
    await db
      .prepare("UPDATE installs SET version = NULL WHERE id = ?")
      .bind(inst.id)
      .run();
    expect(
      ((await (await open(e, sid)).json()) as { silent: boolean }).silent,
    ).toBe(false);
  });

  it("a mint failure logs only the error name and falls back to the plain link", async () => {
    const e = env({ SIGNUP_BROKER_KEY: "not-a-key" });
    const { sid } = await signIn(env());
    await seedReady("g-100", SILENT_MIN_VERSION);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const b = (await (await open(e, sid)).json()) as {
      silent: boolean;
      url: string;
    };
    expect(b.silent).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0] as string[];
    expect(args[0]).toBe("signup_open_mint_failed");
    expect(JSON.stringify(args)).not.toContain("not-a-key");
    spy.mockRestore();
  });

  it("without the signing key it is the plain link", async () => {
    const e = env({ SIGNUP_BROKER_KEY: undefined });
    const { sid } = await signIn(env());
    await seedReady("g-100", SILENT_MIN_VERSION);
    const b = (await (await open(e, sid)).json()) as {
      silent: boolean;
      url: string;
    };
    expect(b.silent).toBe(false);
    expect(b.url).not.toContain("silent");
  });

  it("versionAtLeast orders releases; a prerelease is below its release", () => {
    expect(versionAtLeast("0.154.0", "0.154.0")).toBe(true);
    expect(versionAtLeast("0.154.1", "0.154.0")).toBe(true);
    expect(versionAtLeast("1.0.0", "0.154.0")).toBe(true);
    expect(versionAtLeast("0.153.9", "0.154.0")).toBe(false);
    expect(versionAtLeast("0.154.0-dev+abc", "0.154.0")).toBe(false);
    expect(versionAtLeast("junk", "0.154.0")).toBe(false);
    expect(versionAtLeast(null, "0.154.0")).toBe(false);
  });
});
