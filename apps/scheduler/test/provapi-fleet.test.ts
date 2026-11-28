import { canTransition, REQUEST_ID_RE } from "@oa/provisioning-contract";
import {
  FakeWorkflow,
  fakeProvisionerRpc,
} from "@oa/provisioning-contract/fakes";
import { SYSTEM_ACTOR } from "@oa/provisioning-contract/system";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ProvapiEnv } from "../src/provapi/env.js";
import {
  FLEET_BEHIND_PREFIX,
  FLEET_BLOCKED_MS,
  FLEET_BLOCKED_PREFIX,
  FLEET_CONCURRENCY,
  FLEET_DONE_PREFIX,
  FLEET_FAIL_GAP_MS,
  FLEET_FAIL_PREFIX,
  FLEET_HALT_ALERT_MS,
  FLEET_KEEP_MS,
  FLEET_LEASE_KEY,
  FLEET_LEASE_MS,
  FLEET_PROBE_TIMEOUT_MS,
  FLEET_RETRY_PREFIX,
  FLEET_SKEW_MS,
  FLEET_SMOKE_CLEANUP_MS,
  FLEET_SMOKED_PREFIX,
  FLEET_SOAK_GAP_MS,
  FLEET_SOAK_MIN_MAX,
  FLEET_SOAK_MS,
  FLEET_SOAK_OFF_MS,
  FLEET_SOAKED_PREFIX,
  FLEET_TICK_DEADLINE_MS,
  FLEET_UNVERIFIED_PREFIX,
  FLEET_VERIFIED_PREFIX,
  fleetBlockedMs,
  fleetConditions,
  fleetDue,
  fleetMarks,
  fleetPass,
  fleetRequestId,
  fleetSmokeMode,
  fleetSoakOffMs,
  fleetTarget,
  fleetTick,
  onTarget,
} from "../src/provapi/fleet.js";
import type { HealthProbe } from "../src/provapi/health.js";
import { provapiTick } from "../src/provapi/index.js";
import type { SmokeInput, SmokeResult } from "../src/provapi/smoke.js";
import { getState } from "../src/provapi/state.js";
import {
  FLEET_WAKE_BACKOFF_MAX_S,
  FLEET_WAKE_DEADLINE_MS,
  FLEET_WAKE_MAX_RETRIES,
  FLEET_WAKE_TIMEOUT_MS,
  fleetWake,
  wakeBackoffS,
} from "../src/provapi/wake.js";
import { wakeBatch } from "./provapi/batch.js";
import {
  captureLogs,
  db,
  install,
  installId,
  job,
  lifecycle,
  migrate,
  reset,
  rows,
} from "./provapi/db.js";

// #955: the fleet rollout. Every install follows the scheduler's own version
// tag: the canary, then batches, each soaking first. Failures halt it and a
// person decides. "review N" names the #1083 review finding a test pins;
// "item N", the fourth review's.

beforeAll(migrate);
beforeEach(reset);
// #1229: the deploy marks a version verified once every Worker's read-back
// passed. The rollout tests run on verified versions; the gate has its own.
beforeEach(async () => {
  for (const v of ["0.93.0", "0.93.1", "0.93.2"])
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`${FLEET_VERIFIED_PREFIX}${v}`, 1)
      .run();
});
afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 10, 2, 12, 0);
const MIN = 60_000;
const TARGET = "0.93.0";

/**
 * Worst measured wall time of one `fleetDue` tick over the local D1, on a host
 * loaded the way CI loads one: 280 ms. A 19-tick loop below was still running
 * when its 5,301 ms budget expired (5301 / 19 = 279 ms a tick, load average 20+
 * on 24 cores, #1575); quiet runs on the same host measure 93 ms a tick and
 * 25-50 ms for the ticks that do no work. Two real D1 queries per install
 * dominate.
 */
const FLEET_TICK_MS = 280;
/**
 * Slack over FLEET_TICK_MS for a runner slower than the worst one measured: the
 * runs above already spread 93-280 ms a tick, and one busy run put three of
 * these loops past the 5 s default (5.0 s, 5.4 s and 8.2 s).
 */
const FLEET_HEADROOM = 3;
/**
 * Per-test timeout for a test that ticks the fleet `n` times, from its own
 * work: n x worst tick x headroom. The costliest loop here ticks a 2-hour
 * window every 2 minutes (61 ticks), so its budget is 61 x 280 ms x 3 = 51,240
 * ms; the 5 s default is 0.3x that loop's own work on a loaded host, which is
 * what made these loops flake there (#1575).
 */
const fleetTicksTimeout = (n: number) => n * FLEET_TICK_MS * FLEET_HEADROOM;

/** Which installs answer /healthz on which version. */
type Answers = Map<string, string | "down">;

const release = (version: string, installable = true) => ({
  version,
  publishedAt: 1,
  variants: ["release" as const],
  installable,
  latest: true,
});

function fakes(
  o: {
    canary?: string;
    /** The canary smoke's answers in turn (the last repeats); default pass. */
    smoke?: SmokeResult[];
    tag?: string;
    answers?: Answers;
    releases?: ReturnType<typeof release>[];
    manage?: unknown;
  } = {},
) {
  const manage = new FakeWorkflow();
  const answers: Answers = o.answers ?? new Map();
  const probed: string[] = [];
  // An install answers on its own version unless `answers` says otherwise.
  const probe: HealthProbe = async (id) => {
    probed.push(id);
    const own = await db
      .prepare("SELECT version FROM installs WHERE id = ?1")
      .bind(id)
      .first<{ version: string | null }>();
    const v = answers.get(id) ?? own?.version ?? TARGET;
    if (v === "down") return new Response("no", { status: 502 });
    return Response.json({ ok: true, plan: "free", version: v, installId: id });
  };
  const tag = o.tag ?? `v${TARGET}`;
  const env = {
    PLATFORM_DB: db,
    OA_ENV: "staging",
    MANAGE_INSTALL: o.manage ?? manage,
    PROVISIONER: fakeProvisionerRpc({
      releases: o.releases ?? [release(tag.slice(1))],
    }),
    FLEET_CANARY: o.canary ?? "",
    CF_VERSION_METADATA: {
      id: "x",
      tag,
      timestamp: new Date(NOW - MIN).toISOString(),
    },
  } as unknown as ProvapiEnv;
  const smokes: SmokeInput[] = [];
  const results = o.smoke ?? [{ ok: true, notes: [] }];
  const smoke = async (i: SmokeInput): Promise<SmokeResult> => {
    smokes.push(i);
    return results[Math.min(smokes.length, results.length) - 1] as SmokeResult;
  };
  return {
    env,
    manage,
    answers,
    probed,
    smokes,
    opts: { probe, timeoutMs: 1_000, smoke },
  };
}

/** A serving, active, idle install on `version`, created at `created`. */
async function on(
  version: string,
  over: {
    test_hooks?: number;
    suspended?: boolean;
    created?: number;
    serving?: string;
    health?: string;
  } = {},
) {
  const id = installId();
  await install(id, {
    version,
    previous_version: "0.91.0",
    ...(over.test_hooks === undefined ? {} : { test_hooks: over.test_hooks }),
  });
  await lifecycle(id, {
    serving_mode: over.serving ?? "serving",
    created_at: over.created ?? 1,
    health: over.health ?? "ok",
    ...(over.suspended ? { suspended_at: NOW - MIN } : {}),
  });
  return id;
}

const fleetJobs = () =>
  rows(
    "SELECT * FROM jobs WHERE actor_key = ?1 ORDER BY created_at, request_id",
    SYSTEM_ACTOR.key,
  );
const finish = (jobId: unknown, status: string, at = NOW, code?: string) =>
  db
    .prepare(
      "UPDATE jobs SET status = ?2, finished_at = ?3, updated_at = ?3, error_code = ?4 WHERE id = ?1",
    )
    .bind(jobId, status, at, code ?? null)
    .run();
const lifecycleSuspend = (id: string) =>
  db
    .prepare(
      "UPDATE install_lifecycle SET suspended_at = ?2 WHERE install_id = ?1",
    )
    .bind(id, NOW)
    .run();
const setVersion = (id: string, v: string) =>
  db
    .prepare("UPDATE installs SET version = ?2 WHERE id = ?1")
    .bind(id, v)
    .run();
/** A fleet upgrade row, done by default. */
const fleetJob = (
  id: string,
  over: Record<string, string | number | null> & { from?: string; to?: string },
) => {
  const { from = "0.92.0", to = TARGET, ...rest } = over;
  return job(id, {
    kind: "upgrade",
    workflow: "manage_install",
    actor_kind: SYSTEM_ACTOR.kind,
    actor_key: SYSTEM_ACTOR.key,
    actor_label: SYSTEM_ACTOR.label,
    request_id: fleetRequestId(id, to),
    args: JSON.stringify({ from, to }),
    status: "done",
    finished_at: NOW - MIN,
    ...rest,
  });
};

/** The install has soaked on `v`, as the watch records it. */
const soaked = (id: string, v = TARGET) =>
  db
    .prepare(
      "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
    )
    .bind(`${FLEET_SOAKED_PREFIX}${v}:${id}`, NOW - MIN)
    .run();
const stateKeys = async (prefix: string) =>
  (
    await rows(
      "SELECT key FROM platform_state WHERE substr(key, 1, ?2) = ?1 ORDER BY key",
      prefix,
      prefix.length,
    )
  ).map((r) => r.key as string);
const queued = async () =>
  (await fleetJobs())
    .filter((j) => j.status === "queued")
    .map((j) => j.install_id);
/** Ticks every 2 minutes from `from` through `to`. */
async function ticks(f: ReturnType<typeof fakes>, from: number, to: number) {
  for (let t = from; t <= to; t += 2 * MIN) await fleetDue(f.env, t, f.opts);
}

describe("the target and request ids", () => {
  it("the target is the stable version tag, without its v", () => {
    expect(fleetTarget({ tag: "v0.93.0" })).toBe("0.93.0");
    for (const tag of ["0.93.0", "v0.93", "v0.93.0-rc.1", "", "vx.y.z"])
      expect(fleetTarget({ tag }), tag).toBeNull();
    expect(fleetTarget(undefined)).toBeNull();
  });

  it("request ids are one per install and version, and valid", () => {
    const id = installId();
    expect(fleetRequestId(id, "0.93.0")).toBe(`fleet-${id}-0_93_0`);
    expect(fleetRequestId(id, "999.999.999")).toMatch(REQUEST_ID_RE);
    expect(() => fleetRequestId("nope", "0.93.0")).toThrow();
    expect(() => fleetRequestId(id, "0.93.0-rc.1")).toThrow();
  });

  it("the scheduler may upgrade an active install, never a suspended one, and never rolls back", () => {
    expect(canTransition("active", "upgrade", "S")).toBe(true);
    expect(canTransition("suspended", "upgrade", "S")).toBe(false);
    expect(canTransition("active", "rollback", "S")).toBe(false);
  });
});

describe("the platform_verified gate (#1229)", () => {
  const unverify = () =>
    db
      .prepare(
        "DELETE FROM platform_state WHERE key LIKE 'platform_verified:%'",
      )
      .run();

  it("a target without the mark starts no job, and says why", async () => {
    await unverify();
    const canary = await on("0.92.0");
    await on("0.92.0");
    const f = fakes({ canary });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await fleetJobs()).toEqual([]);
    expect(f.manage.created).toEqual([]);
    expect(lines).toEqual([
      "provapi fleet holding: platform not verified",
      "provapi fleet holding: platform not verified",
    ]);
  });

  it("the mark lets the canary through on the next tick", async () => {
    await unverify();
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`${FLEET_VERIFIED_PREFIX}${TARGET}`, NOW)
      .run();
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect((await fleetJobs()).map((j) => j.install_id)).toEqual([canary]);
  });

  it("another version's mark does not count", async () => {
    await unverify();
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`${FLEET_VERIFIED_PREFIX}0.92.0`, NOW)
      .run();
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
  });

  it("no canary: nothing to hold, and no unverified stamp", async () => {
    await unverify();
    const f = fakes({ canary: "" });
    await fleetDue(f.env, NOW, f.opts);
    expect(await stateKeys(FLEET_UNVERIFIED_PREFIX)).toEqual([]);
  });

  it("the hold is stamped once and opens fleet_halted (platform_unverified) after FLEET_BLOCKED_MS", async () => {
    await unverify();
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await stateKeys(FLEET_UNVERIFIED_PREFIX)).toEqual([
      `${FLEET_UNVERIFIED_PREFIX}${TARGET}`,
    ]);
    const env = f.env as unknown as Parameters<typeof fleetConditions>[0];
    const early = await fleetConditions(env, NOW + FLEET_BLOCKED_MS - MIN);
    expect(early.fleet_halted.rows).toEqual([]);
    const late = await fleetConditions(env, NOW + FLEET_BLOCKED_MS);
    expect(late.fleet_halted).toMatchObject({
      open: true,
      rows: [{ code: "platform_unverified", since: NOW, version: TARGET }],
    });
  });

  it("the watch and the failed-job halt go on during the hold", async () => {
    await unverify();
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const id = await on(TARGET, { created: 5 });
    await fleetJob(id, { finished_at: NOW - MIN });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    // The upgraded install was probed, failed twice and halted the version.
    expect(f.probed).toContain(id);
    expect(await stateKeys(`fleet_halt:${TARGET}:`)).toHaveLength(1);
    expect(lines).toContain("provapi fleet holding: platform not verified");
    // A job failed in the hold halts too.
    const bad = await on("0.92.0");
    await fleetJob(bad, { status: "failed", error_code: "upgrade_incomplete" });
    await fleetDue(f.env, NOW + 4 * MIN, f.opts);
    expect(await stateKeys(`fleet_halt:${TARGET}:${bad}`)).toHaveLength(1);
  });

  it("prune removes old versions' platform_verified marks, never the target's or a newer one's", async () => {
    const ins = (k: string, at: number) =>
      db
        .prepare(
          "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
        )
        .bind(k, at)
        .run();
    await ins(`${FLEET_VERIFIED_PREFIX}0.91.0`, NOW - FLEET_KEEP_MS - MIN);
    await ins(`${FLEET_VERIFIED_PREFIX}0.92.0`, NOW - FLEET_KEEP_MS + MIN);
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const left = (
      await rows(
        "SELECT key FROM platform_state WHERE key GLOB 'platform_verified:*'",
      )
    ).map((r) => r.key);
    expect(left).toContain(`${FLEET_VERIFIED_PREFIX}0.92.0`);
    expect(left).toContain(`${FLEET_VERIFIED_PREFIX}${TARGET}`);
    expect(left).not.toContain(`${FLEET_VERIFIED_PREFIX}0.91.0`);
  });

  it("the mark clears the stamp and the alert", async () => {
    await unverify();
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`${FLEET_VERIFIED_PREFIX}${TARGET}`, NOW)
      .run();
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await stateKeys(FLEET_UNVERIFIED_PREFIX)).toEqual([]);
    const env = f.env as unknown as Parameters<typeof fleetConditions>[0];
    const c = await fleetConditions(env, NOW + 2 * FLEET_BLOCKED_MS);
    expect(
      c.fleet_halted.rows.some((r) => r.code === "platform_unverified"),
    ).toBe(false);
  });
});

