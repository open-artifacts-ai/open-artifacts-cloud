// JobWait on oa-<p>-provisioner (cloud #264, apps/provisioner/src/job-wait.ts):
// R15's held reads wait on it. Leo: "Everything should be event-based, push,
// never PULL (no waits, sleeps, polls)". The jobs this Worker ends (the
// sweep's dead run, the fleet halt's queued upgrades) are pushed here.

/** The provisioner's JobWait RPC, as this Worker sees it (structural). */
export interface JobWaitNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { changed(): Promise<number> };
}

/**
 * Tells JobWait each job changed (here: ended). Never throws: a lost push
 * only lets a held read run to its bound. Unbound, nothing.
 */
export async function jobsChanged(
  ns: JobWaitNamespace | undefined,
  jobIds: readonly string[],
): Promise<void> {
  if (ns === undefined) return;
  await Promise.all(
    jobIds.map(async (id) => {
      try {
        await ns.get(ns.idFromName(id)).changed();
      } catch {
        console.warn("provapi job_changed failed", id);
      }
    }),
  );
}
