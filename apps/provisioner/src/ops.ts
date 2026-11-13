// What both Workflows do around WfpProvisioner: the job's provisioner with
// its options (directFetch, onStep, the broker switch and the Turnstile pair
// derived like the CLI's), the owner token sweep, the live HOSTS mode a fail
// step reconciles install_lifecycle.serving_mode to, and the installs row.
import {
  type Cf,
  cfClient,
  codesOn,
  directFetch,
  googleNewlyEnabled,
  HOSTED_DOMAINS,
  hostsKvTitle,
  names,
  parseHostsValue,
  type WfpOptions,
  WfpProvisioner,
  type WfpStep,
} from "@oa/provision";
import type { ServingMode } from "@oa/provisioning-contract";
import {
  deployEnv,
  type ProvisionerEnv,
  type ProvisionerIo,
  provisionerOptions,
  transient,
} from "./provisioner.js";
import { markStep } from "./steps.js";
import { turnstilePair } from "./turnstile.js";

export interface OpsEnv extends ProvisionerEnv {
  PLATFORM_DB: D1Database;
  /** The install's script before any HOSTS mapping (5.2 f, directFetch). */
  DISPATCHER: DispatchNamespace;
}
export type OpsCtx = { env: OpsEnv; io: ProvisionerIo };

/** The installs row columns the Workflows read (never owner_email). */
export type InstallRowLite = {
  id: string;
  slug: string;
  app_host: string;
  content_host: string;
  state: string;
  version: string | null;
  previous_version: string | null;
  test_hooks: number;
  vars: string | null;
  lease: string | null;
  lease_until: number | null;
};

export async function installRow(
  ctx: OpsCtx,
  id: string,
): Promise<InstallRowLite | null> {
  return transient(
    ctx.env.PLATFORM_DB.prepare(
      "SELECT id, slug, app_host, content_host, state, version, previous_version, test_hooks, vars, lease, lease_until FROM installs WHERE id = ?",
    )
      .bind(id)
      .first<InstallRowLite>(),
  );
}

/** The app host an install of `slug` gets in this env. */
export const appHostOf = (env: OpsEnv, slug: string): string =>
  `${slug}.${HOSTED_DOMAINS[deployEnv(env.OA_ENV)].app}`;

/**
 * The job's WfpProvisioner: owner token `ss-<signupId>` (or the job id's
 * label when the job has no signup), plus `extra`.
 */
export async function provisionerWith(
  ctx: OpsCtx,
  label: string,
  jobId: string,
  extra: Partial<WfpOptions> = {},
): Promise<WfpProvisioner> {
  const o = await provisionerOptions(ctx.env, label, ctx.io, jobId);
  return new WfpProvisioner({ ...o, ...extra });
}

/**
 * The rendering options of a create, upgrade or rollback (5.3, 5.4): the
 * install's script through DISPATCHER only, each WFP_STEPS step written to
 * the job, `brokerEnabled = googleNewlyEnabled({}, vars)`, and the widget
 * pair whenever codes are on (a test-hooks install gets provision's test
 * pair instead).
 */
export async function renderOptions(
  ctx: OpsCtx,
  o: {
    jobId: string;
    label: string;
    installId: string;
    appHost: string;
    vars: Record<string, string>;
    testHooks: boolean;
    registryDisabled?: boolean;
    /**
     * upgrade, rollback: the lease the operation claimed, read at the first
     * step report (5.4 fail). Run-local: jobs.args stays the request (8.3).
     */
    onClaim?: (lease: string | null) => void;
  },
): Promise<WfpProvisioner> {
  const e = deployEnv(ctx.env.OA_ENV);
  const base = await provisionerOptions(ctx.env, o.label, ctx.io, o.jobId);
  const turnstile =
    codesOn(o.vars) && !o.testHooks
      ? await turnstilePair(base.cf, e)
      : undefined;
  let claimed = false;
  return new WfpProvisioner({
    ...base,
    fetch: directFetch(ctx.env.DISPATCHER, {
      appHost: o.appHost,
      script: names(o.installId, e).script,
    }),
    onStep: async (s: WfpStep) => {
      // The first report comes right after the claim: the lease is ours.
      if (o.onClaim && !claimed) {
        claimed = true;
        o.onClaim((await installRow(ctx, o.installId))?.lease ?? null);
      }
      await markStep(ctx, o.jobId, s);
    },
    brokerEnabled: googleNewlyEnabled({}, o.vars),
    ...(turnstile ? { turnstile } : {}),
    ...(o.registryDisabled ? { registryDisabled: true } : {}),
  });
}

/**
 * The install's system job that closes its open WebSockets (apps/server
 * cron.ts CLOSE_SOCKETS_CRON, #1182). Called on the install's script through
 * DISPATCHER with .scheduled( only, as the scheduler does: no HTTP route.
 */
