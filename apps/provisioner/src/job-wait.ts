// JobWait (cloud #264): the push behind R15's held read, GET /jobs/:jobId
// ?wait=<ms>. Leo: "Everything should be event-based, push, never PULL (no
// waits, sleeps, polls)". One object per job (idFromName(jobId)). The API
// holds a read on `hold`; whoever changes what a waiter waits for calls
// `changed`, which releases every held read at once. The changes pushed:
// the job's end (this Worker's Workflows, the API's cancel, the scheduler's
// sweep and fleet halt), a failed attempt it records (last_error_code) and
// its sealed result. The only timer is the held request's own bound.
import { DurableObject, type WorkflowStep } from "cloudflare:workers";

/** R15's longest hold: under the 30 s an API client waits for an answer. */
export const JOB_WAIT_MAX_MS = 25_000;

/** What the API and the Workflows call; the binding's RPC surface. */
export interface JobWaitRpc {
  /**
   * Held until the job changes or `ms` passes: true on a change. `seen` is
   * the job's updated_at the caller read (null: only its end counts).
   */
  hold(jobId: string, ms: number, seen?: number | null): Promise<boolean>;
  /** The job changed: releases every held read; the count released. */
  changed(): Promise<number>;
}

/** A timer the tests can drive (a fake clock); the runtime's by default. */
export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}
const RUNTIME_TIMER: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * The held reads of one object. A hold registers first, then asks
 * `changed`: a change made before the hold was registered is seen by that
 * read, and one made after it by `release`, so none is missed in between.
 */
export class Holds {
  private readonly open = new Set<(ended: boolean) => void>();
  constructor(private readonly timer: Timer = RUNTIME_TIMER) {}

  get size(): number {
    return this.open.size;
  }

  hold(ms: number, changed: () => Promise<boolean>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let h: unknown;
      const settle = (v: boolean) => {
        if (!this.open.delete(settle)) return;
        this.timer.clear(h);
        resolve(v);
      };
      this.open.add(settle);
      h = this.timer.set(() => settle(false), ms);
      // A failed read leaves the hold to `release` or its bound.
      changed().then(
        (e) => {
          if (e) settle(true);
        },
        () => {},
      );
    });
  }

  release(): number {
    const all = [...this.open];
    for (const s of all) s(true);
    return all.length;
  }
}

/** The bound a hold runs to: an integer 0 to JOB_WAIT_MAX_MS. */
export const holdMs = (ms: number): number =>
  Number.isFinite(ms)
    ? Math.min(Math.max(0, Math.floor(ms)), JOB_WAIT_MAX_MS)
    : 0;

const ROW = "SELECT status, updated_at FROM jobs WHERE id = ?";

export class JobWait
  extends DurableObject<{ PLATFORM_DB: D1Database }>
  implements JobWaitRpc
{
  /** Protected so a test can give it a fake clock. */
  protected holds = new Holds();

  async hold(
    jobId: string,
    ms: number,
    seen: number | null = null,
  ): Promise<boolean> {
    return this.holds.hold(holdMs(ms), async () => {
      const r = await this.env.PLATFORM_DB.prepare(ROW)
        .bind(jobId)
        .first<{ status: string; updated_at: number }>();
      if (!r) return true;
      if (r.status === "done" || r.status === "failed") return true;
      return seen !== null && r.updated_at !== seen;
    });
  }

  async changed(): Promise<number> {
    return this.holds.release();
  }
}

/** The end's own step: a short retry; a call that still fails is logged. */
export const JOB_END_STEP = {
  retries: { limit: 2, delay: "1 second", backoff: "exponential" },
  timeout: "10 seconds",
} as const;

/**
 * Tells JobWait the job ended, as the step `job_end` (or `<name>`). Never
 * throws: a lost end only lets a held read run to its bound, and the job's
 * outcome stands. Unbound (a config from before it), no step.
 */
export async function jobEnded(
  env: { JOB_WAIT?: DurableObjectNamespace<JobWait> },
  step: WorkflowStep,
  jobId: string,
  name = "job_end",
): Promise<void> {
  const ns = env.JOB_WAIT;
  if (ns === undefined) return;
  try {
    await step.do(name, JOB_END_STEP, async () => ({
      released: await ns.get(ns.idFromName(jobId)).changed(),
    }));
  } catch {
    console.warn("provisioner job_end failed", jobId);
  }
}

/**
 * Tells JobWait the job changed, from inside a step (a failed attempt
 * recorded, the sealed result written): no step of its own, so a replay
 * never repeats it. Never throws; unbound, nothing.
 */
export async function jobChanged(
  env: { JOB_WAIT?: DurableObjectNamespace<JobWait> },
  jobId: string,
): Promise<void> {
  const ns = env.JOB_WAIT;
  if (ns === undefined) return;
  try {
    await ns.get(ns.idFromName(jobId)).changed();
  } catch {
    console.warn("provisioner job_changed failed", jobId);
  }
}
