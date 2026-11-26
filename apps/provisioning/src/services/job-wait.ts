// R15's held read (cloud #264): GET /jobs/:jobId?wait=<ms> holds an open
// job's read on its JobWait object (oa-<p>-provisioner, apps/provisioner/
// src/job-wait.ts) until a job end releases it or the wait runs out. Leo:
// "Everything should be event-based, push, never PULL (no waits, sleeps,
// polls)". This file is the API's side: the query, the hold and the end.
import { z } from "zod";

/** The longest hold; the provisioner's JOB_WAIT_MAX_MS. */
export const JOB_WAIT_MAX_MS = 25_000;

/**
 * R15's own query, beside the contract's (which takes none): `wait`, whole
 * milliseconds, 0 to any size; more than JOB_WAIT_MAX_MS holds that long.
 * Anything else (`wait=invalid`, -1, 1.5) is a 400 invalid_input, which is
 * how a caller knows this server holds: one that doesn't drops the key.
 */
export const R15_QUERY = z.object({
  wait: z
    .string()
    .regex(/^\d{1,9}$/)
    .transform((v) => Math.min(Number(v), JOB_WAIT_MAX_MS))
    .optional(),
});

/** The provisioner's JobWait RPC, as this Worker sees it (structural). */
export interface JobWaitStub {
  hold(jobId: string, ms: number): Promise<boolean>;
  end(): Promise<number>;
}
export interface JobWaitNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): JobWaitStub;
}

const stub = (ns: JobWaitNamespace, jobId: string) =>
  ns.get(ns.idFromName(jobId));

/**
 * Holds until the job ends or `ms` passes. Unbound, or a failed call (the
 * object reset by a deploy), answers at once: the read then returns the
 * job as it is, never an error.
 */
export async function holdJob(
  env: { JOB_WAIT?: JobWaitNamespace },
  jobId: string,
  ms: number,
): Promise<void> {
  if (!env.JOB_WAIT || ms <= 0) return;
  try {
    await stub(env.JOB_WAIT, jobId).hold(jobId, ms);
  } catch {}
}

/** The job ended here (R25 cancel): releases its held reads. Never throws. */
export async function endJob(
  env: { JOB_WAIT?: JobWaitNamespace },
  jobId: string,
): Promise<void> {
  if (!env.JOB_WAIT) return;
  try {
    await stub(env.JOB_WAIT, jobId).end();
  } catch {
    console.warn("provisioning job_end failed", jobId);
  }
}
