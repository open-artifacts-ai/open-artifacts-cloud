// The fleet wake (cloud #264): the platform deploy's last step, once it has
// marked the release verified, posts one message to oa-<p>-fleet-wake, and
// this Worker, its only consumer, runs the fleet at once instead of waiting
// for the next 2-minute tick. The run is fleetTick, the same pass as the
// tick's fleet duty, under the same lease, with a longer deadline, so one run
// covers the canary's upgrade, its probe, its smoke, queueing the rest the
// moment the smoke passes, and watching the rest settle until the rollout is
// done (fleet_done:<version>, which the deploy reads). A canary upgrade takes
// 60 to 75 s, an estimate from cloud #458; the rest upgrade at once. Every
// safety check is the pass's own: the canary first, the verified mark, the
// halts, the smoke. The tick stays the backup: a lost, late or duplicate
// message changes nothing but when the next pass runs.
//
// The body is never read: the fleet's target is this Worker's own version
// tag, so a message for an older release is just one more pass.
import type { FleetEnv, FleetOptions } from "./fleet.js";
import { fleetTick } from "./fleet.js";
import { type DutyOutcome, runDuties } from "./run.js";

/**
 * The wake run's fleetFast deadline: room for the canary's upgrade (about 60
 * to 75 s, an estimate), its probe and smoke, then the rest's upgrades (about
 * as long again, all at once) and their probes, with margin. A rollout that
 * takes longer is finished by the 2-minute tick.
 */
export const FLEET_WAKE_DEADLINE_MS = 280_000;
/**
 * The wake run's bound (runDuties): the deadline plus a slow last pass. Under
 * FLEET_LEASE_MS, so the lease outlives the run, and far under the 15 min a
 * queue consumer may run.
 */
export const FLEET_WAKE_TIMEOUT_MS = 290_000;
/**
 * A wake that finds the lease held (the tick's fleet duty, at most about
 * 25 s, or an earlier wake) asks for one redelivery this much later, up to
 * FLEET_WAKE_MAX_ATTEMPTS deliveries; after that it is acked, and the tick
 * carries on.
 */
export const FLEET_WAKE_RETRY_S = 30;
export const FLEET_WAKE_MAX_ATTEMPTS = 3;

export interface WakeOptions {
  /** Tests only: the fleet pass's probe, clock, sleep and smoke. */
  fleet?: FleetOptions;
  /** Tests only: the run's bound (default FLEET_WAKE_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** What one batch did: the run's outcome, or "held" when the lease was. */
export type WakeOutcome = DutyOutcome | "held";

/**
 * One batch of oa-<p>-fleet-wake: one fleet run for the whole batch, then
 * every message acked. Only when the lease was held does one message (with
 * deliveries left) ask to come back in FLEET_WAKE_RETRY_S; the rest are
 * acked, so duplicates collapse into one run. A failed or timed-out run is
 * acked too: the tick is the backup. Never throws; logs one fixed line.
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
  let retried = 0;
  for (const m of batch.messages) {
    if (held && retried === 0 && m.attempts < FLEET_WAKE_MAX_ATTEMPTS) {
      m.retry({ delaySeconds: FLEET_WAKE_RETRY_S });
      retried++;
    } else m.ack();
  }
  console.log(
    "provapi fleet wake",
    outcome,
    `messages=${batch.messages.length}`,
    `retried=${retried}`,
  );
  return outcome;
}
