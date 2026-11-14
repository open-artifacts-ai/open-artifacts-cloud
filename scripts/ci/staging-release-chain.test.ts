// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// staging-release-chain.yml (cloud #264 step 1): a published release starts
// the staging deploy, a green chain-dispatched staging deploy starts the gate,
// each once per tag, never for a manual or test run.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FULL_BILLING } from "./chain-dispatch.ts";
import {
  DEPLOY_TITLE_RE,
  dispatch,
  type Exec,
  plan,
} from "./staging-release-chain.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const text = read(".github/workflows/staging-release-chain.yml");
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const w: any = parse(text);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const deploy: any = parse(read(".github/workflows/deploy-hosted-platform.yml"));
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const publish: any = parse(read(".github/workflows/hosted-publish.yml"));
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const redline: any = parse(read(".github/workflows/redline-staging.yml"));

const REPO = "open-artifacts-ai/open-artifacts-cloud";
const TAG = "v0.99.0";
const BOT = "github-actions[bot]";

type World = {
  latest?: string;
  jobs?: { name: string; conclusion: string | null }[];
  deployRuns?: string[];
  gateRuns?: string[];
};
const world = (o: World = {}) => {
  const calls: string[][] = [];
  const exec: Exec = (_c, args) => {
    calls.push(args);
    const path = args[1] === "-X" ? (args[3] ?? "") : (args[1] ?? "");
    const json = (v: unknown) => ({
      code: 0,
      stdout: JSON.stringify(v),
      stderr: "",
    });
    if (args[0] === "workflow") return { code: 0, stdout: "", stderr: "" };
    if (path.endsWith("/releases/latest"))
      return json({ tag_name: o.latest ?? TAG });
    if (path.includes("/jobs"))
      return json({
        jobs: o.jobs ?? [
          { name: `publish-staging release ${TAG}`, conclusion: "success" },
        ],
      });
    if (path.includes("/workflows/deploy-hosted-platform.yml/"))
      return json({
        workflow_runs: (o.deployRuns ?? []).map((t, id) => ({
          id: id + 1,
          display_title: t,
        })),
      });
    if (path.includes("/workflows/redline-staging.yml/"))
      return json({
        workflow_runs: (o.gateRuns ?? []).map((t, id) => ({
          id: id + 1,
          display_title: t,
        })),
      });
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { exec, calls };
};
const afterPublish = (o: World = {}, over: Record<string, string> = {}) =>
  plan({
    exec: world(o).exec,
    repo: REPO,
    workflow: "hosted-publish",
    conclusion: "success",
    event: "workflow_run",
    branch: "main",
    title: "hosted-publish",
    actor: BOT,
    runId: "123",
    ...over,
  });
const CHAIN_TITLE = `deploy-hosted-platform staging ${TAG} [sc77-1]`;
const afterDeploy = (o: World = {}, over: Record<string, string> = {}) =>
  plan({
    exec: world(o).exec,
    repo: REPO,
    workflow: "deploy-hosted-platform",
    conclusion: "success",
    event: "workflow_dispatch",
    branch: "main",
    title: CHAIN_TITLE,
    actor: BOT,
    runId: "124",
    ...over,
  });
const skipped = (p: { go: boolean }) => expect(p.go).toBe(false);

describe("after hosted-publish: the staging deploy", () => {
  it("starts for a release published by hosted-release", () => {
    expect(afterPublish()).toEqual({ go: true, next: "deploy", tag: TAG });
  });
  it("skips a failed, cancelled or off-main run", () => {
    skipped(afterPublish({}, { conclusion: "failure" }));
    skipped(afterPublish({}, { conclusion: "cancelled" }));
    skipped(afterPublish({}, { branch: "other" }));
  });
  it("skips a manual or chain-dispatched publish (prod, floor, hand)", () => {
    skipped(afterPublish({}, { event: "workflow_dispatch" }));
  });
  it("skips a run that published no release (no release, floor, failed job)", () => {
    skipped(
      afterPublish({
        jobs: [{ name: "publish-staging none ", conclusion: "skipped" }],
      }),
    );
    skipped(
      afterPublish({
        jobs: [
          { name: `publish-staging release ${TAG}`, conclusion: "failure" },
        ],
      }),
    );
  });
  it("skips a tag that is not the newest release", () => {
    skipped(afterPublish({ latest: "v0.100.0" }));
  });
  it("never twice: any earlier deploy run for the tag, in any state, skips", () => {
    skipped(
      afterPublish({ deployRuns: [`deploy-hosted-platform staging ${TAG}`] }),
    );
    skipped(afterPublish({ deployRuns: [CHAIN_TITLE] }));
    // another tag, or prod, is no obstacle
    expect(
      afterPublish({
        deployRuns: [
          "deploy-hosted-platform staging v0.99.01",
          `deploy-hosted-platform prod ${TAG}`,
          "deploy-hosted-platform staging v0.98.0",
        ],
      }).go,
    ).toBe(true);
  });
  it("fails closed on an API error", () => {
    const exec: Exec = () => ({ code: 1, stdout: "", stderr: "HTTP 502" });
    expect(() =>
      plan({
        exec,
        repo: REPO,
        workflow: "hosted-publish",
        conclusion: "success",
        event: "workflow_run",
        branch: "main",
        title: "hosted-publish",
        actor: BOT,
        runId: "123",
      }),
    ).toThrow(/502/);
  });
});

describe("after the staging deploy: the gate", () => {
  it("starts for a deploy this chain dispatched", () => {
    expect(afterDeploy()).toEqual({ go: true, next: "gate", tag: TAG });
  });
  it("skips a failed deploy or one off main", () => {
    skipped(afterDeploy({}, { conclusion: "failure" }));
    skipped(afterDeploy({}, { branch: "x" }));
  });
  it("skips a manual deploy (no chain id), a prod deploy, a nightly-style title", () => {
    skipped(
      afterDeploy({}, { title: `deploy-hosted-platform staging ${TAG}` }),
    );
    skipped(
      afterDeploy({}, { title: `deploy-hosted-platform prod ${TAG} [c77-1]` }),
    );
    skipped(
      afterDeploy({}, { title: `deploy-hosted-platform prod ${TAG} [sc77-1]` }),
    );
    skipped(
      afterDeploy(
        {},
        { title: `deploy-hosted-platform staging ${TAG} [p77-1]` },
      ),
    );
    skipped(afterDeploy({}, { title: `${CHAIN_TITLE} x` }));
  });
  it("skips a deploy not dispatched by the bot, or not a dispatch", () => {
    skipped(afterDeploy({}, { actor: "someone" }));
    skipped(afterDeploy({}, { event: "push" }));
  });
  it("skips a stale tag", () => {
    skipped(afterDeploy({ latest: "v0.100.0" }));
  });
  it("never twice: any redline-staging run for the tag skips; another tag does not", () => {
    skipped(afterDeploy({ gateRuns: [`redline-staging ${TAG}`] }));
    expect(afterDeploy({ gateRuns: ["redline-staging v0.98.0"] }).go).toBe(
      true,
    );
  });
  it("ignores other workflows", () => {
    skipped(afterDeploy({}, { workflow: "ci" }));
  });
});

describe("dispatch", () => {
  const call = (o: World, next: "deploy" | "gate") => {
    const wd = world(o);
    const r = dispatch({
      exec: wd.exec,
      repo: REPO,
      next,
      tag: TAG,
      chainId: "sc9-1",
    });
    return { r, started: wd.calls.filter((a) => a[0] === "workflow") };
  };
  it("deploys staging with the tag and chain id only (default targets)", () => {
    const { r, started } = call({}, "deploy");
    expect(r.started).toBe(true);
    expect(started).toEqual([
      [
        "workflow",
        "run",
        "deploy-hosted-platform.yml",
        "--repo",
        REPO,
        "--ref",
        "main",
        "-f",
        "env=staging",
        "-f",
        `tag=${TAG}`,
        "-f",
        "chain_id=sc9-1",
      ],
    ]);
    const joined = started[0]?.join(" ") ?? "";
    for (const k of ["targets=", "verify_only", "reason", "require_newer"])
      expect(joined).not.toContain(k);
  });
  it("billing configured: the billing-inclusive full list; otherwise the default", () => {
    const wd = world();
    dispatch({
      exec: wd.exec,
      repo: REPO,
      next: "deploy",
      tag: TAG,
      chainId: "sc9-1",
      billing: true,
    });
    const a = wd.calls.find((c) => c[0] === "workflow") ?? [];
    expect(a).toContain(`targets=${FULL_BILLING}`);
    expect(FULL_BILLING).toContain("directory-broker,billing,provision-token");
    expect(call({}, "deploy").started[0]?.join(" ")).not.toContain("targets=");
    // the gate never takes targets
    expect(call({}, "gate").started[0]?.join(" ")).not.toContain("targets=");
  });
  it("dispatches the gate with the tag only", () => {
    const { started } = call({}, "gate");
    expect(started[0]?.slice(2)).toEqual([
      "redline-staging.yml",
      "--repo",
      REPO,
      "--ref",
      "main",
      "-f",
      `tag=${TAG}`,
    ]);
  });
  it("re-checks: a run that appeared meanwhile, or a newer release, starts nothing", () => {
    expect(call({ deployRuns: [CHAIN_TITLE] }, "deploy").started).toEqual([]);
    expect(
      call({ gateRuns: [`redline-staging ${TAG}`] }, "gate").started,
    ).toEqual([]);
    expect(call({ latest: "v1.0.0" }, "deploy").r.started).toBe(false);
  });
  it("refuses a bad tag or chain id", () => {
    const e = world().exec;
    expect(() =>
      dispatch({
        exec: e,
        repo: REPO,
        next: "gate",
        tag: "main",
        chainId: "sc1-1",
      }),
    ).toThrow();
    expect(() =>
      dispatch({ exec: e, repo: REPO, next: "gate", tag: TAG, chainId: "x y" }),
    ).toThrow();
  });
});

describe("the workflow", () => {
  it("is triggered only by completed hosted-publish and deploy runs on main", () => {
    expect(w.on).toEqual({
      workflow_run: {
        workflows: ["hosted-publish", "deploy-hosted-platform"],
        types: ["completed"],
        branches: ["main"],
      },
    });
    expect(w.permissions).toEqual({});
  });
  it("names exactly the workflows and run-names the script matches", () => {
    expect(publish.name).toBe("hosted-publish");
    expect(deploy.name).toBe("deploy-hosted-platform");
    expect(publish.jobs["publish-staging"].name).toBe(
      "publish-staging ${{ needs.resolve.outputs.kind }} ${{ needs.resolve.outputs.tag }}",
    );
    // the run-name builds the title DEPLOY_TITLE_RE expects
    expect(deploy["run-name"]).toBe(
      "deploy-hosted-platform ${{ inputs.env }} ${{ inputs.tag }}${{ inputs.chain_id && format(' [{0}]', inputs.chain_id) || '' }}",
    );
    expect(DEPLOY_TITLE_RE.test(CHAIN_TITLE)).toBe(true);
    expect(redline["run-name"]).toBe("redline-staging ${{ inputs.tag }}");
  });
  it("dispatches only inputs the target workflows declare, defaults for the rest", () => {
    const d = deploy.on.workflow_dispatch.inputs;
    for (const k of ["env", "tag", "chain_id"]) expect(d[k]).toBeDefined();
    expect(Object.keys(redline.on.workflow_dispatch.inputs)).toEqual(["tag"]);
    expect(d.verify_only.default).toBe(false);
    expect(d.reason.default).toBe("");
    expect(d.targets.default.split(",")).toHaveLength(10);
  });
  it("passes event fields through env, never into a script", () => {
    const steps = Object.values(w.jobs).flatMap(
      // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
      (j: any) => j.steps as { run?: string }[],
    );
    for (const s of steps) if (s.run) expect(s.run).not.toContain("${{");
    expect(text).toContain("github.event.workflow_run.display_title");
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const step = w.jobs.plan.steps.find((s: any) => s.id === "plan");
    expect(step.env.TITLE).toBe(
      "${{ github.event.workflow_run.display_title }}",
    );
  });
  it("gives actions: write to the dispatch job alone, behind a per-tag group", () => {
    expect(w.jobs.plan.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(w.jobs.dispatch.permissions).toEqual({
      contents: "read",
      actions: "write",
    });
    expect(w.jobs.dispatch.needs).toBe("plan");
    expect(w.jobs.dispatch.if).toBe("needs.plan.outputs.go == 'true'");
    expect(w.jobs.dispatch.concurrency.group).toContain(
      "needs.plan.outputs.tag",
    );
    expect(w.jobs.dispatch.concurrency["cancel-in-progress"]).toBe(false);
    for (const j of Object.values(w.jobs))
      expect((j as { environment?: unknown }).environment).toBeUndefined();
  });
  it("leaves prod-release-chain's trigger as it was", () => {
    const p = parse(read(".github/workflows/prod-release-chain.yml"));
    expect(p.on.workflow_run.workflows).toEqual(["redline-staging"]);
  });
});
