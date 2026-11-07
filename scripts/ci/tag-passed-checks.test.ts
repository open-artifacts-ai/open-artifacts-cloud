import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

// tag-passed-checks.sh: a tag deploys only after every earlier check passed.
// Each condition, failed alone, stops the gate and is named; an API error is a
// failure, never a pass.
const SCRIPT = script("tag-passed-checks.sh");
const TAG = "v0.80.0";
const SHA = "c".repeat(40);
const REPO = "open-artifacts-ai/open-artifacts";

// gh api -X GET <path>: $STATE/<key>.json, or exit 1 when it is missing.
const gh = `
p="\${@: -1}"; p="\${p#repos/$REPO/}"
case "$p" in
  releases/tags/*) k=release ;;
  commits/*) k=commit ;;
  compare/*) k=compare ;;
  actions/workflows/release-please.yml/runs\\?*) k=runs ;;
  actions/runs/*/jobs\\?*) id="\${p#actions/runs/}"; id="\${id%%/*}"; k=jobs; [ -f "$STATE/jobs-$id.json" ] && k="jobs-$id" ;;
  *) exit 1 ;;
esac
[ -f "$STATE/$k.json" ] || { echo "HTTP 404" >&2; exit 1; }
cat "$STATE/$k.json"`;

type State = Record<string, unknown>;
const good = (): State => ({
  release: {
    tag_name: TAG,
    draft: false,
    prerelease: false,
    published_at: "2026-10-30T00:00:00Z",
    assets: [
      { name: "oa-release-staging-0.80.0.tar", state: "uploaded" },
      { name: "oa-release-prod-0.80.0.tar", state: "uploaded" },
    ],
  },
  commit: { sha: SHA },
  compare: { status: "behind" },
  runs: {
    workflow_runs: [
      {
        id: 41,
        head_sha: SHA,
        event: "push",
        status: "completed",
        conclusion: "success",
        created_at: "2026-10-30T00:00:00Z",
      },
    ],
  },
  jobs: {
    jobs: [
      "release-please",
      "verify-release",
      "hosted-guard",
      "hosted-build",
      "hosted-check",
      "hosted-sign-staging",
      "hosted-sign-prod",
      "hosted-attach-staging",
      "hosted-attach-prod",
    ].map((name) => ({ name, status: "completed", conclusion: "success" })),
  },
});

const run = (state: State, env = "prod", tag = TAG) => {
  const sb = sandbox({ gh });
  const dir = join(sb.dir, "state");
  mkdirSync(dir);
  for (const [k, v] of Object.entries(state))
    if (v !== undefined)
      writeFileSync(
        join(dir, `${k}.json`),
        typeof v === "string" ? v : JSON.stringify(v),
      );
  const r = sb.run(["bash", SCRIPT, env, tag], {
    env: {
      STATE: dir,
      REPO,
      GH_TOKEN: "gh-token-SHOULD-NEVER-APPEAR",
      GITHUB_REPOSITORY: REPO,
    },
  });
  expect(r.out + r.err).not.toContain("SHOULD-NEVER-APPEAR");
  return { ...r, calls: sb.log() };
};

// biome-ignore lint/suspicious/noExplicitAny: test fixtures
const edit = (f: (s: any) => void) => {
  const s = good();
  f(s);
  return s;
};
const jobIs = (name: string, conclusion: string | null) =>
  // biome-ignore lint/suspicious/noExplicitAny: test fixtures
  edit((s: any) => {
    s.jobs.jobs = s.jobs.jobs.map((j: { name: string }) =>
      j.name === name
        ? {
            name,
            status: conclusion === null ? "in_progress" : "completed",
            conclusion,
          }
        : j,
    );
  });

const extraJob = (name: string, status: string, conclusion: string | null) =>
  // biome-ignore lint/suspicious/noExplicitAny: test fixtures
  edit((s: any) => s.jobs.jobs.push({ name, status, conclusion }));

