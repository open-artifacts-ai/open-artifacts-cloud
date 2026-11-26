// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// prod-release-chain.yml (#1343): a green, dispatched redline-staging run for
// a release tag deploys that tag to the prod platform. The tag comes only from
// the run's display title, which is redline-staging.yml's run-name; main's
// scripts prove it again before hosted-publish.yml and then
// deploy-hosted-platform.yml are dispatched, each step on the previous step's
// own completion event (cloud #264): nothing waits, sleeps or polls.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  APP_ACTOR,
  child,
  type Exec,
  fresh,
  isNewer,
  plan,
  published,
  report,
  result,
  start,
  TITLE_RE,
  tagOf,
} from "./prod-release-chain.ts";
import { APP_ACTOR as STAGING_APP_ACTOR } from "./staging-release-chain.ts";
import { root, sandbox, script } from "./stubs.ts";

const read = (p: string) => readFileSync(join(root, p), "utf8");
const text = read(".github/workflows/prod-release-chain.yml");
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const w: any = parse(text);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const redline: any = parse(read(".github/workflows/redline-staging.yml"));
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const deploy: any = parse(read(".github/workflows/deploy-hosted-platform.yml"));
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const publishWf: any = parse(read(".github/workflows/hosted-publish.yml"));
type Step = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const gateSteps: Record<string, any>[] = w.jobs.gate.steps;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const planStep: Record<string, any> = w.jobs.plan.steps.find(
  (s: Step) => s.id === "plan",
);
const named = (n: string) => {
  const s = gateSteps.find((x) => x.name === n || x.id === n);
  if (!s) throw new Error(`no step ${n}`);
  return s;
};
const REPO = "open-artifacts-ai/open-artifacts-cloud";
const TAG = "v0.99.0";
const SHA = "a".repeat(40);
const FULL =
  "platform-db,auth-broker,directory-broker,provision-token,provisioner,provisioning,dispatch,inventory,zones,scheduler";

/** The title redline-staging.yml gives a run for `tag`, from its run-name. */
const titleFor = (tag: string) =>
  String(redline["run-name"]).replace("${{ inputs.tag }}", tag);

/** Runs the tag step as the runner would: TITLE in env, output to a file. */
function tagStep(title: string) {
  const d = mkdtempSync(join(tmpdir(), "chain-tag-"));
  const out = join(d, "output");
  writeFileSync(out, "");
  const r = spawnSync("bash", ["-c", named("tag").run], {
    cwd: root,
    env: { PATH: process.env.PATH, TITLE: title, GITHUB_OUTPUT: out },
    encoding: "utf8",
  });
  return { status: r.status, output: readFileSync(out, "utf8") };
}

