// The suite's view of the public hook ledger (apps/dashboard/e2e/staging/
// hook-ledger.ts), for both shapes public has had (public #3200):
//
// - before #3200 (RL_ANON_*): HOOK_LIMIT is 25 (RL_ANON's 30 less 5), and a
//   claim past it waits for room (its `sleep`), up to `deadline`;
// - from #3200 (RL_HOOKS_*): HOOK_LIMIT is 570 (RL_HOOKS' 600 less 30), and a
//   claim past it throws HookBudgetError at once (no `sleep`, no `deadline`).
//
// Either way the suite keeps its own cap at SUITE_HOOK_LIMIT (25) a minute per
// ledger, as before #3200: a wrong or absent hook key is still charged to
// RL_ANON (30 a minute), and the guard's wrong-key probe and the R26 key poll
// rely on that margin (live/guard.test.ts), as do the RL_ANON keys rl-anon.ts
// paces and the suite's share of the hook audit log's newest-200 read
// (test/t19-isolation.test.ts).
// The cap is the ledger's own `reserve`, so no wait is added here.
//
// TODO(public #3200): once PUBLIC_PIN is at or past the release with #3200,
// drop the pre-#3200 branch (`sleep`, `deadline`, HOOK_GAP_MS, ledgerWaits)
// and import the new names directly.
import * as ledger from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";

export {
  HOOK_WINDOW_MS,
  HookBudgetError,
  hookLedgerDir,
  hookWindowCount,
} from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";

/** Claim options of either ledger; the pre-#3200 one also reads `sleep` and `deadline`. */
export interface ClaimOpts {
  root?: string;
  reserve?: number;
  now?: () => number;
  afterScan?: () => Promise<void>;
  /** Pre-#3200 only: how a claim waits for room. */
  sleep?: (ms: number) => Promise<void>;
  /** Pre-#3200 only: past it, the wait gives up (HookBudgetError). */
  deadline?: number;
}

/** The two shapes of the module, as this file reads it. */
interface AnyLedger {
  claimHookSlot(app: string, o?: ClaimOpts): Promise<number>;
  HOOK_LIMIT: number;
  /** Pre-#3200 only: T19's spread, one hook call per this gap. */
  HOOK_GAP_MS?: number;
  /** From #3200 on. */
  RL_HOOKS_LIMIT?: number;
}
const L = ledger as unknown as AnyLedger;

/** The suite's own calls per ledger per HOOK_WINDOW_MS: RL_ANON's 30 less 5. */
export const SUITE_HOOK_LIMIT = 25;

/** Kept back from the ledger's HOOK_LIMIT so the suite stops at its own cap (0 before #3200). */
const HELD = L.HOOK_LIMIT - SUITE_HOOK_LIMIT;
if (HELD < 0)
  throw new Error(
    `hook ledger: HOOK_LIMIT ${L.HOOK_LIMIT} is below the suite's ${SUITE_HOOK_LIMIT}`,
  );

/** True for the pre-#3200 ledger: a full claim waits; from #3200 it throws at once. */
export const ledgerWaits = L.RL_HOOKS_LIMIT === undefined;

/** T19's spread before #3200 (one call per HOOK_GAP_MS); undefined from #3200, which dropped it. */
export const T19_HOOK_GAP_MS: number | undefined = L.HOOK_GAP_MS;

/**
 * Records a suite call in `app`'s ledger, at most SUITE_HOOK_LIMIT (less
 * `reserve`) in the window. Past it: before #3200 it waits (to `deadline`),
 * from #3200 HookBudgetError at once. Returns the calls in the window.
 */
export function claimSuiteSlot(
  app: string,
  o: ClaimOpts = {},
): Promise<number> {
  return L.claimHookSlot(app, { ...o, reserve: HELD + (o.reserve ?? 0) });
}

/**
 * Whether a bare hook 404 can be the key's rather than RL_ANON's: only while
 * the window holds fewer than the suite's cap (the old hook404IsTheKeys).
 */
export const suiteHook404IsTheKeys = (windowCount: number): boolean =>
  windowCount < SUITE_HOOK_LIMIT;
