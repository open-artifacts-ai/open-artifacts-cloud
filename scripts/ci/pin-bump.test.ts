// The pin-bump PR opener: one PR for the newest public release, never a
// second, never armed, and any API error is a thrown error (a red run).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { sleeper } from "./gh-retry.ts";
import {
  applyPin,
  branchOf,
  CI_WORKFLOW,
  compareTags,
  DIRECT_FILES,
  type Exec,
  land,
  landBranch,
  landBranchOf,
  lockfileSensitive,
  openPr,
  PIN_ONLY_STEP,
  plan,
  planDirect,
  rewritePin,
  route,
  STALE_PR_MS,
  SURFACES_FILES,
  stage,
} from "./pin-bump.ts";
import {
  PIN_FILES as ARM_PIN_FILES,
  GATE_WORKFLOWS,
  PRE_GATE_WORKFLOWS,
  readGate,
  type StageRun,
} from "./pin-bump-arm.ts";

// A faked 502 would otherwise sleep through the real backoff.
beforeEach(() => {
  vi.spyOn(sleeper, "sleep").mockImplementation(() => {});
});

const REPO = "open-artifacts-ai/open-artifacts-cloud";
const PUB = "open-artifacts-ai/open-artifacts";
const NOW = Date.parse("2026-11-09T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const OLD_SHA = "607c02b1bc6e2f918260d657e5032257aa6f8d3f";
const NEW_SHA = "a".repeat(40);
const PIN = `# The public open-artifacts release this repo builds on.
tag=v0.136.1
sha=${OLD_SHA}
`;
/**
 * The release pipeline gate (pin-bump-arm's readGate): which gate workflows are
 * busy, the successful prod deploy titles, and the newest red-line runs. By
 * default the gate is open: nothing runs and main's pin v0.136.1 is on prod.
 */
type GateWorld = {
  busy?: string[];
  deployed?: string[];
  gateRuns?: { t: string; c: string | null; a: number }[];
  /** Runs of a stage before the gate for main's pin commit, newest first. */
  stageRuns?: Record<string, StageRun[]>;
  fail?: boolean;
};
/** The main commit that set PUBLIC_PIN (the stages' head sha). */
const PIN_COMMIT = "9".repeat(40);
const ON_PROD = ["deploy-hosted-platform prod v0.136.1 [c1-1]"];
const gateAnswer = (g: GateWorld = {}, path = "") => {
  const out = (v: unknown) => ({
    code: 0,
    stdout: JSON.stringify(v),
    stderr: "",
  });
  // The stages before the gate (pin-bump-arm's stageSpent), read only when main's
  // pin is not on prod and was not rejected.
  if (path.includes("/commits?sha=main&path=PUBLIC_PIN&per_page=1"))
    return g.fail
      ? { code: 1, stdout: "", stderr: "HTTP 404" }
      : out({ sha: PIN_COMMIT, at: "2026-11-26T15:40:03Z" });
  // The stages' "does this run's commit contain the pin" check, from the pin.
  if (path.includes(`/compare/${PIN_COMMIT}...`))
    return { code: 0, stdout: "ahead\n", stderr: "" };
  const st = /\/actions\/workflows\/([^/]+)\/runs\?branch=main/.exec(path);
  if (st) {
    const r = ((g.stageRuns ?? {})[st[1] ?? ""] ?? []).map((x) => ({
      h: PIN_COMMIT,
      ...x,
    }));
    return out({ n: r.length, r });
  }
  const m = /\/actions\/workflows\/([^/]+)\/runs\?status=([a-z_]+)/.exec(path);
  if (!m) return undefined;
  if (g.fail) return { code: 1, stdout: "", stderr: "HTTP 404" };
  const [, wf, status] = m;
  if (status === "queued" || status === "in_progress")
    return out((g.busy ?? []).includes(wf ?? "") ? 1 : 0);
  if (status === "success") {
    const t = g.deployed ?? ON_PROD;
    return out({ n: t.length, t });
  }
  return out(g.gateRuns ?? []);
};
type Rel = { tag_name: string; draft?: boolean; prerelease?: boolean };
const rel = (tag_name: string, extra: Partial<Rel> = {}) => ({
  draft: false,
  prerelease: false,
  tag_name,
  ...extra,
});

const world = (o: {
  releases?: Rel[];
  open?: {
    number: number;
    headRefName: string;
    url: string;
    createdAt?: string;
  }[];
  taken?: { number: number; state: string }[];
  sha?: string;
  failApi?: string;
  /** Direct mode: the refs git/matching-refs lists. */
  landRefs?: string[];
  /** gh pr view's answer for the open PR (#425). */
  view?: {
    state?: string;
    autoMergeRequest?: unknown;
    statusCheckRollup?: { conclusion?: string; state?: string }[];
  };
  gate?: GateWorld;
}) => {
  const calls: string[][] = [];
  const exec: Exec = (_c, args) => {
    calls.push(args);
    const line = args.join(" ");
    if (o.failApi && line.includes(o.failApi))
      return { code: 1, stdout: "", stderr: "HTTP 502" };
    const g = args[0] === "api" ? gateAnswer(o.gate, args[1]) : undefined;
    if (g) return g;
    const json = (v: unknown) => ({
      code: 0,
      stdout: JSON.stringify(v),
      stderr: "",
    });
    if (args[0] === "api" && args[1]?.includes("/releases?"))
      return json(o.releases ?? [rel("v0.137.0"), rel("v0.136.1")]);
    if (args[0] === "api" && args[1]?.includes("/git/matching-refs/"))
      return json((o.landRefs ?? []).map((ref) => ({ ref })));
    if (args[0] === "pr" && args[1] === "list" && args.includes("--head"))
      return json(o.taken ?? []);
    if (args[0] === "pr" && args[1] === "list") return json(o.open ?? []);
    if (args[0] === "api" && args[1]?.includes("/commits/"))
      return { code: 0, stdout: `${o.sha ?? NEW_SHA}\n`, stderr: "" };
    if (args[0] === "pr" && args[1] === "view")
      return json({
        state: "OPEN",
        autoMergeRequest: null,
        statusCheckRollup: [],
        ...o.view,
      });
    if (args[0] === "pr" && args[1] === "close")
      return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "pr" && args[1] === "create")
      return { code: 0, stdout: `https://github.com/x/y/pull/9\n`, stderr: "" };
    throw new Error(`unexpected ${line}`);
  };
  return { exec, calls };
};
const go = (o: Parameters<typeof world>[0], pin = PIN) =>
  plan({ exec: world(o).exec, repo: REPO, publicRepo: PUB, pin, now: NOW });

describe("compareTags", () => {
  it("compares numbers, not strings", () => {
    expect(compareTags("v0.136.10", "v0.136.9")).toBeGreaterThan(0);
    expect(compareTags("v1.0.0", "v0.999.999")).toBeGreaterThan(0);
    expect(compareTags("v0.136.1", "v0.136.1")).toBe(0);
  });
});

describe("plan", () => {
  it("bumps to the newest release and resolves its sha", async () => {
    expect(go({})).toMatchObject({
      bump: true,
      tag: "v0.137.0",
      sha: NEW_SHA,
    });
  });

  it("takes the highest version, whatever order the API lists them", () => {
    const r = go({
      releases: [rel("v0.136.9"), rel("v0.136.10"), rel("v0.136.2")],
    });
    expect(r).toMatchObject({ bump: true, tag: "v0.136.10" });
  });

  it("does nothing when the pin is the newest, or ahead", () => {
    expect(go({ releases: [rel("v0.136.1")] })).toMatchObject({ bump: false });
    expect(go({ releases: [rel("v0.135.0")] })).toMatchObject({ bump: false });
  });

  it("ignores drafts, prereleases and odd tags", () => {
    const r = go({
      releases: [
        rel("v0.138.0", { draft: true }),
        rel("v0.139.0", { prerelease: true }),
        rel("v0.140.0-rc1"),
        rel("nightly"),
        rel("v0.137.0"),
      ],
    });
    expect(r).toMatchObject({ bump: true, tag: "v0.137.0" });
  });

  it("never opens a second PR while a pin-bump PR is open", () => {
    const { exec, calls } = world({
      open: [
        {
          number: 3,
          headRefName: "pin-bump/v0.136.2",
          url: "u3",
          createdAt: hoursAgo(1),
        },
      ],
    });
    const r = plan({ exec, repo: REPO, publicRepo: PUB, pin: PIN, now: NOW });
    expect(r.bump).toBe(false);
    expect(r.why).toContain("u3");
    expect(calls.some((c) => c[1] === "create")).toBe(false);
  });

  it("an open PR from another branch is not a pin-bump PR", () => {
    expect(
      go({
        open: [
          {
            number: 3,
            headRefName: "feature/x",
            url: "u",
            createdAt: hoursAgo(1),
          },
        ],
      }),
    ).toMatchObject({ bump: true });
  });

  it("a merged or closed PR for the tag keeps it from reopening", () => {
    for (const state of ["MERGED", "CLOSED"])
      expect(go({ taken: [{ number: 4, state }] })).toMatchObject({
        bump: false,
        tag: "v0.137.0",
      });
  });

  it("an API error, no release or a bad sha throws, never a quiet skip", () => {
    expect(() => go({ failApi: "/releases?" })).toThrow("502");
    expect(() => go({ failApi: "pr list" })).toThrow("502");
    expect(() => go({ failApi: "--head" })).toThrow("502");
    expect(() => go({ failApi: "/commits/" })).toThrow("502");
    expect(() => go({ releases: [] })).toThrow("no stable");
    expect(() => go({ sha: "main" })).toThrow("not a full sha");
  });

  it("a broken PUBLIC_PIN throws", () => {
    expect(() => go({}, "sha=abc\n")).toThrow("no tag=");
    expect(() => go({}, "tag=latest\nsha=x\n")).toThrow("isn't vX.Y.Z");
  });
});

// The push trigger (cloud #264): the bump for v0.136.1 just merged, so PUBLIC_PIN
// on main is v0.136.1 and no pin-bump PR is open. A release that waited behind it
// is bumped now; with nothing newer the run writes nothing.
describe("plan again once a pin lands on main", () => {
  const writes = (calls: string[][]) =>
    calls.filter(
      (c) =>
        (c[0] === "pr" && ["create", "close", "merge"].includes(c[1] ?? "")) ||
        c.includes("POST") ||
        c.includes("PATCH"),
    );

  it("a newer release than the new pin exists, so bump", () => {
    const { exec, calls } = world({
      releases: [rel("v0.137.0"), rel("v0.136.1")],
    });
    expect(
      plan({ exec, repo: REPO, publicRepo: PUB, pin: PIN, now: NOW }),
    ).toMatchObject({
      bump: true,
      tag: "v0.137.0",
      sha: NEW_SHA,
      why: "v0.136.1 -> v0.137.0",
    });
    expect(writes(calls)).toEqual([]);
  });

  it("nothing newer, so do nothing, and read no PR for a tag", () => {
    const { exec, calls } = world({
      releases: [rel("v0.136.1"), rel("v0.136.0")],
    });
    const r = plan({ exec, repo: REPO, publicRepo: PUB, pin: PIN, now: NOW });
    expect(r).toMatchObject({ bump: false });
    expect(r.why).toContain("v0.136.1 is the newest release");
    expect(calls.some((c) => c.includes("--head"))).toBe(false);
    expect(calls.some((c) => c[1]?.includes("/commits/"))).toBe(false);
    expect(writes(calls)).toEqual([]);
  });

  it("is idempotent: once the newer bump is open, a second run does nothing", () => {
    const open = [
      {
        number: 9,
        headRefName: branchOf("v0.137.0"),
        url: "u9",
        createdAt: hoursAgo(0),
      },
    ];
    const r = go({ open });
    expect(r).toMatchObject({ bump: false, tag: "v0.137.0" });
    expect(r.why).toContain("u9");
    expect(go({ taken: [{ number: 9, state: "OPEN" }] })).toMatchObject({
      bump: false,
    });
  });

  it("direct mode decides the same way", () => {
    const run = (releases: Rel[]) =>
      planDirect({
        exec: world({ releases }).exec,
        repo: REPO,
        publicRepo: PUB,
        pin: PIN,
      });
    expect(run([rel("v0.137.0"), rel("v0.136.1")])).toMatchObject({
      bump: true,
      tag: "v0.137.0",
    });
    expect(run([rel("v0.136.1"), rel("v0.136.0")])).toMatchObject({
      bump: false,
    });
  });
});