describe("tag-passed-checks.sh", () => {
  it("passes when every check holds, for both envs, reading only", () => {
    for (const env of ["staging", "prod"]) {
      const r = run(good(), env);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(`${TAG} passed every check for ${env}`);
      for (const c of r.calls.filter((c) => c.startsWith("gh ")))
        expect(c).toMatch(/^gh api -X GET /);
    }
    // identical (the tag is main's head) is on main too.
    expect(run(edit((s) => (s.compare.status = "identical"))).code).toBe(0);
  });

  const cases: [string, State, RegExp][] = [
    [
      "no release",
      edit((s) => delete s.release),
      /release v0\.80\.0: GitHub API error/,
    ],
    ["a draft", edit((s) => (s.release.draft = true)), /is a draft/],
    [
      "a prerelease",
      edit((s) => (s.release.prerelease = true)),
      /is a prerelease/,
    ],
    [
      "not published",
      edit((s) => (s.release.published_at = null)),
      /not published/,
    ],
    ["another tag", edit((s) => (s.release.tag_name = "v0.79.0")), /not found/],
    [
      "no commit",
      edit((s) => delete s.commit),
      /commit of v0\.80\.0: GitHub API error/,
    ],
    [
      "off main (ahead)",
      edit((s) => (s.compare.status = "ahead")),
      /not on main \(ahead\)/,
    ],
    [
      "off main (diverged)",
      edit((s) => (s.compare.status = "diverged")),
      /not on main/,
    ],
    [
      "compare error",
      edit((s) => delete s.compare),
      /on main: GitHub API error/,
    ],
    ["no push run", edit((s) => (s.runs.workflow_runs = [])), /no push run/],
    [
      "a run for another commit",
      edit((s) => (s.runs.workflow_runs[0].head_sha = "d".repeat(40))),
      /no push run/,
    ],
    [
      "a dispatch run",
      edit((s) => (s.runs.workflow_runs[0].event = "workflow_dispatch")),
      /no push run/,
    ],
    [
      "latest run has a failed required job",
      (() => {
        const s = edit((x) =>
          x.runs.workflow_runs.push({
            ...x.runs.workflow_runs[0],
            id: 42,
            created_at: "2026-10-30T01:00:00Z",
          }),
        );
        // biome-ignore lint/suspicious/noExplicitAny: test fixtures
        const bad = JSON.parse(JSON.stringify((s as any).jobs));
        // biome-ignore lint/suspicious/noExplicitAny: test fixtures
        bad.jobs.find((j: any) => j.name === "hosted-check").conclusion =
          "failure";
        return { ...s, "jobs-42": bad };
      })(),
      /job hosted-check: failure/,
    ],
    [
      "deploy-prod failed",
      extraJob("deploy-prod", "completed", "failure"),
      /job deploy-prod: failure/,
    ],
    [
      "unknown extra job failed",
      extraJob("deploy-new-thing", "completed", "failure"),
      /job deploy-new-thing: failure/,
    ],
    [
      "extra job still running",
      extraJob("deploy-landing", "in_progress", null),
      /job deploy-landing: not completed \(in_progress\)/,
    ],
    [
      "runs error",
      edit((s) => delete s.runs),
      /release-please run: GitHub API error/,
    ],
    [
      "jobs error",
      edit((s) => delete s.jobs),
      /release-please jobs: GitHub API error/,
    ],
    [
      "verify-release failed",
      jobIs("verify-release", "failure"),
      /job verify-release: failure/,
    ],
    [
      "verify-release skipped",
      jobIs("verify-release", "skipped"),
      /job verify-release: skipped/,
    ],
    [
      "required job still running",
      jobIs("hosted-build", null),
      /job hosted-build: not completed \(in_progress\)/,
    ],
    [
      "required job cancelled",
      jobIs("hosted-guard", "cancelled"),
      /job hosted-guard: cancelled/,
    ],
    [
      "release-please job failed",
      jobIs("release-please", "failure"),
      /job release-please: failure/,
    ],
    [
      "hosted-sign-prod failed",
      jobIs("hosted-sign-prod", "failure"),
      /job hosted-sign-prod: failure/,
    ],
    [
      "more jobs than one page",
      edit((s) => (s.jobs.total_count = 150)),
      /more than one page/,
    ],
    [
      "hosted-check failed",
      jobIs("hosted-check", "failure"),
      /job hosted-check: failure/,
    ],
    [
      "hosted-attach-prod failed",
      jobIs("hosted-attach-prod", "failure"),
      /job hosted-attach-prod: failure/,
    ],
    [
      "hosted-attach-prod missing",
      edit(
        (s) =>
          (s.jobs.jobs = s.jobs.jobs.filter(
            (j: { name: string }) => j.name !== "hosted-attach-prod",
          )),
      ),
      /job hosted-attach-prod: missing/,
    ],
    [
      "no prod asset",
      edit(
        (s) =>
          (s.release.assets = [
            { name: "oa-release-staging-0.80.0.tar", state: "uploaded" },
          ]),
      ),
      /no oa-release-prod-\* asset/,
    ],
    [
      "prod asset not uploaded",
      edit((s) => (s.release.assets[1].state = "open")),
      /no oa-release-prod-\* asset/,
    ],
    [
      "unparsable release",
      { ...good(), release: "<html>" },
      /unparsable response/,
    ],
  ];
  it.each(cases)("fails closed on %s, naming the check", (_n, state, msg) => {
    const r = run(state);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^release gate failed: /m);
    expect(r.err).toMatch(msg);
    expect(r.out).not.toContain("passed every check");
  });

  it("passes when only npm jobs failed, the v0.122.0 case", () => {
    for (const run_ of [
      { status: "completed", conclusion: "failure" },
      { status: "in_progress", conclusion: null },
    ]) {
      const s = edit((x) => {
        Object.assign(x.runs.workflow_runs[0], run_);
        x.jobs.jobs.push(
          { name: "pack-npm", status: "completed", conclusion: "success" },
          { name: "publish-npm", status: "completed", conclusion: "failure" },
          { name: "deploy-demo", status: "completed", conclusion: "skipped" },
        );
      });
      for (const env of ["staging", "prod"]) {
        const r = run(s, env);
        expect(r.code, r.err).toBe(0);
        expect(r.out).toContain("passed every check");
      }
    }
  });

  it("passes with deploy-demo skipped", () => {
    expect(run(extraJob("deploy-demo", "completed", "skipped")).code).toBe(0);
  });

  it("staging needs hosted-attach-staging, not prod's", () => {
    const s = good();
    // biome-ignore lint/suspicious/noExplicitAny: test fixtures
    (s as any).jobs.jobs = (s as any).jobs.jobs.map((j: { name: string }) =>
      j.name === "hosted-attach-staging" ? { ...j, conclusion: "failure" } : j,
    );
    expect(run(s, "staging").err).toMatch(/job hosted-attach-staging: failure/);
    // Any non-npm job that failed in the run blocks every env.
    expect(run(s, "prod").err).toMatch(/job hosted-attach-staging: failure/);
  });

  it("refuses a bad env or tag before any call", () => {
    for (const [env, tag] of [
      ["dev", TAG],
      ["prod", "v0.80.0-rc.1"],
      ["prod", "main"],
    ] as const) {
      const r = run(good(), env, tag);
      expect(r.code).toBe(2);
      expect(r.calls).toEqual([]);
    }
  });
});

