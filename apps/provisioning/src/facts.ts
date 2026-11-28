import { parseBusSlugs } from "@oa/provision";
import type { TokenKind } from "@oa/provisioning-contract";
import type { Principal } from "./principal.js";

/**
 * The Principal fields W5a and W5b add to C4's type, by their branches'
 * names: `session` (W5a: admin and user sessions), `hd`, `tokenKind` and
 * `client` (W5b). Absent until those merge, then this cast is a no-op.
 */
export type PrincipalFacts = {
  session?: { csrf: string; expiresAt: number };
  hd?: string;
  tokenKind?: TokenKind;
  client?: string | null;
};

export const factsOf = (p: Principal): Principal & PrincipalFacts => p;

/** W5b's staging OIDC test users (`x-oa-test-user`) carry this sub prefix. */
export const TEST_USER_SUB_PREFIX = "rl-test-";

/** A staging OIDC test user (4.2 `test-users`); a Google sub is digits only. */
export const isTestUser = (p: Principal, env: { OA_ENV: string }) =>
  env.OA_ENV === "staging" &&
  p.kind === "user" &&
  (p.sub ?? "").startsWith(TEST_USER_SUB_PREFIX);

/**
 * The red-line gate's fixture installs are `rl-*` (cloud #297); hosted code
 * treats them as "not a real install" (no bus, no operator alerts). So a
 * person (admin session, token, self-serve user) may not take one. The gate's
 * own creates may: the OIDC principal (red-line), the staging test admin (kind "test-admin") and the
 * staging OIDC test users. Existing installs are not rechecked here.
 */
export const FIXTURE_SLUG_PREFIX = "rl-";
export const isFixtureSlugRefused = (
  p: Principal,
  env: { OA_ENV: string },
  slug: string,
) =>
  slug.startsWith(FIXTURE_SLUG_PREFIX) &&
  p.kind !== "oidc" &&
  p.kind !== "test-admin" &&
  !isTestUser(p, env);

/**
 * Staging test-install slugs eligible for admin-token test hooks (cloud #84):
 * disposable `t-*` fixtures and bus test fixtures (`bus-*` or `bus<digits>*`,
 * e.g. `bus1299-b`, never ordinary words like `business` or `bus`), plus any
 * explicit staging allowlist (such as `STAGING_BUS_SLUGS`, e.g. `m2-walk`).
 * Red-line `rl-*` slugs stay reserved above.
 */
export const TOKEN_TEST_HOOKS_SLUG_RE = /^(?:t-|bus(?:-|\d))/;
export const tokenTestHooksAllowlist = (env: {
  OA_ENV: string;
  STAGING_BUS_SLUGS?: string;
}): string[] =>
  env.OA_ENV === "staging" ? parseBusSlugs(env.STAGING_BUS_SLUGS) : [];
export const isTokenTestHooksSlug = (
  slug: string,
  allowlist: readonly string[] = [],
): boolean =>
  !slug.startsWith(FIXTURE_SLUG_PREFIX) &&
  (TOKEN_TEST_HOOKS_SLUG_RE.test(slug) || allowlist.includes(slug));
