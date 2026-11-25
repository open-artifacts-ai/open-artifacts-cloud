// The pin-bump PR opener: one PR for the newest public release, never a
// second, never armed, and any API error is a thrown error (a red run).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { sleeper } from "./gh-retry.ts";
import {
  applyPin,
  branchOf,
  compareTags,
  type Exec,
  LAND_ATTEMPTS,
  land,
  lockfileSensitive,
  openPr,
  plan,
  planDirect,
  rewritePin,
  STALE_PR_MS,
} from "./pin-bump.ts";

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
  /** gh pr view's answer for the open PR (#425). */
  view?: {
    state?: string;
    autoMergeRequest?: unknown;
    statusCheckRollup?: { conclusion?: string; state?: string }[];
  };
}) => {
  const calls: string[][] = [];
  const exec: Exec = (_c, args) => {
    calls.push(args);
    const line = args.join(" ");
    if (o.failApi && line.includes(o.failApi))
      return { code: 1, stdout: "", stderr: "HTTP 502" };
    const json = (v: unknown) => ({
      code: 0,
      stdout: JSON.stringify(v),
      stderr: "",
    });
    if (args[0] === "api" && args[1]?.includes("/releases?"))
      return json(o.releases ?? [rel("v0.137.0"), rel("v0.136.1")]);
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

  it("runs on a schedule, and by dispatch, from main only", () => {
    expect(Object.keys(w.on)).toEqual(["schedule", "workflow_dispatch"]);
    expect(w.on.schedule).toHaveLength(1);
    expect(w.on.schedule[0].cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
    for (const j of ["prepare", "open", "report"])
      expect(jobs[j].if).toContain(MAIN);
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
    expect(w.concurrency).toEqual({
      group: "pin-bump",
      "cancel-in-progress": false,
    });
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
    const evalExpr = (expr: string, direct: string | null) =>
      new Function(
        "vars",
        "steps",
        `return ${String(expr)
          .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
          .replaceAll("vars.PIN_BUMP_DIRECT", "vars.direct")};`,
      )({ direct }, { plan: { outputs: { bump: "true" } } });
    const runs = (direct: string | null) =>
      stepsOf("open")
        .filter((s) => !s.if || evalExpr(s.if, direct))
        .map((s) => s.name ?? s.id ?? s.uses);

    it("unset (or not exactly on), the steps and the plan are today's", () => {
      for (const v of [null, "", "off", "ON"]) {
        const names = runs(v);
        expect(names).toContain("Push the branch");
        expect(names).toContain("Open the PR (never armed)");
        expect(names).not.toContain("Land the pin on main (direct mode)");
        for (const j of ["prepare", "open"])
          expect(evalExpr(step(j, "plan").env.MODE, v)).toBe("plan");
      }
    });

    it("on, it lands on main and never pushes a branch or opens a PR", () => {
      const names = runs("on");
      expect(names).not.toContain("Push the branch");
      expect(names).not.toContain("Open the PR (never armed)");
      expect(names).toContain("Land the pin on main (direct mode)");
      for (const j of ["prepare", "open"])
        expect(evalExpr(step(j, "plan").env.MODE, "on")).toBe("plan-direct");
    });

    it("lands with the App token, after the commit, with the plan's tag and sha", () => {
      const open = stepsOf("open");
      const l = open.find(
        (s) => s.name === "Land the pin on main (direct mode)",
      );
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
        'node --experimental-strip-types scripts/ci/pin-bump.ts land --repo "$GITHUB_REPOSITORY" --base "$BASE" --commit "$COMMIT" --tag "$TAG" --sha "$SHA"',
      );
      expect(open.indexOf(l)).toBeGreaterThan(
        open.findIndex((s) => s.id === "commit"),
      );
      // The only steps that see the App token are the open job's own.
      const tokened = Object.entries(jobs).filter(([, j]) =>
        // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
        JSON.stringify((j as any).steps).includes("steps.app.outputs.token"),
      );
      expect(tokened.map(([k]) => k)).toEqual(["open"]);
      expect(jobs.open.environment).toBe("release-app");
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
    const result = (prepare: string, open: string) => {
      const expr = String(rep[0].env.RESULT)
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .replaceAll("needs.prepare.result", "prepare")
        .replaceAll("needs.open.result", "open");
      return new Function("prepare", "open", `return ${expr};`)(prepare, open);
    };

    it("anything but success is red; an open skipped for no bump is green", () => {
      expect(result("success", "success")).toBe("success");
      expect(result("success", "skipped")).toBe("success");
      expect(result("success", "failure")).toBe("failure");
      expect(result("success", "cancelled")).toBe("failure");
      expect(result("failure", "skipped")).toBe("failure");
      // a prepare past its timeout is reported cancelled, so it files an issue
      expect(result("cancelled", "skipped")).toBe("failure");
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
    return { r: planDirect({ exec: w.exec, publicRepo: PUB, pin }), w };
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

describe("land", () => {
  const BASE = "b".repeat(40);
  const COMMIT = "c".repeat(40);
  const MAIN2 = "d".repeat(40);
  const REBUILT = "e".repeat(40);
  const TAG = "v0.137.0";
  const pinAt = (tag: string, sha: string) => `# pin\ntag=${tag}\nsha=${sha}\n`;
  const mod = (filename: string, status = "modified") => ({
    filename,
    status,
    sha: `${filename.length.toString(16).padStart(2, "0")}${"f".repeat(38)}`,
  });
  type LandWorld = {
    parents?: string[];
    files?: { filename: string; status: string; sha: string }[];
    ahead?: number;
    pinText?: string;
    syncedText?: string;
    /** main's sha, read by read; the last one repeats. */
    mains?: string[];
    mainPin?: string;
    moved?: { status?: string; behind_by?: number; files?: string[] };
    /** stderr of each PATCH in turn; "" is success. */
    patches?: string[];
  };
  const landWorld = (o: LandWorld) => {
    const calls: string[][] = [];
    const bodies: unknown[] = [];
    let reads = 0;
    let patch = 0;
    const exec: Exec = (_c, args) => {
      calls.push(args);
      const ok = (v: unknown) => ({
        code: 0,
        stdout: typeof v === "string" ? v : JSON.stringify(v),
        stderr: "",
      });
      const path = args[1] === "-X" ? (args[3] ?? "") : (args[1] ?? "");
      if (args[1] === "-X" && args[2] === "PATCH") {
        const err = o.patches?.[patch++] ?? "";
        return err
          ? { code: 1, stdout: "", stderr: err }
          : ok({ object: { sha: "x" } });
      }
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
      if (path.endsWith("git/ref/heads/main")) {
        const m = o.mains ?? [BASE];
        return ok(`${m[Math.min(reads++, m.length - 1)]}\n`);
      }
      if (path.includes("contents/PUBLIC_PIN?ref=") && !path.endsWith(COMMIT))
        return ok(o.mainPin ?? PIN);
      if (path.endsWith(`contents/PUBLIC_PIN?ref=${COMMIT}`))
        return ok(o.pinText ?? pinAt(TAG, NEW_SHA));
      if (path.endsWith(`contents/SYNCED_FROM?ref=${COMMIT}`))
        return ok(o.syncedText ?? pinAt(TAG, NEW_SHA));
      if (path.endsWith("git/trees") || path.endsWith("git/commits")) {
        const i = args.indexOf("--input");
        bodies.push(JSON.parse(readFileSync(args[i + 1] ?? "", "utf8")));
        return ok(`${path.endsWith("git/trees") ? "3".repeat(40) : REBUILT}\n`);
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const run = () =>
      land({
        exec,
        repo: REPO,
        base: BASE,
        commit: COMMIT,
        tag: TAG,
        sha: NEW_SHA,
      });
    return { exec, calls, bodies, run };
  };
  const patches = (calls: string[][]) =>
    calls.filter((c) => c[1] === "-X" && c[2] === "PATCH");

  it("fast-forwards main when it is still the base, never with force", () => {
    const w = landWorld({});
    expect(w.run()).toEqual({ action: "landed", sha: COMMIT, rebuilt: false });
    const p = patches(w.calls);
    expect(p).toHaveLength(1);
    expect(p[0]).toEqual([
      "api",
      "-X",
      "PATCH",
      `repos/${REPO}/git/refs/heads/main`,
      "-f",
      `sha=${COMMIT}`,
      "-F",
      "force=false",
    ]);
    expect(w.calls.flat().join(" ")).not.toContain("force=true");
  });

  it("accepts the lockfile and surfaces files beside the pin files", () => {
    const w = landWorld({
      files: [
        mod("PUBLIC_PIN"),
        mod("SYNCED_FROM"),
        mod("pnpm-lock.yaml"),
        mod("tests/redline/live/manifest.json"),
        mod("tests/redline/test/cases-added.ts"),
        mod("tests/redline/test/surfaces.test.ts"),
      ],
    });
    expect(w.run()).toMatchObject({ action: "landed" });
  });

  it("a main moved on unrelated paths gets the same blobs on its own tree", () => {
    const files = [
      mod("PUBLIC_PIN"),
      mod("SYNCED_FROM"),
      mod("pnpm-lock.yaml"),
    ];
    const w = landWorld({ mains: [MAIN2], files });
    expect(w.run()).toEqual({ action: "landed", sha: REBUILT, rebuilt: true });
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
    expect(patches(w.calls)[0]).toContain(`sha=${REBUILT}`);
  });

  it.each([
    "package.json",
    "packages/provision/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "SYNCED_FROM",
    "tests/redline/src/regen.ts",
  ])("refuses a main moved under %s", (f) => {
    const w = landWorld({ mains: [MAIN2], moved: { files: [f] } });
    expect(() => w.run()).toThrow("lockfile-sensitive");
    expect(patches(w.calls)).toHaveLength(0);
  });

  it("refuses a main that is not ahead of the base", () => {
    const w = landWorld({
      mains: [MAIN2],
      moved: { status: "diverged", behind_by: 1 },
    });
    expect(() => w.run()).toThrow("not ahead");
    expect(patches(w.calls)).toHaveLength(0);
  });

  it("does nothing when main already has this pin or a newer one", () => {
    const same = landWorld({ mains: [MAIN2], mainPin: pinAt(TAG, NEW_SHA) });
    expect(same.run()).toMatchObject({ action: "already" });
    const newer = landWorld({
      mains: [MAIN2],
      mainPin: pinAt("v0.138.0", NEW_SHA),
    });
    expect(newer.run()).toMatchObject({ action: "already" });
    const at = landWorld({ mains: [COMMIT] });
    expect(at.run()).toMatchObject({ action: "already" });
    for (const w of [same, newer, at]) expect(patches(w.calls)).toHaveLength(0);
  });

  it.each([
    [
      "a seventh path",
      { files: [mod("PUBLIC_PIN"), mod("SYNCED_FROM"), mod("apps/x/a.ts")] },
      "not a pin file",
    ],
    [
      "an added pin file",
      {
        files: [
          mod("PUBLIC_PIN"),
          mod("SYNCED_FROM"),
          mod("pnpm-lock.yaml", "added"),
        ],
      },
      "is added",
    ],
    [
      "no SYNCED_FROM change",
      { files: [mod("PUBLIC_PIN")] },
      "does not change SYNCED_FROM",
    ],
    ["a parent that is not the base", { parents: [MAIN2] }, "not just"],
    ["two parents", { parents: ["b".repeat(40), MAIN2] }, "not just"],
    ["two commits ahead", { ahead: 2 }, "not one commit ahead"],
    [
      "a PUBLIC_PIN for another tag",
      { pinText: pinAt("v0.137.1", NEW_SHA) },
      "not v0.137.0",
    ],
    [
      "a SYNCED_FROM for another sha",
      { syncedText: pinAt(TAG, OLD_SHA) },
      "not v0.137.0",
    ],
  ] as [string, LandWorld, string][])("refuses %s", (_n, o, msg) => {
    const w = landWorld(o);
    expect(() => w.run()).toThrow(msg);
    expect(patches(w.calls)).toHaveLength(0);
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
    expect(() => land({ ...base, tag: "latest" })).toThrow("vX.Y.Z");
    expect(() => land({ ...base, commit: "abc" })).toThrow("--commit");
    expect(() => land({ ...base, sha: "" })).toThrow("--sha");
  });

  const NFF = "gh: Update is not a fast forward (HTTP 422)";

  it("a lost race reads main again and lands", () => {
    const w = landWorld({ mains: [BASE, MAIN2], patches: [NFF, ""] });
    expect(w.run()).toEqual({ action: "landed", sha: REBUILT, rebuilt: true });
    expect(patches(w.calls)).toHaveLength(2);
  });

  it(`${LAND_ATTEMPTS} lost races throw`, () => {
    const w = landWorld({ patches: [NFF, NFF, NFF, ""] });
    expect(() => w.run()).toThrow("fast forward");
    expect(patches(w.calls)).toHaveLength(LAND_ATTEMPTS);
  });

  it("any other refusal of the ref update throws at once", () => {
    const w = landWorld({
      patches: ["gh: Repository rule violations found (HTTP 422)", ""],
    });
    expect(() => w.run()).toThrow("rule violations");
    expect(patches(w.calls)).toHaveLength(1);
  });

  it("a GitHub 5xx on the ref update retries", () => {
    const w = landWorld({ patches: ["HTTP 502", ""] });
    expect(w.run()).toMatchObject({ action: "landed", sha: COMMIT });
    expect(patches(w.calls)).toHaveLength(2);
  });

  it("an API error on a read throws", () => {
    const w = landWorld({});
    const exec: Exec = (c, a) =>
      a.join(" ").includes("compare/")
        ? { code: 1, stdout: "", stderr: "HTTP 404" }
        : w.exec(c, a);
    expect(() =>
      land({
        exec,
        repo: REPO,
        base: BASE,
        commit: COMMIT,
        tag: TAG,
        sha: NEW_SHA,
      }),
    ).toThrow("404");
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
      "scripts/overlay.sh",
      "tests/redline/live/manifest.json",
    ])
      expect(lockfileSensitive(p)).toBe(true);
    for (const p of [
      "apps/scheduler/src/fleet.ts",
      "README.md",
      ".github/workflows/ci.yml",
    ])
      expect(lockfileSensitive(p)).toBe(false);
  });
});