describe("the rollout", () => {
  it("no canary or no target: nothing moves", async () => {
    const canary = await on("0.92.0");
    const lines = captureLogs(vi.spyOn);
    for (const f of [
      fakes({ canary: "" }),
      fakes({ canary: "canary" }),
      fakes({ canary, tag: "v0.93.0-rc.1" }),
    ])
      await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
    expect(lines).toEqual([
      "provapi fleet no_canary",
      "provapi fleet no_canary",
      "provapi fleet no_target",
    ]);
  });

  it("the canary goes first: one system upgrade, started; no other install yet", async () => {
    const canary = await on("0.92.0", { created: 5 });
    await on("0.92.0", { created: 1 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j, ...rest] = await fleetJobs();
    expect(rest).toEqual([]);
    expect(j).toMatchObject({
      kind: "upgrade",
      workflow: "manage_install",
      install_id: canary,
      actor_kind: SYSTEM_ACTOR.kind,
      actor_key: SYSTEM_ACTOR.key,
      request_id: fleetRequestId(canary, TARGET),
      status: "queued",
    });
    expect(JSON.parse(String(j?.args))).toEqual({ from: "0.92.0", to: TARGET });
    expect(f.manage.created).toEqual([{ id: j?.id, params: { jobId: j?.id } }]);
    // A second tick while it runs adds nothing.
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await fleetJobs()).toHaveLength(1);
    expect(lines).toEqual(["provapi fleet canary_busy"]);
  });

  it("review 1: the canary on the target mid-job (version written, job running) holds the rest", async () => {
    const canary = await on(TARGET);
    await on("0.92.0");
    // ManageInstall wrote installs.version before verify_clean, health and
    // selftest; the job is still running and the row is upgrading.
    await fleetJob(canary, { status: "running", finished_at: null });
    await db
      .prepare("UPDATE installs SET state = 'upgrading' WHERE id = ?1")
      .bind(canary)
      .run();
    const f = fakes({ canary });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    expect((await fleetJobs()).filter((j) => j.install_id !== canary)).toEqual(
      [],
    );
    expect(lines).toEqual(["provapi fleet canary_busy"]);
    expect(f.probed).toEqual([]);
  });

  it("review 1: a canary whose latest upgrade to the target did not end done holds the rest", async () => {
    const canary = await on(TARGET);
    await on("0.92.0");
    await soaked(canary);
    // An admin's upgrade, failed after the version was written.
    await job(canary, {
      kind: "upgrade",
      workflow: "manage_install",
      args: JSON.stringify({ from: "0.92.0", to: TARGET }),
      status: "failed",
      finished_at: NOW - MIN,
    });
    const f = fakes({ canary });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
    expect(lines).toEqual(["provapi fleet canary_not_done"]);
  });

  it("review 2: a start that fails after the insert still counts toward the cap", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    for (let i = 0; i < FLEET_CONCURRENCY + 2; i++)
      await on("0.92.0", { created: 10 + i });
    const broken = {
      create: async () => {
        throw new Error("binding down");
      },
      get: async () => {
        throw new Error("binding down");
      },
    };
    const f = fakes({ canary, manage: broken });
    await fleetDue(f.env, NOW, f.opts);
    const queued = (await fleetJobs()).filter((j) => j.status === "queued");
    expect(queued).toHaveLength(FLEET_CONCURRENCY);
  });

  it("review 12: the cap is the insert's own guard: overlapping ticks never open more", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    for (let i = 0; i < FLEET_CONCURRENCY; i++) {
      const id = await on(TARGET, { created: 2 + i });
      await fleetJob(id, { status: "running", finished_at: null });
    }
    await on("0.92.0", { created: 50 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect((await fleetJobs()).filter((j) => j.status === "queued")).toEqual(
      [],
    );
  });

  it("re-review N4: at the cap, no insert is even tried", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    for (let i = 0; i < FLEET_CONCURRENCY; i++) {
      const id = await on(TARGET, { created: 2 + i });
      await fleetJob(id, { status: "running", finished_at: null });
    }
    for (let i = 0; i < 5; i++) await on("0.92.0", { created: 50 + i });
    const f = fakes({ canary });
    const inserts: string[] = [];
    const counting = new Proxy(db, {
      get(t, p) {
        if (p !== "prepare") return Reflect.get(t, p);
        return (sql: string) => {
          if (sql.startsWith("INSERT INTO jobs")) inserts.push(sql);
          return t.prepare(sql);
        };
      },
    });
    await fleetDue(
      { ...f.env, PLATFORM_DB: counting } as ProvapiEnv,
      NOW,
      f.opts,
    );
    expect(inserts).toEqual([]);
  });

  it("review 12: a stale cap read can't open more: the insert's guard holds the cap", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    for (let i = 0; i < FLEET_CONCURRENCY; i++) {
      const id = await on(TARGET, { created: 2 + i });
      await fleetJob(id, { status: "running", finished_at: null });
    }
    await on("0.92.0", { created: 50 });
    const f = fakes({ canary });
    // An overlapping tick read the count before the 3 opened.
    const stale = new Proxy(db, {
      get(t, p) {
        if (p !== "prepare") return Reflect.get(t, p);
        return (sql: string) =>
          sql.startsWith("SELECT COUNT(*) AS n FROM jobs j")
            ? { first: async () => ({ n: 0 }) }
            : t.prepare(sql);
      },
    });
    await fleetDue({ ...f.env, PLATFORM_DB: stale } as ProvapiEnv, NOW, f.opts);
    expect((await fleetJobs()).filter((j) => j.status === "queued")).toEqual(
      [],
    );
  });

  it("an install that moves between the read and the insert is not upgraded (the insert's own guard)", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    const moved = await on("0.92.0");
    const f = fakes({ canary });
    // After the read of the installs behind, before the insert: an operator
    // suspends it.
    const racing = new Proxy(db, {
      get(t, p) {
        if (p !== "prepare") return Reflect.get(t, p);
        return (sql: string) => {
          const st = t.prepare(sql);
          if (!sql.includes("install_id <> ?2")) return st;
          return {
            bind: (...b: unknown[]) => ({
              all: async () => {
                const r = await st.bind(...b).all();
                await lifecycleSuspend(moved);
                return r;
              },
            }),
          };
        };
      },
    });
    await fleetDue(
      { ...f.env, PLATFORM_DB: racing } as ProvapiEnv,
      NOW,
      f.opts,
    );
    expect(await fleetJobs()).toEqual([]);
  });

  it("leaves out red-line, suspended, paused (review 4), busy, above-target and on-target installs", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    await on("0.92.0", { test_hooks: 1 });
    await on("0.92.0", { suspended: true });
    // prod_dirty: active, but paused over the quarantined script.
    await on("0.92.0", { serving: "paused" });
    await on("0.92.0", { serving: "closed" });
    const busy = await on("0.92.0");
    await job(busy, { kind: "suspend", workflow: "manage_install" });
    await on("0.94.0");
    await on(TARGET);
    // The control: it does move, so the rest are out for their own reasons.
    const fine = await on("0.92.0", { created: 90 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([fine]);
  });

  it("a red-line, suspended, paused or missing canary stops the rollout", async () => {
    for (const canary of [
      await on("0.92.0", { test_hooks: 1 }),
      await on("0.92.0", { suspended: true }),
      await on("0.92.0", { serving: "paused" }),
      installId(),
    ]) {
      await on("0.92.0");
      const lines = captureLogs(vi.spyOn);
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      expect(await fleetJobs()).toEqual([]);
      expect(lines).toEqual(["provapi fleet canary_blocked unavailable"]);
      vi.restoreAllMocks();
    }
  });

  it("a canary above the target is never downgraded and holds the rollout", async () => {
    const canary = await on("0.94.0");
    await on("0.92.0");
    const lines = captureLogs(vi.spyOn);
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
    expect(lines).toEqual(["provapi fleet canary_blocked off_target"]);
  });

  it("review 13: a target not in the catalog (or not installable) queues nothing, so it never halts", async () => {
    const canary = await on("0.92.0");
    for (const releases of [[], [release(TARGET, false)]]) {
      const f = fakes({ canary, releases });
      const lines = captureLogs(vi.spyOn);
      await fleetDue(f.env, NOW, f.opts);
      expect(await fleetJobs()).toEqual([]);
      expect(lines).toEqual([`provapi fleet release_unpublished ${TARGET}`]);
      vi.restoreAllMocks();
    }
  });

  it("a failed fleet upgrade halts the rollout to that target; the next release starts again", async () => {
    const canary = await on("0.92.0");
    await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
    // On the target by hand: still halted.
    await setVersion(canary, TARGET);
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await fleetJobs()).toHaveLength(1);
    expect(lines).toContain(`provapi fleet halted ${TARGET}`);
    expect(
      (await fleetConditions(f.env, NOW + 2 * MIN)).fleet_halted,
    ).toMatchObject({ open: true, rows: [{ install_id: canary }] });
    // 0.93.1: a new rollout, the canary first again.
    const g = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(g.env, NOW + 4 * MIN, g.opts);
    const next = (await fleetJobs()).filter((x) => x.status === "queued");
    expect(next.map((x) => x.install_id)).toEqual([canary]);
    // The old version's halt stays on the alert for FLEET_HALT_ALERT_MS.
    expect(
      (await fleetConditions(g.env, NOW + 4 * MIN)).fleet_halted.open,
    ).toBe(true);
    // Past that, only the new release's own canary clock remains.
    const late = await fleetConditions(
      g.env,
      NOW + 2 * MIN + FLEET_HALT_ALERT_MS,
    );
    expect(late.fleet_halted.rows.map((r) => r.code)).toEqual([
      "canary_blocked",
    ]);
  });

  it("the rest wait while the canary on the target hasn't answered a healthy probe", async () => {
    const canary = await on(TARGET);
    await on("0.92.0");
    const f = fakes({ canary, answers: new Map([[canary, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
  });

  it("#433: one healthy probe and the smoke, and the rest start in the same pass", async () => {
    const canary = await on(TARGET);
    const rest = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(f.smokes).toHaveLength(1);
    expect(await queued()).toEqual([rest]);
  });

  it("canary soaked: the rest, oldest first, one batch of FLEET_CONCURRENCY", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    const behind = [];
    for (let i = 0; i < FLEET_CONCURRENCY + 2; i++)
      behind.push(await on("0.92.0", { created: 10 + i }));
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect((await fleetJobs()).map((j) => j.install_id)).toEqual(
      behind.slice(0, FLEET_CONCURRENCY),
    );
  });
});

describe("soak", () => {
  /** A done fleet upgrade 0.92.0 -> TARGET, the canary soaked there. */
  async function upgraded(doneAt = NOW - MIN) {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const id = await on(TARGET, { created: 5 });
    await fleetJob(id, { finished_at: doneAt });
    return { canary, id };
  }

  it("the canary upgrade soaks FLEET_SOAK_MS of passes, then the rest start", async () => {
    const canary = await on("0.92.0", { created: 0 });
    const rest = await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "done", NOW + MIN);
    await setVersion(canary, TARGET);
    await ticks(f, NOW + 2 * MIN, NOW + 2 * MIN + FLEET_SOAK_MS - 2 * MIN);
    expect(await queued()).toEqual([]);
    await fleetDue(f.env, NOW + 2 * MIN + FLEET_SOAK_MS, f.opts);
    expect(await queued()).toEqual([rest]);
  });

  it("#433: no settle wait: one passing probe settles the canary", async () => {
    const canary = await on(TARGET, { created: 0 });
    await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await stateKeys(FLEET_SOAKED_PREFIX)).toEqual([
      `${FLEET_SOAKED_PREFIX}${TARGET}:${canary}`,
    ]);
    expect(FLEET_SOAK_MS).toBe(0);
  });

  it("a canary on the target with no fleet upgrade soaks all the same", async () => {
    const canary = await on(TARGET, { created: 0 });
    const rest = await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    await ticks(f, NOW, NOW + FLEET_SOAK_MS + 2 * MIN);
    expect(await queued()).toEqual([rest]);
  });

  // With the smoke off, the passive soak's clock: 4 minutes here.
  const SOAK = 4 * MIN;
  const passive = (f: ReturnType<typeof fakes>) =>
    Object.assign(f.env, { FLEET_SMOKE: "off", FLEET_SOAK_MIN: "4" });

  it("smoke off: a failed probe restarts the soak", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary });
    passive(f);
    await fleetDue(f.env, NOW, f.opts);
    f.answers.set(id, "down");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    f.answers.delete(id);
    await ticks(f, NOW + 4 * MIN, NOW + 4 * MIN + SOAK - 2 * MIN);
    expect(await stateKeys(FLEET_SOAKED_PREFIX)).toEqual([
      `${FLEET_SOAKED_PREFIX}${TARGET}:${canary}`,
    ]);
    await fleetDue(f.env, NOW + 4 * MIN + SOAK, f.opts);
    expect(await stateKeys(FLEET_SOAKED_PREFIX)).toContain(
      `${FLEET_SOAKED_PREFIX}${TARGET}:${id}`,
    );
  });

  it("smoke off: a gap in the ticks doesn't count: over FLEET_SOAK_GAP_MS restarts the clock", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary });
    passive(f);
    await fleetDue(f.env, NOW, f.opts);
    const back = NOW + FLEET_SOAK_GAP_MS + MIN;
    await ticks(f, back, back + SOAK - 2 * MIN);
    expect(await stateKeys(FLEET_SOAKED_PREFIX)).not.toContain(
      `${FLEET_SOAKED_PREFIX}${TARGET}:${id}`,
    );
    await fleetDue(f.env, back + SOAK, f.opts);
    expect(await stateKeys(FLEET_SOAKED_PREFIX)).toContain(
      `${FLEET_SOAKED_PREFIX}${TARGET}:${id}`,
    );
  });

  it("a gap of exactly FLEET_SOAK_GAP_MS is unbroken", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary });
    for (const t of [NOW, NOW + FLEET_SOAK_GAP_MS])
      await fleetDue(f.env, t, f.opts);
    expect(await stateKeys(FLEET_SOAKED_PREFIX)).toContain(
      `${FLEET_SOAKED_PREFIX}${TARGET}:${id}`,
    );
  });

  it("a batch must finish and soak whole before the next starts", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const ids = [];
    for (let i = 0; i < FLEET_CONCURRENCY + 1; i++)
      ids.push(await on("0.92.0", { created: 10 + i }));
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const jobs = await fleetJobs();
    // All but one finish and soak; the last is still running.
    for (let i = 0; i < FLEET_CONCURRENCY - 1; i++) {
      await finish(jobs[i]?.id, "done", NOW + MIN);
      await setVersion(ids[i] as string, TARGET);
      await soaked(ids[i] as string);
    }
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await fleetJobs()).toHaveLength(FLEET_CONCURRENCY);
    // The last finishes, and holds until it answers a healthy probe: down
    // once, then up.
    const last = ids[FLEET_CONCURRENCY - 1] as string;
    await finish(jobs[FLEET_CONCURRENCY - 1]?.id, "done", NOW + 3 * MIN);
    await setVersion(last, TARGET);
    f.answers.set(last, "down");
    await fleetDue(f.env, NOW + 4 * MIN, f.opts);
    expect(await fleetJobs()).toHaveLength(FLEET_CONCURRENCY);
    f.answers.delete(last);
    await fleetDue(f.env, NOW + 6 * MIN, f.opts);
    expect(await queued()).toEqual([ids[FLEET_CONCURRENCY]]);
  });

  it("the watch runs with no canary set", async () => {
    const { id } = await upgraded();
    const f = fakes({ answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await stateKeys(`fleet_halt:${TARGET}:`)).toHaveLength(1);
  });

  it("item 7: every install in the batch is probed each tick, however late", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const ids = [];
    for (let i = 0; i < FLEET_CONCURRENCY; i++) {
      const id = await on(TARGET, { created: 5 + i });
      await fleetJob(id, {});
      ids.push(id);
    }
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect([...f.probed].sort()).toEqual([...ids].sort());
  });

  it("a soaked install is left alone: no more probes, and it holds nothing back", async () => {
    const { canary, id } = await upgraded();
    await soaked(id);
    const rest = await on("0.92.0", { created: 9 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(f.probed).not.toContain(id);
    expect(await queued()).toEqual([rest]);
  });

  it("only the target is watched: an unsoaked install on an older version holds nothing", async () => {
    const { canary, id } = await upgraded();
    const g = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(g.env, NOW, g.opts);
    expect(g.probed).not.toContain(id);
    expect(await queued()).toEqual([canary]);
  });
});

