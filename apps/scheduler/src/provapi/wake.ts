// The fleet wake (cloud #264). Leo: "Everything should be event-based, push,
// never PULL (no waits, sleeps, polls)". Two kinds of message reach
// oa-<p>-fleet-wake, and this Worker is its only consumer:
// - the platform deploy's last step, once it has marked the release
//   verified (scripts/ci/fleet-wake.sh);
// - every ManageInstall job's end, done or failed (the provisioner's
//   fleet_wake step): the canary's upgrade, each of the rest's, and any job
//   that leaves an install idle.
// Each batch is one fleet pass (fleetTick), under the same lease as the
// 2-minute tick's fleet duty, with every safety check the pass has: the
// verified mark, the canary first, the halts, the smoke. So the canary's
// upgrade starts on the deploy's message; its end probes it. With a queue producer, the smoke runs
// on its own delivery and its completion wakes the fleet. Without a producer,
// the legacy pass runs the smoke inline; the last of the rest to end writes fleet_done:<version>, which the
// next prod deploy records. Nothing waits: a pass that only time can finish
// (a probe or smoke to repeat, the lease held, a failed run) asks its message
// back with a backoff, the one wait allowed. Every other message is acked:
// what is left ends with a job, and that job's end is the next message.
//
// Where the canary smoke is required no tick runs the fleet (cloud
// #264). Every pass reads the whole fleet from state, so a lost message (a
// job-end send that ran out of retries, a wake out of deliveries) is
// recovered by the next event of any kind: another job's end, the next
// deploy's wake. Past that, a stuck rollout is OA Manager L-2's to catch, the
// release watcher Leo named; the alerts (canary_blocked, fleet_halted,
// version_skew) still open off the tick's alert marks (fleetMarks). No timer
// is added for it. Where the smoke is off, the 2-minute tick keeps
// its fleet duty for the passive soak (provapi/index.ts tickRunsFleet).
//
// A canary_smoke message runs outside the bounded fleet pass. A passing job
// persists its result and sends smoke_finished; that wake reads fleet state.

import { SYSTEM_ACTOR } from "@oa/provisioning-contract/system";
import type { FleetEnv, FleetOptions, FleetRun } from "./fleet.js";
import {
  fleetCanary,
  fleetTarget,
  fleetTick,
  runQueuedSmoke,
} from "./fleet.js";
import { type DutyOutcome, runDuties } from "./run.js";

/**
 * A wake pass's deadline: room for a probe at its full timeout (8 s), the
 * catalog read (5 s), fleet inserts and, where still enabled, the inline smoke.
 * A queued smoke runs outside this deadline.
 */
export const FLEET_WAKE_DEADLINE_MS = 50_000;
/**
 * The wake run's bound (runDuties): the deadline plus a slow D1 call. Under
 * FLEET_LEASE_MS, so the lease outlives the run, and far under the 15 min a
 * queue consumer may run.
 */
export const FLEET_WAKE_TIMEOUT_MS = 60_000;
/**
 * The retry backoff: 1 s after the first delivery, doubling, at most
 * FLEET_WAKE_BACKOFF_MAX_S. A canary whose new version is not yet served is
 * probed again 1, 2, 4, 8, 16 and 32 s on, and the probe at 63 s, past
 * FLEET_FAIL_GAP_MS, halts it, as before.
 */
export const FLEET_WAKE_BACKOFF_MAX_S = 60;
/**
 * The queue's max_retries (apps/scheduler/wrangler.jsonc, both envs; the
 * config test pins them equal): 1 + 2 + ... + 32 s, then 14 retries at 60 s,
 * about 15 min, after which the message is acked; the next event of any kind
 * picks the fleet up from state (and, smoke off, the tick's fleet duty).
 */
export const FLEET_WAKE_MAX_RETRIES = 20;

/** The delay before delivery `attempts + 1`, in seconds. */
export const wakeBackoffS = (attempts: number): number =>
  Math.min(FLEET_WAKE_BACKOFF_MAX_S, 2 ** Math.max(0, attempts - 1));

export interface WakeOptions {
  /** Tests only: the fleet pass's probe, clock and smoke. */
  fleet?: FleetOptions;
  /** Tests only: the run's bound (default FLEET_WAKE_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** What one batch did: the run's outcome, or "held" when the lease was. */
export type WakeOutcome = DutyOutcome | "held";

/**
 * One batch of oa-<p>-fleet-wake: one fleet pass for the whole batch. When
 * only time can finish what it left (FleetRun.again), the lease was held or
 * the run failed, the message with the fewest deliveries (and retries left)
 * comes back after wakeBackoffS; the rest are acked, so duplicates collapse
 * into one chain. Otherwise every message is acked. The decision is recorded before acknowledgment, so a failed audit write
 * leaves the batch available for redelivery.
 */
export async function fleetWake(
  batch: MessageBatch<unknown>,
  env: FleetEnv,
  now: number,
  o: WakeOptions = {},
): Promise<WakeOutcome> {
  const wakes: Message<unknown>[] = [];
  for (const message of batch.messages) {
    const body = message.body;
    if (
      !body ||
      typeof body !== "object" ||
      !("kind" in body) ||
      body.kind !== "canary_smoke"
    ) {
      wakes.push(message);
      continue;
    }
    const again = await runQueuedSmoke(
      env,
      "target" in body ? body.target : null,
      "canary" in body ? body.canary : null,
      now,
      message.attempts <= FLEET_WAKE_MAX_RETRIES,
      o.fleet?.smoke,
    );
    if (again) message.retry({ delaySeconds: wakeBackoffS(message.attempts) });
    else message.ack();
  }
  if (wakes.length === 0) return "ok";
  let run: FleetRun | null | undefined;
  const out = await runDuties([
    {
      name: "fleet",
      timeoutMs: o.timeoutMs ?? FLEET_WAKE_TIMEOUT_MS,
      run: async () => {
        run = await fleetTick(env, now, {
          deadlineMs: FLEET_WAKE_DEADLINE_MS,
          ...o.fleet,
        });
      },
    },
  ]);
  const outcome: WakeOutcome =
    run === null ? "held" : (out.fleet ?? "exception");
  const again = outcome !== "ok" || run?.again === true;
  let back: Message<unknown> | undefined;
  if (again)
    for (const m of wakes)
      if (
        m.attempts <= FLEET_WAKE_MAX_RETRIES &&
        (back === undefined || m.attempts < back.attempts)
      )
        back = m;
  const canary = fleetCanary(env.FLEET_CANARY);
  const detail = {
    check: run?.check,
    retried: back !== undefined,
    to: fleetTarget(env.CF_VERSION_METADATA),
    canary,
    decision: run?.pass ?? outcome,
    reason: run?.reason ?? (outcome === "held" ? "lease_held" : outcome),
  };
  await env.PLATFORM_DB.prepare(
    "INSERT INTO hosted_audit (at, actor, install_id, action, detail) VALUES (?1, ?2, ?3, 'fleet.wake', ?4)",
  )
    .bind(now, SYSTEM_ACTOR.key, canary ?? "-", JSON.stringify(detail))
    .run();
  for (const m of wakes) {
    if (m === back) m.retry({ delaySeconds: wakeBackoffS(m.attempts) });
    else m.ack();
  }
  console.log(
    "provapi fleet wake",
    outcome,
    `messages=${wakes.length}`,
    `retried=${back === undefined ? 0 : 1}`,
    `again=${again ? 1 : 0}`,
  );
  return outcome;
}
