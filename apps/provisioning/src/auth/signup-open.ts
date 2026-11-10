import { signSilentTicket } from "@oa/auth-core";
import type { Env } from "../env.js";
import { limitRoute } from "../limits.js";
import { isRefusal } from "../principal.js";
import { refuse } from "../refuse.js";
import { randomToken } from "./crypto.js";
import { checkCsrf, checkOrigin } from "./csrf.js";
import { signupPrincipal } from "./signup-session.js";

// POST /auth/open on the sign-up host (#2026): "Open your instance" without a
// second Google sign-in. It mints a silent ticket (a permission to ATTEMPT
// prompt=none at the auth broker, never a login credential) and answers with
// the instance URL that carries it. Target install, origin and sub come only
// from the caller's own ready signups row; the request body is never read.

/** Oldest instance release that passes `silent` through to the broker. */
export const SILENT_MIN_VERSION = "0.149.0";
/** Under the broker's 60 s ceiling, with room for clock skew. */
export const SILENT_TICKET_LIFETIME_MS = 45_000;
const GATE_NOTE = "no-store";

const parse = (v: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(-[^+]*)?(?:\+.*)?$/.exec(v);
  return m
    ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== undefined }
    : null;
};
/** True iff `version` is a release >= `min` (a prerelease of `min` is below it). */
export function versionAtLeast(version: string | null, min: string): boolean {
  const a = version ? parse(version) : null;
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const x = a.n[i] as number;
    const y = b.n[i] as number;
    if (x !== y) return x > y;
  }
  return !a.pre || b.pre;
}

type Row = { id: string; app_host: string; version: string | null };

/** The caller's own newest self-serve sign-up, when it is ready and live. */
const readyInstall = (env: Env, sub: string) =>
  env.PLATFORM_DB.prepare(
    `SELECT i.id AS id, i.app_host AS app_host, i.version AS version
     FROM signups s JOIN installs i ON i.id = s.install_id
     WHERE s.signup_id = (SELECT signup_id FROM signups
         WHERE source = 'self-serve' AND owner_sub = ?1
         ORDER BY created_at DESC, signup_id DESC LIMIT 1)
       AND s.status = 'ready' AND i.state = 'active'`,
  )
    .bind(sub)
    .first<Row>();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": GATE_NOTE },
  });

export async function openInstance(
  req: Request,
  env: Env,
  now: number,
): Promise<Response> {
  // Exact Origin (also checked ahead of routing), session, then CSRF.
  const o = checkOrigin(req, env, "signup");
  if (o) return refuse(env, "csrf", o.code, req);
  const p = await signupPrincipal(req, env, now);
  if (isRefusal(p)) return refuse(env, "auth", p.code, req);
  const c = checkCsrf(req, env, p);
  if (c) return refuse(env, "csrf", c.code, req);
  const lim = await limitRoute(env, "write", p, "signup_open");
  if (lim) return refuse(env, "auth", lim.code, req);

  const row = await readyInstall(env, p.sub as string);
  if (!row) return json({ error: "not_ready" }, 404);
  const origin = `https://${row.app_host}`;
  const plain = { url: `${origin}/`, silent: false };
  // Until the instance runs a release that passes `silent` on, or without the
  // signing key, the plain link: never a broken link.
  const key = env.SIGNUP_BROKER_KEY;
  if (!key || !versionAtLeast(row.version, SILENT_MIN_VERSION))
    return json(plain);
  let ticket: string;
  try {
    ticket = await signSilentTicket(key, {
      install: row.id,
      aud: origin,
      sub: p.sub as string,
      exp: now + SILENT_TICKET_LIFETIME_MS,
      nonce: randomToken(16),
    });
  } catch {
    return json(plain);
  }
  const u = new URL(`${origin}/auth/login/google`);
  u.search = new URLSearchParams({ silent: ticket, next: "/" }).toString();
  return json({ url: u.toString(), silent: true });
}
