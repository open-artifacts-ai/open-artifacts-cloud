import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGING_TEST_DOMAIN } from "@oa/provision/names";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfraError } from "../src/fetch-timeout.ts";
import {
  BUS_PAIR_ERROR_FILE,
  type BusPair,
  busPairSides,
  busPairTargets,
  CLOSE_CEILING_MS,
  type CrossIo,
  crossInstallCase,
  listsName,
  PAUSED_SETTLE_MS,
  PAUSED_WINDOW_MS,
  readBusPair,
  type SuspendIo,
  suspendCase,
  writeBusPair,
} from "../src/hosted-bus.ts";
import { ProbeFail, Run } from "../src/provisioning.ts";
import {
  bringUp,
  bringUpBusPair,
  type RawTargets,
} from "../src/provisioning-live.ts";
import { newRecipient, openSealed, parseCreds } from "../src/seal.ts";
import { secretFileName } from "../src/targets.ts";
import {
  CONFIG,
  type FakeApi,
  fakeApi,
  setVersion,
} from "./provisioning-fake.ts";

// Cloud #202: the hosted bus cases of open-artifacts#1954 on rl-agents and
// rl-busb. The case logic runs on fake seams and a pinned clock; the pair's
// bring-up runs on the fake Provisioning API.

const PAIR: BusPair = {
  agents: {
    name: "rl-agents",
    installId: "iagentsaaaaa",
    app: "https://rl-agents.open-artifacts-staging.app",
    content: "https://rl-agents.open-artifacts-staging.page",
    version: "0.81.0",
  },
  busb: {
    name: "rl-busb",
    installId: "ibusbbbbbbbb",
    app: "https://rl-busb.open-artifacts-staging.app",
    content: "https://rl-busb.open-artifacts-staging.page",
    version: "0.82.0",
  },
};
const TOKEN = "oa_machine_secretsecretsecret";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "oa-hosted-bus-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const unauthorized = JSON.stringify({ error: { code: "unauthorized" } });

/** Case 1's seam: B refuses, A upgrades, the content host refuses, nothing changes. */
function crossIo(
  o: {
    atB?: { status: number; body: string };
    atA?: number;
    atContent?: number;
    changes?: boolean;
  } = {},
): CrossIo & { calls: string[] } {
  const calls: string[] = [];
  let snaps = 0;
  return {
    calls,
    mintA: async () => {
      calls.push("mint");
      return TOKEN;
    },
    connect: async (origin, token) => {
      expect(token).toBe(TOKEN);
      calls.push(`connect ${origin}`);
      if (origin === PAIR.busb.app)
        return o.atB ?? { status: 401, body: unauthorized };
      if (origin === PAIR.agents.app) return { status: o.atA ?? 101, body: "" };
      return { status: o.atContent ?? 404, body: "" };
    },
    snapshotB: async () => {
      calls.push("snapshot");
      return o.changes && snaps++ > 0 ? "after" : "before";
    },
  };
}

describe("case 1: rl-agents' machine token at rl-busb", () => {
  it("passes in OA Bus's order: mint on A, snapshot B, B is 401 unauthorized, A is 101, B's content host refuses, B unchanged", async () => {
    const io = crossIo();
    await crossInstallCase(io, PAIR);
    expect(io.calls).toEqual([
      "mint",
      "snapshot",
      `connect ${PAIR.busb.app}`,
      `connect ${PAIR.agents.app}`,
      `connect ${PAIR.busb.content}`,
      "snapshot",
    ]);
  });

  it.each<[string, Parameters<typeof crossIo>[0], RegExp]>([
    [
      "B upgrades it",
      { atB: { status: 101, body: "" } },
      /upgraded rl-agents's machine token \(101\)/,
    ],
    [
      "B is off (404)",
      { atB: { status: 404, body: "" } },
      /answered 404 no code, want 401 unauthorized/,
    ],
    [
      "B is 401 with another code",
      {
        atB: {
          status: 401,
          body: JSON.stringify({ error: { code: "forbidden" } }),
        },
      },
      /401 forbidden, want 401 unauthorized/,
    ],
    [
      "the control is not 101",
      { atA: 401 },
      /control: rl-agents answered its own machine token with 401/,
    ],
    [
      "B's content host upgrades it",
      { atContent: 101 },
      /content host upgraded/,
    ],
    [
      "B's machines or roster change",
      { changes: true },
      /machines or roster changed/,
    ],
  ])("fails when %s, and never names the token", async (_, o, re) => {
    const e = await crossInstallCase(crossIo(o), PAIR).catch((x) => x);
    expect(e).toBeInstanceOf(ProbeFail);
    expect((e as Error).message).toMatch(re);
    expect((e as Error).message).not.toContain(TOKEN);
  });
});

