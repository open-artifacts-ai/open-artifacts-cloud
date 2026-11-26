// The suite's view of the public hook ledger (apps/dashboard/e2e/staging/
// hook-ledger.ts), for both shapes public has had (public #3200):
//
// - before #3200 (RL_ANON_*): every /__test/* call is charged to RL_ANON
//   (30 a minute per install and IP). HOOK_LIMIT is 25, and a claim past it
//   waits for room (the ledger's own `sleep`), up to `deadline`.
// - from #3200 (RL_HOOKS_*): a call whose hook key checks out is charged to
//   RL_HOOKS (600 a minute), and only a wrong or absent key to RL_ANON.
//   HOOK_LIMIT is 570, and a claim past it throws HookBudgetError at once:
//   the ledger never waits.
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
//   minute per ledger, RL_ANON's 30 less 5. A full ledger waits for room,
//   exactly as the old ledger did: until the oldest call leaves the window,
//   computed from the ledger (roomIn, plus EDGE_MS), never a fixed time, up
//   to the caller's `deadline`; past it, HookBudgetError. Before #3200 the
//   ledger waits itself; from #3200 claimCappedSlot does. (Decision on cloud
//   #475: the server holds these keys to 30 a minute, the old pin waited here
//   already, and the last 3 live runs waited 0.0 s, so a rare burst becomes a
//   short wait, not a flaky failure. Right-key calls never wait.)
//
// TODO(public #3200): once PUBLIC_PIN is at or past the release with #3200,
// drop the pre-#3200 branch (ledgerWaits, HOOK_GAP_MS) and import the new
// names directly.
import * as ledger from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";

export {
  HOOK_WINDOW_MS,
  HookBudgetError,
  hookLedgerDir,
  hookWindowCount,
} from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";

/** Claim options; `sleep` and `deadline` bound a capped claim's wait for room. */
export interface ClaimOpts {
  root?: string;
  reserve?: number;
  now?: () => number;
  afterScan?: () => Promise<void>;
  /** How a capped claim waits the computed time for room (default a timer). */
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

/** Added to a computed wait, so the freed call is past the window's edge (the old ledger's EDGE_MS). */
export const EDGE_MS = 100;

/**
 * Ms from `t` until `app`'s window holds fewer than `room` calls, read from
 * the ledger itself: hookWindowCount at later times only falls, so the
 * smallest such time is found by bisection over one window.
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
 * A call RL_ANON is charged for: at most SUITE_HOOK_LIMIT (less `reserve`)
 * in `app`'s window. A full window waits for room, the time computed from
 * the ledger (roomIn plus EDGE_MS, as the old ledger's wait), up to
 * `deadline`; a longer wait is HookBudgetError. Before #3200 the ledger
 * waits itself. Returns the window's calls.
 */
export async function claimCappedSlot(
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
        `${ledger.hookWindowCount(app, { root, now: () => t })} of ${SUITE_HOOK_LIMIT} calls in the last ${ledger.HOOK_WINDOW_MS / 1000} s; ` +
          `the next fits in ${Math.ceil(wait / 1000)} s, past this call's deadline`,
      );
    await sleep(wait);
  }
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