describe("prod-release-chain.yml", () => {
  it("starts only on completed redline-staging, hosted-publish and deploy-hosted-platform runs on main, with the switch on; no clock", () => {
    expect(w.on).toEqual({
      workflow_run: {
        workflows: [
          "redline-staging",
          "hosted-publish",
          "deploy-hosted-platform",
        ],
        types: ["completed"],
        branches: ["main"],
      },
    });
    // The names it listens for are each workflow's own.
    expect(redline.name).toBe("redline-staging");
    expect(deploy.name).toBe("deploy-hosted-platform");
    expect(publishWf.name).toBe("hosted-publish");
    // cloud #264: event-driven only. No schedule, no wait, no sleep, no poll.
    expect(w.on.schedule).toBeUndefined();
    expect(text).not.toMatch(/wait for its run|sleep |cron:/);
    expect(Object.keys(w.jobs)).toEqual([
      "plan",
      "gate",
      "start",
      "deploy",
      "finish",
      "report",
    ]);
    // The switch: nothing runs unless it is on (and plan checks it again).
    expect(w.jobs.plan.if).toBe("${{ vars.PROD_RELEASE_CHAIN == 'on' }}");
    expect(planStep.env.SWITCH).toBe("${{ vars.PROD_RELEASE_CHAIN }}");
    // Each step starts only on its own event, as the plan names it.
    expect(w.jobs.gate.needs).toBe("plan");
    expect(w.jobs.gate.if).toBe("needs.plan.outputs.step == 'gate'");
    expect(w.jobs.start.needs).toEqual(["plan", "gate"]);
    expect(w.jobs.start.if).toBe("needs.gate.outputs.go == 'true'");
    expect(w.jobs.deploy.needs).toBe("plan");
    expect(w.jobs.deploy.if).toBe("needs.plan.outputs.step == 'deploy'");
    expect(w.jobs.finish.needs).toBe("plan");
    expect(w.jobs.finish.if).toBe("needs.plan.outputs.step == 'report'");
  });

  it("no run-level concurrency (a pending step is never replaced by an unrelated event); the two starting jobs share the tag's group", () => {
    expect(w.concurrency).toBeUndefined();
    for (const j of ["start", "deploy"])
      expect(w.jobs[j].concurrency).toEqual({
        group: "prod-release-chain-${{ needs.plan.outputs.tag }}",
        "cancel-in-progress": false,
      });
    for (const j of ["plan", "gate", "finish", "report"])
      expect(w.jobs[j].concurrency).toBeUndefined();
  });

  it("least privilege: nothing at the top, each job only what it needs; no job token can dispatch", () => {
    expect(w.permissions).toEqual({});
    expect(w.jobs.plan.permissions).toEqual({ contents: "read" });
    for (const j of ["gate", "start", "deploy", "finish"])
      expect(w.jobs[j].permissions).toEqual({
        contents: "read",
        actions: "read",
      });
    expect(w.jobs.report.permissions).toEqual({
      contents: "read",
      issues: "write",
    });
    // The job tokens only read actions (a comment may say what the App holds).
    expect(text.replace(/^\s*#.*$/gm, "")).not.toMatch(/^\s+actions: write/m);
    expect(text).not.toMatch(/id-token|write-all|read-all|secrets: inherit/);
  });

  it("dispatches with the release App's token (a default-token run raises no workflow_run event), minted only in the main-only release-app Environment, right before the dispatch", () => {
    const envs = Object.fromEntries(
      Object.entries(w.jobs).map(([n, j]) => [
        n,
        (j as { environment?: string }).environment,
      ]),
    );
    expect(envs).toEqual({
      plan: undefined,
      gate: "hosted-prod-deploy",
      start: "release-app",
      deploy: "release-app",
      finish: undefined,
      report: undefined,
    });
    for (const j of ["start", "deploy"]) {
      const steps = w.jobs[j].steps as Step[];
      const ids = steps.map((s) => s.id ?? s.name ?? s.uses);
      const app = steps.find((s) => s.id === "app") as Step;
      const d = steps.find((s) => s.id === "dispatch") as Step;
      expect(ids.indexOf("app"), j).toBe(ids.indexOf("dispatch") - 1);
      expect(app.uses).toBe(
        "actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349",
      );
      expect(app.with).toEqual({
        "app-id": "${{ secrets.RELEASE_APP_ID }}",
        "private-key": "${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
        "permission-actions": "write",
      });
      // Minted only when something will be dispatched.
      expect(app.if).toBe("steps.start.outputs.go == 'true'");
      expect(d.if).toBe("steps.start.outputs.go == 'true'");
      expect(d.env?.GH_TOKEN).toBe("${{ steps.app.outputs.token }}");
    }
    // The App's secrets appear in those two steps only.
    const withSecret = Object.values(w.jobs).flatMap((j) =>
      ((j as { steps: Step[] }).steps ?? []).filter((s) =>
        JSON.stringify(s).includes("RELEASE_APP_"),
      ),
    );
    expect(withSecret).toHaveLength(2);
  });

  it("pins every action by SHA and keeps no git credentials", () => {
    for (const l of text.split("\n").filter((l) => /^\s*- uses: /.test(l)))
      expect(l).toMatch(/@[0-9a-f]{40} # v\d/);
    for (const job of Object.values(w.jobs) as { steps: Step[] }[])
      for (const s of job.steps) {
        if (!s.uses) continue;
        expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
        if (String(s.uses).startsWith("actions/checkout@")) {
          expect(s.with?.ref).toBe("${{ github.sha }}");
          expect(s.with?.["persist-credentials"]).toBe(false);
        }
      }
  });

  it("no expression in any run line: every value reaches a script through env", () => {
    for (const job of Object.values(w.jobs) as { steps: Step[] }[])
      for (const s of job.steps)
        if (s.run) expect(String(s.run), s.name).not.toContain("${{");
    // The event's untrusted fields are only ever env values.
    const tag = named("tag");
    expect(tag.env).toEqual({
      TITLE: "${{ github.event.workflow_run.display_title }}",
    });
    expect(named("This event is the newest green run for the tag").env).toEqual(
      {
        TAG: "${{ steps.tag.outputs.tag }}",
        HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
        GH_TOKEN: "${{ github.token }}",
      },
    );
    expect(planStep.env).toEqual({
      SWITCH: "${{ vars.PROD_RELEASE_CHAIN }}",
      WORKFLOW: "${{ github.event.workflow_run.path }}",
      CONCLUSION: "${{ github.event.workflow_run.conclusion }}",
      RUN_EVENT: "${{ github.event.workflow_run.event }}",
      BRANCH: "${{ github.event.workflow_run.head_branch }}",
      HEAD_REPO: "${{ github.event.workflow_run.head_repository.full_name }}",
      TITLE: "${{ github.event.workflow_run.display_title }}",
      ACTOR: "${{ github.event.workflow_run.actor.login }}",
      RUN_ID: "${{ github.event.workflow_run.id }}",
    });
    expect(planStep.run).toBe(
      'node --experimental-strip-types scripts/ci/prod-release-chain.ts plan --repo "$GITHUB_REPOSITORY" --switch "$SWITCH" --workflow "$WORKFLOW" --conclusion "$CONCLUSION" --event "$RUN_EVENT" --branch "$BRANCH" --head-repo "$HEAD_REPO" --title "$TITLE" --actor "$ACTOR" --run-id "$RUN_ID"',
    );
    expect(w.jobs.plan.outputs).toEqual({
      step: "${{ steps.plan.outputs.step }}",
      tag: "${{ steps.plan.outputs.tag }}",
      child: "${{ steps.plan.outputs.child }}",
    });
  });

  it("the tag parse matches redline-staging's run-name contract", () => {
    // The run-name the gate and staging-first-gate.sh read.
    expect(redline["run-name"]).toBe("redline-staging ${{ inputs.tag }}");
    expect(read("scripts/ci/staging-first-gate.sh")).toContain(
      '--arg title "redline-staging $tag"',
    );
    for (const tag of [TAG, "v1.2.3", "v10.20.30", "v0.0.1"]) {
      expect(tagOf(titleFor(tag))).toBe(tag);
      const r = tagStep(titleFor(tag));
      expect(r.status, tag).toBe(0);
      expect(r.output).toBe(`tag=${tag}\n`);
    }
    // Anything else stops the gate before a script sees it.
    for (const bad of [
      "redline-staging",
      "redline-staging ",
      "redline-staging v1.2",
      "redline-staging v1.2.3-rc.1",
      "redline-staging 1.2.3",
      "redline-staging v1.2.3 ",
      " redline-staging v1.2.3",
      "redline-staging  v1.2.3",
      "redline-staging v1.2.3\nredline-staging v9.9.9",
      "redline-staging v1.2.3\ntag=v9.9.9",
      "redline-staging v1.2.3;id",
      "redline-staging $(id)",
      "redline-nightly v1.2.3",
      "deploy-hosted-platform prod v1.2.3",
      "redline-staging v1234567.0.0",
    ]) {
      expect(TITLE_RE.test(bad), JSON.stringify(bad)).toBe(false);
      expect(() => tagOf(bad)).toThrow();
      const r = tagStep(bad);
      expect(r.status, JSON.stringify(bad)).not.toBe(0);
      expect(r.output, JSON.stringify(bad)).toBe("");
    }
  });

  it("the gate: main, then main's scripts, then the gates in order, each given the parsed tag", () => {
    expect(w.jobs.gate.environment).toBe("hosted-prod-deploy");
    expect(w.jobs.gate.outputs).toEqual({
      tag: "${{ steps.tag.outputs.tag }}",
      go: "${{ steps.fresh.outputs.go == 'true' && steps.newer.outputs.go == 'true' }}",
    });
    expect(gateSteps[0]).toMatchObject({
      name: "On main",
      env: { REF: "${{ github.ref }}" },
    });
    expect(gateSteps[0]?.run).toContain('[ "$REF" = refs/heads/main ]');
    expect(gateSteps.map((s) => s.name ?? s.uses)).toEqual([
      "On main",
      gateSteps[1]?.uses,
      gateSteps[2]?.uses,
      "The tag, from the red-line run's name",
      "Staging passed this tag",
      "Staging's smoke is green at or after this tag",
      "The tag passed every earlier check",
      "This event is the newest green run for the tag",
      "Load the hosted constants",
      "The tag is newer than prod's",
    ]);
    expect(gateSteps[1]?.with).toEqual({
      ref: "${{ github.sha }}",
      "sparse-checkout": "scripts/ci\n.github/hosted\n",
      "persist-credentials": false,
    });
    const tagged = { TAG: "${{ steps.tag.outputs.tag }}" };
    expect(named("Staging passed this tag")).toMatchObject({
      env: { ...tagged, GH_TOKEN: "${{ github.token }}" },
      run: 'bash scripts/ci/staging-first-gate.sh "$TAG"',
    });
    expect(
      named("Staging's smoke is green at or after this tag"),
    ).toMatchObject({
      env: { ...tagged, GH_TOKEN: "${{ github.token }}" },
      run: 'bash scripts/ci/staging-smoke-gate.sh "$TAG"',
    });
    expect(named("The tag passed every earlier check")).toMatchObject({
      env: { ...tagged, GH_TOKEN: "${{ github.token }}" },
      run: 'bash scripts/ci/tag-passed-checks.sh prod "$TAG"',
    });
    const fr = named("fresh");
    expect(fr.name).toBe("This event is the newest green run for the tag");
    expect(fr.run).toContain(
      'go="$(node --experimental-strip-types scripts/ci/prod-release-chain.ts fresh --repo "$GITHUB_REPOSITORY" --tag "$TAG" --head-sha "$HEAD_SHA")"',
    );
    // A stale event skips what follows, neutrally.
    expect(named("Load the hosted constants")).toMatchObject({
      if: "steps.fresh.outputs.go == 'true'",
      run: "bash scripts/ci/hosted-constants.sh prod .github/hosted > /dev/null",
    });
    const newer = named("newer");
    expect(newer.name).toBe("The tag is newer than prod's");
    expect(newer.if).toBe("steps.fresh.outputs.go == 'true'");
    expect(newer.env).toEqual({
      ...tagged,
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    });
    expect(newer.run).toContain(
      'current="$(bash scripts/ci/worker-tag.sh prod scheduler)"',
    );
    expect(newer.run).toContain(
      'go="$(node --experimental-strip-types scripts/ci/prod-release-chain.ts newer --tag "$TAG" --current "$current")"',
    );
    // Only that step sees a secret.
    expect(
      gateSteps.filter((s) => JSON.stringify(s).includes("secrets.")),
    ).toEqual([newer]);
    // The scripts it calls take exactly these arguments.
    const usage = (f: string) =>
      /^# Usage: (.*)$/m.exec(read(`scripts/ci/${f}`))?.[1] ?? "";
    expect(usage("staging-first-gate.sh")).toBe(
      "scripts/ci/staging-first-gate.sh vX.Y.Z",
    );
    expect(usage("staging-smoke-gate.sh")).toBe(
      "scripts/ci/staging-smoke-gate.sh vX.Y.Z",
    );
    expect(usage("tag-passed-checks.sh")).toBe(
      "scripts/ci/tag-passed-checks.sh staging|prod vX.Y.Z",
    );
  });

  it("start (after the gate): the publish, or the deploy when prod's bucket has the release, once, then ends", () => {
    const steps = w.jobs.start.steps as Step[];
    const st = steps.find((s) => s.id === "start") as Step;
    expect(st.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      TAG: "${{ needs.gate.outputs.tag }}",
    });
    expect(st.run).toBe(
      'node --experimental-strip-types scripts/ci/prod-release-chain.ts start --repo "$GITHUB_REPOSITORY" --after gate --tag "$TAG"',
    );
    const d = steps.find((s) => s.id === "dispatch") as Step;
    expect(d.env).toEqual({
      GH_TOKEN: "${{ steps.app.outputs.token }}",
      TAG: "${{ needs.gate.outputs.tag }}",
      NEXT: "${{ steps.start.outputs.next }}",
      // p for a publish, c for a deploy: the next step matches the run by it.
      CHAIN_ID:
        "${{ steps.start.outputs.next == 'publish' && 'p' || 'c' }}${{ github.run_id }}-${{ github.run_attempt }}",
    });
    expect(d.run).toBe(
      'node --experimental-strip-types scripts/ci/chain-dispatch.ts --workflow "$NEXT" --repo "$GITHUB_REPOSITORY" --tag "$TAG" --chain-id "$CHAIN_ID"',
    );
    expect(w.jobs.start["timeout-minutes"]).toBeLessThanOrEqual(10);
  });

  it("deploy (after the chain's publish ended): the publish is the chain's, for the tag, green, and in prod's bucket; then the deploy, once, then ends", () => {
    const steps = w.jobs.deploy.steps as Step[];
    expect(steps.map((s) => s.id ?? s.name ?? s.uses)).toEqual([
      "On main",
      steps[1]?.uses,
      steps[2]?.uses,
      "child",
      "start",
      "app",
      "dispatch",
    ]);
    const c = steps.find((s) => s.id === "child") as Step;
    expect(c.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      TAG: "${{ needs.plan.outputs.tag }}",
      CHILD: "${{ needs.plan.outputs.child }}",
    });
    expect(c.run).toBe(
      'node --experimental-strip-types scripts/ci/prod-release-chain.ts child --repo "$GITHUB_REPOSITORY" --workflow publish --run-id "$CHILD" --tag "$TAG"',
    );
    const st = steps.find((s) => s.id === "start") as Step;
    // A rerun still going (running) starts nothing.
    expect(st.if).toBe("steps.child.outputs.state == 'success'");
    expect(st.run).toBe(
      'node --experimental-strip-types scripts/ci/prod-release-chain.ts start --repo "$GITHUB_REPOSITORY" --after publish --tag "$TAG"',
    );
    const d = steps.find((s) => s.id === "dispatch") as Step;
    expect(d.env).toEqual({
      GH_TOKEN: "${{ steps.app.outputs.token }}",
      TAG: "${{ needs.plan.outputs.tag }}",
      CHAIN_ID: "c${{ github.run_id }}-${{ github.run_attempt }}",
    });
    expect(d.run).toBe(
      'node --experimental-strip-types scripts/ci/chain-dispatch.ts --repo "$GITHUB_REPOSITORY" --tag "$TAG" --chain-id "$CHAIN_ID"',
    );
    // The checkout has .github/hosted: the billing read of prod.json.
    expect(steps[1]?.with?.["sparse-checkout"]).toBe(
      "scripts/ci\n.github/hosted\n",
    );
    expect(w.jobs.deploy.outputs).toEqual({
      url: "${{ steps.child.outputs.url }}",
      note: "${{ steps.child.outputs.note || steps.dispatch.outputs.deploy_note }}",
    });
  });

  it("finish (after the chain's deploy ended) reads the deploy again and dispatches nothing", () => {
    const steps = w.jobs.finish.steps as Step[];
    const c = steps.find((s) => s.id === "child") as Step;
    expect(c.run).toBe(
      'node --experimental-strip-types scripts/ci/prod-release-chain.ts child --repo "$GITHUB_REPOSITORY" --workflow deploy --run-id "$CHILD" --tag "$TAG"',
    );
    expect(JSON.stringify(steps)).not.toMatch(/chain-dispatch|app-token/);
    expect(w.jobs.finish.outputs).toEqual({
      state: "${{ steps.child.outputs.state }}",
      url: "${{ steps.child.outputs.url }}",
      note: "${{ steps.child.outputs.note }}",
    });
  });

  it("the deploy it dispatches is deploy-hosted-platform.yml (no workflow_call): prod, every target, require_newer", () => {
    // The chain's inputs live in the script, pinned here: prod, the full list.
    const sh = read("scripts/ci/chain-dispatch.ts");
    expect(sh).toContain('"env=prod"');
    expect(sh).toContain('"require_newer=true"');
    expect(sh).toContain(
      `"platform-db,auth-broker,directory-broker,provision-token,provisioner,provisioning,dispatch,inventory,zones,scheduler"`,
    );
    expect(deploy.on.workflow_call).toBeUndefined();
    // The full list is the deploy's own: its read-back and no-break-glass
    // `if:`s compare against it.
    expect(deploy.on.workflow_dispatch.inputs.targets.default).toBe(FULL);
    const steps = deploy.jobs.deploy.steps as Record<string, string>[];
    const ifOf = (n: string) => steps.find((s) => s.name === n)?.if;
    // The full list with billing (#1568) is the same list the deploy accepts
    // on both envs; the chain carries it only when prod's billing prices are
    // filled in prod.json (chain-dispatch.test.ts).
    const FULLB = FULL.replace(
      "directory-broker,",
      "directory-broker,billing,",
    );
    expect(sh).toContain(`"${FULLB}"`);
    expect(sh).toContain("billingConfigured");
    expect(ifOf("Every platform Worker runs the tag")).toBe(
      `\${{ !cancelled() && (steps.deploy.outcome != 'skipped' || steps.scheduler.outcome != 'skipped') && (inputs.targets == '${FULL}' || inputs.targets == '${FULLB}') }}`,
    );
    expect(ifOf("Record the break-glass deploy")).toBe(
      `\${{ !inputs.verify_only && inputs.targets != '${FULL}' && inputs.targets != '${FULLB}' }}`,
    );
    // Its Environment and concurrency group resolve from inputs.env.
    expect(deploy.jobs.deploy.environment).toBe(
      "${{ inputs.env == 'prod' && 'hosted-prod-deploy' || 'hosted-staging-deploy' }}",
    );
    expect(deploy.concurrency.group).toBe("hosted-platform-${{ inputs.env }}");
  });

  it("reports every step the plan started, a failed plan or gate included, and nothing for an event that starts nothing", () => {
    const r = w.jobs.report;
    expect(r.needs).toEqual(["plan", "gate", "start", "deploy", "finish"]);
    expect(r.if).toBe(
      "${{ always() && needs.plan.result != 'skipped' && (needs.plan.result != 'success' || needs.plan.outputs.step != 'none') }}",
    );
    const step = r.steps.find(
      (s: { name?: string }) => s.name === "Keep the blocker issue in step",
    );
    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      TAG: "${{ needs.plan.outputs.tag }}",
      STEP: "${{ needs.plan.outputs.step }}",
      PLAN: "${{ needs.plan.result }}",
      GATE: "${{ needs.gate.result }}",
      START: "${{ needs.start.result }}",
      DEPLOY: "${{ needs.deploy.result }}",
      FINISH: "${{ needs.finish.result }}",
      STATE: "${{ needs.finish.outputs.state }}",
      RUN: "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
      DEPLOY_RUN: "${{ needs.finish.outputs.url || needs.deploy.outputs.url }}",
      DEPLOY_NOTE:
        "${{ needs.finish.outputs.note || needs.deploy.outputs.note || needs.start.outputs.note }}",
    });
    expect(step.run).toContain(
      'result="$(node --experimental-strip-types scripts/ci/prod-release-chain.ts result --step "$STEP" --plan "$PLAN" --gate "$GATE" --start "$START" --deploy "$DEPLOY" --finish "$FINISH" --state "$STATE")"',
    );
    expect(step.run).toContain(
      'node --experimental-strip-types scripts/ci/prod-release-chain.ts report --repo "$GITHUB_REPOSITORY" --tag "$TAG" --result "$result" --run "$RUN" --deploy-run "$DEPLOY_RUN" --deploy-note "$DEPLOY_NOTE"',
    );
  });
});

