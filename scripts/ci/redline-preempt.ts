// A release gate never waits behind the nightly (cloud #264 step 2): the
// gate run's first job (redline-staging.yml `preempt`, a workflow_dispatch on
// main only) cancels every red-line nightly run still going, then waits for
// a few minutes for each to end (force-cancelling one that won't), then
// checks its R26 revoke: if it issued credentials and the revoke did not
// succeed, the gate revokes rl-a itself before its bring-up, so rl-a is never
// used in an unknown state, and the two never touch it at the same time. Only runs of
// .github/workflows/redline-nightly.yml on main in this repository, started
// by its cron or a dispatch, are ever selected: never a gate, a dry run, a
// fork's run or another branch's. The nightly's report job logs the
// preemption, and the release runs again on its next cron.
//   node --experimental-strip-types scripts/ci/redline-preempt.ts --repo owner/name --run <own run id>
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const NIGHTLY_FILE = "redline-nightly.yml";
export const NIGHTLY_PATH = `.github/workflows/${NIGHTLY_FILE}`;
const BUSY = ["queued", "in_progress", "waiting", "requested", "pending"];
const EVENTS = ["schedule", "workflow_dispatch"];
/** How long a cancelled nightly gets to end on its own (its always() steps). */
export const CANCEL_WAIT_MS = 2 * 60_000;
/** Then a force-cancel (no always() steps) gets this long; past it the gate fails. */
export const FORCE_WAIT_MS = 60_000;
export const POLL_MS = 5_000;

export type Step = {
  name: string;
  status?: string;
  conclusion?: string | null;
};
export type Job = { name: string; steps?: Step[] };

/**
 * Whether rl-a may be in an unknown state after a nightly ended: its redline
 * job issued credentials (its bring-up step started) and its R26 revoke did
 * not succeed (failed, skipped, cut off by a force-cancel, or never ran).
 * Then the gate revokes rl-a itself before its own bring-up.
 */
export function needsReset(jobs: readonly Job[]): boolean {
  const j = jobs.find((x) => /(^| \/ )redline$/.test(x.name));
  if (!j) return false;
  const step = (re: RegExp) => (j.steps ?? []).find((x) => re.test(x.name));
  const up = step(/^Upgrade rl-a/);
  const issued =
    up !== undefined &&
    up.conclusion !== "skipped" &&
    (up.status === "completed" || up.status === "in_progress");
  if (!issued) return false;
  return step(/^Revoke this run's R26 credentials$/)?.conclusion !== "success";
}

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;

export type Run = {
  id: number;
  status: string;
  path?: string;
  event?: string;
  head_branch?: string | null;
  head_repository?: { full_name?: string } | null;
};

/** The runs a gate may cancel: busy nightly runs on main of this repository, never its own. */
export function nightlyToCancel(
  runs: readonly Run[],
  o: { repo: string; ownRun: number },
): Run[] {
  return runs.filter(
    (r) =>
      r.id !== o.ownRun &&
      r.path === NIGHTLY_PATH &&
      r.head_branch === "main" &&
      r.head_repository?.full_name === o.repo &&
      EVENTS.includes(r.event ?? "") &&
      BUSY.includes(r.status),
  );
}

function gh(exec: Exec, args: string[]): string {
  const r = exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 3).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}

const statusOf = (exec: Exec, repo: string, id: number): string =>
  (JSON.parse(gh(exec, ["api", `repos/${repo}/actions/runs/${id}`])) as Run)
    .status;

/**
 * Cancels every nightly run nightlyToCancel selects, and waits a few minutes
 * at most: CANCEL_WAIT_MS for each to end on its own, then a force-cancel and
 * FORCE_WAIT_MS more; one still going then fails the gate (it would share
 * rl-a). Then reads each ended run's jobs: `reset` is true when one issued
 * credentials and its R26 revoke did not succeed (needsReset).
 */
export async function preempt(o: {
  exec: Exec;
  repo: string;
  ownRun: number;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
  log?: (s: string) => void;
}): Promise<{ cancelled: number[]; reset: boolean }> {
  const now = o.now ?? Date.now;
  const wait = o.wait ?? ((ms: number) => delay(ms));
  const log = o.log ?? ((s: string) => console.log(s));
  const runs = (
    JSON.parse(
      gh(o.exec, [
        "api",
        `repos/${o.repo}/actions/workflows/${NIGHTLY_FILE}/runs?branch=main&per_page=30`,
      ]),
    ) as { workflow_runs: Run[] }
  ).workflow_runs;
  const targets = nightlyToCancel(runs, o);
  if (!targets.length) {
    log("preempt: no red-line nightly is going");
    return { cancelled: [], reset: false };
  }
  const post = (id: number, what: "cancel" | "force-cancel") => {
    const r = o.exec("gh", [
      "api",
      "-X",
      "POST",
      `repos/${o.repo}/actions/runs/${id}/${what}`,
    ]);
    // 409: the run ended before the cancel reached it.
    if (r.code !== 0 && statusOf(o.exec, o.repo, id) !== "completed")
      throw new Error(
        `preempt: could not ${what} nightly run ${id}: ${r.stderr.trim() || `exit ${r.code}`}`,
      );
  };
  const ended = async (id: number, within: number): Promise<boolean> => {
    const end = now() + within;
    for (;;) {
      if (statusOf(o.exec, o.repo, id) === "completed") return true;
      if (now() >= end) return false;
      await wait(POLL_MS);
    }
  };
  for (const t of targets) {
    post(t.id, "cancel");
    log(`preempt: cancelled nightly run ${t.id} (${t.status})`);
  }
  let reset = false;
  for (const t of targets) {
    if (!(await ended(t.id, CANCEL_WAIT_MS))) {
      post(t.id, "force-cancel");
      log(
        `preempt: nightly run ${t.id} still going after ${CANCEL_WAIT_MS / 60_000} min: force-cancelled`,
      );
      if (!(await ended(t.id, FORCE_WAIT_MS)))
        throw new Error(
          `preempt: nightly run ${t.id} is still going after a force-cancel; not starting beside it on rl-a`,
        );
    }
    const jobs = (
      JSON.parse(
        gh(o.exec, [
          "api",
          `repos/${o.repo}/actions/runs/${t.id}/jobs?per_page=100`,
        ]),
      ) as { jobs: Job[] }
    ).jobs;
    if (needsReset(jobs)) {
      reset = true;
      log(
        `preempt: nightly run ${t.id} issued credentials and its rl-a revoke did not succeed: the gate revokes rl-a first`,
      );
    } else
      log(
        `preempt: nightly run ${t.id} has ended, rl-a revoked or never touched`,
      );
  }
  return { cancelled: targets.map((t) => t.id), reset };
}

const realExec: Exec = (cmd, args) => {
  try {
    return {
      code: 0,
      stdout: execFileSync(cmd, args, { encoding: "utf8" }),
      stderr: "",
    };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return {
      code: x.status ?? 1,
      stdout: String(x.stdout ?? ""),
      stderr: String(x.stderr ?? ""),
    };
  }
};

const flag = (argv: string[], name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? "" : (argv[i + 1] ?? "");
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const repo = flag(argv, "repo");
  const ownRun = Number(flag(argv, "run"));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(ownRun))
    throw new Error("usage: redline-preempt.ts --repo owner/name --run <id>");
  const r = await preempt({ exec: realExec, repo, ownRun });
  // The redline job reads it: a reset revokes rl-a before its bring-up.
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `reset=${r.reset}\n`);
}
