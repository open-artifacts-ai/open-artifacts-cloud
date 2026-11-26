import { TEST_MEMBER } from "@oa/provisioning-contract";
import { desc, ProbeFail, type Run } from "./provisioning.ts";

// The agents' staging install, rl-agents (docs/ops/hosted.md, "Staging test
// member for agents"), kept on the release under test (cloud #264, public
// #3167). The fleet never upgrades an install with test hooks on
// (apps/scheduler/src/provapi/fleet.ts ELIGIBLE), so without this it stays on
// whatever release it was made at. Each red-line gate run asks for one R5
// upgrade with red-line's own OIDC scope (rl- slugs with test hooks) and
// takes the API's 202 as the answer: it never waits for the job, so a slow or
// failed upgrade never holds or fails the gate, and the next gate run tries
// again. The workflow runs it as the gate job's last step, once the whole
// gate passed, bounded at 30 s (redline-staging.yml, step rl-agents).

/** The one install this touches: the test member's, by its exact slug. */
export const RL_AGENTS_SLUG = TEST_MEMBER.slug;

/** Staging only, as the sweep and the purge: any other API origin throws. */
const STAGING_API = /(^|\.)open-artifacts-staging\.app$/;

export type RlAgentsOutcome =
  | { kind: "started"; from: string | null; to: string; jobId: string }
  | { kind: "current"; to: string }
  | { kind: "skipped"; to: string; reason: string }
  | { kind: "failed"; to: string; reason: string };

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE = /[^A-Za-z0-9 .,:;()_+/=@-]/g;
/** A reason as one short line of plain characters (ProbeFail texts are already a status and a code). */
const clean = (s: string) => s.replace(SAFE, " ").slice(0, 200);

const cmp = (a: string, b: string): number => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let k = 0; k < 3; k++) {
    const d = (x?.[k] ?? 0) - (y?.[k] ?? 0);
    if (d) return d;
  }
  return 0;
};

/**
 * Asks once for rl-agents on `run.c.version`: R2 by slug, R3, then R5 when it
 * is behind and idle. Never throws: every problem is an outcome.
 */
export async function upgradeRlAgents(run: Run): Promise<RlAgentsOutcome> {
  const to = run.c.version;
  try {
    if (!STAGING_API.test(new URL(run.c.api).hostname))
      throw new ProbeFail("the rl-agents upgrade runs on staging only");
    if (!VERSION.test(to)) throw new ProbeFail("the release is not X.Y.Z");
    const l = await run.v1(
      `/installs?${new URLSearchParams({ q: RL_AGENTS_SLUG })}`,
    );
    if (l.status !== 200) throw new ProbeFail(`R2: ${desc(l)}`);
    const rows = (
      (
        l.json as {
          items?: { id?: unknown; slug?: unknown; state?: unknown }[];
        }
      )?.items ?? []
    ).filter(
      (i) =>
        i.slug === RL_AGENTS_SLUG &&
        typeof i.id === "string" &&
        !["deleted", "deleting"].includes(String(i.state)),
    );
    if (rows.length === 0)
      return { kind: "skipped", to, reason: "no live rl-agents install" };
    if (rows.length > 1)
      throw new ProbeFail(`R2: ${rows.length} live rl-agents rows`);
    const id = rows[0]?.id as string;
    const d = await run.v1(`/installs/${encodeURIComponent(id)}`);
    if (d.status !== 200) throw new ProbeFail(`R3: ${desc(d)}`);
    const i = d.json as {
      slug?: unknown;
      state?: unknown;
      version?: unknown;
      testHooks?: unknown;
      activeJobId?: unknown;
    };
    if (i.slug !== RL_AGENTS_SLUG)
      throw new ProbeFail("R3: the row is not rl-agents");
    if (i.testHooks !== true)
      return { kind: "skipped", to, reason: "rl-agents has test hooks off" };
    const from =
      typeof i.version === "string" && VERSION.test(i.version)
        ? i.version
        : null;
    if (from === to) return { kind: "current", to };
    if (from && cmp(from, to) > 0)
      return { kind: "skipped", to, reason: `rl-agents runs ${from}, newer` };
    if (i.state !== "active")
      return {
        kind: "skipped",
        to,
        reason: `rl-agents is ${clean(String(i.state))}, not active`,
      };
    if (i.activeJobId)
      return { kind: "skipped", to, reason: "rl-agents has a job running" };
    const r = await run.v1(`/installs/${encodeURIComponent(id)}/upgrade`, {
      // As rl-a and rl-b (bringUpgrade): rl-agents holds test data only, so
      // it crosses a held migration rather than stay behind.
      body: {
        requestId: run.rid("up-rl-agents"),
        version: to,
        nonAdditive: true,
      },
    });
    // The 202 is the answer. The job is never awaited (no polling).
    if (r.status !== 202) throw new ProbeFail(`R5: ${desc(r)}`);
    const jobId = (r.json as { job?: { id?: unknown } })?.job?.id;
    if (typeof jobId !== "string" || !JOB_ID.test(jobId))
      throw new ProbeFail("R5: 202 without a job id");
    return { kind: "started", from, to, jobId };
  } catch (e) {
    return {
      kind: "failed",
      to,
      reason: clean(e instanceof Error ? e.message : String(e)),
    };
  }
}

/** The job summary's one line for an outcome. */
export function rlAgentsLine(o: RlAgentsOutcome, app: string): string {
  const head = `rl-agents (${app})`;
  switch (o.kind) {
    case "started":
      return `${head}: upgrade from ${o.from ?? "an unknown release"} to ${o.to} started, job ${o.jobId}. The gate does not wait for it.`;
    case "current":
      return `${head}: already on ${o.to}.`;
    case "skipped":
      return `${head}: not upgraded to ${o.to}: ${o.reason}.`;
    case "failed":
      return `${head}: the upgrade to ${o.to} could not start (${o.reason}). It never fails the gate; the next gate run tries again.`;
  }
}

/** rl-agents' public address on staging. */
export const RL_AGENTS_APP = `https://${RL_AGENTS_SLUG}.open-artifacts-staging.app`;
