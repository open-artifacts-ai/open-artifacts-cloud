// cloud #264: a failed release-chain run has its failed jobs rerun, at most twice, one layer only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const dir = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(
  join(dir, "../../.github/workflows/release-retry.yml"),
  "utf8",
);
const wf = parse(text);
type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};
const CHAIN = [
  "hosted-release",
  "hosted-publish",
  "staging-release-chain",
  "deploy-hosted-platform",
  "prod-release-chain",
];

describe("release-retry", () => {
  it("runs when any release-chain workflow completes", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_run"]);
    expect(wf.on.workflow_run).toEqual({
      workflows: CHAIN,
      types: ["completed"],
    });
    expect(wf.permissions).toEqual({});
  });

  it("each named workflow exists under that name, and redline-staging is left to redline-retry", () => {
    for (const name of CHAIN) {
      const own = parse(
        readFileSync(join(dir, `../../.github/workflows/${name}.yml`), "utf8"),
      );
      expect(own.name, name).toBe(name);
    }
    expect(wf.on.workflow_run.workflows).not.toContain("redline-staging");
  });

  it("retries only failed attempts 1 and 2 on main, never a dry run or a hand dispatch", () => {
    const cond = String(wf.jobs.retry.if);
    for (const c of [
      "github.event.workflow_run.conclusion == 'failure'",
      "github.event.workflow_run.run_attempt <= 2",
      "github.event.workflow_run.head_branch == 'main'",
      "!contains(github.event.workflow_run.display_title, '(dry run)')",
      "github.event.workflow_run.event != 'workflow_dispatch'",
      "contains(github.event.workflow_run.display_title, ' [sc')",
    ])
      expect(cond).toContain(c);
    // The one || only lets a staging-chain deploy (" [sc..]") through.
    expect(cond.match(/\|\|/g)?.length).toBe(1);
  });

  // Mirrors the job's condition for the cases that matter (GitHub's contains()
  // is a case-insensitive substring test).
  const retried = (r: {
    conclusion: string;
    attempt: number;
    event: string;
    title: string;
    branch?: string;
  }) =>
    r.conclusion === "failure" &&
    r.attempt <= 2 &&
    (r.branch ?? "main") === "main" &&
    !r.title.toLowerCase().includes("(dry run)") &&
    (r.event !== "workflow_dispatch" || r.title.toLowerCase().includes(" [sc"));
  const fail = { conclusion: "failure", attempt: 1 };

  it("a chain-id deploy or publish under a waiting prod chain is not retried; the chain is", () => {
    expect(
      retried({
        ...fail,
        event: "workflow_dispatch",
        title: "deploy-hosted-platform prod v0.246.1 [c45669888802-1]",
      }),
    ).toBe(false);
    expect(
      retried({
        ...fail,
        event: "workflow_dispatch",
        title: "hosted-publish prod v0.246.1 [p45669888802-1]",
      }),
    ).toBe(false);
    expect(
      retried({ ...fail, event: "workflow_run", title: "prod-release-chain" }),
    ).toBe(true);
  });

  it("a staging-chain deploy is retried, since staging-release-chain waits for nothing", () => {
    expect(
      retried({
        ...fail,
        event: "workflow_dispatch",
        title: "deploy-hosted-platform staging v0.246.1 [sc45693158538-1]",
      }),
    ).toBe(true);
    expect(
      retried({
        ...fail,
        event: "workflow_dispatch",
        title: "deploy-hosted-platform staging v0.246.1",
      }),
    ).toBe(false);
    expect(
      retried({
        ...fail,
        event: "workflow_dispatch",
        title: "hosted-release (dry run)",
      }),
    ).toBe(false);
    expect(retried({ ...fail, event: "push", title: "hosted-release" })).toBe(
      true,
    );
    expect(
      retried({ ...fail, attempt: 3, event: "push", title: "hosted-release" }),
    ).toBe(false);
  });

  it("the prod chain waits on its children, so they are its to redo", () => {
    const chain = readFileSync(
      join(dir, "../../.github/workflows/prod-release-chain.yml"),
      "utf8",
    );
    expect(chain).toContain("Dispatch the prod deploy and wait for its run");
    expect(chain).toContain("Dispatch the prod publish and wait for its run");
  });

  it("backs off, then reruns only the failed jobs with an App token narrowed to actions, and never checks out code", () => {
    const job = wf.jobs.retry;
    expect(job.environment).toBe("release-app");
    expect(job.permissions).toEqual({ issues: "write" });
    const steps = job.steps as Step[];
    expect(steps.some((s) => s.uses?.startsWith("actions/checkout@"))).toBe(
      false,
    );
    const app = steps.find((s) => s.id === "app");
    expect(app?.uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}/);
    const perms = Object.keys(app?.with ?? {}).filter((k) =>
      k.startsWith("permission-"),
    );
    expect(perms).toEqual(["permission-actions"]);
    expect(app?.with?.["permission-actions"]).toBe("write");
    const rerun = steps.find((s) => s.run?.includes("gh run rerun"));
    expect(rerun?.env?.GH_TOKEN).toBe("${{ steps.app.outputs.token }}");
    expect(rerun?.run).toContain(
      'gh run rerun "$RUN_ID" --failed --repo "$REPO"',
    );
    expect(rerun?.run).toMatch(/sleep 30; else sleep 120/);
    for (const s of steps) expect(s.run ?? "").not.toMatch(/--job/);
    expect(job["timeout-minutes"]).toBeGreaterThanOrEqual(3);
  });
});
