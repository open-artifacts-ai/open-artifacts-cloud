// A gate preempts the nightly: it cancels only busy nightly runs on main of
// this repository, and waits for them to end before it touches rl-a.
import { describe, expect, it } from "vitest";
import {
  type Exec,
  NIGHTLY_PATH,
  nightlyToCancel,
  POLL_MS,
  preempt,
  type Run,
} from "./redline-preempt.ts";

const REPO = "open-artifacts-ai/open-artifacts-cloud";
const nightly = (id: number, o: Partial<Run> = {}): Run => ({
  id,
  status: "in_progress",
  path: NIGHTLY_PATH,
  event: "schedule",
  head_branch: "main",
  head_repository: { full_name: REPO },
  ...o,
});

describe("nightlyToCancel", () => {
  it("selects busy nightly runs on main, by cron or dispatch", () => {
    const runs = [
      nightly(1),
      nightly(2, { event: "workflow_dispatch", status: "queued" }),
      nightly(3, { status: "waiting" }),
    ];
    expect(
      nightlyToCancel(runs, { repo: REPO, ownRun: 99 }).map((r) => r.id),
    ).toEqual([1, 2, 3]);
  });

  it("never selects a gate, a dry run, another branch, a fork, its own run or a finished one", () => {
    const runs = [
      nightly(1, { path: ".github/workflows/redline-staging.yml" }),
      nightly(2, { path: ".github/workflows/t19-dry-run.yml" }),
      nightly(3, { head_branch: "pl/x" }),
      nightly(4, {
        head_repository: { full_name: "someone/open-artifacts-cloud" },
      }),
      nightly(5, { head_repository: null }),
      nightly(6, { event: "pull_request" }),
      nightly(7, { status: "completed" }),
      nightly(99),
    ];
    expect(nightlyToCancel(runs, { repo: REPO, ownRun: 99 })).toEqual([]);
  });
});

/** A fake gh: the run list, cancels, and each run's status by call. */
const world = (o: {
  runs: Run[];
  statuses?: Record<number, string[]>;
  cancelFails?: number[];
}) => {
  const calls: string[][] = [];
  const seen: Record<number, number> = {};
  const exec: Exec = (_c, args) => {
    calls.push(args);
    const json = (v: unknown) => ({
      code: 0,
      stdout: JSON.stringify(v),
      stderr: "",
    });
    const path = args.at(-1) ?? "";
    if (
      path.includes("/actions/workflows/redline-nightly.yml/runs?branch=main")
    )
      return json({ workflow_runs: o.runs });
    const cancel = /\/actions\/runs\/(\d+)\/cancel$/.exec(path);
    if (cancel) {
      const id = Number(cancel[1]);
      return o.cancelFails?.includes(id)
        ? { code: 1, stdout: "", stderr: "HTTP 409" }
        : json({});
    }
    const one = /\/actions\/runs\/(\d+)$/.exec(path);
    if (one) {
      const id = Number(one[1]);
      const list = o.statuses?.[id] ?? ["completed"];
      const i = Math.min(seen[id] ?? 0, list.length - 1);
      seen[id] = (seen[id] ?? 0) + 1;
      return json({ id, status: list[i] });
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { exec, calls };
};

describe("preempt", () => {
  const clock = () => {
    let t = 0;
    return {
      now: () => t,
      wait: async (ms: number) => {
        t += ms;
      },
      at: () => t,
    };
  };

  it("does nothing when no nightly is going", async () => {
    const w = world({ runs: [nightly(1, { status: "completed" })] });
    expect(
      await preempt({ exec: w.exec, repo: REPO, ownRun: 9, log: () => {} }),
    ).toEqual([]);
    expect(w.calls.some((a) => a.includes("POST"))).toBe(false);
  });

  it("cancels the running nightly, then waits for it to end before returning", async () => {
    const w = world({
      runs: [
        nightly(1),
        nightly(2, { path: ".github/workflows/redline-staging.yml" }),
      ],
      statuses: { 1: ["in_progress", "in_progress", "completed"] },
    });
    const c = clock();
    expect(
      await preempt({
        exec: w.exec,
        repo: REPO,
        ownRun: 9,
        ...c,
        log: () => {},
      }),
    ).toEqual([1]);
    const posts = w.calls.filter((a) => a.includes("POST"));
    expect(posts).toEqual([
      ["api", "-X", "POST", `repos/${REPO}/actions/runs/1/cancel`],
    ]);
    expect(c.at()).toBe(2 * POLL_MS);
  });

  it("a nightly that ended before the cancel reached it is fine", async () => {
    const w = world({ runs: [nightly(1)], cancelFails: [1] });
    expect(
      await preempt({ exec: w.exec, repo: REPO, ownRun: 9, log: () => {} }),
    ).toEqual([1]);
  });

  it("a cancel that fails on a run still going fails the gate", async () => {
    const w = world({
      runs: [nightly(1)],
      cancelFails: [1],
      statuses: { 1: ["in_progress"] },
    });
    await expect(
      preempt({ exec: w.exec, repo: REPO, ownRun: 9, log: () => {} }),
    ).rejects.toThrow(/could not cancel nightly run 1/);
  });

  it("a nightly still going at the bound fails the gate: never beside it on rl-a", async () => {
    const w = world({ runs: [nightly(1)], statuses: { 1: ["in_progress"] } });
    const c = clock();
    await expect(
      preempt({
        exec: w.exec,
        repo: REPO,
        ownRun: 9,
        within: 60_000,
        ...c,
        log: () => {},
      }),
    ).rejects.toThrow(/still going/);
    expect(c.at()).toBeGreaterThanOrEqual(60_000);
  });
});
