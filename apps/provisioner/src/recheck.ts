// The 2.5 rechecks (design v7 2.5, 5.1): the API's D1 binding is its real
// authority, so every row is a request, never a fact. A job's first step
// re-reads installs, install_lifecycle, signups and jobs, derives the state
// from the shared install_status view, checks the kind against TRANSITIONS,
// and for a create parses signups.vars with a strict schema. Any mismatch is
// `invalid_state`, terminal.
import type { NonRetryableError } from "cloudflare:workflows";
import {
  type Env as DeployEnv,
  OwnerVarsRefusal,
  ownerVars,
} from "@oa/provision";
import {
  canTransition,
  type InstallState,
  type JobKind,
  parseTestInstallActorKey,
  slugError,
  TEST_INSTALL,
  TEST_MEMBER,
  type TransitionActor,
  type TransitionFrom,
  testInstallOwns,
  testMemberOwns,
} from "@oa/provisioning-contract";
import { StepRefusal } from "./errors.js";
import { transient } from "./provisioner.js";
import { auditStatement, type JobRow, type StepCtx } from "./steps.js";

/**
 * A failed recheck: terminal, its message exactly invalid_state's fixed
 * text; `why` reaches only the redacted log line.
 */
export const refused = (why: string): NonRetryableError =>
  new StepRefusal("invalid_state", why);

/** The install_status view row a recheck reads (0008). */
export type StatusRow = {
  install_id: string;
  state: InstallState;
  source: "admin" | "self-serve";
  slug: string | null;
  app_host: string | null;
  content_host: string | null;
  version: string | null;
  previous_version: string | null;
  test_hooks: number | null;
  lease_until: number | null;
  install_state: string | null;
  signup_id: string | null;
  signup_status: string | null;
  serving_mode: string | null;
  suspended_at: number | null;
  deleted_at: number | null;
  purge_at: number | null;
  discarded_at: number | null;
  active_job_id: string | null;
};

export async function readStatus(
  ctx: StepCtx,
  installId: string,
): Promise<StatusRow | null> {
  return transient(
    ctx.env.PLATFORM_DB.prepare(
      "SELECT * FROM install_status WHERE install_id = ?",
    )
      .bind(installId)
      .first<StatusRow>(),
  );
}

/** TRANSITIONS' actor for a job's principal (5.1): OIDC acts as A. */
export function actorOf(kind: JobRow["actor_kind"]): TransitionActor {
  switch (kind) {
    case "admin":
    case "oidc":
      return "A";
    case "token":
      return "T";
    case "user":
      return "U";
    case "system":
      return "S";
    default:
      throw refused("unknown actor kind");
  }
}

/**
 * OIDC's scope (4.4, 5.1): staging only, and only an `rl-` install with test
 * hooks (or a disposable `t-` fixture install owned by the `test-install`
 * workflow). TRANSITIONS reads OIDC as A, so this is the rest of its check.
 */
export function checkOidcScope(
  job: JobRow,
  env: DeployEnv,
  install: {
    id?: string;
    slug: string | null;
    testHooks: boolean;
    createdBy?: string | null;
  },
): void {
  if (job.actor_kind !== "oidc") return;
  if (env !== "staging") throw refused("OIDC is staging only");
  if (job.actor_key.includes(TEST_INSTALL.actorSuffix)) {
    const scope = parseTestInstallActorKey(job.actor_key);
    if (!scope) throw refused("malformed fixture actor key");
    if (job.kind === "create") {
      if (
        scope.mode !== "create" ||
        !(install.slug ?? "").startsWith(TEST_INSTALL.slugPrefix) ||
        !install.testHooks
      )
        throw refused(
          "the fixture workflow creates only disposable t- test installs",
        );
      return;
    }
    const owned = testInstallOwns(
      {
        id: install.id ?? job.install_id,
        slug: install.slug ?? "",
        testHooks: install.testHooks,
        createdBy: install.createdBy,
      },
      scope,
    );
    if (job.kind === "redline_creds") {
      if (scope.mode !== "create" || !owned)
        throw refused(
          "the fixture workflow rotates TEST_HOOK_KEY only for its own create run",
        );
      return;
    }
    if (!["delete", "purge", "discard"].includes(job.kind) || !owned)
      throw refused(
        "the fixture workflow acts only on its owned disposable test install",
      );
    return;
  }
  if (!install.slug?.startsWith("rl-") || !install.testHooks)
    throw refused("OIDC acts only on rl- test installs");
  // The staging test member's workflow (authz TEST_MEMBER): one install only.
  if (
    job.actor_key.endsWith(TEST_MEMBER.actorSuffix) &&
    !testMemberOwns({ slug: install.slug, testHooks: install.testHooks })
  )
    throw refused("the test member acts only on its own install");
}

