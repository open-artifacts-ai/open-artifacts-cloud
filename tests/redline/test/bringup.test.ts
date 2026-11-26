import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimCappedSlot,
  claimSuiteSlot,
  HOOK_WINDOW_MS,
  HookBudgetError,
  hookWindowCount,
  ledgerWaits,
  SUITE_HOOK_LIMIT,
  wrongKeyLedger,
} from "../src/hook-ledger-compat.ts";
import { Run, sidesOf, stagedVersion } from "../src/provisioning.ts";
import {
  bringUp,
  credFile,
  type RawTargets,
  revokeAll,
  waitHookKey,
} from "../src/provisioning-live.ts";
import {
  CONFIG,
  type FakeApi,
  fakeApi,
  setVersion,
} from "./provisioning-fake.ts";

// #1730: bring-up upgrades rl-a and rl-b at the same time. Each install is its
// own chain; both are always awaited; a failure names its install.

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): { f: FakeApi; t: RawTargets } {
  const d = mkdtempSync(join(tmpdir(), "oa-bringup-"));
  dirs.push(d);
  const f = fakeApi();
  // Both installs are behind the release: both need a real upgrade.
  setVersion(f, CONFIG.rlA.id, "0.80.0");
  setVersion(f, CONFIG.rlB.id, "0.81.0");
  return {
    f,
    t: {
      secretsDir: d,
      a: { name: "rl-a", installId: CONFIG.rlA.id, app: CONFIG.rlA.app },
      b: { name: "rl-b", installId: CONFIG.rlB.id, app: CONFIG.rlB.app },
    },
  };
}
/** No hook ledger on disk: the polls' pacing is its own concern. */
const noPace = async () => {};
/** The hosted bus pair is test/hosted-bus.test.ts's: none started here. */
const noPair = () => {};
const quiet = () => vi.spyOn(process.stdout, "write").mockReturnValue(true);
const at = (log: string[], re: RegExp) => log.findIndex((l) => re.test(l));

describe("bringUp runs rl-a and rl-b at the same time", () => {
  it("both upgrades are sent before either install's creds are taken, and every file is written", async () => {
    const { f, t } = setup();
    const out = quiet();
    await bringUp({}, t, new Run(CONFIG, f.io), noPace, noPair);
    const up = (id: string) =>
      at(f.log, new RegExp(`/installs/${id}/upgrade$`));
    const creds = (id: string) =>
      at(f.log, new RegExp(`/installs/${id}/redline-creds$`));
    expect(up(CONFIG.rlA.id)).toBeGreaterThan(-1);
    expect(up(CONFIG.rlB.id)).toBeGreaterThan(-1);
    // Taken one after the other, rl-b's upgrade would follow rl-a's creds.
    const firstCreds = Math.min(creds(CONFIG.rlA.id), creds(CONFIG.rlB.id));
    expect(up(CONFIG.rlA.id)).toBeLessThan(firstCreds);
    expect(up(CONFIG.rlB.id)).toBeLessThan(firstCreds);
    for (const [k, kind] of [
      ["a", "PAT"],
      ["a", "HOOK_KEY"],
      ["b", "PAT"],
      ["b", "HOOK_KEY"],
    ] as const)
      expect(
        readFileSync(credFile(t, k, kind), "utf8").length,
        `${k} ${kind}`,
      ).toBeGreaterThan(10);
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("rl-a: upgraded (0.82.0)");
    expect(text).toContain("rl-b: upgraded (0.82.0)");
    expect(text).toContain("rl-a: R26 creds written");
    expect(text).toContain("rl-b: R26 creds written");
  });

  it("R26 creds are requested the same way as before: one mint per install, sealed to this run's key", async () => {
    const { f, t } = setup();
    quiet();
    await bringUp({}, t, new Run(CONFIG, f.io), noPace, noPair);
    const mints = f.log.filter((l) => /\/redline-creds$/.test(l));
    expect(mints).toHaveLength(2);
    expect(f.pats.size).toBe(2);
    expect([...f.pats.values()].map((p) => p.install).sort()).toEqual(
      [CONFIG.rlA.id, CONFIG.rlB.id].sort(),
    );
  });

  /** rl-a's upgrade request is refused; everything else goes to the fake. */
  const refuseUp = (f: FakeApi, id: string): Run =>
    new Run(CONFIG, {
      ...f.io,
      fetch: (u, i) =>
        String(u).endsWith(`/installs/${id}/upgrade`)
          ? Promise.resolve(
              new Response(JSON.stringify({ error: { code: "boom" } }), {
                status: 500,
              }),
            )
          : f.io.fetch(u, i),
    });

  it("a failing install fails the bring-up, names itself, and the other still runs to the end", async () => {
    const { f, t } = setup();
    const out = quiet();
    await expect(
      bringUp({}, t, refuseUp(f, CONFIG.rlA.id), noPace, noPair),
    ).rejects.toThrow(/^rl-a: /);
    // rl-b was awaited to the end: its creds exist, rl-a has none.
    expect(existsSync(credFile(t, "b", "PAT"))).toBe(true);
    expect(existsSync(credFile(t, "b", "HOOK_KEY"))).toBe(true);
    expect(existsSync(credFile(t, "a", "PAT"))).toBe(false);
    expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "rl-b: R26 creds written",
    );
  });

  it("the same when rl-b is the one that fails", async () => {
    const { f, t } = setup();
    quiet();
    await expect(
      bringUp({}, t, refuseUp(f, CONFIG.rlB.id), noPace, noPair),
    ).rejects.toThrow(/^rl-b: /);
    expect(existsSync(credFile(t, "a", "PAT"))).toBe(true);
    expect(existsSync(credFile(t, "b", "PAT"))).toBe(false);
  });

  it("when both fail, both install names are in the output", async () => {
    const { f, t } = setup();
    const out = quiet();
    const a = refuseUp(f, CONFIG.rlA.id);
    const both = new Run(CONFIG, {
      ...a.io,
      fetch: (u, i) =>
        String(u).endsWith(`/installs/${CONFIG.rlB.id}/upgrade`)
          ? Promise.resolve(new Response("{}", { status: 500 }))
          : a.io.fetch(u, i),
    });
    const err = await bringUp({}, t, both, noPace, noPair).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/^rl-a: /);
    expect(out.mock.calls.map((c) => String(c[0])).join("")).toMatch(/rl-b: /);
  });
});

