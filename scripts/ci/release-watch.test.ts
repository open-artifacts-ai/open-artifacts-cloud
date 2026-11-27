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
  carryMerges,
  commentBody,
  commentKey,
  commentPlan,
  compute,
  EARLIER_FLEET_RE,
  earlierFleetList,
  eta,
  FLEET_DONE_STEP,
  FLEET_UPPER,
  FLEET_WAIT_STEP,
  FLEET_WAKE_STEP,
  fleetStep,
  fromHistory,
  type HistoryEntry,
  historyEntry,
  ISSUE_TITLE,
  type Job,
  lateFleetDone,
  limitOf,
  loadConfig,
  mergeHistory,
  NO_FLEET,
  namedTag,
  notifyStuck,
  type Overrun,
  overruns,
  PROD_RE,
  type Pr,
  parseHistory,
  pct,
  pinSubject,
  type Release,
  type Run,
  STAGING_RE,
  settleSuperseded,
  stats,
  step,
  stuck,
  summary,
  supersede,
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
    expect(commentPlan([], w.over)).toEqual([]);
  });

  it("staging_deploy past its limit mid-flight is a comment naming the release, stage, run and attempts", () => {
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
        runId: 45684245945,
        attempts: 1,
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
    const [o] = commentPlan([], r.over);
    const body = commentBody(o as never, "o/c", config);
    expect(body).toContain(
      "**v0.245.1 staging_deploy** is still running past its limit: it has been going 9.4 min (since 2026-11-25T19:20:38Z); usual 4.3 min, limit 9.3 min",
    );
    expect(body).toContain(
      "- Run: [45684245945](https://github.com/o/c/actions/runs/45684245945), still running, nothing to rerun yet.",
    );
    expect(body).toContain("- Attempts: 1");
    expect(body).toContain(
      "<!-- release-watch v0.245.1 staging_deploy running -->",
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
    // The red stage is listed; at 7 min it is under its limit, so no
    // comment. Its finished stages past their limits are (93 min to tag,
    // 37.6 min to merge the pin PR).
    expect(r.over.map((o) => [o.stage, o.kind, o.minutes])).toEqual([
      ["tag", "finished", 93],
      ["pin_merge", "finished", 37.6],
    ]);
    // The tag and pin stages have no run of their own: the comment says so.
    expect(commentBody(r.over[1] as never, "o/c", config)).toContain(
      "- Run: none. This stage is a wait between events (https://github.com/open-artifacts-ai/open-artifacts-cloud/pull/448).",
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

  it("a superseded release closes when the newer one is done, with no total of its own", () => {
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
    // The newer release's prod deploy is not its own: no total.
    expect(t?.e2e).toBeUndefined();
    expect(t?.e2eTo).toBe("superseded by v0.246.1");
    const r = world(now, w);
    const h = r.history.find((x) => x.tag === "v0.246.0");
    expect(h).toMatchObject({
      supersededBy: "v0.246.1",
      doneAt: T("23:57:00"),
      e2eTo: "superseded by v0.246.1",
    });
    expect(h).not.toHaveProperty("e2e");
    expect(r.current.e2e.last20.map((x) => x.tag)).not.toContain("v0.246.0");
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
    // Its deploy also carried v0.246.0's code: the total starts at that merge.
    expect(h).toMatchObject({
      doneAt: D("01:07:55"),
      e2e: 315.7,
      carries: ["v0.246.0"],
      firstMergeAt: fx.merges["v0.246.0"],
    });
    // current.json matches: v0.246.1 keeps its own 237.5 min and adds the
    // carried total and list; v0.246.0 says it was superseded.
    const cur = (tag: string) => r.current.releases.find((x) => x.tag === tag);
    expect(cur("v0.246.1")).toMatchObject({
      e2e: 237.5,
      carries: ["v0.246.0"],
      firstMergeAt: fx.merges["v0.246.0"],
      carriedE2e: 315.7,
    });
    expect(cur("v0.246.0")).toMatchObject({
      supersededBy: "v0.246.1",
      e2eTo: "superseded by v0.246.1",
    });
    expect(cur("v0.246.0")).not.toHaveProperty("e2e");
    expect(cur("v0.246.0")).not.toHaveProperty("carriedE2e");
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
        runId: 45756565482,
        attempts: 1,
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
    expect(commentBody(r.over[0] as never, "o/c", config)).toContain(
      "**v0.248.2 staging_deploy** is still running past its limit: it has not started 10 min after what it waits on ended (since 2026-11-26T04:39:06Z); usual 4.3 min, limit 9.3 min",
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
    // The step ends after the scheduler's own mark: an upper bound, said so.
    expect(t.e2eTo).toBe(FLEET_UPPER);
    expect(t.e2e).toBe(44.1);
    const r = compute({
      ...world2(chain({ prod: prodRuns(fleetDone) }), now),
      history: [],
      config,
      now,
    });
    expect(r.history[0]).toMatchObject({
      tag: "v0.248.2",
      e2eTo: FLEET_UPPER,
      e2e: 44.1,
    });
    expect(r.history[0]?.stages.fleet).toBe(4.9);
    expect(summary(r.current)).toContain(
      `| v0.248.2 | 44.1 | ${FLEET_UPPER} | 24.1 over |`,
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
    // The fleet's start is the tag's first successful wake.
    const done = {
      deployEnd: D("05:01:00"),
      fleet: {
        state: "done",
        startedAt: D("05:01:00"),
        doneAt: D("05:39:39"),
        url: `${RUNS}4`,
        exact: false,
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
    // The newest run decides the state (done); the first wake the timing.
    expect(row(t, "prod_deploy")).toMatchObject({
      state: "done",
      endedAt: D("05:01:00"),
      runId: 4,
    });
    expect(t.e2eTo).toBe(FLEET_UPPER);
    expect(t.doneAt).toBe(D("05:39:39"));
    // A backfill rebuilds from the runs, so it takes the later success too.
    const r = compute({
      ...world2(chain({ prod }), now),
      history: [],
      config,
      now,
    });
    expect(r.history[0]).toMatchObject({
      e2eTo: FLEET_UPPER,
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
      e2eTo: FLEET_UPPER,
      stages: { prod_deploy: 4.8, fleet: 38.7 },
    });
    // History from before e2eTo also ran to the prod deploy.
    const { e2eTo: _, ...old } = recorded;
    expect(upgradeFleet(old, prod).e2eTo).toBe(FLEET_UPPER);
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
      `| v0.248.2 | 77.9 | ${FLEET_UPPER} | 57.9 over |`,
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
    // The record is the scheduler's own mark: exact, so a "Fleet done" step
    // (which only ever ends after the mark) never replaces it.
    const both = [...prod, laterRun(4, "05:39:00", "05:40:05")];
    expect(row(tl2(chain({ prod: both }), now), "fleet")?.endedAt).toBe(
      D("05:39:39"),
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

// cloud #456 third review (comment 7192575452), from the live v0.251.0 and
// v0.251.1: PR #486 opened 11:14:42, merged 12:11:36; PR #490 opened
// 12:14:48, merged 12:53:57; v0.251.0's prod deploy 45820756312, its "Fleet
// done" step ending 12:45:26 while the scheduler's mark was 12:44:59.732.
describe("overlapping releases and the exact fleet finish (v0.251.0, v0.251.1)", () => {
  const D = (hms: string) => `2026-11-26T${hms}Z`;
  const RUNS =
    "https://github.com/open-artifacts-ai/open-artifacts-cloud/actions/runs/";
  const releases = [
    { tag: "v0.251.0", publishedAt: D("11:12:34") },
    { tag: "v0.251.1", publishedAt: D("12:12:37") },
  ];
  const merges = { "v0.251.0": D("10:03:10"), "v0.251.1": D("12:00:00") };
  const pr = (
    number: number,
    tag: string,
    created: string,
    merged: string | null,
  ): Pr => ({
    number,
    ref: `pin-bump/${tag}`,
    createdAt: D(created),
    mergedAt: merged ? D(merged) : null,
    url: `https://github.com/open-artifacts-ai/open-artifacts-cloud/pull/${number}`,
  });
  const v0510: HistoryEntry = {
    tag: "v0.251.0",
    mode: "pr",
    mergedAt: merges["v0.251.0"],
    publishedAt: D("11:12:34"),
    doneAt: D("12:45:26"),
    e2e: 162.3,
    e2eTo: FLEET_UPPER,
    stages: {
      tag: 69.4,
      pin_open: 2.1,
      pin_merge: 56.9,
      prod_deploy: 3.8,
      fleet: 8.2,
    },
  };

  it("a newer release in flight never hides an older one's stages that finished past their limits", () => {
    const run = (now: string, prs: Pr[], history: HistoryEntry[]) =>
      compute({ releases, runs: [], prs, merges, history, config, now });
    // v0.251.0 alone: both its finished overruns are comments.
    const alone = compute({
      releases: releases.slice(0, 1),
      runs: [],
      prs: [],
      merges,
      history: [v0510],
      config,
      now: D("12:50:00"),
    });
    expect(
      alone.notify.map((o) => [o.tag, o.stage, o.minutes, o.limit]),
    ).toEqual([
      ["v0.251.0", "tag", 69.4, 40.8],
      ["v0.251.0", "pin_merge", 56.9, 30.1],
    ]);
    // With v0.251.1 in flight, its pin PR open 35.2 min (past 30.1): v0.251.0's
    // two stay, and v0.251.1's pin, still going, is in the summary only.
    const both = run(
      D("12:50:00"),
      [pr(490, "v0.251.1", "12:14:48", null)],
      [v0510],
    );
    // v0.251.1's pin, seen still running past its limit: its own heads-up.
    expect(both.notify.map((o) => [o.tag, o.stage, o.kind])).toEqual([
      ["v0.251.0", "tag", "finished"],
      ["v0.251.0", "pin_merge", "finished"],
      ["v0.251.1", "pin_merge", "in_flight"],
    ]);
    expect(commentKey(both.notify[2] as Overrun)).toBe(
      "<!-- release-watch v0.251.1 pin_merge running -->",
    );
    expect(both.over.map((o) => [o.tag, o.stage, o.kind])).toContainEqual([
      "v0.251.1",
      "pin_merge",
      "in_flight",
    ]);
    // The pin merges at 12:53:57 (39.2 min): that event comments on it too.
    const merged = run(
      D("12:54:30"),
      [pr(490, "v0.251.1", "12:14:48", "12:53:57")],
      [v0510],
    );
    expect(
      merged.notify.map((o) => [o.tag, o.stage, o.kind, o.minutes]),
    ).toEqual([
      ["v0.251.0", "tag", "finished", 69.4],
      ["v0.251.0", "pin_merge", "finished", 56.9],
      ["v0.251.1", "pin_merge", "finished", 39.2],
    ]);
    // Said once: a later event with all three keys on the issue posts nothing.
    const said = merged.notify.map((o) => ({
      author: "github-actions[bot]",
      body: commentKey(o),
    }));
    expect(commentPlan(said, merged.notify)).toEqual([]);
    // A backfill comments only on what a normal run would see.
    expect(stuck([fromHistory(v0510, config)], config, D("12:00:00"))).toEqual(
      [],
    );
  });

  const deploy = (o: {
    id: number;
    tag: string;
    created: string;
    updated: string;
    steps: Job["steps"];
  }): Run => ({
    id: o.id,
    path: ".github/workflows/deploy-hosted-platform.yml",
    event: "workflow_dispatch",
    title: `deploy-hosted-platform prod ${o.tag} [c${o.id}-1]`,
    status: "completed",
    conclusion: "success",
    headSha: "a".repeat(40),
    createdAt: D(o.created),
    startedAt: D(o.created),
    updatedAt: D(o.updated),
    attempt: 1,
    url: `${RUNS}${o.id}`,
    commitMessage: "x",
    commitAt: D(o.created),
    jobs: [{ name: "deploy", conclusion: "success", steps: o.steps }],
  });
  const st = (name: string, a: string, b: string, conclusion = "success") => ({
    name,
    status: "completed",
    conclusion,
    startedAt: D(a),
    completedAt: D(b),
  });
  // Run 45820756312's steps as recorded.
  const ownDeploy = deploy({
    id: 45820756312,
    tag: "v0.251.0",
    created: "12:33:28",
    updated: "12:45:33",
    steps: [
      st("Read the fleet finish of earlier releases", "12:34:43", "12:34:44"),
      st(
        "Fleet done of earlier releases ()",
        "12:34:44",
        "12:34:44",
        "skipped",
      ),
      st("Mark the platform verified", "12:37:16", "12:37:16"),
      st(FLEET_WAKE_STEP, "12:37:17", "12:37:17"),
      st(FLEET_WAIT_STEP, "12:37:17", "12:45:26"),
      st(FLEET_DONE_STEP, "12:45:26", "12:45:26"),
    ],
  });
  // v0.251.1's prod deploy records the mark's own time.
  const nextDeploy = deploy({
    id: 45830000001,
    tag: "v0.251.1",
    created: "13:20:00",
    updated: "13:32:00",
    steps: [
      st("Read the fleet finish of earlier releases", "13:21:00", "13:21:01"),
      st(
        "Fleet done of earlier releases (v0.251.0 at 2026-11-26T12:44:59.732Z)",
        "13:21:01",
        "13:21:01",
      ),
    ],
  });

  it("the Fleet done step's end is an upper bound; the scheduler's own mark, once recorded, is the exact finish", () => {
    expect(fleetStep([ownDeploy]).fleet).toMatchObject({
      state: "done",
      doneAt: D("12:45:26"),
      exact: false,
    });
    expect(
      fleetStep([ownDeploy], lateFleetDone([ownDeploy, nextDeploy], "v0.251.0"))
        .fleet,
    ).toMatchObject({
      state: "done",
      doneAt: "2026-11-26T12:44:59.732Z",
      exact: true,
    });
  });

  it("history kept at the step's end takes the exact mark from the next deploy: 26.268 s earlier", () => {
    const fixed = upgradeFleet(v0510, [ownDeploy, nextDeploy]);
    expect(fixed).toEqual({
      ...v0510,
      doneAt: "2026-11-26T12:44:59.732Z",
      e2e: 161.8,
      e2eTo: "every install",
      stages: { ...v0510.stages, fleet: 7.7 },
    });
    expect(ms(v0510.doneAt) - ms(fixed.doneAt)).toBe(26_268);
    // Without the record it stays an upper bound, never the time the watcher saw it.
    expect(upgradeFleet(v0510, [ownDeploy])).toBe(v0510);
    // Exact already: a later step end never moves it.
    expect(upgradeFleet(fixed, [ownDeploy, nextDeploy])).toBe(fixed);
    // Through a run's compute: the history line moves.
    const r = compute({
      releases,
      runs: [ownDeploy, nextDeploy],
      prs: [pr(490, "v0.251.1", "12:14:48", "12:53:57")],
      merges,
      history: [v0510],
      config,
      now: D("13:35:00"),
    });
    expect(r.history.find((h) => h.tag === "v0.251.0")).toEqual(fixed);
  });
});

// cloud #495 (head 92906afe): the prod deploy no longer waits for the fleet.
// It keeps "Wake the fleet" and drops "Wait for the fleet to reach every
// install" and "Fleet done"; the finish comes only from a later prod deploy's
// "Fleet done of earlier releases" record.
describe("the fleet without the deploy's wait (cloud #495)", () => {
  const D = (hms: string) => `2026-11-27T${hms}Z`;
  const RUNS =
    "https://github.com/open-artifacts-ai/open-artifacts-cloud/actions/runs/";
  const st = (name: string, a: string, b: string, conclusion = "success") => ({
    name,
    status: "completed",
    conclusion,
    startedAt: D(a),
    completedAt: D(b),
  });
  const deploy = (
    id: number,
    tag: string,
    created: string,
    updated: string,
    steps: Job["steps"],
  ): Run => ({
    id,
    path: ".github/workflows/deploy-hosted-platform.yml",
    event: "workflow_dispatch",
    title: `deploy-hosted-platform prod ${tag} [c${id}-1]`,
    status: "completed",
    conclusion: "success",
    headSha: "b".repeat(40),
    createdAt: D(created),
    startedAt: D(created),
    updatedAt: D(updated),
    attempt: 1,
    url: `${RUNS}${id}`,
    commitMessage: "x",
    commitAt: D(created),
    jobs: [{ name: "deploy", conclusion: "success", steps }],
  });
  // #495's shape: wake, then the run ends; no wait, no "Fleet done".
  const own = deploy(100, "v0.252.0", "09:00:00", "09:06:30", [
    st("Read the fleet finish of earlier releases", "09:01:00", "09:01:01"),
    st("Fleet done of earlier releases ()", "09:01:01", "09:01:01", "skipped"),
    st("Mark the platform verified", "09:04:00", "09:04:01"),
    st("The tag's scheduler takes the fleet wake", "09:04:01", "09:04:02"),
    st(FLEET_WAKE_STEP, "09:04:02", "09:04:03"),
  ]);
  const next = deploy(200, "v0.252.1", "11:00:00", "11:06:00", [
    st("Read the fleet finish of earlier releases", "11:01:00", "11:01:01"),
    st(
      "Fleet done of earlier releases (v0.251.1 at 2026-11-26T14:00:00.000Z, v0.252.0 at 2026-11-27T09:09:41.250Z)",
      "11:01:01",
      "11:01:01",
    ),
  ]);
  const rel = { tag: "v0.252.0", publishedAt: D("08:30:00") };
  const tl3 = (runs: Run[], now: string) =>
    timeline({
      release: rel,
      runs,
      prs: [],
      mergedAt: D("08:20:00"),
      config,
      now: D(now),
    });

  it("the deploy ends at Wake the fleet even with no wait step; before the next prod deploy the fleet is pending", () => {
    expect(fleetStep([own])).toEqual({
      deployEnd: D("09:04:02"),
      fleet: { state: "none" },
    });
    const t = tl3([own], "10:00:00");
    expect(t.stages.find((x) => x.name === "prod_deploy")).toMatchObject({
      state: "done",
      startedAt: D("09:00:00"),
      endedAt: D("09:04:02"),
    });
    expect(t.stages.find((x) => x.name === "fleet")?.state).toBe("unmeasured");
    expect(t.e2eTo).toBe(NO_FLEET);
    expect(t.doneAt).toBe(D("09:04:02"));
  });

  it("the next prod deploy's record is the exact finish, from the wake; never an upper bound", () => {
    const late = lateFleetDone([own, next], "v0.252.0");
    expect(late).toEqual({ at: "2026-11-27T09:09:41.250Z", url: `${RUNS}200` });
    expect(fleetStep([own], late)).toEqual({
      deployEnd: D("09:04:02"),
      fleet: {
        state: "done",
        startedAt: D("09:04:02"),
        doneAt: "2026-11-27T09:09:41.250Z",
        url: `${RUNS}200`,
        exact: true,
      },
    });
    const t = tl3([own, next], "11:10:00");
    expect(t.stages.find((x) => x.name === "fleet")).toMatchObject({
      state: "done",
      startedAt: D("09:04:02"),
      endedAt: "2026-11-27T09:09:41.250Z",
      minutes: 5.7,
    });
    expect(t.e2eTo).toBe("every install");
    expect(t.e2e).toBe(49.7);
    // History saved at the prod deploy takes it when the record appears.
    const h: HistoryEntry = {
      tag: "v0.252.0",
      mode: "pr",
      mergedAt: D("08:20:00"),
      publishedAt: D("08:30:00"),
      doneAt: D("09:04:02"),
      e2e: 44,
      e2eTo: NO_FLEET,
      stages: { prod_deploy: 4 },
    };
    expect(upgradeFleet(h, [own])).toBe(h);
    expect(upgradeFleet(h, [own, next])).toEqual({
      ...h,
      doneAt: "2026-11-27T09:09:41.250Z",
      e2e: 49.7,
      e2eTo: "every install",
      stages: { prod_deploy: 4, fleet: 5.7 },
    });
  });

  it("older runs with the wait and Fleet done steps still read the same way: an upper bound until a record", () => {
    const old = deploy(300, "v0.252.0", "09:00:00", "09:12:00", [
      st("Mark the platform verified", "09:04:00", "09:04:01"),
      st(FLEET_WAKE_STEP, "09:04:02", "09:04:03"),
      st(FLEET_WAIT_STEP, "09:04:03", "09:09:50"),
      st(FLEET_DONE_STEP, "09:10:05", "09:10:05"),
    ]);
    expect(fleetStep([old]).fleet).toMatchObject({
      state: "done",
      startedAt: D("09:04:02"),
      doneAt: D("09:10:05"),
      exact: false,
    });
    expect(tl3([old], "10:00:00").e2eTo).toBe(FLEET_UPPER);
    expect(
      fleetStep([old], lateFleetDone([old, next], "v0.252.0")).fleet,
    ).toMatchObject({ doneAt: "2026-11-27T09:09:41.250Z", exact: true });
    // An old wait still going: the fleet is running.
    const going = deploy(301, "v0.252.0", "09:00:00", "09:06:00", [
      st(FLEET_WAKE_STEP, "09:04:02", "09:04:03"),
      {
        name: FLEET_WAIT_STEP,
        status: "in_progress",
        conclusion: null,
        startedAt: D("09:04:03"),
        completedAt: null,
      },
    ]);
    expect(
      fleetStep([{ ...going, status: "in_progress", conclusion: null }]).fleet
        .state,
    ).toBe("running");
  });
});

// Prover's controls on #497 (comment 7193897615): prod run 45820756312 in
// #495's shape (no wait, no "Fleet done"), its "Wake the fleet" step and job
// marked success, failure and cancelled. #495 makes a refused wake fail the
// deploy after the final attempt.
describe("a prod deploy whose wake failed (cloud #495)", () => {
  const D = (hms: string) => `2026-11-26T${hms}Z`;
  const RUN = 45820756312;
  const URL = `https://github.com/open-artifacts-ai/open-artifacts-cloud/actions/runs/${RUN}`;
  const st = (name: string, a: string, b: string, conclusion = "success") => ({
    name,
    status: "completed",
    conclusion,
    startedAt: D(a),
    completedAt: D(b),
  });
  const run = (
    wake: "success" | "failure" | "cancelled" | "skipped",
    job: "success" | "failure" = wake === "success" || wake === "skipped"
      ? "success"
      : "failure",
  ): Run => ({
    id: RUN,
    path: ".github/workflows/deploy-hosted-platform.yml",
    event: "workflow_dispatch",
    title: "deploy-hosted-platform prod v0.251.0 [c45820247442-1]",
    status: "completed",
    conclusion: wake === "cancelled" ? "cancelled" : job,
    headSha: "c".repeat(40),
    createdAt: D("12:33:28"),
    startedAt: D("12:33:28"),
    updatedAt: D("12:45:33"),
    attempt: 1,
    url: URL,
    commitMessage: "x",
    commitAt: D("12:33:28"),
    jobs: [
      {
        name: "deploy",
        conclusion: wake === "cancelled" ? "cancelled" : job,
        steps: [
          st(
            "Read the fleet finish of earlier releases",
            "12:34:43",
            "12:34:44",
          ),
          st("Mark the platform verified", "12:37:16", "12:37:16"),
          st(
            "The tag's scheduler takes the fleet wake",
            "12:37:16",
            "12:37:17",
            wake === "skipped" ? "skipped" : "success",
          ),
          st(FLEET_WAKE_STEP, "12:37:17", "12:37:17", wake),
        ],
      },
    ],
  });
  // The prod copy before it, so the deploy's wait (after) has ended.
  const publish: Run = {
    ...run("success"),
    id: 45820247442,
    path: ".github/workflows/hosted-publish.yml",
    title: "hosted-publish prod v0.251.0 [p45820247442-1]",
    createdAt: D("12:30:00"),
    startedAt: D("12:30:00"),
    updatedAt: D("12:33:00"),
    conclusion: "success",
    jobs: undefined,
    url: "https://github.com/open-artifacts-ai/open-artifacts-cloud/actions/runs/45820247442",
  };
  const tlOf = (r: Run, now = D("12:50:00")) =>
    timeline({
      release: { tag: "v0.251.0", publishedAt: D("11:12:34") },
      runs: [publish, r],
      prs: [],
      mergedAt: D("10:03:10"),
      config,
      now,
    });
  const notifyOf = (r: Run) =>
    stuck([tlOf(r)], config).filter((o) => o.stage === "prod_deploy");

  it("a successful wake: the deploy is done at the wake's start, the fleet pending, no alert", () => {
    const t = tlOf(run("success"));
    expect(t.stages.find((x) => x.name === "prod_deploy")).toMatchObject({
      state: "done",
      endedAt: D("12:37:17"),
    });
    expect(t.stages.find((x) => x.name === "fleet")?.state).toBe("unmeasured");
    expect(t.e2eTo).toBe(NO_FLEET);
    expect(notifyOf(run("success"))).toEqual([]);
  });

  for (const wake of ["failure", "cancelled"] as const)
    it(`a ${wake} wake fails the deploy, anchors no fleet start, and is a failed-stage comment with --failed`, () => {
      expect(fleetStep([run(wake)])).toEqual({ fleet: { state: "none" } });
      const t = tlOf(run(wake));
      expect(t.stages.find((x) => x.name === "prod_deploy")).toMatchObject({
        state: "red",
        runId: RUN,
        url: URL,
      });
      expect(t.doneAt).toBeUndefined();
      const [o] = notifyOf(run(wake));
      expect(o).toMatchObject({
        kind: "failed",
        stage: "prod_deploy",
        runId: RUN,
      });
      expect(commentBody(o as Overrun, "o/c", config).split("\n")[2]).toBe(
        `- Run: [${RUN}](https://github.com/o/c/actions/runs/${RUN}), failed. It is a release workflow, so rerun only its failed jobs (AGENTS.md): open the run and choose "Re-run failed jobs", or \`gh run rerun ${RUN} --failed -R o/c\`.`,
      );
    });

  it("a wake skipped on purpose on a green deploy (an older tag, a partial target list): done at the run's end, no alert", () => {
    // Without the old wait, the run ends right after the skipped wake.
    const r = { ...run("skipped", "success"), updatedAt: D("12:37:20") };
    expect(fleetStep([r])).toEqual({ fleet: { state: "none" } });
    const t = tlOf(r);
    expect(t.stages.find((x) => x.name === "prod_deploy")).toMatchObject({
      state: "done",
      endedAt: D("12:37:20"),
      minutes: 3.9,
    });
    expect(t.stages.find((x) => x.name === "fleet")?.state).toBe("unmeasured");
    expect(t.e2eTo).toBe(NO_FLEET);
    // No failed-stage alert, and no rerun advice: there is no failed job.
    expect(notifyOf(r)).toEqual([]);
    // The same skip on the replay's 12.1 min run: only a finished-past-limit
    // note ("finished green, nothing to rerun"), never a failed stage.
    const slow = notifyOf(run("skipped", "success"));
    expect(slow.map((o) => o.kind)).toEqual(["finished"]);
    expect(commentBody(slow[0] as Overrun, "o/c", config)).toContain(
      "finished green, nothing to rerun.",
    );
  });

  it("a wake skipped because the job failed before it: the run's own failure is the one alert", () => {
    const r = run("skipped", "failure");
    expect(fleetStep([r])).toEqual({ fleet: { state: "none" } });
    const t = tlOf(r);
    expect(t.stages.find((x) => x.name === "prod_deploy")).toMatchObject({
      state: "red",
      url: URL,
    });
    const alerts = notifyOf(r);
    expect(alerts.map((o) => [o.stage, o.kind, o.runId])).toEqual([
      ["prod_deploy", "failed", RUN],
    ]);
    expect(commentBody(alerts[0] as Overrun, "o/c", config)).toContain(
      `\`gh run rerun ${RUN} --failed -R o/c\``,
    );
  });

  it("a later run of the tag that woke the fleet wins over an earlier failed wake", () => {
    const failed = run("failure");
    const ok = {
      ...run("success"),
      id: RUN + 1,
      createdAt: D("12:50:00"),
      url: `${URL}1`,
    };
    expect(fleetStep([failed, ok]).deployEnd).toBe(D("12:37:17"));
  });

  // The Prover's recovery cases (comment 7194336736): two prod deploys of the
  // tag, the first one's wake failed. The newest run decides.
  const second = (o: Partial<Run>, wake?: "success" | "skipped"): Run => ({
    ...run(wake ?? "success", "success"),
    id: RUN + 1,
    createdAt: D("12:55:00"),
    startedAt: D("12:55:00"),
    updatedAt: D("12:59:20"),
    url: `${URL}1`,
    ...(wake
      ? {}
      : {
          jobs: [
            {
              name: "deploy",
              status: "in_progress",
              conclusion: null,
              steps: [
                st(
                  "Read the fleet finish of earlier releases",
                  "12:56:00",
                  "12:56:01",
                ),
              ],
            },
          ],
        }),
    ...o,
  });
  const prodRow = (rs: Run[]) =>
    timeline({
      release: { tag: "v0.251.0", publishedAt: D("11:12:34") },
      runs: [publish, ...rs],
      prs: [],
      mergedAt: D("10:03:10"),
      config,
      now: D("13:00:00"),
    }).stages.find((x) => x.name === "prod_deploy");
  const alerts = (rs: Run[]) =>
    stuck(
      [
        timeline({
          release: { tag: "v0.251.0", publishedAt: D("11:12:34") },
          runs: [publish, ...rs],
          prs: [],
          mergedAt: D("10:03:10"),
          config,
          now: D("13:00:00"),
        }),
      ],
      config,
    ).filter((o) => o.stage === "prod_deploy" && o.kind === "failed");

  it("a newer run still in progress after a failed wake is running, not failed", () => {
    const rs = [
      run("failure"),
      second({ status: "in_progress", conclusion: null }),
    ];
    expect(prodRow(rs)).toMatchObject({
      state: "current",
      runId: RUN + 1,
      url: `${URL}1`,
      startedAt: D("12:33:28"),
    });
    expect(alerts(rs)).toEqual([]);
  });

  it("a newer green run with its wake skipped on purpose after a failed wake is done, not failed", () => {
    const rs = [run("failure"), second({}, "skipped")];
    expect(prodRow(rs)).toMatchObject({
      state: "done",
      runId: RUN + 1,
      endedAt: D("12:59:20"),
    });
    expect(alerts(rs)).toEqual([]);
  });

  it("a newer run that woke the fleet clears an older failed wake: done at its own wake", () => {
    const woke = {
      ...second({}, "success"),
      jobs: [
        {
          name: "deploy",
          conclusion: "success",
          steps: [st(FLEET_WAKE_STEP, "12:58:00", "12:58:01")],
        },
      ],
    };
    expect(prodRow([run("failure"), woke])).toMatchObject({
      state: "done",
      runId: RUN + 1,
      endedAt: D("12:58:00"),
    });
    expect(fleetStep([run("failure"), woke]).deployEnd).toBe(D("12:58:00"));
    expect(alerts([run("failure"), woke])).toEqual([]);
  });

  it("two successful wakes with the D1 finish between them: the timing stays the first rollout's, in either run order", () => {
    // v0.251.0's wake 12:37:17 and D1 finish 12:44:59.732 (run 45827368805's
    // record), then a second green deploy of the tag waking at 12:55:00.
    const again: Run = {
      ...second({}, "success"),
      jobs: [
        {
          name: "deploy",
          conclusion: "success",
          steps: [st(FLEET_WAKE_STEP, "12:55:00", "12:55:01")],
        },
      ],
    };
    const record: Run = {
      ...second({}, "success"),
      id: 45827368805,
      title: "deploy-hosted-platform prod v0.251.1 [c45827368805-1]",
      createdAt: D("13:20:00"),
      url: "https://github.com/open-artifacts-ai/open-artifacts-cloud/actions/runs/45827368805",
      jobs: [
        {
          name: "deploy",
          conclusion: "success",
          steps: [
            st(
              "Fleet done of earlier releases (v0.251.0 at 2026-11-26T12:44:59.732Z)",
              "13:21:00",
              "13:21:00",
            ),
          ],
        },
      ],
    };
    for (const order of [
      [run("success"), again, record],
      [record, again, run("success")],
    ]) {
      const t = timeline({
        release: { tag: "v0.251.0", publishedAt: D("11:12:34") },
        runs: [publish, ...order],
        prs: [],
        mergedAt: D("10:03:10"),
        config,
        now: D("13:30:00"),
      });
      const fleet = t.stages.find((x) => x.name === "fleet");
      expect(fleet).toMatchObject({
        state: "done",
        startedAt: D("12:37:17"),
        endedAt: "2026-11-26T12:44:59.732Z",
        minutes: 7.7,
      });
      expect(ms(fleet?.endedAt ?? "") - ms(fleet?.startedAt ?? "")).toBe(
        462_732,
      );
      // The newest run decides the state; the first wake the timing.
      expect(t.stages.find((x) => x.name === "prod_deploy")).toMatchObject({
        state: "done",
        endedAt: D("12:37:17"),
        runId: RUN + 1,
      });
      expect(t.e2eTo).toBe("every install");
    }
  });

  it("a newer failed run after an older green one is failed, with the newer run's id", () => {
    const rs = [
      run("success"),
      second({ status: "completed", conclusion: "failure" }, "skipped"),
    ];
    expect(prodRow(rs)).toMatchObject({ state: "red", runId: RUN + 1 });
    expect(alerts(rs).map((o) => o.runId)).toEqual([RUN + 1]);
  });
});

// The Prover's backfill of 26 November (comment 7194698887): four superseded
// tags saved as "every install" with their successors' prod deploy times.
// These are the history lines that backfill wrote.
describe("superseded releases have no total of their own", () => {
  const saved = [
    '{"tag":"v0.247.0","mode":"pr","supersededBy":"v0.248.0","doneAt":"2026-11-26T05:07:38Z","e2e":362.7,"e2eTo":"every install","mergedAt":"2026-11-25T23:04:59Z","publishedAt":"2026-11-26T01:44:15Z","stages":{"tag":159.3,"pin_open":2,"pin_merge":9.3,"hosted_release":3.3,"staging_publish":2.7,"staging_deploy":4.6,"redline_queue":0.5}}',
    '{"tag":"v0.248.0","mode":"pr","supersededBy":"v0.248.1","doneAt":"2026-11-26T05:07:38Z","e2e":188.2,"e2eTo":"every install","mergedAt":"2026-11-26T01:59:24Z","publishedAt":"2026-11-26T02:02:25Z","stages":{"tag":3,"pin_open":1.8,"pin_merge":31.6,"hosted_release":3.1,"staging_publish":2.5,"staging_deploy":3.6,"redline_queue":0.4}}',
    '{"tag":"v0.248.1","mode":"pr","supersededBy":"v0.248.2","doneAt":"2026-11-26T05:07:38Z","e2e":146.9,"e2eTo":"every install","mergedAt":"2026-11-26T02:40:45Z","publishedAt":"2026-11-26T02:56:42Z","stages":{"tag":16,"pin_open":2.1,"pin_merge":14.6,"hosted_release":3.1,"staging_publish":2.8,"staging_deploy":4,"redline_queue":0.5}}',
    '{"tag":"v0.248.2","mode":"pr","doneAt":"2026-11-26T05:07:38Z","e2e":105.9,"e2eTo":"prod deploy (fleet not yet measured)","mergedAt":"2026-11-26T03:21:47Z","publishedAt":"2026-11-26T04:25:40Z","stages":{"tag":63.9,"prod_deploy":4.5}}',
    '{"tag":"v0.249.0","mode":"pr","supersededBy":"v0.249.1","doneAt":"2026-11-26T09:32:30Z","e2e":281.2,"e2eTo":"every install","mergedAt":"2026-11-26T04:51:17Z","publishedAt":"2026-11-26T07:08:49Z","stages":{"tag":137.5,"prod_deploy":3.8,"fleet":1}}',
    '{"tag":"v0.249.1","mode":"pr","doneAt":"2026-11-26T09:32:30Z","e2e":130.1,"e2eTo":"prod deploy (fleet not yet measured)","mergedAt":"2026-11-26T07:22:24Z","publishedAt":"2026-11-26T07:44:21Z","stages":{"tag":22,"prod_deploy":3.8}}',
  ].join("\n");
  const four = ["v0.247.0", "v0.248.0", "v0.248.1", "v0.249.0"];
  const by: Record<string, string> = {
    "v0.247.0": "v0.248.0",
    "v0.248.0": "v0.248.1",
    "v0.248.1": "v0.248.2",
    "v0.249.0": "v0.249.1",
  };

  it("saved history is corrected: superseded by its successor, no total, no prod or fleet time", () => {
    const h = parseHistory(saved);
    for (const tag of four) {
      const x = settleSuperseded(h.find((e) => e.tag === tag) as HistoryEntry);
      expect(x.e2eTo, tag).toBe(`superseded by ${by[tag]}`);
      expect(x, tag).not.toHaveProperty("e2e");
      expect(x.stages, tag).not.toHaveProperty("prod_deploy");
      expect(x.stages, tag).not.toHaveProperty("fleet");
    }
    // v0.249.0 had 281.2 min ending at v0.249.1's prod deploy (09:32:30Z).
    expect(
      settleSuperseded(h.find((e) => e.tag === "v0.249.0") as HistoryEntry),
    ).toEqual({
      tag: "v0.249.0",
      mode: "pr",
      supersededBy: "v0.249.1",
      doneAt: "2026-11-26T09:32:30Z",
      e2eTo: "superseded by v0.249.1",
      mergedAt: "2026-11-26T04:51:17Z",
      publishedAt: "2026-11-26T07:08:49Z",
      stages: { tag: 137.5 },
    });
    // Releases that had their own prod deploy are unchanged.
    const own = h.find((e) => e.tag === "v0.249.1") as HistoryEntry;
    expect(settleSuperseded(own)).toBe(own);
  });

  it("a run carrying that history saves the corrected lines; each deploy counts once, from the earliest merge it carries", () => {
    const h = parseHistory(saved);
    const r = compute({
      releases: [],
      runs: [],
      prs: [],
      merges: {},
      history: h,
      config,
      now: "2026-11-26T14:00:00Z",
    });
    for (const tag of four) {
      const x = r.history.find((e) => e.tag === tag);
      expect(x?.e2eTo, tag).toBe(`superseded by ${by[tag]}`);
      expect(x, tag).not.toHaveProperty("e2e");
    }
    // Only v0.248.2 and v0.249.1 have totals, each from the earliest merge
    // among it and the releases it carries: v0.247.0's 23:04:59 and
    // v0.249.0's 04:51:17.
    expect(r.current.e2e.last20).toEqual([
      {
        tag: "v0.248.2",
        e2e: 362.7,
        to: "prod deploy (fleet not yet measured)",
        carries: ["v0.247.0", "v0.248.0", "v0.248.1"],
      },
      {
        tag: "v0.249.1",
        e2e: 281.2,
        to: "prod deploy (fleet not yet measured)",
        carries: ["v0.249.0"],
      },
    ]);
    expect(r.current.e2e).toMatchObject({ n: 2, p50: 281.2, p90: 362.7 });
    const md = summary(r.current);
    expect(md).not.toContain("| v0.249.0 |");
    expect(md).toContain(
      "| v0.249.1 (carries v0.249.0) | 281.2 | prod deploy (fleet not yet measured) | 261.2 over |",
    );
    expect(md).toContain(
      "| v0.248.2 (carries v0.247.0, v0.248.0, v0.248.1) | 362.7 |",
    );
    expect(md).toContain(
      "Superseded, with no prod deploy or total of their own (the release that carries them counts from their first merge): v0.247.0 by v0.248.0, v0.248.0 by v0.248.1, v0.248.1 by v0.248.2, v0.249.0 by v0.249.1.",
    );
  });

  it("the totals are over the newest 20 measured deliveries: superseded tags never push one out", () => {
    // The Prover's backfill from 20 November: 29 history rows, 16 measured
    // deliveries (comment 7195373309). Taking the newest 20 rows first left
    // 14 deliveries, dropping v0.239.2 (2692.9) and v0.241.0 (614).
    const rows: [string, string, number | null][] = [
      ["v0.235.2", "v0.238.0", null],
      ["v0.236.0", "v0.238.0", null],
      ["v0.237.0", "v0.238.0", null],
      ["v0.238.0", "v0.239.0", null],
      ["v0.239.0", "v0.239.2", null],
      ["v0.239.1", "v0.239.2", null],
      ["v0.239.2", "", 2692.9],
      ["v0.240.0", "v0.241.0", null],
      ["v0.241.0", "", 614],
      ["v0.242.0", "v0.242.1", null],
      ["v0.242.1", "", 4059.4],
      ["v0.242.2", "", 979.2],
      ["v0.243.0", "", 62.5],
      ["v0.244.0", "", 61],
      ["v0.244.1", "", 99.9],
      ["v0.245.0", "", 44],
      ["v0.245.1", "", 45.8],
      ["v0.246.0", "v0.246.1", null],
      ["v0.246.1", "", 315.7],
      ["v0.247.0", "v0.248.0", null],
      ["v0.248.0", "v0.248.1", null],
      ["v0.248.1", "v0.248.2", null],
      ["v0.248.2", "", 362.7],
      ["v0.249.0", "v0.249.1", null],
      ["v0.249.1", "", 281.2],
      ["v0.250.0", "", 113.2],
      ["v0.251.0", "", 161.9],
      ["v0.251.1", "", 81.5],
      ["v0.252.0", "", 101.8],
    ];
    const history: HistoryEntry[] = rows.map(([tag, by, e2e]) => ({
      tag,
      mode: "pr",
      publishedAt: "2026-11-20T00:00:00Z",
      doneAt: "2026-11-20T01:00:00Z",
      ...(by ? { supersededBy: by } : {}),
      ...(e2e !== null ? { e2e } : {}),
      stages: {},
    }));
    expect(history).toHaveLength(29);
    const s = stats(history, config);
    expect(s.e2e).toMatchObject({ n: 16, p50: 113.2, p90: 2692.9 });
    expect(s.e2e.last20.map((x) => x.tag)).toContain("v0.239.2");
    expect(s.e2e.last20.map((x) => x.tag)).toContain("v0.241.0");
    // The superseded list stays apart, over the same span.
    expect(s.e2e.superseded.map((x) => x.tag)).toEqual([
      "v0.240.0",
      "v0.242.0",
      "v0.246.0",
      "v0.247.0",
      "v0.248.0",
      "v0.248.1",
      "v0.249.0",
    ]);
    // With more than 20 deliveries, the newest 20 of them.
    const many: HistoryEntry[] = Array.from({ length: 30 }, (_, i) => ({
      tag: `v0.300.${i}`,
      mode: "pr",
      publishedAt: "2026-11-20T00:00:00Z",
      doneAt: "2026-11-20T01:00:00Z",
      ...(i % 3 === 0 ? { supersededBy: `v0.300.${i + 1}` } : { e2e: i }),
      stages: {},
    }));
    const m = stats(many, config);
    expect(m.e2e.n).toBe(20);
    expect(m.e2e.last20[0]?.tag).toBe("v0.300.1");
  });

  it("the Prover's example: v0.249.1's total starts at v0.249.0's first merge, and the deploy counts once", () => {
    const h = carryMerges(parseHistory(saved).map(settleSuperseded));
    const v1 = h.find((e) => e.tag === "v0.249.1");
    expect(v1).toMatchObject({
      firstMergeAt: "2026-11-26T04:51:17Z",
      carries: ["v0.249.0"],
      e2e: 281.2,
      doneAt: "2026-11-26T09:32:30Z",
    });
    // 04:51:17 to 09:32:30: 281 min 13 s, of which 151 min 07 s waited before
    // v0.249.1's own first merge (07:22:24).
    expect(ms(v1?.doneAt ?? "") - ms(v1?.firstMergeAt ?? "")).toBe(
      (281 * 60 + 13) * 1000,
    );
    expect(ms(v1?.mergedAt ?? "") - ms(v1?.firstMergeAt ?? "")).toBe(
      (151 * 60 + 7) * 1000,
    );
    expect(h.find((e) => e.tag === "v0.249.0")).not.toHaveProperty("e2e");
    // Idempotent, and kept once the carried line leaves the history.
    expect(carryMerges(h)).toEqual(h);
    const alone = carryMerges(h.filter((e) => e.tag !== "v0.249.0"));
    expect(alone.find((e) => e.tag === "v0.249.1")).toMatchObject({
      firstMergeAt: "2026-11-26T04:51:17Z",
      e2e: 281.2,
    });
  });

  it("a backfill rebuilding a superseded release gives it no total: v0.249.0 is not v0.249.1's 09:32:30 deploy", () => {
    const tls = supersede([
      {
        tag: "v0.249.0",
        mode: "pr",
        mergedAt: "2026-11-26T04:51:17Z",
        publishedAt: "2026-11-26T07:08:49Z",
        stages: [
          { name: "tag", usual: 20.4, minutes: 137.5, state: "done" },
          {
            name: "pin_open",
            usual: 2.15,
            state: "current",
            startedAt: "2026-11-26T07:08:49Z",
            minutes: 30,
          },
        ],
      },
      {
        tag: "v0.249.1",
        mode: "pr",
        mergedAt: "2026-11-26T07:22:24Z",
        publishedAt: "2026-11-26T07:44:21Z",
        stages: [
          {
            name: "prod_deploy",
            usual: 4.8,
            minutes: 3.8,
            state: "done",
            endedAt: "2026-11-26T09:32:30Z",
          },
        ],
        doneAt: "2026-11-26T09:32:30Z",
        e2e: 130.1,
        e2eTo: NO_FLEET,
      },
    ]);
    const old = tls.find((t) => t.tag === "v0.249.0");
    expect(old).toMatchObject({
      supersededBy: "v0.249.1",
      closedAt: "2026-11-26T09:32:30Z",
      e2eTo: "superseded by v0.249.1",
    });
    expect(old).not.toHaveProperty("e2e");
    expect(historyEntry(old as never)).not.toHaveProperty("e2e");
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
    expect(commentBody(r.over[0] as Overrun, "o/r", config)).toContain(
      "**v1.0.0 hosted_release** finished past its limit: it took 78.4 min; usual 3.2 min, limit 8.2 min (the larger of 2 x its usual time and its usual time plus 5 min).",
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
  it("comments once per release and stage: a key already said by the bot, or twice in one tick, is skipped", () => {
    const o = over.over[0] as Overrun;
    // Still running: its own key; the finished one has the plain key.
    expect(commentKey(o)).toBe(
      "<!-- release-watch v1.0.0 pin_open running -->",
    );
    expect(commentKey({ ...o, kind: "finished" })).toBe(
      "<!-- release-watch v1.0.0 pin_open -->",
    );
    expect(commentPlan([], over.over)).toEqual(over.over);
    const said = {
      author: "github-actions[bot]",
      body: `x\n${commentKey(o)}`,
    };
    expect(commentPlan([said], over.over)).toEqual([]);
    // The same overrun again (a refresh, or listed twice): still once.
    expect(commentPlan([], [o, { ...o, minutes: 30 }])).toEqual([o]);
    // A person's comment with the key does not silence the bot.
    expect(commentPlan([{ ...said, author: "someone" }], over.over)).toEqual(
      over.over,
    );
    // Another stage of the same release is its own comment.
    expect(
      commentPlan([said], [o, { ...o, stage: "pin_merge" }]).map(
        (x) => x.stage,
      ),
    ).toEqual(["pin_merge"]);
  });
  it("the comment names the release, stage, run with how to rerun it, failed job and step, and attempts; never a log line", () => {
    const o: Overrun = {
      tag: "v0.248.2",
      stage: "redline",
      kind: "failed",
      red: true,
      startedAt: T("10:00:00"),
      runId: 45750964492,
      attempts: 2,
      minutes: 31,
      usual: 10.4,
      limit: 20.8,
      url: "https://github.com/o/c/actions/runs/45750964492",
    };
    const body = commentBody(o, "o/c", config, {
      job: "redline",
      step: "T19",
    });
    expect(body.split("\n")).toEqual([
      "**v0.248.2 redline** failed 31 min after it started (2026-11-25T10:00:00Z); usual 10.4 min, limit 20.8 min (the larger of 2 x its usual time and its usual time plus 5 min).",
      "",
      '- Run: [45750964492](https://github.com/o/c/actions/runs/45750964492), failed. It is a test gate, so rerun it whole (AGENTS.md): open the run and choose "Re-run all jobs", or `gh run rerun 45750964492 -R o/c`.',
      "- Failed job: `redline`, step `T19`. Its log is on the run.",
      "- Attempts: 2",
      "",
      "Every stage, time and ETA: the [release-watch job summary](https://github.com/o/c/actions/workflows/release-watch.yml).",
      "<!-- release-watch v0.248.2 redline -->",
    ]);
  });
  it("rerun advice follows AGENTS.md by workflow and state", () => {
    const o = (
      stage: string,
      kind: Overrun["kind"],
      runId = 45740398112,
    ): Overrun => ({
      tag: "v0.247.0",
      stage,
      kind,
      ...(kind === "failed" ? { red: true } : {}),
      startedAt: T("10:00:00"),
      runId,
      attempts: 1,
      minutes: 30,
      usual: 10.4,
      limit: 20.8,
    });
    const run = (x: Overrun) =>
      commentBody(x, "o/c", config).split("\n")[2] as string;
    // The real failed v0.247.0 gate (run 45740398112, job T19, "Run T19"): a
    // test gate reruns whole, never --failed.
    const gate = run(o("redline", "failed"));
    expect(gate).toBe(
      '- Run: [45740398112](https://github.com/o/c/actions/runs/45740398112), failed. It is a test gate, so rerun it whole (AGENTS.md): open the run and choose "Re-run all jobs", or `gh run rerun 45740398112 -R o/c`.',
    );
    expect(gate).not.toContain("--failed");
    expect(run(o("redline_queue", "failed"))).toContain(
      "`gh run rerun 45740398112 -R o/c`",
    );
    // Release workflows: failed jobs only.
    for (const stage of [
      "hosted_release",
      "staging_publish",
      "staging_deploy",
      "prod_publish",
      "prod_deploy",
    ])
      expect(run(o(stage, "failed", 7)), stage).toBe(
        '- Run: [7](https://github.com/o/c/actions/runs/7), failed. It is a release workflow, so rerun only its failed jobs (AGENTS.md): open the run and choose "Re-run failed jobs", or `gh run rerun 7 --failed -R o/c`.',
      );
    // Still running, or finished green but slow: nothing to rerun.
    for (const stage of ["redline", "staging_deploy"]) {
      expect(run(o(stage, "in_flight", 7))).toBe(
        "- Run: [7](https://github.com/o/c/actions/runs/7), still running, nothing to rerun yet.",
      );
      expect(run(o(stage, "finished", 7))).toBe(
        "- Run: [7](https://github.com/o/c/actions/runs/7), finished green, nothing to rerun.",
      );
      expect(run(o(stage, "finished", 7))).not.toContain("gh run rerun");
    }
  });
  it("a failed stage is a failed entry whatever its time; one still going past its limit is an in-flight overrun", () => {
    const t = (state: "red" | "current", minutes: number) =>
      overruns(
        [
          {
            tag: "v1.0.0",
            mode: "pr",
            publishedAt: T("10:00:00"),
            stages: [
              {
                name: "redline",
                usual: 10,
                startedAt: T("10:00:00"),
                minutes,
                state,
                runId: 7,
                attempts: 2,
              },
            ],
          },
        ],
        config,
      );
    // Failed at 3 min, under its limit: still a comment.
    expect(t("red", 3).failed).toEqual([
      {
        tag: "v1.0.0",
        stage: "redline",
        kind: "failed",
        red: true,
        startedAt: T("10:00:00"),
        runId: 7,
        attempts: 2,
        minutes: 3,
        usual: 10,
        limit: 20,
        url: undefined,
      },
    ]);
    expect(t("red", 3).over).toEqual([]);
    expect(t("red", 3).red).toHaveLength(1);
    // Going past its limit: an overrun for the summary, but not a comment.
    expect(t("current", 25).over.map((o) => o.kind)).toEqual(["in_flight"]);
    expect(t("current", 25).failed).toEqual([]);
  });
  it("a run comments on a stage seen still running past its limit, then on the same stage failed: two keys", () => {
    // v0.245.1 at 19:30 with its staging deploy still going past its limit.
    const now = T("19:30:00");
    const w = at(now);
    w.runs = w.runs
      .filter((r) => !r.path.endsWith("redline-staging.yml"))
      .map((r) =>
        r.title.startsWith("deploy-hosted-platform staging v0.245.1")
          ? { ...r, status: "in_progress", conclusion: null }
          : r,
      );
    const going = world(now, w);
    expect(going.over.map((o) => [o.stage, o.kind])).toEqual([
      ["staging_deploy", "in_flight"],
    ]);
    // Seen still running past its limit on this event: one heads-up.
    expect(going.notify.map((o) => [o.stage, o.kind])).toEqual([
      ["staging_deploy", "in_flight"],
    ]);
    // The same deploy failed: a comment for it.
    w.runs = w.runs.map((r) =>
      r.title.startsWith("deploy-hosted-platform staging v0.245.1")
        ? {
            ...r,
            status: "completed",
            conclusion: "failure",
            updatedAt: T("19:29:00"),
          }
        : r,
    );
    const failedNow = world(now, w).notify;
    expect(failedNow.map((o) => [o.stage, o.kind])).toEqual([
      ["staging_deploy", "failed"],
    ]);
    // The heads-up already said does not silence the failed comment, and
    // each is said once.
    const said = going.notify.map((o) => ({
      author: "github-actions[bot]",
      body: commentKey(o),
    }));
    expect(commentPlan(said, failedNow)).toEqual(failedNow);
    expect(commentPlan(said, going.notify)).toEqual([]);
    // At 23:30: v0.246.1's tag and pin merge finished past their limits, and
    // v0.246.0, superseded, failed its red-line: each release on its own runs.
    expect(
      world(T("23:30:00")).notify.map((o) => [o.tag, o.stage, o.kind]),
    ).toEqual([
      ["v0.246.0", "redline", "failed"],
      ["v0.246.1", "tag", "finished"],
      ["v0.246.1", "pin_merge", "finished"],
    ]);
  });

  const stub = (o: {
    issues?: { number: number; title: string }[];
    comments?: { author: string; body: string }[];
    jobs?: unknown[];
  }) => {
    const calls: string[][] = [];
    const exec: Exec = (_cmd, args) => {
      calls.push(args);
      const path = args[args.length - 1] ?? "";
      let out = "";
      if (args[0] === "issue" && args[1] === "list")
        out = JSON.stringify(o.issues ?? []);
      else if (args[0] === "issue" && args[1] === "create")
        out = "https://github.com/o/r/issues/42\n";
      else if (path.includes("/comments"))
        out = (o.comments ?? []).map((c) => JSON.stringify(c)).join("\n");
      else if (path.includes("/jobs?"))
        out = (o.jobs ?? []).map((j) => JSON.stringify(j)).join("\n");
      return { code: 0, stdout: out, stderr: "" };
    };
    return { exec, calls };
  };
  it("nothing past its limit: no read, no write", () => {
    const s = stub({});
    expect(notifyStuck(s.exec, "o/r", [], config)).toEqual({
      action: "none",
      posted: [],
    });
    expect(s.calls).toEqual([]);
  });
  it("creates the issue the first time (no label, the default token), then comments", () => {
    const s = stub({ issues: [{ number: 3, title: "hosted-release failed" }] });
    const r = notifyStuck(s.exec, "o/r", over.over, config);
    expect(r).toEqual({
      action: "comment",
      issue: 42,
      posted: ["v1.0.0 pin_open"],
    });
    expect(s.calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "issue list",
      "issue create",
      "issue comment",
    ]);
    expect(s.calls[1]?.slice(0, 6)).toEqual([
      "issue",
      "create",
      "--repo",
      "o/r",
      "--title",
      "release stuck",
    ]);
    expect(s.calls[1]).not.toContain("--label");
    expect(s.calls[2]?.slice(0, 5)).toEqual([
      "issue",
      "comment",
      "42",
      "--repo",
      "o/r",
    ]);
    expect(s.calls[2]?.[6]).toContain(
      "<!-- release-watch v1.0.0 pin_open running -->",
    );
  });
  it("reuses the open issue and says nothing already said: a refresh writes nothing", () => {
    const s = stub({
      issues: [
        { number: 9, title: ISSUE_TITLE },
        { number: 12, title: ISSUE_TITLE },
      ],
      comments: [
        {
          author: "github-actions[bot]",
          body: commentKey(over.over[0] as Overrun),
        },
      ],
    });
    expect(notifyStuck(s.exec, "o/r", over.over, config)).toEqual({
      action: "none",
      issue: 9,
      posted: [],
    });
    expect(s.calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "issue list",
      "api --paginate",
    ]);
    expect(s.calls[1]?.[s.calls[1].length - 1]).toBe(
      "repos/o/r/issues/9/comments?per_page=100",
    );
  });
  it("a failed stage's comment names its failed job and step from the run's jobs, and never reads a log", () => {
    const red: Overrun = {
      tag: "v0.248.1",
      stage: "redline",
      kind: "failed",
      red: true,
      startedAt: T("10:00:00"),
      runId: 45750964492,
      attempts: 2,
      minutes: 70.3,
      usual: 10.4,
      limit: 20.8,
    };
    const s = stub({
      issues: [{ number: 9, title: ISSUE_TITLE }],
      jobs: [
        { id: 1, name: "plan", conclusion: "success", steps: [] },
        {
          id: 2,
          name: "redline",
          conclusion: "failure",
          steps: [
            { name: "Set up job", conclusion: "success" },
            { name: "T19", conclusion: "failure" },
          ],
        },
      ],
    });
    notifyStuck(s.exec, "o/r", [red], config);
    expect(s.calls.map((c) => c[c.length - 1])).toContain(
      "repos/o/r/actions/runs/45750964492/jobs?filter=latest&per_page=100",
    );
    // No log is read: a log line could name an install or a customer.
    expect(s.calls.some((c) => (c[c.length - 1] ?? "").endsWith("/logs"))).toBe(
      false,
    );
    const body = s.calls.find((c) => c[1] === "comment")?.[6] ?? "";
    expect(body).toContain(
      "- Failed job: `redline`, step `T19`. Its log is on the run.",
    );
    expect(body).toContain(
      "- Run: [45750964492](https://github.com/o/r/actions/runs/45750964492), failed. It is a test gate, so rerun it whole",
    );
    expect(body).toContain("- Attempts: 2");
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

  it("a normal tick reads the window, skips merge reads for releases in history, and reads no issue with nothing stuck", () => {
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
    // Nothing past its limit: the issue is not even read.
    expect(f.calls.filter((c) => c.startsWith("issue"))).toEqual([]);
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
      'Measured from the merge to one of three endpoints, and each release says which: "every install", exact, from a later prod deploy\'s record of the scheduler\'s fleet finish ("Fleet done of earlier releases"); "every install (upper bound: the Fleet done step\'s end)", from an older deploy\'s own "Fleet done" step; or "prod deploy (fleet not yet measured)". Reported, never alerted on.',
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
    // Nothing past its limit: the issue is not even read.
    expect(f.calls.filter((c) => c.startsWith("issue"))).toEqual([]);
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
    // Nothing past its limit: the issue is not even read.
    expect(f.calls.filter((c) => c.startsWith("issue"))).toEqual([]);
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

  it("runs on events only: every release workflow's completion on main, a PUBLIC_PIN push to main, and dispatch; never a schedule", () => {
    expect(Object.keys(w.on)).toEqual([
      "workflow_run",
      "push",
      "workflow_dispatch",
    ]);
    expect(w.on.workflow_run.workflows).toEqual([
      "pin-bump",
      "hosted-release",
      "hosted-publish",
      "staging-release-chain",
      "deploy-hosted-platform",
      "redline-staging",
      "prod-release-chain",
    ]);
    expect(w.on.workflow_run.types).toEqual(["completed"]);
    expect(w.on.workflow_run.branches).toEqual(["main"]);
    expect(w.on.push).toEqual({ branches: ["main"], paths: ["PUBLIC_PIN"] });
    expect(w.on).not.toHaveProperty("schedule");
    expect(raw).not.toMatch(/cron:|sleep /);
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
    expect(raw).not.toMatch(/pull_request|merge_group/);
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
