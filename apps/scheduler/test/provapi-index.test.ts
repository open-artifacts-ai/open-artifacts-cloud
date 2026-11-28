import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { REVOKE_MIN_VERSION } from "@oa/provision/versions";
import {
  FakeWorkflow,
  fakeProvisionerRpc,
} from "@oa/provisioning-contract/fakes";
import {
  JOB_START_GRACE_MS,
  SCHEDULER_TICK_KEY,
} from "@oa/provisioning-contract/state";
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
import scheduler, {
  CRON,
  type Env,
  REVOKE_CRON,
  REVOKE_JOB,
  SYNC_JOB,
} from "../src/index.js";
import {
  FLEET_LEASE_KEY,
  FLEET_VERIFIED_PREFIX,
  fleetRequestId,
} from "../src/provapi/fleet.js";
import { DUTY_TIMEOUT_MS, provapiTick } from "../src/provapi/index.js";
import { getState } from "../src/provapi/state.js";
import { wakeBatch } from "./provapi/batch.js";
import {
  captureLogs,
  db,
  insert,
  install,
  installId,
  job,
  lifecycle,
  migrate,
  reset,
  rows,
} from "./provapi/db.js";

// The */2 branch: the dead-man tick first, then the revoke tick and the
// directory sync exactly as before, then the provapi duties, each isolated.

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 9, 31, 12, 0);
/** A fixed line: words, ids and counts only. */
const LINE = /^provapi [a-z_]+( [A-Za-z0-9_=]+)*$/;

const controller = (cron: string, scheduledTime = NOW) =>
  ({ scheduledTime, cron, noRetry() {} }) as ScheduledController;

type Sent = { subject: string; text: string };

function fakes(o: { broken?: boolean } = {}) {
  const calls: { script: string; cron: unknown }[] = [];
  const sent: Sent[] = [];
  const provision = new FakeWorkflow();
  const manage = new FakeWorkflow();
  const throwing = {
    get: async () => {
      throw new Error("D1_ERROR owner@customer.test");
    },
    create: async () => {
      throw new Error("D1_ERROR owner@customer.test");
    },
  };
  const env = {
    OA_ENV: "staging",
    PLATFORM_DB: db,
    DISPATCHER: {
      get(script: string) {
        return {
          async scheduled(opts: { cron: unknown }) {
            calls.push({ script, cron: opts.cron });
            return undefined;
          },
          async fetch() {
            if (o.broken) throw new Error("boom owner@customer.test");
            return Response.json({ ok: true, installId: script.slice(5) });
          },
        };
      },
    },
    PROVISION_INSTALL: o.broken ? throwing : provision,
    MANAGE_INSTALL: o.broken ? throwing : manage,
    PROVISIONER: o.broken
      ? {
          ...fakeProvisionerRpc(),
          tokenStatus: async () => {
            throw new Error("SECRET");
          },
        }
      : fakeProvisionerRpc({
          tokenStatus: { status: "invalid", expiresAt: null, daysLeft: null },
        }),
    ALERT_EMAIL: {
      send: async (m: Sent) => {
        if (o.broken) throw new Error("owner@customer.test");
        sent.push(m);
        return { messageId: "m" };
      },
    },
    ALERT_TO: "ops@example.test",
    ALERT_FROM: "alerts@example.test",
  } as unknown as Env;
  return { env, calls, sent, provision, manage };
}

async function seedRevokeAndSync() {
  const del = installId();
  await install(del, {
    state: "deleting",
    version: REVOKE_MIN_VERSION,
    directory_revoke: "pending",
  });
  const act = installId();
  await install(act, { state: "active" });
  return { del, act };
}