describe("bringUp waits for the new hook key to take effect", () => {
  const calls = (f: FakeApi) =>
    f.log.filter((l) => l.endsWith("/__test/key_check"));

  it("a key still old for three polls, then accepted, passes after polling each install", async () => {
    const { f, t } = setup();
    f.faults.add("hook_key_stale");
    const out = quiet();
    await bringUp({}, t, new Run(CONFIG, f.io), noPace, noPair);
    // Three old answers and the fourth accepted, per install.
    expect(calls(f)).toHaveLength(8);
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("rl-a: the new hook key is accepted");
    expect(text).toContain("rl-b: the new hook key is accepted");
  });

  it("a key accepted at once is checked once per install", async () => {
    const { f, t } = setup();
    quiet();
    await bringUp({}, t, new Run(CONFIG, f.io), noPace, noPair);
    expect(calls(f)).toHaveLength(2);
  });

  it("a key never accepted fails the bring-up as infra after 90 s, naming the install", async () => {
    const { f, t } = setup();
    f.faults.add("hook_key_never");
    quiet();
    const err = await bringUp(
      {},
      t,
      new Run(CONFIG, f.io),
      noPace,
      noPair,
    ).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.name).toBe("InfraError");
    expect(err?.message).toMatch(
      /^rl-[ab]: infra: the new hook key was not accepted within 90 s of R26/,
    );
    // About 30 polls an install at one per 3 s: under the 25 a minute budget.
    expect(calls(f).length).toBeLessThanOrEqual(2 * 32);
  });

  it("slow ledger claims never push the total past the 90 s bound", async () => {
    const { f } = setup();
    f.faults.add("hook_key_never");
    const run = new Run(CONFIG, f.io);
    const t0 = f.io.now();
    // Each claim waits 40 s on the fake clock, and gives up at the deadline.
    const slow = async (_app: string, deadline: number) => {
      await f.io.wait(40_000);
      if (f.io.now() > deadline) throw new HookBudgetError("slow");
    };
    const err = await waitHookKey(run, CONFIG.rlA.app, "k", slow).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.name).toBe("InfraError");
    expect(f.io.now() - t0).toBeLessThanOrEqual(90_000 + 40_000);
    expect(calls(f).length).toBeLessThanOrEqual(2);
  });

  // R26's own pacing (the default `pace`), on the run's clock. Its checks
  // may carry a wrong key, so they go in the wrong-key ledger (RL_ANON's 25 a
  // minute; before public #3200 the app's whole ledger). The failure says how
  // long it waited and what it sent.
  describe("R26's pacing", () => {
    const ledgerRoot = () => {
      const root = mkdtempSync(join(tmpdir(), "oa-bringup-ledger-"));
      dirs.push(root);
      // The default pace's ledger root is os.tmpdir(): this test's own.
      vi.stubEnv("TMPDIR", root);
    };
    const fill = async (
      f: FakeApi,
      claim: (app: string, o: { now: () => number }) => Promise<number>,
      app: string,
    ) => {
      for (let i = 0; i < SUITE_HOOK_LIMIT; i++)
        await claim(app, { now: f.io.now });
      expect(hookWindowCount(app, { now: f.io.now })).toBe(SUITE_HOOK_LIMIT);
    };
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("the suite's right-key calls never hold R26 back from #3200 (before it, it waits for room as always)", async () => {
      const { f } = setup();
      ledgerRoot();
      await fill(f, claimSuiteSlot, CONFIG.rlA.app);
      const run = new Run(CONFIG, f.io);
      const t0 = f.io.now();
      // The fake's fresh key (provisioning-fake.ts, /__test/key_check).
      await waitHookKey(run, CONFIG.rlA.app, "h".repeat(43));
      expect(calls(f)).toHaveLength(1);
      if (ledgerWaits) {
        expect(f.io.now() - t0).toBeGreaterThanOrEqual(HOOK_WINDOW_MS);
        expect(f.io.now() - t0).toBeLessThan(HOOK_WINDOW_MS + 1_000);
      } else expect(f.io.now()).toBe(t0);
    });

    it("a key never accepted fails at 90 s, saying the real time waited and the checks sent; its polls stay within 25 a minute", async () => {
      const { f } = setup();
      f.faults.add("hook_key_never");
      ledgerRoot();
      const run = new Run(CONFIG, f.io);
      const t0 = f.io.now();
      const err = await waitHookKey(run, CONFIG.rlA.app, "k").then(
        () => null,
        (e: Error) => e,
      );
      const waited = f.io.now() - t0;
      expect(err?.name).toBe("InfraError");
      expect(waited).toBe(90_000);
      const sent = calls(f).length;
      expect(sent).toBeGreaterThan(SUITE_HOOK_LIMIT);
      expect(err?.message).toContain(
        `(hooks answer 404 on a key mismatch; waited 90.0 s, ${sent} key checks sent)`,
      );
      expect(
        hookWindowCount(wrongKeyLedger(CONFIG.rlA.app), { now: f.io.now }),
      ).toBeLessThanOrEqual(SUITE_HOOK_LIMIT);
    });

    it("a full wrong-key ledger and a deadline shorter than its wait: fails at once, saying it waited 0 s and sent nothing", async () => {
      const { f } = setup();
      ledgerRoot();
      await fill(f, claimCappedSlot, wrongKeyLedger(CONFIG.rlA.app));
      const run = new Run(CONFIG, f.io);
      const t0 = f.io.now();
      const err = await waitHookKey(
        run,
        CONFIG.rlA.app,
        "h".repeat(43),
        undefined,
        30_000,
      ).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.name).toBe("InfraError");
      expect(f.io.now()).toBe(t0);
      expect(calls(f)).toHaveLength(0);
      expect(err?.message).toMatch(
        /not accepted within 30 s of R26 \(the hook budget had no room before the deadline: .*; waited 0\.0 s, 0 key checks sent\)/,
      );
    });
  });

  it("a request that never answers is cut off at the deadline, not at its own bound", async () => {
    const { f } = setup();
    const hang: typeof fetch = (_u, init) =>
      new Promise((_r, rej) =>
        init?.signal?.addEventListener("abort", () => rej(init.signal?.reason)),
      );
    const run = new Run(CONFIG, {
      ...f.io,
      now: Date.now,
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      fetch: hang,
    });
    const t0 = Date.now();
    const err = await waitHookKey(run, CONFIG.rlA.app, "k", noPace, 300).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.name).toBe("InfraError");
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("bringUp checks the tier fixture (rl-a Team, rl-b Business)", () => {
  const me = (f: FakeApi) => f.log.filter((l) => l.endsWith("/api/v1/me"));

  it("the right tiers pass, one /me read per install", async () => {
    const { f, t } = setup();
    const out = quiet();
    await bringUp({}, t, new Run(CONFIG, f.io), noPace, noPair);
    expect(me(f)).toHaveLength(2);
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("rl-a: tier is team");
    expect(text).toContain("rl-b: tier is business");
  });

  it.each([
    ["a", CONFIG.rlA.id, "rl-a", "business", "team"],
    ["b", CONFIG.rlB.id, "rl-b", "team", "business"],
  ])(
    "a wrong tier on %s fails as infra with the fixture message",
    async (_k, id, slug, got, want) => {
      const { f, t } = setup();
      f.tiers.set(id, got);
      quiet();
      const err = await bringUp(
        {},
        t,
        new Run(CONFIG, f.io),
        noPace,
        noPair,
      ).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.name).toBe("InfraError");
      expect(err?.message).toContain(
        `${slug} is on ${got}, want ${want}: the red-line fixture is rl-a Team, rl-b Business (docs/ops/hosted.md). Fix the staging tier, then rerun.`,
      );
    },
  );
});