const APP = "open-artifacts-release[bot]";
it("the chain's App actor is the staging chain's (the same release App dispatches both)", () => {
  expect(APP_ACTOR).toBe(APP);
  expect(STAGING_APP_ACTOR).toBe(APP);
  // deploy-hosted-platform.yml copies prod-release-chain.ts alone (require-newer).
  expect(read("scripts/ci/prod-release-chain.ts")).not.toMatch(/from "\.\//);
});
const ev = (over: Partial<Parameters<typeof plan>[0]> = {}) =>
  plan({
    repo: REPO,
    switch: "on",
    workflow: ".github/workflows/redline-staging.yml",
    conclusion: "success",
    event: "workflow_dispatch",
    branch: "main",
    headRepo: REPO,
    title: `redline-staging ${TAG}`,
    actor: APP,
    runId: "4242",
    ...over,
  });
const PUB = {
  workflow: ".github/workflows/hosted-publish.yml",
  title: `hosted-publish prod ${TAG} [p77-1]`,
};
const DEP = {
  workflow: ".github/workflows/deploy-hosted-platform.yml",
  title: `deploy-hosted-platform prod ${TAG} [c78-1]`,
};

describe("plan: each step starts only on its own event", () => {
  it("a green dispatched red-line run starts the gate, for the tag its title names", () => {
    expect(ev()).toEqual({ step: "gate", tag: TAG });
    // The workflow path may carry a ref suffix.
    expect(
      ev({ workflow: ".github/workflows/redline-staging.yml@refs/heads/main" }),
    ).toEqual({ step: "gate", tag: TAG });
    // A title that is not a release's leaves the tag empty: the gate's own
    // tag step then fails red, and the report says so.
    expect(ev({ title: "redline-staging v1.2" })).toEqual({
      step: "gate",
      tag: "",
    });
  });
  it("a red, cancelled or called (nightly) red-line run starts nothing", () => {
    for (const over of [
      { conclusion: "failure" },
      { conclusion: "cancelled" },
      { event: "workflow_call" },
      { event: "schedule" },
    ])
      expect(ev(over).step, JSON.stringify(over)).toBe("none");
  });
  it("the chain's prod publish ending, in any conclusion, starts the deploy step for its tag, naming the run", () => {
    for (const conclusion of ["success", "failure", "cancelled"])
      expect(ev({ ...PUB, conclusion })).toEqual({
        step: "deploy",
        tag: TAG,
        child: "4242",
      });
  });
  it("the chain's prod deploy ending starts the report step for its tag", () => {
    expect(ev({ ...DEP, conclusion: "failure" })).toEqual({
      step: "report",
      tag: TAG,
      child: "4242",
    });
  });
  it("any other publish or deploy starts nothing: staging, a hand run, another actor, the other step's chain id, the default token", () => {
    for (const over of [
      // hosted-release's staging copy.
      { ...PUB, event: "workflow_run", title: "hosted-publish" },
      // A hand prod publish or deploy (no chain id).
      { ...PUB, title: `hosted-publish prod ${TAG}` },
      { ...DEP, title: `deploy-hosted-platform prod ${TAG}` },
      // The staging chain's deploy.
      { ...DEP, title: `deploy-hosted-platform staging ${TAG} [sc78-1]` },
      { ...DEP, title: `deploy-hosted-platform prod ${TAG} [sc78-1]` },
      // A chain id of the other step.
      { ...PUB, title: `hosted-publish prod ${TAG} [c77-1]` },
      { ...DEP, title: `deploy-hosted-platform prod ${TAG} [p78-1]` },
      { ...PUB, title: `hosted-publish staging ${TAG} [p77-1]` },
      // Not the release App.
      { ...PUB, actor: "github-actions[bot]" },
      { ...DEP, actor: "someone" },
      { ...DEP, actor: "other-app[bot]" },
      // Not a dispatch.
      { ...DEP, event: "push" },
      // A floor publish.
      { ...PUB, title: "hosted-publish prod 123 [p77-1]" },
    ])
      expect(ev(over).step, JSON.stringify(over)).toBe("none");
  });
  it("nothing on another branch, from another repository (a fork), with the switch off, or for another workflow", () => {
    for (const base of [{}, PUB, DEP])
      for (const over of [
        { branch: "feature" },
        { headRepo: "someone/fork" },
        { headRepo: "" },
        { switch: "off" },
        { switch: "" },
        { switch: "ON" },
      ])
        expect(ev({ ...base, ...over }).step, JSON.stringify(over)).toBe(
          "none",
        );
    expect(ev({ workflow: ".github/workflows/hosted-release.yml" }).step).toBe(
      "none",
    );
    expect(() => ev({ ...PUB, runId: "x1" })).toThrow("bad run id");
  });
  it("the step reads the event as the runner would: env in, step/tag/child out", () => {
    const d = mkdtempSync(join(tmpdir(), "chain-plan-"));
    const out = join(d, "output");
    const runPlan = (env: Record<string, string>) => {
      writeFileSync(out, "");
      const r = spawnSync("bash", ["-c", planStep.run], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: out,
          GITHUB_REPOSITORY: REPO,
          SWITCH: "on",
          CONCLUSION: "success",
          RUN_EVENT: "workflow_dispatch",
          BRANCH: "main",
          HEAD_REPO: REPO,
          ACTOR: APP,
          RUN_ID: "4242",
          ...env,
        },
        encoding: "utf8",
      });
      return { status: r.status, output: readFileSync(out, "utf8") };
    };
    expect(runPlan({ WORKFLOW: PUB.workflow, TITLE: PUB.title })).toEqual({
      status: 0,
      output: `step=deploy\ntag=${TAG}\nchild=4242\n`,
    });
    expect(
      runPlan({
        WORKFLOW: ".github/workflows/redline-staging.yml",
        TITLE: `redline-staging ${TAG}`,
      }),
    ).toEqual({ status: 0, output: `step=gate\ntag=${TAG}\n` });
    // A forged second line in the title never reaches the output.
    expect(
      runPlan({
        WORKFLOW: ".github/workflows/redline-staging.yml",
        TITLE: `redline-staging ${TAG}\ntag=v9.9.9`,
      }),
    ).toEqual({ status: 0, output: "step=gate\ntag=\n" });
    expect(
      runPlan({ WORKFLOW: DEP.workflow, TITLE: DEP.title, SWITCH: "off" }),
    ).toEqual({ status: 0, output: "step=none\n" });
  });
});

