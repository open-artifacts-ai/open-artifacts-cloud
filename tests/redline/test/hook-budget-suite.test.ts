// #1254: the suite's side of the runner's hook budget. The ledger and its
// own tests are public (apps/dashboard/e2e/staging/hook-ledger.ts,
// apps/dashboard/test/hook-ledger.test.ts); the suite imports it, never the
// other way round.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimHookSlot } from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";
import {
  claimCappedSlot,
  claimSuiteSlot,
  HOOK_WINDOW_MS,
  HookBudgetError,
  hookLedgerDir,
  hookWindowCount,
  ledgerWaits,
  SUITE_HOOK_LIMIT,
  SUITE_KEYED_LIMIT,
  suiteHook404IsTheKeys,
  wrongKeyLedger,
} from "../src/hook-ledger-compat.ts";
import { paceHook, paceWrongKeyHook } from "../src/http.ts";
import { type AnonTarget, anonKeys } from "../src/rl-anon.ts";
import { parseTargets } from "../src/targets.ts";
import { secretDir } from "./fake.ts";

const APP = "https://rl-a.open-artifacts-staging.app";
const LANE_T: [AnonTarget, AnonTarget] = [
  {
    name: "rl-a",
    installId: "iaaaaaaaaaaa",
    app: APP,
    content: "https://rl-a.open-artifacts-staging.page",
  },
  {
    name: "rl-b",
    installId: "ibbbbbbbbbbb",
    app: "https://rl-b.open-artifacts-staging.app",
    content: "https://rl-b.open-artifacts-staging.page",
  },
];

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "oa-hook-budget-suite-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A pinned clock whose sleep advances it, recording each wait. */
function clock(start = 1_800_000_000_000) {
  let t = start;
  const waits: number[] = [];
  return {
    now: () => t,
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe("one ledger per install, the same for the suite and T19", () => {
  // T19 keys on rl-a's app origin from REDLINE_TARGETS too (rlA().app; its
  // side: apps/dashboard/test/t19-hook-pace.test.ts). Both use the JSON's
  // a.app as given, so both derive hookLedgerDir(a.app).
  it("the suite keys on the target's app origin, exactly as REDLINE_TARGETS gives it", () => {
    const s = secretDir({ ka: "a".repeat(40), kb: "b".repeat(40) });
    try {
      const t = (name: string, f: string) => ({
        name,
        installId: `${name}-id`,
        app: `https://${name}.open-artifacts-staging.app`,
        content: `https://${name}.open-artifacts-staging.page`,
        testDomain: `${name}.test`,
        hookKeyFile: s.path(f),
      });
      const suite = parseTargets({
        REDLINE_TARGETS: JSON.stringify({
          mode: "staging",
          a: t("rl-a", "ka"),
          b: t("rl-b", "kb"),
        }),
      });
      expect(suite.a.app).toBe(APP);
      expect(hookLedgerDir(suite.a.app)).toBe(hookLedgerDir(APP));
      // Another install never shares it.
      expect(hookLedgerDir(suite.b.app)).not.toBe(hookLedgerDir(suite.a.app));
    } finally {
      s.cleanup();
    }
  });

  it("a suite call counts in the app's window, where T19's claims count too", async () => {
    const root = scratch();
    const c = clock();
    await paceHook({ app: APP } as never, { root, now: c.now });
    await claimHookSlot(APP, { root, now: c.now });
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(2);
    expect(hookWindowCount("https://rl-b.x.app", { root, now: c.now })).toBe(0);
  });
});

describe("guard's wrong-key probe", () => {
  it("paces in the wrong-key ledger with one call kept free, so its 404 is the key's", async () => {
    const root = scratch();
    const c = clock();
    const ledger = wrongKeyLedger(APP);
    for (let i = 0; i < SUITE_HOOK_LIMIT - 1; i++)
      await claimCappedSlot(ledger, { root, now: c.now });
    const probe = () =>
      paceWrongKeyHook({ app: APP } as never, {
        root,
        now: c.now,
        sleep: c.sleep,
        reserve: 1,
      });
    if (ledgerWaits) {
      // Before public #3200: it waits for room rather than take the last slot.
      const n = await probe();
      expect(c.waits).toHaveLength(1);
      expect(suiteHook404IsTheKeys(n)).toBe(true);
    } else {
      // From #3200: refused at once rather than take the last slot, no wait.
      await expect(probe()).rejects.toBeInstanceOf(HookBudgetError);
      expect(c.waits).toHaveLength(0);
      expect(hookWindowCount(ledger, { root, now: c.now })).toBe(
        SUITE_HOOK_LIMIT - 1,
      );
    }
  });

  it("the wrong-key ledger: before public #3200 the app's own; from it a separate one right-key calls never fill", async () => {
    if (ledgerWaits) {
      // Before #3200 every hook call is RL_ANON's: one ledger for both.
      expect(wrongKeyLedger(APP)).toBe(APP);
      return;
    }
    const root = scratch();
    const c = clock();
    for (let i = 0; i < 32; i++)
      await paceHook({ app: APP } as never, { root, now: c.now });
    expect(hookWindowCount(wrongKeyLedger(APP), { root, now: c.now })).toBe(0);
    const n = await paceWrongKeyHook({ app: APP } as never, {
      root,
      now: c.now,
      reserve: 1,
    });
    expect(suiteHook404IsTheKeys(n)).toBe(true);
  });
});

describe(`right-key hook claims (${ledgerWaits ? "pre-#3200" : "#3200"} ledger)`, () => {
  it("32 claims in one lane all succeed; from #3200 none waits, before it unchanged", async () => {
    const root = scratch();
    const c = clock();
    const t0 = c.now();
    const at: number[] = [];
    for (let i = 0; i < 32; i++) {
      await claimSuiteSlot(APP, { root, now: c.now, sleep: c.sleep });
      at.push(c.now());
    }
    if (ledgerWaits) {
      // RL_ANON's 25 a minute, as before #3200: the old ledger's own wait.
      expect(c.waits.length).toBeGreaterThan(0);
      for (const t of at)
        expect(
          at.filter((u) => u <= t && t - u < HOOK_WINDOW_MS).length,
        ).toBeLessThanOrEqual(SUITE_HOOK_LIMIT);
    } else {
      // RL_HOOKS': all 32 at once, no wait on the fake clock.
      expect(c.waits).toHaveLength(0);
      expect(at.every((t) => t === t0)).toBe(true);
      expect(hookWindowCount(APP, { root, now: c.now })).toBe(32);
    }
  });

  it("past SUITE_KEYED_LIMIT a right-key claim is refused (from #3200 at once), taking no slot", async () => {
    const root = scratch();
    const c = clock();
    for (let i = 0; i < SUITE_KEYED_LIMIT; i++)
      await claimSuiteSlot(APP, { root, now: c.now });
    const next = claimSuiteSlot(APP, {
      root,
      now: c.now,
      sleep: c.sleep,
      deadline: c.now(),
    });
    await expect(next).rejects.toBeInstanceOf(HookBudgetError);
    expect(c.waits).toHaveLength(0);
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(SUITE_KEYED_LIMIT);
  });
});

describe(`calls RL_ANON is charged for: ${SUITE_HOOK_LIMIT} a minute per ledger`, () => {
  // The credentials lane's 32 POST /oauth/token calls (its pacing note in the
  // last 3 live runs): 17 go to rl-a and 15 to rl-b, and each install's
  // tok:ip bucket is its own (src/rl-anon.ts), so the lane fits 25 by design.
  it("the credentials lane's tok:ip calls, 17 at rl-a and 15 at rl-b, all fit at once with no wait", async () => {
    const root = scratch();
    const c = clock();
    const tok = (t: string) =>
      anonKeys(
        { method: "POST", url: `${t}/oauth/token`, headers: new Headers() },
        LANE_T,
      )[0] as string;
    const [a, b] = [tok(LANE_T[0].app), tok(LANE_T[1].app)];
    expect(a).not.toBe(b);
    for (const [key, n] of [
      [a, 17],
      [b, 15],
    ] as const)
      for (let i = 0; i < n; i++)
        await claimCappedSlot(`rl-anon/${key}`, {
          root,
          now: c.now,
          sleep: c.sleep,
        });
    expect(c.waits).toHaveLength(0);
    expect(hookWindowCount(`rl-anon/${a}`, { root, now: c.now })).toBe(17);
    expect(hookWindowCount(`rl-anon/${b}`, { root, now: c.now })).toBe(15);
  });

  it("25 fit; the 26th waits (before #3200) or is refused at once (from #3200), never taken in the window", async () => {
    const root = scratch();
    const c = clock();
    const ledger = wrongKeyLedger(APP);
    for (let i = 0; i < SUITE_HOOK_LIMIT; i++)
      await claimCappedSlot(ledger, { root, now: c.now });
    expect(suiteHook404IsTheKeys(SUITE_HOOK_LIMIT - 1)).toBe(true);
    expect(suiteHook404IsTheKeys(SUITE_HOOK_LIMIT)).toBe(false);
    const next = claimCappedSlot(ledger, {
      root,
      now: c.now,
      sleep: c.sleep,
      deadline: c.now(),
    });
    await expect(next).rejects.toBeInstanceOf(HookBudgetError);
    expect(c.waits).toHaveLength(0);
    expect(hookWindowCount(ledger, { root, now: c.now })).toBe(
      SUITE_HOOK_LIMIT,
    );
  });
});
