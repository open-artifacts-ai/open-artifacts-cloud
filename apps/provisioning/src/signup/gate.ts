import type { Env } from "../env.js";
import { isTestUser } from "../facts.js";
import type { Principal } from "../principal.js";

// The private-beta gate (SIGNUPS_ENABLED=invite, #2096). The API is the gate:
// create refuses here, and the provisioner consumer and scheduler only see
// rows the API let through (as for test-users).

/** Lowercased, trimmed; what the allowlist stores and compares. */
export const normEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Whether `email` is on the allow list: an exact email entry, or a `@domain`
 * entry whose domain equals the part after the LAST '@' exactly (no suffix,
 * subdomain or look-alike matching). `emailVerified` must be true: an
 * unverified address is never allowed. Case-insensitive.
 */
export async function isAllowed(
  db: D1Database,
  email: string | null | undefined,
  emailVerified: boolean,
): Promise<boolean> {
  if (!emailVerified || !email) return false;
  const e = normEmail(email);
  const at = e.lastIndexOf("@");
  // A local part and a domain are both required ("@acme.com" is no email).
  if (at < 1 || at === e.length - 1) return false;
  const row = await db
    .prepare("SELECT 1 AS x FROM signup_allowlist WHERE entry IN (?1, ?2)")
    .bind(e, e.slice(at))
    .first();
  return row !== null;
}

export type Admission = "admitted" | "closed" | "not_invited";

/**
 * Whether the self-serve caller may create, by SIGNUPS_ENABLED. `test-users`
 * and `invite` admit the staging OIDC test users (isTestUser is staging only,
 * so prod never widens). `invite` also admits the allow list. The session's
 * email is Google-verified: sign-in refuses an unverified token.
 */
export async function admission(env: Env, p: Principal): Promise<Admission> {
  switch (env.SIGNUPS_ENABLED) {
    case "true":
      return "admitted";
    case "test-users":
      return isTestUser(p, env) ? "admitted" : "closed";
    case "invite":
      if (isTestUser(p, env)) return "admitted";
      return (await isAllowed(env.PLATFORM_DB, p.email, true))
        ? "admitted"
        : "not_invited";
    default:
      return "closed";
  }
}

export type Gate = "allowed" | "waitlist" | "waitlisted";

export const onWaitlist = async (db: D1Database, sub: string) =>
  (await db
    .prepare("SELECT 1 AS x FROM signup_waitlist WHERE sub = ?1")
    .bind(sub)
    .first()) !== null;

/**
 * What the sign-up page shows after sign-in: `allowed` (go to the address
 * step), `waitlist` (not on the list, not joined) or `waitlisted` (joined; a
 * declined row reads the same). Undefined while sign-ups are closed: the
 * config's `open` covers that.
 */
export async function gateOf(
  env: Env,
  p: Principal,
): Promise<Gate | undefined> {
  const a = await admission(env, p);
  if (a === "closed") return undefined;
  if (a === "admitted") return "allowed";
  return (await onWaitlist(env.PLATFORM_DB, p.sub ?? ""))
    ? "waitlisted"
    : "waitlist";
}
