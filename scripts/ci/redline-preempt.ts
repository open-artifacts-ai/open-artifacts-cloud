// A release gate never waits behind the nightly (cloud #264 step 2): the
// gate run's first job (redline-staging.yml `preempt`, a workflow_dispatch on
// main only) cancels every red-line nightly run still going, then waits for
// each to end, its always() steps included (the R26 revoke rotates rl-a's
// hook key), so the two never touch rl-a at the same time. Only runs of
// .github/workflows/redline-nightly.yml on main in this repository, started
// by its cron or a dispatch, are ever selected: never a gate, a dry run, a
// fork's run or another branch's. The nightly's report job logs the
// preemption, and the release runs again on its next cron.
//   node --experimental-strip-types scripts/ci/redline-preempt.ts --repo owner/name --run <own run id>
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const NIGHTLY_FILE = "redline-nightly.yml";
export const NIGHTLY_PATH = `.github/workflows/${NIGHTLY_FILE}`;
const BUSY = ["queued", "in_progress", "waiting", "requested", "pending"];
const EVENTS = ["schedule", "workflow_dispatch"];
/** The nightly's cleanup after a cancel (the R26 revoke, up to 40 min) fits in this. */
export const PREEMPT_WAIT_MS = 45 * 60_000;
export const POLL_MS = 10_000;

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
 * Cancels every nightly run nightlyToCancel selects and waits until each has
 * completed, up to `within`. A run that ends before the cancel reaches it is
 * fine; one still going at the bound fails the gate: it would share rl-a.
 */
export async function preempt(o: {
  exec: Exec;
  repo: string;
  ownRun: number;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
  within?: number;
  log?: (s: string) => void;
}): Promise<number[]> {
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
    return [];
  }
  for (const t of targets) {
    const r = o.exec("gh", [
      "api",
      "-X",
      "POST",
      `repos/${o.repo}/actions/runs/${t.id}/cancel`,
    ]);
    // 409: the run ended before the cancel reached it.
    if (r.code !== 0 && statusOf(o.exec, o.repo, t.id) !== "completed")
      throw new Error(
        `preempt: could not cancel nightly run ${t.id}: ${r.stderr.trim() || `exit ${r.code}`}`,
      );
    log(`preempt: cancelled nightly run ${t.id} (${t.status})`);
  }
  const end = now() + (o.within ?? PREEMPT_WAIT_MS);
  for (const t of targets) {
    for (;;) {
      if (statusOf(o.exec, o.repo, t.id) === "completed") break;
      if (now() >= end)
        throw new Error(
          `preempt: nightly run ${t.id} is still going ${Math.round((o.within ?? PREEMPT_WAIT_MS) / 60_000)} min after the cancel; not starting beside it on rl-a`,
        );
      await wait(POLL_MS);
    }
    log(`preempt: nightly run ${t.id} has ended`);
  }
  return targets.map((t) => t.id);
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
  await preempt({ exec: realExec, repo, ownRun });
}