/** Case 2's seam on a pinned clock; `o` breaks one step. */
function suspendIo(
  o: {
    closeAtMs?: number | null;
    closeCode?: number | null;
    pausedFromMs?: number;
    upgradeAtMs?: number;
    unpauseAtMs?: number;
    bystanderClosesAtMs?: number;
    suspendFails?: boolean;
    resumeFails?: boolean;
    reopenStatus?: number;
    redelivered?: boolean;
    hub?: string | null;
  } = {},
): SuspendIo & { log: string[]; reconnectsAt: number[]; t: { now: number } } {
  const t = { now: 0 };
  const log: string[] = [];
  const reconnectsAt: number[] = [];
  let suspendedAt: number | null = null;
  let closedAt: number | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  const closeAt = o.closeAtMs === undefined ? 5_000 : o.closeAtMs;
  const tick = () => {
    if (suspendedAt !== null && closeAt !== null && closedAt === null)
      if (t.now - suspendedAt >= closeAt) {
        closedAt = t.now;
        resolveClosed();
      }
  };
  const bystanderOpen = () =>
    o.bystanderClosesAtMs === undefined ||
    suspendedAt === null ||
    t.now - suspendedAt < o.bystanderClosesAtMs;
  return {
    log,
    reconnectsAt,
    t,
    now: () => t.now,
    wait: async (ms) => {
      t.now += ms;
      tick();
      await Promise.resolve();
    },
    openBystander: async () => {
      log.push("bystander");
      return {
        closed: new Promise(() => {}),
        isOpen: bystanderOpen,
        closeCode: () => null,
      };
    },
    openDaemon: async () => {
      log.push("daemon");
      return {
        closed,
        isOpen: () => closedAt === null,
        closeCode: () => (o.closeCode === undefined ? 4403 : o.closeCode),
        msgId: "Msg1111111111111",
      };
    },
    suspend: async () => {
      log.push("suspend");
      if (o.suspendFails) throw new ProbeFail("rl-busb suspend: job failed");
      t.now += 20_000;
      suspendedAt = t.now;
      tick();
    },
    resume: async () => {
      log.push("resume");
      if (o.resumeFails) throw new ProbeFail("rl-busb resume: job failed");
    },
    reconnect: async () => {
      const since = t.now - (closedAt ?? t.now);
      reconnectsAt.push(since);
      if (o.upgradeAtMs !== undefined && since >= o.upgradeAtMs)
        return { status: 101, paused: false };
      if (o.unpauseAtMs !== undefined && since >= o.unpauseAtMs)
        return { status: 401, paused: false };
      const paused = since >= (o.pausedFromMs ?? 30_000);
      return { status: paused ? 503 : 401, paused };
    },
    reopen: async (id) => {
      log.push(`reopen ${id}`);
      return {
        status: o.reopenStatus ?? 101,
        redelivered: o.redelivered ?? true,
      };
    },
    hubProblem: async () => {
      log.push("hub");
      return o.hub ?? null;
    },
  };
}

