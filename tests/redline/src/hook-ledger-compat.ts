// The suite's view of the public hook ledger (apps/dashboard/e2e/staging/
// hook-ledger.ts), for both shapes public has had (public #3200):
//
// - before #3200 (RL_ANON_*): every /__test/* call is charged to RL_ANON
//   (30 a minute per install and IP). HOOK_LIMIT is 25, and a claim past it
//   waits for room (the ledger's own `sleep`), up to `deadline`.
// - from #3200 (RL_HOOKS_*): a call whose hook key checks out is charged to
//   RL_HOOKS (600 a minute), and only a wrong or absent key to RL_ANON.
//   HOOK_LIMIT is 570, and a claim past it throws HookBudgetError at once:
//   the ledger never waits, and nothing here waits either (no sleeps, #3115).
//
// So the suite claims in one of two ways:
// - claimSuiteSlot, a hook call with the install's right key: before #3200
//   capped at SUITE_HOOK_LIMIT (25) in the app's ledger, as always; from
//   #3200 RL_HOOKS', capped at SUITE_KEYED_LIMIT (60) a minute so the suite's
//   own rows stay under the hook audit log's newest-200 read in a case's
//   longest wait (test/t19-isolation.test.ts), far above a lane's use.
// - claimCappedSlot, anything RL_ANON is charged for: a hook call that may
//   carry a wrong key (the guard's probe, R26's key poll; wrongKeyLedger)
//   and the RL_ANON keys rl-anon.ts paces. At most SUITE_HOOK_LIMIT (25) a
//   minute per ledger, RL_ANON's 30 less 5. Before #3200 a full ledger waits
//   (the old ledger's own wait); from #3200 it is refused at once.
//
// TODO(public #3200): once PUBLIC_PIN is at or past the release with #3200,
// drop the pre-#3200 branch (ledgerWaits, HOOK_GAP_MS, `sleep`) and import
// the new names directly.
import * as ledger from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";

export {
  HOOK_WINDOW_MS,
  HookBudgetError,
  hookLedgerDir,
  hookWindowCount,
} from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";

/** Claim options of either ledger; only the pre-#3200 one reads `sleep` and `deadline`. */
export interface ClaimOpts {
  root?: string;
  reserve?: number;
  now?: () => number;
  afterScan?: () => Promise<void>;
  /** Pre-#3200 only: how the ledger waits for room. */
  sleep?: (ms: number) => Promise<void>;
  /** Pre-#3200 only: past it, the ledger's wait gives up (HookBudgetError). */
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

/** Calls RL_ANON is charged for, per ledger per HOOK_WINDOW_MS: its 30 less 5. */
export const SUITE_HOOK_LIMIT = 25;

/** Kept back from the ledger's HOOK_LIMIT so a capped claim stops at 25 (0 before #3200). */
const HELD = L.HOOK_LIMIT - SUITE_HOOK_LIMIT;
if (HELD < 0)
  throw new Error(
    `hook ledger: HOOK_LIMIT ${L.HOOK_LIMIT} is below the suite's ${SUITE_HOOK_LIMIT}`,
  );

/** True for the pre-#3200 ledger: every hook call is RL_ANON's, and a full ledger waits. */
export const ledgerWaits = L.RL_HOOKS_LIMIT === undefined;

/** T19's spread before #3200 (one call per HOOK_GAP_MS); undefined from #3200, which dropped it. */
export const T19_HOOK_GAP_MS: number | undefined = L.HOOK_GAP_MS;

/**
 * A call RL_ANON is charged for: at most SUITE_HOOK_LIMIT (less `reserve`)
 * in `app`'s window. Past it, before #3200 the ledger waits (to
 * `deadline`); from #3200 HookBudgetError at once. Returns the window's calls.
 */
export function claimCappedSlot(
  app: string,
  o: ClaimOpts = {},
): Promise<number> {
  return L.claimHookSlot(app, { ...o, reserve: HELD + (o.reserve ?? 0) });
}

/**
 * The suite's right-key hook calls per app ledger per HOOK_WINDOW_MS: before
 * #3200 RL_ANON's cap (every hook call is RL_ANON's); from #3200 60, so
 * three windows (a case's longest wait, 120 s, plus one) hold under the
 * audit read's 200 rows.
 */
export const SUITE_KEYED_LIMIT = ledgerWaits ? SUITE_HOOK_LIMIT : 60;

/**
 * A hook call with the install's right key. Before #3200 it is RL_ANON's
 * like any other (claimCappedSlot, in the app's ledger, unchanged); from
 * #3200 it is RL_HOOKS': at most SUITE_KEYED_LIMIT (less `reserve`) in the
 * window, and it never waits: past it, HookBudgetError at once.
 */
export function claimSuiteSlot(
  app: string,
  o: ClaimOpts = {},
): Promise<number> {
  if (ledgerWaits) return claimCappedSlot(app, o);
  const { root, now, afterScan } = o;
  const reserve = L.HOOK_LIMIT - SUITE_KEYED_LIMIT + (o.reserve ?? 0);
  return L.claimHookSlot(app, { root, now, afterScan, reserve });
}

/**
 * The ledger for `app`'s hook calls that may carry a wrong key: before
 * #3200 the app's own (one RL_ANON bucket for every hook call); from #3200
 * its own, as RL_ANON is charged only for those.
 */
export const wrongKeyLedger = (app: string): string =>
  ledgerWaits ? app : `rl-anon/test:${app}`;

/**
 * Whether a bare hook 404 can be the key's rather than RL_ANON's: only while
 * the window of calls RL_ANON is charged for holds fewer than the cap.
 */
export const suiteHook404IsTheKeys = (windowCount: number): boolean =>
  windowCount < SUITE_HOOK_LIMIT;
