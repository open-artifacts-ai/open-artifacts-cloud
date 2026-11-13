import {
  type ApiRouteId,
  type BrowserRouteId,
  isApiRoute,
  PROTOCOL_ROUTES,
  ROUTES,
} from "@oa/provisioning-contract";
import { authenticate } from "./auth/authenticate.js";
import { checkCsrf, checkOrigin } from "./auth/csrf.js";
import {
  handleOAuth,
  isOAuthPath,
  oauthPrincipal,
} from "./auth/oauth/index.js";
import { browserRoute, type SigninDeps } from "./auth/signin.js";
import { signupPrincipal } from "./auth/signup-session.js";
import { signupAuthRoute } from "./auth/signup-signin.js";
import { LazyBody, readJsonBody } from "./body.js";
import type { Env } from "./env.js";
import {
  ApiError,
  errorResponse,
  methodNotAllowed,
  NotImplemented,
  notImplemented,
} from "./errors.js";
import { browserHeaders } from "./headers.js";
import { type HostKind, hostKind } from "./hosts.js";
import { limit, limitRoute } from "./limits.js";
import { handleMcp } from "./mcp/index.js";
import { isRefusal } from "./principal.js";
import { refuse } from "./refuse.js";
import { BETA_PATH_RE, betaApi } from "./routes/beta.js";
import { BUSINESS_PATH_RE, businessApi } from "./routes/business.js";
import { CLAIM_FREE_PATH, freeClaim } from "./routes/claim-free.js";
import { bodyKeys, invokeRoute } from "./routes/invoke.js";
import { SET_TIER_PATH_RE, setTier } from "./routes/set-tier.js";
import { matchRoute } from "./routes/table.js";
import { ipKeyOf } from "./services/counters.js";
import { submitContact } from "./signup/contact.js";
import {
  SIGNUP_CSP,
  signupConfig,
  signupStatic,
  signupStatus,
} from "./signup/index.js";
import { joinWaitlist } from "./signup/waitlist.js";

// The HTTP adapter (design v7 4.2 check order): host policy -> pre-authn IP
// limit -> Origin (browser writes) -> authn -> CSRF -> invokeRoute.

// The raw address (Cloudflare sets it on every edge request); rate keys use
// ipKeyOf (IPv6 by /64, 4.7). A request without a parseable one is refused,
// so no two callers ever share an "unknown" bucket.
const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") ?? "";

const notFound = () => errorResponse("not_found");

/** Any throw becomes the 3.5 envelope, never an uncaught Worker 500. */
async function guard(f: () => Promise<Response>): Promise<Response> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ApiError)
      return errorResponse(e.code, e.message, e.details);
    if (e instanceof NotImplemented) return notImplemented();
    return errorResponse("internal");
  }
}

/** `signin`: the sign-in routes' clock and seams (tests only). */
export async function handle(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  signin: Partial<SigninDeps> = {},
): Promise<Response> {
  const url = new URL(req.url);
  const host = hostKind(url.hostname, env);
  if (!host) return notFound();
  if (host === "api") return route(req, env, ctx, "api", url, signin);
  if (host === "signup")
    return browserHeaders(await route(req, env, ctx, "signup", url, signin), {
      csp: SIGNUP_CSP,
    });
  // Every admin-host response, SPA and errors alike, carries the 4.5
  // browser-host headers; the consent page keeps its own CSP (9A.3.2).
  return browserHeaders(await route(req, env, ctx, "admin", url, signin), {
    ownCsp: url.pathname === "/oauth/authorize",
  });
}

async function route(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  host: HostKind,
  url: URL,
  signin: Partial<SigninDeps>,
): Promise<Response> {
  // Host policy first: browser hosts refuse Authorization; api.<app> ignores
  // Cookie (4.5).
  if (host !== "api" && req.headers.has("authorization"))
    return refuse(env, "auth", "unauthenticated", req);

  const ipKey = ipKeyOf(clientIp(req));
  if (ipKey === "unknown") return refuse(env, "pre", "forbidden", req);
  const pre = await limit(env, "pre_ip", ipKey);
  if (pre) return refuse(env, "pre", pre.code, req);

  // Protocol routes: method, path and host from PROTOCOL_ROUTES (9A.3.1).
  // Their own checks (the consent POST's Sec-Fetch-Site, 4.5) replace Origin.
  const path = url.pathname;
  const proto = PROTOCOL_ROUTES.filter((r) => r.path === path);
  if (proto.length > 0) {
    const here = proto.filter((r) => r.host === host);
    if (here.length === 0) return notFound();
    if (!here.some((r) => r.method === req.method))
      return methodNotAllowed(here.map((r) => r.method).join(", "));
    return guard(() =>
      path === "/mcp"
        ? handleMcp(req, env, ctx, { oauthPrincipal })
        : handleOAuth(req, env, ctx),
    );
  }
  if (isOAuthPath(path)) return notFound();

  // Browser writes: Origin before authn (4.2).
  if (host === "admin" || host === "signup") {
    const o = checkOrigin(req, env, host);
    if (o) return refuse(env, "csrf", o.code, req);
  }

  // The sign-up host: its page, its sign-in and two small reads, then the
  // three contract routes in SIGNUP_ROUTES (no admin SPA, no other route).
  if (host === "signup") {
    const page = signupStatic(req, path);
    if (page) return page;
    if (req.method === "GET" && path === "/api/v1/config")
      return signupConfig(env);
    const auth = signupAuthRoute(req, env, path, signin);
    if (auth) return guard(() => auth);
    if (req.method === "GET" && path === "/api/v1/signup") {
      const p = await signupPrincipal(req, env, Date.now());
      if (isRefusal(p)) return refuse(env, "auth", p.code, req);
      const r = await limitRoute(env, "read", p, "signup");
      if (r) return refuse(env, "auth", r.code, req);
      return guard(() => signupStatus(env, p));
    }
    if (path === "/api/v1/contact") {
      if (req.method !== "POST") return methodNotAllowed("POST");
      return guard(() => submitContact(req, env, clientIp(req), Date.now()));
    }
    if (path === "/api/v1/signup/waitlist") {
      if (req.method !== "POST") return methodNotAllowed("POST");
      return guard(() => joinWaitlist(req, env, Date.now()));
    }
  }

  if (host === "admin" && path === CLAIM_FREE_PATH) {
    if (req.method !== "POST") return methodNotAllowed("POST");
    return claimFreeRoute(req, env, clientIp(req));
  }

  const betaPath = host === "admin" ? BETA_PATH_RE.exec(path) : null;
  if (betaPath)
    return betaRoute(req, env, clientIp(req), betaPath[1] ?? "", url);
  const bizPath = host === "admin" ? BUSINESS_PATH_RE.exec(path) : null;
  if (bizPath)
    return betaRoute(
      req,
      env,
      clientIp(req),
      bizPath[1] ?? "",
      url,
      businessApi,
    );

  const tierPath = host === "admin" ? SET_TIER_PATH_RE.exec(path) : null;
  if (tierPath) {
    if (req.method !== "POST") return methodNotAllowed("POST");
    return setTierRoute(req, env, clientIp(req), tierPath[1]);
  }

  const m = matchRoute(host, req.method, path);
  if (m)
    return isApiRoute(m.route)
      ? apiRoute(req, env, ctx, host, m.route, m.params, url)
      : guard(() => browserRoute(req, env, m.route as BrowserRouteId, signin));
  if (
    host === "admin" &&
    !path.startsWith("/api/") &&
    !path.startsWith("/v1/") &&
    !path.startsWith("/auth/")
  )
    return guard(() => env.ASSETS.fetch(req));
  return notFound();
}

