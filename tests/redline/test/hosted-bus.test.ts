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
  CLOSE_WITHIN_MS,
  type CrossIo,
  crossInstallCase,
  listsName,
  RECONNECT_AT_MS,
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

// Cloud #202: the hosted bus cases of open-artifacts#1954 on rl-busa and
// rl-busb. The case logic runs on fake seams and a pinned clock; the pair's
// bring-up runs on the fake Provisioning API.

const PAIR: BusPair = {
  busa: {
    name: "rl-busa",
    installId: "ibusaaaaaaaa",
    app: "https://rl-busa.open-artifacts-staging.app",
    content: "https://rl-busa.open-artifacts-staging.page",
    version: "0.82.0",
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
      if (origin === PAIR.busa.app) return { status: o.atA ?? 101, body: "" };
      return { status: o.atContent ?? 404, body: "" };
    },
    snapshotB: async () => {
      calls.push("snapshot");
      return o.changes && snaps++ > 0 ? "after" : "before";
    },
  };
}

describe("case 1: rl-busa' machine token at rl-busb", () => {
  it("passes in OA Bus's order: mint on A, snapshot B, B is 401 unauthorized, A is 101, B's content host refuses, B unchanged", async () => {
    const io = crossIo();
    await crossInstallCase(io, PAIR);
    expect(io.calls).toEqual([
      "mint",
      "snapshot",
      `connect ${PAIR.busb.app}`,
      `connect ${PAIR.busa.app}`,
      `connect ${PAIR.busb.content}`,
      "snapshot",
    ]);
  });

  it.each<[string, Parameters<typeof crossIo>[0], RegExp]>([
    [
      "B upgrades it",
      { atB: { status: 101, body: "" } },
      /upgraded rl-busa's machine token \(101\)/,
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
      /control: rl-busa answered its own machine token with 401/,
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

/** Case 2's seam on a pinned clock (ms since the suspend job's done); `o` breaks one step. */
function suspendIo(
  o: {
    closeAtMs?: number | null;
    closeCode?: number | null;
    pausedFromMs?: number;
    upgradeAtMs?: number;
    bystanderClosesAtMs?: number;
    suspendFails?: boolean;
    resumeFails?: boolean;
    reopenStatus?: number;
    redelivered?: boolean;
    hub?: string | null;
  } = {},
): SuspendIo & { log: string[]; reconnectsAt: number[] } {
  const t = { now: 0 };
  const log: string[] = [];
  const reconnectsAt: number[] = [];
  let doneAt: number | null = null;
  let closedAt: number | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  const closeAt = o.closeAtMs === undefined ? 5_000 : o.closeAtMs;
  const since = () => (doneAt === null ? -1 : t.now - doneAt);
  const tick = () => {
    if (doneAt !== null && closeAt !== null && closedAt === null)
      if (since() >= closeAt) {
        closedAt = t.now;
        resolveClosed();
      }
  };
  return {
    log,
    reconnectsAt,
    now: () => t.now,
    wait: async (ms) => {
      // One second at a time, so a close lands when it is due.
      for (let left = ms; left > 0; left -= 1_000) {
        t.now += Math.min(1_000, left);
        tick();
        await Promise.resolve();
      }
    },
    openBystander: async () => {
      log.push("bystander");
      return {
        closed: new Promise(() => {}),
        isOpen: () =>
          o.bystanderClosesAtMs === undefined ||
          since() < o.bystanderClosesAtMs,
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
      doneAt = t.now;
    },
    resume: async () => {
      log.push("resume");
      if (o.resumeFails) throw new ProbeFail("rl-busb resume: job failed");
    },
    reconnect: async () => {
      reconnectsAt.push(since());
      if (o.upgradeAtMs !== undefined && since() >= o.upgradeAtMs)
        return { status: 101, paused: false };
      const paused = since() >= (o.pausedFromMs ?? 0);
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
  it("passes: closes within 30 s with 4403, reconnects at 10, 60 and 125 s are dispatch's paused answer, resumes, reopens with the pending mail, hub intact", async () => {
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
    expect(io.reconnectsAt).toEqual([...RECONNECT_AT_MS]);
    expect(RECONNECT_AT_MS).toEqual([10_000, 60_000, 125_000]);
    expect(r.reconnects).toBe(3);
  });

  it("a close at 30 s passes; at 31 s it fails, though the 120 s pass would come later", async () => {
    await expect(
      suspendCase(suspendIo({ closeAtMs: CLOSE_WITHIN_MS }), PAIR),
    ).resolves.toMatchObject({ closeMs: CLOSE_WITHIN_MS });
    await expect(
      suspendCase(suspendIo({ closeAtMs: CLOSE_WITHIN_MS + 1_000 }), PAIR),
    ).rejects.toThrow(/still open 30 s after the suspend job was done/);
  });

  it.each<[string, Parameters<typeof suspendIo>[0], RegExp]>([
    [
      "the socket never closes",
      { closeAtMs: null },
      /still open 30 s after the suspend job was done/,
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
      "the 10 s reconnect is not yet paused",
      { pausedFromMs: 20_000 },
      /reconnect 10 s after the suspend with 401, want dispatch's paused 503/,
    ],
    [
      "the 125 s reconnect upgrades",
      { upgradeAtMs: 100_000 },
      /upgraded the daemon's token 125 s after the suspend/,
    ],
    [
      "rl-busa's socket closes in the window",
      { bystanderClosesAtMs: 50_000 },
      /rl-busa's bus socket closed while the other install was suspended/,
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
    ).toEqual(["rl-busa", "rl-busb"]);
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

/** rl-busa and rl-busb in the fake, each absent, older or left suspended. */
function withPair(
  f: FakeApi,
  o: Partial<Record<"busa" | "busb", "absent" | "old" | "suspended">> = {},
) {
  const rla = f.installs.get(CONFIG.rlA.id);
  if (!rla) throw new Error("no rl-a in the fake");
  for (const [k, id] of [
    ["busa", "ibusaaaaaaaa"],
    ["busb", "ibusbbbbbbbb"],
  ] as const) {
    const how = o[k] ?? "absent";
    if (how === "absent") continue;
    const slug = `rl-${k}`;
    f.installs.set(id, {
      ...rla,
      id,
      slug,
      appHost: `${slug}.open-artifacts-staging.app`,
      contentHost: `${slug}.open-artifacts-staging.page`,
      version: "0.81.0",
      ...(how === "suspended" ? { state: "suspended", mode: "paused" } : {}),
    });
  }
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
  it("creates rl-busa and rl-busb over OIDC at the release under test (rl- slug, testHooks, the test domain's owner) and writes both installs' creds and the pair; no other install is touched", async () => {
    const f = fakeApi();
    const d = scratch();
    quiet();
    const p = await bringUpBusPair(
      new Run(CONFIG, f.io),
      d,
      await recipient(),
      noPace,
    );
    for (const slug of ["rl-busa", "rl-busb"]) {
      const create = f.creates.find((c) => c.slug === slug);
      expect(create, slug).toMatchObject({
        testHooks: true,
        version: CONFIG.version,
      });
      expect(String(create?.ownerEmail)).toMatch(
        new RegExp(`@${STAGING_TEST_DOMAIN.replace(".", "\\.")}$`),
      );
    }
    // Only the pair's own installs: no request names another install's id.
    const ours = new Set([p.busa.installId, p.busb.installId]);
    const touched = f.log.flatMap(
      (l) => /\/installs\/([^/?\s]+)/.exec(l)?.[1] ?? [],
    );
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((id) => !ours.has(id))).toEqual([]);
    expect(p.busa.version).toBe(CONFIG.version);
    expect(p.busb.version).toBe(CONFIG.version);
    expect(readBusPair(d)).toEqual(p);
    for (const n of ["rl-busa", "rl-busb"])
      for (const k of ["PAT", "HOOK_KEY"] as const)
        expect(
          readFileSync(join(d, secretFileName(n, k)), "utf8").length,
        ).toBeGreaterThan(10);
    expect(
      busPairSides(d)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["rl-busa", "rl-busb"]);
  });

  it("upgrades an older install, and resumes one a cut-off run left suspended first, each the same way", async () => {
    for (const [busa, busb] of [
      ["old", "suspended"],
      ["suspended", "old"],
    ] as const) {
      const f = fakeApi();
      withPair(f, { busa, busb });
      quiet();
      await bringUpBusPair(
        new Run(CONFIG, f.io),
        scratch(),
        await recipient(),
        noPace,
      );
      for (const [id, how] of [
        ["ibusaaaaaaaa", busa],
        ["ibusbbbbbbbb", busb],
      ] as const) {
        const resume = f.log.findIndex((l) => l.endsWith(`${id}/resume`));
        const up = f.log.findIndex((l) => l.endsWith(`${id}/upgrade`));
        expect(up, `${id} ${how}`).toBeGreaterThan(-1);
        if (how === "suspended") {
          expect(resume).toBeGreaterThan(-1);
          expect(resume).toBeLessThan(up);
        } else expect(resume).toBe(-1);
      }
      expect(f.creates).toEqual([]);
    }
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
      throw new InfraError("rl-busb create: job failed");
    });
    expect(existsSync(join(d, BUS_PAIR_ERROR_FILE))).toBe(true);
    expect(() => readBusPair(d)).toThrow(
      /bus pair bring-up: infra: rl-busb create: job failed/,
    );
    expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "bus pair: not ready",
    );
  });
});