export const CLOSE_SOCKETS_JOB = "oa:close-sockets";
/** One close-sockets call, at most; the suspend never waits longer. */
export const CLOSE_SOCKETS_TIMEOUT_MS = 15_000;
/** The one log line of a failed close: fixed text, a fixed category, no ids. */
export const CLOSE_SOCKETS_FAILED = "suspend close_sockets failed";

/** As the scheduler's (measured): resolves undefined on success, rejects on a throw. */
interface ScheduledFetcher {
  scheduled(o: { cron?: string; scheduledTime?: Date }): Promise<unknown>;
}

/** What a system-job call came to. */
export type SystemJobOutcome = "ok" | "throw" | "timeout" | "outcome";
/** What a close-sockets call came to. */
export type CloseSocketsOutcome = SystemJobOutcome;

/**
 * Calls one of the install's system jobs through DISPATCHER with .scheduled(
 * only. Never throws: it returns the category. Bounded by timeoutMs.
 */
export async function callSystemJob(
  ctx: OpsCtx,
  installId: string,
  cron: string,
  timeoutMs: number,
): Promise<SystemJobOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const script = names(installId, deployEnv(ctx.env.OA_ENV)).script;
    const r = await Promise.race([
      (ctx.env.DISPATCHER.get(script) as unknown as ScheduledFetcher).scheduled(
        { cron, scheduledTime: new Date(ctx.io.now()) },
      ),
      new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), timeoutMs);
      }),
    ]);
    // A { outcome } result (the experimental types) is read defensively.
    return r === "timeout"
      ? "timeout"
      : r === undefined || (r as { outcome?: unknown } | null)?.outcome === "ok"
        ? "ok"
        : "outcome";
  } catch {
    // Never the error text: it can carry the install's own message.
    return "throw";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Close-sockets attempts per suspend (the marker write may fail once). */
export const CLOSE_SOCKETS_ATTEMPTS = 3;
/** Backoff before attempt n+1: n * this. */
export const CLOSE_SOCKETS_BACKOFF_MS = 500;

/**
 * After a suspend's HOSTS pause: asks the install to close every open
 * WebSocket (and, from #2387, write its bus suspend marker). Never throws:
 * the pause is the hard stop and this is cleanup, so a failure (an install on
 * a release without the job rejects it as unknown, a stall, an exception)
 * logs CLOSE_SOCKETS_FAILED with its category and the suspend goes on.
 * Retried up to CLOSE_SOCKETS_ATTEMPTS times while the outcome isn't "ok", so
 * a failed marker write gets another chance. Each call is bounded by
 * timeoutMs; the install does the fan-out itself, so one call per attempt.
 */
export async function closeInstallSockets(
  ctx: OpsCtx,
  installId: string,
  timeoutMs = CLOSE_SOCKETS_TIMEOUT_MS,
): Promise<CloseSocketsOutcome> {
  return (await closeInstallSocketsCounted(ctx, installId, timeoutMs)).outcome;
}

/** callSystemJob, retried up to `attempts` times (backoff n * CLOSE_SOCKETS_BACKOFF_MS) until ok. */
async function callWithRetry(
  ctx: OpsCtx,
  installId: string,
  cron: string,
  timeoutMs: number,
): Promise<{ outcome: SystemJobOutcome; attempts: number }> {
  let outcome: SystemJobOutcome = "throw";
  let attempts = 0;
  while (attempts < CLOSE_SOCKETS_ATTEMPTS) {
    if (attempts > 0)
      await ctx.io.sleep(attempts * CLOSE_SOCKETS_BACKOFF_MS).catch(() => {});
    attempts++;
    outcome = await callSystemJob(ctx, installId, cron, timeoutMs);
    if (outcome === "ok") break;
  }
  return { outcome, attempts };
}

/** closeInstallSockets, with the number of attempts it took. */
export async function closeInstallSocketsCounted(
  ctx: OpsCtx,
  installId: string,
  timeoutMs = CLOSE_SOCKETS_TIMEOUT_MS,
): Promise<{ outcome: CloseSocketsOutcome; attempts: number }> {
  const r = await callWithRetry(ctx, installId, CLOSE_SOCKETS_JOB, timeoutMs);
  if (r.outcome !== "ok") console.warn(CLOSE_SOCKETS_FAILED, r.outcome);
  return r;
}

/** The install's system job that deletes the bus suspend marker (#2387). */
export const RESUME_JOB = "oa:resume";
export const RESUME_TIMEOUT_MS = 15_000;
export type ResumeOutcome = SystemJobOutcome;

/**
 * On resume, before the HOSTS flip to serving: asks the install to clear its
 * bus suspend marker, retried up to 3 times. Never throws and never fails the
 * resume: an install on a release without the job rejects it as unknown, and
 * that can't be told from a real failure (the error text isn't read). The
 * final outcome is audited.
 */
export async function clearInstallSuspendMarker(
  ctx: OpsCtx,
  installId: string,
  timeoutMs = RESUME_TIMEOUT_MS,
): Promise<{ outcome: ResumeOutcome; attempts: number }> {
  return callWithRetry(ctx, installId, RESUME_JOB, timeoutMs);
}

export const CLOSE_AUDIT_FAILED = "suspend close_sockets audit failed";

/**
 * Appends the suspend's socket-close outcome to admin_audit (the admin audit
 * read shows it): action suspend.close_sockets, code ok|throw|timeout|outcome.
 * Never throws: a failed write logs one fixed line and the suspend goes on.
 */
export async function auditCloseSockets(
  ctx: OpsCtx,
  installId: string,
  jobId: string,
  out: CloseSocketsOutcome,
  attempts?: number,
): Promise<void> {
  await auditSystemJob(
    ctx,
    "suspend.close_sockets",
    installId,
    jobId,
    out,
    attempts !== undefined && attempts > 1 ? `attempts=${attempts}` : null,
  );
}

/** Appends the resume's marker-clear outcome: action resume.clear_suspended. */
export async function auditResumeClear(
  ctx: OpsCtx,
  installId: string,
  jobId: string,
  out: ResumeOutcome,
  attempts: number,
): Promise<void> {
  await auditSystemJob(
    ctx,
    "resume.clear_suspended",
    installId,
    jobId,
    out,
    `attempts=${attempts}`,
  );
}

async function auditSystemJob(
  ctx: OpsCtx,
  action: string,
  installId: string,
  jobId: string,
  out: string,
  detail: string | null,
): Promise<void> {
  try {
    await ctx.env.PLATFORM_DB.prepare(
      "INSERT INTO admin_audit (at, actor_kind, actor_label, action, install_id, job_id, outcome, code, detail) VALUES (?1, 'system', 'provisioner', ?6, ?2, ?3, ?4, ?5, ?7)",
    )
      .bind(
        ctx.io.now(),
        installId,
        jobId,
        out === "ok" ? "ok" : "error",
        out,
        action,
        detail,
      )
      .run();
  } catch {
    console.warn(CLOSE_AUDIT_FAILED);
  }
}

/** The stored vars of an install (installs.vars), as strings. */
export function storedVars(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  const v = JSON.parse(raw) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(v).filter(
      (x): x is [string, string] => typeof x[1] === "string",
    ),
  );
}

