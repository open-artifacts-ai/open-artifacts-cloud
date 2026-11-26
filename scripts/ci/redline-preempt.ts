// A release gate never waits behind the nightly (cloud #264 step 2), and no
// code here sleeps or polls (Leo, 2026-11-26 11:45Z: "the code itself should
// have no sleeps or polls"). GitHub does the waiting: the gate's redline job
// and the nightly's share the rl-a job concurrency group, and a gate's entry
// cancels the nightly's job in progress (cancel-in-progress only for a gate;
// gates themselves queue one at a time on the workflow's `redline` group, so
// it can't meet another gate there). The group frees only once the cancelled
// job has ended, its always() R26 revoke included.
//   cancel: the gate's `preempt` job cancels every busy red-line nightly run
//     (one request each), so its T19 job stops too. Never a gate, a dry run,
//     another branch's or a fork's run. It waits for nothing.
//   check: the gate's `rl-a-check` job, once it holds rl-a (the cancelled
//     nightly's job has ended), reads those runs' jobs once: reset=true when
//     one issued credentials and its R26 revoke did not succeed. Then the
//     redline job revokes rl-a before its bring-up.
//   node --experimental-strip-types scripts/ci/redline-preempt.ts cancel --repo owner/name --run <own run id>
//   node --experimental-strip-types scripts/ci/redline-preempt.ts check --repo owner/name --runs <id,id>
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const NIGHTLY_FILE = "redline-nightly.yml";
export const NIGHTLY_PATH = `.github/workflows/${NIGHTLY_FILE}`;
const BUSY = ["queued", "in_progress", "waiting", "requested", "pending"];
const EVENTS = ["schedule", "workflow_dispatch"];
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

/** Cancels every nightly run nightlyToCancel selects, one request each, and returns their ids. It waits for nothing. */
export function cancelNightly(o: {
  exec: Exec;
  repo: string;
  ownRun: number;
  log?: (s: string) => void;
}): number[] {
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
  if (!targets.length) log("preempt: no red-line nightly is going");
  for (const t of targets) {
    const r = o.exec("gh", [
      "api",
      "-X",
      "POST",
      `repos/${o.repo}/actions/runs/${t.id}/cancel`,
    ]);
    // 409: the run ended before the cancel reached it; either way GitHub's
    // rl-a group holds the gate until that run's redline job has ended.
    log(
      r.code === 0
        ? `preempt: cancelled nightly run ${t.id} (${t.status})`
        : `preempt: nightly run ${t.id} took no cancel (${r.stderr.trim() || `exit ${r.code}`}); the rl-a group still waits for it`,
    );
  }
  return targets.map((t) => t.id);
}

/** One read of each preempted run's jobs (they have ended: the gate holds rl-a): whether rl-a needs a reset. */
export function checkPreempted(o: {
  exec: Exec;
  repo: string;
  runs: readonly number[];
  log?: (s: string) => void;
}): boolean {
  const log = o.log ?? ((s: string) => console.log(s));
  let reset = false;
  for (const id of o.runs) {
    const jobs = (
      JSON.parse(
        gh(o.exec, [
          "api",
          `repos/${o.repo}/actions/runs/${id}/jobs?per_page=100`,
        ]),
      ) as { jobs: Job[] }
    ).jobs;
    if (needsReset(jobs)) {
      reset = true;
      log(
        `preempt: nightly run ${id} issued credentials and its rl-a revoke did not succeed: the gate revokes rl-a first`,
      );
    } else log(`preempt: nightly run ${id}: rl-a revoked or never touched`);
  }
  return reset;
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
  const [cmd, ...argv] = process.argv.slice(2);
  const repo = flag(argv, "repo");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error(
      "usage: redline-preempt.ts <cancel|check> --repo owner/name ...",
    );
  const out = (line: string) => {
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  };
  if (cmd === "cancel") {
    const ownRun = Number(flag(argv, "run"));
    if (!Number.isInteger(ownRun))
      throw new Error("cancel: --run <own run id>");
    out(`runs=${cancelNightly({ exec: realExec, repo, ownRun }).join(",")}`);
  } else if (cmd === "check") {
    const raw = flag(argv, "runs");
    if (!/^(\d+(,\d+)*)?$/.test(raw)) throw new Error("check: --runs <id,id>");
    const runs = raw ? raw.split(",").map(Number) : [];
    out(`reset=${checkPreempted({ exec: realExec, repo, runs })}`);
  } else throw new Error("usage: redline-preempt.ts <cancel|check> ...");
}