describe("halts", () => {
  async function upgraded(doneAt = NOW - MIN) {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const id = await on(TARGET, { created: 5 });
    await fleetJob(id, { finished_at: doneAt });
    return { canary, id };
  }
  const marks = () => stateKeys("fleet_halt:");

  it("two failed probes on separate ticks halt the version, and alert", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    expect(await marks()).toEqual([]);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${id}`]);
    const c = await fleetConditions(f.env, NOW + 2 * MIN);
    expect(c.fleet_halted).toMatchObject({
      open: true,
      rows: [{ install_id: id, code: "fleet_halt" }],
    });
  });

  it("two failures in one tick are one: the same tick re-run doesn't halt", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW, f.opts);
    expect(await marks()).toEqual([]);
  });

  it("one failed probe holds the rollout, and no more", async () => {
    const { canary, id } = await upgraded();
    await on("0.92.0", { created: 9 });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    expect(await marks()).toEqual([]);
    expect(await queued()).toEqual([]);
  });

  it("no automatic rollback: a halt queues no rollback job", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + 4 * MIN);
    expect(await rows("SELECT id FROM jobs WHERE kind = 'rollback'")).toEqual(
      [],
    );
  });

  it("item 2: a pass doesn't reset a failure, so a later failure halts", async () => {
    const { canary, id } = await upgraded();
    const other = await on(TARGET, { created: 6 });
    await fleetJob(other, { finished_at: NOW - MIN });
    const f = fakes({
      canary,
      answers: new Map([
        [id, "down"],
        [other, "0.92.0"],
      ]),
    });
    await fleetDue(f.env, NOW, f.opts);
    // id passes (and settles); other still answers wrong, a tick later.
    f.answers.delete(id);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${other}`]);
  });

  it("#433: a second failure under FLEET_FAIL_GAP_MS after the first doesn't halt; at it, it does", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + FLEET_FAIL_GAP_MS - 1, f.opts);
    expect(await marks()).toEqual([]);
    await fleetDue(f.env, NOW + FLEET_FAIL_GAP_MS, f.opts);
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${id}`]);
  });

  it("item 2: leaving the watch doesn't forget a failure", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    const busy = await job(id, { kind: "suspend", workflow: "manage_install" });
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await marks()).toEqual([]);
    expect(await stateKeys(FLEET_FAIL_PREFIX)).toHaveLength(1);
    await finish(busy, "done", NOW + 3 * MIN);
    await fleetDue(f.env, NOW + 4 * MIN, f.opts);
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${id}`]);
  });

  it("a held migration halts the rollout at the canary, and no fleet job can cross it (MIG-2)", async () => {
    const canary = await on("0.92.0");
    const member = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    // Exactly these: nothing here could ask to cross a held migration.
    expect(Object.keys(JSON.parse(String(j?.args))).sort()).toEqual([
      "from",
      "to",
    ]);
    await finish(j?.id, "failed", NOW + MIN, "migration_held");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await fleetJobs()).toHaveLength(1);
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${canary}`]);
    const c = await fleetConditions(f.env, NOW + 2 * MIN);
    expect(c.fleet_halted.rows[0]).toMatchObject({
      install_id: canary,
      code: "migration_held",
    });
    expect(member).not.toBe(canary);
  });

  describe("a held member (MIG-2)", () => {
    /** A soaked canary, member `held` failed migration_held, then a tick. */
    const heldMember = async () => {
      const canary = await on(TARGET);
      await soaked(canary);
      const held = await on("0.92.0", { created: 5 });
      const next = await on("0.92.0", { created: 6 });
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      const jobs = await fleetJobs();
      const j = jobs.find((x) => x.install_id === held);
      expect(j).toBeDefined();
      await finish(j?.id, "failed", NOW + MIN, "migration_held");
      for (const x of jobs)
        if (x.install_id !== held) await finish(x.id, "done", NOW + MIN);
      return { canary, held, next, f, j };
    };

    it(
      "doesn't halt the version, and the rollout carries on past it",
      async () => {
        const { held, f } = await heldMember();
        // Past this batch: it starts only if the held member doesn't block it.
        const last = [
          await on("0.92.0", { created: 7 }),
          await on("0.92.0", { created: 8 }),
          await on("0.92.0", { created: 9 }),
        ];
        const bump = await fleetJobs();
        for (const x of bump)
          if (x.status === "done")
            await setVersion(String(x.install_id), TARGET);
        for (let t = 2; t < 60; t += 2) {
          await fleetDue(f.env, NOW + t * MIN, f.opts);
          for (const x of await fleetJobs())
            if (x.status === "queued") {
              await finish(x.id, "done", NOW + t * MIN);
              await setVersion(String(x.install_id), TARGET);
            }
        }
        expect(await marks()).toEqual([]);
        const c = await fleetConditions(f.env, NOW + 60 * MIN);
        expect(c.fleet_halted.rows).toEqual([]);
        const reached = (await fleetJobs()).map((x) => x.install_id);
        expect(reached).toEqual(expect.arrayContaining(last));
        expect(reached.filter((x) => x === held)).toHaveLength(1);
        // 29 ticks above, each also re-reading the jobs: 29 x 93 ms x 3.
      },
      fleetTicksTimeout(29),
    );

    it("isn't tried again for this target", async () => {
      const { held, f } = await heldMember();
      await fleetDue(f.env, NOW + 2 * MIN, f.opts);
      await fleetDue(f.env, NOW + 4 * MIN, f.opts);
      expect(
        (await fleetJobs()).filter((x) => x.install_id === held),
      ).toHaveLength(1);
    });

    it(
      "can't be mistaken for upgraded: no soak, and version_skew shows it",
      async () => {
        const { held, f, j } = await heldMember();
        for (let t = 2; t < 40; t += 2)
          await fleetDue(f.env, NOW + t * MIN, f.opts);
        expect(await stateKeys(`fleet_soaked:${TARGET}:${held}`)).toEqual([]);
        expect(await stateKeys(`fleet_pass:${TARGET}:${held}`)).toEqual([]);
        const c = await fleetConditions(f.env, NOW + FLEET_SKEW_MS + MIN);
        expect(c.version_skew.rows).toContainEqual(
          expect.objectContaining({
            install_id: held,
            version: TARGET,
            job_id: j?.id,
          }),
        );
        // 19 ticks above (t = 2 to 38): 19 x 93 ms x 3.
      },
      fleetTicksTimeout(19),
    );

    it("any other failure on a member still halts", async () => {
      const canary = await on(TARGET);
      await soaked(canary);
      const m = await on("0.92.0", { created: 5 });
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      const [j] = await fleetJobs();
      await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
      await fleetDue(f.env, NOW + 2 * MIN, f.opts);
      expect(await marks()).toEqual([`fleet_halt:${TARGET}:${m}`]);
    });
  });

  describe("#1343: an upgrade the DO rule refuses (a release binding a new DO class)", () => {
    const STEP = "0.92.5";
    // The row ManageInstall leaves (do_step_required and its stored text);
    // apps/provisioner's manage test proves that path writes exactly this.
    const refuse = (jobId: unknown, at: number) =>
      db
        .prepare(
          "UPDATE jobs SET status = 'failed', finished_at = ?2, updated_at = ?2, error_code = 'do_step_required', error_message = ?3 WHERE id = ?1",
        )
        .bind(
          jobId,
          at,
          `Upgrade this install to ${STEP} first: the target adds Durable Object classes it can't jump to.`,
        )
        .run();

    it(
      "on the canary: the chain halts, names the install and the step, and upgrades nothing more",
      async () => {
        const canary = await on("0.92.0");
        const rest = [
          await on("0.92.0", { created: 5 }),
          await on("0.92.0", { created: 6 }),
        ];
        const f = fakes({ canary });
        await fleetDue(f.env, NOW, f.opts);
        const [j] = await fleetJobs();
        expect(j?.install_id).toBe(canary);
        await refuse(j?.id, NOW + MIN);
        await ticks(f, NOW + 2 * MIN, NOW + 60 * MIN);
        // No retry of the canary, and nobody else moved.
        expect(await fleetJobs()).toHaveLength(1);
        expect(await marks()).toEqual([`fleet_halt:${TARGET}:${canary}`]);
        const c = await fleetConditions(f.env, NOW + 60 * MIN);
        expect(c.fleet_halted.open).toBe(true);
        expect(c.fleet_halted.rows).toHaveLength(1);
        expect(c.fleet_halted.rows[0]).toMatchObject({
          install_id: canary,
          job_id: j?.id,
          code: "do_step_required",
          version: TARGET,
          message: expect.stringContaining(
            `Upgrade this install to ${STEP} first`,
          ),
        });
        for (const id of rest)
          expect((await fleetJobs()).some((x) => x.install_id === id)).toBe(
            false,
          );
        // 30 ticks above (t = 2 to 60): 30 x 93 ms x 3.
      },
      fleetTicksTimeout(30),
    );

    it(
      "on a batch member: the version halts, what's queued is canceled, and no further install moves",
      async () => {
        const canary = await on(TARGET);
        await soaked(canary);
        const m = await on("0.92.0", { created: 5 });
        const peers = [
          await on("0.92.0", { created: 6 }),
          await on("0.92.0", { created: 7 }),
        ];
        const f = fakes({ canary });
        await fleetDue(f.env, NOW, f.opts);
        const batch = await fleetJobs();
        // #433: everything behind at once.
        expect(batch.map((x) => x.install_id)).toEqual([m, ...peers]);
        const j = batch.find((x) => x.install_id === m);
        await refuse(j?.id, NOW + MIN);
        const later = await on("0.92.0", { created: 8 });
        await ticks(f, NOW + 2 * MIN, NOW + 60 * MIN);
        expect(await marks()).toEqual([`fleet_halt:${TARGET}:${m}`]);
        const after = await fleetJobs();
        expect(after).toHaveLength(3);
        expect(after.some((x) => x.install_id === later)).toBe(false);
        for (const x of after.filter((x) => x.install_id !== m))
          expect(x).toMatchObject({ status: "failed", error_code: "canceled" });
        const c = await fleetConditions(f.env, NOW + 60 * MIN);
        expect(c.fleet_halted.rows).toContainEqual(
          expect.objectContaining({
            install_id: m,
            code: "do_step_required",
            message: expect.stringContaining(
              `Upgrade this install to ${STEP} first`,
            ),
          }),
        );
        // 30 ticks above (t = 2 to 60): 30 x 93 ms x 3.
      },
      fleetTicksTimeout(30),
    );
  });

  it("a failed fleet upgrade halts its version, with a durable mark", async () => {
    const canary = await on("0.92.0");
    await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
    // On the target by hand: still halted.
    await setVersion(canary, TARGET);
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await fleetJobs()).toHaveLength(1);
    expect(lines).toContain(`provapi fleet halted ${TARGET}`);
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${canary}`]);
    // The job's row shows, once: not its mark as well.
    const c = await fleetConditions(f.env, NOW + 2 * MIN);
    expect(c.fleet_halted.rows).toHaveLength(1);
    expect(c.fleet_halted.rows[0]).toMatchObject({
      install_id: canary,
      job_id: j?.id,
      code: "upgrade_rolled_back",
    });
  });

  it("an operator's cancel isn't a failure of the release: no halt", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    const id = await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "canceled");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await marks()).toEqual([]);
    expect(
      (await fleetConditions(f.env, NOW + 2 * MIN)).fleet_halted.open,
    ).toBe(false);
    expect(id).toBeTruthy();
  });

  it("item 1: a halt cancels what's queued for that version; a running job finishes", async () => {
    const { canary, id } = await upgraded();
    const a = await on("0.92.0", { created: 10 });
    const b = await on("0.92.0", { created: 11 });
    const queuedJob = await fleetJob(a, {
      status: "queued",
      finished_at: null,
    });
    const running = await fleetJob(b, {
      status: "running",
      finished_at: null,
    });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    // cloud #264: each canceled job's end is pushed to JobWait.
    const pushed: string[] = [];
    f.env.JOB_WAIT = {
      idFromName: (x: string) => x as unknown as DurableObjectId,
      get: (x: DurableObjectId) => ({
        changed: async () => {
          pushed.push(x as unknown as string);
          return 1;
        },
      }),
    };
    await ticks(f, NOW, NOW + 2 * MIN);
    const byId = new Map((await fleetJobs()).map((j) => [j.id, j]));
    expect(byId.get(queuedJob)).toMatchObject({
      status: "failed",
      error_code: "canceled",
      finished_at: NOW + 2 * MIN,
    });
    expect(byId.get(running)).toMatchObject({ status: "running" });
    expect(pushed).toEqual([queuedJob]);
    // The cancel itself isn't a second halt.
    expect(await marks()).toEqual([`fleet_halt:${TARGET}:${id}`]);
  });

  it("a halt cancels only its own version's queued jobs", async () => {
    const { canary, id } = await upgraded();
    const other = await on("0.92.0", { created: 10 });
    const j = await fleetJob(other, {
      status: "queued",
      finished_at: null,
      to: "0.94.0",
    });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    expect((await fleetJobs()).find((x) => x.id === j)).toMatchObject({
      status: "queued",
    });
  });

  it("the tick that halts queues nothing onto the version", async () => {
    const { canary, id } = await upgraded();
    await on("0.92.0", { created: 9 });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    expect(await queued()).toEqual([]);
  });

  describe("item 1: the insert's own guard, for a stale read", () => {
    const mark = (id: string) =>
      db
        .prepare(
          "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
        )
        .bind(`fleet_halt:${TARGET}:${id}`, NOW)
        .run();
    // Runs between the tick's reads and its insert.
    const between = (
      f: ReturnType<typeof fakes>,
      then: () => Promise<unknown>,
    ) => {
      f.env.PROVISIONER = {
        releases: async () => {
          await then();
          return [release(TARGET)];
        },
      } as unknown as ProvapiEnv["PROVISIONER"];
    };

    it("a halt written after the tick's read stops the insert", async () => {
      const canary = await on("0.92.0");
      const other = await on(TARGET, { created: 5 });
      const f = fakes({ canary });
      between(f, () => mark(other));
      await fleetDue(f.env, NOW, f.opts);
      expect(await fleetJobs()).toEqual([]);
    });

    it("a fleet job failing mid-tick stops the insert, before any mark exists", async () => {
      const canary = await on("0.92.0");
      const other = await on(TARGET, { created: 5 });
      const j = await fleetJob(other, { status: "running", finished_at: null });
      const f = fakes({ canary });
      between(f, () => finish(j, "failed", NOW, "upgrade_rolled_back"));
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([]);
      expect(await fleetJobs()).toHaveLength(1);
    });

    it("a halt landing mid-batch stops the rest of the batch", async () => {
      const canary = await on(TARGET, { created: 0 });
      await soaked(canary);
      const ids = [];
      for (let i = 0; i < FLEET_CONCURRENCY; i++)
        ids.push(await on("0.92.0", { created: 10 + i }));
      const manage = {
        create: async () => {
          await mark(canary).catch(() => {});
          return {};
        },
      };
      const f = fakes({ canary, manage });
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([ids[0]]);
    });

    it("a halt on another version doesn't stop it", async () => {
      const canary = await on("0.92.0");
      const f = fakes({ canary });
      between(f, () =>
        db
          .prepare(
            "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
          )
          .bind(`fleet_halt:0.93.0-x:${canary}`, NOW)
          .run(),
      );
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([canary]);
    });
  });

  it("a halt never blocks the next release, even while the install still fails", async () => {
    const { canary, id } = await upgraded();
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    expect(await marks()).toHaveLength(1);
    const g = fakes({
      canary,
      tag: "v0.93.1",
      answers: new Map([[id, "down"]]),
    });
    await fleetDue(g.env, NOW + 4 * MIN, g.opts);
    expect(await queued()).toEqual([canary]);
  });

  it("a halted version is never watched again: no more probes, no hold", async () => {
    const { canary, id } = await upgraded();
    const rest = await on("0.92.0", { created: 9 });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    f.probed.length = 0;
    await fleetDue(f.env, NOW + 4 * MIN, f.opts);
    expect(f.probed).toEqual([]);
    expect(await queued()).not.toContain(rest);
  });

  describe("item 3: pruning", () => {
    const seed = (key: string, at: number) =>
      db
        .prepare(
          "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
        )
        .bind(key, at)
        .run();
    const OLD = NOW - FLEET_KEEP_MS - MIN;

    it("with no target, nothing is pruned, so a rollout can't resume onto a halted version", async () => {
      const canary = await on("0.92.0");
      await seed(`fleet_halt:${TARGET}:${canary}`, OLD);
      const none = fakes({ canary, tag: "broken" });
      await fleetDue(none.env, NOW, none.opts);
      expect(await marks()).toHaveLength(1);
      const f = fakes({ canary });
      await fleetDue(f.env, NOW + 2 * MIN, f.opts);
      expect(await fleetJobs()).toEqual([]);
    });

    it("the target's own marks are never pruned", async () => {
      const canary = await on("0.92.0");
      await seed(`fleet_halt:${TARGET}:${canary}`, OLD);
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      expect(await marks()).toHaveLength(1);
    });

    it("a version above the target keeps its marks: a redeploy back can't resume it", async () => {
      const canary = await on("0.92.0");
      await seed(`fleet_halt:0.94.0:${canary}`, OLD);
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      expect(await marks()).toHaveLength(1);
    });

    it("marks of older versions go after FLEET_KEEP_MS, not before", async () => {
      const id = installId();
      for (const p of ["halt", "fail", "pass", "soaked"])
        await seed(`fleet_${p}:0.91.0:${id}`, OLD);
      await seed("fleet_blocked:0.91.0", OLD);
      await seed(`fleet_halt:0.92.0:${id}`, NOW - FLEET_KEEP_MS + MIN);
      const f = fakes({});
      await fleetDue(f.env, NOW, f.opts);
      expect(await stateKeys("fleet_")).toEqual([`fleet_halt:0.92.0:${id}`]);
    });

    it("an unparsable key is left alone", async () => {
      await seed("fleet_halt:nonsense", OLD);
      const f = fakes({});
      await fleetDue(f.env, NOW, f.opts);
      expect(await marks()).toEqual(["fleet_halt:nonsense"]);
    });
  });
});

describe("item 5: health-gated eligibility", () => {
  it("a broken install is skipped: it doesn't move, halt, or hold the rest", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    const broken = await on("0.92.0", { created: 5, health: "failing" });
    const fine = await on("0.92.0", { created: 6 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([fine]);
    expect(await stateKeys("fleet_halt:")).toEqual([]);
    // version_skew reports it.
    expect(await stateKeys(FLEET_BEHIND_PREFIX)).toContain(
      `${FLEET_BEHIND_PREFIX}${broken}`,
    );
  });

  it("the insert re-reads health: one going bad after the read isn't upgraded", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    f.env.PROVISIONER = {
      releases: async () => {
        await db
          .prepare(
            "UPDATE install_lifecycle SET health = 'failing' WHERE install_id = ?1",
          )
          .bind(canary)
          .run();
        return [release(TARGET)];
      },
    } as unknown as ProvapiEnv["PROVISIONER"];
    await fleetDue(f.env, NOW, f.opts);
    expect(await fleetJobs()).toEqual([]);
  });
});

describe("item 6: a canary that can't take the release", () => {
  const blocked = `${FLEET_BLOCKED_PREFIX}${TARGET}`;
  const code = async (f: ReturnType<typeof fakes>, at: number) =>
    (await fleetConditions(f.env, at)).fleet_halted.rows.map((r) => r.code);

  it("paused (prod_dirty): the alert opens after FLEET_BLOCKED_MS, not with the 6 h skew", async () => {
    const canary = await on("0.92.0", { serving: "paused" });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await stateKeys(blocked)).toEqual([blocked]);
    expect(await code(f, NOW + FLEET_BLOCKED_MS - MIN)).toEqual([]);
    expect(await code(f, NOW + FLEET_BLOCKED_MS)).toEqual(["canary_blocked"]);
  });

  it("the first sighting stays: a later tick doesn't restart the clock", async () => {
    const canary = await on("0.92.0", { serving: "paused" });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + 20 * MIN, f.opts);
    expect(await code(f, NOW + FLEET_BLOCKED_MS)).toEqual(["canary_blocked"]);
  });

  it("every cause counts: unhealthy, suspended, red-line, above the target, missing", async () => {
    const cases = [
      await on("0.92.0", { health: "failing" }),
      await on("0.92.0", { suspended: true }),
      await on("0.92.0", { test_hooks: 1 }),
      await on("0.94.0"),
      installId(),
    ];
    for (const canary of cases) {
      await db
        .prepare("DELETE FROM platform_state WHERE key GLOB 'fleet_*'")
        .run();
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      expect(await stateKeys(blocked), canary).toEqual([blocked]);
    }
  });

  it("no alert with no canary set", async () => {
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(blocked, NOW)
      .run();
    const f = fakes({});
    expect(await code(f, NOW + FLEET_BLOCKED_MS)).toEqual([]);
  });
});

describe("#1110 review: the batch gate", () => {
  /** The canary soaked on TARGET, one member done and unsoaked, one to go. */
  async function batch() {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const member = await on(TARGET, { created: 5 });
    await fleetJob(member, {});
    const rest = await on("0.92.0", { created: 9 });
    return { canary, member, rest, f: fakes({ canary }) };
  }

  it("a batch member suspended, paused, busy or rolled back still holds the next batch", async () => {
    const acts: ((id: string) => Promise<unknown>)[] = [
      lifecycleSuspend,
      (id) =>
        db
          .prepare(
            "UPDATE install_lifecycle SET serving_mode = 'paused' WHERE install_id = ?1",
          )
          .bind(id)
          .run(),
      (id) => job(id, { kind: "suspend", workflow: "manage_install" }),
      (id) => setVersion(id, "0.92.0"),
    ];
    for (const act of acts) {
      await reset();
      const { member, f } = await batch();
      await act(member);
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([]);
    }
  });

  it("a paused member isn't probed: it can't answer, and that's no failure", async () => {
    const { member, f } = await batch();
    await db
      .prepare(
        "UPDATE install_lifecycle SET serving_mode = 'paused' WHERE install_id = ?1",
      )
      .bind(member)
      .run();
    await fleetDue(f.env, NOW, f.opts);
    expect(f.probed).not.toContain(member);
  });

  it("only soaking takes a member out", async () => {
    const { member, rest, f } = await batch();
    await soaked(member);
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([rest]);
  });

  it("or the install going away", async () => {
    const { member, rest, f } = await batch();
    await db
      .prepare(
        "UPDATE install_lifecycle SET deleted_at = ?2, purge_at = ?2 WHERE install_id = ?1",
      )
      .bind(member, NOW)
      .run();
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([rest]);
  });

  it("the insert holds the gate: a job finishing after the tick's read can't let a batch start", async () => {
    const canary = await on("0.92.0");
    const other = await on(TARGET, { created: 5 });
    const j = await fleetJob(other, { status: "running", finished_at: null });
    const f = fakes({ canary });
    f.env.PROVISIONER = {
      releases: async () => {
        await finish(j, "done", NOW);
        return [release(TARGET)];
      },
    } as unknown as ProvapiEnv["PROVISIONER"];
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([]);
  });

  it("a member's gate is per version: V's unsoaked batch doesn't stop V+1", async () => {
    const { canary, member } = await batch();
    const g = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(g.env, NOW, g.opts);
    expect(await queued()).toEqual([canary]);
    expect(member).toBeTruthy();
  });

  it("R25 on a job after it landed: the install is probed all the same, and holds until healthy", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const member = await on(TARGET, { created: 5 });
    await fleetJob(member, {
      status: "failed",
      error_code: "canceled",
    });
    const rest = await on("0.92.0", { created: 9 });
    const f = fakes({ canary, answers: new Map([[member, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    expect(f.probed).toContain(member);
    expect(await queued()).toEqual([]);
    f.answers.delete(member);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await queued()).toEqual([rest]);
  });

  it("the gate counts a landed, canceled job on its own, with the member out of the watch", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const member = await on(TARGET, { created: 5 });
    await fleetJob(member, { status: "failed", error_code: "canceled" });
    await lifecycleSuspend(member);
    await on("0.92.0", { created: 9 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([]);
  });

  it("R25 before the job landed holds nothing", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const member = await on("0.92.0", { created: 5 });
    await fleetJob(member, { status: "failed", error_code: "canceled" });
    const rest = await on("0.92.0", { created: 9 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([rest]);
    expect(await stateKeys("fleet_halt:")).toEqual([]);
  });
});

describe("#1110 review: a halt never blocks V+1", () => {
  const NEXT = "v0.93.1";
  const halted = (id: string) =>
    db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`fleet_halt:${TARGET}:${id}`, NOW - MIN)
      .run();

  for (const [what, over] of [
    ["unhealthy", { health: "failing" }],
    ["paused", { serving: "paused" }],
  ] as const) {
    it(`a canary the release broke, now ${what}, takes the next release`, async () => {
      const canary = await on(TARGET, over);
      await halted(canary);
      const f = fakes({ canary, tag: NEXT });
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([canary]);
    });

    it(`a canary ${what} for another reason doesn't`, async () => {
      const canary = await on("0.92.0", over);
      const f = fakes({ canary, tag: NEXT });
      const lines = captureLogs(vi.spyOn);
      await fleetDue(f.env, NOW, f.opts);
      expect(await fleetJobs()).toEqual([]);
      expect(lines).toContain(
        `provapi fleet canary_blocked ${"health" in over ? "unhealthy" : "unavailable"}`,
      );
    });

    it(`any install the release broke, now ${what}, takes it in its batch`, async () => {
      const canary = await on("0.93.1", { created: 0 });
      await soaked(canary, "0.93.1");
      const victim = await on(TARGET, { ...over, created: 5 });
      await halted(victim);
      const other = await on("0.92.0", { ...over, created: 6 });
      const f = fakes({ canary, tag: NEXT });
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([victim]);
      expect(other).toBeTruthy();
    });
  }
});