type Api = Record<string, unknown>;
const childRun = (over: Api = {}): Api => ({
  id: 4242,
  path: ".github/workflows/hosted-publish.yml",
  status: "completed",
  conclusion: "success",
  event: "workflow_dispatch",
  head_branch: "main",
  display_title: `hosted-publish prod ${TAG} [p77-1]`,
  html_url: "https://github.com/x/actions/runs/4242",
  actor: { login: APP },
  head_repository: { full_name: REPO },
  ...over,
});
const readChild = (
  r: Api | "fail",
  which: "publish" | "deploy" = "publish",
) => {
  const calls: string[][] = [];
  const res = child({
    exec: (_c, a) => {
      calls.push(a);
      return r === "fail"
        ? { code: 1, stdout: "", stderr: "HTTP 502" }
        : { code: 0, stdout: JSON.stringify(r), stderr: "" };
    },
    repo: REPO,
    which,
    runId: "4242",
    tag: TAG,
  });
  return { res, calls };
};

describe("child: the run that ended is read again by id, and must be the chain's own for the tag", () => {
  it("green, running (a rerun going) or failed, from its newest attempt", () => {
    const g = readChild(childRun());
    expect(g.res).toEqual({
      state: "success",
      url: "https://github.com/x/actions/runs/4242",
      conclusion: "success",
    });
    expect(g.calls).toEqual([
      ["api", "-X", "GET", `repos/${REPO}/actions/runs/4242`],
    ]);
    expect(
      readChild(childRun({ status: "in_progress", conclusion: null })).res
        .state,
    ).toBe("running");
    expect(readChild(childRun({ status: "queued" })).res.state).toBe("running");
    for (const conclusion of ["failure", "cancelled", "timed_out", null])
      expect(readChild(childRun({ conclusion })).res.state).toBe("failed");
    expect(
      readChild(
        childRun({
          path: ".github/workflows/deploy-hosted-platform.yml",
          display_title: `deploy-hosted-platform prod ${TAG} [c78-1]`,
        }),
        "deploy",
      ).res.state,
    ).toBe("success");
  });
  it("verifies the tag: a run for another tag, or not the chain's, throws (fail closed)", () => {
    for (const over of [
      { display_title: "hosted-publish prod v0.98.0 [p77-1]" },
      { display_title: `hosted-publish prod ${TAG}` },
      { display_title: `hosted-publish staging ${TAG} [p77-1]` },
      { path: ".github/workflows/deploy-hosted-platform.yml" },
      { event: "workflow_run" },
      { head_branch: "feature" },
      { head_repository: { full_name: "someone/fork" } },
      { actor: { login: "github-actions[bot]" } },
      { id: 1 },
    ])
      expect(() => readChild(childRun(over)), JSON.stringify(over)).toThrow(
        "is not this chain's prod publish",
      );
    // The publish's run is never taken for the deploy's.
    expect(() => readChild(childRun(), "deploy")).toThrow();
    expect(() => readChild("fail")).toThrow(/HTTP 502/);
    expect(() =>
      child({
        exec: () => ({ code: 0, stdout: "{}", stderr: "" }),
        repo: REPO,
        which: "publish",
        runId: "4242",
        tag: "v1.2",
      }),
    ).toThrow("not a release tag");
  });
  it("the step fails red on a failed run, naming it, and is neutral on a rerun still going", () => {
    const d = mkdtempSync(join(tmpdir(), "chain-child-"));
    const bin = join(d, "bin");
    mkdirSync(bin);
    const out = join(d, "output");
    const step = (w.jobs.finish.steps as Step[]).find(
      (s) => s.id === "child",
    ) as Step;
    const runStep = (r: Api) => {
      writeFileSync(join(d, "run.json"), JSON.stringify(r));
      writeFileSync(
        join(bin, "gh"),
        `#!/usr/bin/env bash\ncat "${d}/run.json"\n`,
        {
          mode: 0o755,
        },
      );
      writeFileSync(out, "");
      const p = spawnSync("bash", ["-c", String(step.run)], {
        cwd: root,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_OUTPUT: out,
          GITHUB_REPOSITORY: REPO,
          TAG,
          CHILD: "4242",
        },
        encoding: "utf8",
      });
      return {
        status: p.status,
        out: p.stdout,
        output: readFileSync(out, "utf8"),
      };
    };
    const dep = {
      path: ".github/workflows/deploy-hosted-platform.yml",
      display_title: `deploy-hosted-platform prod ${TAG} [c78-1]`,
    };
    const red = runStep(childRun({ ...dep, conclusion: "failure" }));
    expect(red.status).not.toBe(0);
    expect(red.output).toBe(
      "state=failed\nurl=https://github.com/x/actions/runs/4242\nnote=deploy run 4242 concluded failure: https://github.com/x/actions/runs/4242\n",
    );
    const going = runStep(childRun({ ...dep, status: "in_progress" }));
    expect(going.status).toBe(0);
    expect(going.output).toBe(
      "state=running\nurl=https://github.com/x/actions/runs/4242\n",
    );
    expect(going.out).toContain(
      "::notice title=Release chain waits for its event::",
    );
    const green = runStep(childRun(dep));
    expect(green.status).toBe(0);
    expect(green.output).toBe(
      "state=success\nurl=https://github.com/x/actions/runs/4242\n",
    );
  });
});

