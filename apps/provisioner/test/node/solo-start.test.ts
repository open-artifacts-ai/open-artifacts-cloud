// ProvisionInstall's solo_start step (self-serve only): billing's
// BillingProvisionerRpc.soloStart, ordered after create's registry write and
// before done (ready) and notify (welcome).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_PUBKEY } from "../../../../packages/provision/test/fixtures/release.js";
import {
  type BillingProvisionerRpc,
  runCreate,
  type SoloStartResult,
} from "../../src/workflow.js";
import { event, seedCreate, stepRunner, type World, world } from "./world.js";

vi.mock(
  "../../../../packages/provision/src/internal/gates.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../../packages/provision/src/internal/gates.js")
    >()),
    get RELEASE_PUBKEY() {
      return { staging: TEST_PUBKEY, prod: TEST_PUBKEY };
    },
  }),
);

async function run(w: World, jobId: string, o: { twice?: boolean } = {}) {
  const r = stepRunner(w.clock, o);
  const e = await runCreate(w.ctx, event(jobId), r.step).then(
    () => null,
    (x: unknown) => x as Error,
  );
  return { ...r, error: e };
}

let w: World;
beforeEach(async () => {
  w = await world();
});

const OK: SoloStartResult = {
  ok: true,
  tier: "solo",
  status: "active",
  trialEndsAt: null,
  graceUntil: null,
  soloTrialEndsAt: 1,
  version: 1,
  asOf: 1,
};
type Answer = SoloStartResult | Error;
/** A BILLING binding that answers from `answers` in turn (the last repeats). */
function bind(answers: Answer[], seen: string[] = []) {
  const calls: string[] = seen;
  const soloStart = vi.fn(async (install: string): Promise<SoloStartResult> => {
    calls.push(install);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)] as Answer;
    if (a instanceof Error) throw a;
    return a;
  });
  w.ctx.env.BILLING = { soloStart } as BillingProvisionerRpc;
  return { soloStart, calls };
}
const selfServe = (slug: string, sendWelcome = true) =>
  seedCreate(w, { slug, source: "self-serve", tier: "trial", sendWelcome });
const signup = (id: string) =>
  w.signup(id) as {
    status: string;
    solo_started_at: number | null;
    solo_skipped_at: number | null;
  };

