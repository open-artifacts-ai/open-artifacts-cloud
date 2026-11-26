// Release watch (cloud #264, Lane 5 PR1): the pure core on recorded runs of
// v0.245.0 to v0.246.1, at pinned clocks, and the workflow's shape.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Exec } from "./gh-retry.ts";
import {
  BUILT_RE,
  type Config,
  compute,
  EARLIER_FLEET_RE,
  earlierFleetList,
  eta,
  FLEET_DONE_STEP,
  FLEET_WAIT_STEP,
  FLEET_WAKE_STEP,
  fleetStep,
  type HistoryEntry,
  ISSUE_TITLE,
  issueBody,
  issuePlan,
  type Job,
  lateFleetDone,
  limitOf,
  loadConfig,
  mergeHistory,
  namedTag,
  overruns,
  PROD_RE,
  type Pr,
  parseHistory,
  pct,
  pinSubject,
  type Release,
  type Run,
  STAGING_RE,
  stats,
  step,
  summary,
  supersede,
  syncIssue,
  tick,
  timeline,
  upgradeFleet,
} from "./release-watch.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const config: Config = loadConfig(read(".github/hosted/release-stages.json"));
const fx = JSON.parse(read("scripts/ci/release-watch.fixture.json")) as {
  releases: Release[];
  prs: Pr[];
  runs: Run[];
  merges: Record<string, string>;
};

const T = (hm: string) => `2026-11-25T${hm}Z`;
const ms = (iso: string) => Date.parse(iso);
/** The recorded world as it stood at `now`: later things not yet there, runs still going. */
function at(now: string) {
  const n = ms(now);
  return {
    releases: fx.releases.filter((r) => ms(r.publishedAt) <= n),
    prs: fx.prs
      .filter((p) => ms(p.createdAt) <= n)
      .map((p) => ({
        ...p,
        mergedAt: p.mergedAt && ms(p.mergedAt) <= n ? p.mergedAt : null,
      })),
    runs: fx.runs
      .filter((r) => ms(r.createdAt) <= n)
      .map((r) =>
        ms(r.updatedAt) > n
          ? { ...r, status: "in_progress", conclusion: null, updatedAt: now }
          : r,
      ),
    merges: fx.merges,
  };
}
const world = (now: string, w = at(now), history: HistoryEntry[] = []) =>
  compute({ ...w, history, config, now });
const tl = (tag: string, now: string, w = at(now)) =>
  supersede(
    w.releases.map((release) =>
      timeline({
        release,
        runs: w.runs,
        prs: w.prs,
        mergedAt: w.merges[release.tag],
        config,
        now,
      }),
    ),
  ).find((t) => t.tag === tag);
const row = (t: ReturnType<typeof tl>, name: string) =>
  t?.stages.find((s) => s.name === name);

describe("release-stages.json", () => {
  it("each stage waits on earlier stages' ends, merged to fleet; a run stage is timed from its own start", () => {
    const list = (k: string | string[] | undefined) =>
      k === undefined ? [] : Array.isArray(k) ? k : [k];
    for (const mode of ["pr", "direct"] as const) {
      const s = config.stages.filter((x) => !x.mode || x.mode === mode);
      expect(s[0]?.from).toBe("merged");
      expect(s[s.length - 1]?.name).toBe("fleet");
      for (let i = 1; i < s.length; i++) {
        const x = s[i] as (typeof s)[number];
        const ends = s.slice(0, i).map((y) => y.to);
        // What it waits on: its after, else its own start is an earlier end.
        for (const d of list(x.after ?? x.from))
          expect(ends, `${x.name} waits on ${d}`).toContain(d);
        // A stage with its own run starts at that run's start.
        if (x.after) expect(x.from).toBe(x.to.replace(/\.done$/, ".started"));
      }
    }
    // Since cloud #471 the staging copy and deploy both wait on hosted_release
    // and the red-line queue on both.
    const by = (n: string) => config.stages.find((x) => x.name === n);
    expect(by("staging_publish")?.after).toBe("hosted_release.done");
    expect(by("staging_deploy")?.after).toBe("hosted_release.done");
    expect(by("redline_queue")?.from).toEqual([
      "staging_publish.done",
      "staging_deploy.done",
    ]);
  });
  it("has a direct-pin stage beside the PR stages", () => {
    const d = config.stages.find((s) => s.name === "direct_pin");
    expect(d).toMatchObject({
      from: "published",
      to: "pinned",
      mode: "direct",
    });
    expect(
      config.stages.filter((s) => s.mode === "pr").map((s) => s.name),
    ).toEqual(["pin_open", "pin_merge"]);
  });
  it("measures fleet only where the prod deploy records it, with no usual time yet and no admin reads", () => {
    const f = config.stages.find((s) => s.name === "fleet");
    expect(f).toMatchObject({
      from: "fleet.started",
      to: "fleet.done",
      after: "prod_deploy.done",
      optional: true,
    });
    expect(f?.usual).toBeUndefined();
    expect(f?.todo).toMatch(/Fleet done/);
    expect(f?.todo).toMatch(/no admin reads/);
  });
  it("alerts past max(2 x usual, usual + 5 min); merge to every install only has a 20 min target", () => {
    expect(config.alertFactor).toBe(2);
    expect(config.alertFloor).toBe(5);
    expect(config.e2eTarget).toBe(20);
    expect(config).not.toHaveProperty("e2eWorst");
    for (const s of config.stages) {
      expect(s, s.name).not.toHaveProperty("budget");
      if (!s.optional) expect(s.usual, s.name).toBeGreaterThan(0);
    }
  });
  it("the usual times are the medians the note cites, release by release", () => {
    const raw = JSON.parse(read(".github/hosted/release-stages.json")) as {
      notes: string[];
    };
    const v: Record<string, number[]> = {};
    for (const n of raw.notes.filter((x) => x.startsWith("Measured v")))
      for (const m of n.matchAll(/(\w+) (\d+(?:\.\d+)?)(?: \(|,|\.$)/g)) {
        const k = m[1] as string;
        v[k] = [...(v[k] ?? []), Number(m[2])];
      }
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const h = Math.floor(s.length / 2);
      return s.length % 2
        ? s[h]
        : ((s[h - 1] as number) + (s[h] as number)) / 2;
    };
    expect(raw.notes.filter((x) => x.startsWith("Measured v"))).toHaveLength(
      23,
    );
    for (const s of config.stages.filter(
      (x) => !x.optional && x.name !== "direct_pin",
    ))
      expect(median(v[s.name] ?? []), s.name).toBeCloseTo(s.usual as number, 2);
  });
  it("refuses a measured stage with no usual time, and a missing alert factor or floor", () => {
    expect(() =>
      loadConfig(
        JSON.stringify({ stages: [{ name: "x", from: "a", to: "b" }] }),
      ),
    ).toThrow(/bad stage/);
    expect(() =>
      loadConfig(
        JSON.stringify({
          e2eTarget: 20,
          stages: [{ name: "x", from: "a", to: "b", usual: 1 }],
        }),
      ),
    ).toThrow(/alertFactor/);
    expect(() =>
      loadConfig(
        JSON.stringify({
          alertFactor: 2,
          e2eTarget: 20,
          stages: [{ name: "x", from: "a", to: "b", usual: 1 }],
        }),
      ),
    ).toThrow(/alertFloor/);
  });
});