describe("start: what the chain dispatches next for the tag, never twice", () => {
  type W = {
    deploys?: Api[];
    publishes?: Api[];
    /** Completed hosted-publish runs whose publish-prod job for TAG succeeded. */
    inBucket?: boolean;
  };
  const chainRun = (which: "publish" | "deploy", over: Api = {}): Api => ({
    id: which === "publish" ? 501 : 601,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    head_branch: "main",
    display_title:
      which === "publish"
        ? `hosted-publish prod ${TAG} [p77-1]`
        : `deploy-hosted-platform prod ${TAG} [c78-1]`,
    actor: { login: APP },
    head_repository: { full_name: REPO },
    ...over,
  });
  const go = (after: "gate" | "publish", o: W = {}) => {
    const calls: string[] = [];
    const exec: Exec = (_c, a) => {
      const u = a.at(-1) ?? "";
      calls.push(u);
      const json = (v: unknown) => ({
        code: 0,
        stdout: JSON.stringify(v),
        stderr: "",
      });
      if (u.includes("/workflows/deploy-hosted-platform.yml/runs?"))
        return json({ workflow_runs: o.deploys ?? [] });
      if (
        u.includes("/workflows/hosted-publish.yml/runs?event=workflow_dispatch")
      )
        return json({ workflow_runs: o.publishes ?? [] });
      if (u.includes("/workflows/hosted-publish.yml/runs?"))
        return json({
          workflow_runs: o.inBucket
            ? [
                {
                  id: 900,
                  status: "completed",
                  conclusion: "success",
                  head_branch: "main",
                  head_repository: { full_name: REPO },
                },
              ]
            : [],
        });
      if (u.includes("/runs/900/jobs"))
        return json({
          jobs: [
            { name: `publish-prod release ${TAG}`, conclusion: "success" },
          ],
        });
      throw new Error(`unexpected ${u}`);
    };
    return { r: start({ exec, repo: REPO, after, tag: TAG }), calls };
  };
  it("after the gate: the publish; the deploy at once when prod's bucket has the release", () => {
    expect(go("gate").r).toEqual({ go: true, next: "publish" });
    expect(go("gate", { inBucket: true }).r).toEqual({
      go: true,
      next: "deploy",
    });
  });
  it("after a green publish: the deploy, and the bucket must have the release (else red)", () => {
    expect(go("publish", { inBucket: true }).r).toEqual({
      go: true,
      next: "deploy",
    });
    expect(() => go("publish")).toThrow("prod's bucket has no record");
  });
  it("nothing while the chain's publish or deploy of the tag is queued or running, or once its deploy succeeded", () => {
    for (const status of ["queued", "in_progress", "waiting", "pending"]) {
      const deploys = [chainRun("deploy", { status, conclusion: null })];
      expect(go("gate", { deploys }).r.go, status).toBe(false);
      expect(go("publish", { deploys, inBucket: true }).r.go, status).toBe(
        false,
      );
      const publishes = [chainRun("publish", { status, conclusion: null })];
      expect(go("gate", { publishes }).r).toEqual({
        go: false,
        why: `the chain's publish of ${TAG} is under way: its end is the next event`,
      });
    }
    expect(
      go("gate", { deploys: [chainRun("deploy")], inBucket: true }).r,
    ).toEqual({
      go: false,
      why: `the chain already deployed ${TAG}`,
    });
  });
  it("a failed earlier run does not block a new event", () => {
    const failed = { conclusion: "failure" };
    expect(go("gate", { publishes: [chainRun("publish", failed)] }).r).toEqual({
      go: true,
      next: "publish",
    });
    expect(
      go("publish", { deploys: [chainRun("deploy", failed)], inBucket: true })
        .r,
    ).toEqual({ go: true, next: "deploy" });
  });
  it("counts only the chain's own runs of this tag", () => {
    const going = { status: "in_progress", conclusion: null };
    for (const over of [
      { display_title: `deploy-hosted-platform prod v0.98.0 [c78-1]` },
      { display_title: `deploy-hosted-platform prod ${TAG}` },
      { display_title: `deploy-hosted-platform staging ${TAG} [sc78-1]` },
      { actor: { login: "someone" } },
      { head_branch: "feature" },
      { head_repository: { full_name: "someone/fork" } },
    ])
      expect(
        go("gate", { deploys: [chainRun("deploy", { ...going, ...over })] }).r,
        JSON.stringify(over),
      ).toEqual({ go: true, next: "publish" });
  });
  it("fails closed on an unreadable list or a bad tag", () => {
    expect(() =>
      start({
        exec: () => ({ code: 0, stdout: "{}", stderr: "" }),
        repo: REPO,
        after: "gate",
        tag: TAG,
      }),
    ).toThrow("unparsable");
    expect(() =>
      start({
        exec: () => ({ code: 1, stdout: "", stderr: "HTTP 502" }),
        repo: REPO,
        after: "gate",
        tag: TAG,
      }),
    ).toThrow();
    expect(() =>
      start({
        exec: () => ({ code: 0, stdout: "{}", stderr: "" }),
        repo: REPO,
        after: "gate",
        tag: "v1",
      }),
    ).toThrow("not a release tag");
  });
});

