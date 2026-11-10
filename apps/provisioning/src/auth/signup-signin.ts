import {
  brokerNonce,
  brokerRedeemRequest,
  GoogleTokenError,
  ipKey,
  pkceChallenge,
  signBrokerTicket,
  verifyGoogleIdTokenAnyDomain,
} from "@oa/auth-core";
import { audit } from "../audit.js";
import type { Env } from "../env.js";
import { errorResponse } from "../errors.js";
import { limit } from "../limits.js";
import { refuse } from "../refuse.js";
import { bump, peek, SIGNIN_REFUSALS } from "./counters.js";
import { hmac16, randomToken } from "./crypto.js";
import { checkCsrf } from "./csrf.js";
import { FLOW_TTL_MS, readFlow, writeFlow } from "./flow.js";
import { BROKER_GOOGLE_CLIENT_ID } from "./google.js";
import { readCookie } from "./session.js";
import { openInstance } from "./signup-open.js";
import {
  clearSignupFlowCookie,
  clearSignupSessionCookie,
  createSignupSession,
  revokeSignupSession,
  SIGNUP_COOKIE,
  SIGNUP_FLOW_COOKIE,
  signupFlowCookie,
  signupOrigin,
  signupPrincipal,
  signupSessionCookie,
  signupSessionOf,
} from "./signup-session.js";

// Sign-in for the sign-up page (signup.<app>): the same Google broker flow as
// the admin panel (4.3), as the broker's second platform principal
// `i00000signup`. Any verified Google account may sign in (personal Gmail included); nothing reads ADMIN_IDENTITIES. The
// session is `kind = 'user'`, host-only, with its own CSRF.

export const SIGNUP_PRINCIPAL_ID = "i00000signup";
const GATE_INSTALL_HEADER = "x-oa-gate-install";
const TICKET_LIFETIME_MS = 5 * 60_000;

/** What the routes take from outside; tests pin the clock and the JWKS. */
export type SignupSigninDeps = {
  now: () => number;
  jwks?: Parameters<typeof verifyGoogleIdTokenAnyDomain>[0]["jwks"];
};
const DEFAULTS: SignupSigninDeps = { now: () => Date.now() };

const brokerOrigin = (env: Env) => `https://auth.${env.APP_DOMAIN}`;

function redirect(
  location: string,
  status: 302 | 303,
  cookies: string[] = [],
): Response {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status, headers: h });
}

/** Back to the page with the error the screen explains. */
const failed = (env: Env, why: "expired" | "denied" | "rate_limited") =>
  redirect(
    `${signupOrigin(env)}/?${new URLSearchParams({ error: why })}`,
    303,
    [clearSignupFlowCookie()],
  );

async function limited(req: Request, env: Env): Promise<Response | null> {
  const r = await limit(env, "signin_ip", ipKey(req));
  if (!r) return null;
  if (r.code !== "rate_limited") return errorResponse(r.code);
  await refuse(env, "signin", r.code, req);
  return failed(env, "rate_limited");
}

async function start(
  req: Request,
  env: Env,
  d: SignupSigninDeps,
): Promise<Response> {
  const key = env.SIGNUP_BROKER_KEY;
  if (!key) return errorResponse("unavailable");
  const lim = await limited(req, env);
  if (lim) return lim;
  const now = d.now();
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const challenge = await pkceChallenge(verifier);
  const flow = await writeFlow(env, {
    state,
    nonce,
    verifier,
    return: "/",
    reauth: false,
    exp: now + FLOW_TTL_MS,
  });
  const ticket = await signBrokerTicket(key, {
    install: SIGNUP_PRINCIPAL_ID,
    state,
    challenge,
    exp: now + TICKET_LIFETIME_MS,
  });
  const u = new URL(`${brokerOrigin(env)}/google/authorize`);
  u.search = new URLSearchParams({
    install: SIGNUP_PRINCIPAL_ID,
    state,
    nonce,
    code_challenge: challenge,
    ticket,
  }).toString();
  return redirect(u.toString(), 302, [signupFlowCookie(flow)]);
}

async function redeem(
  env: Env,
  a: { code: string; verifier: string; nonce: string; bstate: string },
  now: number,
): Promise<string | null> {
  try {
    const req = await brokerRedeemRequest(
      {
        url: brokerOrigin(env),
        installId: SIGNUP_PRINCIPAL_ID,
        signingKey: env.SIGNUP_BROKER_KEY as string,
      },
      a,
      now,
    );
    req.headers.set(GATE_INSTALL_HEADER, SIGNUP_PRINCIPAL_ID);
    const res = await env.AUTH_BROKER.fetch(req);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const out = (await res.json().catch(() => null)) as {
      id_token?: unknown;
    } | null;
    return typeof out?.id_token === "string" ? out.id_token : null;
  } catch {
    return null;
  }
}