describe("timeline on the recorded chain", () => {
  it("v0.245.1, the full chain within its usual times: every stage timed, no issue", () => {
    const now = T("19:50:00");
    const t = tl("v0.245.1", now);
    expect(t?.mode).toBe("pr");
    expect(
      Object.fromEntries(t?.stages.map((s) => [s.name, s.minutes]) ?? []),
    ).toEqual({
      tag: 3.6,
      pin_open: 1.8,
      pin_merge: 10,
      // Each run stage from its own start: the hand-off waits are not in it.
      hosted_release: 2.8,
      staging_publish: 3.9,
      staging_deploy: 4.7,
      redline_queue: 0.7,
      redline: 9.9,
      prod_publish: 1.9,
      prod_deploy: 4.4,
      fleet: undefined,
    });
    // A deploy before cloud #474 has no fleet steps: done at the prod deploy.
    expect(row(t, "fleet")?.state).toBe("unmeasured");
    expect(t?.e2eTo).toBe("prod deploy (fleet not yet measured)");
    expect(t?.doneAt).toBe(T("19:43:43"));
    expect(t?.e2e).toBe(45.8);
    const w = world(now);
    expect(w.over).toEqual([]);
    expect(issuePlan([], w.over, w.red, config)).toEqual({ action: "none" });
  });

  it("staging_deploy past its limit mid-flight opens the blocker naming the stage and release", () => {
    const now = T("19:30:00");
    const w = at(now);
    w.runs = w.runs
      .filter((r) => !r.path.endsWith("redline-staging.yml"))
      .map((r) =>
        r.title.startsWith("deploy-hosted-platform staging v0.245.1")
          ? { ...r, status: "in_progress", conclusion: null }
          : r,
      );
    const r = world(now, w);
    expect(r.over).toEqual([
      {
        tag: "v0.245.1",
        stage: "staging_deploy",
        kind: "in_flight",
        startedAt: T("19:20:38"),
        minutes: 9.4,
        usual: 4.3,
        limit: 9.3,
        url: expect.stringContaining("/actions/runs/"),
      },
    ]);
    expect(r.current.inFlight[0]).toMatchObject({
      tag: "v0.245.1",
      stage: "staging_deploy",
      state: "current",
      elapsed: 9.4,
      usual: 4.3,
      limit: 9.3,
    });
    const a = issuePlan([], r.over, r.red, config);
    expect(a.action).toBe("create");
    if (a.action === "create")
      expect(a.body).toContain(
        "- v0.245.1 staging_deploy: still going past 9.3 min (usual 4.3 min), started 2026-11-25T19:20:38Z.",
      );
  });

  it("no pin PR 7.5 minutes after the release is a pin_open stall; 4.5 minutes is under the 5 min floor", () => {
    const now = T("19:09:00");
    const w = at(now);
    w.prs = w.prs.filter((p) => p.ref !== "pin-bump/v0.245.1");
    const r = world(now, w);
    expect(r.over.map((o) => [o.tag, o.stage, o.minutes, o.limit])).toEqual([
      ["v0.245.1", "pin_open", 7.5, 7.15],
    ]);
    // Past twice its usual time (4.3 min), not past usual + 5 (7.15): no alert.
    const early = at(T("19:06:00"));
    early.prs = early.prs.filter((p) => p.ref !== "pin-bump/v0.245.1");
    expect(world(T("19:06:00"), early).over).toEqual([]);
    // With the PR there, the release has moved on and nothing is stuck.
    expect(world(now).over).toEqual([]);
  });

  it("a red stage is listed apart and opens no issue of its own", () => {
    const now = T("23:30:00");
    const w = at(now);
    w.runs = w.runs.map((r) =>
      r.path.endsWith("hosted-release.yml") && r.headSha.startsWith("e910df8c")
        ? {
            ...r,
            status: "completed",
            conclusion: "failure",
            attempt: 1,
            updatedAt: T("23:27:09"),
          }
        : r,
    );
    const r = world(now, w);
    expect(r.red).toEqual([
      {
        tag: "v0.246.1",
        stage: "hosted_release",
        url: expect.stringContaining("/actions/runs/"),
      },
    ]);
    // The red stage is no overrun: the red run's blocker covers it. Its
    // finished stages past twice their usual time still are (93 min to tag,
    // 37.6 min to merge the pin PR).
    expect(r.over.map((o) => [o.stage, o.kind, o.minutes])).toEqual([
      ["tag", "finished", 93],
      ["pin_merge", "finished", 37.6],
    ]);
    expect(issuePlan([], [], r.red, config)).toEqual({ action: "none" });
    expect(issueBody(r.over, r.red, config)).toContain(
      "Red, covered by that run's own blocker issue:\n- v0.246.1 hosted_release: https://",
    );
    expect(eta(tl("v0.246.1", now, w) as never, r.current.stages, now)).toBe(
      null,
    );
  });

  it("a release left behind when a newer one is pinned is superseded, not in flight", () => {
    const now = T("23:50:00");
    const t = tl("v0.246.0", now);
    expect(row(t, "redline")?.state).toBe("red");
    expect(t?.supersededBy).toBe("v0.246.1");
    expect(t?.closedAt).toBeUndefined();
    const r = world(now);
    expect(r.current.inFlight.map((x) => x.tag)).toEqual(["v0.246.1"]);
    expect(r.red).toEqual([]);
  });

  it("a superseded release closes when the newer one is done, counting to then", () => {
    const now = T("23:59:00");
    const w = at(now);
    const sha = "e910df8c";
    const done = (path: string, title: string, end: string): Run => ({
      ...(fx.runs[0] as Run),
      id: ms(end),
      path: `.github/workflows/${path}`,
      event: "workflow_dispatch",
      title,
      headSha: `${sha}${"0".repeat(32)}`,
      status: "completed",
      conclusion: "success",
      createdAt: end,
      startedAt: end,
      updatedAt: end,
    });
    w.runs = [
      ...w.runs
        .filter((r) => !r.headSha.startsWith(sha))
        .concat(
          w.runs
            .filter(
              (r) =>
                r.headSha.startsWith(sha) &&
                r.path.endsWith("hosted-release.yml"),
            )
            .map((r) => ({
              ...r,
              status: "completed",
              conclusion: "success",
              updatedAt: T("23:46:00"),
            })),
        ),
      {
        ...done("hosted-publish.yml", "hosted-publish", T("23:50:00")),
        event: "workflow_run",
        headSha: w.runs.find((r) => r.headSha.startsWith(sha))?.headSha ?? "",
      },
      done(
        "deploy-hosted-platform.yml",
        "deploy-hosted-platform staging v0.246.1 [sc1-1]",
        T("23:52:00"),
      ),
      done("redline-staging.yml", "redline-staging v0.246.1", T("23:54:00")),
      done(
        "hosted-publish.yml",
        "hosted-publish prod v0.246.1 [p1-1]",
        T("23:55:00"),
      ),
      done(
        "deploy-hosted-platform.yml",
        "deploy-hosted-platform prod v0.246.1 [c1-1]",
        T("23:57:00"),
      ),
    ];
    const t = tl("v0.246.0", now, w);
    expect(t?.closedAt).toBe(T("23:57:00"));
    expect(t?.e2e).toBe(244.8);
    const r = world(now, w);
    expect(r.history.find((h) => h.tag === "v0.246.0")).toMatchObject({
      supersededBy: "v0.246.1",
      doneAt: T("23:57:00"),
    });
    expect(r.history.find((h) => h.tag === "v0.246.1")?.doneAt).toBe(
      T("23:57:00"),
    );
  });

  it("a rerun counts its whole span, from the run's creation", () => {
    const red = fx.runs.find((r) => r.title === "redline-staging v0.246.0");
    expect(red?.attempt).toBe(2);
    expect(step([red as Run])).toMatchObject({
      state: "red",
      startedAt: T("20:20:17"),
    });
    const t = tl("v0.246.0", T("20:45:00"));
    expect(row(t, "redline_queue")?.minutes).toBe(0.4);
    expect(row(t, "redline")).toMatchObject({ state: "red", minutes: 24.7 });
  });

  it("a queued red-line run splits the wait for the gate from the run", () => {
    const now = T("19:27:00");
    const w = at(now);
    w.runs = w.runs.map((r) =>
      r.title === "redline-staging v0.245.1"
        ? { ...r, status: "queued", conclusion: null }
        : r,
    );
    const t = tl("v0.245.1", now, w);
    expect(row(t, "redline_queue")).toMatchObject({
      state: "current",
      startedAt: T("19:25:17"),
      minutes: 1.7,
    });
    expect(row(t, "redline")?.state).toBe("pending");
  });

  it("a direct pin commit is the direct_pin stage, with no PR stages", () => {
    const now = T("19:50:00");
    const w = at(now);
    w.prs = w.prs.filter((p) => p.ref !== "pin-bump/v0.245.1");
    w.runs = w.runs.map((r) =>
      r.commitMessage.startsWith("chore(pin): bump PUBLIC_PIN to v0.245.1")
        ? {
            ...r,
            commitMessage: "chore(pin): release public v0.245.1",
            commitAt: T("19:03:00"),
          }
        : r,
    );
    const t = tl("v0.245.1", now, w);
    expect(t?.mode).toBe("direct");
    expect(t?.stages.map((s) => s.name)).not.toContain("pin_open");
    expect(row(t, "direct_pin")).toMatchObject({ state: "done", minutes: 1.5 });
    // Its own run: the wait for it to start is not counted.
    expect(row(t, "hosted_release")?.minutes).toBe(2.8);
    expect(t?.doneAt).toBe(T("19:43:43"));
  });

  it("a release waiting for its pin uses pinMode", () => {
    const t = tl("v0.245.1", T("19:02:00"), { ...at(T("19:02:00")), prs: [] });
    expect(t?.mode).toBe(config.pinMode);
    expect(
      tl("v0.245.1", T("19:02:00"), { ...at(T("19:02:00")), prs: [] })
        ?.stages[1],
    ).toMatchObject({ state: "current" });
    const direct = { ...config, pinMode: "direct" as const };
    const w = at(T("19:02:00"));
    const d = timeline({
      release: w.releases.find((r) => r.tag === "v0.245.1") as Release,
      runs: w.runs,
      prs: [],
      mergedAt: fx.merges["v0.245.1"],
      config: direct,
      now: T("19:02:00"),
    });
    expect(d.mode).toBe("direct");
    expect(d.stages[1]).toMatchObject({ name: "direct_pin", state: "current" });
  });

  it("with no merge time the tag stage is done but untimed, and merge to every install stays unknown", () => {
    const now = T("19:50:00");
    const w = { ...at(now), merges: {} };
    const t = tl("v0.245.1", now, w);
    expect(row(t, "tag")).toMatchObject({ state: "done" });
    expect(row(t, "tag")?.minutes).toBeUndefined();
    // Never timed from the publish: that would undercount merge to every install.
    expect(t?.e2e).toBeUndefined();
  });

  it("the pin subject names exactly the tag", () => {
    expect(
      pinSubject("chore(pin): bump PUBLIC_PIN to v0.245.1 (#445)", "v0.245.1"),
    ).toBe(true);
    expect(pinSubject("chore(pin): release public v0.245.1", "v0.245.1")).toBe(
      true,
    );
    expect(
      pinSubject("chore(pin): bump PUBLIC_PIN to v0.245.10 (#9)", "v0.245.1"),
    ).toBe(false);
    expect(pinSubject("fix: v0.245.1", "v0.245.1")).toBe(false);
  });
});