describe("result: one result for the blocker issue", () => {
  const r = (o: Partial<Parameters<typeof result>[0]>) =>
    result({
      step: "gate",
      plan: "success",
      gate: "skipped",
      start: "skipped",
      deploy: "skipped",
      finish: "skipped",
      state: "",
      ...o,
    });
  it("only the deploy's own green end is a success (closes the issue)", () => {
    expect(r({ step: "report", finish: "success", state: "success" })).toBe(
      "success",
    );
    // The gate and the publish step starting the next one leave it.
    expect(r({ gate: "success", start: "success" })).toBe("skipped");
    expect(r({ step: "deploy", deploy: "success" })).toBe("skipped");
  });
  it("red anywhere is red: the plan, a gate, a refused dispatch, a failed publish, a failed deploy", () => {
    expect(r({ plan: "failure" })).toBe("failure");
    expect(r({ plan: "" })).toBe("failure");
    expect(r({ gate: "failure" })).toBe("failure");
    expect(r({ gate: "success", start: "failure" })).toBe("failure");
    expect(r({ gate: "success", start: "cancelled" })).toBe("cancelled");
    expect(r({ step: "deploy", deploy: "failure" })).toBe("failure");
    expect(r({ step: "report", finish: "failure", state: "failed" })).toBe(
      "failure",
    );
  });
  it("a neutral skip, or a rerun still going, leaves the issue", () => {
    // A stale or repeated event: the gate is green with go false.
    expect(r({ gate: "success", start: "skipped" })).toBe("skipped");
    expect(r({ step: "report", finish: "success", state: "running" })).toBe(
      "skipped",
    );
    expect(r({ step: "none" })).toBe("skipped");
  });
});

type R = {
  id: number;
  status?: string;
  conclusion?: string | null;
  display_title?: string;
  head_branch?: string;
  head_sha?: string;
  event?: string;
  created_at?: string;
  head_repository?: { full_name: string };
};
const run = (over: R): R => ({
  status: "completed",
  conclusion: "success",
  display_title: `redline-staging ${TAG}`,
  head_branch: "main",
  head_sha: SHA,
  event: "workflow_dispatch",
  created_at: "2026-11-03T10:00:00Z",
  head_repository: { full_name: REPO },
  ...over,
});
const runsExec =
  (runs: R[] | "fail" | "junk", calls: string[][] = []): Exec =>
  (_c, args) => {
    calls.push(args);
    if (runs === "fail") return { code: 1, stdout: "", stderr: "HTTP 502" };
    if (runs === "junk") return { code: 0, stdout: "{}", stderr: "" };
    return {
      code: 0,
      stdout: JSON.stringify({ workflow_runs: runs }),
      stderr: "",
    };
  };

describe("fresh: this event is the newest green run for the tag", () => {
  const go = (runs: R[] | "fail" | "junk", headSha = SHA, tag = TAG) =>
    fresh({ exec: runsExec(runs), repo: REPO, tag, headSha });

  it("passes when the newest matching run has the event's head sha", () => {
    const calls: string[][] = [];
    expect(
      fresh({
        exec: runsExec([run({ id: 5 })], calls),
        repo: REPO,
        tag: TAG,
        headSha: SHA,
      }),
    ).toEqual({ run: 5, go: true });
    expect(calls[0]).toEqual([
      "api",
      "-X",
      "GET",
      "--jq",
      expect.stringContaining("workflow_runs"),
      `repos/${REPO}/actions/workflows/redline-staging.yml/runs?branch=main&status=success&event=workflow_dispatch&per_page=30`,
    ]);
  });

  it("a stale event: a newer green run for the tag has another sha", () => {
    const newer = "b".repeat(40);
    const runs = [
      run({ id: 9, head_sha: newer, created_at: "2026-11-03T12:00:00Z" }),
      run({ id: 5 }),
    ];
    // Stale: no error, a neutral skip.
    expect(go(runs)).toEqual({ run: 9, go: false });
    expect(go(runs, newer)).toEqual({ run: 9, go: true });
  });

  it("counts only what staging-first-gate.sh counts", () => {
    const other = "c".repeat(40);
    // Each is newer than the real one and has another sha, but doesn't count.
    const late = "2026-11-03T12:00:00Z";
    for (const over of [
      { conclusion: "failure" },
      { status: "in_progress" },
      { head_branch: "feature" },
      { event: "workflow_call" },
      { event: "schedule" },
      { head_repository: { full_name: "fork/open-artifacts" } },
      { display_title: "redline-staging v0.98.0" },
      { display_title: `redline-staging ${TAG} ` },
    ] as Partial<R>[])
      expect(
        go([
          run({ id: 9, head_sha: other, created_at: late, ...over }),
          run({ id: 5 }),
        ]),
        JSON.stringify(over),
      ).toEqual({ run: 5, go: true });
  });

  it("fails closed: no run, an API error, an unparsable answer, a bad sha or tag", () => {
    expect(() => go([])).toThrow(/no green/);
    expect(() => go("fail")).toThrow(/HTTP 502/);
    expect(() => go("junk")).toThrow(/unparsable/);
    expect(() => go([run({ id: 5 })], "")).toThrow(/head sha/);
    expect(() => go([run({ id: 5 })], "A".repeat(40))).toThrow(/head sha/);
    expect(() => go([run({ id: 5 })], SHA, "0.99.0")).toThrow(/release tag/);
  });
});

