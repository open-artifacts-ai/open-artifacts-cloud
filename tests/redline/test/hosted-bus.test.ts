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
  BREACH_MARK,
  BreachFail,
  BUS_LANE_WORST_MS,
  BUS_PAIR_ERROR_FILE,
  BUS_PAIR_LOG_FILE,
  BUS_PAIR_STARTED_FILE,
  BUS_PAIR_WAIT_MS,
  type BusPair,
  busPairEnded,
  busPairSides,
  busPairTargets,
  CLOSE_WITHIN_MS,
  type CrossIo,
  crossInstallCase,
  hubView,
  listsName,
  PAUSE_WINDOW_MS,
  RECONNECT_AT_MS,
  readBusPair,
  type SuspendIo,
  suspendCase,
  WINDOW_CLOSE_DEADLINE_MS,
  waitBusPair,
  writeBusPair,
} from "../src/hosted-bus.ts";
import { ProbeFail, Run } from "../src/provisioning.ts";
import {
  awaitPairEnd,
  bringUp,
  bringUpBusPair,
  jobDeadline,
  type RawTargets,
  revokeAll,
  runBusPair,
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

describe("case 1: rl-busa's machine token at rl-busb", () => {
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
    // OA Bus M1: a 101 at B's app or content host is a breach.
    const breach = o?.atB?.status === 101 || o?.atContent === 101;
    const e = await crossInstallCase(crossIo(o), PAIR).catch((x) => x);
    expect(e).toBeInstanceOf(ProbeFail);
    expect((e as Error).message).toMatch(re);
    expect((e as Error).message).not.toContain(TOKEN);
    expect(e instanceof BreachFail, "breach").toBe(breach);
  });

  it("compares B's machines and roster by ids and labels or names, not raw JSON", () => {
    const m = (t: number) =>
      JSON.stringify({
        machines: [{ id: "m1", label: "x", revokedAt: null, lastUsedAt: t }],
      });
    const a = (state: string) =>
      JSON.stringify({ agents: [{ id: "a1", name: "redline-recv", state }] });
    expect(hubView(m(1), a("live")).view).toBe(hubView(m(2), a("away")).view);
    expect(hubView(m(1), a("live"), "x", "redline-recv").ours).toBe(true);
    expect(
      hubView(
        JSON.stringify({ machines: [{ id: "m1", label: "x", revokedAt: 5 }] }),
        a("live"),
        "x",
        "redline-recv",
      ).ours,
    ).toBe(false);
    expect(
      hubView(m(1), JSON.stringify({ agents: [{ id: "a2", name: "y" }] })).view,
    ).not.toBe(hubView(m(1), a("live")).view);
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
    /** The hub after the resume: "same" (default), "changed" or "gone" (ours missing). */
    hubAfter?: "same" | "changed" | "gone";
    daemonClosedEarly?: boolean;
    /** Reconnects before this (ms after the job's done) get 101 and a held socket (the pause window). */
    windowUntilMs?: number;
    /** When the install's later pass closes a window socket (ms after the job's done; null: never) and with what code. */
    windowCloseAtMs?: number | null;
    windowCloseCode?: number | null;
    windowTexts?: string[];
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
  const windowTicks: (() => void)[] = [];
  const tick = () => {
    for (const w of windowTicks) w();
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
        isOpen: () => closedAt === null && !o.daemonClosedEarly,
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
    reconnectHold: async () => {
      reconnectsAt.push(since());
      if (o.windowUntilMs !== undefined && since() < o.windowUntilMs) {
        let open = true;
        let resolveWin!: () => void;
        const winClosed = new Promise<void>((r) => {
          resolveWin = r;
        });
        const due =
          o.windowCloseAtMs === undefined ? 121_000 : o.windowCloseAtMs;
        windowTicks.push(() => {
          if (open && due !== null && since() >= due) {
            open = false;
            resolveWin();
          }
        });
        return {
          status: 101,
          paused: false,
          sock: {
            closed: winClosed,
            isOpen: () => open,
            closeCode: () =>
              o.windowCloseCode === undefined ? 4403 : o.windowCloseCode,
            texts: () => o.windowTexts ?? [],
          },
        };
      }
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
    hub: async () => {
      // Before the suspend (doneAt null) the daemon's hub; after the resume,
      // whatever the test asks for.
      const after = doneAt !== null;
      log.push(after ? "hub after" : "hub before");
      const how = after ? (o.hubAfter ?? "same") : "same";
      return {
        view: how === "changed" ? "other" : "same",
        ours: how !== "gone",
      };
    },
  };
}

describe("case 2: suspend rl-busb", () => {
  it("passes: closes within 30 s with 4403, reconnects at 10, 60 and 125 s are dispatch's paused answer (no window 101), resumes, reopens with the pending mail, hub intact", async () => {
    const io = suspendIo();
    const r = await suspendCase(io, PAIR);
    // The hub is compared after the resume and BEFORE the reopen (OA Bus M2).
    expect(io.log).toEqual([
      "bystander",
      "daemon",
      "hub before",
      "suspend",
      "resume",
      "hub after",
      "reopen Msg1111111111111",
    ]);
    expect(r.closeMs).toBe(5_000);
    expect(io.reconnectsAt).toEqual([...RECONNECT_AT_MS]);
    expect(RECONNECT_AT_MS).toEqual([10_000, 60_000, 125_000]);
    expect(r.reconnects).toBe(3);
    expect(r.windowOpens).toBe(0);
  });

  describe("the pause window (P20, #228)", () => {
    it("a 101 at 10 s and 60 s closed with 4403 by the later pass passes, and is recorded", async () => {
      const io = suspendIo({
        windowUntilMs: PAUSE_WINDOW_MS,
        windowCloseAtMs: 121_000,
      });
      const r = await suspendCase(io, PAIR);
      expect(r.windowOpens).toBe(2);
      expect(r.windowCloseMs).toEqual([121_000, 121_000]);
      expect(io.log).toContain("resume");
    });

    it("frames on window sockets are counted by type and a delivery is flagged, never failed on", async () => {
      const r = await suspendCase(
        suspendIo({
          windowUntilMs: PAUSE_WINDOW_MS,
          windowTexts: [
            JSON.stringify({ type: "hello_ok" }),
            JSON.stringify({ type: "deliver" }),
            "nope",
          ],
        }),
        PAIR,
      );
      expect(r.windowFrames).toEqual({ hello_ok: 2, deliver: 2, unparsed: 2 });
      expect(r.windowDelivery).toBe(true);
    });

    it("a window socket still open at the deadline is a breach, and still resumes", async () => {
      const io = suspendIo({
        windowUntilMs: PAUSE_WINDOW_MS,
        windowCloseAtMs: null,
      });
      const e = await suspendCase(io, PAIR).catch((x) => x);
      expect(e).toBeInstanceOf(BreachFail);
      expect((e as Error).message).toMatch(
        /a socket opened in the pause window was still open 150 s after the suspend/,
      );
      expect(io.log).toContain("resume");
    });

    it("a window socket closed after the deadline is a breach", async () => {
      await expect(
        suspendCase(
          suspendIo({
            windowUntilMs: PAUSE_WINDOW_MS,
            windowCloseAtMs: WINDOW_CLOSE_DEADLINE_MS + 1_000,
          }),
          PAIR,
        ),
      ).rejects.toThrow(/still open 150 s after the suspend/);
    });

    it("a window socket closed with 1006 is a breach", async () => {
      const e = await suspendCase(
        suspendIo({ windowUntilMs: PAUSE_WINDOW_MS, windowCloseCode: 1006 }),
        PAIR,
      ).catch((x) => x);
      expect(e).toBeInstanceOf(BreachFail);
      expect((e as Error).message).toMatch(/closed with 1006, want 4403/);
    });

    it("a 101 at 125 s is still a breach, window sockets or not", async () => {
      const e = await suspendCase(
        suspendIo({ windowUntilMs: PAUSE_WINDOW_MS, upgradeAtMs: 120_000 }),
        PAIR,
      ).catch((x) => x);
      expect(e).toBeInstanceOf(BreachFail);
      expect((e as Error).message).toMatch(/upgraded the daemon's token 125 s/);
    });
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

  it("OA Bus M1: a 101 for a suspended install is a breach, never a plain failure", async () => {
    const e = await suspendCase(
      suspendIo({ upgradeAtMs: PAUSE_WINDOW_MS }),
      PAIR,
    ).catch((x) => x);
    expect(e).toBeInstanceOf(BreachFail);
    expect((e as Error).message.startsWith(BREACH_MARK)).toBe(true);
  });

  it("the daemon socket must be open just before the suspend; nothing is suspended then", async () => {
    const io = suspendIo({ daemonClosedEarly: true });
    await expect(suspendCase(io, PAIR)).rejects.toThrow(
      /daemon socket closed before the suspend/,
    );
    expect(io.log).not.toContain("suspend");
  });

  it("a failed suspend request is still followed by a resume (its answer may be lost)", async () => {
    const io = suspendIo({ suspendFails: true });
    await expect(suspendCase(io, PAIR)).rejects.toThrow(/suspend: job failed/);
    expect(io.log).toEqual([
      "bystander",
      "daemon",
      "hub before",
      "suspend",
      "resume",
    ]);
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
      "the hub's machines or roster changed",
      { hubAfter: "changed" },
      /hub is not the one before the suspend \(machines or roster changed\)/,
    ],
    [
      "the hub lost the case's machine or receiver",
      { hubAfter: "gone" },
      /the case's machine or receiver is gone/,
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

describe("bringUp and the pair (its own process)", () => {
  const targets = (d: string): RawTargets => ({
    secretsDir: d,
    a: { name: "rl-a", installId: CONFIG.rlA.id, app: CONFIG.rlA.app },
    b: { name: "rl-b", installId: CONFIG.rlB.id, app: CONFIG.rlB.app },
  });

  it("starts the pair before rl-a's and rl-b's chains and returns without waiting for it", async () => {
    const f = fakeApi();
    setVersion(f, CONFIG.rlA.id, "0.80.0");
    const d = scratch();
    quiet();
    let startedAt = -1;
    await bringUp({}, targets(d), new Run(CONFIG, f.io), noPace, () => {
      startedAt = f.log.length;
    });
    // Before any request of the a/b chains; nothing of the pair was awaited.
    expect(startedAt).toBe(0);
    expect(f.log.some((l) => /redline-creds$/.test(l))).toBe(true);
    expect(existsSync(join(d, "REDLINE_BUS_PAIR"))).toBe(false);
    expect(existsSync(join(d, BUS_PAIR_ERROR_FILE))).toBe(false);
  });

  it("runBusPair writes the pair, or the reason it failed, so its end is always marked", async () => {
    const f = fakeApi();
    const d = scratch();
    quiet();
    await runBusPair({}, targets(d), new Run(CONFIG, f.io), noPace);
    expect(readBusPair(d).busb.name).toBe("rl-busb");
    const g = fakeApi();
    g.faults.add("signups_closed");
    const e = scratch();
    const broken = new Run(CONFIG, {
      ...g.io,
      fetch: (async () => new Response("no", { status: 500 })) as typeof fetch,
    });
    await runBusPair({}, targets(e), broken, noPace);
    expect(busPairEnded(e)).toBe(true);
    expect(() => readBusPair(e)).toThrow(
      /bus pair bring-up: rl-busa: R2 q=rl-busa/,
    );
  });

  it("the bus lane waits for the pair with its own deadline; not ended by then is infra", async () => {
    const d = scratch();
    const t = { now: 0 };
    const clock = {
      now: () => t.now,
      wait: async (ms: number) => {
        t.now += ms;
        if (t.now >= 60_000) writeBusPair(d, PAIR);
      },
    };
    await expect(waitBusPair(d, 120_000, clock)).resolves.toEqual(PAIR);
    const e = scratch();
    t.now = 0;
    await expect(
      waitBusPair(e, 30_000, {
        now: () => t.now,
        wait: async (ms) => {
          t.now += ms;
        },
      }),
    ).rejects.toThrow("infra: bus pair bring-up not done within 1 min");
  });

  it("the revoke waits for a started pair, bounded; one still going is stopped by its own pid; its log prints without workflow commands", async () => {
    const d = scratch();
    // Not started: nothing to wait for.
    await awaitPairEnd(d, 1_000, { wait: async () => {}, now: () => 0 });
    writeFileSync(join(d, BUS_PAIR_STARTED_FILE), "424242\n");
    writeFileSync(
      join(d, BUS_PAIR_LOG_FILE),
      "rl-busa: created (0.82.0)\n::add-mask::secret\n",
    );
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const out = quiet();
    const t = { now: 0 };
    await awaitPairEnd(d, 30_000, {
      now: () => t.now,
      wait: async (ms) => {
        t.now += ms;
      },
    });
    expect(t.now).toBeGreaterThanOrEqual(30_000);
    expect(kill).toHaveBeenCalledWith(424242, "SIGTERM");
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("bus pair log: rl-busa: created (0.82.0)");
    expect(text).not.toContain("secret");
    // Ended already: no wait, no kill.
    kill.mockClear();
    writeBusPair(d, PAIR);
    t.now = 0;
    await awaitPairEnd(d, 30_000, {
      now: () => t.now,
      wait: async (ms) => {
        t.now += ms;
      },
    });
    expect(t.now).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("the revoke inside the job's deadline (cloud #202)", () => {
  const targets = (d: string): RawTargets => ({
    secretsDir: d,
    a: { name: "rl-a", installId: CONFIG.rlA.id, app: CONFIG.rlA.app },
    b: { name: "rl-b", installId: CONFIG.rlB.id, app: CONFIG.rlB.app },
  });
  /** A pair brought up on the fake, so its sides file lists both installs. */
  async function upPair() {
    const f = fakeApi();
    const d = scratch();
    quiet();
    await bringUpBusPair(new Run(CONFIG, f.io), d, await recipient(), noPace);
    writeFileSync(join(d, BUS_PAIR_STARTED_FILE), "1\n");
    // The fake serves /api/v1/me for rl-a and rl-b only: no PAT check here.
    for (const n of ["rl-busa", "rl-busb"])
      rmSync(join(d, secretFileName(n, "PAT")));
    vi.restoreAllMocks();
    return { f, d };
  }
  const revokes = (f: FakeApi) =>
    f.log.filter((l) => /redline-creds$/.test(l)).length;

  it("the bus lane's worst case fits between the suite's latest start (75 min) and the revoke's cap (110 min)", () => {
    expect(BUS_PAIR_WAIT_MS).toBe(10 * 60_000);
    expect(BUS_LANE_WORST_MS).toBeLessThanOrEqual(35 * 60_000);
    expect(Math.round(BUS_LANE_WORST_MS / 60_000)).toBe(31);
  });

  it("the deadline is the job's start + 150 min - 5 min: REDLINE_JOB_STARTED_AT, else the VM's boot", () => {
    expect(jobDeadline({ REDLINE_JOB_STARTED_AT: "1000" }, 0, 0)).toBe(
      1000 + 145 * 60_000,
    );
    expect(jobDeadline({}, 10 * 60_000, 120)).toBe(8 * 60_000 + 145 * 60_000);
  });

  it("with time left: rl-a and rl-b first, then both pair installs", async () => {
    const { f, d } = await upPair();
    const before = revokes(f);
    const out = quiet();
    const code = await revokeAll({}, targets(d), {
      run: new Run(CONFIG, f.io),
      deadline: f.io.now() + 60 * 60_000,
      now: f.io.now,
    });
    expect(code).toBe(0);
    expect(revokes(f) - before).toBe(4);
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    expect(text.indexOf("rl-b: R26 revoked")).toBeLessThan(
      text.indexOf("rl-busa: R26 revoked"),
    );
    expect(text).toContain("rl-busb: R26 revoked");
  });

  it("with no time left: rl-a and rl-b only, and a loud warning for the pair; the step doesn't fail on it", async () => {
    const { f, d } = await upPair();
    const before = revokes(f);
    const out = quiet();
    const code = await revokeAll({}, targets(d), {
      run: new Run(CONFIG, f.io),
      deadline: f.io.now() + 60_000,
      now: f.io.now,
    });
    expect(code).toBe(0);
    expect(revokes(f) - before).toBe(2);
    expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "::warning::rl-busa/rl-busb R26 not revoked: no time left; the next run's mint revokes them",
    );
  });

  it("OA Bus M3: rl-busb left suspended is resumed before its revoke", async () => {
    const { f, d } = await upPair();
    const busb = [...f.installs.values()].find((i) => i.slug === "rl-busb");
    if (!busb) throw new Error("no rl-busb");
    busb.state = "suspended";
    const out = quiet();
    await revokeAll({}, targets(d), {
      run: new Run(CONFIG, f.io),
      deadline: f.io.now() + 60 * 60_000,
      now: f.io.now,
    });
    expect(f.log.some((l) => l.endsWith(`${busb.id}/resume`))).toBe(true);
    expect(busb.state).toBe("active");
    expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "rl-busb: suspended at cleanup, resuming",
    );
  });
});