// cloud #456 review: v0.246.1's staging publish ran on main fd2652f3, a
// recovery after the pin run's own publish failed, then staging deploy,
// red-line, prod publish and prod deploy at 01:07:55Z. Recorded from runs
// 45720938191, 45721473041, 45723885429, 45728845641, 45730519720,
// 45731023993, 45731553873, 45732780132, 45733048529 and v0.247.0's pin
// (PR #463, run 45738985811).
describe("a release across recovery runs (v0.246.1)", () => {
  const RUNS =
    "https://github.com/open-artifacts-ai/open-artifacts-cloud/actions/runs/";
  const MAIN = "fd2652f3061fa30f9009eca5c4171dd6ec7e65a0";
  const D = (hms: string) => `2026-11-26T${hms}Z`;
  const ok = (name: string) => ({ name, conclusion: "success" });
  const skipped = (name: string) => ({
    name: `${name} \${{ needs.resolve.outputs.kind }} \${{ needs.resolve.outputs.tag }}`,
    conclusion: "skipped",
  });
  const run = (
    file: string,
    o: Pick<Run, "id" | "event" | "title" | "createdAt" | "updatedAt"> &
      Partial<Run>,
  ): Run => ({
    path: `.github/workflows/${file}`,
    status: "completed",
    conclusion: "success",
    headSha: MAIN,
    startedAt: o.createdAt,
    attempt: 1,
    url: `${RUNS}${o.id}`,
    commitMessage:
      "fix(hosted-release): a re-run accepts an existing tag on an earlier main commit pinning the same release (#457)",
    commitAt: D("00:16:42"),
    ...o,
  });
  const pinRun = fx.runs.find((r) => r.id === 45720938191) as Run;
  const pinPublish = fx.runs.find((r) => r.id === 45721473041) as Run;
  const recovery = (): Run[] => [
    // The pin run went green on attempt 3.
    {
      ...pinRun,
      status: "completed",
      conclusion: "success",
      attempt: 3,
      startedAt: D("00:38:18"),
      updatedAt: D("00:41:25"),
    },
    {
      ...pinPublish,
      jobs: [
        ok("resolve"),
        { name: "publish-staging release v0.246.1", conclusion: "failure" },
      ],
    },
    run("hosted-publish.yml", {
      id: 45723885429,
      event: "workflow_run",
      title: "hosted-publish",
      headSha: "4f8bf1540cab011b0c731f668b92241788676162",
      conclusion: "failure",
      createdAt: T("23:46:22"),
      updatedAt: T("23:47:26"),
      jobs: [
        ok("resolve"),
        { name: "publish-staging release v0.246.1", conclusion: "failure" },
      ],
    }),
    // A run on the same main commit that published nothing.
    run("hosted-publish.yml", {
      id: 45728845641,
      event: "workflow_run",
      title: "hosted-publish",
      createdAt: D("00:27:17"),
      updatedAt: D("00:27:31"),
      jobs: [
        ok("resolve"),
        skipped("publish-staging"),
        skipped("publish-prod"),
      ],
    }),
    run("hosted-publish.yml", {
      id: 45730519720,
      event: "workflow_run",
      title: "hosted-publish",
      createdAt: D("00:41:28"),
      updatedAt: D("00:45:10"),
      jobs: [
        ok("resolve"),
        // Job 139611132784: the copy ends here, though stage-prod runs on.
        {
          ...ok("publish-staging release v0.246.1"),
          status: "completed",
          startedAt: D("00:41:39"),
          completedAt: D("00:43:57"),
        },
        ok("stage-prod release v0.246.1"),
        skipped("publish-prod"),
      ],
    }),
    run("deploy-hosted-platform.yml", {
      id: 45731023993,
      event: "workflow_dispatch",
      title: "deploy-hosted-platform staging v0.246.1 [sc45730978252-1]",
      createdAt: D("00:45:37"),
      updatedAt: D("00:49:46"),
    }),
    run("redline-staging.yml", {
      id: 45731553873,
      event: "workflow_dispatch",
      title: "redline-staging v0.246.1",
      createdAt: D("00:50:09"),
      updatedAt: D("00:59:53"),
    }),
    run("hosted-publish.yml", {
      id: 45732780132,
      event: "workflow_dispatch",
      title: "hosted-publish prod v0.246.1 [p45732669445-1]",
      createdAt: D("01:00:49"),
      updatedAt: D("01:02:50"),
      jobs: [
        ok("resolve"),
        ok("publish-prod release v0.246.1"),
        skipped("stage-prod"),
        skipped("publish-staging"),
      ],
    }),
    run("deploy-hosted-platform.yml", {
      id: 45733048529,
      event: "workflow_dispatch",
      title: "deploy-hosted-platform prod v0.246.1 [c45732669445-1]",
      createdAt: D("01:03:05"),
      updatedAt: D("01:07:55"),
    }),
    // v0.247.0 pinned after: before the fix, this superseded v0.246.1.
    run("hosted-release.yml", {
      id: 45738985811,
      event: "push",
      title: "hosted-release",
      headSha: "4575a96be56acb8b60cac1c29d55e81adb7f8104",
      commitMessage: "chore(pin): bump PUBLIC_PIN to v0.247.0 (#463)",
      commitAt: D("01:47:47"),
      createdAt: D("01:55:32"),
      updatedAt: D("01:58:47"),
    }),
  ];
  const now = D("02:00:00");
  const w = (runs: Run[]) => ({
    releases: [...fx.releases, { tag: "v0.247.0", publishedAt: D("01:44:15") }],
    prs: [
      ...fx.prs,
      {
        number: 463,
        ref: "pin-bump/v0.247.0",
        createdAt: D("01:46:15"),
        mergedAt: D("01:55:30"),
        url: "https://github.com/open-artifacts-ai/open-artifacts-cloud/pull/463",
      },
    ],
    runs: [
      ...fx.runs.filter((r) => r.id !== pinRun.id && r.id !== pinPublish.id),
      ...runs,
    ],
    merges: fx.merges,
  });

  it("the job names a run's release: the tag, nothing for a run that published nothing, unknown when unread", () => {
    const [, failed, , noop, publish, , , prod] = recovery();
    expect(namedTag(publish as Run, STAGING_RE)).toBe("v0.246.1");
    expect(namedTag(failed as Run, STAGING_RE)).toBe("v0.246.1");
    expect(namedTag(failed as Run, STAGING_RE, true)).toBe(null);
    expect(namedTag(noop as Run, STAGING_RE)).toBe(null);
    expect(namedTag(prod as Run, PROD_RE)).toBe("v0.246.1");
    expect(namedTag(prod as Run, STAGING_RE)).toBe(null);
    expect(namedTag({ ...(publish as Run), jobs: undefined }, STAGING_RE)).toBe(
      undefined,
    );
    expect(namedTag({ ...(publish as Run), jobs: [] }, STAGING_RE)).toBe(
      undefined,
    );
  });

  it("a staging publish on a later main commit that names the tag counts: the release reached prod and is done, not superseded", () => {
    const x = w(recovery());
    const t = tl("v0.246.1", now, x);
    // From its run's start, 00:41:28Z, to its publish-staging job's end.
    expect(row(t, "staging_publish")).toMatchObject({
      state: "done",
      minutes: 2.5,
      endedAt: D("00:43:57"),
      url: `${RUNS}45730519720`,
    });
    expect(
      Object.fromEntries((t?.stages ?? []).map((s) => [s.name, s.minutes])),
    ).toMatchObject({
      hosted_release: 78.4,
      staging_publish: 2.5,
      staging_deploy: 4.2,
      redline_queue: 0.4,
      redline: 9.7,
      prod_publish: 2,
      prod_deploy: 4.8,
    });
    expect(t?.prodAt).toBe(D("01:07:55"));
    expect(t?.doneAt).toBe(D("01:07:55"));
    expect(t?.supersededBy).toBeUndefined();
    expect(t?.e2e).toBe(237.5);
    const r = world(now, x);
    const h = r.history.find((e) => e.tag === "v0.246.1");
    expect(h).toMatchObject({ doneAt: D("01:07:55"), e2e: 237.5 });
    expect(h).not.toHaveProperty("supersededBy");
    expect(h?.stages.staging_publish).toBe(2.5);
    // v0.246.0 never reached prod: superseded, closed by v0.246.1's prod deploy.
    expect(r.history.find((e) => e.tag === "v0.246.0")).toMatchObject({
      supersededBy: "v0.246.1",
      doneAt: D("01:07:55"),
    });
    expect(r.current.inFlight.map((f) => f.tag)).toEqual(["v0.247.0"]);
  });

  it("a release that reached its prod deploy is never superseded, even with a stage unmatched", () => {
    // No jobs read: the recovery publish is not matched by sha, but the
    // prod deploy ran, so every stage before it happened.
    const x = w(recovery().map((r) => ({ ...r, jobs: undefined })));
    const t = tl("v0.246.1", now, x);
    // The failed copies ran before hosted_release ended: earlier attempts.
    expect(row(t, "staging_publish")?.state).toBe("done");
    expect(row(t, "staging_publish")?.minutes).toBeUndefined();
    expect(row(t, "staging_deploy")?.minutes).toBe(4.2);
    expect(row(t, "redline")?.minutes).toBe(9.7);
    expect(t?.supersededBy).toBeUndefined();
    expect(t?.doneAt).toBe(D("01:07:55"));
  });

  it("a release that never reached prod is superseded once a newer one is pinned", () => {
    const x = w(
      recovery().filter(
        (r) => ![45731553873, 45732780132, 45733048529].includes(r.id),
      ),
    );
    const t = tl("v0.246.1", now, x);
    expect(row(t, "redline_queue")?.state).toBe("current");
    expect(t?.prodAt).toBeUndefined();
    expect(t?.supersededBy).toBe("v0.247.0");
    expect(t?.closedAt).toBeUndefined();
    const r = world(now, x);
    expect(r.current.inFlight.map((f) => f.tag)).toEqual(["v0.247.0"]);
    expect(r.history.map((e) => e.tag)).not.toContain("v0.246.1");
  });

  it("a hosted-release dispatch on main's head counts by its hosted-built job (cloud #469), not its sha", () => {
    const built = (tag: string, conclusion = "success") =>
      run("hosted-release.yml", {
        id: 45728492094,
        event: "workflow_dispatch",
        title: "hosted-release",
        createdAt: D("00:24:20"),
        updatedAt: D("00:27:15"),
        jobs: [
          ok("hosted-guard"),
          { name: `hosted-built ${tag} ${pinRun.headSha}`, conclusion },
        ],
      });
    // The pin run red on its first attempt; the dispatch rebuilt its commit.
    const red = {
      ...pinRun,
      status: "completed",
      conclusion: "failure",
      attempt: 1,
      startedAt: pinRun.createdAt,
      updatedAt: T("23:27:09"),
    };
    // Nothing later ran, so no later stage marks this one done.
    const hr = (b: Run) =>
      row(tl("v0.246.1", now, w([red, b])), "hosted_release");
    expect(hr(built("v0.246.1"))).toMatchObject({
      state: "done",
      endedAt: D("00:27:15"),
    });
    expect(namedTag(built("v0.246.1"), BUILT_RE, true)).toBe("v0.246.1");
    // Another tag's build, or a hosted-built job that did not pass, is not this release's.
    expect(hr(built("v0.245.1"))?.state).toBe("red");
    expect(hr(built("v0.246.1", "failure"))?.state).toBe("red");
  });
});

