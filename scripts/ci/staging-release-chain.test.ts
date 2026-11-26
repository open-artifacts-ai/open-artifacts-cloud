// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// staging-release-chain.yml (cloud #264 steps 1 and 4): a cut release starts
// the staging deploy beside the staging copy; the gate starts once both the
// copy and a chain-dispatched staging deploy succeeded, each once per tag,
// never for a manual or test run.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FULL_BILLING } from "./chain-dispatch.ts";
import {
  APP_ACTOR,
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
const PUBLISH_PATH = ".github/workflows/hosted-publish.yml";
const RELEASE_PATH = ".github/workflows/hosted-release.yml";
const SHA = "a".repeat(40);
const DEPLOY_PATH = ".github/workflows/deploy-hosted-platform.yml";
const BOT = APP_ACTOR;

type Job = { name: string; conclusion: string | null };
type DeployRun =
  | string
  | {
      title: string;
      status?: string;
      conclusion?: string | null;
      actor?: string;
    };
type World = {
  latest?: string;
  /** The latest tag's commit. */
  tagSha?: string;
  /** The event hosted-publish run's jobs (run 123). */
  jobs?: Job[];
  /** The event hosted-release run's jobs (run 122); the default is a passed guard, no hosted-built job (before #469). */
  releaseJobs?: Job[];
  /** PUBLIC_PIN's tag at a commit; the default is the newest release's at every commit. */
  pins?: Record<string, string>;
  /** PUBLIC_PIN's public commit at a commit; the default is PUB at every commit. */
  pinShas?: Record<string, string>;
  /** hosted-publish runs, newest first; the default is run 123 alone. */
  publishRuns?: { id: number; event?: string; jobs: Job[] }[];
  deployRuns?: DeployRun[];
  gateRuns?: string[];
};
const PUB = "c".repeat(40);
const GUARD: Job = { name: "hosted-guard", conclusion: "success" };
const COPIED: Job = {
  name: `publish-staging release ${TAG}`,
  conclusion: "success",
};
const world = (o: World = {}) => {
  const calls: string[][] = [];
  const exec: Exec = (_c, args) => {
    calls.push(args);
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    const json = (v: unknown) => ({
      code: 0,
      stdout: JSON.stringify(v),
      stderr: "",
    });
    if (args[0] === "workflow") return { code: 0, stdout: "", stderr: "" };
    const publishRuns = o.publishRuns ?? [
      { id: 123, jobs: o.jobs ?? [COPIED] },
    ];
    const pinRef = /\/contents\/PUBLIC_PIN\?ref=([0-9a-f]{40})$/.exec(path);
    if (pinRef) {
      const at = pinRef[1] as string;
      const tag = o.pins?.[at] ?? o.latest ?? TAG;
      const pub = o.pinShas?.[at] ?? PUB;
      return { code: 0, stdout: `tag=${tag}\nsha=${pub}\n`, stderr: "" };
    }
    if (path.endsWith("/releases/latest"))
      return json({ tag_name: o.latest ?? TAG });
    if (path.includes("/commits/")) return json({ sha: o.tagSha ?? SHA });
    const jobsOf = /\/actions\/runs\/(\d+)\/jobs/.exec(path);
    if (jobsOf?.[1] === "122") return json({ jobs: o.releaseJobs ?? [GUARD] });
    if (jobsOf) {
      const r = publishRuns.find((p) => String(p.id) === jobsOf[1]);
      if (!r) throw new Error(`no run ${jobsOf[1]}`);
      return json({ jobs: r.jobs });
    }
    if (path.includes("/workflows/hosted-publish.yml/"))
      return json({
        workflow_runs: publishRuns.map((r) => ({
          id: r.id,
          event: r.event ?? "workflow_run",
          head_branch: "main",
        })),
      });
    if (path.includes("/workflows/deploy-hosted-platform.yml/"))
      return json({
        workflow_runs: (o.deployRuns ?? []).map((d, id) => {
          const r = typeof d === "string" ? { title: d } : d;
          return {
            id: id + 1,
            display_title: r.title,
            status: r.status,
            conclusion: r.conclusion,
            actor: { login: r.actor },
          };
        }),
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
const afterRelease = (o: World = {}, over: Record<string, string> = {}) =>
  plan({
    exec: world(o).exec,
    repo: REPO,
    workflow: RELEASE_PATH,
    conclusion: "success",
    event: "push",
    branch: "main",
    title: "hosted-release",
    actor: BOT,
    runId: "122",
    headSha: SHA,
    ...over,
  });
const afterPublish = (o: World = {}, over: Record<string, string> = {}) =>
  plan({
    exec: world(o).exec,
    repo: REPO,
    workflow: PUBLISH_PATH,
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
    workflow: DEPLOY_PATH,
    conclusion: "success",
    event: "workflow_dispatch",
    branch: "main",
    title: CHAIN_TITLE,
    actor: BOT,
    runId: "124",
    ...over,
  });
const skipped = (p: { go: boolean }) => expect(p.go).toBe(false);

describe("staging chain read retries", () => {
  it("one failed read then success still plans the deploy", () => {
    const inner = world().exec;
    let failed = false;
    const sleeps: number[] = [];
    const exec: Exec = (c, a) => {
      if (!failed && a.join(" ").includes("/jobs")) {
        failed = true;
        return { code: 1, stdout: "", stderr: "" };
      }
      return inner(c, a);
    };
    const p = plan({
      exec,
      sleep: (ms) => sleeps.push(ms),
      repo: REPO,
      workflow: PUBLISH_PATH,
      conclusion: "success",
      event: "workflow_run",
      branch: "main",
      title: "hosted-publish",
      actor: BOT,
      runId: "123",
    });
    expect(p).toEqual({ go: true, next: "deploy", tag: TAG });
    expect(sleeps).toEqual([2000]);
  });
});

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
        workflow: PUBLISH_PATH,
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
    skipped(afterDeploy({}, { actor: "other-app[bot]" }));
    skipped(afterDeploy({}, { actor: "github-actions[bot]" }));
    skipped(afterDeploy({}, { actor: "open-artifacts-release" }));
    expect(APP_ACTOR).toBe("open-artifacts-release[bot]");
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
  it("matches the workflow file, not the name (a run-name replaces the name)", () => {
    // the live event: name is the run's title, path is the file
    expect(afterDeploy({}, { workflow: DEPLOY_PATH }).go).toBe(true);
    expect(
      afterDeploy({}, { workflow: `${DEPLOY_PATH}@refs/heads/main` }).go,
    ).toBe(true);
    skipped(afterDeploy({}, { workflow: CHAIN_TITLE }));
    skipped(afterDeploy({}, { workflow: "deploy-hosted-platform" }));
    expect(afterPublish({}, { workflow: PUBLISH_PATH }).go).toBe(true);
    skipped(afterPublish({}, { workflow: "hosted-publish" }));
  });
  it("ignores other workflows", () => {
    skipped(afterDeploy({}, { workflow: ".github/workflows/ci.yml" }));
  });
});

describe("after hosted-release: the staging deploy starts beside the copy", () => {
  it("starts for the release the run cut (its commit is the newest tag's)", () => {
    expect(afterRelease()).toEqual({ go: true, next: "deploy", tag: TAG });
    // a real run dispatched by hand (dry_run false) has the same name
    expect(afterRelease({}, { event: "workflow_dispatch" }).go).toBe(true);
  });
  it("skips a dry run, a failed, cancelled or off-main run, another event", () => {
    skipped(afterRelease({}, { title: "hosted-release (dry run)" }));
    skipped(afterRelease({}, { conclusion: "failure" }));
    skipped(afterRelease({}, { conclusion: "cancelled" }));
    skipped(afterRelease({}, { branch: "other" }));
    skipped(afterRelease({}, { event: "schedule" }));
  });
  it("skips a run that built an older release than the newest", () => {
    // before #469: PUBLIC_PIN at the head names v0.98.0
    skipped(afterRelease({ pins: { [SHA]: "v0.98.0" } }));
    // after #469: its hosted-built job names v0.98.0
    skipped(
      afterRelease({
        releaseJobs: [
          GUARD,
          { name: `hosted-built v0.98.0 ${SHA}`, conclusion: "success" },
        ],
      }),
    );
  });
  it("skips a run whose guard did not pass (it built nothing)", () => {
    skipped(
      afterRelease({
        releaseJobs: [{ name: "hosted-guard", conclusion: "skipped" }],
      }),
    );
  });
  // The v0.246.1 recovery (run 45728492094): a dispatch on main's newer head
  // rebuilt the existing tag's older commit and succeeded. Its head is not
  // the tag's commit, yet it built the newest release.
  const OLD = "b".repeat(40);
  it("starts for a rebuild of the newest tag's older commit, by its hosted-built job (#469)", () => {
    const r = world({
      tagSha: OLD,
      releaseJobs: [
        GUARD,
        { name: `hosted-built ${TAG} ${OLD}`, conclusion: "success" },
      ],
      pins: { [SHA]: "v0.98.0" },
    });
    const p = plan({
      exec: r.exec,
      repo: REPO,
      workflow: RELEASE_PATH,
      conclusion: "success",
      event: "workflow_dispatch",
      branch: "main",
      title: "hosted-release",
      actor: BOT,
      runId: "122",
      headSha: SHA,
    });
    expect(p).toEqual({ go: true, next: "deploy", tag: TAG });
    // The marker names the release: PUBLIC_PIN is never read, and the
    // latest attempt's jobs are.
    expect(r.calls.some((c) => c.some((a) => a.includes("PUBLIC_PIN")))).toBe(
      false,
    );
    expect(
      r.calls.some((c) =>
        c.includes(
          `repos/${REPO}/actions/runs/122/jobs?filter=latest&per_page=100`,
        ),
      ),
    ).toBe(true);
  });
  it("starts for the same rebuild before #469, from what its guard checked", () => {
    // PUBLIC_PIN at the head and at the tag's older commit pin the same release
    expect(
      afterRelease({ tagSha: OLD }, { event: "workflow_dispatch" }),
    ).toEqual({ go: true, next: "deploy", tag: TAG });
  });
  it("fails closed when the built release doesn't hold now", () => {
    // the marker's tag has moved to another commit
    expect(() =>
      afterRelease({
        tagSha: OLD,
        releaseJobs: [
          GUARD,
          { name: `hosted-built ${TAG} ${SHA}`, conclusion: "success" },
        ],
      }),
    ).toThrow(/built v0\.99\.0 at a+, but v0\.99\.0 is at b+/);
    // two markers
    expect(() =>
      afterRelease({
        releaseJobs: [
          { name: `hosted-built ${TAG} ${SHA}`, conclusion: "success" },
          { name: `hosted-built v0.98.0 ${SHA}`, conclusion: "success" },
        ],
      }),
    ).toThrow(/several built releases/);
    // before #469: the tag's older commit pins another public release
    expect(() =>
      afterRelease({ tagSha: OLD, pinShas: { [OLD]: "d".repeat(40) } }),
    ).toThrow(/does not pin v0\.99\.0/);
    // a bad run id
    expect(() => afterRelease({}, { runId: "x" })).toThrow(/run id/);
  });
  it("a failed hosted-built job names nothing: the guard's rule decides", () => {
    expect(
      afterRelease({
        releaseJobs: [
          GUARD,
          { name: `hosted-built v0.98.0 ${SHA}`, conclusion: "failure" },
        ],
      }),
    ).toEqual({ go: true, next: "deploy", tag: TAG });
  });
  it("never twice: a deploy run for the tag in any state skips", () => {
    skipped(afterRelease({ deployRuns: [CHAIN_TITLE] }));
    skipped(
      afterRelease({ deployRuns: [`deploy-hosted-platform staging ${TAG}`] }),
    );
  });
  it("fails closed on a bad head sha", () => {
    expect(() => afterRelease({}, { headSha: "" })).toThrow(/head sha/);
    expect(() => afterRelease({}, { headSha: "main" })).toThrow(/head sha/);
  });
});

describe("after hosted-publish once the deploy started beside it", () => {
  const green = {
    title: CHAIN_TITLE,
    status: "completed",
    conclusion: "success",
    actor: BOT,
  };
  it("starts the gate when this chain's deploy already succeeded", () => {
    expect(afterPublish({ deployRuns: [green] })).toEqual({
      go: true,
      next: "gate",
      tag: TAG,
    });
  });
  it("waits while the deploy runs, and never gates on a failed one", () => {
    skipped(
      afterPublish({
        deployRuns: [{ ...green, status: "in_progress", conclusion: null }],
      }),
    );
    skipped(
      afterPublish({ deployRuns: [{ ...green, conclusion: "failure" }] }),
    );
  });
  it("a manual green deploy of the tag (no chain id, not the bot) never gates", () => {
    skipped(
      afterPublish({
        deployRuns: [
          { ...green, title: `deploy-hosted-platform staging ${TAG}` },
        ],
      }),
    );
    skipped(afterPublish({ deployRuns: [{ ...green, actor: "someone" }] }));
  });
  it("never twice: a gate run for the tag skips", () => {
    skipped(
      afterPublish({
        deployRuns: [green],
        gateRuns: [`redline-staging ${TAG}`],
      }),
    );
  });
});

describe("after the staging deploy: the gate waits for the staging copy", () => {
  const other: Job = { name: "publish-staging none ", conclusion: "skipped" };
  it("starts once a hosted-release publish run copied the tag", () => {
    expect(afterDeploy()).toEqual({ go: true, next: "gate", tag: TAG });
    // the copy is in an older run: the newest published nothing
    expect(
      afterDeploy({
        publishRuns: [
          { id: 200, jobs: [other] },
          { id: 123, jobs: [COPIED] },
        ],
      }).go,
    ).toBe(true);
    // its run may still be going (stage-prod after the copy)
    expect(
      afterDeploy({
        publishRuns: [
          {
            id: 123,
            jobs: [
              COPIED,
              { name: `stage-prod release ${TAG}`, conclusion: null },
            ],
          },
        ],
      }).go,
    ).toBe(true);
  });
  it("waits while the copy runs: its end starts the gate", () => {
    const p = afterDeploy({
      publishRuns: [
        { id: 123, jobs: [{ name: COPIED.name, conclusion: null }] },
        // an older green copy of the tag is not read past a running one
        { id: 99, jobs: [COPIED] },
      ],
    });
    skipped(p);
    expect(JSON.stringify(p)).toContain("staging copy");
  });
  it("a failed or missing copy never starts the gate", () => {
    skipped(
      afterDeploy({
        publishRuns: [
          { id: 123, jobs: [{ ...COPIED, conclusion: "failure" }] },
        ],
      }),
    );
    skipped(afterDeploy({ publishRuns: [] }));
    skipped(
      afterDeploy({
        publishRuns: [
          {
            id: 123,
            jobs: [
              {
                name: "publish-staging release v0.98.0",
                conclusion: "success",
              },
            ],
          },
        ],
      }),
    );
  });
  it("the newest copy decides: a newer failed copy keeps the gate shut over an older success", () => {
    for (const conclusion of ["failure", "cancelled"]) {
      const p = afterDeploy({
        publishRuns: [
          { id: 200, jobs: [{ ...COPIED, conclusion }] },
          { id: 123, jobs: [COPIED] },
        ],
      });
      skipped(p);
      expect(JSON.stringify(p), conclusion).toContain("staging copy");
    }
    // a newer success after an older failure opens it
    expect(
      afterDeploy({
        publishRuns: [
          { id: 200, jobs: [COPIED] },
          { id: 123, jobs: [{ ...COPIED, conclusion: "failure" }] },
        ],
      }).go,
    ).toBe(true);
    // a newer run that skipped the copy is passed over
    expect(
      afterDeploy({
        publishRuns: [
          { id: 200, jobs: [{ ...COPIED, conclusion: "skipped" }] },
          { id: 123, jobs: [COPIED] },
        ],
      }).go,
    ).toBe(true);
  });
  it("a manual publish's copy does not count", () => {
    skipped(
      afterDeploy({
        publishRuns: [{ id: 123, event: "workflow_dispatch", jobs: [COPIED] }],
      }),
    );
  });
});

describe("step 4 ordering: the gate starts once, after both, from whichever ends last", () => {
  const green = {
    title: CHAIN_TITLE,
    status: "completed",
    conclusion: "success",
    actor: BOT,
  };
  const running = { ...green, status: "in_progress", conclusion: null };
  const copying: Job = { name: COPIED.name, conclusion: null };
  it("hosted-release starts the deploy; the copy then sees it started and does not start another", () => {
    expect(afterRelease().go).toBe(true);
    // the copy ends while the deploy runs: neither a second deploy nor the gate
    skipped(afterPublish({ deployRuns: [running] }));
    // the deploy ends after the copy: the gate
    expect(afterDeploy({ deployRuns: [green] })).toEqual({
      go: true,
      next: "gate",
      tag: TAG,
    });
  });
  it("the deploy ends first: it waits, and the copy's end starts the gate", () => {
    skipped(
      afterDeploy({
        deployRuns: [green],
        publishRuns: [{ id: 123, jobs: [copying] }],
      }),
    );
    expect(afterPublish({ deployRuns: [green] })).toEqual({
      go: true,
      next: "gate",
      tag: TAG,
    });
  });
  it("the copy fails: neither end starts the gate, so nothing reaches prod", () => {
    const failed: Job = { ...COPIED, conclusion: "failure" };
    skipped(
      afterDeploy({
        deployRuns: [green],
        publishRuns: [{ id: 123, jobs: [failed] }],
      }),
    );
    skipped(
      afterPublish(
        { deployRuns: [green], jobs: [failed] },
        { conclusion: "failure" },
      ),
    );
  });
  it("the deploy fails: neither end starts the gate", () => {
    const red = { ...green, conclusion: "failure" };
    skipped(afterDeploy({ deployRuns: [red] }, { conclusion: "failure" }));
    skipped(afterPublish({ deployRuns: [red] }));
  });
  it("both ends see both green: the second finds the first's gate run and starts nothing", () => {
    expect(afterDeploy({ deployRuns: [green] }).go).toBe(true);
    skipped(
      afterPublish({
        deployRuns: [green],
        gateRuns: [`redline-staging ${TAG}`],
      }),
    );
    const wd = world({
      deployRuns: [green],
      gateRuns: [`redline-staging ${TAG}`],
    });
    expect(
      dispatch({
        exec: wd.exec,
        repo: REPO,
        next: "gate",
        tag: TAG,
        chainId: "sc9-1",
      }).started,
    ).toBe(false);
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
  it("is triggered only by completed hosted-release, hosted-publish and deploy runs on main", () => {
    expect(w.on).toEqual({
      workflow_run: {
        workflows: [
          "hosted-release",
          "hosted-publish",
          "deploy-hosted-platform",
        ],
        types: ["completed"],
        branches: ["main"],
      },
    });
    expect(w.permissions).toEqual({});
  });
  it("names exactly the workflows and run-names the script matches", () => {
    expect(publish.name).toBe("hosted-publish");
    // hosted-release's real runs are named exactly "hosted-release"; dry runs
    // add "(dry run)". hosted-publish follows the same completed runs.
    const release = parse(read(".github/workflows/hosted-release.yml"));
    expect(release.name).toBe("hosted-release");
    expect(release["run-name"]).toBe(
      "${{ inputs.dry_run && 'hosted-release (dry run)' || 'hosted-release' }}",
    );
    expect(publish.on.workflow_run.workflows).toEqual(["hosted-release"]);
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
    expect(text).not.toContain("vars.");
    expect(step.env.WORKFLOW).toBe("${{ github.event.workflow_run.path }}");
    expect(step.env.TITLE).toBe(
      "${{ github.event.workflow_run.display_title }}",
    );
    expect(step.env.HEAD_SHA).toBe("${{ github.event.workflow_run.head_sha }}");
    expect(step.run).toContain('--head-sha "$HEAD_SHA"');
  });
  it("dispatches with the release App's token (actions: write), never github.token", () => {
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const steps: any[] = w.jobs.dispatch.steps;
    const iApp = steps.findIndex((s) => s.id === "app");
    const iGo = steps.findIndex((s) =>
      /staging-release-chain\.ts dispatch/.test(s.run ?? ""),
    );
    expect(iApp).toBeGreaterThanOrEqual(0);
    expect(iApp).toBeLessThan(iGo);
    expect(steps[iApp].uses).toMatch(
      /^actions\/create-github-app-token@[0-9a-f]{40}$/,
    );
    expect(steps[iApp].with).toEqual({
      "app-id": "${{ secrets.RELEASE_APP_ID }}",
      "private-key": "${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
      "permission-actions": "write",
    });
    expect(steps[iGo].env.GH_TOKEN).toBe("${{ steps.app.outputs.token }}");
    // the default token is never the dispatch token
    expect(JSON.stringify(steps[iGo])).not.toContain("github.token");
  });
  it("gives the dispatch job read-only default permissions, behind a per-tag group", () => {
    expect(w.jobs.plan.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(w.jobs.dispatch.permissions).toEqual({ contents: "read" });
    expect(w.jobs.dispatch.needs).toBe("plan");
    expect(w.jobs.dispatch.if).toBe("needs.plan.outputs.go == 'true'");
    expect(w.jobs.dispatch.concurrency.group).toContain(
      "needs.plan.outputs.tag",
    );
    expect(w.jobs.dispatch.concurrency["cancel-in-progress"]).toBe(false);
    // Only the job that mints the release App token has an environment (#302).
    expect(w.jobs.dispatch.environment).toBe("release-app");
    for (const [name, j] of Object.entries(w.jobs))
      if (name !== "dispatch")
        expect((j as { environment?: unknown }).environment).toBeUndefined();
  });
  it("leaves prod-release-chain's trigger and order as they were (prod copies, then deploys)", () => {
    const p = parse(read(".github/workflows/prod-release-chain.yml"));
    expect(p.on.workflow_run.workflows).toEqual(["redline-staging"]);
    expect(p.jobs.publish.needs).toBe("gate");
    expect(p.jobs.deploy.needs).toEqual(["gate", "publish"]);
  });
});

describe("runs-list reads stay under spawnSync's 1 MiB buffer", () => {
  for (const f of [
    "chain-dispatch",
    "staging-release-chain",
    "prod-release-chain",
  ]) {
    it(`${f}: small page, --jq, maxBuffer backstop`, () => {
      const src = read(`scripts/ci/${f}.ts`);
      const lists = src.match(/actions\/workflows\/[^`]*\/runs\?[^`]*`/g) ?? [];
      expect(lists.length).toBeGreaterThan(0);
      for (const l of lists) expect(l).toMatch(/per_page=(20|30)`/);
      expect(src.match(/"--jq"/g)?.length).toBe(lists.length);
      expect(src).toMatch(/MAX_BUFFER = 16 \* 1024 \* 1024/);
      expect(src).toMatch(/maxBuffer: MAX_BUFFER/);
    });
  }
});