/** The kind is allowed from `from` for the job's actor (TRANSITIONS). */
export function checkTransition(
  from: TransitionFrom,
  kind: JobKind,
  job: JobRow,
): void {
  if (!canTransition(from, kind, actorOf(job.actor_kind)))
    throw refused(`${kind} is not allowed from ${from}`);
}

/** The job is open, of the Workflow that runs it, and of an allowed kind. */
export function checkJob(
  job: JobRow | null,
  workflow: JobRow["workflow"],
  kinds: readonly JobKind[],
): JobRow {
  if (!job) throw refused("no such job");
  if (job.workflow !== workflow || !kinds.includes(job.kind))
    throw refused(`a ${job.kind} job does not run here`);
  if (job.status !== "queued" && job.status !== "running")
    throw refused(`the job is ${job.status}`);
  return job;
}

/**
 * signups.vars under the strict schema (2.5 item 3), @oa/provision's
 * ownerVars: its refusals become the step's. `login` is a login change's
 * resulting vars (#2520); a create never passes it.
 */
export function strictVars(
  raw: string,
  o: {
    source: "admin" | "self-serve";
    selfServeTier: string;
    testHooks: boolean;
    env: DeployEnv;
    login?: boolean;
  },
): Record<string, string> {
  try {
    return ownerVars(raw, o);
  } catch (e) {
    if (e instanceof OwnerVarsRefusal)
      throw e.code === "domain_codes_refused"
        ? new StepRefusal("domain_codes_refused", e.why)
        : refused(e.why);
    throw e;
  }
}

/** A stored slug is still a valid, unreserved one. */
export function checkSlug(slug: unknown): string {
  if (typeof slug !== "string" || slugError(slug) !== null)
    throw refused("the slug is not valid");
  return slug;
}

/** The audit action for a token-actor job refused at its recheck (#1168). */
export const TOKEN_REFUSED_ACTION = "job.token_refused";

/** Why a token-actor job was refused; the audit row's `reason`. */
export type TokenRefusalReason =
  | "no_token"
  | "revoked"
  | "expired"
  | "session_ended";

type LiveRow = {
  revoked_at: number | null;
  expires_at: number;
  admin_email: string;
  s_kind: string | null;
  s_email: string | null;
  s_revoked_at: number | null;
  s_expires_at: number | null;
};

/**
 * #1168: a job whose actor is a token (T) was authorized at request time; its
 * Workflow runs later. The same liveness tokenPrincipal enforces per request,
 * minus ADMIN_IDENTITIES (this Worker has no such var): the job's agent_tokens
 * row exists, is not revoked and not past expires_at, and its admin session
 * (matched by session_hash) is an unrevoked, unexpired admin session of the
 * token's admin_email. Any failure is a terminal `invalid_state`, and a
 * `job.token_refused` audit row names the reason (no email, no token id).
 * Other actors are not touched.
 */
export async function checkTokenLive(ctx: StepCtx, job: JobRow): Promise<void> {
  if (job.actor_kind !== "token") return;
  const row = job.token_id
    ? await transient(
        ctx.env.PLATFORM_DB.prepare(
          `SELECT t.revoked_at, t.expires_at, t.admin_email, s.kind AS s_kind, s.email AS s_email,
s.revoked_at AS s_revoked_at, s.expires_at AS s_expires_at
FROM agent_tokens t LEFT JOIN sessions s ON s.id_hash = t.session_hash WHERE t.id = ?`,
        )
          .bind(job.token_id)
          .first<LiveRow>(),
      )
    : null;
  const now = ctx.io.now();
  let reason: TokenRefusalReason | null = null;
  if (!row) reason = "no_token";
  else if (row.revoked_at !== null) reason = "revoked";
  else if (row.expires_at <= now) reason = "expired";
  else if (
    row.s_kind !== "admin" ||
    row.s_revoked_at !== null ||
    row.s_expires_at === null ||
    row.s_expires_at <= now ||
    row.s_email?.toLowerCase() !== row.admin_email.toLowerCase()
  )
    reason = "session_ended";
  if (reason === null) return;
  await transient(
    auditStatement(
      ctx,
      job.install_id,
      TOKEN_REFUSED_ACTION,
      { jobId: job.id, kind: job.kind, reason },
      job.id,
    ).run(),
  );
  throw refused(`the job's token is not live (${reason})`);
}