// cloud #456 second review: since cloud #471 the staging copy and the staging
// deploy both start when hosted-release ends. Recorded from v0.248.2:
// hosted-release 45756226648, the copy 45756565482 (publish-staging job
// 04:39:21 to 04:41:59, stage-prod on to 04:43:21), the deploy 45757040413
// (4.3 min), replayed as the Prover did: the deploy starting 1 s after
// hosted-release ended.
describe("stages that overlap (cloud #471) and the fleet finish (cloud #474)", () => {
  const RUNS =
    "https://github.com/open-artifacts-ai/open-artifacts-cloud/actions/runs/";
  const SHA = "c80f07fffeb6a326e8a60cb9af9f0659c4f4066f";
  const D = (hms: string) => `2026-11-26T${hms}Z`;
  const base = (
    file: string,
    o: Pick<Run, "id" | "event" | "title" | "createdAt" | "updatedAt"> &
      Partial<Run>,
  ): Run => ({
    path: `.github/workflows/${file}`,
    status: "completed",
    conclusion: "success",
    headSha: SHA,
    startedAt: o.createdAt,
    attempt: 1,
    url: `${RUNS}${o.id}`,
    commitMessage: "chore(pin): bump PUBLIC_PIN to v0.248.2 (#473)",
    commitAt: D("04:29:30"),
    ...o,
  });
  const copyJob = (end: string | null) => ({
    name: "publish-staging release v0.248.2",
    status: end ? "completed" : "in_progress",
    conclusion: end ? "success" : null,
    startedAt: D("04:39:21"),
    completedAt: end,
  });
  const chain = (o: {
    copyEnd?: string | null;
    copyRunEnd?: string;
    prod?: Run[];
  }): Run[] => [
    base("hosted-release.yml", {
      id: 45756226648,
      event: "push",
      title: "hosted-release",
      createdAt: D("04:35:54"),
      updatedAt: D("04:39:06"),
    }),
    base("hosted-publish.yml", {
      id: 45756565482,
      event: "workflow_run",
      title: "hosted-publish",
      createdAt: D("04:39:09"),
      updatedAt: o.copyRunEnd ?? D("04:43:21"),
      ...(o.copyRunEnd === undefined && o.copyEnd === null
        ? { status: "in_progress", conclusion: null }
        : {}),
      jobs: [
        { name: "resolve", conclusion: "success" },
        copyJob(o.copyEnd === undefined ? D("04:41:59") : o.copyEnd),
      ],
    }),
    base("deploy-hosted-platform.yml", {
      id: 45757040413,
      event: "workflow_dispatch",
      title: "deploy-hosted-platform staging v0.248.2 [sc45756226648-1]",
      createdAt: D("04:39:07"),
      updatedAt: D("04:43:27"),
    }),
    ...(o.prod ?? []),
  ];
  const world2 = (runs: Run[], now: string) => ({
    releases: [{ tag: "v0.248.2", publishedAt: D("04:25:40") }],
    prs: [
      {
        number: 473,
        ref: "pin-bump/v0.248.2",
        createdAt: D("04:27:54"),
        mergedAt: D("04:35:53"),
        url: "https://github.com/open-artifacts-ai/open-artifacts-cloud/pull/473",
      },
    ],
    runs: runs.filter((r) => ms(r.createdAt) <= ms(now)),
    merges: { "v0.248.2": D("04:21:47") },
  });
  const tl2 = (runs: Run[], now: string) => {
    const w = world2(runs, now);
    return timeline({
      release: w.releases[0] as Release,
      runs: w.runs,
      prs: w.prs,
      mergedAt: w.merges["v0.248.2"],
      config,
      now,
    });
  };

  it("times the copy and the deploy each from its own start: the deploy is 4.3 min, not 0.1", () => {
    const t = tl2(chain({}), D("04:44:00"));
    expect(row(t, "staging_deploy")).toMatchObject({
      state: "done",
      startedAt: D("04:39:07"),
      endedAt: D("04:43:27"),
      minutes: 4.3,
    });
    // The copy ends with its publish-staging job, though stage-prod runs on.
    expect(row(t, "staging_publish")).toMatchObject({
      state: "done",
      startedAt: D("04:39:09"),
      endedAt: D("04:41:59"),
      minutes: 2.8,
    });
    // The red-line queue starts when the later of the two ended.
    expect(row(t, "redline_queue")).toMatchObject({
      state: "current",
      startedAt: D("04:43:27"),
    });
  });

  it("a copy still running after the deploy finished is not done: it is the stage going, and the red-line queue has not started", () => {
    const runs = chain({ copyEnd: null });
    const t = tl2(runs, D("04:44:00"));
    expect(row(t, "staging_deploy")?.state).toBe("done");
    expect(row(t, "staging_publish")).toMatchObject({
      state: "current",
      startedAt: D("04:39:09"),
      minutes: 4.9,
    });
    expect(row(t, "redline_queue")?.state).toBe("pending");
    // A stalled copy is named as the copy, never the red-line queue.
    const now = D("04:49:00");
    const r = compute({
      ...world2(runs, now),
      history: [],
      config,
      now,
    });
    expect(r.over.filter((o) => o.kind === "in_flight")).toEqual([
      {
        tag: "v0.248.2",
        stage: "staging_publish",
        kind: "in_flight",
        startedAt: D("04:39:09"),
        minutes: 9.9,
        usual: 2.8,
        limit: 7.8,
        url: `${RUNS}45756565482`,
      },
    ]);
    expect(r.current.inFlight[0]?.going.map((g) => g.stage)).toEqual([
      "staging_publish",
    ]);
  });

  it("a stage that has not started counts from what it waits on, so a stall still shows", () => {
    // The deploy never dispatched: 10 min after hosted-release ended.
    const runs = chain({}).filter((r) => r.id !== 45757040413);
    const now = D("04:49:06");
    const t = tl2(runs, now);
    expect(row(t, "staging_deploy")).toMatchObject({
      state: "current",
      waiting: true,
      startedAt: D("04:39:06"),
      minutes: 10,
    });
    const r = compute({ ...world2(runs, now), history: [], config, now });
    expect(r.over.map((o) => [o.stage, o.waiting])).toEqual([
      ["staging_deploy", true],
    ]);
    expect(issueBody(r.over, r.red, config)).toContain(
      "- v0.248.2 staging_deploy: not started 9.3 min after what it waits on ended (usual 4.3 min), waiting since 2026-11-26T04:39:06Z.",
    );
  });

  // The rest of the chain, then the prod deploy run with #474's steps.
  const prodRuns = (
    steps: Job["steps"] | undefined,
    deploy?: Partial<Run>,
  ): Run[] => [
    base("redline-staging.yml", {
      id: 1,
      event: "workflow_dispatch",
      title: "redline-staging v0.248.2",
      createdAt: D("04:43:40"),
      updatedAt: D("04:53:40"),
    }),
    base("hosted-publish.yml", {
      id: 2,
      event: "workflow_dispatch",
      title: "hosted-publish prod v0.248.2 [p1-1]",
      createdAt: D("04:54:00"),
      updatedAt: D("04:56:00"),
    }),
    base("deploy-hosted-platform.yml", {
      id: 3,
      event: "workflow_dispatch",
      title: "deploy-hosted-platform prod v0.248.2 [c1-1]",
      createdAt: D("04:56:10"),
      updatedAt: D("05:06:00"),
      ...(steps
        ? { jobs: [{ name: "deploy", conclusion: "success", steps }] }
        : {}),
      ...deploy,
    }),
  ];
  const stepOf = (
    name: string,
    startedAt: string,
    completedAt: string | null,
    conclusion: string | null = "success",
  ) => ({
    name,
    status: completedAt ? "completed" : "in_progress",
    conclusion,
    startedAt,
    completedAt,
  });
  const fleetDone = [
    stepOf("Mark the platform verified", D("05:00:40"), D("05:00:55")),
    stepOf(FLEET_WAKE_STEP, D("05:01:00"), D("05:01:02")),
    stepOf(FLEET_WAIT_STEP, D("05:01:02"), D("05:05:50")),
    stepOf(FLEET_DONE_STEP, D("05:05:52"), D("05:05:53")),
  ];

  it("with a Fleet done step, the release is reported to every install, and the prod deploy ends where the fleet starts", () => {
    const now = D("05:10:00");
    const t = tl2(chain({ prod: prodRuns(fleetDone) }), now);
    expect(row(t, "prod_deploy")).toMatchObject({
      state: "done",
      startedAt: D("04:56:10"),
      endedAt: D("05:01:00"),
      minutes: 4.8,
    });
    expect(row(t, "fleet")).toMatchObject({
      state: "done",
      startedAt: D("05:01:00"),
      endedAt: D("05:05:53"),
      minutes: 4.9,
      url: `${RUNS}3`,
    });
    expect(t.doneAt).toBe(D("05:05:53"));
    expect(t.e2eTo).toBe("every install");
    expect(t.e2e).toBe(44.1);
    const r = compute({
      ...world2(chain({ prod: prodRuns(fleetDone) }), now),
      history: [],
      config,
      now,
    });
    expect(r.history[0]).toMatchObject({
      tag: "v0.248.2",
      e2eTo: "every install",
      e2e: 44.1,
    });
    expect(r.history[0]?.stages.fleet).toBe(4.9);
    expect(summary(r.current)).toContain(
      "| v0.248.2 | 44.1 | every install | 24.1 over |",
    );
    // Fleet has no usual time yet: never an alert.
    expect(r.over.map((o) => o.stage)).not.toContain("fleet");
  });

  it("while the fleet wait runs, the release is in flight on its fleet stage", () => {
    const now = D("05:03:00");
    const steps = [
      ...fleetDone.slice(0, 2),
      stepOf(FLEET_WAIT_STEP, D("05:01:02"), null, null),
      { name: FLEET_DONE_STEP, status: "pending", conclusion: null },
    ];
    const runs = chain({
      prod: prodRuns(steps, { status: "in_progress", conclusion: null }),
    });
    const t = tl2(runs, now);
    expect(row(t, "prod_deploy")).toMatchObject({
      state: "done",
      endedAt: D("05:01:00"),
    });
    expect(row(t, "fleet")).toMatchObject({
      state: "current",
      startedAt: D("05:01:00"),
      minutes: 2,
    });
    expect(t.doneAt).toBeUndefined();
    expect(
      compute({ ...world2(runs, now), history: [], config, now }).current
        .inFlight[0],
    ).toMatchObject({ tag: "v0.248.2", stage: "fleet", state: "current" });
  });

  it("without a Fleet done success (a deploy before #474, or a wait that ran out), the release keeps to prod deploy (fleet not yet measured)", () => {
    const now = D("05:20:00");
    const ranOut = [
      ...fleetDone.slice(0, 2),
      stepOf(FLEET_WAIT_STEP, D("05:01:02"), D("05:11:02")),
      stepOf(FLEET_DONE_STEP, D("05:11:03"), D("05:11:03"), "skipped"),
    ];
    for (const steps of [undefined, ranOut]) {
      const t = tl2(chain({ prod: prodRuns(steps) }), now);
      expect(row(t, "fleet")?.state).toBe("unmeasured");
      expect(t.e2eTo).toBe("prod deploy (fleet not yet measured)");
      expect(t.doneAt).toBe(row(t, "prod_deploy")?.endedAt);
    }
    expect(fleetStep(prodRuns(ranOut))).toEqual({
      deployEnd: D("05:01:00"),
      fleet: { state: "none" },
    });
    expect(fleetStep(prodRuns(undefined))).toEqual({
      fleet: { state: "none" },
    });
    // A Fleet done step that was skipped is no finish, nor one still pending.
    expect(
      fleetStep(
        prodRuns([
          ...fleetDone.slice(0, 3),
          stepOf(FLEET_DONE_STEP, D("05:05:52"), D("05:05:52"), "skipped"),
        ]),
      ).fleet.state,
    ).toBe("none");
  });

  // The Prover's replay (cloud #264 comment 7185291783): a first prod deploy
  // of the tag whose wait ran out, then a later one (a rerun or a new deploy
  // of the same tag) whose "Fleet done" succeeded at 05:39:39.
  const ranOutRun = (): Run =>
    base("deploy-hosted-platform.yml", {
      id: 3,
      event: "workflow_dispatch",
      title: "deploy-hosted-platform prod v0.248.2 [c1-1]",
      createdAt: D("04:56:10"),
      updatedAt: D("05:12:00"),
      jobs: [
        {
          name: "deploy",
          conclusion: "success",
          steps: [
            ...fleetDone.slice(0, 2),
            stepOf(FLEET_WAIT_STEP, D("05:01:02"), D("05:11:02")),
            stepOf(FLEET_DONE_STEP, D("05:11:03"), D("05:11:03"), "skipped"),
          ],
        },
      ],
    });
  const laterRun = (id: number, start: string, end: string): Run =>
    base("deploy-hosted-platform.yml", {
      id,
      event: "workflow_dispatch",
      title: `deploy-hosted-platform prod v0.248.2 [c${id}-1]`,
      createdAt: D(start),
      updatedAt: D(end),
      jobs: [
        {
          name: "deploy",
          conclusion: "success",
          steps: [
            stepOf(FLEET_WAKE_STEP, D(start), D(start)),
            stepOf(FLEET_WAIT_STEP, D(start), D(end)),
            stepOf(FLEET_DONE_STEP, D(end), D(end)),
          ],
        },
      ],
    });

  it("an earlier wait that ran out never hides a later Fleet done for the same tag: the earliest success is the finish", () => {
    const later = laterRun(4, "05:30:00", "05:39:39");
    const done = {
      deployEnd: D("05:01:00"),
      fleet: {
        state: "done",
        startedAt: D("05:01:00"),
        doneAt: D("05:39:39"),
        url: `${RUNS}4`,
      },
    };
    // Whatever order the runs come in.
    expect(fleetStep([ranOutRun(), later])).toEqual(done);
    expect(fleetStep([later, ranOutRun()])).toEqual(done);
    // Two successes: the earliest.
    expect(
      fleetStep([laterRun(5, "05:40:00", "05:45:00"), later, ranOutRun()]).fleet
        .doneAt,
    ).toBe(D("05:39:39"));
    const now = D("05:50:00");
    const prod = [...prodRuns(undefined).slice(0, 2), ranOutRun(), later];
    const t = tl2(chain({ prod }), now);
    expect(row(t, "fleet")).toMatchObject({
      state: "done",
      endedAt: D("05:39:39"),
    });
    expect(row(t, "prod_deploy")?.endedAt).toBe(D("05:01:00"));
    expect(t.e2eTo).toBe("every install");
    expect(t.doneAt).toBe(D("05:39:39"));
    // A backfill rebuilds from the runs, so it takes the later success too.
    const r = compute({
      ...world2(chain({ prod }), now),
      history: [],
      config,
      now,
    });
    expect(r.history[0]).toMatchObject({
      e2eTo: "every install",
      doneAt: D("05:39:39"),
    });
  });

  it("a release already in history to the prod deploy takes a later Fleet done; one measured to every install is kept", () => {
    const now = D("05:50:00");
    const recorded: HistoryEntry = {
      tag: "v0.248.2",
      mode: "pr",
      mergedAt: D("04:21:47"),
      publishedAt: D("04:25:40"),
      doneAt: D("05:01:00"),
      e2e: 39.2,
      e2eTo: "prod deploy (fleet not yet measured)",
      stages: { prod_deploy: 4.8 },
    };
    const prod = [
      ...prodRuns(undefined).slice(0, 2),
      ranOutRun(),
      laterRun(4, "05:30:00", "05:39:39"),
    ];
    const up = upgradeFleet(recorded, prod);
    expect(up).toEqual({
      ...recorded,
      doneAt: D("05:39:39"),
      e2e: 77.9,
      e2eTo: "every install",
      stages: { prod_deploy: 4.8, fleet: 38.7 },
    });
    // History from before e2eTo also ran to the prod deploy.
    const { e2eTo: _, ...old } = recorded;
    expect(upgradeFleet(old, prod).e2eTo).toBe("every install");
    // Nothing new: unchanged. Already to every install, or superseded: unchanged.
    expect(upgradeFleet(recorded, [ranOutRun()])).toBe(recorded);
    const full = { ...recorded, e2eTo: "every install" };
    expect(upgradeFleet(full, prod)).toBe(full);
    const sup = { ...recorded, supersededBy: "v0.248.3" };
    expect(upgradeFleet(sup, prod)).toBe(sup);
    // Through a tick's compute: the history line and the summary move.
    const r = compute({
      ...world2(chain({ prod }), now),
      history: [recorded],
      config,
      now,
    });
    expect(r.history).toEqual([up]);
    expect(summary(r.current)).toContain(
      "| v0.248.2 | 77.9 | every install | 57.9 over |",
    );
  });

  // cloud #474 at b5e08292: every prod deploy reads every fleet_done mark
  // (platform-db.ts fleet-done-all: oldest first, the newest 20, each
  // `v${v} at ${new Date(value).toISOString()}`, joined with ", ") and, when
  // there is any, runs a step named
  //   Fleet done of earlier releases (${{ steps.prev_fleet.outputs.list }})
  const listName = (...entries: [string, string][]) =>
    `Fleet done of earlier releases (${entries
      .map(([tag, at]) => `${tag} at ${new Date(at).toISOString()}`)
      .join(", ")})`;
  const lateName = (tag: string, at: string) =>
    listName(["v0.248.1", D("03:58:00")], [tag, at]);
  const nextDeploy = (name: string, conclusion = "success", id = 6): Run =>
    base("deploy-hosted-platform.yml", {
      id,
      event: "workflow_dispatch",
      title: "deploy-hosted-platform prod v0.248.3 [c6-1]",
      createdAt: D("06:10:00"),
      updatedAt: D("06:20:00"),
      jobs: [
        {
          name: "deploy",
          conclusion: "success",
          steps: [
            stepOf(
              "Read the fleet finish of earlier releases",
              D("06:10:30"),
              D("06:10:31"),
            ),
            stepOf(name, D("06:10:32"), D("06:10:32"), conclusion),
          ],
        },
      ],
    });

  it("reads each release's finish from a prod deploy's earlier-releases list, exactly as #474 writes it", () => {
    const name = lateName("v0.248.2", D("05:39:39"));
    expect(name).toBe(
      "Fleet done of earlier releases (v0.248.1 at 2026-11-26T03:58:00.000Z, v0.248.2 at 2026-11-26T05:39:39.000Z)",
    );
    expect(EARLIER_FLEET_RE.test(name)).toBe(true);
    expect(earlierFleetList(name)).toEqual([
      { tag: "v0.248.1", at: D("03:58:00") },
      { tag: "v0.248.2", at: D("05:39:39") },
    ]);
    // One entry, and 20 (the most #474 lists).
    expect(earlierFleetList(listName(["v0.248.2", D("05:39:39")]))).toEqual([
      { tag: "v0.248.2", at: D("05:39:39") },
    ]);
    const twenty = Array.from(
      { length: 20 },
      (_, i) => [`v0.230.${i}`, D("01:00:00")] as [string, string],
    );
    expect(earlierFleetList(listName(...twenty))).toHaveLength(20);
    // A malformed entry is skipped, the rest kept; other step names list nothing.
    expect(
      earlierFleetList(
        "Fleet done of earlier releases (v0.248.1 at soon, v0.248.2 at 2026-11-26T05:39:39.000Z)",
      ),
    ).toEqual([{ tag: "v0.248.2", at: D("05:39:39") }]);
    expect(earlierFleetList("Fleet done of earlier releases ()")).toEqual([]);
    expect(earlierFleetList(FLEET_DONE_STEP)).toEqual([]);
    expect(
      earlierFleetList(
        "Fleet done of the release before (v0.248.2 at 2026-11-26T05:39:39.000Z)",
      ),
    ).toEqual([]);
    expect(lateFleetDone([nextDeploy(name)], "v0.248.2")).toEqual({
      at: D("05:39:39"),
      url: `${RUNS}6`,
    });
    expect(lateFleetDone([nextDeploy(name)], "v0.248.1")?.at).toBe(
      D("03:58:00"),
    );
    // Only a successful step, only a listed tag.
    expect(lateFleetDone([nextDeploy(name, "skipped")], "v0.248.2")).toBe(
      undefined,
    );
    expect(lateFleetDone([nextDeploy(name, "failure")], "v0.248.2")).toBe(
      undefined,
    );
    expect(lateFleetDone([nextDeploy(name)], "v0.247.0")).toBe(undefined);
    // Listed by many runs: the earliest time per tag.
    expect(
      lateFleetDone(
        [
          nextDeploy(lateName("v0.248.2", D("05:50:00")), "success", 7),
          nextDeploy(name),
        ],
        "v0.248.2",
      )?.at,
    ).toBe(D("05:39:39"));
  });

  it("a wait that ran out, then the next deploy's record: the release runs to every install at the recorded time", () => {
    const now = D("06:30:00");
    const prod = [
      ...prodRuns(undefined).slice(0, 2),
      ranOutRun(),
      nextDeploy(lateName("v0.248.2", D("05:39:39"))),
    ];
    const t = tl2(chain({ prod }), now);
    expect(row(t, "fleet")).toMatchObject({
      state: "done",
      startedAt: D("05:01:00"),
      endedAt: D("05:39:39"),
      minutes: 38.7,
      url: `${RUNS}6`,
    });
    expect(t.e2eTo).toBe("every install");
    expect(t.doneAt).toBe(D("05:39:39"));
    // The earliest of all sources: a same-run "Fleet done" before the record wins.
    const both = [...prod, laterRun(4, "05:20:00", "05:25:00")];
    expect(row(tl2(chain({ prod: both }), now), "fleet")?.endedAt).toBe(
      D("05:25:00"),
    );
    // And a record before a later same-run success wins over it.
    const recFirst = [...prod, laterRun(4, "05:45:00", "05:50:00")];
    expect(row(tl2(chain({ prod: recFirst }), now), "fleet")?.endedAt).toBe(
      D("05:39:39"),
    );
  });

  it("a release in history to the prod deploy takes the next deploy's record; with no fleet steps of its own the fleet is untimed", () => {
    const recorded: HistoryEntry = {
      tag: "v0.248.2",
      mode: "pr",
      mergedAt: D("04:21:47"),
      publishedAt: D("04:25:40"),
      doneAt: D("05:01:00"),
      e2e: 39.2,
      e2eTo: "prod deploy (fleet not yet measured)",
      stages: { prod_deploy: 4.8 },
    };
    const rec = nextDeploy(lateName("v0.248.2", D("05:39:39")));
    expect(upgradeFleet(recorded, [ranOutRun(), rec])).toEqual({
      ...recorded,
      doneAt: D("05:39:39"),
      e2e: 77.9,
      e2eTo: "every install",
      stages: { prod_deploy: 4.8, fleet: 38.7 },
    });
    // Its own deploy had no fleet steps (before #474): finish known, start not.
    const own = prodRuns(undefined)[2] as Run;
    expect(upgradeFleet(recorded, [own, rec])).toEqual({
      ...recorded,
      doneAt: D("05:39:39"),
      e2e: 77.9,
      e2eTo: "every install",
    });
    const now = D("06:30:00");
    const r = compute({
      ...world2(
        chain({ prod: [...prodRuns(undefined).slice(0, 2), ranOutRun(), rec] }),
        now,
      ),
      history: [recorded],
      config,
      now,
    });
    expect(r.history[0]).toMatchObject({
      tag: "v0.248.2",
      e2eTo: "every install",
      doneAt: D("05:39:39"),
    });
  });
});

