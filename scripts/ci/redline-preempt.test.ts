// A gate preempts the nightly: it cancels only busy nightly runs on main of
// this repository, and waits for them to end before it touches rl-a.
import { describe, expect, it } from "vitest";
import {
  CANCEL_WAIT_MS,
  type Exec,
  FORCE_WAIT_MS,
  type Job,
  NIGHTLY_PATH,
  needsReset,
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

/** A fake gh: the run list, cancels and force-cancels, each run's status by call, and its jobs. */
const world = (o: {
  runs: Run[];
  statuses?: Record<number, string[]>;
  /** After a force-cancel, the run reads completed at once. */
  forceEnds?: boolean;
  cancelFails?: number[];
  jobs?: Record<number, Job[]>;
}) => {
  const calls: string[][] = [];
  const seen: Record<number, number> = {};
  const forced = new Set<number>();
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
    const post = /\/actions\/runs\/(\d+)\/(cancel|force-cancel)$/.exec(path);
    if (post) {
      const id = Number(post[1]);
      if (post[2] === "force-cancel") forced.add(id);
      return o.cancelFails?.includes(id)
        ? { code: 1, stdout: "", stderr: "HTTP 409" }
        : json({});
    }
    const jobs = /\/actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path);
    if (jobs) return json({ jobs: o.jobs?.[Number(jobs[1])] ?? [] });
    const one = /\/actions\/runs\/(\d+)$/.exec(path);
    if (one) {
      const id = Number(one[1]);
      if (forced.has(id) && o.forceEnds)
        return json({ id, status: "completed" });
      const list = o.statuses?.[id] ?? ["completed"];
      const i = Math.min(seen[id] ?? 0, list.length - 1);
      seen[id] = (seen[id] ?? 0) + 1;
      return json({ id, status: list[i] });
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { exec, calls };
};

const redlineJob = (steps: [string, string, string | null][]): Job => ({
  name: "redline / redline",
  steps: steps.map(([name, status, conclusion]) => ({
    name,
    status,
    conclusion,
  })),
});
const UP =
  "Upgrade rl-a (and rl-b in the nightly) to the tag (R5) and take this run's credentials (R26)";
const REVOKE = "Revoke this run's R26 credentials";

describe("needsReset", () => {
  it("only when credentials were issued and the revoke did not succeed", () => {
    expect(needsReset([])).toBe(false);
    expect(
      needsReset([
        redlineJob([
          [UP, "completed", "skipped"],
          [REVOKE, "completed", "success"],
        ]),
      ]),
    ).toBe(false);
    expect(needsReset([redlineJob([[UP, "queued", null]])])).toBe(false);
    expect(
      needsReset([
        redlineJob([
          [UP, "completed", "success"],
          [REVOKE, "completed", "success"],
        ]),
      ]),
    ).toBe(false);
    for (const rv of [
      [REVOKE, "completed", "failure"],
      [REVOKE, "completed", "cancelled"],
      [REVOKE, "completed", "skipped"],
      [REVOKE, "queued", null],
    ] as [string, string, string | null][])
      expect(
        needsReset([redlineJob([[UP, "completed", "cancelled"], rv])]),
        rv.join(" "),
      ).toBe(true);
    // Credentials issued and the run cut off before its revoke step at all.
    expect(needsReset([redlineJob([[UP, "in_progress", null]])])).toBe(true);
    // Only the redline job counts, not t19 or another.
    expect(
      needsReset([
        {
          name: "redline / t19",
          steps: [{ name: UP, status: "completed", conclusion: "success" }],
        },
      ]),
    ).toBe(false);
  });
});

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
  const quiet = { log: () => {} };

  it("does nothing when no nightly is going", async () => {
    const w = world({ runs: [nightly(1, { status: "completed" })] });
    expect(
      await preempt({ exec: w.exec, repo: REPO, ownRun: 9, ...quiet }),
    ).toEqual({ cancelled: [], reset: false });
    expect(w.calls.some((a) => a.includes("POST"))).toBe(false);
  });

  it("cancels the running nightly, waits for it, and needs no reset after a clean revoke", async () => {
    const w = world({
      runs: [
        nightly(1),
        nightly(2, { path: ".github/workflows/redline-staging.yml" }),
      ],
      statuses: { 1: ["in_progress", "in_progress", "completed"] },
      jobs: {
        1: [
          redlineJob([
            [UP, "completed", "cancelled"],
            [REVOKE, "completed", "success"],
          ]),
        ],
      },
    });
    const c = clock();
    expect(
      await preempt({ exec: w.exec, repo: REPO, ownRun: 9, ...c, ...quiet }),
    ).toEqual({ cancelled: [1], reset: false });
    expect(w.calls.filter((a) => a.includes("POST"))).toEqual([
      ["api", "-X", "POST", `repos/${REPO}/actions/runs/1/cancel`],
    ]);
    expect(c.at()).toBe(2 * POLL_MS);
  });

  it("a nightly that ended with a failed revoke asks for a reset of rl-a", async () => {
    const w = world({
      runs: [nightly(1)],
      jobs: {
        1: [
          redlineJob([
            [UP, "completed", "success"],
            [REVOKE, "completed", "failure"],
          ]),
        ],
      },
    });
    expect(
      await preempt({ exec: w.exec, repo: REPO, ownRun: 9, ...quiet }),
    ).toEqual({ cancelled: [1], reset: true });
  });

  it("one that won't end is force-cancelled after a few minutes; its revoke never ran, so rl-a is reset", async () => {
    const w = world({
      runs: [nightly(1)],
      statuses: { 1: ["in_progress"] },
      forceEnds: true,
      jobs: {
        1: [
          redlineJob([
            [UP, "completed", "success"],
            [REVOKE, "completed", "cancelled"],
          ]),
        ],
      },
    });
    const c = clock();
    expect(
      await preempt({ exec: w.exec, repo: REPO, ownRun: 9, ...c, ...quiet }),
    ).toEqual({ cancelled: [1], reset: true });
    expect(
      w.calls.filter((a) => a.includes("POST")).map((a) => a.at(-1)),
    ).toEqual([
      `repos/${REPO}/actions/runs/1/cancel`,
      `repos/${REPO}/actions/runs/1/force-cancel`,
    ]);
    expect(c.at()).toBeLessThanOrEqual(CANCEL_WAIT_MS + POLL_MS);
  });

  it("one still going after the force-cancel fails the gate, within a few minutes in all", async () => {
    const w = world({ runs: [nightly(1)], statuses: { 1: ["in_progress"] } });
    const c = clock();
    await expect(
      preempt({ exec: w.exec, repo: REPO, ownRun: 9, ...c, ...quiet }),
    ).rejects.toThrow(/still going after a force-cancel/);
    expect(c.at()).toBeLessThanOrEqual(
      CANCEL_WAIT_MS + FORCE_WAIT_MS + 2 * POLL_MS,
    );
    expect(CANCEL_WAIT_MS + FORCE_WAIT_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  it("a nightly that ended before the cancel reached it is fine", async () => {
    const w = world({ runs: [nightly(1)], cancelFails: [1] });
    expect(
      (await preempt({ exec: w.exec, repo: REPO, ownRun: 9, ...quiet }))
        .cancelled,
    ).toEqual([1]);
  });

  it("a cancel that fails on a run still going fails the gate", async () => {
    const w = world({
      runs: [nightly(1)],
      cancelFails: [1],
      statuses: { 1: ["in_progress"] },
    });
    await expect(
      preempt({ exec: w.exec, repo: REPO, ownRun: 9, ...quiet }),
    ).rejects.toThrow(/could not cancel nightly run 1/);
  });
});