/** Revokes the install's active `label` owner tokens; none before it exists. */
export async function sweepTokens(
  ctx: OpsCtx,
  label: string,
  installId: string,
  jobId: string,
): Promise<{ revoked: number }> {
  if (!(await installRow(ctx, installId))) return { revoked: 0 };
  const p = await provisionerWith(ctx, label, jobId);
  const { revoked } = await p.ciTokenSweep(installId, label);
  return { revoked };
}

/** A Cloudflare client on PROVISION_TOKEN, for reads outside an operation. */
export async function cfFor(ctx: OpsCtx): Promise<Cf> {
  deployEnv(ctx.env.OA_ENV);
  const token = await transient(ctx.env.PROVISION_TOKEN.get());
  return cfClient({
    accountId: ctx.env.ACCOUNT_ID,
    token,
    fetch: ctx.io.fetch,
    sleep: ctx.io.sleep,
  });
}

/** What dispatch serves for the install now (its app host's HOSTS value). */
export async function liveMode(
  ctx: OpsCtx,
  row: InstallRowLite,
): Promise<ServingMode> {
  const e = deployEnv(ctx.env.OA_ENV);
  const cf = await cfFor(ctx);
  const kv = await cf.kvFind(hostsKvTitle(e));
  if (!kv) return "unmapped";
  for (const h of [row.app_host, row.content_host]) {
    const v = parseHostsValue(await cf.kvGet(kv, h));
    if (v?.installId === row.id) return v.mode;
  }
  return "unmapped";
}

/** install_lifecycle.serving_mode, as the provisioner last wrote HOSTS. */
export function modeStatement(
  ctx: OpsCtx,
  installId: string,
  mode: ServingMode,
): D1PreparedStatement {
  return ctx.env.PLATFORM_DB.prepare(
    "UPDATE install_lifecycle SET serving_mode = ?2, updated_at = ?3 WHERE install_id = ?1",
  ).bind(installId, mode, ctx.io.now());
}

/**
 * A fail step's reconcile (5.5): the lifecycle's serving_mode set to the
 * live HOSTS mode, so D1 never shows less exposure than dispatch serves.
 * No installs row: nothing was ever routed. A Cloudflare error leaves it.
 */
export async function reconcile(
  ctx: OpsCtx,
  installId: string,
): Promise<D1PreparedStatement[]> {
  const row = await installRow(ctx, installId);
  if (!row) return [];
  try {
    return [modeStatement(ctx, installId, await liveMode(ctx, row))];
  } catch {
    return [];
  }
}