describe("percentiles, history and ETA", () => {
  it("pct with n=0, 1 and 20", () => {
    expect(pct([], 50)).toBe(null);
    expect(pct([7], 50)).toBe(7);
    expect(pct([7], 90)).toBe(7);
    const v = Array.from({ length: 20 }, (_, i) => 20 - i);
    expect(pct(v, 50)).toBe(10);
    expect(pct(v, 90)).toBe(18);
  });

  const entry = (n: number, minutes: number): HistoryEntry => ({
    tag: `v0.1.${n}`,
    mode: "pr",
    publishedAt: T("10:00:00"),
    doneAt: T("11:00:00"),
    e2e: minutes * 10,
    stages: { redline: minutes },
  });

  it("stats take the newest statsWindow releases by tag", () => {
    const h = Array.from({ length: 25 }, (_, i) => entry(i, i));
    const s = stats(h, config);
    expect(s.stages.redline).toEqual({ p50: 14, p90: 22, n: 20, usual: 10.4 });
    expect(s.stages.tag).toEqual({ p50: null, p90: null, n: 0, usual: 20.4 });
    expect(s.e2e).not.toHaveProperty("worst");
    expect(s.e2e.target).toBe(20);
    expect(s.e2e).toMatchObject({ p50: 140, p90: 220, n: 20 });
    expect(s.e2e.last20).toHaveLength(20);
  });

  it("history merges by tag, newer wins, oldest dropped past the size", () => {
    const m = mergeHistory(
      [entry(1, 1), entry(2, 2)],
      [entry(2, 9), entry(10, 3)],
      2,
    );
    expect(m.map((e) => [e.tag, e.stages.redline])).toEqual([
      ["v0.1.2", 9],
      ["v0.1.10", 3],
    ]);
  });

  it("parseHistory drops lines that are not entries", () => {
    const good = JSON.stringify(entry(1, 1));
    const h = parseHistory(
      [
        good,
        "not json",
        JSON.stringify({ tag: "x" }),
        JSON.stringify({ ...entry(2, 1), stages: { a: "1" } }),
        "",
      ].join("\n"),
    );
    expect(h.map((e) => e.tag)).toEqual(["v0.1.1"]);
  });

  it("ETA: what is left of the current stage, then each later stage's p50 or p90", () => {
    const now = T("19:22:12");
    const t = tl("v0.245.1", now);
    // Timed from its own run's start, 19:20:38Z.
    expect(row(t, "staging_deploy")).toMatchObject({
      state: "current",
      minutes: 1.6,
    });
    const st = stats(
      [
        {
          tag: "v0.1.0",
          mode: "pr",
          publishedAt: now,
          doneAt: now,
          stages: {
            staging_deploy: 5,
            redline_queue: 1,
            redline: 10,
            prod_publish: 3,
            prod_deploy: 5,
          },
        },
      ],
      config,
    ).stages;
    // (5 - 1.6) + 1 + 10 + 3 + 5 = 22.4 min; fleet, unmeasured, adds nothing.
    expect(eta(t as never, st, now)).toEqual({
      p50: "2026-11-25T19:44:36.000Z",
      p90: "2026-11-25T19:44:36.000Z",
    });
    // No samples: usual times. (4.3 - 1.6) + 0.5 + 10.4 + 1.9 + 4.8 = 20.3 min.
    expect(eta(t as never, stats([], config).stages, now)?.p50).toBe(
      "2026-11-25T19:42:30.000Z",
    );
    // A current stage past its figure leaves nothing of it, never less.
    const late = T("19:40:12");
    const w = at(late);
    w.runs = w.runs
      .filter((r) => ms(r.createdAt) <= ms(T("19:22:00")))
      .map((r) =>
        r.title.includes("staging v0.245.1")
          ? { ...r, status: "in_progress", conclusion: null }
          : r,
      );
    expect(eta(tl("v0.245.1", late, w) as never, st, late)?.p50).toBe(
      "2026-11-25T19:59:12.000Z",
    );
  });
});

