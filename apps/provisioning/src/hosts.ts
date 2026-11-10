import type { Env } from "./env.js";

/**
 * The hosts of this Worker (2.2): cookies on admin, bearers on api, and the
 * public sign-up page on signup.<app> (its own host-only cookie and CSRF).
 */
export type HostKind = "admin" | "api" | "signup";

export function hostKind(hostname: string, env: Env): HostKind | null {
  const h = hostname.toLowerCase();
  if (h === `admin.${env.APP_DOMAIN}`) return "admin";
  if (h === `api.${env.APP_DOMAIN}`) return "api";
  if (h === `signup.${env.APP_DOMAIN}`) return "signup";
  return null;
}
