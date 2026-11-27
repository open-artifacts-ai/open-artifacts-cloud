// cloud #428: a red release gate is rerun once, whole, on its own.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const text = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../.github/workflows/redline-retry.yml",
  ),
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

describe("redline-retry", () => {
  it("runs only when redline-staging completes", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_run"]);
    expect(wf.on.workflow_run).toEqual({
      workflows: ["redline-staging"],
      types: ["completed"],
    });
    expect(wf.permissions).toEqual({});
  });

  it("retries only attempt 1 of a failed gate dispatched on main", () => {
    const cond = String(wf.jobs.retry.if);
    for (const c of [
      "github.event.workflow_run.conclusion == 'failure'",
      "github.event.workflow_run.run_attempt == 1",
      "github.event.workflow_run.event == 'workflow_dispatch'",
      "github.event.workflow_run.head_branch == 'main'",
    ])
      expect(cond).toContain(c);
    expect(cond).not.toMatch(/\|\|/);
  });

  it("reruns the whole run with an App token narrowed to actions, and never checks out code", () => {
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
    for (const s of steps) expect(s.run ?? "").not.toMatch(/--failed|--job/);
  });
});