describe("scheduled() and the provapi duties", () => {
  it("*/2: the tick is written with value = scheduledTime even when every duty fails", async () => {
    const f = fakes({ broken: true });
    await job(installId(), { created_at: NOW - JOB_START_GRACE_MS });
    const lines = captureLogs(vi.spyOn);
    await scheduler.scheduled(
      controller(REVOKE_CRON),
      f.env,
      createExecutionContext(),
    );
    expect(await getState(db, SCHEDULER_TICK_KEY)).toBe(NOW);
    const provapi = lines.filter((l) => l.startsWith("provapi "));
    expect(provapi.length).toBeGreaterThan(0);
    for (const l of provapi) expect(l).toMatch(LINE);
    expect(lines.join("\n")).not.toMatch(/@|SECRET|D1_ERROR|boom/);
  });

  it("*/2: a provapi failure never changes the revoke or sync results", async () => {
    const results = [];
    for (const broken of [false, true]) {
      await reset();
      const { del, act } = await seedRevokeAndSync();
      const f = fakes({ broken });
      captureLogs(vi.spyOn);
      await scheduler.scheduled(
        controller(REVOKE_CRON),
        f.env,
        createExecutionContext(),
      );
      vi.restoreAllMocks();
      results.push({
        calls: f.calls.map((c) => ({
          script: c.script.replace(del, "DEL").replace(act, "ACT"),
          cron: c.cron,
        })),
        revoke: (
          await rows("SELECT directory_revoke FROM installs WHERE id = ?1", del)
        )[0],
      });
    }
    expect(results[0]).toEqual({
      calls: [
        { script: "oa-s-DEL", cron: REVOKE_JOB },
        { script: "oa-s-ACT", cron: SYNC_JOB },
      ],
      revoke: { directory_revoke: "done" },
    });
    expect(results[1]).toEqual(results[0]);
  });

  it("*/2: the duties run: a dead job is started, an alert opens and emails", async () => {
    const f = fakes();
    const id = await job(installId(), {
      created_at: NOW - JOB_START_GRACE_MS,
      updated_at: NOW - JOB_START_GRACE_MS,
    });
    const lines = captureLogs(vi.spyOn);
    await scheduler.scheduled(
      controller(REVOKE_CRON),
      f.env,
      createExecutionContext(),
    );
    for (const l of lines.filter((x) => x.startsWith("provapi ")))
      expect(l).toMatch(LINE);
    expect(f.provision.created.map((c) => c.id)).toEqual([id]);
    expect(await getState(db, "token_invalid_opened_at")).toBe(NOW);
    expect(f.sent.map((s) => s.subject)).toEqual([
      "Open Artifacts staging: provisioner token invalid",
    ]);
  });

  it("the nightly cron writes no tick and runs no duty", async () => {
    const f = fakes();
    await job(installId(), { created_at: NOW - JOB_START_GRACE_MS });
    const lines = captureLogs(vi.spyOn);
    await scheduler.scheduled(
      controller(CRON),
      f.env,
      createExecutionContext(),
    );
    expect(await getState(db, SCHEDULER_TICK_KEY)).toBeNull();
    expect(f.provision.created).toEqual([]);
    expect(f.sent).toEqual([]);
    expect(lines.some((l) => l.startsWith("provapi"))).toBe(false);
  });

  // cloud #264: with the smoke required (unset here, as on prod) the
  // 2-minute tick runs no fleet; only queue() does, on the fleet's events, so
  // the tick never touches the fleet lease.
  it("*/2, smoke required: no fleet duty: the tick runs no fleet pass and leaves the fleet lease alone", async () => {
    const f = fakes();
    const lines = captureLogs(vi.spyOn);
    expect(await provapiTick(f.env, NOW)).not.toHaveProperty("fleet");
    expect(lines).not.toContain("provapi fleet no_target");
    expect(await getState(db, FLEET_LEASE_KEY)).toBeNull();
    await insert("platform_state", {
      key: FLEET_LEASE_KEY,
      value: NOW - 1_000,
      updated_at: NOW - 1_000,
    });
    lines.length = 0;
    await scheduler.scheduled(
      controller(REVOKE_CRON),
      f.env,
      createExecutionContext(),
    );
    expect(lines.filter((l) => l.startsWith("provapi fleet"))).toEqual([]);
    expect(await getState(db, FLEET_LEASE_KEY)).toBe(NOW - 1_000);
  });

  it("replays the 09:43Z staging deploy wake through the consumer and records its canary decision", async () => {
    const canary = "i33m6mbc3zuz";
    const to = "0.268.0";
    const tag = `v${to}`;
    const at = Date.parse("2026-11-27T09:43:10.878Z");
    vi.spyOn(Date, "now").mockReturnValue(at);
    const { env, manage } = fakes();
    await install(canary, { version: "0.265.0" });
    await lifecycle(canary, { serving_mode: "serving", health: "ok" });
    await job(canary, {
      kind: "upgrade",
      workflow: "manage_install",
      actor_kind: "system",
      actor_key: SYSTEM_ACTOR.key,
      request_id: fleetRequestId(canary, "0.265.0"),
      args: JSON.stringify({ from: "0.264.0", to: "0.265.0" }),
      status: "done",
    });
    for (let n = 0; n < 6; n++) {
      const id = installId();
      await install(id, { version: "0.251.1" });
      await lifecycle(id, { serving_mode: "serving", health: "ok" });
      await job(id, {
        kind: "upgrade",
        workflow: "manage_install",
        actor_kind: "system",
        actor_key: SYSTEM_ACTOR.key,
        request_id: fleetRequestId(id, "0.265.0"),
        args: JSON.stringify({ from: "0.251.1", to: "0.265.0" }),
        status: "failed",
        error_code: "migration_held",
      });
    }
    await insert("platform_state", {
      key: FLEET_VERIFIED_PREFIX + to,
      value: at - 676,
      updated_at: at - 676,
    });
    const batch = createMessageBatch("oa-s-fleet-wake", [
      {
        id: "deploy",
        timestamp: at,
        attempts: 1,
        body: { env: "staging", tag },
      },
    ]);
    await scheduler.queue(batch, {
      ...env,
      FLEET_CANARY: canary,
      FLEET_SMOKE: "required",
      CF_VERSION_METADATA: {
        id: "test",
        tag,
        timestamp: new Date(at).toISOString(),
      },
      PROVISIONER: fakeProvisionerRpc({
        releases: [
          {
            version: to,
            publishedAt: 1,
            variants: ["release"],
            installable: true,
            latest: true,
          },
        ],
      }) as Env["PROVISIONER"],
    });
    expect(await getQueueResult(batch, createExecutionContext())).toMatchObject(
      {
        explicitAcks: ["deploy"],
        retryMessages: [],
      },
    );
    expect(
      await rows(
        "SELECT install_id, request_id FROM jobs WHERE status = 'queued'",
      ),
    ).toEqual([{ install_id: canary, request_id: fleetRequestId(canary, to) }]);
    expect(manage.created).toHaveLength(1);
    const audit = await rows(
      "SELECT actor, detail FROM hosted_audit WHERE action = 'fleet.wake' AND install_id = ?",
      canary,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe(SYSTEM_ACTOR.key);
    expect(JSON.parse(String(audit[0]?.detail))).toEqual({
      to,
      canary,
      decision: "canary",
      reason: "canary_job_queued",
      retried: false,
    });
  });

  it("queue(): a fleet wake runs the fleet only, acks its message and writes no tick", async () => {
    const { del } = await seedRevokeAndSync();
    const f = fakes();
    await job(installId(), { created_at: NOW - JOB_START_GRACE_MS });
    const { batch, acked, retried } = wakeBatch([1, 2]);
    const lines = captureLogs(vi.spyOn);
    await scheduler.queue(batch, f.env);
    expect(acked).toEqual([0, 1]);
    expect(retried).toEqual([]);
    // No dead-man tick, no duty, no revoke, no sync, no mail.
    expect(await getState(db, SCHEDULER_TICK_KEY)).toBeNull();
    expect(f.calls).toEqual([]);
    expect(f.provision.created).toEqual([]);
    expect(f.sent).toEqual([]);
    expect(
      (
        await rows("SELECT directory_revoke FROM installs WHERE id = ?1", del)
      )[0],
    ).toEqual({ directory_revoke: "pending" });
    // The fleet ran (no target in this env) and gave its lease back.
    expect(lines).toEqual([
      "provapi fleet no_target",
      "provapi fleet wake ok messages=2 retried=0 again=0",
    ]);
    for (const l of lines) expect(l).toMatch(LINE);
    expect(await getState(db, FLEET_LEASE_KEY)).toBeNull();
  });

  it("an unknown cron writes no tick", async () => {
    const f = fakes();
    await scheduler.scheduled(
      controller("0 0 * * *"),
      f.env,
      createExecutionContext(),
    );
    expect(await getState(db, SCHEDULER_TICK_KEY)).toBeNull();
  });

  it("a late tick never lowers scheduler_tick_at", async () => {
    const f = fakes();
    captureLogs(vi.spyOn);
    await scheduler.scheduled(
      controller(REVOKE_CRON, NOW),
      f.env,
      createExecutionContext(),
    );
    await scheduler.scheduled(
      controller(REVOKE_CRON, NOW - 2 * 60_000),
      f.env,
      createExecutionContext(),
    );
    expect(await getState(db, SCHEDULER_TICK_KEY)).toBe(NOW);
  });

  it("provapiTick: one hanging duty times out; the rest run", async () => {
    const f = fakes();
    const hang = {
      ...fakeProvisionerRpc(),
      tokenStatus: () => new Promise<never>(() => {}),
    };
    await insert("prodclean_reports", { at: NOW, ok: 0, code: "dirty" });
    const lines = captureLogs(vi.spyOn);
    const out = await provapiTick({ ...f.env, PROVISIONER: hang } as Env, NOW, {
      timeoutMs: { alerts: 20 },
    });
    expect(out).toEqual({
      sweep: "ok",
      signups: "ok",
      reminders: "ok",
      purge: "ok",
      health: "ok",
      alerts: "timeout",
      prune: "ok",
    });
    expect(lines).toContain("provapi alerts failed timeout");
    for (const l of lines) expect(l).toMatch(LINE);
    // The smoke is required here (unset), so no fleet duty runs (cloud #264).
    expect(Object.keys(DUTY_TIMEOUT_MS).filter((k) => k !== "fleet")).toEqual(
      Object.keys(out),
    );
    // #1083 re-review N9: the budgets fit inside the 2-minute tick with room.
    const total = Object.values(DUTY_TIMEOUT_MS).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(120_000);
  });
});