describe("newer: the tag is above what prod's scheduler runs", () => {
  it("compares numerically, part by part", () => {
    expect(isNewer("v0.100.0", "v0.99.9")).toBe(true);
    expect(isNewer("v1.0.0", "v0.999.999")).toBe(true);
    expect(isNewer("v0.99.1", "v0.99.0")).toBe(true);
    expect(isNewer("v0.99.0", "v0.99.0")).toBe(false);
    expect(isNewer("v0.98.9", "v0.99.0")).toBe(false);
    expect(isNewer("v0.9.0", "v0.10.0")).toBe(false);
  });

  it("a malformed current or tag throws, so the gate fails", () => {
    for (const [t, c] of [
      [TAG, ""],
      [TAG, "0.98.0"],
      [TAG, "v0.98.0-rc.1"],
      ["", "v0.98.0"],
    ] as const)
      expect(() => isNewer(t, c), `${t} ${c}`).toThrow();
    const cli = (mode: string, current: string) => {
      const r = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          script("prod-release-chain.ts"),
          mode,
          "--tag",
          TAG,
          "--current",
          current,
        ],
        { encoding: "utf8" },
      );
      return { status: r.status, out: r.stdout };
    };
    // The gate: not newer is a neutral skip (go=false, exit 0).
    expect(cli("newer", "v0.98.0")).toEqual({ status: 0, out: "go=true\n" });
    expect(cli("newer", TAG)).toEqual({ status: 0, out: "go=false\n" });
    expect(cli("newer", "v1.0.0")).toEqual({ status: 0, out: "go=false\n" });
    expect(cli("newer", "").status).not.toBe(0);
    // The deploy's re-check: not newer fails.
    expect(cli("require-newer", "v0.98.0")).toEqual({ status: 0, out: "" });
    expect(cli("require-newer", TAG).status).not.toBe(0);
    expect(cli("require-newer", "v1.0.0").status).not.toBe(0);
    expect(cli("require-newer", "").status).not.toBe(0);
  });
});

describe("report: one blocker issue while red", () => {
  const world = (open: { number: number; title: string }[]) => {
    const calls: string[][] = [];
    const exec: Exec = (_c, args) => {
      calls.push(args);
      const out = (v: unknown) => ({
        code: 0,
        stdout: JSON.stringify(v),
        stderr: "",
      });
      if (args[0] === "issue" && args[1] === "list") return out(open);
      if (args[0] === "label" && args[1] === "list")
        return out([{ name: "blocker" }]);
      return { code: 0, stdout: "", stderr: "" };
    };
    return { exec, calls };
  };
  const RUN = "https://github.com/x/actions/runs/1";

  it("red opens one, then refreshes it; the nightly's issue is not its own", () => {
    const a = world([{ number: 3, title: "Nightly red-line failed: v0.98.0" }]);
    expect(
      report({
        exec: a.exec,
        repo: REPO,
        tag: TAG,
        result: "failure",
        run: RUN,
      }),
    ).toEqual({ action: "opened" });
    const create = a.calls.find((c) => c[1] === "create");
    expect(create).toContain(`Prod release chain failed: ${TAG}`);
    expect(create).toContain("blocker");
    const b = world([
      { number: 4, title: "Prod release chain failed: v0.98.0" },
    ]);
    expect(
      report({
        exec: b.exec,
        repo: REPO,
        tag: TAG,
        result: "failure",
        run: RUN,
      }),
    ).toEqual({ action: "refreshed", issue: 4 });
  });

  it("a red issue never claims the fleet stayed put: it points at the read-back that runs after a failed deploy (#55)", () => {
    const a = world([]);
    report({ exec: a.exec, repo: REPO, tag: TAG, result: "failure", run: RUN });
    const create = a.calls.find((c) => c[1] === "create") ?? [];
    const body = create[create.indexOf("--body") + 1] ?? "";
    expect(body).not.toMatch(/did not move|never moves|stayed/);
    expect(body).toContain("Every platform Worker runs the tag");
    expect(body).toContain("the fleet follows it");
    expect(body).toContain("require_newer false");
  });

  it("a neutral skip (stale event, a release prod has) neither opens, refreshes nor closes it", () => {
    const a = world([
      { number: 4, title: "Prod release chain failed: v0.98.0" },
    ]);
    expect(
      report({
        exec: a.exec,
        repo: REPO,
        tag: TAG,
        result: "skipped",
        run: RUN,
      }),
    ).toEqual({ action: "none" });
    expect(a.calls).toEqual([]);
  });

  it("green closes it", () => {
    const a = world([
      { number: 4, title: "Prod release chain failed: v0.98.0" },
    ]);
    expect(
      report({
        exec: a.exec,
        repo: REPO,
        tag: TAG,
        result: "success",
        run: RUN,
      }),
    ).toEqual({ action: "closed", issues: [4] });
    expect(
      report({
        exec: world([]).exec,
        repo: REPO,
        tag: TAG,
        result: "success",
        run: RUN,
      }),
    ).toEqual({ action: "none" });
  });

  it("a failed gate with no tag still opens one, naming no tag", () => {
    const a = world([]);
    report({ exec: a.exec, repo: REPO, tag: "", result: "failure", run: RUN });
    expect(a.calls.find((c) => c[1] === "create")).toContain(
      "Prod release chain failed: no release tag",
    );
  });
});