describe("#1110 review: canary_blocked is a catch-all", () => {
  const key = `${FLEET_BLOCKED_PREFIX}${TARGET}`;
  const codes = async (f: ReturnType<typeof fakes>, at: number) =>
    (await fleetConditions(f.env, at)).fleet_halted.rows.map((r) => r.code);
  const opens = async (f: ReturnType<typeof fakes>, t0 = NOW) => {
    expect(await codes(f, t0 + FLEET_BLOCKED_MS - MIN)).toEqual([]);
    expect(await codes(f, t0 + FLEET_BLOCKED_MS)).toEqual(["canary_blocked"]);
  };

  it("R25 cancels the canary's job, spending its request id", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "canceled");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    await opens(f);
  });

  it("an operator rolls the canary back", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "done", NOW + MIN);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    await opens(f);
  });

  it("R25 lands after the canary's upgrade did", async () => {
    const canary = await on(TARGET);
    await fleetJob(canary, { status: "failed", error_code: "canceled" });
    const f = fakes({ canary, answers: new Map([[canary, "down"]]) });
    // One tick: its probe failed, so it hasn't settled and the clock runs.
    await fleetDue(f.env, NOW, f.opts);
    await opens(f);
  });

  it("the target isn't published", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary, releases: [] });
    await fleetDue(f.env, NOW, f.opts);
    await opens(f);
  });

  it("clears once the canary has soaked", async () => {
    const canary = await on(TARGET);
    const f = fakes({ canary });
    await ticks(f, NOW, NOW + FLEET_SOAK_MS + 2 * MIN);
    expect(await stateKeys(key)).toEqual([]);
    expect(await codes(f, NOW + FLEET_BLOCKED_MS)).toEqual([]);
  });

  it("no false all-clear: the next release doesn't restart the clock", async () => {
    const canary = await on("0.92.0", { serving: "paused" });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const g = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(g.env, NOW + 20 * MIN, g.opts);
    expect(await codes(g, NOW + FLEET_BLOCKED_MS)).toEqual(["canary_blocked"]);
  });

  it("a halted target ends the clock: fleet_halted says so itself", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await stateKeys(key)).toEqual([]);
  });

  it("a non-semver canary version blocks, and never throws", async () => {
    const canary = await on("not-a-version");
    const f = fakes({ canary });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    expect(lines).toContain("provapi fleet canary_blocked bad_version");
    await opens(f);
  });

  it("a test-hook canary on the target is never probed, and halts nothing", async () => {
    const canary = await on(TARGET, { test_hooks: 1 });
    const f = fakes({ canary });
    await ticks(f, NOW, NOW + 2 * MIN);
    expect(f.probed).not.toContain(canary);
    expect(await stateKeys("fleet_halt:")).toEqual([]);
    await opens(f);
  });
});

