// The Provisioning API's scheduler duties (design v7 5.8), run on the */2
// tick after the revoke tick and the directory sync. The fleet duty runs on
// its own minute cron instead (fleetCronTick, cloud #264).
import { ALERT_KEYS } from "@oa/provisioning-contract/enum-values";
import { trialRemindersDue } from "../trial-reminder.js";
import { alertFor, factsOf, prodcleanReport, stepAlert } from "./alerts.js";
import { alertConditions, signupDailyCap } from "./conditions.js";
import type { ProvapiEnv } from "./env.js";
import {
  FLEET_TICK_TIMEOUT_MS,
  type FleetOptions,
  fleetTick,
} from "./fleet.js";
import { type HealthProbe, healthDue } from "./health.js";
import { prune } from "./prune.js";
import { purgeDue } from "./purge.js";
import { type Duty, type DutyOutcome, runDuties } from "./run.js";
import { signupsDue } from "./signups.js";
import { soloStartMissingAlert } from "./solo-start.js";
import { type SweepDeps, sweep } from "./sweep.js";

export { SCHEDULER_TICK_KEY } from "@oa/provisioning-contract/state";
export type { ProvapiEnv } from "./env.js";
export { writeTick } from "./run.js";

/**
 * Each 2-minute duty's budget: 94.5 s together, inside the 2 minutes.
 * Ticks may still overlap (a slow D1 call); every duty's writes are guarded
 * for that.
 * The fleet duty has its own cron and budget (FLEET_TICK_TIMEOUT_MS).
 */
export const DUTY_TIMEOUT_MS = {
  sweep: 20_000,
  signups: 5_000,
  reminders: 4_500,
  purge: 10_000,
  health: 20_000,
  alerts: 30_000,
  prune: 5_000,
} as const satisfies Record<Exclude<Duty["name"], "fleet">, number>;

/** The scheduler opens and clears every alert here, and only here. */
export async function alertsTick(env: ProvapiEnv, now: number): Promise<void> {
  const c = await alertConditions(
    env.PLATFORM_DB,
    env.PROVISIONER,
    { now, signupDailyCap: signupDailyCap(env.SIGNUP_DAILY_CAP) },
    {
      versionMetadata: env.CF_VERSION_METADATA,
      fleetCanary: env.FLEET_CANARY,
      fleetSmoke: env.FLEET_SMOKE,
      fleetSoakMin: env.FLEET_SOAK_MIN,
    },
  );
  for (const k of ALERT_KEYS) {
    const cond = c[k];
    const report =
      k === "prodclean_failed" && cond.open
        ? await prodcleanReport(env.PLATFORM_DB)
        : undefined;
    const facts = {
      ...factsOf(cond.rows),
      ...(cond.daysLeft === undefined ? {} : { daysLeft: cond.daysLeft }),
      ...(report === undefined ? {} : { report }),
    };
    // stepAlert never throws: one key's failure never stops the next.
    await stepAlert(env, alertFor(k, env.OA_ENV, facts), cond.open, now);
  }
  // Local to this repo (not in the public ALERT_KEYS): never throws.
  await soloStartMissingAlert(env, now);
}

export interface ProvapiOptions extends SweepDeps {
  /** Tests only: per-duty budgets. */
  timeoutMs?: Partial<Record<Duty["name"], number>>;
  /** Tests only: the /healthz request (default publicRouteProbe). */
  healthProbe?: HealthProbe;
}

/**
 * The fleet cron's one duty (index.ts FLEET_CRON): fleetTick, bounded by
 * FLEET_TICK_TIMEOUT_MS and isolated like the 2-minute duties, so a failure logs
 * `provapi fleet failed <category>`. Never throws.
 */
export function fleetCronTick(
  env: ProvapiEnv,
  now: number,
  o: { fleet?: FleetOptions; timeoutMs?: number } = {},
): Promise<Record<string, DutyOutcome>> {
  return runDuties([
    {
      name: "fleet",
      timeoutMs: o.timeoutMs ?? FLEET_TICK_TIMEOUT_MS,
      run: () => fleetTick(env, now, o.fleet),
    },
  ]);
}

/**
 * Sweep, signups, trial reminders, purge, health, alerts, prune: in that
 * order, so the alerts read the tick's own sweep, purge and health writes
 * (and the fleet cron's latest). Never throws.
 */
export function provapiTick(
  env: ProvapiEnv,
  now: number,
  o: ProvapiOptions = {},
): Promise<Record<string, DutyOutcome>> {
  const t = { ...DUTY_TIMEOUT_MS, ...o.timeoutMs };
  const sweepDeps: SweepDeps = o.settleFailed
    ? { settleFailed: o.settleFailed }
    : {};
  return runDuties([
    {
      name: "sweep",
      timeoutMs: t.sweep,
      run: () => sweep(env, now, sweepDeps),
    },
    {
      name: "signups",
      timeoutMs: t.signups,
      run: () => signupsDue(env, now),
    },
    {
      name: "reminders",
      timeoutMs: t.reminders,
      run: () => trialRemindersDue(env, now),
    },
    { name: "purge", timeoutMs: t.purge, run: () => purgeDue(env, now) },
    {
      name: "health",
      timeoutMs: t.health,
      run: async () => {
        await healthDue(env, now, {
          budgetMs: t.health,
          ...(o.healthProbe ? { probe: o.healthProbe } : {}),
        });
      },
    },
    { name: "alerts", timeoutMs: t.alerts, run: () => alertsTick(env, now) },
    { name: "prune", timeoutMs: t.prune, run: () => prune(env, now) },
  ]);
}
