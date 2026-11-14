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
