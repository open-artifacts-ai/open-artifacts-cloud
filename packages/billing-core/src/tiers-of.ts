// What billing's operator RPC BillingOperatorRpc.tiersOf (#2058) answers: the
// billing tier of up to TIERS_OF_MAX installs, read only. A plain,
// serialisable union; it never throws.

/** The most installs one call may ask about (the admin list's page cap). */
export const TIERS_OF_MAX = 100;

/** One install's row: what GET /tier answers (no row: solo, active). */
export interface TierOfView {
  tier: string | null;
  status: string | null;
}

/**
 *  - bad_installs: not an array of 1..TIERS_OF_MAX install ids billing accepts.
 *  - unavailable: any unexpected error (a D1 error, say).
 */
export type TiersOfError = "bad_installs" | "unavailable";

export type TiersOfResult =
  | { ok: true; tiers: Record<string, TierOfView> }
  | { ok: false; error: TiersOfError };