async function apiRoute(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  host: HostKind,
  route: ApiRouteId,
  params: Record<string, string>,
  url: URL,
): Promise<Response> {
  const p = await authenticate(req, env, host);
  if (isRefusal(p)) return refuse(env, "auth", p.code, req);
  if (host === "admin" || host === "signup") {
    const c = checkCsrf(req, env, p);
    if (c) return refuse(env, "csrf", c.code, req);
  }
  return guard(async () => {
    // Writes with a body: application/json, 16 KiB, then JSON (3.1), read
    // by invokeRoute after the rate limit and authz (4.2).
    const def = ROUTES[route];
    const body =
      def.method !== "GET" && bodyKeys(def).size > 0
        ? new LazyBody(() => readJsonBody(req))
        : undefined;
    const r = await invokeRoute(
      env,
      ctx,
      p,
      route,
      { params, query: Object.fromEntries(url.searchParams), body },
      { kind: "http", client: { ip: clientIp(req), host: url.hostname } },
    );
    return new Response(r.body === null ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...r.headers,
      },
    });
  });
}

/**
 * Operator-only: free a kept sign-up claim (#52). Admin host, so Origin was
 * checked; authn, CSRF and the write limit run here like apiRoute, and
 * freeClaim admits an admin session only.
 */
async function claimFreeRoute(
  req: Request,
  env: Env,
  ip: string,
): Promise<Response> {
  const p = await authenticate(req, env, "admin");
  if (isRefusal(p)) return refuse(env, "auth", p.code, req);
  const c = checkCsrf(req, env, p);
  if (c) return refuse(env, "csrf", c.code, req);
  return guard(async () => {
    const rl = await limit(env, "write", p.rateKey);
    if (rl) throw new ApiError(rl.code);
    const r = await freeClaim(env, p, await readJsonBody(req), ip);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });
}

/**
 * The private beta's admin API (#2096). Admin host, so Origin was checked;
 * authn, CSRF and the read or write limit run here like claimFreeRoute, and
 * betaApi admits an admin session only.
 */
async function betaRoute(
  req: Request,
  env: Env,
  ip: string,
  sub: string,
  url: URL,
  api: typeof betaApi = betaApi,
): Promise<Response> {
  const p = await authenticate(req, env, "admin");
  if (isRefusal(p)) return refuse(env, "auth", p.code, req);
  const c = checkCsrf(req, env, p);
  if (c) return refuse(env, "csrf", c.code, req);
  return guard(async () => {
    const read = req.method === "GET";
    const rl = await limit(env, read ? "read" : "write", p.rateKey);
    if (rl) throw new ApiError(rl.code);
    const r = await api(
      env,
      p,
      { method: req.method, sub, url, body: () => readJsonBody(req) },
      ip,
    );
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });
}

/**
 * Operator-only: set an install's billing tier (#66). Admin host, so Origin
 * was checked; authn, CSRF and the write limit run here like apiRoute, and
 * setTier admits an admin session only on this surface (bearers never
 * authenticate on the admin host).
 */
async function setTierRoute(
  req: Request,
  env: Env,
  ip: string,
  installId: string | undefined,
): Promise<Response> {
  const p = await authenticate(req, env, "admin");
  if (isRefusal(p)) return refuse(env, "auth", p.code, req);
  const c = checkCsrf(req, env, p);
  if (c) return refuse(env, "csrf", c.code, req);
  return guard(async () => {
    const rl = await limit(env, "write", p.rateKey);
    if (rl) throw new ApiError(rl.code);
    const r = await setTier(env, p, installId, await readJsonBody(req), {
      kind: "http",
      ip,
    });
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });
}
