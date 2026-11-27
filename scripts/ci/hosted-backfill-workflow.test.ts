// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// hosted-backfill.yml: the operator-run backfills, by hand on main, dry run
// first, counts only in a public log.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const text = readFileSync(
  join(root, ".github/workflows/hosted-backfill.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const w: any = parse(text);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
type Step = Record<string, any>;
const steps: Step[] = w.jobs.backfill.steps;
const named = (n: string) => steps.find((s) => s.name === n) as Step;

describe("hosted-backfill.yml", () => {
  it("is dispatch only, with op, env, dry_run (default true) and confirm", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    const i = w.on.workflow_dispatch.inputs;
    expect(Object.keys(i).sort()).toEqual(["confirm", "dry_run", "env", "op"]);
    expect(i.op.options).toEqual(["push-keys", "optout-key"]);
    expect(i.env.options).toEqual(["staging", "prod"]);
    expect(i.dry_run.default).toBe(true);
    expect(w.permissions).toEqual({ contents: "read" });
  });

  it("runs in the env's deploy Environment and only from main", () => {
    expect(w.jobs.backfill.environment).toBe(
      "${{ inputs.env == 'prod' && 'hosted-prod-deploy' || 'hosted-staging-deploy' }}",
    );
    const g = named("Runs only from main, and a real prod run is confirmed");
    expect(g.run).toContain("refs/heads/main");
    expect(g.run).toContain('"write prod"');
    expect(steps.indexOf(g)).toBe(0);
  });

  it("reads the secret in one step only, and removes the file always", () => {
    expect(
      steps.filter((s) => JSON.stringify(s).includes("secrets.")).length,
    ).toBe(1);
    expect(named("Write the token file").env.CLOUDFLARE_API_TOKEN).toBe(
      "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    );
    expect(named("Remove the token file").if).toBe("${{ always() }}");
  });

  it("calls only the two backfill commands, never with --detail", () => {
    const run = named("Backfill").run as string;
    const calls = [...run.matchAll(/--filter @oa\/hosted start (\S+)/g)].map(
      (m) => m[1],
    );
    expect(calls).toEqual(["backfill-push-keys", "backfill-optout-key"]);
    expect(run).not.toContain("--detail");
    expect(run).toContain("--dry-run");
    expect(named("Backfill").env.OA_HOSTED_ENVIRONMENT).toBe(
      "${{ inputs.env == 'prod' && 'hosted-prod-deploy' || 'hosted-staging-deploy' }}",
    );
  });

  it("the prod confirmation guard refuses a real run without it", () => {
    const g = named("Runs only from main, and a real prod run is confirmed")
      .run as string;
    expect(g).toContain('[ "$DEPLOY_ENV" = prod ] && [ "$DRY_RUN" != true ]');
  });
});
