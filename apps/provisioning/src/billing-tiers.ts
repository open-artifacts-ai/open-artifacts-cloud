import { BillingStatusSchema, BillingTierSchema } from "@oa/shared";
import type { Env } from "./env.js";

/** How long admin waits on billing before showing "Created as" instead. */
export const BILLING_TIERS_TIMEOUT_MS = 1500;

export type BillingView = {
  billingTier: ReturnType<typeof BillingTierSchema.parse>;
  billingStatus: ReturnType<typeof BillingStatusSchema.parse> | null;
};

/**
 * The billing tier and status of each install (#2058), from one batched read through
 * BILLING.tiersOf. Best effort: unbound, a missing method (billing deploys
 * after provisioning), a throw, a refusal, a slow answer or an unknown tier
 * all leave the install out of the map, and the caller shows null. It never
 * throws, so a list or detail read never fails on billing.
 */
export async function billingTiersOf(
  env: Env,
  installs: string[],
): Promise<Map<string, BillingView>> {
  const out = new Map<string, BillingView>();
  const rpc = env.BILLING;
  if (!rpc || installs.length === 0) return out;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      rpc.tiersOf?.(installs),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), BILLING_TIERS_TIMEOUT_MS);
      }),
    ]);
    if (!r || !r.ok) return out;
    for (const [id, v] of Object.entries(r.tiers)) {
      const t = BillingTierSchema.safeParse(v?.tier);
      if (!t.success) continue;
      const st = BillingStatusSchema.safeParse(v?.status);
      out.set(id, {
        billingTier: t.data,
        billingStatus: st.success ? st.data : null,
      });
    }
  } catch {
    // billing is down or lacks the method: no billing tier
  } finally {
    clearTimeout(timer);
  }
  return out;
}