describe("a stuck bump PR", () => {
  const stuck = (ms: number, extra: object = {}) => ({
    open: [
      {
        number: 3,
        headRefName: "pin-bump/v0.136.2",
        url: "u3",
        createdAt: new Date(NOW - ms).toISOString(),
        ...extra,
      },
    ],
  });

  it("is three days", () => {
    expect(STALE_PR_MS).toBe(3 * 24 * 3_600_000);
  });

  it("turns the run red once it is older than that, even with no newer release", () => {
    expect(() => go(stuck(STALE_PR_MS + 60_000))).toThrow(
      "open for over 3 days",
    );
    expect(() =>
      go({ ...stuck(STALE_PR_MS + 60_000), releases: [rel("v0.136.1")] }),
    ).toThrow("u3");
  });

  it("a younger one just holds the line", () => {
    expect(go(stuck(STALE_PR_MS - 60_000))).toMatchObject({ bump: false });
  });

  it("a PR from another branch is never stuck", () => {
    expect(
      go(stuck(STALE_PR_MS * 3, { headRefName: "feature/x" })),
    ).toMatchObject({ bump: true });
  });

  it("an unreadable age is an error, not a pass", () => {
    expect(() => go(stuck(0, { createdAt: undefined }))).toThrow("createdAt");
  });
});

describe("a red, unarmed bump for an older tag (#425)", () => {
  const old = {
    number: 3,
    headRefName: "pin-bump/v0.136.2",
    url: "u3",
    createdAt: hoursAgo(1),
  };
  const red = {
    statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }],
  };

  it("is replaced by the bump to the newest release", () => {
    expect(go({ open: [old], view: red })).toMatchObject({
      bump: true,
      tag: "v0.137.0",
      supersede: 3,
    });
  });

  it("a commit status in error counts as red too", () => {
    expect(
      go({ open: [old], view: { statusCheckRollup: [{ state: "ERROR" }] } }),
    ).toMatchObject({ bump: true, supersede: 3 });
  });

  it("a green, pending or cancelled one holds the line", () => {
    for (const c of [
      [],
      [{ conclusion: "SUCCESS" }],
      [{ conclusion: "" }],
      [{ conclusion: "CANCELLED" }],
    ])
      expect(go({ open: [old], view: { statusCheckRollup: c } })).toMatchObject(
        {
          bump: false,
        },
      );
  });

  it("an armed one is never touched, red or not", () => {
    const r = go({
      open: [old],
      view: { ...red, autoMergeRequest: { enabledAt: "x" } },
    });
    expect(r).toMatchObject({ bump: false });
    expect(r.why).toContain("armed");
  });

  it("one for the newest tag, or a newer one, is never replaced", () => {
    for (const h of ["pin-bump/v0.137.0", "pin-bump/v0.138.0", "pin-bump/odd"])
      expect(
        go({ open: [{ ...old, headRefName: h }], view: red }),
      ).toMatchObject({
        bump: false,
      });
  });

  it("a stale one that can be replaced is replaced, not a red run", () => {
    expect(
      go({ open: [{ ...old, createdAt: hoursAgo(24 * 4) }], view: red }),
    ).toMatchObject({ bump: true, supersede: 3 });
  });

  it("open-pr closes it with a comment, then opens the new PR", () => {
    const { exec, calls } = world({ open: [old] });
    const r = openPr({
      exec,
      repo: REPO,
      publicRepo: PUB,
      tag: "v0.137.0",
      sha: NEW_SHA,
      branch: branchOf("v0.137.0"),
      supersede: 3,
    });
    expect(r.action).toBe("opened");
    const close = calls.findIndex((c) => c[0] === "pr" && c[1] === "close");
    const create = calls.findIndex((c) => c[0] === "pr" && c[1] === "create");
    expect(close).toBeGreaterThan(-1);
    expect(close).toBeLessThan(create);
    expect(calls[close]).toContain("3");
    expect(calls[close]?.join(" ")).toContain("v0.137.0");
  });

  it("open-pr leaves it if it was armed since the plan, or is not the one planned", () => {
    for (const [view, supersede] of [
      [{ autoMergeRequest: { enabledAt: "x" } }, 3],
      [{}, 4],
      [{}, undefined],
    ] as const) {
      const { exec, calls } = world({ open: [old], view });
      expect(
        openPr({
          exec,
          repo: REPO,
          publicRepo: PUB,
          tag: "v0.137.0",
          sha: NEW_SHA,
          branch: branchOf("v0.137.0"),
          supersede,
        }),
      ).toEqual({ action: "left", url: "u3" });
      expect(calls.some((c) => c[1] === "close" || c[1] === "create")).toBe(
        false,
      );
    }
  });
});

describe("rewritePin", () => {
  it("moves tag and sha and keeps every other line", () => {
    expect(rewritePin(PIN, "v0.137.0", NEW_SHA)).toBe(
      `# The public open-artifacts release this repo builds on.\ntag=v0.137.0\nsha=${NEW_SHA}\n`,
    );
    const synced =
      "# c\nsha=x\ntag=v1.0.0\nlist=public:scripts/ci/private-paths.txt\n";
    expect(rewritePin(synced, "v0.137.0", NEW_SHA)).toContain(
      "list=public:scripts/ci/private-paths.txt",
    );
  });

  it("refuses a bad tag, a short sha, or a file without the lines", () => {
    expect(() => rewritePin(PIN, "main", NEW_SHA)).toThrow("isn't vX.Y.Z");
    expect(() => rewritePin(PIN, "v0.137.0", "abc")).toThrow("full sha");
    expect(() => rewritePin("tag=v1.0.0\n", "v0.137.0", NEW_SHA)).toThrow(
      "no sha=",
    );
  });

  it("applyPin writes both PUBLIC_PIN and SYNCED_FROM", () => {
    const dir = mkdtempSync(join(tmpdir(), "pin-bump-"));
    writeFileSync(join(dir, "PUBLIC_PIN"), PIN);
    writeFileSync(join(dir, "SYNCED_FROM"), `sha=${OLD_SHA}\ntag=v0.136.1\n`);
    applyPin(dir, "v0.137.0", NEW_SHA);
    for (const f of ["PUBLIC_PIN", "SYNCED_FROM"]) {
      const t = readFileSync(join(dir, f), "utf8");
      expect(t).toContain("tag=v0.137.0");
      expect(t).toContain(`sha=${NEW_SHA}`);
      expect(t).not.toContain(OLD_SHA);
    }
  });
});

describe("openPr", () => {
  const base = {
    repo: REPO,
    publicRepo: PUB,
    tag: "v0.137.0",
    sha: NEW_SHA,
    branch: branchOf("v0.137.0"),
  };

  it("opens one PR into main from the bump branch, and never arms it", () => {
    const { exec, calls } = world({});
    expect(openPr({ ...base, exec })).toEqual({
      action: "opened",
      url: "https://github.com/x/y/pull/9",
    });
    const create = calls.find((c) => c[0] === "pr" && c[1] === "create") ?? [];
    expect(create).toContain("--base");
    expect(create[create.indexOf("--base") + 1]).toBe("main");
    expect(create[create.indexOf("--head") + 1]).toBe("pin-bump/v0.137.0");
    expect(create).toContain("chore(pin): bump PUBLIC_PIN to v0.137.0");
    expect(calls.some((c) => c.includes("merge") || c.includes("--auto"))).toBe(
      false,
    );
  });

  it("a PR that appeared since the plan is left, not duplicated", () => {
    const { exec, calls } = world({
      open: [
        {
          number: 8,
          headRefName: "pin-bump/v0.137.0",
          url: "u8",
          createdAt: hoursAgo(1),
        },
      ],
    });
    expect(openPr({ ...base, exec })).toEqual({ action: "left", url: "u8" });
    expect(calls.some((c) => c[1] === "create")).toBe(false);
  });

  it("a gh failure throws", () => {
    expect(() =>
      openPr({ ...base, exec: world({ failApi: "pr list" }).exec }),
    ).toThrow("502");
  });
});

