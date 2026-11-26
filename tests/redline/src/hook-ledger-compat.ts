// The suite's view of the public hook ledger (apps/dashboard/e2e/staging/
// hook-ledger.ts), for both shapes public has had (public #3200):
//
// - before #3200 (RL_ANON_*): HOOK_LIMIT is 25 (RL_ANON's 30 less 5), and a
//   claim past it waits for room (its `sleep`), up to `deadline`;
// - from #3200 (RL_HOOKS_*): HOOK_LIMIT is 570 (RL_HOOKS' 600 less 30), and a
//   claim past it throws HookBudgetError at once (no `sleep`, no `deadline`).
//
// The suite's claims wait for room either way (claimSuiteSlot): from #3200
// the wait is computed here from the ledger's own window, exactly as the old
// ledger computed it (the oldest call that must leave, plus EDGE_MS), never a
// fixed sleep, and a claim whose wait would pass its `deadline` is refused.
//
// Either way the suite keeps its own cap at SUITE_HOOK_LIMIT (25) a minute per
// ledger, as before #3200: a wrong or absent hook key is still charged to
// RL_ANON (30 a minute), and the guard's wrong-key probe and the R26 key poll
// rely on that margin (live/guard.test.ts), as do the RL_ANON keys rl-anon.ts
// paces and the suite's share of the hook audit log's newest-200 read
// (test/t19-isolation.test.ts).
// The cap is the ledger's own `reserve`.
//
// TODO(public #3200): once PUBLIC_PIN is at or past the release with #3200,
// drop the pre-#3200 branch (HOOK_GAP_MS, ledgerWaits and the ledger's own
// wait) and import the new names directly.
import * as ledger from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";

export {
  HOOK_WINDOW_MS,
  HookBudgetError,
  hookLedgerDir,
  hookWindowCount,
} from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";

/** Claim options; `sleep` and `deadline` bound the wait for room (claimSuiteSlot). */
export interface ClaimOpts {
  root?: string;
  reserve?: number;
  now?: () => number;
  afterScan?: () => Promise<void>;
  /** How a claim waits the computed time for room (default a timer). */
  sleep?: (ms: number) => Promise<void>;
  /** Epoch ms by which the call must be made; a longer wait is HookBudgetError. */
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

/** True for the pre-#3200 ledger, which waits for room itself; from #3200 claimSuiteSlot does. */
export const ledgerWaits = L.RL_HOOKS_LIMIT === undefined;

/** T19's spread before #3200 (one call per HOOK_GAP_MS); undefined from #3200, which dropped it. */
export const T19_HOOK_GAP_MS: number | undefined = L.HOOK_GAP_MS;

/** Added to a computed wait, so the freed call is past the window's edge (the old ledger's EDGE_MS). */
export const EDGE_MS = 100;

/**
 * Ms from `t` until `app`'s window holds fewer than `room` calls, read from
 * the ledger itself: hookWindowCount at later times only falls, so the
 * smallest such time is found by bisection over one window. At most one
 * window, when every call in it is the newest.
 */
export function roomIn(
  app: string,
  room: number,
  t: number,
  root?: string,
): number {
  const count = (x: number) =>
    ledger.hookWindowCount(app, { root, now: () => t + x });
  if (count(0) < room) return 0;
  let lo = 0;
  let hi = ledger.HOOK_WINDOW_MS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (count(mid) < room) hi = mid;
    else lo = mid;
  }
  return hi;
}

const timer = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Records a suite call in `app`'s ledger, at most SUITE_HOOK_LIMIT (less
 * `reserve`) in the window, waiting for room when it is full: before #3200
 * the ledger waits itself; from #3200 the wait is computed from the window
 * (roomIn, plus EDGE_MS), then the claim is tried again. A wait that would
 * pass `deadline` is HookBudgetError. Returns the calls in the window.
 */
export async function claimSuiteSlot(
  app: string,
  o: ClaimOpts = {},
): Promise<number> {
  const reserve = HELD + (o.reserve ?? 0);
  if (ledgerWaits) return L.claimHookSlot(app, { ...o, reserve });
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? timer;
  const room = SUITE_HOOK_LIMIT - (o.reserve ?? 0);
  const { root, afterScan } = o;
  for (;;) {
    try {
      return await L.claimHookSlot(app, { root, now, afterScan, reserve });
    } catch (e) {
      if (!(e instanceof ledger.HookBudgetError)) throw e;
    }
    const t = now();
    const wait = Math.max(1, roomIn(app, room, t, root) + EDGE_MS);
    if (o.deadline !== undefined && t + wait > o.deadline)
      throw new ledger.HookBudgetError(
        `${ledger.hookWindowCount(app, { root, now: () => t })} of ${SUITE_HOOK_LIMIT} suite calls in the last ${ledger.HOOK_WINDOW_MS / 1000} s; ` +
          `the next fits in ${Math.ceil(wait / 1000)} s, past this call's deadline`,
      );
    await sleep(wait);
  }
}

/**
 * Whether a bare hook 404 can be the key's rather than RL_ANON's: only while
 * the window holds fewer than the suite's cap (the old hook404IsTheKeys).
 */
export const suiteHook404IsTheKeys = (windowCount: number): boolean =>
  windowCount < SUITE_HOOK_LIMIT;