describe("case 2: suspend rl-busb", () => {
  it("passes: closes with 4403, refuses reconnects for 6 min (paused from the first paused answer on), resumes, reopens with the pending mail, hub intact", async () => {
    const io = suspendIo();
    const r = await suspendCase(io, PAIR);
    expect(io.log).toEqual([
      "bystander",
      "daemon",
      "suspend",
      "resume",
      "reopen Msg1111111111111",
      "hub",
    ]);
    expect(r.closeMs).toBe(5_000);
    // The window ran its 6 min from the close: the last reconnect is past it.
    expect(io.reconnectsAt.at(-1)).toBeGreaterThanOrEqual(PAUSED_WINDOW_MS);
    expect(
      io.reconnectsAt.every(
        (ms, i) => i === 0 || ms - (io.reconnectsAt[i - 1] ?? 0) <= 30_000,
      ),
    ).toBe(true);
    expect(r.reconnects).toBe(io.reconnectsAt.length);
    expect(r.pausedMs).toBeGreaterThanOrEqual(PAUSED_WINDOW_MS - 30_000);
  });

  it.each<[string, Parameters<typeof suspendIo>[0], RegExp]>([
    [
      "the socket never closes",
      { closeAtMs: null },
      new RegExp(`still open ${CLOSE_CEILING_MS / 1000} s after the suspend`),
    ],
    [
      "it closes with another code",
      { closeCode: 1006 },
      /closed with 1006, want 4403/,
    ],
    [
      "it closes with no code",
      { closeCode: null },
      /closed with no code, want 4403/,
    ],
    [
      "a reconnect upgrades in the window",
      { upgradeAtMs: 200_000 },
      /upgraded the daemon's token 210 s into the suspend/,
    ],
    [
      "a reconnect is not paused after a paused one",
      { unpauseAtMs: 300_000 },
      /with 401, after dispatch's paused answer/,
    ],
    [
      "dispatch never pauses",
      { pausedFromMs: 10 * 60_000 },
      new RegExp(
        `no paused answer from dispatch ${PAUSED_SETTLE_MS / 1000} s after the close`,
      ),
    ],
    [
      "rl-agents' socket closes in the window",
      { bystanderClosesAtMs: 100_000 },
      /rl-agents's bus socket closed while the other install was suspended/,
    ],
  ])("fails when %s, and still resumes", async (_, o, re) => {
    const io = suspendIo(o);
    await expect(suspendCase(io, PAIR)).rejects.toThrow(re);
    expect(io.log).toContain("resume");
    expect(io.log.some((l) => l.startsWith("reopen"))).toBe(false);
  });

  it("a failed suspend request is still followed by a resume (its answer may be lost)", async () => {
    const io = suspendIo({ suspendFails: true });
    await expect(suspendCase(io, PAIR)).rejects.toThrow(/suspend: job failed/);
    expect(io.log).toEqual(["bystander", "daemon", "suspend", "resume"]);
  });

  it("the first failure wins over a failed resume; a failed resume alone fails", async () => {
    await expect(
      suspendCase(suspendIo({ closeCode: 1000, resumeFails: true }), PAIR),
    ).rejects.toThrow(/want 4403/);
    await expect(
      suspendCase(suspendIo({ resumeFails: true }), PAIR),
    ).rejects.toThrow(/resume: job failed/);
  });

  it.each<[string, Parameters<typeof suspendIo>[0], RegExp]>([
    [
      "the same token is refused after the resume",
      { reopenStatus: 401 },
      /answered the same machine token with 401, want 101/,
    ],
    [
      "the pending mail is gone",
      { redelivered: false },
      /the pending mail did not come again/,
    ],
    [
      "the hub lost the machine",
      { hub: "the machine is not listed, or is revoked" },
      /hub: the machine is not listed/,
    ],
  ])("fails after the resume when %s", async (_, o, re) => {
    await expect(suspendCase(suspendIo(o), PAIR)).rejects.toThrow(re);
  });
});

describe("the pair file", () => {
  it("round-trips, and gives the guard both installs as targets", () => {
    const d = scratch();
    writeBusPair(d, PAIR);
    expect(readBusPair(d)).toEqual(PAIR);
    expect(
      busPairTargets({
        REDLINE_TARGETS: JSON.stringify({ secretsDir: d }),
      }).map((x) => x.name),
    ).toEqual(["rl-agents", "rl-busb"]);
  });

  it("is infra when bring-up wrote an error or nothing; no targets then", () => {
    const d = scratch();
    expect(() => readBusPair(d)).toThrow(InfraError);
    expect(
      busPairTargets({ REDLINE_TARGETS: JSON.stringify({ secretsDir: d }) }),
    ).toEqual([]);
    expect(busPairTargets({})).toEqual([]);
    writeBusPair(d, PAIR);
    rmSync(join(d, "REDLINE_BUS_PAIR"));
    writeFileSync(
      join(d, BUS_PAIR_ERROR_FILE),
      "rl-busb: R26 rl-busb: job failed\n",
    );
    expect(() => readBusPair(d)).toThrow(
      "infra: bus pair bring-up: rl-busb: R26 rl-busb: job failed",
    );
  });

  it("listsName finds a name at any depth, and only that name", () => {
    expect(
      listsName({ agents: [{ name: "redline-recv" }] }, "redline-recv"),
    ).toBe(true);
    expect(
      listsName({ agents: [{ name: "redline-recv-2" }] }, "redline-recv"),
    ).toBe(false);
  });
});

// --- Bring-up on the fake Provisioning API ---------------------------------