describe("ProvisionInstall: solo_start", () => {
  it("runs after the registry write and before ready and the welcome", async () => {
    const s = selfServe("sord");
    const seen: Record<string, unknown> = {};
    const soloStart = vi.fn(async (id: string): Promise<SoloStartResult> => {
      seen.id = id;
      seen.registry = w.signin(id) !== undefined;
      seen.status = signup(s.signupId).status;
      seen.mail = w.mail.length;
      seen.jobDone = (w.job(s.jobId) as { status: string }).status;
      return OK;
    });
    w.ctx.env.BILLING = { soloStart } as BillingProvisionerRpc;
    const r = await run(w, s.jobId);
    expect(r.error).toBeNull();
    expect(seen).toEqual({
      id: s.installId,
      registry: true,
      status: "creating",
      mail: 0,
      jobDone: "running",
    });
    const names = r.log.map((l) => l.name);
    expect(names.indexOf("create")).toBeLessThan(names.indexOf("solo_start"));
    expect(names.indexOf("solo_start")).toBeLessThan(names.indexOf("notify"));
    expect(names.indexOf("solo_start")).toBeLessThan(names.indexOf("done"));
    expect(signup(s.signupId)).toMatchObject({
      status: "ready",
      solo_skipped_at: null,
      solo_started_at: expect.any(Number),
    });
    expect(w.mail).toHaveLength(1);
  });

  it("a retryable answer retries the step, then succeeds", async () => {
    const s = selfServe("sretry");
    const b = bind([
      { ok: false, error: "unknown_install", retryable: true },
      { ok: false, error: "unknown_install", retryable: true },
      OK,
    ]);
    const r = await run(w, s.jobId);
    expect(r.error).toBeNull();
    expect(b.calls).toEqual([s.installId, s.installId, s.installId]);
    expect(r.log.filter((l) => l.name === "solo_start")).toHaveLength(3);
    expect(signup(s.signupId).solo_started_at).not.toBeNull();
    expect(w.job(s.jobId)).toMatchObject({ status: "done" });
  });

  it("a thrown transport error is retried", async () => {
    const s = selfServe("sthrow");
    const b = bind([new Error("network lost"), OK]);
    const r = await run(w, s.jobId);
    expect(r.error).toBeNull();
    expect(b.calls).toHaveLength(2);
    expect(signup(s.signupId).status).toBe("ready");
  });

  it("a retryable answer that never clears fails the job after the step's retries", async () => {
    const s = selfServe("sexhaust");
    const b = bind([{ ok: false, error: "unknown_install", retryable: true }]);
    const r = await run(w, s.jobId);
    expect(r.error).not.toBeNull();
    expect(b.calls).toHaveLength(7);
    expect(signup(s.signupId).status).toBe("failed");
    expect(w.mail).toHaveLength(0);
  });

  it("a malformed answer is never marked started and is retried", async () => {
    const s = selfServe("smal");
    const b = bind([
      {} as SoloStartResult,
      { ok: "yes" } as unknown as SoloStartResult,
      OK as SoloStartResult,
    ]);
    const r = await run(w, s.jobId);
    expect(r.error).toBeNull();
    expect(b.calls).toHaveLength(3);
    expect(signup(s.signupId).solo_started_at).not.toBeNull();
  });

  it("a malformed answer that never clears fails without marking started", async () => {
    const s = selfServe("smal2");
    const b = bind([undefined as unknown as SoloStartResult]);
    const r = await run(w, s.jobId);
    expect(r.error).not.toBeNull();
    expect(b.calls).toHaveLength(7);
    expect(signup(s.signupId).solo_started_at).toBeNull();
  });

  it("a non-retryable answer fails the job once, runs fail and settles the signup failed", async () => {
    const s = selfServe("snonret");
    const b = bind([{ ok: false, error: "plan_conflict", retryable: false }]);
    const r = await run(w, s.jobId);
    expect(r.error?.name).toBe("NonRetryableError");
    expect(b.calls).toHaveLength(1);
    expect(r.log.some((l) => l.name === "fail")).toBe(true);
    expect(w.job(s.jobId)).toMatchObject({
      status: "failed",
      error_code: "internal",
    });
    // billing's error text is not stored on the job row
    expect(JSON.stringify(w.job(s.jobId))).not.toContain("plan_conflict");
    expect(signup(s.signupId)).toMatchObject({
      status: "failed",
      solo_started_at: null,
    });
    // The install exists by now, so settleFailed keeps the account claim
    // until purge (jobs.ts FREE_ACCOUNT); the job_failed alert owns the rest.
    expect(w.install(s.installId)).toBeDefined();
    expect(
      w.get("SELECT freed_at FROM signup_accounts WHERE owner_sub = ?", s.sub),
    ).toEqual({ freed_at: null });
    expect(w.mail).toHaveLength(0);
  });

  it("no BILLING binding: skipped, recorded, and the create succeeds", async () => {
    const s = selfServe("snobill");
    expect(w.ctx.env.BILLING).toBeUndefined();
    const r = await run(w, s.jobId);
    expect(r.error).toBeNull();
    expect(r.log.find((l) => l.name === "solo_start")?.output).toEqual({
      skipped: "no_billing",
    });
    expect(signup(s.signupId)).toMatchObject({
      status: "ready",
      solo_started_at: null,
      solo_skipped_at: expect.any(Number),
    });
    expect(w.mail).toHaveLength(1);
  });

  it("an admin create never calls billing and has no solo_start step", async () => {
    const s = seedCreate(w, { slug: "sadmin" });
    const b = bind([OK]);
    const r = await run(w, s.jobId);
    expect(r.error).toBeNull();
    expect(b.calls).toHaveLength(0);
    expect(r.log.some((l) => l.name === "solo_start")).toBe(false);
  });

  it("a replay of the step (twice, or an engine replay) is idempotent", async () => {
    const s = selfServe("sreplay");
    const b = bind([OK]);
    const r = await run(w, s.jobId, { twice: true });
    expect(r.error).toBeNull();
    // every body ran twice; the second call carries the same install id
    expect(new Set(b.calls)).toEqual(new Set([s.installId]));
    const first = signup(s.signupId).solo_started_at;
    expect(first).not.toBeNull();
    // a second full run with the steps' results replayed does not call billing
    const results = new Map<string, unknown>();
    const s2 = selfServe("sreplay2");
    const calls1 = bind([OK]);
    const r1 = stepRunner(w.clock, { results, evictAfter: "reachable" });
    void runCreate(w.ctx, event(s2.jobId), r1.step);
    await r1.evicted;
    expect(calls1.calls).toHaveLength(1);
    const r2 = stepRunner(w.clock, { results });
    await runCreate(w.ctx, event(s2.jobId), r2.step);
    expect(calls1.calls).toHaveLength(1);
    expect(r2.log.find((l) => l.name === "solo_start")?.replayed).toBe(true);
    expect(signup(s2.signupId).status).toBe("ready");
  });
});