async function callback(
  req: Request,
  env: Env,
  d: SignupSigninDeps,
): Promise<Response> {
  if (!env.SIGNUP_BROKER_KEY) return errorResponse("unavailable");
  const lim = await limited(req, env);
  if (lim) return lim;
  const now = d.now();
  const q = new URL(req.url).searchParams;
  const flow = await readFlow(env, readCookie(req, SIGNUP_FLOW_COOKIE), now);
  if (!flow || q.get("state") !== flow.state) {
    await refuse(env, "signin", "unauthenticated", req);
    return failed(env, "expired");
  }
  const code = q.get("code");
  const err = q.get("error");
  if (err || !code)
    return failed(env, err === "access_denied" ? "denied" : "expired");

  const ip = ipKey(req);
  const db = env.PLATFORM_DB;
  const ipCounter = `signin_refused:ip:${await hmac16(env.ADMIN_SESSION_KEY, ip)}`;
  const byIp = SIGNIN_REFUSALS.ip;
  if ((await peek(db, ipCounter, byIp.windowMs, now)) >= byIp.limit) {
    await refuse(env, "signin", "rate_limited", req);
    return failed(env, "rate_limited");
  }
  const idToken = await redeem(
    env,
    {
      code,
      verifier: flow.verifier,
      nonce: flow.nonce,
      bstate: q.get("bstate") ?? "",
    },
    now,
  );
  if (!idToken) {
    await bump(db, ipCounter, byIp.windowMs, now);
    await refuse(env, "signin", "unauthenticated", req);
    return failed(env, "expired");
  }
  let id: Awaited<ReturnType<typeof verifyGoogleIdTokenAnyDomain>>;
  try {
    id = await verifyGoogleIdTokenAnyDomain(
      { clientId: BROKER_GOOGLE_CLIENT_ID[env.OA_ENV], jwks: d.jwks, now },
      idToken,
      await brokerNonce(SIGNUP_PRINCIPAL_ID, flow.nonce),
    );
  } catch (e) {
    if (!(e instanceof GoogleTokenError)) throw e;
    await bump(db, ipCounter, byIp.windowMs, now);
    await audit(env, {
      action: "signin.refused",
      actor: { kind: "signin" },
      outcome: "refused",
      route: "R23",
      code: "token_invalid",
      ip,
      detail: { stage: e.stage, host: "signup" },
    });
    return failed(env, "denied");
  }

  // One live sign-up session per browser: a new sign-in replaces it.
  const prior = await signupSessionOf(req, env, now);
  if (prior) await revokeSignupSession(env, prior.row.id_hash, now);
  await audit(env, {
    action: "signin.ok",
    actor: { kind: "signin", email: id.email, sub: id.sub },
    outcome: "ok",
    route: "R23",
    ip,
    detail: { host: "signup" },
  });
  const sid = await createSignupSession(
    env,
    { email: id.email, sub: id.sub, hd: id.hd, authAt: id.authTime ?? 0 },
    now,
  );
  return redirect(`${signupOrigin(env)}/`, 303, [
    signupSessionCookie(sid),
    clearSignupFlowCookie(),
  ]);
}

/** POST /auth/logout: session, Origin (checked by the adapter) and CSRF. */
async function logout(
  req: Request,
  env: Env,
  d: SignupSigninDeps,
): Promise<Response> {
  const now = d.now();
  const p = await signupPrincipal(req, env, now);
  if ("refusal" in p) return refuse(env, "auth", p.code, req);
  const c = checkCsrf(req, env, p);
  if (c || !p.session) return refuse(env, "csrf", "csrf_failed", req);
  await revokeSignupSession(env, p.session.hash, now);
  const h = new Headers({ "cache-control": "no-store" });
  h.append("set-cookie", clearSignupSessionCookie());
  return new Response(null, { status: 204, headers: h });
}

export function signupAuthRoute(
  req: Request,
  env: Env,
  path: string,
  deps: Partial<SignupSigninDeps> = {},
): Promise<Response> | null {
  const d = { ...DEFAULTS, ...deps };
  if (req.method === "GET" && path === "/auth/start") return start(req, env, d);
  if (req.method === "GET" && path === "/auth/callback/google")
    return callback(req, env, d);
  if (req.method === "POST" && path === "/auth/open")
    return openInstance(req, env, d.now());
  if (req.method === "POST" && path === "/auth/logout")
    return logout(req, env, d);
  return null;
}

export { SIGNUP_COOKIE };
