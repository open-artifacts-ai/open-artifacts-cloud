// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// tier-audit.yml: prod's TIER-binding audit, read-only, by hand only, from
// main, in the prod Environment, with main's scripts only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { root } from "./stubs.ts";

const text = readFileSync(
  join(root, ".github/workflows/tier-audit.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const w: any = parse(text);
const job = w.jobs.audit;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const steps: Record<string, any>[] = job.steps;

describe("tier-audit.yml", () => {
  it("runs only on dispatch with no inputs, read-only, in prod's Environment", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    expect(w.on.workflow_dispatch?.inputs).toBeUndefined();
    expect(w.permissions).toEqual({ contents: "read" });
    expect(Object.keys(w.jobs)).toEqual(["audit"]);
    expect(job.permissions).toBeUndefined();
    expect(job.environment).toBe("hosted-prod-deploy");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(10);
  });

  it("refuses any ref but main first", () => {
    expect(steps[0]).toMatchObject({
      name: "On main",
      env: { REF: "${{ github.ref }}" },
    });
    expect(steps[0]?.run).toContain('[ "$REF" = refs/heads/main ] ||');
  });

  it("checks out main's scripts/ci and .github/hosted only, SHA-pinned, no credentials", () => {
    const outs = steps.filter((s) => s.uses);
    expect(outs).toHaveLength(1);
    expect(outs[0]?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(outs[0]?.with).toEqual({
      ref: "${{ github.sha }}",
      "sparse-checkout": "scripts/ci\n.github/hosted\n",
      "persist-credentials": false,
    });
  });

  it("only the script step sees the token, and it takes the namespace from prod.json", () => {
    const withSecrets = steps.filter((s) =>
      JSON.stringify(s).includes("secrets."),
    );
    expect(withSecrets.map((s) => s.name)).toEqual(["List the TIER bindings"]);
    expect(withSecrets[0]?.run).toBe("bash scripts/ci/tier-audit.sh");
    expect(withSecrets[0]?.env).toEqual({
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    });
    expect(text).toContain(".github/hosted/prod.json");
    expect(text).not.toContain("vars.");
    expect(text).not.toContain("inputs.");
  });
});
