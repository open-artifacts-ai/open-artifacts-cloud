import {
  type Pins,
  pinsFromEnv,
  type VerifyOptions,
  verify,
} from "@oa/gh-oidc";
import {
  fixtureOwnerKeyId,
  isFixtureOwnerPublicKey,
  type OidcWorkflow,
  TEST_INSTALL,
  TEST_MEMBER,
  testInstallActorKey,
  testInstallDeleteActorKey,
  verifyFixtureDeleteProof,
} from "@oa/provisioning-contract";
import type { Env } from "../env.js";
import { type Principal, type Refusal, refusal } from "../principal.js";

// The GitHub OIDC principal (design v7 4.4, Q1): staging only, on the
// staging api host only, with every OIDC_* var set (pinsFromEnv). Prod
// refuses it here, before any JWKS fetch, for the oidc kind and an
// `x-oa-test-user` caller alike; authorize() refuses kind oidc again. Any
// failure is 401 and never says why.

/** The one host that accepts an OIDC JWT. */
export const STAGING_API_HOST = "api.open-artifacts-staging.app";
/** `x-oa-test-user` turns the caller into a self-serve test user (M4). */
export const TEST_USER_HEADER = "x-oa-test-user";
/** Raw 32-byte Ed25519 public key (base64url) identifying a fixture's owner. */
export const FIXTURE_OWNER_KEY_HEADER = TEST_INSTALL.ownerKeyHeader;
/** Signed Ed25519 cleanup proof for deleting/purging a fixture in a later run. */
export const FIXTURE_DELETE_PROOF_HEADER = TEST_INSTALL.deleteProofHeader;
const RUN_ID_RE = /^\d{1,32}$/;
const TEST_USERS = new Set(["a", "b", "c"]);
export const TEST_USER_DOMAIN = "test.invalid";
/**
 * The one workflow whose JWT mints the staging test admin's session (R28,
 * #1053). It must also be in OIDC_JOB_WORKFLOW_REFS; its caller may call R28
 * and nothing else, and no other caller may call R28 (authorize).
 */
export const TEST_ADMIN_WORKFLOW_REF =
  "open-artifacts-ai/open-artifacts-cloud/.github/workflows/staging-test-admin.yml@refs/heads/main";

/**
 * The one workflow whose JWT may take the staging test member's credentials
 * (R26 on `rl-agents` only, then R15 and R2: TEST_MEMBER in authz). It must
 * also be in OIDC_JOB_WORKFLOW_REFS; it is never a test user, and its jobs
 * and sealed results are its own (actorKey `oidc:<repository_id>:test-member`).
 */
export const TEST_MEMBER_WORKFLOW_REF =
  "open-artifacts-ai/open-artifacts-cloud/.github/workflows/staging-test-member.yml@refs/heads/main";

/**
 * The pinned staging workflow for disposable test installs (TEST_INSTALL in
 * authz). Its JWT may create a `t-` test-hooks fixture and, when bound via
 * `x-oa-fixture-install-id`, read it, rotate its hook key (`hookKeyOnly`),
 * soft-delete and purge that exact install only. Never a test user.
 */
export const TEST_INSTALL_WORKFLOW_REF =
  "open-artifacts-ai/open-artifacts-cloud/.github/workflows/staging-test-install.yml@refs/heads/main";

/** Red-line's workflow (redline-staging.yml): the rl- test installs' scope. */
export const REDLINE_WORKFLOW_REF =
  "open-artifacts-ai/open-artifacts-cloud/.github/workflows/redline-staging.yml@refs/heads/main";

/**
 * Each pinned workflow's scope. A JWT whose job_workflow_ref is in
 * OIDC_JOB_WORKFLOW_REFS but not here is refused (401): no ref falls back to
 * red-line's scope.
 */
const WORKFLOW_SCOPES: ReadonlyMap<string, OidcWorkflow> = new Map([
  [REDLINE_WORKFLOW_REF, "redline"],
  [TEST_ADMIN_WORKFLOW_REF, "test-admin"],
  [TEST_MEMBER_WORKFLOW_REF, "test-member"],
  [TEST_INSTALL_WORKFLOW_REF, "test-install"],
]);

