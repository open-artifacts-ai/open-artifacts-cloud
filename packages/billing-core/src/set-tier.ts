// What billing's operator RPC (BillingOperatorRpc.setTier, #66) answers: a
// plain, serialisable union. It never throws for an expected outcome; anything
// unexpected is { ok: false, error: "unavailable" }.

/** The tiers an operator may comp an install onto. */
export const SET_TIER_TIERS = ["team", "business", "solo"] as const;
export type SetTierTier = (typeof SET_TIER_TIERS)[number];

/** The row as it was before the write (null: the install had no row). */
export interface SetTierPrevious {
  tier: string | null;
  status: string | null;
  version: number;
}

/**
 * Fixed error codes:
 *  - bad_install: not an install id billing accepts.
 *  - bad_tier: not team, business or solo.
 *  - unknown_install: not in billing's registry (the install does not exist
 *    or its entry is not visible yet).
 *  - subscription_active: the row holds a live Stripe subscription; Stripe
 *    owns the tier there, so the comp is refused and nothing changes.
 *  - unavailable: any unexpected error (a D1 error, say).
 */
export type SetTierError =
  | "bad_install"
  | "bad_tier"
  | "unknown_install"
  | "subscription_active"
  | "unavailable";

export type SetTierResult =
  | {
      ok: true;
      tier: SetTierTier;
      status: "active";
      /** The row's version after the write (it grows by one every call). */
      version: number;
      updatedAt: number;
      previous: SetTierPrevious | null;
    }
  | { ok: false; error: SetTierError };
