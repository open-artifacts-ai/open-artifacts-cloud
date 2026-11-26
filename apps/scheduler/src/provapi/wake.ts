// The fleet wake (cloud #264): the platform deploy's last step, once it has
// marked the release verified, posts one message to oa-<p>-fleet-wake, and
// this Worker, its only consumer, runs the fleet. It is the only thing that
// starts a fleet run: the 2-minute cron no longer runs the fleet. The run is
// fleetTick under the fleet lease, with a long deadline, so one run covers
// the canary's upgrade, its probe, its smoke, queueing the rest the moment
// the smoke passes, and watching the rest settle until the rollout is done
// (fleet_done:<version>, which the deploy reads). A canary upgrade takes 60
// to 75 s, an estimate from cloud #458; the rest upgrade at once. Every
// safety check is the pass's own: the canary first, the verified mark, the
// halts, the smoke.
//
// A run that fails, times out, finds the lease held, or ends with the
// rollout still unsettled (fleetSettled) asks the queue to deliver the
// message again, so the queue's retries carry the rollout on, not a timer.
// The queue's max_retries (apps/scheduler/wrangler.jsonc) bounds them; a
// rollout still stuck by then has its alert open already (fleet_halted's
// canary_blocked or platform_unverified, 45 min; version_skew).
//
// The body is never read: the fleet's target is this Worker's own version
// tag, so a message for an older release is just one more pass.
import { within } from "./env.js";
import type { FleetEnv, FleetOptions } from "./fleet.js";
import { fleetSettled, fleetTick } from "./fleet.js";
import { type DutyOutcome, runDuties } from "./run.js";

/**
 * The wake run's fleetFast deadline: room for the canary's upgrade (about 60
 * to 75 s, an estimate), its probe and smoke, then the rest's upgrades (about
 * as long again, all at once) and their probes, with margin. A rollout that
 * takes longer carries on in the message's next delivery.
 */
export const FLEET_WAKE_DEADLINE_MS = 280_000;
/**
 * The wake run's bound (runDuties): the deadline plus a slow last pass. Under
 * FLEET_LEASE_MS, so the lease outlives the run, and far under the 15 min a
 * queue consumer may run.
 */
export const FLEET_WAKE_TIMEOUT_MS = 290_000;
/**
 * A run that failed or left the rollout unsettled comes back this much later:
 * the pace of the 2-minute tick it replaces, so the smoke-off soak (passes at
 * most FLEET_SOAK_GAP_MS apart) and FLEET_FAIL_GAP_MS keep their meaning.
 */
export const FLEET_WAKE_RETRY_S = 120;
/**
 * A wake that finds the lease held (an earlier delivery still running, or a
 * killed run's lease, FLEET_LEASE_MS) comes back this much later.
 */
export const FLEET_WAKE_HELD_RETRY_S = 30;
/**
 * The queue's max_retries for oa-<p>-fleet-wake (wrangler.jsonc; a config
 * test pins the two equal). At FLEET_WAKE_RETRY_S apart that is an hour of
 * deliveries: past every rollout alert's window (FLEET_BLOCKED_MS and
 * fleetBlockedMs, 45 min), so a rollout still unsettled by the last one is
 * alerting already. The last delivery is acked, never retried.
 */
export const FLEET_WAKE_MAX_RETRIES = 30;
/** The settled read after a run: one D1 query. */
export const FLEET_WAKE_SETTLED_MS = 5_000;

export interface WakeOptions {
  /** Tests only: the fleet pass's probe, clock, sleep and smoke. */
  fleet?: FleetOptions;
  /** Tests only: the run's bound (default FLEET_WAKE_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** What one batch did: the run's outcome, or "held" when the lease was. */
export type WakeOutcome = DutyOutcome | "held";

/**
 * One batch of oa-<p>-fleet-wake: one fleet run for the whole batch. When
 * the run ended well and the rollout is settled (fleetSettled), every message
 * is acked. Otherwise (a failed or timed-out run, the lease held, the rollout
 * not settled) the message with the fewest deliveries asks to come back, in
 * FLEET_WAKE_HELD_RETRY_S when the lease was held and FLEET_WAKE_RETRY_S
 * otherwise, and the rest are acked, so duplicates collapse into one chain.
 * A message on its last delivery is acked. Never throws; logs one fixed line.
 */
export async function fleetWake(
  batch: MessageBatch<unknown>,
  env: FleetEnv,
  now: number,
  o: WakeOptions = {},
): Promise<WakeOutcome> {
  let held = false;
  const out = await runDuties([
    {
      name: "fleet",
      timeoutMs: o.timeoutMs ?? FLEET_WAKE_TIMEOUT_MS,
      run: async () => {
        held = !(await fleetTick(env, now, {
          deadlineMs: FLEET_WAKE_DEADLINE_MS,
          pollBatch: true,
          ...o.fleet,
        }));
      },
    },
  ]);
  const outcome: WakeOutcome = held ? "held" : (out.fleet ?? "exception");
  // Read only after a run that ended well: a failed one (D1 down, a hang)
  // is retried without another call. A failed read counts as unsettled.
  const settled =
    outcome === "ok" &&
    (await within(fleetSettled(env), FLEET_WAKE_SETTLED_MS).catch(() => {
      console.error("provapi fleet wake settled_unknown");
      return false;
    }));
  let next: Message<unknown> | null = null;
  if (!settled)
    for (const m of batch.messages)
      if (
        m.attempts <= FLEET_WAKE_MAX_RETRIES &&
        (next === null || m.attempts < next.attempts)
      )
        next = m;
  for (const m of batch.messages)
    if (m === next)
      m.retry({
        delaySeconds: held ? FLEET_WAKE_HELD_RETRY_S : FLEET_WAKE_RETRY_S,
      });
    else m.ack();
  console.log(
    "provapi fleet wake",
    outcome,
    `messages=${batch.messages.length}`,
    `retried=${next === null ? 0 : 1}`,
    `settled=${settled ? 1 : 0}`,
  );
  return outcome;
}
