// Release watch (cloud #264, Lane 5 PR1): the pure core on recorded runs of
// v0.245.0 to v0.246.1, at pinned clocks, and the workflow's shape.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Exec } from "./gh-retry.ts";
import {
  type Config,
  compute,
  eta,
  type HistoryEntry,
  ISSUE_TITLE,
  issueBody,
  issuePlan,
  loadConfig,
  mergeHistory,
  overruns,
  type Pr,
  parseHistory,
  pct,
  pinSubject,
  type Release,
  type Run,
  stats,
  step,
  summary,
  supersede,
  syncIssue,
  tick,
  timeline,
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
  it("chains each mode's stages end to start, merged to prod deploy", () => {
    for (const mode of ["pr", "direct"] as const) {
      const s = config.stages.filter((x) => !x.mode || x.mode === mode);
      expect(s[0]?.from).toBe("merged");
      for (let i = 1; i < s.length; i++)
        expect(s[i]?.from, s[i]?.name).toBe(s[i - 1]?.to);
    }
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
  it("leaves fleet unmeasured, naming the source it needs", () => {
    const f = config.stages.find((s) => s.name === "fleet");
    expect(f?.measured).toBe(false);
    expect(f?.todo).toMatch(/fleet/);
    expect(f?.todo).toMatch(/no admin reads/);
  });
  it("e2eWorst is the sum of the measured PR-mode budgets", () => {
    const sum = config.stages
      .filter((s) => s.measured !== false && s.mode !== "direct")
      .reduce((a, s) => a + s.budget, 0);
    expect(config.e2eWorst).toBe(sum);
  });
  it("refuses a stage with no budget", () => {
    expect(() =>
      loadConfig(
        JSON.stringify({ stages: [{ name: "x", from: "a", to: "b" }] }),
      ),
    ).toThrow(/bad stage/);
  });
});

describe("timeline on the recorded chain", () => {
  it("v0.245.1, the full chain within budget: every stage timed, no issue", () => {
    const now = T("19:50:00");
    const t = tl("v0.245.1", now);
    expect(t?.mode).toBe("pr");
    expect(
      Object.fromEntries(t?.stages.map((s) => [s.name, s.minutes]) ?? []),
    ).toEqual({
      tag: 3.6,
      pin_open: 1.8,
      pin_merge: 10,
      hosted_release: 2.9,
      staging_publish: 4,
      staging_deploy: 5.1,
      redline_queue: 0.7,
      redline: 9.9,
      prod_publish: 3,
      prod_deploy: 4.9,
    });
    expect(t?.doneAt).toBe(T("19:43:43"));
    expect(t?.e2e).toBe(45.8);
    const w = world(now);
    expect(w.over).toEqual([]);
    expect(issuePlan([], w.over, w.red)).toEqual({ action: "none" });
  });

  it("staging_deploy over budget mid-flight opens the blocker naming the stage", () => {
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
        startedAt: T("19:20:12"),
        minutes: 9.8,
        budget: 7,
        url: expect.stringContaining("/actions/runs/"),
      },
    ]);
    expect(r.current.inFlight[0]).toMatchObject({
      tag: "v0.245.1",
      stage: "staging_deploy",
      state: "current",
      elapsed: 9.8,
      budget: 7,
    });
    const a = issuePlan([], r.over, r.red);
    expect(a.action).toBe("create");
    if (a.action === "create")
      expect(a.body).toContain(
        "- v0.245.1 staging_deploy: still going, budget 7 min, started 2026-11-25T19:20:12Z.",
      );
  });

  it("no pin PR 4.5 minutes after the release is a pin_open stall", () => {
    const now = T("19:06:00");
    const w = at(now);
    w.prs = w.prs.filter((p) => p.ref !== "pin-bump/v0.245.1");
    const r = world(now, w);
    expect(r.over.map((o) => [o.tag, o.stage, o.minutes])).toEqual([
      ["v0.245.1", "pin_open", 4.5],
    ]);
    // With the PR there, the release has moved on and is within budget.
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
    // Not its stage and not its e2e (139 min since the merge): the red run's blocker covers it.
    expect(r.over).toEqual([]);
    expect(issuePlan([], r.over, r.red)).toEqual({ action: "none" });
    expect(issueBody(r.over, r.red)).toContain(
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
    expect(row(t, "hosted_release")?.minutes).toBe(13.2);
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
    expect(s.stages.redline).toEqual({ p50: 14, p90: 22, n: 20, budget: 14 });
    expect(s.stages.tag).toEqual({ p50: null, p90: null, n: 0, budget: 6 });
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
    expect(row(t, "staging_deploy")).toMatchObject({
      state: "current",
      minutes: 2,
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
    // (5 - 2) + 1 + 10 + 3 + 5 = 22 min.
    expect(eta(t as never, st, now)).toEqual({
      p50: "2026-11-25T19:44:12.000Z",
      p90: "2026-11-25T19:44:12.000Z",
    });
    // No samples: budgets. (7 - 2) + 2 + 14 + 5 + 8 = 34 min.
    expect(eta(t as never, stats([], config).stages, now)?.p50).toBe(
      "2026-11-25T19:56:12.000Z",
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

describe("the over-budget issue", () => {
  const over = overruns(
    [
      {
        tag: "v1.0.0",
        mode: "pr",
        publishedAt: T("10:00:00"),
        stages: [
          {
            name: "tag",
            budget: 6,
            startedAt: T("09:58:00"),
            endedAt: T("10:00:00"),
            minutes: 2,
            state: "done",
          },
          {
            name: "pin_open",
            budget: 4,
            startedAt: T("10:00:00"),
            minutes: 9,
            state: "current",
          },
        ],
      },
    ],
    config,
    T("10:09:00"),
  );
  it("an in-flight stage past its budget is an overrun", () => {
    expect(over.over).toEqual([
      {
        tag: "v1.0.0",
        stage: "pin_open",
        kind: "in_flight",
        startedAt: T("10:00:00"),
        minutes: 9,
        budget: 4,
        url: undefined,
      },
    ]);
  });
  it("the newest finished release's overruns keep it open until a release is within budget", () => {
    const done = {
      tag: "v1.0.0",
      mode: "pr" as const,
      publishedAt: T("10:00:00"),
      doneAt: T("11:30:00"),
      e2e: 90,
      stages: [
        {
          name: "redline",
          budget: 14,
          startedAt: T("10:00:00"),
          endedAt: T("11:30:00"),
          minutes: 90,
          state: "done" as const,
        },
      ],
    };
    expect(
      overruns([done], config, T("12:00:00")).over.map((o) => [
        o.kind,
        o.stage,
      ]),
    ).toEqual([
      ["last_release", "redline"],
      ["last_release", "e2e"],
    ]);
    const newer = {
      ...done,
      tag: "v1.0.1",
      e2e: 30,
      stages: [{ ...done.stages[0], minutes: 10 }],
    };
    expect(
      overruns([done, newer as never], config, T("12:00:00")).over,
    ).toEqual([]);
  });
  it("creates once, edits only on a change, closes when within budget", () => {
    const body = issueBody(over.over, []);
    expect(issuePlan([], over.over, [])).toEqual({ action: "create", body });
    const open = [
      { number: 5, title: ISSUE_TITLE, body },
      { number: 3, title: "hosted-release failed", body: "" },
    ];
    expect(issuePlan(open, over.over, [])).toEqual({ action: "none" });
    expect(
      issuePlan(
        [{ number: 5, title: ISSUE_TITLE, body: `${body}\n` }],
        over.over,
        [],
      ),
    ).toEqual({ action: "none" });
    expect(
      issuePlan(
        [{ number: 5, title: ISSUE_TITLE, body: "old" }],
        over.over,
        [],
      ),
    ).toEqual({ action: "edit", number: 5, body });
    expect(issuePlan(open, [], [])).toMatchObject({
      action: "close",
      number: 5,
    });
    expect(issuePlan(open.slice(1), [], [])).toEqual({ action: "none" });
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
              budget: 4,
              startedAt: T("10:00:00"),
              minutes: 14,
              state: "current",
            },
          ],
        },
      ],
      config,
      T("10:14:00"),
    );
    expect(issueBody(later.over, [])).toBe(issueBody(over.over, []));
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
    const body = issueBody(over.over, []);
    const s = stub([{ number: 5, title: ISSUE_TITLE, body }]);
    expect(syncIssue(s.exec, "o/r", over.over, []).action).toBe("none");
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
    syncIssue(s.exec, "o/r", over.over, []);
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
    syncIssue(s.exec, "o/r", [], []);
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
    expect(summary(r.current)).toContain("Not measured: fleet");
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
      stages: { tag: (tag?.budget ?? 0) + 5 },
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
      ["v0.245.1", "tag", "last_release"],
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