describe("the stuck-stage issue", () => {
  const over = overruns(
    [
      {
        tag: "v1.0.0",
        mode: "pr",
        publishedAt: T("10:00:00"),
        stages: [
          {
            name: "tag",
            usual: 6,
            startedAt: T("09:58:00"),
            endedAt: T("10:00:00"),
            minutes: 2,
            state: "done",
          },
          {
            name: "pin_open",
            usual: 4,
            startedAt: T("10:00:00"),
            minutes: 9.5,
            state: "current",
          },
        ],
      },
    ],
    config,
  );
  it("an in-flight stage past its limit is an overrun", () => {
    expect(over.over).toEqual([
      {
        tag: "v1.0.0",
        stage: "pin_open",
        kind: "in_flight",
        startedAt: T("10:00:00"),
        minutes: 9.5,
        usual: 4,
        limit: 9,
        url: undefined,
      },
    ]);
  });
  it("the limit is the larger of twice the usual time and the usual time plus 5 min", () => {
    // redline_queue's 0.5 min usual would alert on a 1.1 min wait at 2x alone.
    expect(limitOf(0.5, config)).toBe(5.5);
    expect(limitOf(4, config)).toBe(9);
    // At 5 min the two agree; above it, twice the usual time is the larger.
    expect(limitOf(5, config)).toBe(10);
    expect(limitOf(9.8, config)).toBe(19.6);
    expect(limitOf(18.2, config)).toBe(36.4);
    const q = (minutes: number) =>
      overruns(
        [
          {
            tag: "v1.0.0",
            mode: "pr",
            publishedAt: T("10:00:00"),
            stages: [
              {
                name: "redline_queue",
                usual: 0.5,
                startedAt: T("10:00:00"),
                minutes,
                state: "current",
              },
            ],
          },
        ],
        config,
      ).over.map((o) => [o.stage, o.minutes, o.limit]);
    expect(q(1.1)).toEqual([]);
    expect(q(5.5)).toEqual([]);
    expect(q(5.6)).toEqual([["redline_queue", 5.6, 5.5]]);
  });
  it("an in-flight stage at exactly its limit is not stuck yet", () => {
    const at8 = overruns(
      [
        {
          tag: "v1.0.0",
          mode: "pr",
          publishedAt: T("10:00:00"),
          stages: [
            {
              name: "pin_open",
              usual: 4,
              startedAt: T("10:00:00"),
              minutes: 9,
              state: "current",
            },
          ],
        },
      ],
      config,
    );
    expect(at8.over).toEqual([]);
  });
  it("a finished stage past its limit stays an overrun while its release is in flight", () => {
    const r = overruns(
      [
        {
          tag: "v1.0.0",
          mode: "pr",
          publishedAt: T("10:00:00"),
          stages: [
            {
              name: "hosted_release",
              usual: 3.2,
              startedAt: T("10:00:00"),
              endedAt: T("11:18:24"),
              minutes: 78.4,
              state: "done",
            },
            {
              name: "staging_publish",
              usual: 4.2,
              startedAt: T("11:18:24"),
              minutes: 1,
              state: "current",
            },
          ],
        },
      ],
      config,
    );
    expect(r.over).toEqual([
      {
        tag: "v1.0.0",
        stage: "hosted_release",
        kind: "finished",
        startedAt: T("10:00:00"),
        minutes: 78.4,
        usual: 3.2,
        limit: 8.2,
        url: undefined,
      },
    ]);
    expect(issueBody(r.over, [], config)).toContain(
      "- v1.0.0 hosted_release: took 78.4 min (usual 3.2 min, limit 8.2 min).",
    );
    expect(issueBody(r.over, [], config)).toContain(
      "ran past its limit, the larger of 2 x its usual time and its usual time plus 5 min.",
    );
  });
  it("the newest finished release's overruns keep it open until a release completes with none; its total never alerts", () => {
    const done = {
      tag: "v1.0.0",
      mode: "pr" as const,
      publishedAt: T("10:00:00"),
      doneAt: T("11:30:00"),
      e2e: 90,
      stages: [
        {
          name: "redline",
          usual: 14,
          startedAt: T("10:00:00"),
          endedAt: T("11:30:00"),
          minutes: 90,
          state: "done" as const,
        },
      ],
    };
    expect(overruns([done], config).over.map((o) => [o.kind, o.stage])).toEqual(
      [["finished", "redline"]],
    );
    const newer = {
      ...done,
      tag: "v1.0.1",
      e2e: 30,
      stages: [{ ...done.stages[0], minutes: 10 }],
    };
    // 300 min from merge, far past the 20 min target: reported, not alerted.
    expect(
      overruns([done, { ...newer, e2e: 300 } as never], config).over,
    ).toEqual([]);
  });
  it("creates once, edits only on a change, closes when nothing is stuck", () => {
    const body = issueBody(over.over, [], config);
    expect(issuePlan([], over.over, [], config)).toEqual({
      action: "create",
      body,
    });
    const open = [
      { number: 5, title: ISSUE_TITLE, body },
      { number: 3, title: "hosted-release failed", body: "" },
    ];
    expect(issuePlan(open, over.over, [], config)).toEqual({ action: "none" });
    expect(
      issuePlan(
        [{ number: 5, title: ISSUE_TITLE, body: `${body}\n` }],
        over.over,
        [],
        config,
      ),
    ).toEqual({ action: "none" });
    expect(
      issuePlan(
        [{ number: 5, title: ISSUE_TITLE, body: "old" }],
        over.over,
        [],
        config,
      ),
    ).toEqual({ action: "edit", number: 5, body });
    expect(issuePlan(open, [], [], config)).toMatchObject({
      action: "close",
      number: 5,
    });
    expect(issuePlan(open.slice(1), [], [], config)).toEqual({
      action: "none",
    });
  });
  it("the body holds no moving clock: the same state twice gives the same body", () => {
    const later = overruns(
      [
        {
          tag: "v1.0.0",
          mode: "pr",
          publishedAt: T("10:00:00"),
          stages: [
            {
              name: "pin_open",
              usual: 4,
              startedAt: T("10:00:00"),
              minutes: 14,
              state: "current",
            },
          ],
        },
      ],
      config,
    );
    expect(issueBody(later.over, [], config)).toBe(
      issueBody(over.over, [], config),
    );
  });

  const stub = (issues: unknown[]) => {
    const calls: string[][] = [];
    const exec: Exec = (_cmd, args) => {
      calls.push(args);
      return args[0] === "issue" && args[1] === "list"
        ? { code: 0, stdout: JSON.stringify(issues), stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    };
    return { exec, calls };
  };
  it("syncIssue lists blocker issues once and writes nothing when unchanged", () => {
    const body = issueBody(over.over, [], config);
    const s = stub([{ number: 5, title: ISSUE_TITLE, body }]);
    expect(syncIssue(s.exec, "o/r", over.over, [], config).action).toBe("none");
    expect(s.calls).toEqual([
      [
        "issue",
        "list",
        "--repo",
        "o/r",
        "--state",
        "open",
        "--label",
        "blocker",
        "--limit",
        "100",
        "--json",
        "number,title,body",
      ],
    ]);
  });
  it("syncIssue opens the issue with the blocker label", () => {
    const s = stub([]);
    syncIssue(s.exec, "o/r", over.over, [], config);
    expect(s.calls[1]?.slice(0, 7)).toEqual([
      "issue",
      "create",
      "--repo",
      "o/r",
      "--title",
      ISSUE_TITLE,
      "--label",
    ]);
    expect(s.calls[1]?.[7]).toBe("blocker");
  });
  it("syncIssue closes with a comment", () => {
    const s = stub([{ number: 5, title: ISSUE_TITLE, body: "x" }]);
    syncIssue(s.exec, "o/r", [], [], config);
    expect(s.calls[1]?.slice(0, 5)).toEqual([
      "issue",
      "close",
      "5",
      "--repo",
      "o/r",
    ]);
  });
});

describe("tick reads", () => {
  const lines = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n");
  const fake = (now: string, page?: Pr[]) => {
    const w = at(now);
    const calls: string[] = [];
    const exec: Exec = (_cmd, args) => {
      const path = args[args.length - 1] ?? "";
      calls.push(args[0] === "issue" ? `issue ${args[1]}` : path);
      let out = "";
      if (args[0] === "issue") out = args[1] === "list" ? "[]" : "";
      else if (path.includes("/releases?"))
        out = lines(
          w.releases.map((r) => ({ tag: r.tag, publishedAt: r.publishedAt })),
        );
      else if (path.includes("/pulls?")) {
        const head = /[?&]head=[^:&]+:([^&]+)/.exec(path)?.[1];
        // The newest-100 page may have lost an old PR; the head lookup never does.
        out = head
          ? lines(w.prs.filter((p) => p.ref === head))
          : lines(page ?? w.prs);
      } else if (path.includes("/compare/"))
        out = JSON.stringify([
          { sha: "a".repeat(40), subject: "feat: x (#1)", date: T("09:00:00") },
        ]);
      else if (path.includes("/commits/")) {
        const tag =
          calls
            .filter((c) => c.includes("/compare/"))
            .pop()
            ?.split("...")[1] ?? "";
        out = fx.merges[tag] ?? "";
      } else if (path.includes("/actions/workflows/")) {
        const f = path.split("/actions/workflows/")[1]?.split("/")[0];
        out = lines(w.runs.filter((r) => r.path.endsWith(`/${f}`)));
      }
      return { code: 0, stdout: out, stderr: "" };
    };
    return { exec, calls };
  };

  it("a normal tick reads the window, skips merge reads for releases in history, and syncs the issue", () => {
    const now = T("19:50:00");
    const f = fake(now);
    const history: HistoryEntry[] = [
      {
        tag: "v0.245.0",
        mode: "pr",
        mergedAt: fx.merges["v0.245.0"],
        publishedAt: T("17:23:42"),
        doneAt: T("18:04:15"),
        stages: {},
      },
    ];
    const r = tick({
      exec: f.exec,
      repo: "o/c",
      publicRepo: "o/p",
      config,
      history,
      now,
      issue: true,
    });
    expect(f.calls.filter((c) => c.includes("/compare/"))).toEqual([
      "repos/o/p/compare/v0.245.0...v0.245.1",
    ]);
    expect(f.calls.filter((c) => c.includes("/actions/workflows/"))).toEqual(
      [
        "hosted-release.yml",
        "hosted-publish.yml",
        "deploy-hosted-platform.yml",
        "redline-staging.yml",
      ].map(
        (x) =>
          `repos/o/c/actions/workflows/${x}/runs?branch=main&created=>=2026-11-25T13:50:00Z&per_page=100`,
      ),
    );
    expect(f.calls.filter((c) => c.startsWith("issue"))).toEqual([
      "issue list",
    ]);
    expect(f.calls.filter((c) => c.includes("/pulls?"))).toEqual([
      "repos/o/c/pulls?state=all&head=o:pin-bump/v0.245.1&per_page=100",
    ]);
    expect(r.history.map((h) => h.tag)).toEqual(["v0.245.0", "v0.245.1"]);
    expect(r.history[1]?.e2e).toBe(45.8);
    expect(summary(r.current)).toContain("No release in flight.");
    expect(summary(r.current)).toContain(
      "### Merge to every install, target 20 min",
    );
    // No "Fleet done" step on this deploy: the total says plainly where it ends.
    expect(r.current.e2e.last20).toEqual([
      {
        tag: "v0.245.1",
        e2e: 45.8,
        to: "prod deploy (fleet not yet measured)",
      },
    ]);
    expect(summary(r.current)).toContain(
      "| Release | Minutes | To | Against 20 min |",
    );
    expect(summary(r.current)).toContain(
      "| v0.245.1 | 45.8 | prod deploy (fleet not yet measured) | 25.8 over |",
    );
    expect(summary(r.current)).toContain(
      "| staging_deploy | 4.7 | 4.7 | 1 | 4.3 | 9.3 |",
    );
    expect(summary(r.current)).toContain("| fleet | - | - | 0 | - | - |");
    expect(summary(r.current)).toContain("Measured only where recorded: fleet");
  });

  it("reads jobs only of hosted-release, hosted-publish and prod deploy runs since the oldest release not in history, and matches the staging publish by them", () => {
    const now = T("19:50:00");
    const f = fake(now);
    const publish = at(now).runs.find(
      (r) =>
        r.path.endsWith("hosted-publish.yml") &&
        r.event === "workflow_run" &&
        ms(r.createdAt) >= ms(T("19:01:32")),
    ) as Run;
    // A recovery shape: the run is on another main commit and names the tag in its job.
    const exec: Exec = (cmd, args) => {
      const path = args[args.length - 1] ?? "";
      if (path.includes("/actions/workflows/hosted-publish.yml/"))
        return {
          code: 0,
          stdout: at(now)
            .runs.filter((r) => r.path.endsWith("/hosted-publish.yml"))
            .map((r) =>
              JSON.stringify(
                r.id === publish.id ? { ...r, headSha: "b".repeat(40) } : r,
              ),
            )
            .join("\n"),
          stderr: "",
        };
      if (
        path ===
        `repos/o/c/actions/runs/${publish.id}/jobs?filter=latest&per_page=100`
      ) {
        f.calls.push(path);
        return {
          code: 0,
          stdout: [
            { name: "resolve", conclusion: "success" },
            { name: "publish-staging release v0.245.1", conclusion: "success" },
          ]
            .map((j) => JSON.stringify(j))
            .join("\n"),
          stderr: "",
        };
      }
      return f.exec(cmd, args);
    };
    const r = tick({
      exec,
      repo: "o/c",
      publicRepo: "o/p",
      config,
      history: [
        {
          tag: "v0.245.0",
          mode: "pr",
          publishedAt: T("17:23:42"),
          doneAt: T("18:04:15"),
          stages: {},
        },
      ],
      now,
      issue: false,
    });
    const want = at(now)
      .runs.filter(
        (x) =>
          (/\/hosted-(release|publish)\.yml$/.test(x.path) ||
            x.title.startsWith("deploy-hosted-platform prod ")) &&
          ms(x.createdAt) >= ms(T("19:01:32")),
      )
      .map(
        (x) => `repos/o/c/actions/runs/${x.id}/jobs?filter=latest&per_page=100`,
      );
    // hosted-release, the staging copy, the prod copy and the prod deploy.
    expect(want.length).toBe(4);
    // Plus v0.245.0's prod deploy: it is in history to the prod deploy (no
    // fleet measured), so a later "Fleet done" for its tag would count.
    const v0450 = at(now).runs.find((x) =>
      x.title.startsWith("deploy-hosted-platform prod v0.245.0"),
    ) as Run;
    expect([...f.calls.filter((c) => c.includes("/jobs?"))].sort()).toEqual(
      [
        ...want,
        `repos/o/c/actions/runs/${v0450.id}/jobs?filter=latest&per_page=100`,
      ].sort(),
    );
    const t = r.current.releases.find((x) => x.tag === "v0.245.1");
    expect(t?.stages.find((x) => x.name === "staging_publish")).toMatchObject({
      state: "done",
      minutes: 3.9,
    });
  });

  it("an old release's pin PR off the newest-100 page is still found by its head branch", () => {
    const now = "2026-11-26T09:00:00Z";
    const f = fake(T("19:50:00"), []);
    const r = tick({
      exec: f.exec,
      repo: "o/c",
      publicRepo: "o/p",
      config,
      history: [],
      now,
      issue: true,
    });
    const t = r.current.releases.find((x) => x.tag === "v0.245.1");
    expect(t?.stages.find((s) => s.name === "pin_open")?.state).toBe("done");
    expect(r.over).toEqual([]);
    expect(f.calls.filter((c) => c.startsWith("issue"))).toEqual([
      "issue list",
    ]);
  });

  it("a release finished in history is not rebuilt: no PR read, done even with nothing left to read", () => {
    const now = "2026-11-26T09:00:00Z";
    const f = fake(T("19:06:00"), []);
    const exec: Exec = (cmd, args) => {
      const path = args[args.length - 1] ?? "";
      if (path.includes("/pulls?") || path.includes("/actions/workflows/"))
        return { code: 0, stdout: "", stderr: "" };
      return f.exec(cmd, args);
    };
    const h: HistoryEntry = {
      tag: "v0.245.1",
      mode: "pr",
      mergedAt: fx.merges["v0.245.1"],
      publishedAt: T("18:20:00"),
      doneAt: T("19:06:00"),
      e2e: 45.8,
      stages: { tag: 3.6 },
    };
    const r = tick({
      exec,
      repo: "o/c",
      publicRepo: "o/p",
      config,
      history: [h],
      now,
      issue: true,
    });
    expect(f.calls.filter((c) => c.includes("/pulls?"))).toEqual([]);
    // Nothing in flight: no run's jobs are read.
    expect(f.calls.filter((c) => c.includes("/jobs?"))).toEqual([]);
    expect(r.over).toEqual([]);
    expect(r.current.inFlight).toEqual([]);
    expect(r.history).toEqual([h]);
    expect(f.calls.filter((c) => c.startsWith("issue"))).toEqual([
      "issue list",
    ]);
  });

  it("the newest finished release in history still keeps its own overruns", () => {
    const tag = config.stages.find((s) => s.name === "tag");
    const h: HistoryEntry = {
      tag: "v0.245.1",
      mode: "pr",
      publishedAt: T("18:20:00"),
      doneAt: T("19:06:00"),
      e2e: 10,
      stages: { tag: (tag?.usual ?? 0) * 2 + 5 },
    };
    const r = compute({
      releases: [{ tag: "v0.245.1", publishedAt: T("18:20:00") }],
      runs: [],
      prs: [],
      merges: {},
      history: [h],
      config,
      now: "2026-11-26T09:00:00Z",
    });
    expect(r.over.map((o) => [o.tag, o.stage, o.kind])).toEqual([
      ["v0.245.1", "tag", "finished"],
    ]);
  });

  it("the newest release stays watched however old, and widens the runs window to it", () => {
    const now = "2026-11-26T09:00:00Z";
    const f = fake(T("19:06:00"));
    tick({
      exec: f.exec,
      repo: "o/c",
      publicRepo: "o/p",
      config,
      history: [],
      now,
      issue: false,
    });
    expect(f.calls.find((c) => c.includes("hosted-release.yml"))).toContain(
      "created=>=2026-11-25T19:01:32Z",
    );
    expect(f.calls.filter((c) => c.startsWith("issue"))).toEqual([]);
  });

  it("a backfill reads every release since the day, ignoring history, paginated", () => {
    const f = fake(T("23:50:00"));
    const calls: string[][] = [];
    const exec: Exec = (cmd, args) => {
      calls.push(args);
      return f.exec(cmd, args);
    };
    const r = tick({
      exec,
      repo: "o/c",
      publicRepo: "o/p",
      config,
      history: [
        {
          tag: "v0.245.0",
          mode: "pr",
          publishedAt: T("17:00:00"),
          doneAt: T("18:00:00"),
          stages: { tag: 1 },
        },
      ],
      since: "2026-11-20",
      now: T("23:50:00"),
      issue: false,
    });
    expect(f.calls.filter((c) => c.includes("/compare/"))).toHaveLength(3);
    expect(
      calls.find((a) => (a[a.length - 1] ?? "").includes("/releases?")),
    ).toContain("--paginate");
    expect(
      calls.find((a) => (a[a.length - 1] ?? "").includes("/pulls?")),
    ).toContain("--paginate");
    expect(f.calls.find((c) => c.includes("hosted-release.yml"))).toContain(
      "created=>=2026-11-20T00:00:00Z",
    );
    expect(r.history.map((h) => h.tag)).toEqual(["v0.245.0", "v0.245.1"]);
    // The history passed in is ignored: v0.245.0 is rebuilt (no previous tag here, so its tag stage is untimed).
    expect(r.history[0]?.stages.tag).toBeUndefined();
    expect(r.history[1]?.stages.tag).toBe(3.6);
  });
});

describe("run-name contract", () => {
  it("the titles the watcher matches are the ones the workflows set", () => {
    expect(read(".github/workflows/deploy-hosted-platform.yml")).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "run-name: deploy-hosted-platform ${{ inputs.env }} ${{ inputs.tag }}${{ inputs.chain_id && format(' [{0}]', inputs.chain_id) || '' }}",
    );
    expect(read(".github/workflows/redline-staging.yml")).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "run-name: redline-staging ${{ inputs.tag }}",
    );
    expect(read(".github/workflows/hosted-publish.yml")).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "run-name: hosted-publish${{ inputs.env && format(' {0} {1}', inputs.env, inputs.tag || inputs.floor_run_id) || '' }}${{ inputs.chain_id && format(' [{0}]', inputs.chain_id) || '' }}",
    );
    // The staging and prod publish jobs name the tag their resolve job verified.
    expect(read(".github/workflows/hosted-publish.yml")).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "name: publish-staging ${{ needs.resolve.outputs.kind }} ${{ needs.resolve.outputs.tag }}",
    );
    expect(read(".github/workflows/hosted-publish.yml")).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "name: publish-prod ${{ needs.resolve.outputs.kind }} ${{ needs.resolve.outputs.tag }}",
    );
    expect(read(".github/workflows/hosted-release.yml")).toMatch(
      /^on:\n {2}push:\n {4}branches: \[main\]\n {4}paths: \[PUBLIC_PIN\]$/m,
    );
  });
});