/** The caller's pins, or null unless staging and every OIDC_* var is set. */
export function oidcPins(env: Env): Pins | null {
  return env.OA_ENV === "staging" ? pinsFromEnv(env) : null;
}

/** `opts` is a test seam for gh-oidc's JWKS fetch and clock. */
export async function oidcPrincipal(
  req: Request,
  env: Env,
  jwt: string,
  opts?: VerifyOptions,
): Promise<Principal | Refusal> {
  const pins = oidcPins(env);
  if (!pins || new URL(req.url).hostname.toLowerCase() !== STAGING_API_HOST)
    return refusal("unauthenticated");
  let claims: Awaited<ReturnType<typeof verify>>;
  try {
    claims = await verify(jwt, pins, opts);
  } catch {
    return refusal("unauthenticated");
  }
  const workflow = WORKFLOW_SCOPES.get(claims.job_workflow_ref);
  if (workflow === undefined) return refusal("unauthenticated");
  const testAdmin = workflow === "test-admin";
  const testMember = workflow === "test-member";
  const testInstall = workflow === "test-install";
  const testUser = req.headers.get(TEST_USER_HEADER);
  if (testUser !== null) {
    // Only red-line's workflow may act as a test user.
    if (workflow !== "redline") return refusal("unauthenticated");
    if (!TEST_USERS.has(testUser)) return refusal("unauthenticated");
    const sub = `rl-test-${testUser}`;
    const email = `${sub}@${TEST_USER_DOMAIN}`;
    return {
      kind: "user",
      actorKey: `user:${sub}`,
      rateKey: `user:${sub}`,
      label: email,
      scopes: [],
      email,
      sub,
      hd: TEST_USER_DOMAIN,
      authAt: null,
    };
  }
  const key = `oidc:${claims.repository_id}`;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  let testInstallKey: string | null = null;
  let testInstallMode: "create" | "delete" | undefined;
  if (testInstall) {
    const runId = str(claims.run_id);
    if (!runId || !RUN_ID_RE.test(runId)) return refusal("unauthenticated");
    const rawOwnerKey = req.headers.get(TEST_INSTALL.ownerKeyHeader)?.trim();
    if (!isFixtureOwnerPublicKey(rawOwnerKey))
      return refusal("unauthenticated");
    const rawProof = req.headers.get(TEST_INSTALL.deleteProofHeader);
    if (rawProof !== null) {
      const verified = await verifyFixtureDeleteProof({
        ownerPublicKey: rawOwnerKey,
        proof: rawProof.trim(),
        repositoryId: claims.repository_id,
        now: opts?.now?.(),
      });
      if (!verified) return refusal("unauthenticated");
      testInstallMode = "delete";
      testInstallKey = testInstallDeleteActorKey(
        claims.repository_id,
        verified.ownerKeyId,
        verified.installId,
      );
    } else {
      const ownerKeyId = await fixtureOwnerKeyId(rawOwnerKey);
      testInstallMode = "create";
      testInstallKey = testInstallActorKey(
        claims.repository_id,
        runId,
        ownerKeyId,
      );
    }
  }
  // Each workflow gets its own actorKey: R26 jobs and sealed results (R15) are
  // isolated between red-line, test-member, and each fixture create/cleanup.
  const memberKey = `${key}${TEST_MEMBER.actorSuffix}`;
  const fixtureRateKey = `${key}${TEST_INSTALL.actorSuffix}`;
  const actorKey = testMember
    ? memberKey
    : testInstallKey !== null
      ? testInstallKey
      : key;
  const rateKey = testAdmin
    ? `${key}:test-admin`
    : testMember
      ? memberKey
      : testInstall
        ? fixtureRateKey
        : key;
  return {
    kind: "oidc",
    actorKey,
    // Its own bucket: R28, test-member, test-install and red-line stay isolated.
    rateKey,
    label: claims.repository,
    scopes: [],
    sub: claims.sub,
    authAt: null,
    oidcWorkflow: workflow,
    ...(testInstallMode ? { testInstallMode } : {}),
    ...(testAdmin
      ? {
          oidcRun: {
            actor: str(claims.actor),
            runId: str(claims.run_id),
            workflowRef: claims.job_workflow_ref,
          },
        }
      : {}),
  };
}
