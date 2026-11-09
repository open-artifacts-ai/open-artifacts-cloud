import type { Env } from "../env.js";

// The one reader of the admin session lifetime. The session cookie, the
// session row, an OAuth grant's end and its refresh chain all take their
// length from adminSessionTtlMs, so they cannot drift apart: a grant and its
// refresh never outlive the session.

/** The lifetime everywhere: 8 h absolute (design v7 4.5, Q3). */
export const SESSION_TTL_MS = 8 * 3600_000;
/** The longest a staging session may be set to. */
export const ADMIN_SESSION_TTL_MAX_HOURS = 168;

/**
 * The admin session lifetime in ms. Only staging honours
 * ADMIN_SESSION_TTL_HOURS, and only as a whole number of hours from 1 to
 * 168. Anything else (prod with the var set, empty, zero, negative, a
 * fraction, text, above 168) is exactly 8 h. It never throws.
 */
export function adminSessionTtlMs(
  env: Pick<Env, "OA_ENV"> & { ADMIN_SESSION_TTL_HOURS?: unknown },
): number {
  const raw = env.ADMIN_SESSION_TTL_HOURS;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,2}$/.test(raw))
    return SESSION_TTL_MS;
  const hours = Number(raw);
  return hours <= ADMIN_SESSION_TTL_MAX_HOURS
    ? hours * 3600_000
    : SESSION_TTL_MS;
}