describe("release-watch.yml", () => {
  // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
  const w: any = parse(read(".github/workflows/release-watch.yml"));
  const raw = read(".github/workflows/release-watch.yml");
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  const steps: any[] = w.jobs.watch.steps;

  it("runs after the chain's workflows on main, every 5 minutes, and on dispatch", () => {
    expect(Object.keys(w.on)).toEqual([
      "workflow_run",
      "schedule",
      "workflow_dispatch",
    ]);
    expect(w.on.workflow_run.workflows).toEqual([
      "pin-bump",
      "hosted-release",
      "hosted-publish",
      "deploy-hosted-platform",
      "redline-staging",
      "prod-release-chain",
    ]);
    expect(w.on.workflow_run.types).toEqual(["completed"]);
    expect(w.on.workflow_run.branches).toEqual(["main"]);
    expect(w.on.schedule).toEqual([{ cron: "*/5 * * * *" }]);
    expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual([
      "backfill_since",
    ]);
  });
  it("every watched workflow exists under that name", () => {
    for (const n of w.on.workflow_run.workflows as string[])
      expect(read(`.github/workflows/${n}.yml`)).toMatch(
        new RegExp(`^name: ${n}$`, "m"),
      );
  });
  it("is never a pull_request check", () => {
    expect(raw).not.toMatch(/pull_request|merge_group|push:/);
  });
  it("grants nothing at the top; the one job reads and writes issues only", () => {
    expect(w.permissions).toEqual({});
    expect(Object.keys(w.jobs)).toEqual(["watch"]);
    expect(w.jobs.watch.permissions).toEqual({
      contents: "read",
      actions: "read",
      issues: "write",
    });
    expect(w.jobs.watch["timeout-minutes"]).toBe(5);
  });
  it("uses no secret but the default token, and pins every action", () => {
    expect(raw).not.toMatch(/secrets\./);
    for (const s of steps.filter((x) => x.uses))
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    for (const s of steps.filter((x) => x.env?.GH_TOKEN))
      expect(s.env.GH_TOKEN).toBe("${{ github.token }}");
  });
  it("never interpolates an expression into a script", () => {
    for (const s of steps.filter((x) => x.run))
      expect(s.run).not.toContain("${{");
    const m = steps.find((s) => s.name === "Measure the releases");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(m.env.BACKFILL_SINCE).toBe("${{ inputs.backfill_since }}");
  });
  it("serializes runs without cancelling a running one", () => {
    expect(w.concurrency).toEqual({
      group: "release-watch",
      "cancel-in-progress": false,
    });
  });
  it("uploads current.json and history.jsonl as release-stats, the artifact it reads back", () => {
    const up = steps.find((s) =>
      String(s.uses).startsWith("actions/upload-artifact@"),
    );
    expect(up.with.name).toBe("release-stats");
    expect(up.with.path).toContain("out/current.json");
    expect(up.with.path).toContain("out/history.jsonl");
    expect(raw).toContain(
      "actions/workflows/release-watch.yml/runs?branch=main&status=success",
    );
    expect(raw).toContain("artifacts?name=release-stats");
    expect(raw).not.toContain("repos/$REPO/actions/artifacts?");
    expect(up.with["retention-days"]).toBe(7);
  });
});
