import { BillingTierSchema } from "@oa/shared";
import type { Env } from "./env.js";

/** How long admin waits on billing before showing "Created as" instead. */
export const BILLING_TIERS_TIMEOUT_MS = 1500;

type BillingTier = ReturnType<typeof BillingTierSchema.parse>;

/**
 * The billing tier of each install (#2058), from one batched read through
 * BILLING.tiersOf. Best effort: unbound, a missing method (billing deploys
 * after provisioning), a throw, a refusal, a slow answer or an unknown tier
 * all leave the install out of the map, and the caller shows null. It never
 * throws, so a list or detail read never fails on billing.
 */
export async function billingTiersOf(
  env: Env,
  installs: string[],
): Promise<Map<string, BillingTier>> {
  const out = new Map<string, BillingTier>();
  const rpc = env.BILLING;
  if (!rpc || typeof rpc.tiersOf !== "function" || installs.length === 0)
    return out;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      rpc.tiersOf(installs),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), BILLING_TIERS_TIMEOUT_MS);
      }),
    ]);
    if (!r || !r.ok) return out;
    for (const [id, v] of Object.entries(r.tiers)) {
      const t = BillingTierSchema.safeParse(v?.tier);
      if (t.success) out.set(id, t.data);
    }
  } catch {
    // billing is down or lacks the method: no billing tier
  } finally {
    clearTimeout(timer);
  }
  return out;
}
