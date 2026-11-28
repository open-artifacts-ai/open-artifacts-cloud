// JobWait (cloud #264): R15's held read is released by the job's end, a
// push, never a poll. The holds on a fake clock (no timer ever runs on its
// own), and every Workflow end that releases them: a create's and a manage
// job's done or fail, and a cleanup's settle of its parent.
import { FLOOR_KEY } from "@oa/provision";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  floorOf,
  signFloor,
  TEST_PUBKEY,
} from "../../../../packages/provision/test/fixtures/release.js";
import {
  Holds,
  holdMs,
  JOB_WAIT_MAX_MS,
  JobWait,
  type Timer,
} from "../../src/job-wait.js";
import { runManage } from "../../src/manage.js";
import { runCreate } from "../../src/workflow.js";
import {
  type CreateSeed,
  event,
  seedCreate,
  seedJob,
  stepRunner,
  V1,
  V2,
  type World,
  world,
} from "./world.js";

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

/** A clock the test moves: a timer fires only on `advance`. */
function fakeTimer() {
  let now = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  let n = 0;
  const t: Timer & { advance(ms: number): void; pending(): number } = {
    set(fn, ms) {
      due.set(++n, { at: now + ms, fn });
      return n;
    },
    clear(h) {
      due.delete(h as number);
    },
    advance(ms) {
      now += ms;
      for (const [h, d] of [...due]) {
        if (d.at > now) continue;
        due.delete(h);
        d.fn();
      }
    },
    pending: () => due.size,
  };
  return t;
}

/** Whether `p` has settled, after the microtasks queued so far. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return done;
}

describe("Holds", () => {
  it("an end releases every hold at once, true; its timers are cleared", async () => {
    const t = fakeTimer();
    const h = new Holds(t);
    const a = h.hold(25_000, async () => false);
    const b = h.hold(25_000, async () => false);
    expect(await settled(a)).toBe(false);
    expect(h.size).toBe(2);
    expect(h.release()).toBe(2);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(t.pending()).toBe(0);
    expect(h.release()).toBe(0);
  });

  it("the bound answers false, and not a millisecond before", async () => {
    const t = fakeTimer();
    const h = new Holds(t);
    const a = h.hold(25_000, async () => false);
    t.advance(24_999);
    expect(await settled(a)).toBe(false);
    t.advance(1);
    expect(await a).toBe(false);
    expect(h.size).toBe(0);
  });

  it("a job already ended when the hold registers answers at once", async () => {
    const t = fakeTimer();
    const h = new Holds(t);
    expect(await h.hold(25_000, async () => true)).toBe(true);
    expect(t.pending()).toBe(0);
  });

  it("an end that lands while the read is in flight is not missed", async () => {
    const t = fakeTimer();
    const h = new Holds(t);
    let answer: (v: boolean) => void = () => {};
    const a = h.hold(
      25_000,
      () =>
        new Promise<boolean>((r) => {
          answer = r;
        }),
    );
    h.release();
    // The read, begun before the end, still says running.
    answer(false);
    expect(await a).toBe(true);
  });

  it("a failed read leaves the hold to an end or its bound", async () => {
    const t = fakeTimer();
    const h = new Holds(t);
    const a = h.hold(10, async () => {
      throw new Error("d1 down");
    });
    expect(await settled(a)).toBe(false);
    t.advance(10);
    expect(await a).toBe(false);
  });

  it("holdMs bounds the wait to 0..JOB_WAIT_MAX_MS, whole ms", () => {
    expect(holdMs(-5)).toBe(0);
    expect(holdMs(Number.NaN)).toBe(0);
    expect(holdMs(1500.7)).toBe(1500);
    expect(holdMs(10 ** 9)).toBe(JOB_WAIT_MAX_MS);
  });
});

/** JobWait objects by name, on the world's D1 and a fake clock. */
function namespace(w: World) {
  const timer = fakeTimer();
  class TestJobWait extends JobWait {
    constructor() {
      super({} as DurableObjectState, { PLATFORM_DB: w.ctx.env.PLATFORM_DB });
      this.holds = new Holds(timer);
    }
  }
  const objects = new Map<string, TestJobWait>();
  const ends: string[] = [];
  /** The job's row as each push found it. */
  const rows: { id: string; status?: string; code: string | null }[] = [];
  const ns = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = id as unknown as string;
      let o = objects.get(name);
      if (!o) {
        o = new TestJobWait();
        objects.set(name, o);
      }
      const obj = o;
      return {
        hold: (jobId: string, ms: number, seen?: number | null) =>
          obj.hold(jobId, ms, seen),
        changed: () => {
          ends.push(name);
          const j = w.job(name);
          rows.push({
            id: name,
            status: j?.status as string | undefined,
            code: (j?.last_error_code as string | null | undefined) ?? null,
          });
          return obj.changed();
        },
      };
    },
  };
  return {
    ns: ns as unknown as DurableObjectNamespace<JobWait>,
    get: ns.get,
    ends,
    rows,
    timer,
  };
}