function withAgents(
  f: FakeApi,
  o: { busb?: "absent" | "old" | "suspended" } = {},
) {
  const rla = f.installs.get(CONFIG.rlA.id);
  if (!rla) throw new Error("no rl-a in the fake");
  const copy = (
    id: string,
    slug: string,
    extra: Record<string, unknown> = {},
  ) =>
    f.installs.set(id, {
      ...rla,
      id,
      slug,
      appHost: `${slug}.open-artifacts-staging.app`,
      contentHost: `${slug}.open-artifacts-staging.page`,
      version: "0.81.0",
      ...extra,
    });
  copy("iagentsaaaaa", "rl-agents");
  if (o.busb === "old") copy("ibusbbbbbbbb", "rl-busb");
  if (o.busb === "suspended")
    copy("ibusbbbbbbbb", "rl-busb", { state: "suspended", mode: "paused" });
}

const quiet = () => vi.spyOn(process.stdout, "write").mockReturnValue(true);
const noPace = async () => {};
async function recipient() {
  const r = await newRecipient();
  return {
    publicKey: r.publicKey,
    open: async (s: string) => parseCreds(await openSealed(r, s)),
  };
}

describe("bringUpBusPair", () => {
  it("creates rl-busb over OIDC at the release under test (rl- slug, testHooks, the test domain's owner), leaves rl-agents' version, and writes both installs' creds and the pair", async () => {
    const f = fakeApi();
    withAgents(f);
    const d = scratch();
    quiet();
    const p = await bringUpBusPair(
      new Run(CONFIG, f.io),
      d,
      await recipient(),
      noPace,
    );
    const create = f.creates.find((c) => c.slug === "rl-busb");
    expect(create).toMatchObject({ testHooks: true, version: CONFIG.version });
    expect(String(create?.ownerEmail)).toMatch(
      new RegExp(`@${STAGING_TEST_DOMAIN.replace(".", "\\.")}$`),
    );
    expect(
      f.log.some((l) => /iagentsaaaaa\/(upgrade|suspend|resume)$/.test(l)),
    ).toBe(false);
    expect(p.agents.version).toBe("0.81.0");
    expect(p.busb.version).toBe(CONFIG.version);
    expect(readBusPair(d)).toEqual(p);
    for (const n of ["rl-agents", "rl-busb"])
      for (const k of ["PAT", "HOOK_KEY"] as const)
        expect(
          readFileSync(join(d, secretFileName(n, k)), "utf8").length,
        ).toBeGreaterThan(10);
    expect(
      busPairSides(d)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["rl-agents", "rl-busb"]);
  });

  it("upgrades an older rl-busb, and resumes one a cut-off run left suspended first", async () => {
    for (const busb of ["old", "suspended"] as const) {
      const f = fakeApi();
      withAgents(f, { busb });
      quiet();
      await bringUpBusPair(
        new Run(CONFIG, f.io),
        scratch(),
        await recipient(),
        noPace,
      );
      const resume = f.log.findIndex((l) => l.endsWith("ibusbbbbbbbb/resume"));
      const up = f.log.findIndex((l) => l.endsWith("ibusbbbbbbbb/upgrade"));
      expect(up, busb).toBeGreaterThan(-1);
      if (busb === "suspended") expect(resume).toBeGreaterThan(-1);
      if (busb === "suspended") expect(resume).toBeLessThan(up);
      else expect(resume).toBe(-1);
      expect(f.creates.some((c) => c.slug === "rl-busb")).toBe(false);
    }
  });

  it("no rl-agents on staging is infra, and nothing is created", async () => {
    const f = fakeApi();
    quiet();
    await expect(
      bringUpBusPair(
        new Run(CONFIG, f.io),
        scratch(),
        await recipient(),
        noPace,
      ),
    ).rejects.toThrow(/infra: rl-agents is not on staging/);
    expect(f.creates).toEqual([]);
  });
});

describe("bringUp and the pair", () => {
  it("a pair that fails never fails the bring-up: its reason is written for the bus cases", async () => {
    const f = fakeApi();
    setVersion(f, CONFIG.rlA.id, "0.80.0");
    const d = scratch();
    const t: RawTargets = {
      secretsDir: d,
      a: { name: "rl-a", installId: CONFIG.rlA.id, app: CONFIG.rlA.app },
      b: { name: "rl-b", installId: CONFIG.rlB.id, app: CONFIG.rlB.app },
    };
    const out = quiet();
    await bringUp({}, t, new Run(CONFIG, f.io), noPace, async () => {
      throw new InfraError("rl-agents is not on staging");
    });
    expect(existsSync(join(d, BUS_PAIR_ERROR_FILE))).toBe(true);
    expect(() => readBusPair(d)).toThrow(
      /bus pair bring-up: infra: rl-agents is not on staging/,
    );
    expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "bus pair: not ready",
    );
  });
});