describe("pin-bump.yml", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const text = readFileSync(
    join(root, ".github/workflows/pin-bump.yml"),
    "utf8",
  );
  // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
  const w: any = parse(text);
  // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
  type Step = any;
  const jobs = w.jobs;
  const stepsOf = (j: string): Step[] => jobs[j].steps;
  const step = (j: string, id: string) => stepsOf(j).find((s) => s.id === id);
  const MAIN = "github.ref == 'refs/heads/main'";
  // Direct mode's lander, split out so each workflow's group holds one kind of work.
  const landText = readFileSync(
    join(root, ".github/workflows/pin-land.yml"),
    "utf8",
  );
  // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
  const lw: any = parse(landText);
  const landJobs = lw.jobs;
  const landSteps = (j: string): Step[] => landJobs[j].steps;
  const GATES = GATE_WORKFLOWS.map((f) => f.replace(/\.yml$/, ""));

  it("is event-only: by dispatch, when a pin lands on main and when a gate workflow ends, from main only", () => {
    // cloud #264: no schedule, no timer of any kind
    expect(Object.keys(w.on)).toEqual([
      "workflow_dispatch",
      "push",
      "workflow_run",
    ]);
    expect(w.on.schedule).toBeUndefined();
    expect(text).not.toMatch(/\bcron:/);
    // a pin PR merging, or land moving main, changes PUBLIC_PIN on main
    expect(w.on.push).toEqual({ branches: ["main"], paths: ["PUBLIC_PIN"] });
    // a gate run on any branch: readGate counts them all (no branch filter);
    // and hosted-release, whose end with the retry spent makes main's pin dead
    expect(w.on.workflow_run).toEqual({
      workflows: ["hosted-release", ...GATES],
      types: ["completed"],
    });
    for (const j of ["prepare", "open", "report"])
      expect(jobs[j].if).toContain(MAIN);
    // the event's fields are read only in `if`s, never in a step
    for (const j of Object.keys(jobs))
      for (const st of stepsOf(j))
        expect(JSON.stringify(st)).not.toContain("github.event");
  });

  it("pin-land.yml is event-only too: by dispatch, after CI on a staged pin and when a gate workflow ends, never on a push, from main only", () => {
    expect(Object.keys(lw.on)).toEqual(["workflow_dispatch", "workflow_run"]);
    expect(lw.on.push).toBeUndefined();
    expect(lw.on.schedule).toBeUndefined();
    expect(landText).not.toMatch(/\bcron:/);
    // no branch filter: a gate run on any branch wakes it; land's `if` takes
    // CI only on pin-land/*
    expect(lw.on.workflow_run).toEqual({
      workflows: ["CI", "hosted-release", ...GATES],
      types: ["completed"],
    });
    expect(Object.keys(landJobs)).toEqual(["land", "report"]);
    expect(landJobs.report.needs).toEqual(["land"]);
    for (const j of ["land", "report"]) expect(landJobs[j].if).toContain(MAIN);
    for (const j of Object.keys(landJobs))
      for (const st of landSteps(j))
        expect(JSON.stringify(st)).not.toContain("github.event");
    expect(lw.permissions).toEqual({});
    expect(lw.concurrency["cancel-in-progress"]).toBe(false);
    // the lander is only here: pin-bump.yml never moves main
    expect(jobs.land).toBeUndefined();
    expect(text).not.toContain("PIN_LAND_APP_");
    expect(text).not.toContain("pin-bump.ts land");
    const uses = Object.values(landJobs)
      // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
      .flatMap((j: any) => j.steps)
      .map((s: Step) => s.uses)
      .filter(Boolean) as string[];
    expect(uses.length).toBeGreaterThan(2);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}( |$)/);
  });

  it("each gate workflow named is the workflow that file declares", () => {
    for (const f of GATE_WORKFLOWS) {
      const g = parse(
        readFileSync(join(root, ".github/workflows", f), "utf8"),
      ) as { name: string };
      expect(g.name).toBe(f.replace(/\.yml$/, ""));
    }
  });

  describe("which jobs run, by event (cloud #264)", () => {
    const CLOUD = "open-artifacts-ai/open-artifacts-cloud";
    type Ev = {
      event: string;
      repo?: string;
      ref?: string;
      direct?: string;
      bump?: string;
      /** workflow_run: the run that ended, and its branch */
      wf?: string;
      branch?: string;
      /** report: which of prepare and land ran */
      ran?: { prepare: string; land: string };
    };
    // A GitHub expression is plain JS once its contexts and functions are bound.
    const evaluate = (expr: string, o: Ev): unknown =>
      new Function(
        "github",
        "vars",
        "needs",
        "always",
        "startsWith",
        "format",
        `return ${expr.replace(/^\$\{\{\s*|\s*\}\}$/g, "")};`,
      )(
        {
          event_name: o.event,
          repository: o.repo ?? CLOUD,
          ref: o.ref ?? "refs/heads/main",
          run_id: 42,
          event: {
            workflow_run: { name: o.wf ?? "", head_branch: o.branch ?? "" },
          },
        },
        { PIN_BUMP_DIRECT: o.direct ?? "" },
        {
          prepare: {
            outputs: { bump: o.bump ?? "true" },
            result: o.ran?.prepare ?? "success",
          },
          land: { result: o.ran?.land ?? "success" },
        },
        () => true,
        (a: string, b: string) => a.startsWith(b),
        (f: string, ...a: unknown[]) =>
          f.replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)])),
      );
    // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
    type Wf = { name: string; on: any; jobs: any; concurrency: any };
    const BUMP: Wf = w;
    const LAND: Wf = lw;
    // Whether the workflow runs at all for this event (its `on:` filters).
    const triggers = (wf: Wf, o: Ev): boolean => {
      if (o.event === "workflow_dispatch") return "workflow_dispatch" in wf.on;
      if (o.event === "push") return "push" in wf.on;
      const r = wf.on.workflow_run;
      if (!r || !r.workflows.includes(o.wf)) return false;
      if (!r.branches) return true;
      return r.branches.some((b: string) =>
        b.endsWith("/**")
          ? (o.branch ?? "").startsWith(b.slice(0, -2))
          : b === o.branch,
      );
    };
    const runsIn = (wf: Wf, j: string, o: Ev): boolean =>
      triggers(wf, o) && Boolean(evaluate(String(wf.jobs[j].if), o));
    // report's `if` reads which of prepare and land ran, so bind those first
    const jobsIn = (wf: Wf, o: Ev): string[] => {
      const ran = Object.keys(wf.jobs)
        .filter((j) => j !== "report")
        .filter((j) => runsIn(wf, j, o));
      const r = {
        prepare: ran.includes("prepare") ? "success" : "skipped",
        land: ran.includes("land") ? "success" : "skipped",
      };
      return runsIn(wf, "report", { ...o, ran: r }) ? [...ran, "report"] : ran;
    };
    const jobsFor = (o: Ev) => jobsIn(BUMP, o);
    const landFor = (o: Ev) => jobsIn(LAND, o);
    const groupIn = (wf: Wf, o: Ev) =>
      evaluate(String(wf.concurrency.group), o);
    const group = (o: Ev) => groupIn(BUMP, o);
    const gateEnd = (wf: string, direct = "on") => ({
      event: "workflow_run",
      wf,
      branch: "main",
      direct,
    });
    const ciOnPin = (direct = "on"): Ev => ({
      event: "workflow_run",
      wf: "CI",
      branch: "pin-land/v1.2.3",
      direct,
    });

    it("a pin landing on main plans again at once, the same as a release dispatch", () => {
      for (const direct of ["", "on"]) {
        expect(jobsFor({ event: "push", direct })).toEqual(
          jobsFor({ event: "workflow_dispatch", direct }),
        );
        expect(jobsFor({ event: "push", direct })).toEqual([
          "prepare",
          "open",
          "report",
        ]);
      }
      // nothing newer: prepare's plan says no bump, and open does not run
      expect(jobsFor({ event: "push", bump: "false" })).toEqual([
        "prepare",
        "report",
      ]);
    });

    it("the lander never runs on the push, in direct mode or not (#481)", () => {
      for (const direct of ["", "on"]) {
        expect(triggers(LAND, { event: "push", direct })).toBe(false);
        expect(landFor({ event: "push", direct })).toEqual([]);
      }
      expect(landFor({ event: "workflow_dispatch", direct: "on" })).toEqual([
        "land",
        "report",
      ]);
      // not direct: a dispatch of the lander does nothing
      expect(landFor({ event: "workflow_dispatch" })).toEqual([]);
    });

    it("after CI on a staged pin, only the lander runs (direct mode)", () => {
      expect(landFor(ciOnPin())).toEqual(["land", "report"]);
      expect(triggers(BUMP, ciOnPin())).toBe(false);
      expect(jobsFor(ciOnPin())).toEqual([]);
      // not direct: nothing runs, and report does not close the blocker issue
      expect(landFor(ciOnPin(""))).toEqual([]);
    });

    it("a gate workflow ending on main plans and lands again in direct mode, and does nothing otherwise", () => {
      for (const wf of GATES) {
        expect(jobsFor(gateEnd(wf))).toEqual(["prepare", "open", "report"]);
        expect(jobsFor({ ...gateEnd(wf), bump: "false" })).toEqual([
          "prepare",
          "report",
        ]);
        expect(landFor(gateEnd(wf))).toEqual(["land", "report"]);
        // the PR path does not wait on the gate (pin-bump-arm does): no job
        expect(jobsFor(gateEnd(wf, ""))).toEqual([]);
        expect(landFor(gateEnd(wf, ""))).toEqual([]);
      }
    });

    it("a gate run ending off main wakes the plan and the lander too: the gate counts it, so its end may open the gate", () => {
      for (const wf of GATES)
        for (const branch of ["rehearsal/v0.251.0", "feature", "main"]) {
          const o = { ...gateEnd(wf), branch };
          expect(jobsFor(o), `${wf} on ${branch}`).toEqual([
            "prepare",
            "open",
            "report",
          ]);
          expect(landFor(o), `${wf} on ${branch}`).toEqual(["land", "report"]);
          expect(group(o)).toBe("pin-bump");
          expect(groupIn(LAND, o)).toBe("pin-land");
          // outside direct mode it still does nothing
          expect(jobsFor({ ...o, direct: "" })).toEqual([]);
          expect(landFor({ ...o, direct: "" })).toEqual([]);
        }
      // the branch is never trusted: the jobs read no event field in a step
      // (tested above), run main's checkout, and the plan and land decide
      // from readGate, which counts every branch's runs
      expect(String(jobs.prepare.if)).not.toContain("head_branch");
      expect(String(landJobs.land.if)).not.toContain("head_branch == 'main'");
    });

    it("readGate counts queued and running gate runs on every branch, so every one it counts must wake the plan and the lander", () => {
      const calls: string[] = [];
      const gate = readGate(
        (_cmd, args) => {
          const a = args.join(" ");
          calls.push(a);
          // one redline-staging run, off main, in progress
          if (
            a.includes("/runs?status=in_progress") &&
            a.includes("redline-staging.yml")
          )
            return { code: 0, stdout: "1\n", stderr: "" };
          if (a.includes("/runs?status=")) {
            if (a.includes("--jq .total_count"))
              return { code: 0, stdout: "0\n", stderr: "" };
            if (a.includes("display_title | select"))
              return { code: 0, stdout: '{"n":0,"t":[]}', stderr: "" };
            return { code: 0, stdout: "[]", stderr: "" };
          }
          // main's pin is not on prod, so the stages before the gate are read
          // (pin-bump-arm's stageSpent): none spent here.
          if (a.includes("commits?sha=main&path=PUBLIC_PIN"))
            return {
              code: 0,
              stdout: JSON.stringify({
                sha: "9".repeat(40),
                at: "2026-11-26T15:40:03Z",
              }),
              stderr: "",
            };
          if (a.includes("/runs?branch=main&"))
            return { code: 0, stdout: '{"n":0,"r":[]}', stderr: "" };
          return { code: 1, stdout: "", stderr: `unexpected ${a}` };
        },
        "o/r",
        "tag=v1.2.3\nsha=" + "a".repeat(40) + "\n",
      );
      expect(gate.busy).toEqual(["redline-staging.yml"]);
      expect(gate.dead).toBeUndefined();
      const counts = calls.filter((c) => c.includes("--jq .total_count"));
      expect(counts).toHaveLength(GATE_WORKFLOWS.length * 2);
      // no branch filter in the counts: a run on any branch holds the gate
      for (const c of counts) expect(c).not.toMatch(/[?&]branch=/);
      // and every gate workflow, and every stage before the gate whose end can
      // make main's pin dead, wakes both, on any branch
      for (const f of [...GATE_WORKFLOWS, ...PRE_GATE_WORKFLOWS]) {
        const wf = f.replace(/\.yml$/, "");
        expect(w.on.workflow_run.workflows).toContain(wf);
        expect(lw.on.workflow_run.workflows).toContain(wf);
      }
      expect(w.on.workflow_run.branches).toBeUndefined();
      expect(lw.on.workflow_run.branches).toBeUndefined();
    });

    it("CI ending anywhere but pin-land/* runs nothing, in direct mode or not", () => {
      for (const direct of ["", "on"])
        for (const branch of ["main", "feature", "pin-bump/v1.2.3"]) {
          const ci = { event: "workflow_run", wf: "CI", branch, direct };
          expect(jobsFor(ci)).toEqual([]);
          expect(landFor(ci)).toEqual([]);
          expect(groupIn(LAND, ci)).toBe("pin-land-idle-42");
        }
    });

    // Every event either workflow may see, in both modes.
    const eventsIn = (direct: string): Ev[] => [
      { event: "push", direct },
      { event: "workflow_dispatch", direct },
      ciOnPin(direct),
      { event: "workflow_run", wf: "CI", branch: "main", direct },
      ...GATES.map((wf) => gateEnd(wf, direct)),
      { ...gateEnd("prod-release-chain", direct), branch: "feature" },
      { ...gateEnd("redline-staging", direct), branch: "rehearsal/v0.251.0" },
      { event: "workflow_run", wf: "CI", branch: "feature", direct },
    ];
    // PIN_BUMP_DIRECT is one repo variable: two events in a row see the same mode.
    const MODES = ["", "on"];
    const EVENTS: Ev[] = MODES.flatMap(eventsIn);

    it("a run with work takes its workflow's one group; an event no job takes gets its own, so it never replaces a pending run", () => {
      for (const [wf, shared, idle] of [
        [BUMP, "pin-bump", "pin-bump-idle-42"],
        [LAND, "pin-land", "pin-land-idle-42"],
      ] as const)
        for (const o of EVENTS.filter((e) => triggers(wf, e))) {
          const work = jobsIn(wf, o).length > 0;
          if (work) expect(groupIn(wf, o), JSON.stringify(o)).toBe(shared);
          else if (groupIn(wf, o) === shared)
            // only a lander dispatch outside direct mode: no work, and every
            // other run in the group has none either
            expect(o).toEqual({ event: "workflow_dispatch", direct: "" });
          else expect(groupIn(wf, o)).toBe(idle);
        }
      expect(groupIn(BUMP, { event: "push" })).not.toBe(
        groupIn(LAND, ciOnPin()),
      );
    });

    // GitHub keeps one pending run per concurrency group: a newer event in the
    // group replaces it (cancel-in-progress false cancels the pending one, not
    // the running one). Replaying that slot must never drop an event's work.
    const pendingSlot = (wf: Wf, shared: string, events: Ev[]) => {
      let pending: Ev | undefined;
      for (const e of events)
        if (triggers(wf, e) && groupIn(wf, e) === shared) pending = e;
      return pending;
    };
    // All the work one event starts, across both workflows.
    const work = (o: Ev) => [
      ...jobsIn(BUMP, o).map((j) => `pin-bump:${j}`),
      ...jobsIn(LAND, o).map((j) => `pin-land:${j}`),
    ];

    it("a release dispatch followed by a pin-land CI event: the release is still planned and opened, and the pin landed (direct mode)", () => {
      const dispatch: Ev = { event: "workflow_dispatch", direct: "on" };
      const ci: Ev = { ...ciOnPin(), branch: "pin-land/v1.2.2" };
      // the CI event never takes the dispatch's pending slot
      expect(pendingSlot(BUMP, "pin-bump", [dispatch, ci])).toBe(dispatch);
      expect(jobsFor(dispatch)).toEqual(["prepare", "open", "report"]);
      // and the lander's slot holds the CI event
      expect(pendingSlot(LAND, "pin-land", [dispatch, ci])).toBe(ci);
      expect(landFor(ci)).toEqual(["land", "report"]);
    });

    it("whichever event replaces another in a group does every job the replaced one would there, and no event crosses groups", () => {
      for (const [wf, shared] of [
        [BUMP, "pin-bump"],
        [LAND, "pin-land"],
      ] as const) {
        for (const direct of MODES) {
          const inGroup = eventsIn(direct).filter(
            (o) => triggers(wf, o) && groupIn(wf, o) === shared,
          );
          // outside direct mode the lander's group holds only a dispatch, with no work
          expect(inGroup.length).toBeGreaterThanOrEqual(
            wf === LAND && direct === "" ? 1 : 2,
          );
          for (const first of inGroup)
            for (const later of inGroup) {
              const survivor = pendingSlot(wf, shared, [first, later]) as Ev;
              expect(survivor).toBe(later);
              const msg = `${wf.name}: ${JSON.stringify(first)} then ${JSON.stringify(later)}`;
              for (const j of jobsIn(wf, first))
                expect(jobsIn(wf, survivor), msg).toContain(j);
            }
        }
      }
      // each group holds one kind of work: plan/open there, land here
      for (const o of EVENTS) {
        for (const j of jobsIn(BUMP, o))
          expect(["prepare", "open", "report"]).toContain(j);
        for (const j of jobsIn(LAND, o))
          expect(["land", "report"]).toContain(j);
      }
      // and no event's work is lost: every one with work keeps a pending slot
      // in each workflow it has work in, whatever event comes after it
      for (const direct of MODES)
        for (const first of eventsIn(direct))
          for (const later of eventsIn(direct)) {
            const kept = [
              ...(jobsIn(BUMP, first).length
                ? jobsIn(
                    BUMP,
                    pendingSlot(BUMP, "pin-bump", [first, later]) as Ev,
                  ).map((j) => `pin-bump:${j}`)
                : []),
              ...(jobsIn(LAND, first).length
                ? jobsIn(
                    LAND,
                    pendingSlot(LAND, "pin-land", [first, later]) as Ev,
                  ).map((j) => `pin-land:${j}`)
                : []),
            ];
            for (const j of work(first))
              expect(
                kept,
                `${JSON.stringify(first)} then ${JSON.stringify(later)}`,
              ).toContain(j);
          }
    });

    it("never runs on a fork or another branch, whatever the event", () => {
      const events: Ev[] = [
        { event: "push" },
        { event: "workflow_dispatch" },
        ciOnPin(),
        gateEnd("prod-release-chain"),
      ];
      for (const e of events) {
        for (const o of [
          { ...e, repo: "someone/open-artifacts-cloud", direct: "on" },
          { ...e, ref: "refs/heads/feature", direct: "on" },
        ]) {
          expect(jobsFor(o)).toEqual([]);
          expect(landFor(o)).toEqual([]);
        }
      }
    });
  });

  it("is three jobs, in order", () => {
    expect(Object.keys(jobs)).toEqual(["prepare", "open", "report"]);
    expect(jobs.open.needs).toBe("prepare");
    expect(jobs.report.needs).toEqual(["prepare", "open"]);
  });

  it("grants nothing wide, one run at a time", () => {
    expect(w.permissions).toEqual({});
    // checks and statuses read: the plan reads an open bump's checks (#425).
    for (const j of [jobs.prepare, jobs.open])
      expect(j.permissions).toEqual({
        contents: "read",
        "pull-requests": "read",
        checks: "read",
        statuses: "read",
      });
    expect(jobs.report.permissions).toEqual({ issues: "write" });
    // actions read: land reads ci.yml's push run and its jobs (cloud #264).
    expect(landJobs.report.permissions).toEqual({ issues: "write" });
    expect(landJobs.land.permissions).toEqual({
      contents: "read",
      actions: "read",
      checks: "read",
      statuses: "read",
    });
    // the group itself is tested by event above
    expect(w.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("pins every third-party action by full SHA", () => {
    const uses = Object.values(jobs)
      // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
      .flatMap((j: any) => j.steps)
      .map((s: Step) => s.uses)
      .filter(Boolean) as string[];
    expect(uses.length).toBeGreaterThan(8);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}( |$)/);
  });

  it("prepare holds no secret and no token that can write", () => {
    const j = JSON.stringify(jobs.prepare);
    expect(j).not.toContain("secrets.");
    expect(j).not.toContain("create-github-app-token");
    expect(j).not.toContain("id-token");
    expect(j).not.toContain("steps.app");
    expect(jobs.prepare.environment).toBeUndefined();
    expect(jobs.prepare.permissions.contents).toBe("read");
  });

  it("prepare sends out only the lockfile and the surfaces plan", () => {
    const ups = stepsOf("prepare").filter((s) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(ups).toHaveLength(2);
    expect(ups[0].with.path).toMatch(/\/pnpm-lock\.yaml$/);
    expect(ups[1].with.path).toMatch(/\/regen\/plan\.json$/);
    expect(ups[1].with.name).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "pin-bump-regen-${{ steps.plan.outputs.tag }}",
    );
    expect(ups[0].with.name).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "pin-bump-lock-${{ steps.plan.outputs.tag }}",
    );
  });

  it("open never checks out or runs the public tree, and never installs", () => {
    const open = stepsOf("open");
    for (const s of open) {
      expect(s.with?.repository).toBeUndefined();
      expect(s.uses ?? "").not.toMatch(/pnpm\/action-setup/);
      expect(s.run ?? "").not.toMatch(
        /(^|\s)(pnpm|npm|npx|yarn) |overlay\.sh|public\//,
      );
      expect(s.working_directory ?? s["working-directory"] ?? "").not.toMatch(
        /public/,
      );
    }
    expect(JSON.stringify(jobs.open)).not.toContain("path: public");
    // main's own checkout only
    const co = open.filter((s) => s.uses?.startsWith("actions/checkout@"));
    expect(co).toHaveLength(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(co[0].with.ref).toBe("${{ github.sha }}");
  });

  it("open plans again itself and takes the lockfile by its own tag, as data", () => {
    const open = stepsOf("open");
    const names = open.map((s) => s.id ?? s.name ?? s.uses);
    expect(names.indexOf("plan")).toBeGreaterThan(-1);
    const dl = open.find((s) =>
      s.uses?.startsWith("actions/download-artifact@"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(dl.with.name).toBe("pin-bump-lock-${{ steps.plan.outputs.tag }}");
    // the token is minted only after the lockfile is in place
    const at = (f: (s: Step) => boolean) => open.findIndex(f);
    const iApp = at((s) => s.id === "app");
    expect(iApp).toBeGreaterThan(at((s) => s === dl));
    expect(iApp).toBeGreaterThan(
      at((s) => s.name === "Take the lockfile as data"),
    );
    expect(iApp).toBeGreaterThan(at((s) => s.id === "plan"));
    expect(iApp).toBeGreaterThan(at((s) => s.name === "Move the pin files"));
    const take = open.find((s) => s.name === "Take the lockfile as data");
    expect(take.run).toContain("-L");
    expect(take.run).toContain("10000000");
  });

  it("open applies the surfaces plan as data, with main's own script, before the token is minted", () => {
    const open = stepsOf("open");
    const names = open.map((s) => s.id ?? s.name ?? s.uses);
    const apply = open.find(
      (s) => s.name === "Apply the surfaces plan as data",
    );
    expect(apply.run).toContain("-L");
    expect(apply.run).toContain("2000000");
    expect(apply.run).toContain(
      "node --experimental-strip-types --no-warnings tests/redline/scripts/redline-regen.ts apply --plan",
    );
    expect(open.indexOf(apply)).toBeLessThan(names.indexOf("app"));
    const dl = open.filter((s) =>
      s.uses?.startsWith("actions/download-artifact@"),
    );
    expect(dl.map((s) => s.with.name)).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "pin-bump-lock-${{ steps.plan.outputs.tag }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "pin-bump-regen-${{ steps.plan.outputs.tag }}",
    ]);
  });

  it("prepare plans the surfaces port after the lockfile, with an install that runs no scripts", () => {
    const prep = stepsOf("prepare");
    const plan = prep.find((s) => s.name?.startsWith("Plan the surfaces port"));
    expect(plan.run).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts",
    );
    expect(plan.run).toContain("scripts/redline-regen.ts plan --out");
    expect(plan["working-directory"]).toBe("public");
    const lock = prep.findIndex(
      (s) => s.name === "Regenerate the merged lockfile",
    );
    expect(prep.indexOf(plan)).toBeGreaterThan(lock);
    // The lockfile leaves before any public build code runs (v4 artifacts can't
    // be overwritten by name, so the build can't swap it).
    const upLock = prep.findIndex(
      (s) =>
        s.uses?.startsWith("actions/upload-artifact@") &&
        s.with?.name?.startsWith("pin-bump-lock-"),
    );
    expect(upLock).toBeGreaterThan(lock);
    expect(upLock).toBeLessThan(prep.indexOf(plan));
  });

  it("writes only with the release App's token, scoped to contents and PRs", () => {
    const app = step("open", "app");
    expect(app.uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(app.with["app-id"]).toBe("${{ secrets.RELEASE_APP_ID }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    const key = "${{ secrets.RELEASE_APP_PRIVATE_KEY }}";
    expect(app.with["private-key"]).toBe(key);
    expect(app.with["permission-contents"]).toBe("write");
    expect(app.with["permission-pull-requests"]).toBe("write");
    for (const j of ["prepare", "open"]) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(step(j, "plan").env.GH_TOKEN).toBe("${{ github.token }}");
    }
    expect(JSON.stringify(jobs.report)).not.toContain("secrets.");
  });

  it("commits through the git-data API with the App token, not local git", () => {
    const c = step("open", "commit");
    const push = stepsOf("open").find((s) => s.name === "Push the branch");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(c.env.GH_TOKEN).toBe("${{ steps.app.outputs.token }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(push.env.GH_TOKEN).toBe("${{ steps.app.outputs.token }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(c.env.BASE).toBe("${{ github.sha }}");
    for (const call of ["git/blobs", "git/trees", "git/commits"])
      expect(c.run).toContain(call);
    expect(c.run).toContain('echo "commit=$commit" >> "$GITHUB_OUTPUT"');
    expect(c.run).not.toContain("git/refs");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(push.env.COMMIT).toBe("${{ steps.commit.outputs.commit }}");
    for (const call of ["git/refs/heads/$BRANCH", "git/refs"])
      expect(push.run).toContain(call);
    // Only the pin files, the lockfile and the three surfaces-port files the plan
    // regenerates, as regular files, on top of the main sha the job checked out.
    expect(c.run).toContain(
      "for f in PUBLIC_PIN SYNCED_FROM pnpm-lock.yaml tests/redline/live/manifest.json tests/redline/test/cases-added.ts tests/redline/test/surfaces.test.ts; do",
    );
    expect(c.run).toContain('mode: "100644"');
    expect(c.run).toContain("parents: [$p]");
    // No author or committer is set, so GitHub records the App and signs it.
    expect(c.run).not.toMatch(/author|committer/);
    // An existing branch is moved with force; a new one is created.
    expect(push.run).toContain("-F force=true");
    expect(push.run).toContain("-X POST");
    for (const r of [c.run, push.run])
      expect(r).not.toMatch(/\bgit (commit|push|config|switch|add)\b/);
    expect(text).not.toMatch(/github-actions\[bot\]|x-access-token/);
    const names = stepsOf("open").map((s) => s.name ?? s.id);
    expect(names.indexOf(c.name)).toBeGreaterThan(
      names.indexOf("Take the lockfile as data"),
    );
    expect(names.indexOf(c.name)).toBeLessThan(names.indexOf(push.name));
    expect(names.indexOf(push.name)).toBeLessThan(
      names.indexOf("Open the PR (never armed)"),
    );
  });

  describe("direct mode (PIN_BUMP_DIRECT, cloud #264)", () => {
    // A step's `if` or a MODE expression is plain JS once its contexts are bound.
    const evalExpr = (
      expr: string,
      direct: string | null,
      route: Record<string, string> = {},
    ) =>
      new Function(
        "vars",
        "steps",
        `return ${String(expr)
          .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
          .replaceAll("vars.PIN_BUMP_DIRECT", "vars.direct")};`,
      )(
        { direct },
        { plan: { outputs: { bump: "true" } }, route: { outputs: route } },
      );
    const runs = (direct: string | null, route: Record<string, string>) =>
      stepsOf("open")
        .filter((s) => !s.if || evalExpr(s.if, direct, route))
        .map((s) => s.id ?? s.name ?? s.uses);
    const PR = { route: "pr", pr: "true" };
    const DIRECT = { route: "direct", pr: "false" };
    const STAGE = "Stage the pin for CI (direct mode)";

    it("unset (or not exactly on), the plan is today's and the route passes the PR plan through", () => {
      for (const v of [null, "", "off", "ON"]) {
        for (const j of ["prepare", "open"])
          expect(evalExpr(step(j, "plan").env.MODE, v)).toBe("plan");
        expect(evalExpr(step("open", "route").env.DIRECT, v)).toBe("off");
      }
      expect(landJobs.land.if).toContain("vars.PIN_BUMP_DIRECT == 'on'");
    });

    it("the PR route pushes the branch and opens the PR, and stages nothing", () => {
      const names = runs(null, PR);
      expect(names).toContain("commit");
      expect(names).toContain("Push the branch");
      expect(names).toContain("Open the PR (never armed)");
      expect(names).not.toContain(STAGE);
    });

    it("the direct route stages on pin-land and never pushes a PR branch, opens a PR or moves main", () => {
      const names = runs("on", DIRECT);
      expect(names).toContain("commit");
      expect(names).not.toContain("Push the branch");
      expect(names).not.toContain("Open the PR (never armed)");
      expect(names).toContain(STAGE);
      for (const j of ["prepare", "open"])
        expect(evalExpr(step(j, "plan").env.MODE, "on")).toBe("plan-direct");
      expect(evalExpr(step("open", "route").env.DIRECT, "on")).toBe("on");
      expect(JSON.stringify(jobs.open)).not.toContain("pin-bump.ts land");
    });

    it("a PR route with nothing to open commits nothing", () => {
      const names = runs("on", { route: "pr", pr: "false" });
      for (const n of [
        "commit",
        "Push the branch",
        "Open the PR (never armed)",
        STAGE,
      ])
        expect(names).not.toContain(n);
    });

    it("the route decides on the surfaces port, before the token is minted", () => {
      const open = stepsOf("open");
      const r = step("open", "route");
      expect(r.run).toContain(
        "git diff --quiet HEAD -- tests/redline/live/manifest.json tests/redline/test/cases-added.ts tests/redline/test/surfaces.test.ts || surfaces=changed",
      );
      expect(r.run).toContain("pin-bump.ts route");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(r.env.GH_TOKEN).toBe("${{ github.token }}");
      expect(open.indexOf(r)).toBeGreaterThan(
        open.findIndex((s) => s.name === "Apply the surfaces plan as data"),
      );
      expect(open.indexOf(r)).toBeLessThan(
        open.findIndex((s) => s.id === "app"),
      );
      const push = open.find((s) => s.name === "Push the branch");
      const pr = open.find((s) => s.name === "Open the PR (never armed)");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(push.env.BRANCH).toBe("${{ steps.route.outputs.branch }}");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(pr.env.BRANCH).toBe("${{ steps.route.outputs.branch }}");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(pr.env.SUPERSEDE).toBe("${{ steps.route.outputs.supersede }}");
    });

    it("stages with the App token, after the commit, with the plan's tag and sha", () => {
      const open = stepsOf("open");
      const l = open.find((s) => s.name === STAGE);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(l.env.GH_TOKEN).toBe("${{ steps.app.outputs.token }}");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(l.env.BASE).toBe("${{ github.sha }}");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(l.env.COMMIT).toBe("${{ steps.commit.outputs.commit }}");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(l.env.TAG).toBe("${{ steps.plan.outputs.tag }}");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(l.env.SHA).toBe("${{ steps.plan.outputs.sha }}");
      expect(l.run).toBe(
        'node --experimental-strip-types scripts/ci/pin-bump.ts stage --repo "$GITHUB_REPOSITORY" --base "$BASE" --commit "$COMMIT" --tag "$TAG" --sha "$SHA"',
      );
      expect(open.indexOf(l)).toBeGreaterThan(
        open.findIndex((s) => s.id === "commit"),
      );
    });

    it("land reads with the job token, writes with a contents-only App token, from main's checkout", () => {
      const steps = landSteps("land");
      const app = steps.find((s) => s.id === "app");
      expect(app.with["permission-contents"]).toBe("write");
      expect(app.with["permission-pull-requests"]).toBeUndefined();
      const l = steps.find((s) => s.run?.includes("pin-bump.ts land"));
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(l.env.GH_TOKEN).toBe("${{ steps.app.outputs.token }}");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(l.env.READ_TOKEN).toBe("${{ github.token }}");
      const co = steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
      expect(co).toHaveLength(1);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(co[0].with.ref).toBe("${{ github.sha }}");
      // Its own App in its own Environment: the bypass actor on main, never the release App.
      expect(landJobs.land.environment).toBe("pin-land");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(app.with["app-id"]).toBe("${{ secrets.PIN_LAND_APP_ID }}");
      expect(app.with["private-key"]).toBe(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
        "${{ secrets.PIN_LAND_APP_PRIVATE_KEY }}",
      );
      expect(JSON.stringify(landJobs.land)).not.toContain("RELEASE_APP_");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(l.env.LAND_BOT).toBe("${{ steps.app.outputs.app-slug }}[bot]");
    });

    it("only open and land see the App token", () => {
      // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
      const tokened = (js: any) =>
        Object.entries(js)
          .filter(([, j]) =>
            // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
            JSON.stringify((j as any).steps).includes(
              "steps.app.outputs.token",
            ),
          )
          .map(([k]) => k);
      expect(tokened(jobs)).toEqual(["open"]);
      expect(tokened(landJobs)).toEqual(["land"]);
      expect(jobs.open.environment).toBe("release-app");
    });

    it("CI runs in full on a push to pin-land/*, with the commit's parent as the port-check base", () => {
      // In the overlay tree ci.yml is public's; this repo's sits at ../private
      // (as in ci-pin-once-workflow.test.ts). This repo's is the one with the
      // overlay-action job.
      const ci = parse(
        [
          join(root, "../private/.github/workflows/ci.yml"),
          join(root, ".github/workflows/ci.yml"),
        ]
          .filter((f) => existsSync(f))
          .map((f) => readFileSync(f, "utf8"))
          .find((t) => /^ {2}overlay-action:$/m.test(t)) as string,
      );
      expect(ci.on.push.branches).toContain("pin-land/**");
      const synced = ci.jobs["overlay-shard"].steps.find(
        // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
        (s: any) => s.id === "synced",
      );
      expect(synced.run).toContain('[[ "$REF" == refs/heads/pin-land/* ]]');
      expect(synced.run).toContain("repos/$REPO/commits/$GITHUB_SHA");
      // land reads the short path off this step: it runs only when pin_only is true.
      for (const name of ["overlay-shard", "lint", "e2e"]) {
        const short = ci.jobs[name].steps.find(
          // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
          (s: any) => s.name === PIN_ONLY_STEP,
        );
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
        expect(short.if).toBe("${{ steps.ro.outputs.pin_only == 'true' }}");
      }
    });
  });

  it("never arms or merges", () => {
    expect(text).not.toMatch(
      /gh pr merge|--auto(?![-\w])|--admin|auto-merge|enablePullRequestAutoMerge/,
    );
    expect(
      readFileSync(join(root, "scripts/ci/pin-bump.ts"), "utf8"),
    ).not.toMatch(/"merge"|--auto(?![-\w])|--admin/);
  });

  it("after the plan, prepare's and open's steps run only when it says bump", () => {
    for (const j of ["prepare", "open"]) {
      const steps = stepsOf(j);
      const i = steps.findIndex((s) => s.id === "plan");
      for (const s of steps.slice(i + 1))
        expect(s.if).toContain("steps.plan.outputs.bump == 'true'");
    }
    expect(jobs.open.if).toContain("needs.prepare.outputs.bump == 'true'");
  });

  it("prepare checks out only the pinned sha of public, with no stored credentials", () => {
    const pub = stepsOf("prepare").find(
      (s) => s.with?.repository === "open-artifacts-ai/open-artifacts",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(pub.with.ref).toBe("${{ steps.plan.outputs.sha }}");
    expect(pub.with["persist-credentials"]).toBe(false);
    for (const j of ["prepare", "open"])
      for (const s of stepsOf(j).filter((s) =>
        s.uses?.startsWith("actions/checkout@"),
      ))
        expect(s.with["persist-credentials"]).toBe(false);
  });

  describe("report", () => {
    const rep = stepsOf("report");
    it("has no checkout and no action, and runs whatever the others did", () => {
      expect(rep).toHaveLength(1);
      expect(rep[0].uses).toBeUndefined();
      expect(jobs.report.if).toContain("always()");
      // a job past its timeout is reported as cancelled: report must still run
      expect(jobs.report.if).not.toContain("cancelled");
    });

    // The RESULT expression is plain JS once the needs are bound.
    const resultOf =
      (r: Step) =>
      (prepare: string, open: string, land = "skipped") => {
        const expr = String(r.env.RESULT)
          .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
          .replaceAll("needs.prepare.result", "prepare")
          .replaceAll("needs.open.result", "open")
          .replaceAll("needs.land.result", "land");
        return new Function("prepare", "open", "land", `return ${expr};`)(
          prepare,
          open,
          land,
        );
      };
    const result = resultOf(rep[0]);

    it("anything but success is red; an open skipped for no bump is green", () => {
      expect(result("success", "success")).toBe("success");
      expect(result("success", "skipped")).toBe("success");
      expect(result("success", "failure")).toBe("failure");
      expect(result("success", "cancelled")).toBe("failure");
      expect(result("failure", "skipped")).toBe("failure");
      // a prepare past its timeout is reported cancelled, so it files an issue
      expect(result("cancelled", "skipped")).toBe("failure");
      // land is pin-land.yml's: it never colours this report
      expect(rep[0].env.RESULT).not.toContain("needs.land");
    });

    it("pin-land.yml's report: a staged pin that cannot land is red, under its own title", () => {
      const lrep = landSteps("report");
      expect(lrep).toHaveLength(1);
      expect(lrep[0].uses).toBeUndefined();
      expect(landJobs.report.if).toContain("always()");
      expect(landJobs.report.if).not.toContain("cancelled");
      const lresult = resultOf(lrep[0]);
      expect(lresult("skipped", "skipped", "success")).toBe("success");
      expect(lresult("skipped", "skipped", "failure")).toBe("failure");
      // past its timeout, land is reported cancelled: red
      expect(lresult("skipped", "skipped", "cancelled")).toBe("failure");
      expect(lrep[0].run).toContain('title="pin-land failed"');
      // never the opener's issue: a green land must not close a red plan's
      expect(lrep[0].run).not.toContain("pin-bump failed");
      expect(lrep[0].run.replace('title="pin-land failed"', "")).toBe(
        rep[0].run
          .replace('title="pin-bump failed"', "")
          .replace(
            "The pin-bump workflow failed",
            "The pin-land workflow failed",
          ),
      );
    });

    const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
    const log = join(bin, "log");
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1 $2" in
  "issue list") printf '%s' "\${FAKE_OPEN:-}" ;;
  "label list") printf '%s' "\${FAKE_LABELS:-}" ;;
esac
`,
      { mode: 0o755 },
    );
    const run = (result: string, env: Record<string, string> = {}) => {
      writeFileSync(log, "");
      const r = spawnSync("bash", ["-c", rep[0].run], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          REPO,
          RESULT: result,
          RUN: "https://github.com/x/y/actions/runs/1",
          ...env,
        },
      });
      expect(r.status, r.stderr).toBe(0);
      return readFileSync(log, "utf8").trim().split("\n");
    };

    it("red opens one blocker issue titled 'pin-bump failed' with the run URL", () => {
      const calls = run("failure", { FAKE_LABELS: "blocker\nbug" });
      const create = calls.find((c) => c.startsWith("issue create")) ?? "";
      expect(create).toContain("--title pin-bump failed");
      expect(create).toContain("--label blocker");
      expect(create).toContain("actions/runs/1");
      expect(calls.filter((c) => c.startsWith("issue create"))).toHaveLength(1);
      expect(calls.some((c) => c.startsWith("label create"))).toBe(false);
    });

    it("creates the blocker label only when it is missing", () => {
      const calls = run("failure", { FAKE_LABELS: "bug" });
      expect(calls.some((c) => c.startsWith("label create blocker"))).toBe(
        true,
      );
    });

    it("red with one already open comments on it and opens no second", () => {
      const calls = run("failure", { FAKE_OPEN: "12" });
      expect(calls.some((c) => c.startsWith("issue create"))).toBe(false);
      expect(calls.some((c) => c.startsWith("issue comment 12"))).toBe(true);
    });

    it("green closes the open issue, and does nothing when none is open", () => {
      const closed = run("success", { FAKE_OPEN: "12" });
      expect(closed.some((c) => c.startsWith("issue close 12"))).toBe(true);
      const none = run("success");
      expect(none.every((c) => c.startsWith("issue list"))).toBe(true);
    });

    it("looks only among open issues labelled blocker, by the exact title", () => {
      const list = run("success")[0] ?? "";
      expect(list).toContain("--state open");
      expect(list).toContain("--label blocker");
      expect(list).toContain("pin-bump failed");
    });
  });
});

describe("planDirect", () => {
  const go = (o: Parameters<typeof world>[0], pin = PIN) => {
    const w = world(o);
    return {
      r: planDirect({ exec: w.exec, repo: REPO, publicRepo: PUB, pin }),
      w,
    };
  };

  it("bumps to the newest release and resolves its sha", () => {
    expect(go({}).r).toMatchObject({
      bump: true,
      tag: "v0.137.0",
      sha: NEW_SHA,
    });
  });

  it("an equal tag is no bump", () => {
    const { r } = go({ releases: [rel("v0.136.1"), rel("v0.136.0")] });
    expect(r).toMatchObject({ bump: false, tag: "", sha: "" });
  });

  it("reads no PR: an open or taken bump PR is ignored", () => {
    const { r, w } = go({
      open: [
        {
          number: 7,
          headRefName: branchOf("v0.137.0"),
          url: "u",
          createdAt: hoursAgo(100),
        },
      ],
      taken: [{ number: 7, state: "CLOSED" }],
    });
    expect(r).toMatchObject({ bump: true, tag: "v0.137.0" });
    expect(w.calls.some((c) => c[0] === "pr")).toBe(false);
  });

  it("a tag already staged on pin-land/<tag> is no bump; land takes it", () => {
    const { r, w } = go({ landRefs: ["refs/heads/pin-land/v0.137.0"] });
    expect(r).toMatchObject({ bump: false, tag: "" });
    expect(r.why).toContain("pin-land/v0.137.0 is already staged");
    expect(
      w.calls.some((c) =>
        c[1]?.endsWith("git/matching-refs/heads/pin-land/v0.137.0"),
      ),
    ).toBe(true);
  });

  it("a staged branch whose name only starts with the tag is not this tag", () => {
    const { r } = go({ landRefs: ["refs/heads/pin-land/v0.137.01"] });
    expect(r).toMatchObject({ bump: true, tag: "v0.137.0" });
  });

  describe("the release pipeline gate (pin-bump-arm's gateRefusal)", () => {
    it("a busy gate workflow stages nothing", () => {
      const { r } = go({ gate: { busy: ["redline-staging.yml"] } });
      expect(r).toMatchObject({ bump: false, tag: "", sha: "" });
      expect(r.why).toContain("candidate open: redline-staging.yml");
    });

    it("main's pin not yet on prod stages nothing", () => {
      const { r } = go({
        gate: { deployed: ["deploy-hosted-platform prod v0.136.0 [c1-1]"] },
      });
      expect(r).toMatchObject({ bump: false, tag: "" });
      expect(r.why).toContain(
        "main's pin v0.136.1 has no successful prod deploy yet",
      );
    });

    it("main's pin rejected by the gate after its retry (#449) does not hold the bump", () => {
      const { r } = go({
        gate: {
          deployed: [],
          gateRuns: [{ t: "redline-staging v0.136.1", c: "failure", a: 2 }],
        },
      });
      expect(r).toMatchObject({ bump: true, tag: "v0.137.0", sha: NEW_SHA });
    });

    it("main's pin dead before the gate (v0.253.0: hosted-release failed with its retry spent) does not hold the bump", () => {
      const { r } = go({
        gate: {
          deployed: [],
          stageRuns: {
            "hosted-release.yml": [
              { s: "completed", c: "failure", a: 3, t: "hosted-release" },
            ],
          },
        },
      });
      expect(r).toMatchObject({ bump: true, tag: "v0.137.0", sha: NEW_SHA });
    });

    it("a hosted-release still running, or due its retry, keeps the hold", () => {
      for (const run of [
        { s: "in_progress", c: null, a: 3, t: "hosted-release" },
        { s: "completed", c: "failure", a: 2, t: "hosted-release" },
      ]) {
        const { r } = go({
          gate: { deployed: [], stageRuns: { "hosted-release.yml": [run] } },
        });
        expect(r, JSON.stringify(run)).toMatchObject({ bump: false });
      }
    });

    it("a first-attempt failure is no rejection: still waits", () => {
      const { r } = go({
        gate: {
          deployed: [],
          gateRuns: [{ t: "redline-staging v0.136.1", c: "failure", a: 1 }],
        },
      });
      expect(r).toMatchObject({ bump: false });
    });

    it("a gate that cannot be read throws", () => {
      expect(() => go({ gate: { fail: true } })).toThrow("404");
    });

    it("is not read when there is nothing to bump", () => {
      const { w } = go({ releases: [rel("v0.136.1")], gate: { fail: true } });
      expect(w.calls.some((c) => c[1]?.includes("/actions/"))).toBe(false);
    });
  });

  it("ignores drafts and prereleases", () => {
    const { r } = go({
      releases: [
        rel("v0.140.0", { draft: true }),
        rel("v0.139.0", { prerelease: true }),
        rel("v0.137.0"),
      ],
    });
    expect(r).toMatchObject({ bump: true, tag: "v0.137.0" });
  });

  it("throws on an API error, a bad sha, or no stable release", () => {
    expect(() => go({ failApi: "releases" })).toThrow("502");
    expect(() => go({ sha: "nope" })).toThrow("not a full sha");
    expect(() => go({ releases: [rel("v0.140.0", { draft: true })] })).toThrow(
      "no stable",
    );
  });
});

describe("direct mode: stage, landBranch, land, route", () => {
  const BASE = "b".repeat(40);
  const COMMIT = "c".repeat(40);
  const MAIN2 = "d".repeat(40);
  const REBUILT = "e".repeat(40);
  const TAG = "v0.137.0";
  const BRANCH = "pin-land/v0.137.0";
  const pinAt = (tag: string, sha: string) => `# pin\ntag=${tag}\nsha=${sha}\n`;
  const mod = (filename: string, status = "modified") => ({
    filename,
    status,
    sha: `${filename.length.toString(16).padStart(2, "0")}${"f".repeat(38)}`,
  });
  const REQUIRED = ["scripts", "overlay", "lint"];
  const RUN = 7;
  /** ci.yml's push run on the staged branch at its head, passed. */
  const ciRun = (o: Record<string, unknown> = {}) => ({
    id: RUN,
    path: CI_WORKFLOW,
    event: "push",
    head_branch: BRANCH,
    head_sha: COMMIT,
    status: "completed",
    conclusion: "success",
    ...o,
  });
  /** A job of that run; full unless `short` (the pin-only short path ran). */
  const job = (
    name: string,
    o: { conclusion?: string; short?: boolean } = {},
  ) => ({
    name,
    status: "completed",
    conclusion: o.conclusion ?? "success",
    steps: [
      {
        name: "pin-only bot PR? (decided by the base commit's script)",
        conclusion: "success",
      },
      { name: PIN_ONLY_STEP, conclusion: o.short ? "success" : "skipped" },
    ],
  });
  type LandWorld = {
    parents?: string[];
    files?: { filename: string; status: string; sha: string }[];
    ahead?: number;
    pinText?: string;
    syncedText?: string;
    /** main's sha, read in turn; the last one repeats. */
    mains?: string[];
    mainPin?: string;
    moved?: { status?: string; behind_by?: number; files?: string[] };
    /** stderr of each PATCH of main in turn; "" is success. */
    patches?: string[];
    /** stderr of the POST that creates a ref; "" is success. */
    createRef?: string;
    author?: string;
    committer?: string;
    verified?: boolean;
    required?: string[];
    /** ci.yml's runs the runs query lists. */
    runs?: ReturnType<typeof ciRun>[];
    /** the jobs of each run, by id; a run not listed has REQUIRED, all full. */
    jobs?: Record<number, ReturnType<typeof job>[]>;
    refs?: string[];
    gate?: GateWorld;
    landBot?: string;
  };
  const landWorld = (o: LandWorld) => {
    const calls: { by: "read" | "write"; args: string[] }[] = [];
    const bodies: unknown[] = [];
    let reads = 0;
    let patch = 0;
    const ok = (v: unknown) => ({
      code: 0,
      stdout: typeof v === "string" ? v : JSON.stringify(v),
      stderr: "",
    });
    const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
    const answer = (args: string[]) => {
      const method = args[1] === "-X" ? (args[2] ?? "") : "GET";
      const path =
        args[1] === "-X" || args[1] === "--paginate"
          ? (args[3] ?? "")
          : (args[1] ?? "");
      if (method === "PATCH" && path.endsWith("git/refs/heads/main")) {
        const err = o.patches?.[patch++] ?? "";
        return err ? fail(err) : ok({ object: { sha: "x" } });
      }
      if (method === "PATCH" || method === "DELETE") return ok("");
      const g = method === "GET" ? gateAnswer(o.gate, path) : undefined;
      if (g) return g;
      if (method === "POST" && path.endsWith("git/refs"))
        return o.createRef ? fail(o.createRef) : ok("");
      if (path.endsWith("git/matching-refs/heads/pin-land/"))
        return ok((o.refs ?? [`refs/heads/${BRANCH}`]).map((ref) => ({ ref })));
      if (path.endsWith("git/ref/heads/main")) {
        const m = o.mains ?? [BASE];
        return ok(`${m[Math.min(reads++, m.length - 1)]}\n`);
      }
      if (path.endsWith(`git/ref/heads/${BRANCH}`)) return ok(`${COMMIT}\n`);
      if (path.endsWith(`repos/${REPO}/commits/${COMMIT}`))
        return ok({
          author: { login: o.author ?? "open-artifacts-release[bot]" },
          committer: { login: o.committer ?? "web-flow" },
          parents: (o.parents ?? [BASE]).map((sha) => ({ sha })),
          commit: {
            message: `chore(pin): bump PUBLIC_PIN to ${TAG}`,
            verification: { verified: o.verified ?? true },
          },
        });
      if (path.endsWith(`repos/${PUB}/commits/${TAG}`))
        return ok(`${NEW_SHA}\n`);
      if (path.endsWith(`git/commits/${COMMIT}`))
        return ok({
          sha: COMMIT,
          message: `chore(pin): bump PUBLIC_PIN to ${TAG}`,
          tree: { sha: "1".repeat(40) },
          parents: (o.parents ?? [BASE]).map((sha) => ({ sha })),
        });
      if (path.endsWith(`git/commits/${MAIN2}`))
        return ok({
          sha: MAIN2,
          message: "m",
          tree: { sha: "2".repeat(40) },
          parents: [],
        });
      if (path.endsWith(`compare/${BASE}...${COMMIT}`))
        return ok({
          status: "ahead",
          ahead_by: o.ahead ?? 1,
          behind_by: 0,
          files: o.files ?? [mod("PUBLIC_PIN"), mod("SYNCED_FROM")],
        });
      if (path.includes(`compare/${BASE}...`))
        return ok({
          status: o.moved?.status ?? "ahead",
          ahead_by: 1,
          behind_by: o.moved?.behind_by ?? 0,
          files: (o.moved?.files ?? ["apps/x/src/a.ts"]).map((f) => mod(f)),
        });
      if (path.endsWith(`contents/PUBLIC_PIN?ref=${COMMIT}`))
        return ok(o.pinText ?? pinAt(TAG, NEW_SHA));
      if (path.endsWith(`contents/SYNCED_FROM?ref=${COMMIT}`))
        return ok(o.syncedText ?? pinAt(TAG, NEW_SHA));
      if (path.includes("contents/PUBLIC_PIN?ref="))
        return ok(o.mainPin ?? PIN);
      if (path.endsWith("rules/branches/main"))
        return ok([
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: (o.required ?? REQUIRED).map(
                (context) => ({ context }),
              ),
            },
          },
        ]);
      if (path.includes("actions/workflows/ci.yml/runs?"))
        return ok({ workflow_runs: o.runs ?? [ciRun()] });
      const jr = /actions\/runs\/(\d+)\/jobs\?/.exec(path);
      if (jr)
        return ok([
          {
            jobs: o.jobs?.[Number(jr[1])] ?? REQUIRED.map((n) => job(n)),
          },
        ]);
      if (path.endsWith("git/trees") || path.endsWith("git/commits")) {
        const i = args.indexOf("--input");
        bodies.push(JSON.parse(readFileSync(args[i + 1] ?? "", "utf8")));
        return ok(`${path.endsWith("git/trees") ? "3".repeat(40) : REBUILT}\n`);
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const exec: Exec = (_c, args) => {
      calls.push({ by: "write", args });
      return answer(args);
    };
    const read: Exec = (_c, args) => {
      calls.push({ by: "read", args });
      return answer(args);
    };
    const one = () =>
      landBranch({
        exec,
        read,
        repo: REPO,
        publicRepo: PUB,
        branch: BRANCH,
        landBot: o.landBot,
      });
    const all = () => land({ exec, read, repo: REPO, publicRepo: PUB });
    const doStage = () =>
      stage({
        exec,
        repo: REPO,
        base: BASE,
        commit: COMMIT,
        tag: TAG,
        sha: NEW_SHA,
      });
    return { exec, read, calls, bodies, one, all, doStage };
  };
  type Calls = ReturnType<typeof landWorld>["calls"];
  const writes = (calls: Calls) =>
    calls.filter((c) => c.args[1] === "-X").map((c) => c.args);
  const mainMoves = (calls: Calls) =>
    writes(calls).filter((a) => a[3]?.endsWith("git/refs/heads/main"));

  describe("stage", () => {
    it("pushes the pin commit to pin-land/<tag> and never moves main", () => {
      const w = landWorld({});
      expect(w.doStage()).toEqual({ branch: BRANCH, sha: COMMIT });
      expect(writes(w.calls)).toEqual([
        [
          "api",
          "-X",
          "POST",
          `repos/${REPO}/git/refs`,
          "-f",
          `ref=refs/heads/${BRANCH}`,
          "-f",
          `sha=${COMMIT}`,
        ],
      ]);
      expect(landBranchOf(TAG)).toBe(BRANCH);
    });

    it("moves a leftover branch with force, never main", () => {
      const w = landWorld({
        createRef: "gh: Reference already exists (HTTP 422)",
      });
      w.doStage();
      const p = writes(w.calls).filter((a) => a[2] === "PATCH");
      expect(p).toHaveLength(1);
      expect(p[0]?.[3]).toBe(`repos/${REPO}/git/refs/heads/${BRANCH}`);
      expect(p[0]).toContain("force=true");
      expect(mainMoves(w.calls)).toHaveLength(0);
    });

    it.each([
      [
        "a surfaces-port file",
        {
          files: [
            mod("PUBLIC_PIN"),
            mod("SYNCED_FROM"),
            mod("tests/redline/test/cases-added.ts"),
          ],
        },
        "land without a person",
      ],
      [
        "an added lockfile",
        {
          files: [
            mod("PUBLIC_PIN"),
            mod("SYNCED_FROM"),
            mod("pnpm-lock.yaml", "added"),
          ],
        },
        "is added",
      ],
      ["a parent that is not the base", { parents: [MAIN2] }, "not just"],
      ["two commits ahead", { ahead: 2 }, "not one commit ahead"],
      [
        "a PUBLIC_PIN for another tag",
        { pinText: pinAt("v0.137.1", NEW_SHA) },
        "not v0.137.0",
      ],
    ] as [string, LandWorld, string][])("refuses %s", (_n, o, msg) => {
      const w = landWorld(o);
      expect(() => w.doStage()).toThrow(msg);
      expect(writes(w.calls)).toHaveLength(0);
    });

    it("refuses arguments that are not a tag or full shas", () => {
      const { exec } = landWorld({});
      const base = {
        exec,
        repo: REPO,
        base: BASE,
        commit: COMMIT,
        tag: TAG,
        sha: NEW_SHA,
      };
      expect(() => stage({ ...base, tag: "latest" })).toThrow("vX.Y.Z");
      expect(() => stage({ ...base, commit: "abc" })).toThrow("--commit");
      expect(() => stage({ ...base, sha: "" })).toThrow("--sha");
    });
  });

  describe("landBranch", () => {
    it("green on the exact sha, main still its parent: fast-forwards main, never with force, then drops the branch", () => {
      const w = landWorld({});
      expect(w.one()).toEqual({ action: "landed", sha: COMMIT });
      expect(writes(w.calls)).toEqual([
        [
          "api",
          "-X",
          "PATCH",
          `repos/${REPO}/git/refs/heads/main`,
          "-f",
          `sha=${COMMIT}`,
          "-F",
          "force=false",
        ],
        ["api", "-X", "DELETE", `repos/${REPO}/git/refs/heads/${BRANCH}`],
      ]);
      // every read goes through the read token, every write through the App's
      for (const c of w.calls)
        expect(c.by).toBe(c.args[1] === "-X" ? "write" : "read");
      // ci.yml's push run on this branch at this sha, its jobs against main's ruleset
      const paths = w.calls.map((c) => c.args.join(" "));
      expect(
        paths.some((p) => p.includes(`repos/${REPO}/rules/branches/main`)),
      ).toBe(true);
      expect(
        paths.some((p) =>
          p.includes(
            `repos/${REPO}/actions/workflows/ci.yml/runs?event=push&branch=pin-land%2Fv0.137.0&head_sha=${COMMIT}`,
          ),
        ),
      ).toBe(true);
      expect(
        paths.some((p) =>
          p.includes(`repos/${REPO}/actions/runs/${RUN}/jobs?filter=latest`),
        ),
      ).toBe(true);
      // check names on the sha are not the evidence any more
      expect(paths.some((p) => p.includes("check-runs"))).toBe(false);
    });

    it.each([
      ["there is no CI run yet", { runs: [] }],
      [
        "the push run is still running",
        { runs: [ciRun({ status: "in_progress", conclusion: null })] },
      ],
      [
        "the only green run on the branch and sha is a PR run (#468: every check green, lint and e2e skipped)",
        { runs: [ciRun({ event: "pull_request" })] },
      ],
      [
        "the only green push run is for another branch",
        { runs: [ciRun({ head_branch: "pin-land/v0.136.9" })] },
      ],
      [
        "the only green push run is for another sha",
        { runs: [ciRun({ head_sha: MAIN2 })] },
      ],
      [
        "the only green push run is another workflow's",
        { runs: [ciRun({ path: ".github/workflows/other.yml" })] },
      ],
      [
        "a newer push run on the same sha is still running",
        {
          runs: [
            ciRun(),
            ciRun({ id: RUN + 1, status: "queued", conclusion: null }),
          ],
        },
      ],
    ] as [string, LandWorld][])(
      "waits when %s, and writes nothing",
      (_n, o) => {
        const w = landWorld(o);
        expect(w.one()).toMatchObject({ action: "waiting" });
        expect(writes(w.calls)).toHaveLength(0);
      },
    );

    it.each(["failure", "cancelled", "timed_out"])(
      "a push run that ended %s throws, and the branch stays for a person",
      (conclusion) => {
        const w = landWorld({ runs: [ciRun({ conclusion })] });
        expect(() => w.one()).toThrow(
          `ci.yml run ${RUN} on ${BRANCH} at ${COMMIT} is ${conclusion}`,
        );
        expect(writes(w.calls)).toHaveLength(0);
      },
    );

    it("the newest push run on the sha decides: an older green one does not count", () => {
      const w = landWorld({
        runs: [ciRun(), ciRun({ id: RUN + 1, conclusion: "failure" })],
      });
      expect(() => w.one()).toThrow(`run ${RUN + 1}`);
      expect(writes(w.calls)).toHaveLength(0);
      const ok = landWorld({
        runs: [ciRun({ id: RUN + 1 }), ciRun({ conclusion: "failure" })],
      });
      expect(ok.one()).toEqual({ action: "landed", sha: COMMIT });
    });

    it.each([
      [
        "a required job was skipped",
        [
          job("scripts"),
          job("overlay"),
          job("lint", { conclusion: "skipped" }),
        ],
        "required job lint is skipped",
      ],
      [
        "a required job failed",
        [
          job("scripts"),
          job("overlay"),
          job("lint", { conclusion: "failure" }),
        ],
        "required job lint is failure",
      ],
      [
        "a required job is not in the run",
        [job("scripts"), job("overlay")],
        "required job lint is missing",
      ],
      [
        "a required job took the pin-only short path",
        [job("scripts"), job("overlay"), job("lint", { short: true })],
        "job lint in ci.yml run 7",
      ],
      [
        "a job behind a required one took the pin-only short path",
        [...REQUIRED.map((n) => job(n)), job("overlay (a)", { short: true })],
        "pin-only short path",
      ],
    ] as [string, ReturnType<typeof job>[], string][])(
      "a passed run where %s throws, and moves nothing",
      (_n, jobs, msg) => {
        const w = landWorld({ jobs: { [RUN]: jobs } });
        expect(() => w.one()).toThrow(msg);
        expect(writes(w.calls)).toHaveLength(0);
      },
    );

    it("fails closed when main's required checks cannot be read", () => {
      const w = landWorld({ required: [] });
      expect(() => w.one()).toThrow("required checks could not be read");
      expect(writes(w.calls)).toHaveLength(0);
    });

    it.each([
      ["another author", { author: "someone" }],
      ["an unverified commit", { verified: false }],
      ["another committer", { committer: "someone" }],
    ] as [string, LandWorld][])(
      "refuses %s, and leaves the branch",
      (_n, o) => {
        const w = landWorld(o);
        expect(() => w.one()).toThrow("verified commit");
        expect(writes(w.calls)).toHaveLength(0);
      },
    );

    it.each([
      [
        "a surfaces-port file (pin-bump-arm leaves that for a person)",
        {
          files: [
            mod("PUBLIC_PIN"),
            mod("SYNCED_FROM"),
            mod("tests/redline/live/manifest.json"),
          ],
        },
        "land without a person",
      ],
      [
        "any other path",
        { files: [mod("PUBLIC_PIN"), mod("SYNCED_FROM"), mod("apps/x/a.ts")] },
        "land without a person",
      ],
      [
        "no SYNCED_FROM change",
        { files: [mod("PUBLIC_PIN")] },
        "does not change SYNCED_FROM",
      ],
      ["two parents", { parents: [BASE, MAIN2] }, "not one"],
      [
        "a SYNCED_FROM for another sha than the public tag's",
        { syncedText: pinAt(TAG, OLD_SHA) },
        "not v0.137.0",
      ],
    ] as [string, LandWorld, string][])("refuses %s", (_n, o, msg) => {
      const w = landWorld(o);
      expect(() => w.one()).toThrow(msg);
      expect(writes(w.calls)).toHaveLength(0);
    });

    describe("the release pipeline gate (pin-bump-arm's gateRefusal)", () => {
      it.each([
        ["a gate workflow is busy", { busy: ["prod-release-chain.yml"] }],
        ["main's pin is not on prod yet", { deployed: [] }],
      ] as [string, GateWorld][])(
        "waits when %s, green or not, and writes nothing",
        (_n, gate) => {
          const w = landWorld({ gate });
          const r = w.one();
          expect(r).toMatchObject({ action: "waiting" });
          expect(r.action === "waiting" && r.why).toContain("candidate open");
          expect(writes(w.calls)).toHaveLength(0);
        },
      );

      it("a moved main is not rebuilt while the gate is shut", () => {
        const w = landWorld({
          mains: [MAIN2],
          gate: { busy: ["hosted-publish.yml"] },
        });
        expect(w.one()).toMatchObject({ action: "waiting" });
        expect(writes(w.calls)).toHaveLength(0);
      });

      it("main's pin dead before the gate (hosted-release failed with its retry spent) lands", () => {
        const w = landWorld({
          gate: {
            deployed: [],
            stageRuns: {
              "hosted-release.yml": [
                { s: "completed", c: "failure", a: 3, t: "hosted-release" },
              ],
            },
          },
        });
        expect(w.one()).toEqual({ action: "landed", sha: COMMIT });
        expect(mainMoves(w.calls)).toHaveLength(1);
      });

      it("a hosted-release still running for main's pin keeps the lander waiting", () => {
        const w = landWorld({
          gate: {
            deployed: [],
            stageRuns: {
              "hosted-release.yml": [
                { s: "in_progress", c: null, a: 1, t: "hosted-release" },
              ],
            },
          },
        });
        expect(w.one()).toMatchObject({ action: "waiting" });
        expect(writes(w.calls)).toHaveLength(0);
      });

      it("main's pin rejected after its retry (#449) lands", () => {
        const w = landWorld({
          gate: {
            deployed: [],
            gateRuns: [{ t: "redline-staging v0.136.1", c: "failure", a: 2 }],
          },
        });
        expect(w.one()).toEqual({ action: "landed", sha: COMMIT });
        expect(mainMoves(w.calls)).toHaveLength(1);
      });

      it("reads the gate with the read token, on main's current pin", () => {
        const w = landWorld({});
        expect(w.one()).toMatchObject({ action: "landed" });
        const gate = w.calls.filter((c) =>
          c.args.some((a) => a.includes("/actions/workflows/")),
        );
        expect(gate.length).toBeGreaterThan(0);
        for (const c of gate) expect(c.by).toBe("read");
      });

      it("a gate that cannot be read throws, and moves nothing", () => {
        const w = landWorld({ gate: { fail: true } });
        expect(() => w.one()).toThrow("404");
        expect(writes(w.calls)).toHaveLength(0);
      });
    });

    describe("a branch the land App rebuilt", () => {
      const LAND_BOT = "oa-pin-land[bot]";
      it("its own verified commit lands", () => {
        const w = landWorld({ author: LAND_BOT, landBot: LAND_BOT });
        expect(w.one()).toEqual({ action: "landed", sha: COMMIT });
      });

      it.each([
        ["no land bot is named", { author: LAND_BOT }],
        [
          "the land bot is another",
          { author: LAND_BOT, landBot: "other[bot]" },
        ],
        [
          "it is unverified",
          { author: LAND_BOT, landBot: LAND_BOT, verified: false },
        ],
        [
          "another committer",
          { author: LAND_BOT, landBot: LAND_BOT, committer: "someone" },
        ],
        ["the land bot is not a bot login", { author: "x", landBot: "x" }],
      ] as [string, LandWorld][])("refuses it when %s", (_n, o) => {
        const w = landWorld(o);
        expect(() => w.one()).toThrow("verified commit");
        expect(writes(w.calls)).toHaveLength(0);
      });
    });

    it("main already at this pin or newer: drops the branch, moves nothing", () => {
      for (const mainPin of [pinAt(TAG, NEW_SHA), pinAt("v0.138.0", NEW_SHA)]) {
        const w = landWorld({ mainPin });
        expect(w.one()).toMatchObject({ action: "already" });
        expect(writes(w.calls).map((a) => a[2])).toEqual(["DELETE"]);
      }
    });

    it("a main moved on unrelated paths: the same blobs on main's head go back to the branch for CI, main does not move", () => {
      const files = [
        mod("PUBLIC_PIN"),
        mod("SYNCED_FROM"),
        mod("pnpm-lock.yaml"),
      ];
      const w = landWorld({
        mains: [MAIN2],
        files,
        createRef: "gh: Reference already exists (HTTP 422)",
      });
      expect(w.one()).toMatchObject({ action: "retest", sha: REBUILT });
      expect(w.bodies[0]).toEqual({
        base_tree: "2".repeat(40),
        tree: files.map((f) => ({
          path: f.filename,
          mode: "100644",
          type: "blob",
          sha: f.sha,
        })),
      });
      expect(w.bodies[1]).toEqual({
        message: `chore(pin): bump PUBLIC_PIN to ${TAG}`,
        tree: "3".repeat(40),
        parents: [MAIN2],
      });
      expect(mainMoves(w.calls)).toHaveLength(0);
      const moved = writes(w.calls).find(
        (a) => a[2] === "PATCH" && a[3]?.endsWith(BRANCH),
      );
      expect(moved).toContain(`sha=${REBUILT}`);
    });

    it.each([
      "package.json",
      "packages/provision/package.json",
      "pnpm-lock.yaml",
      "SYNCED_FROM",
      "private-paths.txt",
      "tests/redline/src/regen.ts",
    ])(
      "a main moved under %s: drops the branch and throws, so the next run regenerates",
      (f) => {
        const w = landWorld({ mains: [MAIN2], moved: { files: [f] } });
        expect(() => w.one()).toThrow("lockfile-sensitive");
        expect(writes(w.calls).map((a) => a[2])).toEqual(["DELETE"]);
      },
    );

    it("a main that is not ahead of the parent is refused", () => {
      const w = landWorld({
        mains: [MAIN2],
        moved: { status: "diverged", behind_by: 1 },
      });
      expect(() => w.one()).toThrow("not ahead");
      expect(mainMoves(w.calls)).toHaveLength(0);
    });

    const NFF = "gh: Update is not a fast forward (HTTP 422)";

    it("a lost race to main rebuilds on the new main for CI, and lands nothing untested", () => {
      const w = landWorld({
        mains: [BASE, MAIN2],
        patches: [NFF],
        createRef: "gh: Reference already exists (HTTP 422)",
      });
      expect(w.one()).toMatchObject({ action: "retest", sha: REBUILT });
      expect(mainMoves(w.calls)).toHaveLength(1);
    });

    it("any other refusal of the main update throws", () => {
      const w = landWorld({
        patches: ["gh: Repository rule violations found (HTTP 422)"],
      });
      expect(() => w.one()).toThrow("rule violations");
      expect(writes(w.calls)).toHaveLength(1);
    });

    it("a GitHub 5xx on the main update retries", () => {
      const w = landWorld({ patches: ["HTTP 502", ""] });
      expect(w.one()).toMatchObject({ action: "landed", sha: COMMIT });
      expect(mainMoves(w.calls)).toHaveLength(2);
    });

    it("refuses a branch that is not pin-land/vX.Y.Z", () => {
      const { exec, read } = landWorld({});
      expect(() =>
        landBranch({
          exec,
          read,
          repo: REPO,
          publicRepo: PUB,
          branch: "pin-land/x",
        }),
      ).toThrow("not pin-land/vX.Y.Z");
    });
  });

  describe("land", () => {
    it("takes every staged branch, and reports one's error without skipping the rest", () => {
      const w = landWorld({
        refs: [`refs/heads/pin-land/nope`, `refs/heads/${BRANCH}`],
      });
      const r = w.all();
      expect(r).toHaveLength(2);
      expect(r[0]).toMatchObject({ branch: "pin-land/nope" });
      expect(r[0]?.error).toContain("not pin-land/vX.Y.Z");
      expect(r[1]).toEqual({
        branch: BRANCH,
        result: { action: "landed", sha: COMMIT },
      });
    });

    it("nothing staged is nothing to do", () => {
      const w = landWorld({ refs: [] });
      expect(w.all()).toEqual([]);
      expect(writes(w.calls)).toHaveLength(0);
    });
  });

  describe("route", () => {
    const pr =
      (p: Partial<ReturnType<typeof plan>> = {}) =>
      () => ({
        bump: true,
        tag: TAG,
        sha: NEW_SHA,
        why: "w",
        ...p,
      });
    const never = () => {
      throw new Error("no PR plan expected");
    };
    const planned = { branch: branchOf(TAG), supersede: 5 };

    it("off: the PR path with the plan's own branch and supersede, planned once", () => {
      for (const surfacesChanged of [true, false])
        expect(
          route({
            direct: false,
            surfacesChanged,
            tag: TAG,
            planned,
            prPlan: never,
          }),
        ).toMatchObject({
          route: "pr",
          pr: true,
          branch: branchOf(TAG),
          supersede: 5,
        });
    });

    it("on, with an empty surfaces port: direct", () => {
      expect(
        route({
          direct: true,
          surfacesChanged: false,
          tag: TAG,
          planned,
          prPlan: never,
        }),
      ).toEqual({ route: "direct" });
    });

    it("on, with a surfaces port: a PR for a person, from the PR plan", () => {
      expect(
        route({
          direct: true,
          surfacesChanged: true,
          tag: TAG,
          planned,
          prPlan: pr({ supersede: 8 }),
        }),
      ).toMatchObject({
        route: "pr",
        pr: true,
        branch: branchOf(TAG),
        supersede: 8,
      });
    });

    it("on, with a surfaces port the PR plan will not take for this tag: nothing is opened", () => {
      for (const p of [pr({ bump: false, tag: "" }), pr({ tag: "v0.138.0" })])
        expect(
          route({
            direct: true,
            surfacesChanged: true,
            tag: TAG,
            planned,
            prPlan: p,
          }),
        ).toMatchObject({ route: "pr", pr: false });
    });
  });

  it("lands only the files pin-bump-arm arms without a person", () => {
    expect(DIRECT_FILES).toEqual(ARM_PIN_FILES);
    for (const f of SURFACES_FILES) expect(DIRECT_FILES).not.toContain(f);
  });
});

describe("lockfileSensitive", () => {
  it("names the install inputs, the pin and the redline tree, and nothing else", () => {
    for (const p of [
      "package.json",
      "apps/scheduler/package.json",
      ".nvmrc",
      ".pnpmfile.cjs",
      "PUBLIC_PIN",
      "private-paths.txt",
      "scripts/overlay.sh",
      "tests/redline/live/manifest.json",
    ])
      expect(lockfileSensitive(p)).toBe(true);
    for (const p of [
      "apps/scheduler/src/fleet.ts",
      "README.md",
      ".github/workflows/ci.yml",
      "scripts/ci/private-paths.txt.bak",
    ])
      expect(lockfileSensitive(p)).toBe(false);
  });
});
