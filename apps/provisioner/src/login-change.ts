// The `update` kind's login variant (open-artifacts#2520 slice 3): an
// instance's own login-domain change. The provisioning Worker has already
// written installs.vars (compare-and-set) with the job and its audit row in
// one batch; this renders and redeploys that one install from those stored
// vars, through provision's updateVars. The job never touches another row.
//
// jobs.args is exactly { login: true }: the vars are not in the job, so a row
// is never a fact (2.5): the recheck parses installs.vars again under the
// same strict schema the route used (ownerVars, login on).
import { ProvisionRefused } from "@oa/provision";
import type { ManageJob } from "./manage.js";
import { installRow, renderOptions, storedVars } from "./ops.js";
import { deployEnv } from "./provisioner.js";
import { refused, strictVars } from "./recheck.js";
import type { CreateCtx } from "./workflow.js";

/** An `update` job's args as a login change, or false. Only { login: true } runs. */
export function isLoginJob(a: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return keys.length === 1 && a.login === true;
}

/** The job is the platform's own (system) and the install's vars still pass the login schema. */
export async function checkLoginJob(
  ctx: CreateCtx,
  job: { actor_kind: string },
  installId: string,
  source: "admin" | "self-serve",
  testHooks: boolean,
): Promise<void> {
  if (job.actor_kind !== "system")
    throw refused("a login change is the platform's own job");
  const row = await installRow(ctx, installId);
  if (!row || row.vars === null) throw refused("no installs vars");
  const vars = storedVars(row.vars);
  const owner: Record<string, string> = {};
  for (const k of [
    "AUTH_PROVIDERS",
    "TIER",
    "EMAIL_CODE_DOMAIN",
    "TEST_DOMAIN",
    "AUTH_DOMAIN_JOIN",
    "AUTH_DOMAIN_JOIN_SOURCE",
  ])
    if (vars[k] !== undefined) owner[k] = vars[k] as string;
  owner.AUTH_DOMAINS = vars.AUTH_DOMAINS ?? "";
  strictVars(JSON.stringify(owner), {
    source,
    selfServeTier: ctx.env.SELF_SERVE_TIER,
    testHooks,
    env: deployEnv(ctx.env.OA_ENV),
    login: true,
  });
}

/** updateVars with the stored vars: the install runs what installs.vars says. */
export async function loginRedeploy(
  ctx: CreateCtx,
  job: ManageJob,
  label: string,
): Promise<{ version: string }> {
  const row = await installRow(ctx, job.installId);
  if (!row) throw refused("no installs row");
  const vars = storedVars(row.vars);
  const w = await renderOptions(ctx, {
    jobId: job.jobId,
    label,
    installId: job.installId,
    appHost: row.app_host,
    vars,
    testHooks: row.test_hooks === 1,
    registryDisabled: job.registryDisabled,
  });
  const r = await w.updateVars(job.installId, vars);
  // The new vars are live but a check after them failed: a person looks.
  if (!r.ok)
    throw new ProvisionRefused(
      "the checks after the var change failed",
      "upgrade_incomplete",
    );
  return { version: r.version };
}
