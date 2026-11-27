// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// cf-logs.yml: one Worker's logs as counts, by hand, from the read-only token.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const text = readFileSync(join(root, ".github/workflows/cf-logs.yml"), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const w: any = parse(text);
const job = w.jobs.logs;

describe("cf-logs.yml", () => {
  it("runs on dispatch only, with no permissions, in cf-read", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual([
      "worker",
      "since",
      "minutes",
      "filter",
    ]);
    expect(w.on.workflow_dispatch.inputs.filter.options).toEqual([
      "errors",
      "status5xx",
      "all",
    ]);
    expect(w.permissions).toEqual({});
    expect(job.environment).toBe("cf-read");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(5);
    expect(text).not.toContain("actions/checkout");
  });

  it("fails closed: bash, pipefail, every run step", () => {
    for (const s of job.steps) {
      expect(s.shell).toBe("bash");
      expect(s.run.startsWith("set -euo pipefail\n")).toBe(true);
    }
  });

  it("refuses a multi-line worker input", () => {
    const run = (worker: string) =>
      spawnSync("bash", ["-c", job.steps[0].run], {
        env: {
          PATH: process.env.PATH,
          WORKER: worker,
          SINCE: "2026-11-18T10:00:00Z",
          MINUTES: "30",
        },
      }).status;
    expect(run("oa-p-dispatch")).toBe(0);
    expect(run("open-artifacts-prod")).toBe(0);
    // install-style and unknown names are refused
    expect(run("oa-p-acme-corp")).not.toBe(0);
    expect(run("oa-p-dispatch-acme")).not.toBe(0);
    expect(run("acme")).not.toBe(0);
    expect(run("oa-p-dispatch\nevil")).not.toBe(0);
    expect(run("evil\noa-p-dispatch")).not.toBe(0);
    expect(run("oa-p-dispatch\n")).not.toBe(0);
  });

  it("allowlists the worker and bounds minutes", () => {
    expect(text).toContain(
      "^(oa-[ps]-(dispatch|provisioning|scheduler|provisioner|inventory|billing)|open-artifacts-(prod|staging))$",
    );
    expect(text).toContain("<= 120");
  });

  it("passes inputs through env, never into the script text", () => {
    for (const s of job.steps) expect(s.run).not.toMatch(/\$\{\{/);
  });

  it("prints a class and hash, never error text", () => {
    expect(text).not.toContain("redact");
    const fn = /errline\(\) \{\n[\s\S]*?\n {10}\}\n/.exec(text)?.[0];
    expect(fn).toBeDefined();
    const msg =
      "TypeError: cannot reach acme.com for Jane Doe id a1b2c3d4e5f6a7b8";
    const hex = "0123456789abcdef0123456789abcdef";
    const out = spawnSync("bash", ["-c", `${fn}\nerrline`], {
      input: `3\t${msg}\n2\tJane Doe failed\n4\talice123 is not a member\n5\t${hex}\n6\tD1_ERROR: no such table x\n7\tAcmeCorp: down\n`,
      encoding: "utf8",
    }).stdout;
    const hash = createHash("sha256").update(msg).digest("hex").slice(0, 8);
    expect(out).toContain(`- 3: TypeError #${hash}`);
    expect(out).toContain("- 2: error #");
    expect(out).toContain("- 4: error #");
    expect(out).toContain("- 5: error #");
    expect(out).toContain("- 6: D1_ERROR #");
    expect(out).toContain("- 7: error #");
    for (const leak of [
      "acme.com",
      "Jane",
      "Doe",
      "a1b2c3d4e5f6a7b8",
      "cannot",
      "alice123",
      hex,
      "AcmeCorp",
    ])
      expect(out).not.toContain(leak);
    expect(text).toContain("Cloudflare error code");
    expect(text).not.toMatch(/cat resp\.json|jq \. resp\.json/);
    expect(text).toContain("Axe review");
    expect(text).toContain('no result.calculations in the response" >&2');
    expect(text).toContain(".errors[0].code | numbers");
  });
});