// worker-tag.sh: curl is a stub; the token reaches it on stdin only.
describe("worker-tag.sh", () => {
  const TOK = "cfut_TOKEN_never_printed_0123456789";
  const ACCT = "26ac346086d4405f7a976d48747a2a75";
  const VID = "11111111-0000-4000-8000-111111111111";
  const curl = `cfg="$(cat)"
case "$cfg" in *"Bearer $TOK_EXPECT"*) ;; *) echo '{"success":false,"errors":[{"message":"bad token"}]}'; exit 0 ;; esac
url="\${@: -1}"; path="\${url#https://api.cloudflare.com/client/v4/accounts/$STUB_ACCT/workers/scripts/}"
case "$path" in
  */deployments) f="$STATE/deployments" ;;
  */versions/*) f="$STATE/version" ;;
  *) echo '{"success":false}'; exit 0 ;;
esac
echo "$path" >> "$STATE/paths"
[ -f "$f" ] || { echo '{"success":false,"errors":[{"code":10007}]}'; exit 0; }
cat "$f"`;
  const ok = (result: unknown) => JSON.stringify({ success: true, result });
  const deployments = (versions: unknown[]) =>
    ok({
      deployments: [
        {
          created_on: "2026-10-01T00:00:00Z",
          versions: [{ version_id: VID, percentage: 100 }],
        },
        { created_on: "2026-11-01T00:00:00Z", versions },
      ],
    });
  const go = (
    fx: { deployments?: string; version?: string },
    args = ["prod", "scheduler"],
  ) => {
    const sb = sandbox({ curl });
    const state = join(sb.dir, "state");
    mkdirSync(state);
    if (fx.deployments)
      writeFileSync(join(state, "deployments"), fx.deployments);
    if (fx.version) writeFileSync(join(state, "version"), fx.version);
    const r = sb.run(["bash", script("worker-tag.sh"), ...args], {
      env: {
        CLOUDFLARE_API_TOKEN: TOK,
        CLOUDFLARE_ACCOUNT_ID: ACCT,
        TOK_EXPECT: TOK,
        STUB_ACCT: ACCT,
        STATE: state,
      },
    });
    let paths = "";
    try {
      paths = readFileSync(join(state, "paths"), "utf8");
    } catch {}
    return { ...r, log: sb.log().join("\n"), paths };
  };
  const one = deployments([{ version_id: VID, percentage: 100 }]);
  const tagged = (tag: unknown) =>
    ok({ id: VID, annotations: { "workers/tag": tag } });

  it("prints the release the newest deployment serves, reading the env's Worker", () => {
    const r = go({ deployments: one, version: tagged("v0.98.0") });
    expect(r.code).toBe(0);
    expect(r.out).toBe("v0.98.0\n");
    expect(r.paths).toBe(
      `oa-p-scheduler/deployments\noa-p-scheduler/versions/${VID}\n`,
    );
    // The token never reaches argv.
    expect(r.log).not.toContain(TOK);
    expect(r.out + r.err).not.toContain(TOK);
  });

  it("fails closed, printing nothing: split, untagged, not a release, no deployment, API error", () => {
    const cases = {
      split: {
        deployments: deployments([
          { version_id: VID, percentage: 50 },
          { version_id: VID, percentage: 50 },
        ]),
        version: tagged("v0.98.0"),
      },
      untagged: { deployments: one, version: ok({ id: VID, annotations: {} }) },
      other: { deployments: one, version: tagged("hotfix") },
      rc: { deployments: one, version: tagged("v0.98.0-rc.1") },
      none: {
        deployments: ok({ deployments: [] }),
        version: tagged("v0.98.0"),
      },
      api: { version: tagged("v0.98.0") },
      noVersion: { deployments: one },
    };
    for (const [k, fx] of Object.entries(cases)) {
      const r = go(fx);
      expect(r.code, k).toBe(1);
      expect(r.out, k).toBe("");
    }
  });

  it("refuses an unknown env or app before any call", () => {
    for (const args of [
      ["dev", "scheduler"],
      ["prod", "zones"],
      ["prod", "../x"],
      ["prod"],
    ]) {
      const r = go({ deployments: one, version: tagged("v0.98.0") }, args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.paths).toBe("");
    }
  });
});

// The skip steps, run as the runner would: node stubbed to print go=...
describe("the gate's neutral skips", () => {
  const runStep = (name: string, go: string) => {
    const d = mkdtempSync(join(tmpdir(), "chain-skip-"));
    const bin = join(d, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), `#!/usr/bin/env bash\necho ${go}\n`, {
      mode: 0o755,
    });
    const out = join(d, "output");
    writeFileSync(out, "");
    const run = String(named(name).run).replace(
      "bash scripts/ci/worker-tag.sh prod scheduler",
      "echo v0.98.0",
    );
    const r = spawnSync("bash", ["-c", run], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: out,
        TAG,
        HEAD_SHA: SHA,
        GITHUB_REPOSITORY: REPO,
      },
      encoding: "utf8",
    });
    return {
      status: r.status,
      out: r.stdout,
      output: readFileSync(out, "utf8"),
    };
  };
  for (const step of ["fresh", "newer"]) {
    it(`${step}: go=false is green with a notice, and the output says so`, () => {
      const r = runStep(step, "go=false");
      expect(r.status).toBe(0);
      expect(r.output).toBe("go=false\n");
      expect(r.out).toContain("::notice title=Release chain skipped::");
      const ok = runStep(step, "go=true");
      expect(ok.status).toBe(0);
      expect(ok.output).toBe("go=true\n");
      expect(ok.out).not.toContain("::notice");
    });
  }
  it("published: true only when a main hosted-publish run's publish-prod job for the tag succeeded", () => {
    const run = (
      jobsByRun: Record<number, { name: string; conclusion: string }[]>,
    ) =>
      published({
        repo: "o/r",
        tag: "v1.2.3",
        exec: (_c, a) => {
          const u = a.at(-1) ?? "";
          if (u.includes("/workflows/hosted-publish.yml/runs"))
            return {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({
                workflow_runs: Object.keys(jobsByRun).map((id) => ({
                  id: Number(id),
                  status: "completed",
                  conclusion: "success",
                  head_branch: "main",
                  head_repository: { full_name: "o/r" },
                })),
              }),
            };
          const id = /runs\/(\d+)\/jobs/.exec(u)?.[1];
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({ jobs: jobsByRun[Number(id)] ?? [] }),
          };
        },
      });
    expect(run({})).toBe(false);
    // Real job list of run 42823274720 (v0.144.0), before the rename.
    const old = [
      { name: "resolve", conclusion: "success" },
      { name: "publish-staging release v1.2.3", conclusion: "success" },
      { name: "publish-prod", conclusion: "success" },
    ];
    expect(run({ 1: old })).toBe(true);
    // A plain publish-prod beside another tag's staging publish is not ours.
    expect(
      run({
        1: [
          { name: "publish-staging release v1.2.4", conclusion: "success" },
          { name: "publish-prod", conclusion: "success" },
        ],
      }),
    ).toBe(false);
    expect(
      run({
        1: old.map((j) =>
          j.name === "publish-prod" ? { ...j, conclusion: "failure" } : j,
        ),
      }),
    ).toBe(false);
    expect(
      run({
        1: [{ name: "publish-staging release v1.2.3", conclusion: "success" }],
      }),
    ).toBe(false);
    expect(
      run({
        1: [{ name: "publish-prod release v1.2.3", conclusion: "failure" }],
      }),
    ).toBe(false);
    expect(
      run({
        1: [{ name: "publish-prod release v1.2.4", conclusion: "success" }],
      }),
    ).toBe(false);
    expect(
      run({
        1: [],
        2: [{ name: "publish-prod release v1.2.3", conclusion: "success" }],
      }),
    ).toBe(true);
    // Fails closed on an API error.
    expect(() =>
      published({
        repo: "o/r",
        tag: "v1.2.3",
        exec: () => ({ code: 1, stdout: "", stderr: "boom" }),
      }),
    ).toThrow();
  });
  it("the report names the dispatched deploy run when there is one", () => {
    const calls: string[][] = [];
    const exec: Exec = (_c, a) => {
      calls.push(a);
      return {
        code: 0,
        stdout:
          a[0] === "issue" && a[1] === "list"
            ? "[]"
            : a[0] === "label"
              ? '[{"name":"blocker"}]'
              : "",
        stderr: "",
      };
    };
    report({
      exec,
      repo: "o/r",
      tag: "v1.2.3",
      result: "failure",
      run: "https://x/chain",
      deployRun: "https://x/deploy",
      deployNote: "cancelled the dispatched run https://x/deploy",
    });
    const body =
      (() => {
        const c = calls.find((x) => x[1] === "create") ?? [];
        return c[c.indexOf("--body") + 1];
      })() ?? "";
    expect(body).toContain("Deploy run: https://x/deploy");
    expect(body).toContain("cancelled the dispatched run https://x/deploy");
  });
});
