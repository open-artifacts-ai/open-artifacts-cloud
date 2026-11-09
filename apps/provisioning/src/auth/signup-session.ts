import type { Env } from "../env.js";
import { type Principal, type Refusal, refusal } from "../principal.js";
import type { SessionRow } from "../services/tokens.js";
import { randomToken, sameString } from "./crypto.js";
import { csrfToken } from "./csrf.js";
import { readCookie, SESSION_TTL_MS, sessionHash } from "./session.js";

// Sign-up sessions (the sign-up page, signup.<app>): `__Host-oa-signup=<sid>`,
// Secure, HttpOnly, SameSite=Strict, host-only, 8 h absolute. Same table as
// admin sessions (`kind = 'user'`, host `signup.<app>`), so an admin cookie
// never opens a sign-up session and the other way round. The sid is a random
// 32-byte token; D1 keeps sha256(sid) only.

export const SIGNUP_COOKIE = "__Host-oa-signup";
export const SIGNUP_FLOW_COOKIE = "__Host-oa-signup-flow";
const SID_RE = /^[A-Za-z0-9_-]{43}$/;

export const signupHost = (env: Env) => `signup.${env.APP_DOMAIN}`;
export const signupOrigin = (env: Env) => `https://${signupHost(env)}`;

export const signupSessionCookie = (sid: string) =>
  `${SIGNUP_COOKIE}=${sid}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Strict`;
export const clearSignupSessionCookie = () =>
  `${SIGNUP_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
// Lax: the broker's redirect back is a cross-site top-level GET.
export const signupFlowCookie = (value: string) =>
  `${SIGNUP_FLOW_COOKIE}=${value}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`;
export const clearSignupFlowCookie = () =>
  `${SIGNUP_FLOW_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

/** Inserts a sign-up session; the sid goes only into the cookie. */
export async function createSignupSession(
  env: Env,
  s: { email: string; sub: string; hd: string | null; authAt: number },
  now: number,
): Promise<string> {
  const sid = randomToken(32);
  await env.PLATFORM_DB.prepare(
    `INSERT INTO sessions (id_hash, kind, host, email, sub, auth_at, created_at, expires_at, hd)
     VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sessionHash(sid),
      signupHost(env),
      s.email,
      s.sub,
      s.authAt,
      now,
      now + SESSION_TTL_MS,
      s.hd,
    )
    .run();
  return sid;
}

async function liveSignupSession(
  env: Env,
  sid: string,
  now: number,
): Promise<SessionRow | null> {
  const hash = await sessionHash(sid);
  const row = await env.PLATFORM_DB.prepare(
    `SELECT * FROM sessions WHERE id_hash = ? AND kind = 'user' AND host = ?
       AND revoked_at IS NULL AND expires_at > ?`,
  )
    .bind(hash, signupHost(env), now)
    .first<SessionRow>();
  return row && sameString(row.id_hash, hash) ? row : null;
}

/** Ends a sign-up session (logout, or a new sign-in replacing it). */
export async function revokeSignupSession(
  env: Env,
  hash: string,
  now: number,
): Promise<void> {
  await env.PLATFORM_DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND kind = 'user' AND revoked_at IS NULL",
  )
    .bind(now, hash)
    .run();
}

/** The live sign-up session for the request's cookie, or null. */
export async function signupSessionOf(
  req: Request,
  env: Env,
  now: number,
): Promise<{ row: SessionRow; sid: string } | null> {
  const sid = readCookie(req, SIGNUP_COOKIE);
  if (!sid || !SID_RE.test(sid)) return null;
  const row = await liveSignupSession(env, sid, now);
  return row ? { row, sid } : null;
}

/**
 * The `user` principal for the sign-up cookie (4.1 U): `hd` is the verified
 * Workspace domain the sign-in recorded, absent for a personal account.
 */
export async function signupPrincipal(
  req: Request,
  env: Env,
  now: number,
): Promise<Principal | Refusal> {
  const s = await signupSessionOf(req, env, now);
  if (!s) return refusal("unauthenticated");
  const { row, sid } = s;
  const key = `user:${row.sub}`;
  return {
    kind: "user",
    actorKey: key,
    rateKey: key,
    label: row.email,
    scopes: [],
    email: row.email,
    sub: row.sub,
    ...(row.hd ? { hd: row.hd } : {}),
    authAt: row.auth_at,
    session: {
      hash: row.id_hash,
      csrf: await csrfToken(env, `signup\n${sid}`),
      expiresAt: row.expires_at,
      authAt: row.auth_at,
    },
  };
}
