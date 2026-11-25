// cloud #264: a failed release-chain run is rerun whole, at most twice, on its own.
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
      "contains(github.event.workflow_run.display_title, ' [')",
    ])
      expect(cond).toContain(c);
    // The one || only lets a chain-dispatched run (its id in the run-name) through.
    expect(cond.match(/\|\|/g)?.length).toBe(1);
  });

  it("backs off, then reruns the whole run with an App token narrowed to actions, and never checks out code", () => {
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
    expect(rerun?.run).toContain('gh run rerun "$RUN_ID" --repo "$REPO"');
    expect(rerun?.run).toMatch(/sleep 30; else sleep 120/);
    for (const s of steps) expect(s.run ?? "").not.toMatch(/--failed|--job/);
    expect(job["timeout-minutes"]).toBeGreaterThanOrEqual(3);
  });
});