// Split mode (#1056 C3): the hosted jobs and assets are in the hosted repo's
// hosted-release run; the public release and its release-please run are read
// from PUBLIC_REPO. A tag with no release in the hosted repo is legacy: the
// old read of the public repo.
describe("tag-passed-checks.sh, two repos", () => {
  const CLOUD = "open-artifacts-ai/open-artifacts-cloud";
  const CSHA = "e".repeat(40);
  // gh api -X GET [-H ...] <path>: $STATE/<pub|cloud>-<key>.json; a missing file
  // is a 404, a <key>.err file is that error.
  const ghTwo = `
p="\${@: -1}"
case "$p" in
  repos/${REPO}/*) side=pub; p="\${p#repos/${REPO}/}" ;;
  repos/${CLOUD}/*) side=cloud; p="\${p#repos/${CLOUD}/}" ;;
  *) exit 1 ;;
esac
case "$p" in
  releases/tags/*) k=release ;;
  commits/*) k=commit ;;
  compare/*) k=compare ;;
  contents/PUBLIC_PIN\\?*) k=pin ;;
  actions/workflows/release-please.yml/runs\\?*) k=runs ;;
  actions/workflows/hosted-release.yml/runs\\?*) k=runs ;;
  actions/runs/*/jobs\\?*) k=jobs ;;
  *) exit 1 ;;
esac
k="$side-$k"
[ -f "$STATE/$k.err" ] && { cat "$STATE/$k.err" >&2; exit 1; }
[ -f "$STATE/$k.json" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
cat "$STATE/$k.json"`;

  const jobsOf = (names: string[]) => ({
    jobs: names.map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
    })),
  });
  const rel = (assets: string[]) => ({
    tag_name: TAG,
    draft: false,
    prerelease: false,
    published_at: "2026-10-30T00:00:00Z",
    assets: assets.map((name) => ({ name, state: "uploaded" })),
  });
  const runOf = (sha: string, extra: Record<string, unknown> = {}) => ({
    workflow_runs: [
      {
        id: 41,
        head_sha: sha,
        event: "push",
        display_title: "hosted-release",
        status: "completed",
        conclusion: "success",
        created_at: "2026-10-30T00:00:00Z",
        ...extra,
      },
    ],
  });
  const two = (): State => ({
    "pub-release": rel([]),
    "pub-commit": { sha: SHA },
    "pub-compare": { status: "behind" },
    "pub-runs": runOf(SHA),
    "pub-jobs": jobsOf(["release-please", "verify-release", "pack-npm"]),
    "cloud-release": rel([
      "oa-release-staging-0.80.0.tar",
      "oa-release-prod-0.80.0.tar",
    ]),
    "cloud-commit": { sha: CSHA },
    "cloud-compare": { status: "identical" },
    "cloud-runs": runOf(CSHA),
    "cloud-jobs": jobsOf([
      "mirror",
      "hosted-guard",
      "hosted-build",
      "hosted-check",
      "hosted-sign-staging",
      "hosted-sign-prod",
      "hosted-attach-staging",
      "hosted-attach-prod",
    ]),
    "cloud-pin": `tag=${TAG}\nsha=${SHA}\n`,
  });
  const runTwo = (state: State, env = "prod", repo = CLOUD) => {
    const sb = sandbox({ gh: ghTwo });
    const dir = join(sb.dir, "state");
    mkdirSync(dir);
    for (const [k, v] of Object.entries(state))
      if (v !== undefined)
        writeFileSync(
          join(dir, k.endsWith(".err") ? k : `${k}.json`),
          typeof v === "string" ? v : JSON.stringify(v),
        );
    const r = sb.run(["bash", SCRIPT, env, TAG], {
      env: {
        STATE: dir,
        GH_TOKEN: "gh-token-SHOULD-NEVER-APPEAR",
        GITHUB_REPOSITORY: repo,
      },
    });
    expect(r.out + r.err).not.toContain("SHOULD-NEVER-APPEAR");
    return { ...r, calls: sb.log() };
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixtures
  const tweak = (f: (s: any) => void): State => {
    const s = two();
    f(s);
    return s;
  };
  const cloudJob = (name: string, conclusion: string | null) =>
    // biome-ignore lint/suspicious/noExplicitAny: test fixtures
    tweak((s: any) => {
      s["cloud-jobs"].jobs = s["cloud-jobs"].jobs.map((j: { name: string }) =>
        j.name === name
          ? {
              name,
              status: conclusion === null ? "in_progress" : "completed",
              conclusion,
            }
          : j,
      );
    });

  it("passes when both halves hold, for both envs, reading only", () => {
    for (const env of ["staging", "prod"]) {
      const r = runTwo(two(), env);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(`${TAG} passed every check for ${env}`);
      expect(r.out).toContain(`hosted commit ${CSHA}`);
      for (const c of r.calls.filter((c) => c.startsWith("gh ")))
        expect(c).toMatch(/^gh api -X GET /);
    }
  });

  it("reads the hosted jobs and assets from the hosted repo, not the public one", () => {
    // The public run has no hosted-* jobs and no assets: still a pass.
    const r = runTwo(two());
    expect(r.code, r.err).toBe(0);
    const paths = r.calls.map((c) => c.split(" ").at(-1) ?? "");
    expect(
      paths.some((p) =>
        p.startsWith(
          `repos/${CLOUD}/actions/workflows/hosted-release.yml/runs`,
        ),
      ),
    ).toBe(true);
    expect(
      paths.some((p) =>
        p.startsWith(`repos/${REPO}/actions/workflows/release-please.yml/runs`),
      ),
    ).toBe(true);
    expect(
      paths.some((p) =>
        p.startsWith(`repos/${CLOUD}/actions/workflows/release-please.yml`),
      ),
    ).toBe(false);
  });

  const cases: [string, State, RegExp][] = [
    [
      "the public release is missing",
      tweak((s) => delete s["pub-release"]),
      /release v0\.80\.0: GitHub API error/,
    ],
    [
      "the public release is a prerelease",
      tweak((s) => (s["pub-release"].prerelease = true)),
      /is a prerelease/,
    ],
    [
      "the public commit is off public main",
      tweak((s) => (s["pub-compare"].status = "diverged")),
      /not on main \(diverged\)/,
    ],
    [
      "no public release-please push run",
      tweak((s) => (s["pub-runs"].workflow_runs = [])),
      /release-please run: no push run/,
    ],
    [
      "public verify-release failed",
      tweak((s) => {
        s["pub-jobs"].jobs[1].conclusion = "failure";
      }),
      /job verify-release: failure/,
    ],
    [
      "public verify-release missing",
      tweak((s) => {
        s["pub-jobs"].jobs = s["pub-jobs"].jobs.filter(
          (j: { name: string }) => j.name !== "verify-release",
        );
      }),
      /job verify-release: missing/,
    ],
    [
      "the hosted release is a draft",
      tweak((s) => (s["cloud-release"].draft = true)),
      /is a draft/,
    ],
    [
      "the hosted commit is off hosted main",
      tweak((s) => (s["cloud-compare"].status = "ahead")),
      /not on main \(ahead\)/,
    ],
    [
      "no hosted-release run",
      tweak((s) => (s["cloud-runs"].workflow_runs = [])),
      /hosted-release run: no push run/,
    ],
    [
      "only a dry run exists",
      tweak((s) => {
        s["cloud-runs"] = runOf(CSHA, {
          event: "workflow_dispatch",
          display_title: "hosted-release (dry run)",
        });
      }),
      /hosted-release run: no push run/,
    ],
    [
      "hosted-guard failed",
      cloudJob("hosted-guard", "failure"),
      /job hosted-guard: failure/,
    ],
    ["mirror skipped", cloudJob("mirror", "skipped"), /job mirror: skipped/],
    [
      "hosted-build still running",
      cloudJob("hosted-build", null),
      /job hosted-build: not completed \(in_progress\)/,
    ],
    [
      "hosted-check failed",
      cloudJob("hosted-check", "failure"),
      /job hosted-check: failure/,
    ],
    [
      "hosted-sign-prod failed",
      cloudJob("hosted-sign-prod", "failure"),
      /job hosted-sign-prod: failure/,
    ],
    [
      "hosted-attach-prod failed",
      cloudJob("hosted-attach-prod", "failure"),
      /job hosted-attach-prod: failure/,
    ],
    [
      "hosted-attach-prod missing",
      tweak((s) => {
        s["cloud-jobs"].jobs = s["cloud-jobs"].jobs.filter(
          (j: { name: string }) => j.name !== "hosted-attach-prod",
        );
      }),
      /job hosted-attach-prod: missing/,
    ],
    [
      "another hosted job failed",
      tweak((s) =>
        s["cloud-jobs"].jobs.push({
          name: "new-job",
          status: "completed",
          conclusion: "failure",
        }),
      ),
      /job new-job: failure/,
    ],
    [
      "no prod asset on the hosted release",
      tweak(
        (s) =>
          (s["cloud-release"].assets = [
            { name: "oa-release-staging-0.80.0.tar", state: "uploaded" },
          ]),
      ),
      /no oa-release-prod-\* asset/,
    ],
    [
      "an asset only on the public release",
      tweak((s) => {
        s["cloud-release"].assets = [];
        s["pub-release"].assets = [
          { name: "oa-release-prod-0.80.0.tar", state: "uploaded" },
        ];
      }),
      /no oa-release-prod-\* asset/,
    ],
    [
      "PUBLIC_PIN names another tag",
      tweak((s) => (s["cloud-pin"] = `tag=v0.79.0\nsha=${SHA}\n`)),
      /PUBLIC_PIN at e+: not v0\.80\.0/,
    ],
    [
      "PUBLIC_PIN names another public commit",
      tweak((s) => (s["cloud-pin"] = `tag=${TAG}\nsha=${"d".repeat(40)}\n`)),
      /PUBLIC_PIN at e+: not public commit c+/,
    ],
    [
      "PUBLIC_PIN unreadable",
      tweak((s) => delete s["cloud-pin"]),
      /PUBLIC_PIN at e+: GitHub API error/,
    ],
    [
      "the hosted release lookup errors (not a 404)",
      tweak((s) => {
        delete s["cloud-release"];
        s["cloud-release.err"] = "gh: Server Error (HTTP 500)";
      }),
      /release v0\.80\.0: GitHub API error/,
    ],
  ];
  it.each(cases)("fails closed on %s, naming the check", (_n, state, msg) => {
    const r = runTwo(state);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^release gate failed: /m);
    expect(r.err).toMatch(msg);
    expect(r.out).not.toContain("passed every check");
  });

  it("a successful run is not hidden by a later dry run", () => {
    const s = tweak((x) => {
      x["cloud-runs"].workflow_runs.push({
        ...x["cloud-runs"].workflow_runs[0],
        id: 99,
        event: "workflow_dispatch",
        display_title: "hosted-release (dry run)",
        created_at: "2026-10-30T09:00:00Z",
      });
    });
    const r = runTwo(s);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("run 41");
  });

  it("accepts a dispatched (non dry) hosted-release run", () => {
    const s = tweak((x) => {
      x["cloud-runs"] = runOf(CSHA, { event: "workflow_dispatch" });
    });
    expect(runTwo(s).code).toBe(0);
  });

  it("a tag with no hosted release is legacy: everything is read from the public repo", () => {
    const s = two();
    delete s["cloud-release"];
    // The legacy run carries the hosted jobs and assets, as before the split.
    s["pub-release"] = rel([
      "oa-release-staging-0.80.0.tar",
      "oa-release-prod-0.80.0.tar",
    ]);
    s["pub-jobs"] = jobsOf([
      "release-please",
      "verify-release",
      "hosted-guard",
      "hosted-build",
      "hosted-check",
      "hosted-sign-staging",
      "hosted-sign-prod",
      "hosted-attach-staging",
      "hosted-attach-prod",
    ]);
    const r = runTwo(s);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`commit ${SHA}`);
    expect(r.calls.some((c) => c.includes("hosted-release.yml"))).toBe(false);
  });

  it("a legacy tag still needs its hosted jobs in the public run", () => {
    const s = two();
    delete s["cloud-release"];
    // two() has no hosted jobs in the public run and no assets.
    const r = runTwo(s);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/job hosted-guard: missing/);
  });

  it("a hosted release does not make up for a failing public run", () => {
    const s = tweak((x) => {
      x["pub-jobs"].jobs[0].conclusion = "failure";
    });
    const r = runTwo(s);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/job release-please: failure/);
  });

  it("running in the public repo itself is always the legacy read", () => {
    const s = two();
    s["pub-release"] = rel([
      "oa-release-staging-0.80.0.tar",
      "oa-release-prod-0.80.0.tar",
    ]);
    s["pub-jobs"] = jobsOf([
      "release-please",
      "verify-release",
      "hosted-guard",
      "hosted-build",
      "hosted-check",
      "hosted-sign-staging",
      "hosted-sign-prod",
      "hosted-attach-staging",
      "hosted-attach-prod",
    ]);
    const r = runTwo(s, "prod", REPO);
    expect(r.code, r.err).toBe(0);
    expect(r.calls.some((c) => c.includes(CLOUD))).toBe(false);
  });
});
