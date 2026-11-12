import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HookBudgetError } from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";
import { Run } from "../src/provisioning.ts";
import {
  bringUp,
  credFile,
  type RawTargets,
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
const quiet = () => vi.spyOn(process.stdout, "write").mockReturnValue(true);
const at = (log: string[], re: RegExp) => log.findIndex((l) => re.test(l));

describe("bringUp runs rl-a and rl-b at the same time", () => {
  it("both upgrades are sent before either install's creds are taken, and every file is written", async () => {
    const { f, t } = setup();
    const out = quiet();
    await bringUp({}, t, new Run(CONFIG, f.io), noPace);
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
    await bringUp({}, t, new Run(CONFIG, f.io), noPace);
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
      bringUp({}, t, refuseUp(f, CONFIG.rlA.id), noPace),
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
      bringUp({}, t, refuseUp(f, CONFIG.rlB.id), noPace),
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
    const err = await bringUp({}, t, both, noPace).then(
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
    await bringUp({}, t, new Run(CONFIG, f.io), noPace);
    // Three old answers and the fourth accepted, per install.
    expect(calls(f)).toHaveLength(8);
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("rl-a: the new hook key is accepted");
    expect(text).toContain("rl-b: the new hook key is accepted");
  });

  it("a key accepted at once is checked once per install", async () => {
    const { f, t } = setup();
    quiet();
    await bringUp({}, t, new Run(CONFIG, f.io), noPace);
    expect(calls(f)).toHaveLength(2);
  });

  it("a key never accepted fails the bring-up as infra after 90 s, naming the install", async () => {
    const { f, t } = setup();
    f.faults.add("hook_key_never");
    quiet();
    const err = await bringUp({}, t, new Run(CONFIG, f.io), noPace).then(
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
    await bringUp({}, t, new Run(CONFIG, f.io), noPace);
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
      const err = await bringUp({}, t, new Run(CONFIG, f.io), noPace).then(
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
