// A gate preempts the nightly: it cancels only busy nightly runs on main of
// this repository, and waits for them to end before it touches rl-a.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cancelNightly,
  checkPreempted,
  type Exec,
  type Job,
  NIGHTLY_PATH,
  needsReset,
  nightlyToCancel,
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

/** A fake gh: the run list, cancels, and each run's jobs. It has no clock: nothing here waits. */
const world = (o: {
  runs: Run[];
  cancelFails?: number[];
  jobs?: Record<number, Job[]>;
}) => {
  const calls: string[][] = [];
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
    const post = /\/actions\/runs\/(\d+)\/cancel$/.exec(path);
    if (post)
      return o.cancelFails?.includes(Number(post[1]))
        ? { code: 1, stdout: "", stderr: "HTTP 409" }
        : json({});
    const jobs = /\/actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path);
    if (jobs) return json({ jobs: o.jobs?.[Number(jobs[1])] ?? [] });
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

describe("cancelNightly and checkPreempted (no waits: GitHub's rl-a group does it)", () => {
  const quiet = { log: () => {} };

  it("cancels each busy nightly with one request, and returns their ids", () => {
    const w = world({
      runs: [
        nightly(1),
        nightly(2, { path: ".github/workflows/redline-staging.yml" }),
        nightly(3, { status: "completed" }),
      ],
    });
    expect(
      cancelNightly({ exec: w.exec, repo: REPO, ownRun: 9, ...quiet }),
    ).toEqual([1]);
    expect(w.calls.filter((a) => a.includes("POST"))).toEqual([
      ["api", "-X", "POST", `repos/${REPO}/actions/runs/1/cancel`],
    ]);
    // One list, one cancel: no status read, no loop.
    expect(w.calls).toHaveLength(2);
  });

  it("a run that takes no cancel (it just ended) is still returned, for the check", () => {
    const w = world({ runs: [nightly(1)], cancelFails: [1] });
    expect(
      cancelNightly({ exec: w.exec, repo: REPO, ownRun: 9, ...quiet }),
    ).toEqual([1]);
  });

  it("does nothing when no nightly is going", () => {
    const w = world({ runs: [] });
    expect(
      cancelNightly({ exec: w.exec, repo: REPO, ownRun: 9, ...quiet }),
    ).toEqual([]);
    expect(w.calls.some((a) => a.includes("POST"))).toBe(false);
  });

  it("the check reads each preempted run's jobs once: reset after a failed revoke, none after a clean one", () => {
    const w = world({
      runs: [],
      jobs: {
        1: [
          redlineJob([
            [UP, "completed", "cancelled"],
            [REVOKE, "completed", "success"],
          ]),
        ],
        2: [
          redlineJob([
            [UP, "completed", "success"],
            [REVOKE, "completed", "failure"],
          ]),
        ],
      },
    });
    expect(
      checkPreempted({ exec: w.exec, repo: REPO, runs: [1], ...quiet }),
    ).toBe(false);
    expect(
      checkPreempted({ exec: w.exec, repo: REPO, runs: [1, 2], ...quiet }),
    ).toBe(true);
    expect(
      checkPreempted({ exec: w.exec, repo: REPO, runs: [], ...quiet }),
    ).toBe(false);
    expect(w.calls).toHaveLength(3);
  });

  it("the script has no sleep, poll or wait at all (comments aside)", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "redline-preempt.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(
      /setTimeout|timers\/promises|delay\(|sleep|for \(;;\)|while \(/,
    );
  });
});