let w: World;
beforeEach(async () => {
  w = await world();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const create = (o: CreateSeed) => {
  const s = seedCreate(w, o);
  const r = stepRunner(w.clock);
  return {
    s,
    log: r.log,
    run: runCreate(w.ctx, event(s.jobId), r.step),
  };
};

async function manage(
  kind: string,
  installId: string,
  o: Omit<Parameters<typeof seedJob>[1], "kind" | "installId"> = {},
) {
  const id = seedJob(w, { kind, installId, ...o });
  const r = stepRunner(w.clock);
  const error = await runManage(w.ctx, event(id), r.step).then(
    () => null,
    (x: unknown) => x as Error,
  );
  return { id, error, names: r.log.map((l) => l.name), job: w.job(id) };
}

describe("JobWait.hold reads the job once it is registered", () => {
  it("a row changed since the caller's read (updated_at) answers at once; the same row holds", async () => {
    const n = namespace(w);
    const s = seedCreate(w, { slug: "seenco" });
    const row = w.get("SELECT updated_at FROM jobs WHERE id = ?", s.jobId) as {
      updated_at: number;
    };
    const o = n.get(s.jobId as unknown as DurableObjectId);
    expect(await o.hold(s.jobId, 25_000, row.updated_at - 1)).toBe(true);
    const same = o.hold(s.jobId, 25_000, row.updated_at);
    expect(await settled(same)).toBe(false);
    // No caller's row: only an end, a push or the bound.
    const none = o.hold(s.jobId, 25_000, null);
    expect(await settled(none)).toBe(false);
    n.timer.advance(25_000);
    expect(await same).toBe(false);
    expect(await none).toBe(false);
    // An unknown job is never held.
    expect(await o.hold("01JE0000000000000000000000", 25_000, 1)).toBe(true);
  });
});

describe("a job's end releases its held reads", () => {
  it("a create: the read held while it runs answers true at its end, no timer", async () => {
    const n = namespace(w);
    w.ctx.env.JOB_WAIT = n.ns;
    const c = create({ slug: "heldco" });
    const held = n
      .get(c.s.jobId as unknown as DurableObjectId)
      .hold(c.s.jobId, 25_000);
    await c.run;
    expect(w.job(c.s.jobId)?.status).toBe("done");
    expect(await held).toBe(true);
    expect(n.timer.pending()).toBe(0);
    const names = c.log.map((l) => l.name);
    expect(names.slice(-2)).toEqual(["done", "job_end"]);
    expect(n.ends).toEqual([c.s.jobId]);
    // A read of the ended job is not held at all.
    expect(
      await n
        .get(c.s.jobId as unknown as DurableObjectId)
        .hold(c.s.jobId, 25_000),
    ).toBe(true);
  });

  it("a manage job: job_end after done; a failed one's right after fail", async () => {
    const n = namespace(w);
    w.ctx.env.JOB_WAIT = n.ns;
    await w.r2.put(FLOOR_KEY, JSON.stringify(signFloor(floorOf())));
    const a = create({ slug: "endco", version: V1 });
    await a.run;
    const ok = await manage("upgrade", a.s.installId, {
      args: { from: V1, to: V2 },
    });
    expect(ok.job?.status).toBe("done");
    expect(ok.names.slice(-2)).toEqual(["done", "job_end"]);
    const b = create({ slug: "endfail", version: V1 });
    await b.run;
    await w.r2.put(
      FLOOR_KEY,
      JSON.stringify(signFloor(floorOf({ revoked: [V2] }))),
    );
    const bad = await manage("upgrade", b.s.installId, {
      args: { from: V1, to: V2 },
    });
    expect(bad.job?.status).toBe("failed");
    expect(bad.names.indexOf("job_end")).toBe(bad.names.indexOf("fail") + 1);
    // The failed attempt's code is pushed when it is recorded (the job
    // still running: a waiter for a state before the end, such as P53's
    // lease_held, gets it), then the end.
    expect(n.ends).toEqual([a.s.jobId, ok.id, b.s.jobId, bad.id, bad.id]);
    expect(n.rows.filter((x) => x.id === bad.id)).toEqual([
      { id: bad.id, status: "running", code: "release_unverified" },
      { id: bad.id, status: "failed", code: "release_unverified" },
    ]);
  });

  it("a cleanup releases its parent's reads after the settle", async () => {
    const n = namespace(w);
    w.ctx.env.JOB_WAIT = n.ns;
    const s = seedCreate(w, {
      slug: "parentco",
      source: "self-serve",
      tier: "trial",
    });
    w.db
      .prepare(
        "UPDATE jobs SET status = 'failed', error_code = 'canceled', finished_at = 1 WHERE id = ?",
      )
      .run(s.jobId);
    const r = await manage("cleanup", s.installId, {
      parentJobId: s.jobId,
      signupId: s.signupId,
    });
    expect(r.error).toBeNull();
    expect(r.names.indexOf("parent_end")).toBe(r.names.indexOf("settle") + 1);
    expect(n.ends).toEqual([s.jobId, r.id]);
  });

  it("an end that keeps failing is logged and the job's outcome stands; unbound, no step", async () => {
    w.ctx.env.JOB_WAIT = {
      idFromName: (x: string) => x,
      get: () => ({
        changed: async () => {
          throw new Error("do reset");
        },
      }),
    } as unknown as DurableObjectNamespace<JobWait>;
    const a = create({ slug: "downco" });
    await a.run;
    expect(w.job(a.s.jobId)?.status).toBe("done");
    expect(
      (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((c) => String(c[0]))
        .join("\n"),
    ).toContain("provisioner job_end failed");
    w.ctx.env.JOB_WAIT = undefined;
    const b = create({ slug: "noneco" });
    await b.run;
    expect(b.log.map((l) => l.name)).not.toContain("job_end");
  });
});
