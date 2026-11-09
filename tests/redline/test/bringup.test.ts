import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Run } from "../src/provisioning.ts";
import {
  bringUp,
  credFile,
  type RawTargets,
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
const quiet = () => vi.spyOn(process.stdout, "write").mockReturnValue(true);
const at = (log: string[], re: RegExp) => log.findIndex((l) => re.test(l));

describe("bringUp runs rl-a and rl-b at the same time", () => {
  it("both upgrades are sent before either install's creds are taken, and every file is written", async () => {
    const { f, t } = setup();
    const out = quiet();
    await bringUp({}, t, new Run(CONFIG, f.io));
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
    await bringUp({}, t, new Run(CONFIG, f.io));
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
    await expect(bringUp({}, t, refuseUp(f, CONFIG.rlA.id))).rejects.toThrow(
      /^rl-a: /,
    );
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
    await expect(bringUp({}, t, refuseUp(f, CONFIG.rlB.id))).rejects.toThrow(
      /^rl-b: /,
    );
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
    const err = await bringUp({}, t, both).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/^rl-a: /);
    expect(out.mock.calls.map((c) => String(c[0])).join("")).toMatch(/rl-b: /);
  });
});
