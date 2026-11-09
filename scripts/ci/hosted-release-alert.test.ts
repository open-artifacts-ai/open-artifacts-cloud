// #1782: a failed hosted-release run keeps one open `blocker` issue.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const wf = (name: string): any => parse(read(`.github/workflows/${name}`));
const triggers = (w: { on: Record<string, unknown> }) => Object.keys(w.on);

describe("hosted-release-alert.yml", () => {
  const w = wf("hosted-release-alert.yml");
  const raw = read(".github/workflows/hosted-release-alert.yml");
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  const steps: any[] = w.jobs.report.steps;
  const step = steps[0];

  it("watches hosted-release on main, completed runs only", () => {
    expect(triggers(w)).toEqual(["workflow_run"]);
    expect(w.on.workflow_run.workflows).toEqual(["hosted-release"]);
    expect(w.on.workflow_run.types).toEqual(["completed"]);
    expect(w.on.workflow_run.branches).toEqual(["main"]);
  });
  it("grants nothing at the top and only issues: write to its one job", () => {
    expect(w.permissions).toEqual({});
    expect(Object.keys(w.jobs)).toEqual(["report"]);
    expect(w.jobs.report.permissions).toEqual({ issues: "write" });
  });
  it("has no checkout, install or secret but the default token", () => {
    expect(steps).toHaveLength(1);
    expect(JSON.stringify(steps)).not.toMatch(/uses|checkout/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(step.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(raw).not.toMatch(/secrets\./);
  });
  it("never interpolates an expression into the script", () => {
    expect(step.run).not.toContain("${{");
    for (const k of ["CONCLUSION", "RUN", "SHA", "DISPLAY_TITLE"])
      expect(step.env[k]).toMatch(/^\$\{\{ github\.event\.workflow_run\./);
  });
  it("serializes completions without cancelling a running one", () => {
    expect(w.concurrency).toEqual({
      group: "hosted-release-alert",
      "cancel-in-progress": false,
    });
  });

  const GH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
if [ "$1 $2" = "issue list" ]; then [ -z "$STUB_FAIL" ] || exit 1; printf '%s' "$STUB_ISSUES"; fi
`;
  const TITLE = "hosted-release failed";
  const issue = (number: number, title = TITLE) => ({ number, title });
  const alert = (
    conclusion: string,
    issues: unknown[] = [],
    title = "hosted-release",
    fail = false,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "ra-"));
    writeFileSync(join(dir, "gh"), GH, { mode: 0o755 });
    const r = spawnSync("bash", ["-c", step.run], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        STUB_LOG: join(dir, "log"),
        STUB_ISSUES: JSON.stringify(issues),
        STUB_FAIL: fail ? "1" : "",
        GH_TOKEN: "t",
        REPO: "o/r",
        TITLE: step.env.TITLE,
        CONCLUSION: conclusion,
        RUN: "https://github.com/o/r/actions/runs/1",
        SHA: "a".repeat(40),
        DISPLAY_TITLE: title,
      },
    });
    let calls: string[] = [];
    try {
      calls = readFileSync(join(dir, "log"), "utf8").trim().split("\n");
    } catch {}
    const writes = calls.filter((c) => !c.startsWith("issue list"));
    return { code: r.status, calls, writes, out: r.stdout + r.stderr };
  };

  it("a dry run counts as nothing, red or green", () => {
    for (const c of ["failure", "success"]) {
      const r = alert(c, [issue(7)], "hosted-release (dry run)");
      expect(r.code).toBe(0);
      expect(r.writes).toEqual([]);
      expect(r.out).toContain("dry run");
    }
  });
  it("lists open blocker issues with the exact arguments, once", () => {
    const r = alert("success");
    expect(r.calls.filter((c) => c.startsWith("issue list"))).toEqual([
      "issue list --repo o/r --state open --label blocker --limit 100 --json number,title",
    ]);
  });
  it("comments on the first matching open issue", () => {
    const r = alert("failure", [issue(8, "other"), issue(7), issue(9)]);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatch(/^issue comment 7 /);
  });
  it("startup_failure is red", () => {
    expect(alert("startup_failure").writes[0]).toMatch(/^issue create /);
  });
  it("a failed issue list fails the job and creates nothing", () => {
    for (const c of ["failure", "success"]) {
      const r = alert(c, [issue(7)], "hosted-release", true);
      expect(r.code).not.toBe(0);
      expect(r.writes).toEqual([]);
    }
  });
  it("fails on any error", () => {
    expect(step.run).toMatch(/^set -euo pipefail$/m);
  });
  it("uses the fixed title", () => {
    expect(step.env.TITLE).toBe(TITLE);
  });
  it.each(["failure", "timed_out"])("%s with no open issue opens one", (c) => {
    const r = alert(c);
    expect(r.code).toBe(0);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatch(
      /^issue create --repo o\/r --title hosted-release failed --label blocker --body .*actions\/runs\/1 .*a{40}.* /,
    );
    expect(r.writes[0]).toContain(c);
  });
  it("failure with an open issue comments on it, opens no second", () => {
    const r = alert("failure", [issue(7), issue(8, "something else")]);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatch(/^issue comment 7 --repo o\/r --body /);
    expect(r.writes[0]).toContain("actions/runs/1");
  });
  it("another issue's title does not count as the open one", () => {
    const r = alert("failure", [issue(8, "something else")]);
    expect(r.writes[0]).toMatch(/^issue create /);
  });
  it("success closes the open issue, naming the run", () => {
    const r = alert("success", [issue(7)]);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatch(
      /^issue close 7 --repo o\/r --comment Green again: .*actions\/runs\/1/,
    );
  });
  it("success with no open issue does nothing", () => {
    const r = alert("success");
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
  });
  it.each(["cancelled", "skipped", "neutral", ""])(
    "%j is neither red nor green: nothing changes, and it says so",
    (c) => {
      const r = alert(c, [issue(7)]);
      expect(r.code).toBe(0);
      expect(r.writes).toEqual([]);
      expect(r.out).toContain("nothing changed");
    },
  );
});
