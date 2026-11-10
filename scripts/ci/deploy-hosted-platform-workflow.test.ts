// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// deploy-hosted-platform.yml: one env's hosted platform Workers deploy by hand
// only, from a stable tag that passed the release gate, in that env's
// main-only Environment (no approval step), with main's deploy scripts and the
// tag's code.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { root } from "./stubs.ts";

const text = readFileSync(
  join(root, ".github/workflows/deploy-hosted-platform.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const w: any = parse(text);
const job = w.jobs.deploy;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const steps: Record<string, any>[] = job.steps;
const named = (n: string) =>
  steps.find((s) => s.name === n) as Record<string, any>;

describe("ALLOW_SIGNUPS", () => {
  it("is set once at job level, for staging only, so every step that reads the signups constant sees it; prod gets none", () => {
    expect(job.env.ALLOW_SIGNUPS).toBe(
      "${{ inputs.env == 'staging' && '1' || '' }}",
    );
    for (const st of steps) expect(st.env?.ALLOW_SIGNUPS, st.name).toBeUndefined();
  });
});

const FULL =
  "platform-db,auth-broker,directory-broker,provision-token,provisioner,dispatch,inventory,provisioning,zones,scheduler";
// The gate on billing's Stripe secrets: staging and the billing target (#1568).
const HOLD =
  "inputs.env == 'staging' && contains(format(',{0},', inputs.targets), ',billing,') &&";
// Staging's full list: the same with billing (a staging-only target, #1568).
const FULLB =
  "platform-db,auth-broker,directory-broker,billing,provision-token,provisioner,dispatch,inventory,provisioning,zones,scheduler";

describe("deploy-hosted-platform.yml", () => {
  it("one version (#1040): the default is every target, in order; required", () => {
    const t = w.on.workflow_dispatch.inputs.targets;
    expect(t.default).toBe(FULL);
    expect(t.required).toBe(true);
    // The order the input check enforces.
    const check = named("Check the inputs").run as string;
    expect(/order="([^"]+)"/.exec(check)?.[1]?.split(" ").join(",")).toBe(
      FULLB,
    );
    // The scheduler refuses without ALERT_TO. It is the owner's address, so
    // it is never committed (#1084): it comes from the OA_OWNER_EMAIL secret.
    for (const e of ["staging", "prod"])
      expect(
        JSON.parse(readFileSync(join(root, `.github/hosted/${e}.json`), "utf8"))
          .alert_to,
        e,
      ).toBeUndefined();
    expect(text).toContain("OA_OWNER_EMAIL: ${{ secrets.OA_OWNER_EMAIL }}");
  });
  it("names each run after its env and tag", () => {
    expect(w["run-name"]).toBe(
      "deploy-hosted-platform ${{ inputs.env }} ${{ inputs.tag }}${{ inputs.chain_id && format(' [{0}]', inputs.chain_id) || '' }}",
    );
  });
  it("break-glass: fewer targets need a reason, checked before any checkout; verify_only is exempt", () => {
    expect(w.on.workflow_dispatch.inputs.reason).toMatchObject({
      type: "string",
      default: "",
    });
    const c = named("Check the inputs");
    expect(steps.indexOf(c)).toBe(0);
    expect(c.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      TAG: "${{ inputs.tag }}",
      TARGETS: "${{ inputs.targets }}",
      REASON: "${{ inputs.reason }}",
      VERIFY_ONLY: "${{ inputs.verify_only }}",
      OA_OWNER_EMAIL: "${{ secrets.OA_OWNER_EMAIL }}",
      // Billing's Stripe secrets: a staging run that includes billing only (#1568).
      STRIPE_SECRET_KEY: `\${{ ${HOLD} secrets.STRIPE_SECRET_KEY || '' }}`,
      STRIPE_WEBHOOK_SECRET: `\${{ ${HOLD} secrets.STRIPE_WEBHOOK_SECRET || '' }}`,
    });
    const go = (
      TARGETS: string,
      REASON: string,
      VERIFY_ONLY = "false",
      DEPLOY_ENV = "prod",
    ) =>
      spawnSync("bash", ["-c", c.run], {
        env: {
          PATH: process.env.PATH,
          DEPLOY_ENV,
          TAG: "v0.90.3",
          TARGETS,
          REASON,
          VERIFY_ONLY,
          OA_OWNER_EMAIL: "me@test.invalid",
          STRIPE_SECRET_KEY: "sk_test_abcdefgh12345678",
          STRIPE_WEBHOOK_SECRET: "whsec_abcdefgh12345678",
        },
        encoding: "utf8",
      });
    expect(go(FULL, "").status).toBe(0);
    // Staging's full list (with billing) is a full list: no reason needed.
    expect(go(FULLB, "", "false", "staging").status).toBe(0);
    // billing alone, or without the rest, is break-glass like any fewer targets.
    expect(go("billing", "", "false", "staging").status).toBe(1);
    expect(go("billing", "stage it", "false", "staging").status).toBe(0);
    // Prod refuses billing in any list, with or without a reason, verify only too.
    for (const t of [FULLB, "billing", "directory-broker,billing,dispatch"])
      for (const v of ["false", "true"]) {
        const r = go(t, "because", v, "prod");
        expect(r.status, `${t} ${v}`).toBe(1);
        expect(r.stdout).toContain("billing is a staging-only target");
      }
    const no = go("dispatch", "");
    expect(no.status).toBe(1);
    expect(no.stdout).toContain("need a reason");
    expect(go("dispatch", "   ").status).toBe(1);
    expect(go("dispatch", "hotfix #1040: dispatch 5xx").status).toBe(0);
    // verify_only deploys nothing: no reason needed.
    expect(go("dispatch", "", "true").status).toBe(0);
    expect(go("dispatch", "x".repeat(501)).status).toBe(1);
    expect(go("dispatch", "two\nlines").status).toBe(1);
  });
  it("break-glass opens an issue with the reason, the run and the actor; not for verify_only or the full list", () => {
    const r = named("Record the break-glass deploy");
    expect(r.if).toBe(
      `\${{ !inputs.verify_only && inputs.targets != '${FULL}' && inputs.targets != '${FULLB}' }}`,
    );
    const i = (n: string) => steps.indexOf(named(n));
    // After the release gate and the main check, before anything deploys.
    expect(i("Record the break-glass deploy")).toBeGreaterThan(
      i("Prod runs only from main"),
    );
    expect(i("Record the break-glass deploy")).toBeLessThan(
      i("Deploy and verify"),
    );
    expect(r.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      TAG: "${{ inputs.tag }}",
      TARGETS: "${{ inputs.targets }}",
      REASON: "${{ inputs.reason }}",
      ACTOR: "${{ github.actor }}",
      RUN_URL:
        "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
      GH_TOKEN: "${{ github.token }}",
    });
    expect(JSON.stringify(r)).not.toMatch(/secrets\.|email/i);
    const run = r.run as string;
    expect(run).toContain(
      'gh issue create --repo "$GITHUB_REPOSITORY" --title "Break-glass platform deploy: $DEPLOY_ENV $TAG $TARGETS" --body-file "$body"',
    );
    // The body, as the step writes it (gh stubbed out).
    const body = spawnSync(
      "bash",
      ["-c", `${run.replace(/^gh issue create.*$/m, 'cat "$body"')}`],
      {
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: tmpdir(),
          REASON: "dispatch 5xx %s",
          RUN_URL: "https://github.com/o/r/actions/runs/1",
          ACTOR: "someone",
        },
        encoding: "utf8",
      },
    );
    expect(body.status).toBe(0);
    expect(body.stdout).toBe(
      "Reason: dispatch 5xx %s\n\nRun: https://github.com/o/r/actions/runs/1\n\nActor: someone\n",
    );
  });
  it("runs by dispatch only (the chain dispatches it), read-only, one at a time, in the env's Environment", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    const inputs = w.on.workflow_dispatch.inputs;
    expect(inputs.tag.required).toBe(true);
    expect(inputs.env).toMatchObject({
      type: "choice",
      options: ["staging", "prod"],
      required: true,
    });
    expect(inputs.verify_only).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(w.permissions).toEqual({
      contents: "read",
      actions: "read",
      issues: "write",
    });
    expect(Object.keys(inputs).sort()).toEqual([
      "chain_id",
      "env",
      "reason",
      "require_newer",
      "tag",
      "targets",
      "verify_only",
    ]);
    expect(job.permissions).toBeUndefined();
    expect(job.environment).toBe(
      "${{ inputs.env == 'prod' && 'hosted-prod-deploy' || 'hosted-staging-deploy' }}",
    );
    expect(w.concurrency).toEqual({
      group: "hosted-platform-${{ inputs.env }}",
      "cancel-in-progress": false,
    });
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
  });

  it("pins every action by SHA and keeps no git credentials", () => {
    const local = "./_cloud/.github/actions/overlay";
    for (const l of text
      .split("\n")
      .filter((l) => /^\s*- uses: /.test(l) && !l.endsWith(local)))
      expect(l).toMatch(/@[0-9a-f]{40} # v\d/);
    for (const s of steps.filter((s) => s.uses && s.uses !== local)) {
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
      if (String(s.uses).startsWith("actions/checkout@"))
        expect(s.with["persist-credentials"]).toBe(false);
    }
  });

  it("deploys the tag's code with main's deploy scripts", () => {
    const outs = steps.filter((s) =>
      String(s.uses).startsWith("actions/checkout@"),
    );
    expect(outs).toHaveLength(3);
    // The CLOUD tag goes to _cloud; the overlay action puts it on the public
    // tree at the tag's PUBLIC_PIN and refuses anything but exactly the tag.
    expect(outs[1]?.with).toEqual({
      ref: "refs/tags/${{ inputs.tag }}",
      path: "_cloud",
      "persist-credentials": false,
    });
    const overlay =
      steps[steps.indexOf(outs[1] as Record<string, unknown>) + 1];
    expect(overlay?.uses).toBe("./_cloud/.github/actions/overlay");
    expect(overlay?.with).toEqual({ "exact-tag": "${{ inputs.tag }}" });
    expect(outs[2]?.with).toMatchObject({
      ref: "${{ github.sha }}",
      path: ".deploy-logic",
      "sparse-checkout":
        "scripts/ops\nscripts/ci\npackages/provision/src\napps/platform-db\napps/billing\n.github/hosted\n",
    });
    const use = named("Use main's deploy scripts").run as string;
    expect(use).toContain(
      "for f in deploy-hosted-platform.sh deploy-platform-worker.sh hosted-zones.sh platform-db.ts billing-db.ts check-migration-lock.mjs wrangler-env.ts broker-key.ts; do",
    );
    // The broker's Google client pin is main's, never the tag's.
    expect(use).toContain(
      'cp .deploy-logic/packages/provision/src/wfp.ts "$RUNNER_TEMP/main-wfp.ts"',
    );
    expect(named("Deploy and verify").env.BROKER_PIN_FILE).toBe(
      "${{ runner.temp }}/main-wfp.ts",
    );
    expect(steps.indexOf(named("Use main's deploy scripts"))).toBeLessThan(
      steps.indexOf(named("Deploy and verify")),
    );
    // The constants and the id lookup are main's too, never the tag's.
    expect(use).toContain(
      "for f in hosted-cf.sh hosted-constants.sh hosted-resource-ids.sh staging-first-gate.sh staging-smoke-gate.sh deploy-token-expiry.sh platform-tags.sh worker-tag.sh prod-release-chain.ts deploy-token-identity.sh; do",
    );
    expect(use).toContain(
      'cp -R .deploy-logic/.github/hosted "$RUNNER_TEMP/main-ci/hosted"',
    );
    // main's migration pins, never the tag's own lock alone.
    expect(use).toContain(
      'cp .deploy-logic/apps/platform-db/migration-lock.json "$RUNNER_TEMP/main-ci/migration-lock.json"',
    );
    expect(named("Deploy and verify").env.MAIN_MIGRATION_LOCK).toBe(
      "${{ runner.temp }}/main-ci/migration-lock.json",
    );
    // The billing database's pins are main's too (staging's billing target).
    expect(use).toContain(
      'cp .deploy-logic/apps/billing/migration-lock.json "$RUNNER_TEMP/main-ci/billing-migration-lock.json"',
    );
    expect(named("Deploy and verify").env.MAIN_BILLING_MIGRATION_LOCK).toBe(
      "${{ runner.temp }}/main-ci/billing-migration-lock.json",
    );
  });

  it("loads main's committed constants, then resolves the resource ids, before deploying; no variables", () => {
    const i = (n: string) => steps.indexOf(named(n));
    expect(i("Use main's deploy scripts")).toBeLessThan(
      i("Load the hosted constants"),
    );
    // The release chain's re-check (#1343) sits between: it needs the
    // account id, and runs before any lookup or deploy.
    expect(i("Load the hosted constants")).toBe(
      i("The deploy token is the Environment's") - 1,
    );
    expect(i("The deploy token is the Environment's")).toBe(
      i("The tag is newer than prod's") - 1,
    );
    expect(i("The tag is newer than prod's")).toBe(
      i("Resolve the resource ids") - 1,
    );
    expect(i("Resolve the resource ids")).toBe(i("Deploy and verify") - 1);
    expect(named("Load the hosted constants")).toMatchObject({
      env: { DEPLOY_ENV: "${{ inputs.env }}" },
      run: 'bash "$RUNNER_TEMP/main-ci/hosted-constants.sh" "$DEPLOY_ENV" "$RUNNER_TEMP/main-ci/hosted"',
    });
    expect(named("Resolve the resource ids")).toMatchObject({
      env: {
        DEPLOY_ENV: "${{ inputs.env }}",
        // The Secrets Store id only for provision-token and provisioner.
        TARGETS: "${{ inputs.targets }}",
        CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      },
      run: 'bash "$RUNNER_TEMP/main-ci/hosted-resource-ids.sh" "$DEPLOY_ENV"',
    });
    expect(Object.keys(named("Resolve the resource ids").env)).toHaveLength(3);
    expect(named("Load the hosted constants").if).toBeUndefined();
    // Only the targets that bind an id (or the zone tag) look them up.
    const cond = named("Resolve the resource ids").if as string;
    const runsFor = (targets: string) => {
      const js = cond
        .replace(/^\$\{\{\s*/, "")
        .replace(/\s*\}\}$/, "")
        .replace(
          /contains\(format\(',\{0\},', inputs\.targets\), '([^']*)'\)/g,
          (_, t) => JSON.stringify(`,${targets},`.includes(t)),
        );
      expect(js).toMatch(/^(true|false|\|\|| )+$/);
      return new Function(`return (${js});`)() as boolean;
    };
    for (const t of [
      "platform-db",
      "auth-broker",
      "directory-broker",
      "provision-token",
      "provisioner",
      "dispatch",
      "scheduler",
      "inventory",
      "provisioning",
      "auth-broker,directory-broker,dispatch,scheduler",
      "inventory,zones",
    ])
      expect(runsFor(t), t).toBe(true);
    for (const t of ["zones"]) expect(runsFor(t), t).toBe(false);
    // Everything the user used to copy into the Environment comes from these.
    expect(text).not.toContain("vars.");
    for (const k of [
      "CLOUDFLARE_ACCOUNT_ID",
      "PLATFORM_DB_ID",
      "HOSTS_KV_ID",
      "BROKER_REGISTRY_ID",
      "DIRECTORY_REGISTRY_ID",
      "EMAIL_ZONE_TAGS",
      "EMAIL_DAILY_LIMIT",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_DIRECTORY_CLIENT_ID",
    ])
      expect(named("Deploy and verify").env[k], k).toBeUndefined();
  });

  it("only the id lookup, deploy, zones, tag read-back and expiry steps see secrets, through env, exactly these", () => {
    const withSecrets = steps.filter((s) =>
      JSON.stringify(s).includes("secrets."),
    );
    expect(withSecrets.map((s) => s.name)).toEqual([
      "Check the inputs",
      "Load the hosted constants",
      "The deploy token is the Environment's",
      "The tag is newer than prod's",
      "Resolve the resource ids",
      "Deploy and verify",
      "Zones",
      "Scheduler, last",
      "Every platform Worker runs the tag",
      "Mark the platform verified",
      "Clear the platform verified marks (break-glass)",
      "The deploy token's expiry",
    ]);
    // One Cloudflare token for everything; the old names are gone.
    for (const old of ["DEPLOY_TOKEN", "ZONE_TOKEN", "PROVISION_TOKEN"])
      expect(text).not.toContain(old);
    // #1084: the alert address, the owner's, is a secret, never committed.
    // The input check sees that one secret, and no token.
    expect(
      JSON.stringify(named("Check the inputs").env).match(/secrets\.\w+/g),
    ).toEqual([
      "secrets.OA_OWNER_EMAIL",
      "secrets.STRIPE_SECRET_KEY",
      "secrets.STRIPE_WEBHOOK_SECRET",
    ]);
    expect(named("Load the hosted constants").env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      OA_OWNER_EMAIL: "${{ secrets.OA_OWNER_EMAIL }}",
    });
    expect(
      JSON.stringify(named("The tag is newer than prod's").env).match(
        /secrets\.\w+/g,
      ),
    ).toEqual(["secrets.CLOUDFLARE_API_TOKEN"]);
    // #1343: the canary smoke's two secrets reach the scheduler's step, and
    // no other step of the workflow.
    expect(
      JSON.stringify(named("Scheduler, last").env).match(/secrets\.\w+/g),
    ).toEqual([
      "secrets.CLOUDFLARE_API_TOKEN",
      "secrets.FLEET_SMOKE_TOKEN",
      "secrets.FLEET_SMOKE_SHARE_TO",
    ]);
    for (const st of steps.filter((x) => x.name !== "Scheduler, last"))
      expect(JSON.stringify(st), st.name).not.toMatch(/FLEET_SMOKE/);
    expect(named("Zones").env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      VERIFY_ONLY: "${{ inputs.verify_only && '1' || '' }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    });
    const env = named("Deploy and verify").env as Record<string, string>;
    const secrets = Object.entries(env)
      .filter(([, v]) => v.includes("secrets."))
      .map(([k]) => k)
      .sort();
    expect(secrets).toEqual([
      "ADMIN_IDENTITIES",
      "CLOUDFLARE_API_TOKEN",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_DIRECTORY_CLIENT_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
    // The inventory key is gone (design v7 6.3): OIDC replaces it.
    expect(text).not.toContain("INVENTORY_KEY");
    expect(text).not.toContain("inventory-key");
    // The same names in each env's Environment: no env-specific secret names.
    expect(JSON.stringify(env)).not.toMatch(/PROD_|STAGING_/);
    expect(env.CLOUDFLARE_API_TOKEN).toBe(
      "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    );
    expect(env.VERIFY_ONLY).toBe("${{ inputs.verify_only && '1' || '' }}");
    // Every Worker version is tagged with the release (#1040): the wrapper
    // passes DEPLOY_TAG to wrangler deploy --tag.
    expect(env.DEPLOY_TAG).toBe("${{ inputs.tag }}");
    // #1007: the admin allowlist is the Environment's secret, never committed.
    expect(env.ADMIN_IDENTITIES).toBe("${{ secrets.ADMIN_IDENTITIES }}");
    expect(named("Deploy and verify").run).not.toContain("secrets.");
    expect(named("Deploy and verify").run).toContain(
      'bash scripts/ops/deploy-hosted-platform.sh "$DEPLOY_ENV" "$t"',
    );
  });

  it("the release gate runs main's script right after the input check, before the tag checkout, for both envs", () => {
    const gate = named("The tag passed every earlier check");
    const i = steps.indexOf(gate);
    expect(steps.indexOf(named("Check the inputs"))).toBe(i - 2);
    expect(steps[i - 1]?.with).toMatchObject({
      ref: "${{ github.sha }}",
      path: ".release-gate",
      "sparse-checkout": "scripts/ci",
      "persist-credentials": false,
    });
    expect(gate.if).toBeUndefined();
    expect(gate.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      TAG: "${{ inputs.tag }}",
      GH_TOKEN: "${{ github.token }}",
    });
    expect(gate.run).toContain(
      'bash .release-gate/scripts/ci/tag-passed-checks.sh "$DEPLOY_ENV" "$TAG"',
    );
    const tagOut = steps.find(
      (s) =>
        String(s.uses).startsWith("actions/checkout@") &&
        s.with.ref === "refs/tags/${{ inputs.tag }}",
    );
    expect(i).toBeLessThan(steps.indexOf(tagOut as Record<string, unknown>));
  });

  it("zones plan, then apply in the same job; verify_only stays plan only", () => {
    const z = named("Zones");
    expect(z.env.VERIFY_ONLY).toBe("${{ inputs.verify_only && '1' || '' }}");
    expect(text).not.toContain("apply_zones");
    const lines = (z.run as string).trim().split("\n");
    expect(lines).toEqual([
      "set -euo pipefail",
      'bash scripts/ops/hosted-zones.sh "$DEPLOY_ENV" plan',
      '[ -n "$VERIFY_ONLY" ] || bash scripts/ops/hosted-zones.sh "$DEPLOY_ENV" apply',
    ]);
    expect(steps.indexOf(z)).toBeGreaterThan(
      steps.indexOf(named("Deploy and verify")),
    );
  });

  it("prod runs only from main, checked in the workflow and again in the script", () => {
    const s = named("Prod runs only from main");
    expect(s.if).toBe("${{ inputs.env == 'prod' }}");
    expect(s.run).toBe('test "$REF" = refs/heads/main');
    expect(named("Deploy and verify").env.DEPLOY_ENVIRONMENT).toBe(
      "${{ inputs.env == 'prod' && 'hosted-prod-deploy' || 'hosted-staging-deploy' }}",
    );
  });

  it("the input check accepts known targets in order and refuses anything else", () => {
    const check = named("Check the inputs").run as string;
    const go = (TAG: string, TARGETS: string) =>
      spawnSync("bash", ["-c", check], {
        env: {
          PATH: process.env.PATH,
          DEPLOY_ENV: "staging",
          TAG,
          TARGETS,
          REASON: "test",
          OA_OWNER_EMAIL: "me@test.invalid",
        },
        encoding: "utf8",
      }).status;
    expect(
      go("v0.74.1", "auth-broker,directory-broker,dispatch,scheduler"),
    ).toBe(0);
    expect(go("v0.74.1", "inventory,zones")).toBe(0);
    expect(go("v0.74.1", "inventory-key")).toBe(1);
    expect(go("v0.74.1", "zones,dispatch")).toBe(1);
    expect(
      go(
        "v0.74.1",
        "platform-db,auth-broker,directory-broker,provision-token,provisioner,dispatch,inventory,provisioning,zones,scheduler",
      ),
    ).toBe(0);
    expect(go("v0.74.1", "provisioning,provisioner")).toBe(1);
    expect(go("v0.74.1", "provisioner,provision-token")).toBe(1);
    expect(go("v0.74.1", "auth-broker,platform-db")).toBe(1);
    expect(go("v0.74.1", "dispatch,scheduler")).toBe(0);
    for (const [tag, t] of [
      ["0.74.1", "dispatch"],
      ["v0.74.1-rc.1", "dispatch"],
      ["main", "dispatch"],
      ["v0.74.1", "scheduler,dispatch"],
      ["v0.74.1", "dispatch,dispatch"],
      ["v0.74.1", "bogus"],
      ["v0.74.1", "dispatch;rm -rf /"],
      ["v0.74.1", ""],
    ])
      expect(go(tag as string, t as string), `${tag} ${t}`).toBe(1);
  });

  it("billing's Stripe secrets: staging only, and a billing run without them fails in the input check, before any target runs (#1568)", () => {
    const c = named("Check the inputs");
    const SECRET = "sk_test_abcdefgh12345678";
    const WH = "whsec_abcdefgh12345678";
    const go = (
      TARGETS: string,
      env: Record<string, string> = {},
      DEPLOY_ENV = "staging",
      VERIFY_ONLY = "false",
    ) =>
      spawnSync("bash", ["-c", c.run], {
        env: {
          PATH: process.env.PATH,
          DEPLOY_ENV,
          TAG: "v0.90.3",
          TARGETS,
          REASON: "test",
          VERIFY_ONLY,
          OA_OWNER_EMAIL: "me@test.invalid",
          STRIPE_SECRET_KEY: SECRET,
          STRIPE_WEBHOOK_SECRET: WH,
          ...env,
        },
        encoding: "utf8",
      });
    expect(go(FULLB).status).toBe(0);
    expect(go("billing").status).toBe(0);
    // A run that does not deploy billing needs neither secret.
    expect(
      go("dispatch", { STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" })
        .status,
    ).toBe(0);
    for (const [k, v, want] of [
      [
        "STRIPE_SECRET_KEY",
        "",
        "STRIPE_SECRET_KEY is not set in hosted-staging-deploy",
      ],
      [
        "STRIPE_WEBHOOK_SECRET",
        "",
        "STRIPE_WEBHOOK_SECRET is not set in hosted-staging-deploy",
      ],
      ["STRIPE_SECRET_KEY", "sk_live_abcdefgh12345678", "test-mode key"],
      ["STRIPE_SECRET_KEY", "rk_live_abcdefgh12345678", "test-mode key"],
      ["STRIPE_WEBHOOK_SECRET", "abcdefgh12345678", "signing secret"],
    ] as const) {
      const r = go(FULLB, { [k]: v });
      expect(r.status, `${k}=${v}`).toBe(1);
      expect(r.stdout).toContain(want);
      // The value is never printed.
      if (v) expect(r.stdout + r.stderr).not.toContain(v);
    }
    // verify only reads: no secret needed.
    expect(
      go(
        "billing",
        { STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" },
        "staging",
        "true",
      ).status,
    ).toBe(0);
    // Prod: billing is refused whatever the secrets say.
    expect(go("billing", {}, "prod").status).toBe(1);
    // The deploy step gets them by the same expression.
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"])
      expect(named("Deploy and verify").env[k]).toBe(
        `\${{ ${HOLD} secrets.${k} || '' }}`,
      );
    // Evaluated: only staging with billing in the targets holds a secret; a
    // prod run, or a staging run without billing, holds none.
    const held = (env: string, targets: string, k: string) => {
      const expr = (named("Deploy and verify").env[k] as string)
        .replace(/^\$\{\{\s*/, "")
        .replace(/\s*\}\}$/, "")
        .replace(
          /contains\(format\(',\{0\},', inputs\.targets\), '([^']*)'\)/g,
          (_, t) => JSON.stringify(`,${targets},`.includes(t)),
        )
        .replace(/secrets\.\w+/, JSON.stringify("the-secret"));
      return new Function("inputs", `return (${expr});`)({ env }) as string;
    };
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) {
      expect(held("staging", FULLB, k), k).toBe("the-secret");
      expect(held("staging", "billing", k)).toBe("the-secret");
      expect(held("staging", FULL, k), "staging default list").toBe("");
      expect(held("staging", "dispatch,scheduler", k)).toBe("");
      expect(held("prod", FULL, k), "prod").toBe("");
      expect(held("prod", "billing", k), "prod billing").toBe("");
    }
    // No other step sees them.
    const seeing = steps
      .filter((s) => JSON.stringify(s).includes("STRIPE_"))
      .map((s) => s.name);
    expect(seeing).toEqual(["Check the inputs", "Deploy and verify"]);
  });

  it("the order puts every bound target before its binder (design v7 10.2)", () => {
    const check = named("Check the inputs").run as string;
    const order = (/order="([^"]+)"/.exec(check)?.[1] ?? "").split(" ");
    expect(order).toEqual([
      "platform-db",
      "auth-broker",
      "directory-broker",
      "billing",
      "provision-token",
      "provisioner",
      "dispatch",
      "inventory",
      "provisioning",
      "zones",
      "scheduler",
    ]);
    // What each app binds, from its committed config (prod block).
    const strip = (src: string) =>
      src
        .replace(
          /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
          (m, q) => q ?? "",
        )
        .replace(/,(\s*[}\]])/g, "$1");
    const bound = (app: string): string[] => {
      const cfg = JSON.parse(
        strip(readFileSync(join(root, `apps/${app}/wrangler.jsonc`), "utf8")),
      ).env.prod;
      const out = new Set<string>();
      if (cfg.d1_databases?.length) out.add("platform-db");
      for (const s of cfg.services ?? [])
        out.add(String(s.service).replace(/^oa-p-/, ""));
      for (const wf of cfg.workflows ?? [])
        if (wf.script_name)
          out.add(String(wf.script_name).replace(/^oa-p-/, ""));
      for (const s of cfg.secrets_store_secrets ?? [])
        if (String(s.secret_name).endsWith("-provision-token"))
          out.add("provision-token");
      return [...out];
    };
    const apps = [
      "auth-broker",
      "directory-broker",
      "provisioner",
      "dispatch",
      "scheduler",
      "inventory",
      "provisioning",
    ];
    for (const app of apps)
      for (const dep of bound(app)) {
        expect(order, `${app} binds ${dep}`).toContain(dep);
        expect(order.indexOf(dep), `${dep} before ${app}`).toBeLessThan(
          order.indexOf(app),
        );
      }
    // Staging binds billing (#1568) on dispatch and the scheduler: it
    // deploys before both, and prod binds it nowhere.
    const stagingBound = (app: string): string[] => {
      const cfg = JSON.parse(
        strip(readFileSync(join(root, `apps/${app}/wrangler.jsonc`), "utf8")),
      ).env.staging;
      return (cfg.services ?? []).map((s: { service: string }) =>
        String(s.service).replace(/^oa-s-/, ""),
      );
    };
    for (const app of ["dispatch", "scheduler", "provisioner"]) {
      expect(stagingBound(app), app).toContain("billing");
      expect(order.indexOf("billing"), `billing before ${app}`).toBeLessThan(
        order.indexOf(app),
      );
      expect(bound(app), `prod ${app}`).not.toContain("billing");
    }
    expect(order.indexOf("billing")).toBeGreaterThan(
      order.indexOf("directory-broker"),
    );
    expect(bound("provisioning")).toEqual(
      expect.arrayContaining(["platform-db", "provisioner", "auth-broker"]),
    );
    expect(bound("provisioner")).toEqual(
      expect.arrayContaining(["platform-db", "provision-token"]),
    );
    // The zones route to every Worker that has a route; the scheduler has
    // none (no fetch handler), and nothing binds it, so it can come last
    // (#1343): its tag is the fleet's target.
    for (const app of apps) expect(bound(app), app).not.toContain("scheduler");
    const sched = JSON.parse(
      strip(readFileSync(join(root, "apps/scheduler/wrangler.jsonc"), "utf8")),
    ).env.prod;
    for (const k of ["route", "routes", "custom_domain", "custom_domains"])
      expect(sched[k], k).toBeUndefined();
    expect(order.at(-2)).toBe("zones");
    expect(order.at(-1)).toBe("scheduler");
  });

  it("every prod deploy waits for a green staging run of the tag, whatever its targets, before anything deploys (#1412)", () => {
    const g = named("Staging passed this tag");
    expect(g.run).toBe(
      'bash "$RUNNER_TEMP/main-ci/staging-first-gate.sh" "$TAG"',
    );
    expect(g.env).toEqual({
      TAG: "${{ inputs.tag }}",
      GH_TOKEN: "${{ github.token }}",
    });
    // No filter on a target list, but #1229: a verify_only run with the FULL
    // list is gated too (it can write the platform_verified mark); a partial
    // verify_only run (deploys nothing) and staging runs skip the gates.
    expect(g.if).toBe(
      `\${{ inputs.env == 'prod' && (!inputs.verify_only || (inputs.targets == '${FULL}' || inputs.targets == '${FULLB}')) }}`,
    );
    const runsFor = (env: string, verify_only: boolean, targets = FULL) =>
      new Function(
        "inputs",
        `return (${(g.if as string)
          .replace(/^\$\{\{\s*/, "")
          .replace(/\s*\}\}$/, "")});`,
      )({ env, verify_only, targets }) as boolean;
    expect(runsFor("prod", false)).toBe(true);
    expect(runsFor("prod", false, "scheduler")).toBe(true);
    expect(runsFor("prod", true)).toBe(true);
    expect(runsFor("prod", true, FULLB)).toBe(true);
    expect(runsFor("prod", true, "scheduler")).toBe(false);
    expect(runsFor("staging", false)).toBe(false);
    expect(runsFor("staging", true)).toBe(false);
    const i = (n: string) => steps.indexOf(named(n));
    expect(i("Use main's deploy scripts")).toBeLessThan(
      i("Staging passed this tag"),
    );
    expect(i("Staging passed this tag")).toBeLessThan(i("Deploy and verify"));
    // #1406: the same targets also need staging's smoke green at or after
    // the tag, with main's script, before anything deploys.
    const s = named("Staging's smoke is green at or after this tag");
    expect(s.if).toBe(g.if);
    expect(s.env).toEqual(g.env);
    expect(s.run).toBe(
      'bash "$RUNNER_TEMP/main-ci/staging-smoke-gate.sh" "$TAG"',
    );
    expect(i("Use main's deploy scripts")).toBeLessThan(
      i("Staging's smoke is green at or after this tag"),
    );
    expect(i("Staging's smoke is green at or after this tag")).toBeLessThan(
      i("Deploy and verify"),
    );
  });

  it("builds and tests the Provisioning API Workers and the admin SPA too", () => {
    const run = named("Build and test the Workers being deployed")
      .run as string;
    for (const p of ["@oa/provisioner", "@oa/provisioning", "@oa/admin"])
      expect(run).toContain(`--filter ${p}`);
    // Staging's billing service and its Stripe core, staging only (#1568): the
    // step covers each Worker target, and prod's run is exactly what it was.
    const step = named("Build and test the Workers being deployed");
    expect(step.env).toEqual({ DEPLOY_ENV: "${{ inputs.env }}" });
    expect(run).toContain(
      'if [ "$DEPLOY_ENV" = staging ]; then pnpm --filter @oa/billing --filter @oa/billing-core test; fi',
    );
    const main =
      run.split("\n").find((l) => l.includes("--filter @oa/admin test")) ?? "";
    expect(main).not.toContain("billing");
  });

  it("reads every Worker's tag back with main's script after a full-list run (#1064)", () => {
    const t = named("Every platform Worker runs the tag");
    // The condition follows the input's default, read from the YAML: a target
    // added to the default without the condition fails here, never silently
    // skips the read-back.
    // Prod's full list, or staging's with billing (a staging-only target).
    expect(t.if).toBe(
      `\${{ !cancelled() && (steps.deploy.outcome != 'skipped' || steps.scheduler.outcome != 'skipped') && (inputs.targets == '${w.on.workflow_dispatch.inputs.targets.default}' || inputs.targets == '${FULLB}') }}`,
    );
    expect(t.run).toBe(
      'bash "$RUNNER_TEMP/main-ci/platform-tags.sh" "$DEPLOY_ENV" "$TAG"',
    );
    expect(t.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      TAG: "${{ inputs.tag }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      // billing is read back only when the run deployed it.
      PLATFORM_TAGS_BILLING:
        "${{ contains(format(',{0},', inputs.targets), ',billing,') && '1' || '' }}",
    });
    expect(steps.indexOf(named("Zones"))).toBeLessThan(steps.indexOf(t));
    expect(steps.indexOf(t)).toBeLessThan(
      steps.indexOf(named("The deploy token's expiry")),
    );
  });

  // #1229: a fleet rollout starts only after the read-back passed.
  const evalIf = (
    step: Record<string, any>,
    inputs: Record<string, unknown>,
    outcomes: Record<string, string> = {},
    ok = true,
  ) =>
    new Function(
      "inputs",
      "steps",
      "success",
      "cancelled",
      `return (${(step.if as string)
        .replace(/^\$\{\{\s*/, "")
        .replace(/\s*\}\}$/, "")});`,
    )(
      inputs,
      Object.fromEntries(
        Object.entries(outcomes).map(([k, v]) => [k, { outcome: v }]),
      ),
      () => ok,
      () => false,
    ) as boolean;
  const ran = {
    deploy: "success",
    scheduler: "success",
    platform_tags: "success",
  };

  it("marks the platform verified only after a green read-back of a full-list run, verify_only included", () => {
    const m = named("Mark the platform verified");
    const i = (n: string) => steps.indexOf(named(n));
    expect(i("Mark the platform verified")).toBe(
      i("Every platform Worker runs the tag") + 1,
    );
    expect(named("Every platform Worker runs the tag").id).toBe(
      "platform_tags",
    );
    expect(m.run).toBe(
      'node --experimental-strip-types --no-warnings scripts/ops/platform-db.ts mark-verified "$DEPLOY_ENV" "$TAG"',
    );
    expect(m.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      TAG: "${{ inputs.tag }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    });
    // platform-db.ts is already main's copy (the deploy-scripts loop).
    expect(text).not.toContain("platform-verified");
    for (const verify_only of [false, true])
      for (const targets of [FULL, FULLB])
        expect(evalIf(m, { verify_only, targets }, ran), targets).toBe(true);
    // A partial list, verify_only or not, never marks.
    for (const verify_only of [false, true])
      expect(evalIf(m, { verify_only, targets: "scheduler" }, ran)).toBe(false);
    // A failed step before it, a failed read-back or a failed gate (success()
    // is false) means no mark.
    expect(evalIf(m, { verify_only: false, targets: FULL }, ran, false)).toBe(
      false,
    );
    expect(
      evalIf(
        m,
        { verify_only: false, targets: FULL },
        {
          ...ran,
          platform_tags: "failure",
        },
      ),
    ).toBe(false);
  });

  it("prod verify_only with the full list runs both staging gates before the mark; partial verify_only runs neither gate nor mark; other runs unchanged", () => {
    const i = (n: string) => steps.indexOf(named(n));
    const gates = [
      named("Staging passed this tag"),
      named("Staging's smoke is green at or after this tag"),
    ];
    const m = named("Mark the platform verified");
    for (const g of gates) {
      expect(i(g.name)).toBeLessThan(i("Mark the platform verified"));
      expect(evalIf(g, { env: "prod", verify_only: true, targets: FULL })).toBe(
        true,
      );
      expect(
        evalIf(g, { env: "prod", verify_only: true, targets: "zones" }),
      ).toBe(false);
      expect(
        evalIf(g, { env: "prod", verify_only: false, targets: "zones" }),
      ).toBe(true);
      expect(
        evalIf(g, { env: "staging", verify_only: true, targets: FULL }),
      ).toBe(false);
    }
    // A failed gate fails the job: nothing after it runs under success().
    expect(
      evalIf(m, { env: "prod", verify_only: true, targets: FULL }, ran, false),
    ).toBe(false);
    expect(
      evalIf(m, { env: "prod", verify_only: true, targets: "zones" }, ran),
    ).toBe(false);
  });

  it("a break-glass run that deployed clears every mark after its deploy, whatever the outcome; full and verify_only runs do not", () => {
    const u = named("Clear the platform verified marks (break-glass)");
    const i = (n: string) => steps.indexOf(named(n));
    expect(i(u.name)).toBeGreaterThan(i("Mark the platform verified"));
    expect(i(u.name)).toBeGreaterThan(i("Scheduler, last"));
    expect(u.run).toBe(
      'node --experimental-strip-types --no-warnings scripts/ops/platform-db.ts unmark-verified "$DEPLOY_ENV"',
    );
    expect(u.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    });
    const ev = (o: Record<string, unknown>, out: Record<string, string>) =>
      evalIf(u, o, out, false);
    const skipped = { deploy: "skipped", scheduler: "skipped" };
    // Even after a failed step (success() is false here).
    expect(
      ev(
        { verify_only: false, targets: "scheduler" },
        { deploy: "skipped", scheduler: "failure" },
      ),
    ).toBe(true);
    expect(
      ev(
        { verify_only: false, targets: "provisioner,dispatch" },
        { deploy: "failure", scheduler: "skipped" },
      ),
    ).toBe(true);
    // No deploy step ran, zones only, a full list, or verify_only: untouched.
    expect(ev({ verify_only: false, targets: "scheduler" }, skipped)).toBe(
      false,
    );
    expect(ev({ verify_only: false, targets: "zones" }, ran)).toBe(false);
    expect(ev({ verify_only: false, targets: FULL }, ran)).toBe(false);
    expect(ev({ verify_only: false, targets: FULLB }, ran)).toBe(false);
    expect(ev({ verify_only: true, targets: "scheduler" }, ran)).toBe(false);
  });

  it("passes the repository id for the OIDC principals, and reads back the token's expiry last", () => {
    expect(named("Deploy and verify").env.GITHUB_REPOSITORY_ID).toBe(
      "${{ github.repository_id }}",
    );
    const e = named("The deploy token's expiry");
    expect(steps.at(-1)).toBe(e);
    // A wrong or unverified token never opens a roll issue.
    expect(e.if).toBe(
      "${{ !cancelled() && steps.token_identity.outcome == 'success' }}",
    );
    expect(e.run).toBe(
      'bash "$RUNNER_TEMP/main-ci/deploy-token-expiry.sh" "$DEPLOY_ENV"',
    );
    expect(e.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      GH_TOKEN: "${{ github.token }}",
    });
  });

  // #1343: prod-release-chain.yml dispatches this file. A called workflow
  // resolves a secret its caller does not pass to empty even when the job's
  // Environment has it (run 42109047045), so there is no workflow_call: every
  // secret comes from the job's own Environment.
  it("has no workflow_call; the chain's two inputs are optional; the run name carries the chain id; the env is checked in the input step", () => {
    expect(w.on.workflow_call).toBeUndefined();
    expect(text.replace(/^\s*#.*$/gm, "")).not.toContain("workflow_call");
    const d = w.on.workflow_dispatch.inputs;
    expect(d.require_newer).toMatchObject({
      type: "boolean",
      required: false,
      default: false,
    });
    expect(d.chain_id).toMatchObject({
      type: "string",
      required: false,
      default: "",
    });
    expect(w["run-name"]).toContain("${{ inputs.chain_id");
    expect(d.env).toMatchObject({
      required: true,
      type: "choice",
      options: ["staging", "prod"],
    });
    expect(d.targets.default).toBe(FULL);
    // Every secret the job reads is the Environment's (or the repo's
    // OA_OWNER_EMAIL), none declared for a caller to pass.
    const named_ = new Set(text.match(/secrets\.([A-Z_]+)/g));
    expect([...named_].map((x) => x.slice(8)).sort()).toEqual([
      "ADMIN_IDENTITIES",
      "CLOUDFLARE_API_TOKEN",
      "FLEET_SMOKE_SHARE_TO",
      "FLEET_SMOKE_TOKEN",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_DIRECTORY_CLIENT_SECRET",
      "OA_OWNER_EMAIL",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
    // Defense in depth: the first step refuses
    // anything but staging or prod, before any checkout.
    const check = named("Check the inputs");
    const go = (DEPLOY_ENV: string) =>
      spawnSync("bash", ["-c", check.run], {
        env: {
          PATH: process.env.PATH,
          DEPLOY_ENV,
          TAG: "v0.90.3",
          TARGETS: FULL,
          REASON: "",
          VERIFY_ONLY: "false",
          OA_OWNER_EMAIL: "me@test.invalid",
        },
        encoding: "utf8",
      });
    expect(go("prod").status).toBe(0);
    expect(go("staging").status).toBe(0);
    for (const bad of ["", "dev", "prod ", "Prod", "prod\nstaging"]) {
      const r = go(bad);
      expect(r.status, bad).toBe(1);
      expect(r.stdout).toContain("env must be staging or prod");
    }
  });

  // #1343: the scheduler's tag is the fleet's target, so it deploys last,
  // after every other target and the zones: a run that stops partway never
  // moves the fleet.
  it("the scheduler deploys last, in its own step after the zones", () => {
    const i = (n: string) => steps.indexOf(named(n));
    expect(i("Scheduler, last")).toBe(i("Zones") + 1);
    expect(i("Every platform Worker runs the tag")).toBe(
      i("Scheduler, last") + 1,
    );
    const s = named("Scheduler, last");
    expect(s.if).toBe(
      "${{ contains(format(',{0},', inputs.targets), ',scheduler,') }}",
    );
    expect(s.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      DEPLOY_ENVIRONMENT:
        "${{ inputs.env == 'prod' && 'hosted-prod-deploy' || 'hosted-staging-deploy' }}",
      VERIFY_ONLY: "${{ inputs.verify_only && '1' || '' }}",
      DEPLOY_TAG: "${{ inputs.tag }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      FLEET_SMOKE_TOKEN: "${{ secrets.FLEET_SMOKE_TOKEN }}",
      FLEET_SMOKE_SHARE_TO: "${{ secrets.FLEET_SMOKE_SHARE_TO }}",
    });
    expect(s.run).toBe(
      'bash scripts/ops/deploy-hosted-platform.sh "$DEPLOY_ENV" scheduler',
    );
    // The loop deploys everything else, in order, and never the scheduler.
    const loop = named("Deploy and verify").run as string;
    expect(loop).toContain('[ "$t" = zones ] && continue');
    expect(loop).toContain('[ "$t" = scheduler ] && continue');
    const ran = (TARGETS: string) => {
      const r = spawnSync(
        "bash",
        [
          "-c",
          loop.replace(
            'bash scripts/ops/deploy-hosted-platform.sh "$DEPLOY_ENV" "$t"',
            'echo "$t"',
          ),
        ],
        {
          env: { PATH: process.env.PATH, DEPLOY_ENV: "prod", TARGETS },
          encoding: "utf8",
        },
      );
      return r.stdout
        .split("\n")
        .filter((l) => l && !l.startsWith("::"))
        .join(",");
    };
    expect(ran(FULL)).toBe(
      "platform-db,auth-broker,directory-broker,provision-token,provisioner,dispatch,inventory,provisioning",
    );
    expect(ran("scheduler")).toBe("");
  });

  it("require_newer (the chain's): the tag must be newer than prod's scheduler, before anything deploys", () => {
    const s = named("The tag is newer than prod's");
    const i = (n: string) => steps.indexOf(n === "" ? s : named(n));
    expect(s.if).toBe("${{ inputs.require_newer }}");
    // After the concurrency group is held (the job runs only then) and the
    // account id is loaded; before every lookup and deploy.
    expect(i("")).toBeGreaterThan(i("Load the hosted constants"));
    for (const n of [
      "Resolve the resource ids",
      "Deploy and verify",
      "Zones",
      "Scheduler, last",
    ])
      expect(i(""), n).toBeLessThan(i(n));
    expect(s.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      TAG: "${{ inputs.tag }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    });
    // main's copies, never the tag's.
    expect(s.run).toContain(
      'current="$(bash "$RUNNER_TEMP/main-ci/worker-tag.sh" prod scheduler)"',
    );
    // Run it with worker-tag.sh stubbed to print prod's current tag.
    const dir = mkdtempSync(join(tmpdir(), "require-newer-"));
    mkdirSync(join(dir, "main-ci"));
    copyFileSync(
      join(root, "scripts/ci/prod-release-chain.ts"),
      join(dir, "main-ci/prod-release-chain.ts"),
    );
    const go = (DEPLOY_ENV: string, TAG: string, current: string) => {
      writeFileSync(
        join(dir, "main-ci/worker-tag.sh"),
        `[ "$*" = "prod scheduler" ] || exit 9\n${current ? `echo ${current}` : "exit 1"}\n`,
      );
      return spawnSync("bash", ["-c", s.run], {
        env: { PATH: process.env.PATH, RUNNER_TEMP: dir, DEPLOY_ENV, TAG },
        encoding: "utf8",
      }).status;
    };
    expect(go("prod", "v0.99.0", "v0.98.3")).toBe(0);
    // A manual deploy of the same or a newer tag won the group: refuse.
    expect(go("prod", "v0.99.0", "v0.99.0")).not.toBe(0);
    expect(go("prod", "v0.99.0", "v0.100.0")).not.toBe(0);
    // prod's tag unreadable: refuse.
    expect(go("prod", "v0.99.0", "")).not.toBe(0);
    expect(go("staging", "v0.99.0", "v0.98.3")).not.toBe(0);
  });

  it("verifies the deploy token's identity right after the constants, before any step using CLOUDFLARE_API_TOKEN", () => {
    const names = steps.map((s) => s.name);
    const at = names.indexOf("The deploy token is the Environment's");
    expect(at).toBe(names.indexOf("Load the hosted constants") + 1);
    const first = steps.findIndex((s) =>
      JSON.stringify(s).includes("CLOUDFLARE_API_TOKEN"),
    );
    expect(first).toBe(at);
    // Fail-open guards: main's copy of the script, main's hosted constants,
    // exactly this line, and nothing that swallows a failure.
    const g = steps[at];
    expect(g.id).toBe("token_identity");
    expect(g.run).toBe(
      'bash "$RUNNER_TEMP/main-ci/deploy-token-identity.sh" "$DEPLOY_ENV" "$RUNNER_TEMP/main-ci/hosted"',
    );
    expect(g.if).toBeUndefined();
    expect(g["continue-on-error"]).toBeUndefined();
    expect(JSON.stringify(g)).not.toMatch(/\|\|\s*true|continue-on-error/);
    expect(g.shell).toBeUndefined();
    expect(text).toContain(
      "worker-tag.sh prod-release-chain.ts deploy-token-identity.sh;",
    );
  });
});
