// R15's held read (cloud #264): GET /jobs/:jobId?wait=<ms>. The job's end
// is pushed to the held request through JOB_WAIT (faked here: the test is
// the job's end and the clock). Access is the plain read's, checked before
// any hold; a bad wait is a 400, which is the probe.
import { API_ERROR_STATUS, JobSchema } from "@oa/provisioning-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_WAIT_MAX_MS } from "../src/services/job-wait.js";
import { call } from "./call.js";
import {
  ADMIN_P,
  db,
  fakeEnv,
  requestId,
  resetDb,
  seedInstall,
  seedJob,
  tokenP,
  userP,
} from "./fakes.js";

const NOW = Date.UTC(2026, 10, 26, 12);
const READ = tokenP(["installs:read"]);

beforeEach(async () => {
  await resetDb();
  vi.spyOn(Date, "now").mockImplementation(() => NOW);
});
afterEach(() => vi.restoreAllMocks());

/**
 * A JOB_WAIT whose holds stay open until the test ends the job (`end`) or
 * runs the wait out (`runOut`): nothing here waits on a clock of its own.
 */
function jobWait() {
  const holds: { jobId: string; ms: number; release(v: boolean): void }[] = [];
  const ends: string[] = [];
  let arrived: () => void = () => {};
  const ns = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      hold: (jobId: string, ms: number) =>
        new Promise<boolean>((release) => {
          expect(id as unknown as string).toBe(jobId);
          holds.push({ jobId, ms, release });
          arrived();
        }),
      end: async () => {
        ends.push(id as unknown as string);
        return 0;
      },
    }),
  };
  return {
    ns,
    holds,
    ends,
    /** Resolves once a read is held. */
    held: () =>
      holds.length
        ? Promise.resolve()
        : new Promise<void>((r) => {
            arrived = r;
          }),
  };
}

const finish = (id: string, status: "done" | "failed") =>
  db
    .prepare(
      "UPDATE jobs SET status = ?2, step = 'done', finished_at = ?3, updated_at = ?3 WHERE id = ?1",
    )
    .bind(id, status, NOW)
    .run();

const r15 = (
  e: ReturnType<typeof fakeEnv>,
  jobId: string,
  wait?: string,
  p = READ,
) =>
  call(e, p, "R15", {
    params: { jobId },
    query: wait === undefined ? {} : { wait },
  });

describe("R15 ?wait= holds an open job's read until its end", () => {
  it("the job ends while held: the read answers done, as pushed, at once", async () => {
    const j = jobWait();
    const e = fakeEnv({ JOB_WAIT: j.ns });
    const { id } = await seedInstall();
    const job = await seedJob(id, { status: "running", step: "upload" });
    const read = r15(e, job, "25000");
    await j.held();
    expect(j.holds.map((h) => [h.jobId, h.ms])).toEqual([[job, 25_000]]);
    // The provisioner's done step, then its job_end.
    await finish(job, "done");
    j.holds[0].release(true);
    const r = await read;
    expect(r.status).toBe(200);
    expect(JobSchema.parse(r.body)).toMatchObject({ id: job, status: "done" });
  });

  it("the wait runs out: the job as it is, still running", async () => {
    const j = jobWait();
    const e = fakeEnv({ JOB_WAIT: j.ns });
    const { id } = await seedInstall();
    const job = await seedJob(id, { status: "queued" });
    const read = r15(e, job, "1000");
    await j.held();
    j.holds[0].release(false);
    const r = await read;
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("queued");
    expect(j.holds[0].ms).toBe(1000);
  });

  it(`a wait over ${JOB_WAIT_MAX_MS} ms holds ${JOB_WAIT_MAX_MS} ms`, async () => {
    const j = jobWait();
    const e = fakeEnv({ JOB_WAIT: j.ns });
    const { id } = await seedInstall();
    const job = await seedJob(id, { status: "running" });
    const read = r15(e, job, "999999999");
    await j.held();
    expect(j.holds[0].ms).toBe(JOB_WAIT_MAX_MS);
    j.holds[0].release(false);
    expect((await read).status).toBe(200);
  });

  it("no hold: no wait, wait=0, a finished job, or JOB_WAIT unbound", async () => {
    const j = jobWait();
    const e = fakeEnv({ JOB_WAIT: j.ns });
    const { id } = await seedInstall();
    const open = await seedJob(id, { status: "running" });
    expect((await r15(e, open)).body.status).toBe("running");
    expect((await r15(e, open, "0")).body.status).toBe("running");
    for (const status of ["done", "failed"] as const) {
      const ended = await seedJob(id, { status });
      expect((await r15(e, ended, "25000")).body.status).toBe(status);
    }
    expect(j.holds).toEqual([]);
    const unbound = fakeEnv();
    expect((await r15(unbound, open, "25000")).body.status).toBe("running");
  });

  it("a failed hold (the object reset by a deploy) answers the job as it is", async () => {
    const e = fakeEnv({
      JOB_WAIT: {
        idFromName: (n: string) => n as unknown as DurableObjectId,
        get: () => ({
          hold: async () => {
            throw new Error(
              "Durable Object reset because its code was updated",
            );
          },
          end: async () => 0,
        }),
      },
    });
    const { id } = await seedInstall();
    const job = await seedJob(id, { status: "running" });
    const r = await r15(e, job, "25000");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("running");
  });

  it("a caller who may not read the job is refused as before, and nothing is held", async () => {
    const j = jobWait();
    const e = fakeEnv({ JOB_WAIT: j.ns });
    const mine = await seedInstall({ source: "self-serve", ownerSub: "u2" });
    const job = await seedJob(mine.id, { status: "running" });
    // authz (a token without installs:read): before the query is read.
    const noScope = await r15(e, job, "invalid", tokenP(["audit:read"]));
    expect(noScope.code).toBe("forbidden");
    expect((await r15(e, job, "25000", tokenP(["audit:read"]))).code).toBe(
      "forbidden",
    );
    // Reach (another user's install): 404 before any hold.
    expect((await r15(e, job, "25000", userP("u1"))).code).toBe("not_found");
    expect(j.holds).toEqual([]);
  });

  it("a bad wait is a 400 invalid_input on query.wait (the probe); nothing is held", async () => {
    const j = jobWait();
    const e = fakeEnv({ JOB_WAIT: j.ns });
    const { id } = await seedInstall();
    const job = await seedJob(id, { status: "running" });
    for (const wait of ["invalid", "-1", "1.5", "", "1e3", "1234567890"]) {
      const r = await r15(e, job, wait);
      expect(r.code, wait).toBe("invalid_input");
      expect(r.status).toBe(400);
      expect(r.details).toEqual({ fields: ["query.wait"] });
    }
    expect(API_ERROR_STATUS.invalid_input).toBe(400);
    expect(j.holds).toEqual([]);
    // An admin probes the same way, on any job id, even an unknown one.
    expect(
      (await r15(e, "01JE0000000000000000000000", "invalid", ADMIN_P)).code,
    ).toBe("invalid_input");
  });

  it("R25's cancel releases the canceled job's held reads", async () => {
    const j = jobWait();
    const e = fakeEnv({ JOB_WAIT: j.ns });
    const { id, slug } = await seedInstall();
    const r1 = await call(e, ADMIN_P, "R7", {
      params: { id },
      body: { requestId: requestId(), reason: "x" },
    });
    const target = r1.body.job.id as string;
    const r = await call(e, ADMIN_P, "R25", {
      params: { jobId: target },
      body: { requestId: requestId(), confirmSlug: slug },
    });
    expect(r.status).toBe(202);
    expect(j.ends).toEqual([target]);
  });
});