// Cloud #264 step 2: a smoke gate uses rl-a only (REDLINE_SIDES=a). The
// nightly's long suite, with any other value, brings up both, as before.
describe("a smoke gate brings up rl-a only (REDLINE_SIDES=a)", () => {
  it("upgrades and mints rl-a alone, starts no bus pair, and writes no rl-b file", async () => {
    const { f, t } = setup();
    const out = quiet();
    let pairs = 0;
    await bringUp(
      { REDLINE_SIDES: "a" },
      t,
      new Run(CONFIG, f.io),
      noPace,
      () => {
        pairs++;
      },
    );
    expect(
      at(f.log, new RegExp(`/installs/${CONFIG.rlA.id}/upgrade$`)),
    ).toBeGreaterThan(-1);
    expect(at(f.log, new RegExp(`/installs/${CONFIG.rlB.id}/upgrade$`))).toBe(
      -1,
    );
    expect(f.log.filter((l) => /\/redline-creds$/.test(l))).toHaveLength(1);
    expect(existsSync(credFile(t, "a", "PAT"))).toBe(true);
    expect(existsSync(credFile(t, "b", "PAT"))).toBe(false);
    expect(existsSync(credFile(t, "b", "HOOK_KEY"))).toBe(false);
    expect(pairs).toBe(0);
    expect(out.mock.calls.map((c) => String(c[0])).join("")).not.toContain(
      "rl-b",
    );
  });

  it("any other value, or none, brings up both and starts the pair (the nightly)", async () => {
    for (const env of [{}, { REDLINE_SIDES: "ab" }, { REDLINE_SIDES: "b" }]) {
      const { f, t } = setup();
      quiet();
      let pairs = 0;
      await bringUp(env, t, new Run(CONFIG, f.io), noPace, () => {
        pairs++;
      });
      expect(
        f.log.filter((l) => /\/redline-creds$/.test(l)),
        JSON.stringify(env),
      ).toHaveLength(2);
      expect(pairs).toBe(1);
    }
  });

  it("sidesOf reads only the exact value a", () => {
    expect(sidesOf({ REDLINE_SIDES: "a" })).toEqual(["a"]);
    for (const v of [undefined, "", "ab", "A", " a", "b"])
      expect(sidesOf({ REDLINE_SIDES: v })).toEqual(["a", "b"]);
  });

  it("the staged-version check and the revoke follow it: rl-a only", async () => {
    const { f, t } = setup();
    quiet();
    const run = new Run(CONFIG, f.io);
    await bringUp({ REDLINE_SIDES: "a" }, t, run, noPace, noPair);
    // rl-b still runs 0.81.0: checking it would fail.
    expect(await stagedVersion(run, ["a"])).toBe("0.82.0");
    await expect(stagedVersion(run)).rejects.toThrow(/rl-b/);
    const out = quiet();
    const before = f.log.filter((l) => /\/redline-creds$/.test(l)).length;
    expect(await revokeAll({ REDLINE_SIDES: "a" }, t, { run })).toBe(0);
    expect(
      f.log.filter((l) => /\/redline-creds$/.test(l)).length - before,
    ).toBe(1);
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("rl-a: R26 revoked");
    expect(text).not.toContain("rl-b");
  });
});