describe("#1110 review: halts count per version, and say so", () => {
  async function two() {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const a = await on(TARGET, { created: 5 });
    await fleetJob(a, {});
    const b = await on(TARGET, { created: 6 });
    await fleetJob(b, {});
    return { canary, a, b };
  }

  it("one failed probe on each of two installs, on separate ticks, halts the version", async () => {
    const { canary, a, b } = await two();
    // b is held back the first tick (it answers its old version: a failure
    // too, but one failure per tick), then b fails again a tick later.
    const f = fakes({
      canary,
      answers: new Map([
        [a, "down"],
        [b, "down"],
      ]),
    });
    await fleetDue(f.env, NOW, f.opts);
    f.answers.delete(a);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await stateKeys("fleet_halt:")).toEqual([
      `fleet_halt:${TARGET}:${b}`,
    ]);
  });

  it("two installs failing in one tick are one failure", async () => {
    const { canary, a, b } = await two();
    const f = fakes({
      canary,
      answers: new Map([
        [a, "down"],
        [b, "down"],
      ]),
    });
    await fleetDue(f.env, NOW, f.opts);
    expect(await stateKeys("fleet_halt:")).toEqual([]);
  });

  it("the alert names the version, the install and the job", async () => {
    const { canary, a } = await two();
    const [j] = await rows(
      "SELECT id FROM jobs WHERE install_id = ?1 AND kind = 'upgrade'",
      a,
    );
    const f = fakes({ canary, answers: new Map([[a, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    const c = await fleetConditions(f.env, NOW + 2 * MIN);
    expect(c.fleet_halted.rows).toContainEqual(
      expect.objectContaining({
        install_id: a,
        job_id: j?.id,
        job_kind: "upgrade",
        version: TARGET,
      }),
    );
  });

  it("a canary on the target by hand has no job to name, and says so with null", async () => {
    const canary = await on(TARGET);
    const f = fakes({ canary, answers: new Map([[canary, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    const c = await fleetConditions(f.env, NOW + 2 * MIN);
    expect(c.fleet_halted.rows).toContainEqual(
      expect.objectContaining({
        install_id: canary,
        job_id: null,
        version: TARGET,
      }),
    );
  });

  it("a new halt owes an email, even with the alert already open", async () => {
    const { canary, a } = await two();
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES ('fleet_halted_notified_at', ?1, ?1)",
      )
      .bind(NOW - MIN)
      .run();
    const f = fakes({ canary, answers: new Map([[a, "down"]]) });
    await ticks(f, NOW, NOW + 2 * MIN);
    const [n] = await rows(
      "SELECT value FROM platform_state WHERE key = 'fleet_halted_notified_at'",
    );
    expect(n?.value).toBe(0);
  });

  it("a halt writes one audit row, as the scheduler", async () => {
    const { canary, a } = await two();
    const f = fakes({ canary, answers: new Map([[a, "down"]]) });
    await ticks(f, NOW, NOW + 4 * MIN);
    const r = await rows(
      "SELECT actor, install_id, detail FROM hosted_audit WHERE action = 'fleet.halted' AND install_id = ?1",
      a,
    );
    expect(r).toEqual([
      {
        actor: SYSTEM_ACTOR.key,
        install_id: a,
        detail: JSON.stringify({ version: TARGET }),
      },
    ]);
  });

  it("a failed batch loses nothing: the next failing tick halts", async () => {
    const { canary, a } = await two();
    const f = fakes({ canary, answers: new Map([[a, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    const flaky = new Proxy(db, {
      get(t, p) {
        if (p === "batch")
          return async () => {
            throw new Error("D1 down");
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    await fleetDue(
      { ...f.env, PLATFORM_DB: flaky } as ProvapiEnv,
      NOW + 2 * MIN,
      f.opts,
    ).catch(() => {});
    expect(await stateKeys("fleet_halt:")).toEqual([]);
    await fleetDue(f.env, NOW + 4 * MIN, f.opts);
    expect(await stateKeys("fleet_halt:")).toEqual([
      `fleet_halt:${TARGET}:${a}`,
    ]);
  });
});

describe("#1110 last round", () => {
  const seedHalt = (v: string, id: string) =>
    db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`fleet_halt:${v}:${id}`, NOW - MIN)
      .run();

  describe("F1: an exempted install gets one try", () => {
    it("a broken install takes one release, and isn't exempt for the next", async () => {
      const canary = await on("0.93.1", { created: 0 });
      await soaked(canary, "0.93.1");
      const broken = await on(TARGET, { created: 5, health: "failing" });
      await seedHalt(TARGET, broken);
      const f = fakes({ canary, tag: "v0.93.1" });
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([broken]);
      expect(await stateKeys(FLEET_RETRY_PREFIX)).toEqual([
        `${FLEET_RETRY_PREFIX}${broken}`,
      ]);
      // It fails. The release halts, once.
      const [j] = await fleetJobs();
      await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
      await fleetDue(f.env, NOW + 2 * MIN, f.opts);
      expect(await stateKeys("fleet_halt:0.93.1:")).toHaveLength(1);
      // The next release doesn't touch it, so it can't halt that one too.
      const next = await on("0.93.2", { created: 0 });
      await soaked(next, "0.93.2");
      const g = fakes({ canary: next, tag: "v0.93.2" });
      await fleetDue(g.env, NOW + 4 * MIN, g.opts);
      expect(await queued()).toEqual([canary]);
      expect(await stateKeys("fleet_halt:0.93.2:")).toEqual([]);
    });

    it("soaking gives the try back", async () => {
      const canary = await on(TARGET, { created: 0 });
      await soaked(canary);
      const id = await on(TARGET, { created: 5 });
      await fleetJob(id, {});
      await db
        .prepare(
          "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
        )
        .bind(`${FLEET_RETRY_PREFIX}${id}`, NOW)
        .run();
      const f = fakes({ canary });
      await ticks(f, NOW, NOW + FLEET_SOAK_MS + 2 * MIN);
      expect(await stateKeys(FLEET_RETRY_PREFIX)).toEqual([]);
    });

    it("a healthy install on a halted version spends no try", async () => {
      const canary = await on("0.93.1", { created: 0 });
      await soaked(canary, "0.93.1");
      const fine = await on(TARGET, { created: 5 });
      await seedHalt(TARGET, canary);
      const f = fakes({ canary, tag: "v0.93.1" });
      await fleetDue(f.env, NOW, f.opts);
      expect(await queued()).toEqual([fine]);
      expect(await stateKeys(FLEET_RETRY_PREFIX)).toEqual([]);
    });
  });

  it("F3: every install on the halted version is exempt, not only the one that tripped it", async () => {
    const canary = await on("0.93.1", { created: 0 });
    await soaked(canary, "0.93.1");
    const tripped = await on(TARGET, { created: 5, health: "failing" });
    const other = await on(TARGET, { created: 6, health: "failing" });
    const unrelated = await on("0.92.0", { created: 7, health: "failing" });
    await seedHalt(TARGET, tripped);
    const f = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([tripped, other]);
    expect(unrelated).toBeTruthy();
  });

  it("F1: a broken canary gets one try too", async () => {
    const canary = await on(TARGET, { health: "failing" });
    await seedHalt(TARGET, canary);
    const f = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([canary]);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
    const g = fakes({ canary, tag: "v0.93.2" });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(g.env, NOW + 2 * MIN, g.opts);
    expect(await fleetJobs()).toHaveLength(1);
    expect(lines).toContain("provapi fleet canary_blocked unhealthy");
  });

  it("F3: an install reverted to an older version, having halted one, gets its try too", async () => {
    const canary = await on("0.93.1", { created: 0 });
    await soaked(canary, "0.93.1");
    const reverted = await on("0.92.0", { created: 5, health: "failing" });
    await seedHalt(TARGET, reverted);
    const f = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([reverted]);
  });

  describe("F2: no silent stall after the canary soaks", () => {
    it("a canceled job on a canary that landed still releases the rest", async () => {
      const canary = await on(TARGET, { created: 0 });
      await fleetJob(canary, { status: "failed", error_code: "canceled" });
      const rest = await on("0.92.0", { created: 5 });
      const f = fakes({ canary });
      await ticks(f, NOW, NOW + FLEET_SOAK_MS + 2 * MIN);
      expect(await queued()).toEqual([rest]);
      expect(await stateKeys(FLEET_BLOCKED_PREFIX)).toEqual([]);
    });

    it("the stamp clears only when the canary is ready, and comes back if it stops", async () => {
      const canary = await on(TARGET, { created: 0 });
      await soaked(canary);
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      expect(await stateKeys(FLEET_BLOCKED_PREFIX)).toEqual([]);
      // Soaked, but it can no longer lead: paused by a person.
      await db
        .prepare(
          "UPDATE install_lifecycle SET serving_mode = 'paused' WHERE install_id = ?1",
        )
        .bind(canary)
        .run();
      await fleetDue(f.env, NOW + 2 * MIN, f.opts);
      const c = await fleetConditions(f.env, NOW + 2 * MIN + FLEET_BLOCKED_MS);
      expect(c.fleet_halted.rows.map((r) => r.code)).toEqual([
        "canary_blocked",
      ]);
    });
  });

  describe("F4: a held rollout", () => {
    async function held() {
      const canary = await on(TARGET, { created: 0 });
      await soaked(canary);
      const member = await on(TARGET, { created: 5 });
      await fleetJob(member, {});
      await lifecycleSuspend(member);
      await on("0.92.0", { created: 9 });
      return { canary, member, f: fakes({ canary }) };
    }

    it("logs who holds it", async () => {
      const { member, f } = await held();
      const lines = captureLogs(vi.spyOn);
      await fleetDue(f.env, NOW, f.opts);
      expect(lines).toContain(`provapi fleet held by ${member}`);
    });

    it("sends no fleet_halted all-clear while held", async () => {
      const { f } = await held();
      const c = await fleetConditions(f.env, NOW);
      expect(c.fleet_halted).toEqual({ open: null, rows: [] });
    });

    it("clears as usual when nothing holds it", async () => {
      const canary = await on(TARGET, { created: 0 });
      await soaked(canary);
      const f = fakes({ canary });
      const c = await fleetConditions(f.env, NOW);
      expect(c.fleet_halted).toEqual({ open: false, rows: [] });
    });

    it("a real row still opens the alert while held", async () => {
      const { member, f } = await held();
      await seedHalt("0.92.9", member);
      const c = await fleetConditions(f.env, NOW);
      expect(c.fleet_halted.open).toBe(true);
    });
  });

  describe("F5: the rows name version and job", () => {
    it("canary_blocked", async () => {
      const canary = await on("0.92.0");
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      const [j] = await fleetJobs();
      await finish(j?.id, "failed", NOW + MIN, "canceled");
      await fleetDue(f.env, NOW + 2 * MIN, f.opts);
      const c = await fleetConditions(f.env, NOW + FLEET_BLOCKED_MS);
      expect(c.fleet_halted.rows[0]).toMatchObject({
        code: "canary_blocked",
        version: TARGET,
        job_id: j?.id,
      });
    });

    it("version_skew", async () => {
      const canary = await on(TARGET);
      await soaked(canary);
      const behind = await on("0.92.0", { created: 5 });
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      const [j] = await fleetJobs();
      const c = await fleetConditions(f.env, NOW + FLEET_SKEW_MS);
      expect(c.version_skew.rows[0]).toMatchObject({
        install_id: behind,
        version: TARGET,
        job_id: j?.id,
      });
    });

    it("version_skew with no job says null", async () => {
      const canary = await on(TARGET);
      await soaked(canary);
      const behind = await on("0.92.0", { created: 5, health: "failing" });
      const f = fakes({ canary });
      await fleetDue(f.env, NOW, f.opts);
      const c = await fleetConditions(f.env, NOW + FLEET_SKEW_MS);
      expect(c.version_skew.rows[0]).toMatchObject({
        install_id: behind,
        version: TARGET,
        job_id: null,
      });
    });
  });

  it("F8: a repeat of a halt writes no second audit row and owes no second email", async () => {
    const canary = await on("0.92.0");
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [j] = await fleetJobs();
    await finish(j?.id, "failed", NOW + MIN, "upgrade_rolled_back");
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    // The tick's state was read before an overlapping tick wrote the mark.
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES ('fleet_halted_notified_at', ?1, ?1)",
      )
      .bind(NOW)
      .run();
    const stale = new Proxy(db, {
      get(t, p) {
        if (p !== "prepare") {
          const v = Reflect.get(t, p);
          return typeof v === "function" ? v.bind(t) : v;
        }
        return (sql: string) =>
          sql.startsWith("SELECT key, value, updated_at FROM platform_state")
            ? t.prepare(
                "SELECT key, value, updated_at FROM platform_state WHERE 0",
              )
            : t.prepare(sql);
      },
    });
    await fleetDue(
      { ...f.env, PLATFORM_DB: stale } as ProvapiEnv,
      NOW + 4 * MIN,
      f.opts,
    );
    expect(
      await rows(
        "SELECT id FROM hosted_audit WHERE action = 'fleet.halted' AND install_id = ?1",
        canary,
      ),
    ).toHaveLength(1);
    const [n] = await rows(
      "SELECT value FROM platform_state WHERE key = 'fleet_halted_notified_at'",
    );
    expect(n?.value).toBe(NOW);
  });
});

describe("onTarget", () => {
  const id = "i00000000abc";
  const good = { ok: true, version: TARGET, installId: id };
  const go = (r: () => Response | Promise<Response>, ms = 1_000) =>
    onTarget(async () => r(), id, "x.test", TARGET, ms);

  it("passes only on 200, ok, its own id and the version, no test hooks", async () => {
    expect(await go(() => Response.json(good))).toBe(true);
  });

  it("fails on anything else", async () => {
    const bad: Record<string, unknown>[] = [
      { ...good, ok: false },
      { ...good, ok: "true" },
      { ...good, installId: "i00000000xyz" },
      { ...good, version: "0.92.0" },
      { ...good, testHooks: false },
    ];
    for (const b of bad)
      expect(await go(() => Response.json(b)), JSON.stringify(b)).toBe(false);
    expect(await go(() => Response.json(good, { status: 503 }))).toBe(false);
    expect(await go(() => new Response("not json"))).toBe(false);
    expect(await go(() => new Response("null"))).toBe(false);
  });

  it("a throw or a hang fails, never throws", async () => {
    expect(
      await go(() => {
        throw new Error("x");
      }),
    ).toBe(false);
    expect(await go(() => new Promise<Response>(() => {}), 5)).toBe(false);
  });
});

describe("the alerts", () => {
  const H = 60 * MIN;
  const env = (o: { tag?: string; canary?: string } = {}) =>
    ({
      PLATFORM_DB: db,
      FLEET_CANARY: o.canary ?? "ifhx5rpmrhwh",
      CF_VERSION_METADATA: {
        id: "x",
        tag: o.tag ?? `v${TARGET}`,
        timestamp: new Date(NOW).toISOString(),
      },
    }) as unknown as ProvapiEnv;

  it("version_skew: an install first seen off FLEET_SKEW_MS ago; red-line, suspended and paused are out", async () => {
    const canary = await on(TARGET);
    await soaked(canary);
    const behind = await on("0.92.0");
    await on("0.92.0", { test_hooks: 1 });
    await on("0.92.0", { suspended: true });
    await on("0.92.0", { serving: "paused" });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(
      (await fleetConditions(f.env, NOW + FLEET_SKEW_MS - MIN)).version_skew
        .open,
    ).toBe(false);
    const late = await fleetConditions(f.env, NOW + FLEET_SKEW_MS);
    expect(late.version_skew.rows.map((r) => r.install_id)).toEqual([behind]);
    await setVersion(behind, TARGET);
    await fleetDue(f.env, NOW + FLEET_SKEW_MS, f.opts);
    expect(
      (await fleetConditions(f.env, NOW + FLEET_SKEW_MS)).version_skew.open,
    ).toBe(false);
  });

  it("frequent releases don't restart a stuck install's clock", async () => {
    const canary = await on("0.92.0", { suspended: false, health: "failing" });
    const stuck = await on("0.92.0", { health: "failing" });
    const a = fakes({ canary });
    await fleetDue(a.env, NOW, a.opts);
    const b = fakes({ canary, tag: "v0.93.1" });
    await fleetDue(b.env, NOW + 3 * H, b.opts);
    const c = await fleetConditions(b.env, NOW + FLEET_SKEW_MS);
    expect(c.version_skew.rows.map((r) => r.install_id)).toContain(stuck);
  });

  it("version_skew is unknown with no canary or no target, never an all-clear", async () => {
    for (const e of [env({ canary: "" }), env({ tag: "x" })])
      expect((await fleetConditions(e, NOW)).version_skew).toEqual({
        open: null,
        rows: [],
      });
  });

  it("no canary and nothing halted: fleet_halted clear", async () => {
    expect(
      (await fleetConditions(env({ canary: "" }), NOW)).fleet_halted,
    ).toEqual({ open: false, rows: [] });
  });

  it("a canary set but no target opens fleet_halted (no_target)", async () => {
    const c = await fleetConditions(env({ tag: "x" }), NOW);
    expect(c.fleet_halted).toMatchObject({
      open: true,
      rows: [{ code: "no_target" }],
    });
  });

  it("a halt on an earlier version stays on fleet_halted for FLEET_HALT_ALERT_MS", async () => {
    const id = installId();
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`fleet_halt:0.92.0:${id}`, NOW)
      .run();
    expect(
      (await fleetConditions(env(), NOW + FLEET_HALT_ALERT_MS)).fleet_halted
        .open,
    ).toBe(true);
    expect(
      (await fleetConditions(env(), NOW + FLEET_HALT_ALERT_MS + 1)).fleet_halted
        .open,
    ).toBe(false);
  });

  it("a halt on the target stays until the next release", async () => {
    const id = installId();
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`fleet_halt:${TARGET}:${id}`, NOW)
      .run();
    expect(
      (await fleetConditions(env(), NOW + 100 * H)).fleet_halted.open,
    ).toBe(true);
  });
});

describe("#433: no timers, leo with the rest", () => {
  it("canary healthy and smoked in one pass, then every install behind at once, oldest first", async () => {
    const canary = await on(TARGET, { created: 0 });
    await fleetJob(canary, { finished_at: NOW - MIN });
    const old = [];
    for (let i = 0; i < 5; i++)
      old.push(await on("0.92.0", { created: 1 + i }));
    const leo = await on("0.92.0", { created: 50 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(f.smokes).toHaveLength(1);
    expect(f.smokes[0]).toMatchObject({ installId: canary, version: TARGET });
    expect(await queued()).toEqual([...old, leo]);
    // The smoke ran once for the version: a passed smoke is never rerun.
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(f.smokes).toHaveLength(1);
  });

  it("FLEET_CONCURRENCY only bounds open upgrades: the next group goes once these are healthy", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const ids = [];
    for (let i = 0; i < FLEET_CONCURRENCY + 1; i++)
      ids.push(await on("0.92.0", { created: 1 + i }));
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual(ids.slice(0, FLEET_CONCURRENCY));
  });

  it("a canary just upgraded whose probe fails asks again; the pass on the retry moves the rest, no halt", async () => {
    const canary = await on(TARGET, { created: 0 });
    await fleetJob(canary, { finished_at: NOW - MIN });
    const rest = await on("0.92.0", { created: 5 });
    const f = fakes({ canary, answers: new Map([[canary, "down"]]) });
    // Only time can tell: the message comes back (wake.ts).
    expect(await fleetPass(f.env, NOW, f.opts)).toEqual({
      pass: "canary",
      reason: "awaiting_probe",
      again: true,
    });
    expect(await queued()).toEqual([]);
    f.answers.delete(canary);
    // The first retry, wakeBackoffS(1) later: healthy, smoked, the rest go,
    // and what is left ends with their jobs (no again).
    expect(
      await fleetPass(f.env, NOW + wakeBackoffS(1) * 1_000, f.opts),
    ).toEqual({ pass: "batch", reason: "fleet_jobs_queued", again: false });
    expect(await queued()).toEqual([rest]);
    expect(await stateKeys(`fleet_halt:${TARGET}:`)).toEqual([]);
  });

  it("a canary down on every retry halts on the backoff's first probe past FLEET_FAIL_GAP_MS", async () => {
    const canary = await on(TARGET, { created: 0 });
    await fleetJob(canary, { finished_at: NOW - MIN });
    await on("0.92.0", { created: 5 });
    const f = fakes({ canary, answers: new Map([[canary, "down"]]) });
    let at = NOW;
    const probes: number[] = [];
    for (let attempts = 1; ; attempts++) {
      expect(attempts).toBeLessThanOrEqual(FLEET_WAKE_MAX_RETRIES + 1);
      const r = await fleetPass(f.env, at, f.opts);
      probes.push(at - NOW);
      if (!r.again) break;
      at += wakeBackoffS(attempts) * 1_000;
    }
    // 0, 1, 3, 7, 15, 31 s fail and count once; 63 s is past the gap.
    expect(probes).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 63_000]);
    expect(FLEET_FAIL_GAP_MS).toBe(60_000);
    expect(await stateKeys(`fleet_halt:${TARGET}:`)).toEqual([
      `fleet_halt:${TARGET}:${canary}`,
    ]);
    expect(await queued()).toEqual([]);
  });

  it("fleetTick: a slow probe, then the smoke with only the time left, ends inside the duty's 25 s", async () => {
    const canary = await on(TARGET, { created: 0 });
    await fleetJob(canary, { finished_at: NOW - MIN });
    const rest = await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    let t = 0;
    const budgets: (number | undefined)[] = [];
    const probe = f.opts.probe;
    await fleetTick(f.env, NOW, {
      ...f.opts,
      clock: () => t,
      // Every probe takes its whole timeout.
      probe: async (...a) => {
        t += FLEET_PROBE_TIMEOUT_MS;
        return probe(...a);
      },
      // The smoke spends its whole budget, then its whole cleanup.
      smoke: async (i) => {
        budgets.push(i.budgetMs);
        t += (i.budgetMs ?? 0) + FLEET_SMOKE_CLEANUP_MS;
        return { ok: true, notes: [] };
      },
    });
    expect(budgets).toEqual([
      FLEET_TICK_DEADLINE_MS - FLEET_PROBE_TIMEOUT_MS - FLEET_SMOKE_CLEANUP_MS,
    ]);
    expect(t).toBeLessThanOrEqual(FLEET_TICK_DEADLINE_MS);
    expect(t).toBeLessThan(25_000);
    expect(await queued()).toEqual([rest]);
  });

  it("fleetTick: too little time left for the smoke defers it and asks again, never a failure", async () => {
    const canary = await on(TARGET, { created: 0 });
    await fleetJob(canary, { finished_at: NOW - MIN });
    await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    let t = 0;
    const probe = f.opts.probe;
    const r = await fleetTick(f.env, NOW, {
      ...f.opts,
      clock: () => t,
      // A probe that eats almost the whole deadline.
      probe: async (...a) => {
        t += FLEET_TICK_DEADLINE_MS - FLEET_SMOKE_CLEANUP_MS - 1_000;
        return probe(...a);
      },
    });
    expect(r).toEqual({
      pass: "canary",
      reason: "smoke_deferred",
      again: true,
    });
    expect(f.smokes).toEqual([]);
    expect(await stateKeys("fleet_smoke_")).toEqual([]);
    expect(await queued()).toEqual([]);
  });

  it(
    "fleetTick: one run at a time; the lease is given back, and a stale one is taken (ported from cloud #458)",
    async () => {
      const canary = await on("0.92.0", { created: 0 });
      const f = fakes({ canary });
      /** A run whose probe can be held, holding the lease meanwhile. */
      const run = (at: number, hold?: Promise<void>, held?: () => void) =>
        fleetTick(f.env, at, {
          ...f.opts,
          clock: () => 0,
          probe: async (...a) => {
            held?.();
            await hold;
            return f.opts.probe(...a);
          },
        });
      // The last pass queued the canary's upgrade; it has ended, and this
      // run's probe of it waits, holding the lease.
      await fleetDue(f.env, NOW - 2 * MIN, f.opts);
      const [up] = await fleetJobs();
      await setVersion(canary, TARGET);
      await finish(up?.id, "done", NOW - MIN);
      let release = () => {};
      const hold = new Promise<void>((r) => {
        release = r;
      });
      let held = () => {};
      const waiting = new Promise<void>((r) => {
        held = r;
      });
      const lines = captureLogs(vi.spyOn);
      const first = run(NOW, hold, held);
      await waiting;
      // A second run meanwhile (the tick beside a wake, a message delivered
      // twice) does nothing and says so.
      expect(await run(NOW)).toBeNull();
      expect(await run(NOW + 2 * MIN)).toBeNull();
      expect(lines.filter((l) => l === "provapi fleet overlap")).toHaveLength(
        2,
      );
      release();
      expect(await first).not.toBeNull();
      expect(await getState(db, FLEET_LEASE_KEY)).toBeNull();
      expect((await fleetJobs()).map((j) => j.install_id)).toEqual([canary]);
      // A lease never given back (a killed run) blocks only until
      // FLEET_LEASE_MS has passed.
      await db
        .prepare(
          "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
        )
        .bind(FLEET_LEASE_KEY, NOW)
        .run();
      lines.length = 0;
      expect(await run(NOW + 2 * MIN)).toBeNull();
      expect(lines).toEqual(["provapi fleet overlap"]);
      lines.length = 0;
      expect(await run(NOW + FLEET_LEASE_MS)).not.toBeNull();
      expect(lines).not.toContain("provapi fleet overlap");
      expect(await getState(db, FLEET_LEASE_KEY)).toBeNull();
      // The lease outlives the longest run (the wake's); a killed run's
      // lease costs the backup tick at most three ticks.
      expect(FLEET_LEASE_MS).toBeGreaterThan(FLEET_WAKE_TIMEOUT_MS);
      expect(FLEET_LEASE_MS).toBeLessThan(6 * MIN);
    },
    fleetTicksTimeout(30),
  );

  it(
    "the v0.251.0 timeline on events: the rest go in the pass the canary's job end starts, fleet_done in the pass the last job end starts, nothing waits",
    async () => {
      // Measured on prod for v0.251.0 (cloud #264, deploy run 45820756312
      // and the admin job records): the wake posted 12:37:17; the canary's
      // job was created 12:37:20 and ended 12:38:40; the other 10 were
      // created 12:42:59 and ended by 12:44:09 (70 s); fleet_done was
      // written 12:44:59.732. The rest and fleet_done were both written by
      // the 2-minute tick's fleet duty, about 59 s into its 12:42 and 12:44
      // runs. Here each step starts on the previous one's message.
      const WAKE_AT = Date.UTC(2026, 10, 26, 12, 37, 17);
      const MEASURED_DONE = Date.UTC(2026, 10, 26, 12, 44, 59, 732);
      const CANARY_END = Date.UTC(2026, 10, 26, 12, 38, 40);
      const REST_JOB_MS = 70_000;
      const canary = await on("0.92.0", { created: 0 });
      const rest: string[] = [];
      for (let i = 0; i < 10; i++)
        rest.push(await on("0.92.0", { created: 1 + i }));
      const f = fakes({ canary });
      const retried: unknown[] = [];
      /** One delivery of oa-<p>-fleet-wake at `at`: one pass. */
      const deliver = async (at: number) => {
        const b = wakeBatch([1], at);
        expect(
          await fleetWake(b.batch, f.env, at, {
            fleet: { ...f.opts, clock: () => at },
          }),
        ).toBe("ok");
        expect(b.acked).toEqual([0]);
        retried.push(...b.retried);
      };
      // The deploy's wake: the canary's upgrade is queued at once.
      await deliver(WAKE_AT);
      const [c] = await fleetJobs();
      expect(c?.install_id).toBe(canary);
      expect(c?.created_at).toBe(WAKE_AT);
      // ManageInstall ends it; its fleet_wake step is the next message.
      await setVersion(canary, TARGET);
      await finish(c?.id, "done", CANARY_END);
      await deliver(CANARY_END);
      // That one pass probed it, ran the smoke and queued every other
      // install: no gap after the canary's job (measured: 4 min 19 s).
      expect(f.smokes).toHaveLength(1);
      const restJobs = (await fleetJobs()).filter(
        (j) => j.install_id !== canary,
      );
      expect(restJobs.map((j) => j.install_id).sort()).toEqual(
        [...rest].sort(),
      );
      expect(new Set(restJobs.map((j) => j.created_at))).toEqual(
        new Set([CANARY_END]),
      );
      // Each of the rest's ends is a message; only the last finds it done.
      let lastEnd = 0;
      for (const [i, j] of restJobs.entries()) {
        lastEnd = CANARY_END + REST_JOB_MS + i * 100;
        await setVersion(j.install_id as string, TARGET);
        await finish(j.id, "done", lastEnd);
        await deliver(lastEnd);
        if (i < restJobs.length - 1)
          expect(await stateKeys(FLEET_DONE_PREFIX)).toEqual([]);
      }
      // fleet_done at the last job's end (measured: 50.7 s after it).
      expect(await getState(db, `${FLEET_DONE_PREFIX}${TARGET}`)).toBe(lastEnd);
      // Nothing asked to come back, so nothing waited.
      expect(retried).toEqual([]);
      // Wake to done: 2 min 33.9 s on the measured job times (83 s to the
      // canary's end, 70 s for the rest, 0.9 s between their ends here),
      // against the measured 7 min 42.7 s.
      expect(lastEnd - WAKE_AT).toBe(153_900);
      expect(MEASURED_DONE - WAKE_AT).toBe(462_732);
      expect(await getState(db, FLEET_LEASE_KEY)).toBeNull();
      // A wake pass fits the queue's bound, under the lease.
      expect(FLEET_WAKE_DEADLINE_MS).toBeLessThan(FLEET_WAKE_TIMEOUT_MS);
      expect(FLEET_WAKE_TIMEOUT_MS).toBeLessThan(FLEET_LEASE_MS);
    },
    fleetTicksTimeout(15),
  );

  it("fleet_done: set once when nothing eligible is behind and everything settled; never while one is behind, open or halted", async () => {
    const canary = await on("0.92.0", { created: 0 });
    const rest = await on("0.92.0", { created: 5 });
    // A broken install is left out, so it never holds the mark.
    await on("0.92.0", { created: 6, health: "failing" });
    const f = fakes({ canary });
    const lines = captureLogs(vi.spyOn);
    const pass = (at: number) => fleetDue(f.env, at, f.opts);
    // The canary's upgrade is open: canary.
    expect(await pass(NOW)).toBe("canary");
    const [c] = await fleetJobs();
    await setVersion(canary, TARGET);
    await finish(c?.id, "done", NOW + MIN);
    // Settled, smoked, the rest queued: the batch is open.
    expect(await pass(NOW + MIN)).toBe("batch");
    expect(await stateKeys(FLEET_DONE_PREFIX)).toEqual([]);
    const r = (await fleetJobs()).find((j) => j.install_id === rest);
    // Open: still the batch.
    expect(await pass(NOW + MIN + 15_000)).toBe("batch");
    await setVersion(rest, TARGET);
    await finish(r?.id, "done", NOW + 2 * MIN);
    // Done, settled on the next pass: the mark, once.
    expect(await pass(NOW + 2 * MIN)).toBe("idle");
    expect(await stateKeys(FLEET_DONE_PREFIX)).toEqual([
      `${FLEET_DONE_PREFIX}${TARGET}`,
    ]);
    const first = await getState(db, `${FLEET_DONE_PREFIX}${TARGET}`);
    expect(await pass(NOW + 4 * MIN)).toBe("idle");
    expect(await getState(db, `${FLEET_DONE_PREFIX}${TARGET}`)).toBe(first);
    expect(
      lines.filter((l) => l === `provapi fleet done ${TARGET}`),
    ).toHaveLength(1);
  });

  it("fleet_done: a healthy install busy with another job on the old version is not upgraded; done waits for its upgrade (the Prover's workerd case)", async () => {
    const canary = await on("0.92.0", { created: 0 });
    const busy = await on("0.92.0", { created: 5 });
    // An ordinary settings update is running on it.
    const settings = await job(busy, {
      kind: "update",
      workflow: "manage_install",
      status: "running",
      args: "{}",
    });
    const f = fakes({ canary });
    const pass = (at: number) => fleetDue(f.env, at, f.opts);
    expect(await pass(NOW)).toBe("canary");
    const [c] = await fleetJobs();
    await setVersion(canary, TARGET);
    await finish(c?.id, "done", NOW + MIN);
    // The canary settles and smokes; the busy install can't start and the
    // rollout is not done: a wake run keeps re-checking.
    expect(await pass(NOW + MIN)).toBe("batch");
    expect(await stateKeys(FLEET_DONE_PREFIX)).toEqual([]);
    expect(await pass(NOW + MIN + 15_000)).toBe("batch");
    expect(await stateKeys(FLEET_DONE_PREFIX)).toEqual([]);
    // The settings job ends: its upgrade is queued, still not done.
    await finish(settings, "done", NOW + 2 * MIN);
    expect(await pass(NOW + 2 * MIN)).toBe("batch");
    const up = (await fleetJobs()).find((j) => j.install_id === busy);
    expect(up?.status).toBe("queued");
    expect(await stateKeys(FLEET_DONE_PREFIX)).toEqual([]);
    // Upgraded and idle on the target: done.
    await setVersion(busy, TARGET);
    await finish(up?.id, "done", NOW + 3 * MIN);
    expect(await pass(NOW + 3 * MIN)).toBe("idle");
    expect(await stateKeys(FLEET_DONE_PREFIX)).toEqual([
      `${FLEET_DONE_PREFIX}${TARGET}`,
    ]);
  });

  it("fleet_done: an install on the target but busy is not done until it is idle", async () => {
    const canary = await on("0.92.0", { created: 0 });
    const there = await on(TARGET, { created: 5 });
    const running = await job(there, {
      kind: "update",
      workflow: "manage_install",
      status: "running",
      args: "{}",
    });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [c] = await fleetJobs();
    await setVersion(canary, TARGET);
    await finish(c?.id, "done", NOW + MIN);
    expect(await fleetDue(f.env, NOW + MIN, f.opts)).toBe("batch");
    expect(await stateKeys(FLEET_DONE_PREFIX)).toEqual([]);
    await finish(running, "done", NOW + 2 * MIN);
    expect(await fleetDue(f.env, NOW + 2 * MIN, f.opts)).toBe("idle");
    expect(await stateKeys(FLEET_DONE_PREFIX)).toEqual([
      `${FLEET_DONE_PREFIX}${TARGET}`,
    ]);
  });

  it("fleet_done: a halted version is never done", async () => {
    const canary = await on("0.92.0", { created: 0 });
    await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    const [c] = await fleetJobs();
    await finish(c?.id, "failed", NOW + MIN, "upgrade_failed");
    await fleetDue(f.env, NOW + MIN, f.opts);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await stateKeys(FLEET_DONE_PREFIX)).toEqual([]);
  });

  it("fleetWake keeps every safety check: an unverified target moves nothing, and the message is acked", async () => {
    await db
      .prepare("DELETE FROM platform_state WHERE key = ?1")
      .bind(`${FLEET_VERIFIED_PREFIX}${TARGET}`)
      .run();
    const canary = await on("0.92.0", { created: 0 });
    await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    const { batch, acked } = wakeBatch([1]);
    const lines = captureLogs(vi.spyOn);
    expect(
      await fleetWake(batch, f.env, NOW, {
        fleet: { ...f.opts, clock: () => 0 },
      }),
    ).toBe("ok");
    expect(lines).toContain("provapi fleet holding: platform not verified");
    expect(await fleetJobs()).toEqual([]);
    expect(acked).toEqual([0]);
  });

  it("fleetWake: with the lease held, the message with the fewest deliveries comes back after the backoff, the rest are acked; one out of retries is acked", async () => {
    const canary = await on("0.92.0", { created: 0 });
    const f = fakes({ canary });
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(FLEET_LEASE_KEY, NOW - MIN)
      .run();
    const lines = captureLogs(vi.spyOn);
    const two = wakeBatch([3, 1]);
    expect(await fleetWake(two.batch, f.env, NOW, { fleet: f.opts })).toBe(
      "held",
    );
    expect(two.retried).toEqual([{ i: 1, delaySeconds: wakeBackoffS(1) }]);
    expect(two.acked).toEqual([0]);
    expect(lines).toEqual([
      "provapi fleet overlap",
      "provapi fleet wake held messages=2 retried=1 again=1",
    ]);
    // Past max_retries the queue would drop it: acked, the tick carries on.
    const last = wakeBatch([FLEET_WAKE_MAX_RETRIES + 1]);
    expect(await fleetWake(last.batch, f.env, NOW, { fleet: f.opts })).toBe(
      "held",
    );
    expect(last.retried).toEqual([]);
    expect(last.acked).toEqual([0]);
    const audit = await rows(
      "SELECT detail FROM hosted_audit WHERE action = 'fleet.wake' AND install_id = ? ORDER BY id",
      canary,
    );
    const held = { to: TARGET, canary, decision: "held", reason: "lease_held" };
    expect(audit.map((row) => JSON.parse(String(row.detail)))).toEqual([
      { ...held, retried: true },
      { ...held, retried: false },
    ]);
    // No more deliveries. The alerts tick must start the canary clock itself.
    await fleetMarks(f.env, NOW);
    const before = await fleetConditions(f.env, NOW + FLEET_BLOCKED_MS - 1);
    expect(before.fleet_halted.rows.map((row) => row.code)).not.toContain(
      "canary_blocked",
    );
    await fleetMarks(f.env, NOW + FLEET_BLOCKED_MS);
    const due = await fleetConditions(f.env, NOW + FLEET_BLOCKED_MS);
    expect(due.fleet_halted.rows).toContainEqual(
      expect.objectContaining({ code: "canary_blocked", since: NOW }),
    );
    // Nothing moved, and the other run's lease is still its own.
    expect(await fleetJobs()).toEqual([]);
    expect(await getState(db, FLEET_LEASE_KEY)).toBe(NOW - MIN);
  });

  it("fleetWake: a duplicate after a finished run is one more harmless pass, acked", async () => {
    const canary = await on("0.92.0", { created: 0 });
    const f = fakes({ canary });
    // The canary's upgrade stays open: its end is the next event.
    const opts = { fleet: { ...f.opts, clock: () => 0 } };
    const a = wakeBatch([1]);
    await fleetWake(a.batch, f.env, NOW, opts);
    const jobs = await fleetJobs();
    expect(jobs.map((j) => j.install_id)).toEqual([canary]);
    const b = wakeBatch([1]);
    expect(await fleetWake(b.batch, f.env, NOW + 1_000, opts)).toBe("ok");
    // The insert's guards: no second upgrade for the same version.
    expect(await fleetJobs()).toEqual(jobs);
    expect(b.acked).toEqual([0]);
  });

  it("fleetWake: a run that hangs times out with a fixed line and comes back after the backoff, never thrown", async () => {
    const f = fakes({});
    const hang = {
      ...f.env,
      PLATFORM_DB: {
        prepare: (sql: string) =>
          sql.includes("INSERT INTO hosted_audit")
            ? db.prepare(sql)
            : {
                bind: () => ({ first: () => new Promise<never>(() => {}) }),
              },
      },
    } as unknown as ProvapiEnv;
    const { batch, acked, retried } = wakeBatch([1]);
    const lines = captureLogs(vi.spyOn);
    expect(await fleetWake(batch, hang, NOW, { timeoutMs: 20 })).toBe(
      "timeout",
    );
    expect(acked).toEqual([]);
    expect(retried).toEqual([{ i: 0, delaySeconds: wakeBackoffS(1) }]);
    expect(lines).toEqual([
      "provapi fleet failed timeout",
      "provapi fleet wake timeout messages=1 retried=1 again=1",
    ]);
  });

  it("the backoff: 1 s doubling to FLEET_WAKE_BACKOFF_MAX_S, and the retries outlast the probe's fail gap", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(wakeBackoffS)).toEqual([
      1, 2, 4, 8, 16, 32, 60, 60, 60,
    ]);
    expect(FLEET_WAKE_BACKOFF_MAX_S).toBe(60);
    let total = 0;
    for (let a = 1; a <= FLEET_WAKE_MAX_RETRIES; a++) total += wakeBackoffS(a);
    // About 15 min: past the 60 s fail gap, inside canary_blocked's 45 min.
    expect(total).toBeGreaterThan(FLEET_FAIL_GAP_MS / 1_000);
    expect(total * 1_000).toBeLessThan(FLEET_BLOCKED_MS);
  });

  // cloud #264: the 2-minute tick runs no fleet. It keeps only the fleet's
  // alert marks, so version_skew and platform_unverified alert as before.
  it("*/2, smoke required: the tick moves no install and takes no lease, even with the fleet behind; its alerts duty keeps fleet_behind", async () => {
    const canary = await on("0.92.0", { created: 0 });
    const rest = await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    const lines = captureLogs(vi.spyOn);
    const out = await provapiTick(f.env, NOW, {
      timeoutMs: { sweep: 1_000, health: 1_000 },
      healthProbe: f.opts.probe,
    });
    expect(out).not.toHaveProperty("fleet");
    expect(await fleetJobs()).toEqual([]);
    expect(await getState(db, FLEET_LEASE_KEY)).toBeNull();
    expect(
      lines.filter((l) =>
        /^provapi fleet (upgrade|overlap|holding|soaked)/.test(l),
      ),
    ).toEqual([]);
    expect(await stateKeys(FLEET_BEHIND_PREFIX)).toEqual(
      [canary, rest].sort().map((id) => `${FLEET_BEHIND_PREFIX}${id}`),
    );
  });

  it("fleetMarks: stamps fleet_unverified while the target has no mark, then fleet_behind; clears a caught-up one; moves nothing", async () => {
    await db
      .prepare("DELETE FROM platform_state WHERE key = ?1")
      .bind(`${FLEET_VERIFIED_PREFIX}${TARGET}`)
      .run();
    const canary = await on("0.92.0", { created: 0 });
    const rest = await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    await fleetMarks(f.env, NOW);
    expect(await getState(db, `${FLEET_UNVERIFIED_PREFIX}${TARGET}`)).toBe(NOW);
    expect(await stateKeys(FLEET_BEHIND_PREFIX)).toEqual([]);
    // After 45 minutes, platform_unverified opens off the tick's own stamp.
    const late = await fleetConditions(f.env, NOW + FLEET_BLOCKED_MS);
    expect(late.fleet_halted.rows.map((r) => r.code)).toContain(
      "platform_unverified",
    );
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`${FLEET_VERIFIED_PREFIX}${TARGET}`, NOW + MIN)
      .run();
    await fleetMarks(f.env, NOW + 2 * MIN);
    expect(await stateKeys(FLEET_UNVERIFIED_PREFIX)).toEqual([]);
    expect(await stateKeys(FLEET_BEHIND_PREFIX)).toEqual(
      [canary, rest].sort().map((id) => `${FLEET_BEHIND_PREFIX}${id}`),
    );
    // An install that catches up between releases (by hand, say) is cleared
    // on the next tick, so version_skew doesn't stay open for it.
    await setVersion(rest, TARGET);
    await fleetMarks(f.env, NOW + 4 * MIN);
    expect(await stateKeys(FLEET_BEHIND_PREFIX)).toEqual([
      `${FLEET_BEHIND_PREFIX}${canary}`,
    ]);
    // ... and one left behind past FLEET_SKEW_MS opens version_skew.
    const skew = await fleetConditions(f.env, NOW + 2 * MIN + FLEET_SKEW_MS);
    expect(skew.version_skew.open).toBe(true);
    expect(await fleetJobs()).toEqual([]);
    expect(await getState(db, FLEET_LEASE_KEY)).toBeNull();
  });

  it("fleetMarks: no canary or no target writes nothing", async () => {
    await on("0.92.0");
    await fleetMarks(fakes({}).env, NOW);
    const canary = await on("0.92.0");
    await fleetMarks(fakes({ canary, tag: "nope" }).env, NOW);
    expect(await stateKeys("fleet_")).toEqual([]);
  });

  // An explicitly configured passive soak needs passes at most FLEET_SOAK_GAP_MS apart.
  it(
    "*/2, smoke off: the tick runs the fleet duty and soaks with main's 5-min gap rule",
    async () => {
      const canary = await on(TARGET, { created: 0 });
      await fleetJob(canary, { finished_at: NOW - MIN });
      const rest = await on("0.92.0", { created: 5 });
      const f = fakes({ canary });
      Object.assign(f.env, { FLEET_SMOKE: "off", FLEET_SOAK_MIN: "15" });
      const tick = (at: number) =>
        provapiTick(f.env, at, {
          timeoutMs: { sweep: 1_000, health: 1_000 },
          healthProbe: f.opts.probe,
          fleet: f.opts,
        });
      expect((await tick(NOW)).fleet).toBe("ok");
      // Ticks 2 min apart for 14 min: still soaking, nothing queued.
      for (let t = NOW + 2 * MIN; t < NOW + 15 * MIN; t += 2 * MIN)
        await tick(t);
      expect(await queued()).toEqual([]);
      // The tick at 16 min soaks it and queues the rest.
      await tick(NOW + 16 * MIN);
      expect(await stateKeys(`${FLEET_SOAKED_PREFIX}${TARGET}:`)).toEqual([
        `${FLEET_SOAKED_PREFIX}${TARGET}:${canary}`,
      ]);
      expect(await queued()).toEqual([rest]);
      expect(await getState(db, FLEET_LEASE_KEY)).toBeNull();
    },
    fleetTicksTimeout(20),
  );

  it("smoke off: a tick gap over FLEET_SOAK_GAP_MS restarts the soak, as on main", async () => {
    const canary = await on(TARGET, { created: 0 });
    await fleetJob(canary, { finished_at: NOW - MIN });
    await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    Object.assign(f.env, { FLEET_SMOKE: "off", FLEET_SOAK_MIN: "15" });
    const tick = (at: number) =>
      provapiTick(f.env, at, {
        timeoutMs: { sweep: 1_000, health: 1_000 },
        healthProbe: f.opts.probe,
        fleet: f.opts,
      });
    await tick(NOW);
    // One delivery 15 min later is a gap over 5 min: no soak, the clock restarts.
    await tick(NOW + 15 * MIN);
    expect(await stateKeys(`${FLEET_SOAKED_PREFIX}${TARGET}:`)).toEqual([]);
    expect(FLEET_SOAK_GAP_MS).toBe(5 * MIN);
  });

  // A lost job-end message (the provisioner's send ran out of retries): no
  // tick re-checks, but every pass reads the fleet from state, so the next
  // event of any kind (here another install's job ending) moves it on.
  it("a lost canary job-end message: the next event of any kind, read from state, moves the rollout on", async () => {
    const canary = await on("0.92.0", { created: 0 });
    const rest = await on("0.92.0", { created: 5 });
    const other = await on("0.92.0", { created: 6, health: "failing" });
    const f = fakes({ canary });
    const deliver = async (at: number, body: unknown) => {
      const b = wakeBatch([1], at);
      for (const m of b.batch.messages)
        (m as unknown as { body: unknown }).body = body;
      await fleetWake(b.batch, f.env, at, {
        fleet: { ...f.opts, clock: () => at },
      });
      return b;
    };
    await deliver(NOW, { env: "staging", tag: `v${TARGET}` });
    const [c] = await fleetJobs();
    await setVersion(canary, TARGET);
    await finish(c?.id, "done", NOW + MIN);
    // The canary's own job-end message never arrives. Later, an unrelated
    // job on another install ends, and its message names only that job.
    const settings = await job(other, {
      kind: "update",
      workflow: "manage_install",
      status: "done",
      args: "{}",
    });
    const b = await deliver(NOW + 30 * MIN, { jobId: settings });
    expect(b.acked).toEqual([0]);
    expect(f.smokes).toHaveLength(1);
    expect((await fleetJobs()).map((j) => j.install_id)).toContain(rest);
  });

  it(
    "with no canary, a required smoke is inert: no smoke, nothing queued, no alert",
    async () => {
      await on("0.92.0", { created: 0 });
      await on("0.92.0", { created: 1 });
      const f = fakes({ canary: "" });
      // The smoke required, a 60-minute soak, no smoke token.
      Object.assign(f.env, { FLEET_SMOKE: "required", FLEET_SOAK_MIN: "60" });
      const lines = captureLogs(vi.spyOn);
      await ticks(f, NOW, NOW + 120 * MIN);
      expect(await fleetJobs()).toEqual([]);
      expect(f.smokes).toEqual([]);
      expect(new Set(lines)).toEqual(new Set(["provapi fleet no_canary"]));
      // Past canary_blocked's window: no smoke_unconfigured, no canary_blocked.
      const c = await fleetConditions(f.env, NOW + 120 * MIN);
      expect(c.fleet_halted).toEqual({ open: false, rows: [] });
      expect(c.version_skew.open).toBeNull();
      // 61 ticks above (t = 0 to 120): 61 x 93 ms x 3.
    },
    fleetTicksTimeout(61),
  );
});

describe("#1343: the canary smoke gates the rollout", () => {
  /** A settled canary on the target, and one install behind. */
  async function settled() {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const rest = await on("0.92.0", { created: 5 });
    return { canary, rest };
  }
  const halted = () => stateKeys(`fleet_halt:${TARGET}:`);
  const codes = async (f: ReturnType<typeof fakes>, at: number) =>
    (await fleetConditions(f.env, at)).fleet_halted.rows;

  it("a queued smoke and its completion advance the fleet on separate deliveries", async () => {
    const { canary, rest } = await settled();
    const f = fakes({ canary });
    const sent: unknown[] = [];
    f.env.FLEET_WAKE = {
      send: async (body) => {
        sent.push(body);
        return {
          metadata: { metrics: { backlogCount: sent.length, backlogBytes: 0 } },
        };
      },
    };
    const deliver = async (body: unknown) => {
      const b = wakeBatch([1]);
      for (const message of b.batch.messages) Object.assign(message, { body });
      await fleetWake(b.batch, f.env, NOW, { fleet: f.opts });
      expect(b.acked).toEqual([0]);
    };
    await deliver({ jobId: "canary-upgrade" });
    expect(sent).toEqual([{ kind: "canary_smoke", target: TARGET, canary }]);
    expect(f.smokes).toHaveLength(0);
    await deliver({ kind: "canary_smoke", target: "0.1.0", canary });
    await deliver({ kind: "canary_smoke", target: TARGET, canary: rest });
    expect(f.smokes).toHaveLength(0);
    await deliver(sent[0]);
    expect(f.smokes).toHaveLength(1);
    expect(f.smokes[0]?.budgetMs).toBeUndefined();
    expect(await queued()).toEqual([]);
    expect(sent[1]).toEqual({ kind: "smoke_finished", target: TARGET, canary });
    await deliver(sent[0]);
    expect(f.smokes).toHaveLength(1);
    await deliver(sent[1]);
    expect(await queued()).toEqual([rest]);
  });

  it("a queued transport failure retries with the check in the audit; a config failure holds", async () => {
    const { canary } = await settled();
    const f = fakes({
      canary,
      smoke: [
        { ok: false, kind: "transport", check: "read" },
        { ok: false, kind: "config", check: "token" },
      ],
    });
    const send = vi.fn();
    f.env.FLEET_WAKE = { send };
    for (const attempts of [1, 2]) {
      const b = wakeBatch([attempts]);
      for (const message of b.batch.messages)
        Object.assign(message, {
          body: { kind: "canary_smoke", target: TARGET, canary },
        });
      await fleetWake(b.batch, f.env, NOW + attempts, { fleet: f.opts });
      expect(b.retried).toHaveLength(attempts === 1 ? 1 : 0);
    }
    const audits = await rows(
      "SELECT detail FROM hosted_audit WHERE action = 'fleet.wake' AND install_id = ? ORDER BY id",
      canary,
    );
    expect(audits.map((row) => JSON.parse(String(row.detail)))).toMatchObject([
      { reason: "smoke_transport", check: "read", retried: true },
      { reason: "smoke_config", check: "token", retried: false },
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(await queued()).toEqual([]);
  });

  it("passes: marks the version smoked, and the rest move the same tick", async () => {
    const { canary, rest } = await settled();
    const f = fakes({
      canary,
      smoke: [{ ok: true, notes: ["bus: skipped, FLEET_SMOKE_BUS off"] }],
    });
    const lines = captureLogs(vi.spyOn);
    await fleetDue(f.env, NOW, f.opts);
    expect(await queued()).toEqual([rest]);
    expect(await stateKeys(FLEET_SMOKED_PREFIX)).toEqual([
      `${FLEET_SMOKED_PREFIX}${TARGET}:${canary}`,
    ]);
    // The note is logged by name; no token, body or address.
    expect(lines).toContain(
      `provapi fleet smoke passed ${canary} ${TARGET} bus: skipped, FLEET_SMOKE_BUS off`,
    );
  });

  it("the smoke gets the canary, the env's token, the share target and the broker", async () => {
    const { canary } = await settled();
    const f = fakes({ canary });
    Object.assign(f.env, {
      FLEET_SMOKE_TOKEN: "pat-x",
      FLEET_SMOKE_SHARE_TO: "b@x.test",
      AUTH_BROKER_ORIGIN: "https://auth.example.test",
    });
    await fleetDue(f.env, NOW, f.opts);
    const host = (
      await rows("SELECT app_host FROM installs WHERE id = ?1", canary)
    )[0]?.app_host;
    expect(f.smokes[0]).toMatchObject({
      installId: canary,
      appHost: host,
      token: "pat-x",
      shareTo: "b@x.test",
      brokerOrigin: "https://auth.example.test",
      version: TARGET,
    });
  });

  it(
    "an assertion failure halts the version at once, names the check, and moves nothing",
    async () => {
      const { canary, rest } = await settled();
      const f = fakes({
        canary,
        smoke: [{ ok: false, kind: "assert", check: "share" }],
      });
      await fleetDue(f.env, NOW, f.opts);
      expect(await halted()).toEqual([`fleet_halt:${TARGET}:${canary}`]);
      expect((await fleetJobs()).map((j) => j.install_id)).not.toContain(rest);
      const r = await codes(f, NOW);
      expect(r).toMatchObject([
        { code: "smoke_failed", install_id: canary, message: "share" },
      ]);
      // The halt's audit row, as the scheduler.
      expect(
        await rows(
          "SELECT actor, install_id, action FROM hosted_audit WHERE action = 'fleet.halted' AND install_id = ?1",
          canary,
        ),
      ).toEqual([
        { actor: SYSTEM_ACTOR.key, install_id: canary, action: "fleet.halted" },
      ]);
      // Forward only: never rerun on this version, never a rollback.
      await ticks(f, NOW + 2 * MIN, NOW + 20 * MIN);
      expect(f.smokes).toHaveLength(1);
      expect((await fleetJobs()).filter((j) => j.kind === "rollback")).toEqual(
        [],
      );
      // 10 ticks above (t = 2 to 20): 10 x 93 ms x 3.
    },
    fleetTicksTimeout(10),
  );

  it("a transport failure counts once; a second on a later tick halts", async () => {
    const { canary, rest } = await settled();
    const t = { ok: false, kind: "transport", check: "mcp" } as const;
    const f = fakes({ canary, smoke: [t, t] });
    await fleetDue(f.env, NOW, f.opts);
    expect(await halted()).toEqual([]);
    expect(await stateKeys("fleet_smoke_fail:")).toEqual([
      `fleet_smoke_fail:${TARGET}:mcp`,
    ]);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await halted()).toEqual([`fleet_halt:${TARGET}:${canary}`]);
    expect((await codes(f, NOW + 2 * MIN))[0]).toMatchObject({
      code: "smoke_failed",
      message: "mcp",
    });
    expect((await fleetJobs()).map((j) => j.install_id)).not.toContain(rest);
  });

  it("a transport failure, then a pass: no halt, the rest move", async () => {
    const { canary, rest } = await settled();
    const f = fakes({
      canary,
      smoke: [
        { ok: false, kind: "transport", check: "read" },
        { ok: true, notes: [] },
      ],
    });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await halted()).toEqual([]);
    expect(await queued()).toEqual([rest]);
  });

  it("two transport failures in one tick's time are one", async () => {
    const { canary } = await settled();
    const t = { ok: false, kind: "transport", check: "mcp" } as const;
    const f = fakes({ canary, smoke: [t, t] });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW, f.opts);
    expect(await halted()).toEqual([]);
  });

  it("unconfigured: never passes, never halts; fleet_halted names it until it runs", async () => {
    const { canary, rest } = await settled();
    const f = fakes({
      canary,
      smoke: [
        { ok: false, kind: "config", check: "token" },
        { ok: true, notes: [] },
      ],
    });
    await fleetDue(f.env, NOW, f.opts);
    expect(await halted()).toEqual([]);
    expect(await queued()).toEqual([]);
    expect(await codes(f, NOW)).toMatchObject([
      { code: "smoke_unconfigured", install_id: canary, message: "token" },
    ]);
    // Set up: the next run passes and the row goes.
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await queued()).toEqual([rest]);
    expect(await codes(f, NOW + 2 * MIN)).toEqual([]);
  });

  it(
    "unconfigured past the window: canary_blocked opens too",
    async () => {
      const { canary } = await settled();
      const f = fakes({
        canary,
        smoke: [{ ok: false, kind: "config", check: "share" }],
      });
      await ticks(f, NOW, NOW + FLEET_BLOCKED_MS);
      expect(
        (await codes(f, NOW + FLEET_BLOCKED_MS)).map((r) => r.code),
      ).toEqual(["smoke_unconfigured", "canary_blocked"]);
      // 23 ticks above (t = 0 to 45): 23 x 93 ms x 3.
    },
    fleetTicksTimeout(23),
  );

  it("out of the tick's time: neither a pass nor a failure", async () => {
    const { canary, rest } = await settled();
    const f = fakes({
      canary,
      smoke: [
        { ok: false, kind: "budget", check: "mcp" },
        { ok: true, notes: [] },
      ],
    });
    await fleetWake(wakeBatch([1]).batch, f.env, NOW, { fleet: f.opts });
    const [audit] = await rows(
      "SELECT detail FROM hosted_audit WHERE action = 'fleet.wake' AND install_id = ?",
      canary,
    );
    expect(JSON.parse(String(audit?.detail))).toMatchObject({
      reason: "smoke_budget",
      check: "mcp",
    });
    expect(await halted()).toEqual([]);
    expect(await stateKeys("fleet_smoke_")).toEqual([]);
    expect(await queued()).toEqual([]);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await queued()).toEqual([rest]);
  });

  it("no smoke before the canary has settled", async () => {
    const canary = await on(TARGET, { created: 0 });
    await fleetJob(canary, { finished_at: NOW - MIN });
    const f = fakes({ canary, answers: new Map([[canary, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    expect(f.smokes).toEqual([]);
  });

  it("a failing probe still halts with the smoke passed (the settle watch)", async () => {
    const { canary } = await settled();
    const id = await on(TARGET, { created: 7 });
    await fleetJob(id, { finished_at: NOW - MIN });
    const f = fakes({ canary, answers: new Map([[id, "down"]]) });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + 2 * MIN, f.opts);
    expect(await halted()).toEqual([`fleet_halt:${TARGET}:${id}`]);
  });

  it("#433: settle is one passing probe", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const id = await on(TARGET, { created: 7 });
    await fleetJob(id, { finished_at: NOW - MIN });
    const f = fakes({ canary });
    await fleetDue(f.env, NOW, f.opts);
    expect(await stateKeys(`${FLEET_SOAKED_PREFIX}${TARGET}:${id}`)).toEqual([
      `${FLEET_SOAKED_PREFIX}${TARGET}:${id}`,
    ]);
  });

  it("smoke marks of older versions are pruned with the rest", async () => {
    const id = installId();
    for (const k of [
      `${FLEET_SMOKED_PREFIX}0.90.0:${id}`,
      "fleet_smoke_fail:0.90.0:mcp",
      "fleet_smoke_halt:0.90.0:read",
      "fleet_smoke_config:0.90.0:token",
    ])
      await db
        .prepare(
          "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
        )
        .bind(k, NOW - FLEET_KEEP_MS - 1)
        .run();
    const f = fakes({});
    await fleetDue(f.env, NOW, f.opts);
    expect(await stateKeys("fleet_smoke")).toEqual([]);
  });
});

describe("#1343: FLEET_SMOKE off keeps the passive soak", () => {
  it('parses: only "off" is off; anything else is required', () => {
    expect(fleetSmokeMode("off")).toBe("off");
    expect(fleetSmokeMode(" off ")).toBe("off");
    for (const v of [undefined, "", "required", "Off", "of", "none"])
      expect(fleetSmokeMode(v), String(v)).toBe("required");
  });

  it("off: no smoke; the canary soaks FLEET_SOAK_OFF_MS, then the rest move", async () => {
    const canary = await on(TARGET, { created: 0 });
    await fleetJob(canary, { finished_at: NOW - MIN });
    const rest = await on("0.92.0", { created: 5 });
    const f = fakes({
      canary,
      smoke: [{ ok: false, kind: "config", check: "token" }],
    });
    Object.assign(f.env, { FLEET_SMOKE: "off" });
    await ticks(f, NOW, NOW + FLEET_SOAK_OFF_MS - 2 * MIN);
    expect(await queued()).toEqual([]);
    await fleetDue(f.env, NOW + FLEET_SOAK_OFF_MS, f.opts);
    expect(await queued()).toEqual([rest]);
    expect(f.smokes).toEqual([]);
    // No smoke_unconfigured row while off, and no canary_blocked once ready.
    expect(
      (await fleetConditions(f.env, NOW + FLEET_SOAK_OFF_MS)).fleet_halted.rows,
    ).toEqual([]);
  });

  it("off: batches soak FLEET_SOAK_OFF_MS too", async () => {
    const canary = await on(TARGET, { created: 0 });
    await soaked(canary);
    const id = await on(TARGET, { created: 5 });
    await fleetJob(id, { finished_at: NOW - MIN });
    const f = fakes({ canary });
    Object.assign(f.env, { FLEET_SMOKE: "off" });
    await ticks(f, NOW, NOW + FLEET_SOAK_OFF_MS - 2 * MIN);
    expect(await stateKeys(`${FLEET_SOAKED_PREFIX}${TARGET}:${id}`)).toEqual(
      [],
    );
    await fleetDue(f.env, NOW + FLEET_SOAK_OFF_MS, f.opts);
    expect(await stateKeys(`${FLEET_SOAKED_PREFIX}${TARGET}:${id}`)).toEqual([
      `${FLEET_SOAKED_PREFIX}${TARGET}:${id}`,
    ]);
  });

  it(
    "required (and unset): a missing token never passes",
    async () => {
      for (const mode of ["required", undefined]) {
        await db.prepare("DELETE FROM platform_state").run();
        const canary = await on(TARGET, { created: 0 });
        await soaked(canary);
        await on("0.92.0", { created: 5 });
        const f = fakes({
          canary,
          smoke: [{ ok: false, kind: "config", check: "token" }],
        });
        if (mode) Object.assign(f.env, { FLEET_SMOKE: mode });
        await ticks(f, NOW, NOW + 30 * MIN);
        expect(
          (await fleetJobs()).filter((j) => j.install_id !== canary),
          String(mode),
        ).toEqual([]);
        await db.prepare("DELETE FROM jobs").run();
      }
      // 32 ticks above (16 a mode, t = 0 to 30): 32 x 93 ms x 3.
    },
    fleetTicksTimeout(32),
  );
});

describe("#1343: the smoke mark is the canary's own", () => {
  it("a new FLEET_CANARY ignores the old canary's fleet_smoked mark", async () => {
    const oldCanary = await on(TARGET, { created: 0 });
    const canary = await on(TARGET, { created: 1 });
    await soaked(oldCanary);
    await soaked(canary);
    await db
      .prepare(
        "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2)",
      )
      .bind(`${FLEET_SMOKED_PREFIX}${TARGET}:${oldCanary}`, NOW - MIN)
      .run();
    await on("0.92.0", { created: 5 });
    const f = fakes({
      canary,
      smoke: [{ ok: false, kind: "config", check: "token" }],
    });
    await fleetDue(f.env, NOW, f.opts);
    // The new canary is smoked itself, and until it passes nothing moves.
    expect(f.smokes.map((s) => s.installId)).toEqual([canary]);
    expect(await queued()).toEqual([]);
    expect(await stateKeys(`${FLEET_BLOCKED_PREFIX}${TARGET}`)).toEqual([
      `${FLEET_BLOCKED_PREFIX}${TARGET}`,
    ]);
  });
});

describe("#1343: FLEET_SMOKE off follows the per-env FLEET_SOAK_MIN", () => {
  it("parses: unset is 15 minutes, whole minutes 1 to the max, else the longest soak", () => {
    expect(fleetSoakOffMs(undefined)).toBe(FLEET_SOAK_OFF_MS);
    expect(FLEET_SOAK_OFF_MS).toBe(15 * MIN);
    expect(fleetSoakOffMs("")).toBe(15 * MIN);
    expect(fleetSoakOffMs("60")).toBe(60 * MIN);
    expect(fleetSoakOffMs(" 15 ")).toBe(15 * MIN);
    for (const v of ["0", "-5", "6O", "60.5", "060", "99999"])
      expect(fleetSoakOffMs(v), v).toBe(FLEET_SOAK_MIN_MAX * MIN);
  });

  it(
    "off with prod's 60: the canary soaks 60 minutes, not 15",
    async () => {
      const canary = await on(TARGET, { created: 0 });
      await fleetJob(canary, { finished_at: NOW - MIN });
      const rest = await on("0.92.0", { created: 5 });
      const f = fakes({ canary });
      Object.assign(f.env, { FLEET_SMOKE: "off", FLEET_SOAK_MIN: "60" });
      await ticks(f, NOW, NOW + 60 * MIN - 2 * MIN);
      expect(await queued()).toEqual([]);
      await fleetDue(f.env, NOW + 60 * MIN, f.opts);
      expect(await queued()).toEqual([rest]);
      expect(f.smokes).toEqual([]);
      // 30 ticks above (t = 0 to 58): 30 x 93 ms x 3.
    },
    fleetTicksTimeout(30),
  );

  it("required ignores FLEET_SOAK_MIN: the 2-minute settle and the smoke", async () => {
    const canary = await on(TARGET, { created: 0 });
    await fleetJob(canary, { finished_at: NOW - MIN });
    const rest = await on("0.92.0", { created: 5 });
    const f = fakes({ canary });
    Object.assign(f.env, { FLEET_SMOKE: "required", FLEET_SOAK_MIN: "60" });
    await fleetDue(f.env, NOW, f.opts);
    await fleetDue(f.env, NOW + FLEET_SOAK_MS, f.opts);
    expect(f.smokes).toHaveLength(1);
    expect(await queued()).toEqual([rest]);
  });
});

describe("#1343: canary_blocked waits out the off-mode soak", () => {
  it("the window: 45 min with the smoke required; soak plus 30 with it off", () => {
    expect(fleetBlockedMs({})).toBe(FLEET_BLOCKED_MS);
    expect(
      fleetBlockedMs({ FLEET_SMOKE: "required", FLEET_SOAK_MIN: "60" }),
    ).toBe(45 * MIN);
    expect(fleetBlockedMs({ FLEET_SMOKE: "off" })).toBe(45 * MIN);
    expect(fleetBlockedMs({ FLEET_SMOKE: "off", FLEET_SOAK_MIN: "15" })).toBe(
      45 * MIN,
    );
    expect(fleetBlockedMs({ FLEET_SMOKE: "off", FLEET_SOAK_MIN: "60" })).toBe(
      90 * MIN,
    );
  });

  it("off with prod's 60: no canary_blocked mid-soak, at 90 it opens", async () => {
    const canary = await on("0.92.0", { serving: "paused" });
    const f = fakes({ canary });
    Object.assign(f.env, { FLEET_SMOKE: "off", FLEET_SOAK_MIN: "60" });
    await fleetDue(f.env, NOW, f.opts);
    const code = async (at: number) =>
      (await fleetConditions(f.env, at)).fleet_halted.rows.map((r) => r.code);
    expect(await code(NOW + FLEET_BLOCKED_MS)).toEqual([]);
    // The reviewer's case: off with 60, at 50 minutes, no canary_blocked.
    expect(await code(NOW + 50 * MIN)).toEqual([]);
    expect(await code(NOW + 90 * MIN - 1)).toEqual([]);
    expect(await code(NOW + 90 * MIN)).toEqual(["canary_blocked"]);
  });

  it(
    "off with prod's 60, ticking: the stamp holds through the soak, nothing opens before 90",
    async () => {
      const canary = await on(TARGET, { created: 0 });
      await fleetJob(canary, { finished_at: NOW - MIN });
      await on("0.92.0", { created: 5 });
      const f = fakes({ canary });
      Object.assign(f.env, { FLEET_SMOKE: "off", FLEET_SOAK_MIN: "60" });
      await ticks(f, NOW, NOW + 50 * MIN);
      expect(
        (await fleetConditions(f.env, NOW + 50 * MIN)).fleet_halted.rows,
      ).toEqual([]);
      // 26 ticks above (t = 0 to 50): 26 x 93 ms x 3.
    },
    fleetTicksTimeout(26),
  );
});

describe("#1299: FLEET_SMOKE_BUS reaches the smoke", () => {
  for (const [v, bus] of [
    ["off", false],
    [undefined, true],
    ["on", true],
    ["Off", true],
  ] as const)
    it(`FLEET_SMOKE_BUS ${String(v)}: bus ${bus}`, async () => {
      const canary = await on(TARGET, { created: 0 });
      await soaked(canary);
      const f = fakes({ canary });
      if (v !== undefined) Object.assign(f.env, { FLEET_SMOKE_BUS: v });
      await fleetDue(f.env, NOW, f.opts);
      expect(f.smokes[0]?.bus).toBe(bus);
    });
});

describe("#1343: FLEET_SMOKE_SHARE reaches the smoke", () => {
  for (const [v, share] of [
    ["on", true],
    [undefined, true],
    ["off", false],
    ["Off", true],
  ] as const)
    it(`FLEET_SMOKE_SHARE ${String(v)}: share ${share}`, async () => {
      const canary = await on(TARGET, { created: 0 });
      await soaked(canary);
      const f = fakes({ canary });
      if (v !== undefined) Object.assign(f.env, { FLEET_SMOKE_SHARE: v });
      await fleetDue(f.env, NOW, f.opts);
      expect(f.smokes[0]?.share).toBe(share);
    });
});
