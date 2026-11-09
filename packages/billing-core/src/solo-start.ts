// What billing's provisioner RPC (BillingProvisionerRpc.soloStart, #1568)
// answers: a plain, serialisable union. It never throws for an expected
// outcome; anything unexpected is { ok: false, error: "unavailable",
// retryable: true }.

/** The tier answer, as billing reports an install's plan (no Stripe ids). */
export interface SoloStartView {
  tier: "free" | "solo" | "trial" | "team" | "business";
  status: "active" | "past_due" | "lapsed" | "suspended";
  /** The 14-day Business trial's end (ms), or null. */
  trialEndsAt: number | null;
  graceUntil: number | null;
  /** The Solo subscription's 30-day trial end (ms) while it is ahead, else null. */
  soloTrialEndsAt: number | null;
  version: number;
  asOf: number;
}

/**
 * Fixed error codes, each with its retry class:
 *  - bad_install (permanent): not an install id billing accepts.
 *  - unknown_install (retryable): not in billing's registry yet; the
 *    provisioner's KV write takes time to become visible.
 *  - plan_conflict (permanent): the row is on team, business or trial.
 *  - not_active (permanent until its status changes): lapsed, past_due or
 *    suspended.
 *  - config (not retryable): billing's Stripe key or Solo price is missing or
 *    malformed (a live key is refused); an operator fixes it first.
 *  - upstream, bad_upstream (retryable): Stripe failed or answered something
 *    unusable.
 *  - retry (retryable): the same Stripe request is still in progress.
 *  - unavailable (retryable): any unexpected error (a D1 error, say).
 */
export type SoloStartError =
  | "bad_install"
  | "unknown_install"
  | "plan_conflict"
  | "not_active"
  | "config"
  | "upstream"
  | "bad_upstream"
  | "retry"
  | "unavailable";

export type SoloStartResult =
  | ({ ok: true } & SoloStartView)
  | { ok: false; error: SoloStartError; retryable: boolean };

/** Which codes may be retried (the table above). */
export const SOLO_START_RETRYABLE: Readonly<Record<SoloStartError, boolean>> =
  Object.freeze({
    bad_install: false,
    unknown_install: true,
    plan_conflict: false,
    not_active: false,
    config: false,
    upstream: true,
    bad_upstream: true,
    retry: true,
    unavailable: true,
  });
