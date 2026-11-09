// The pin-bump PR opener: one PR for the newest public release, never a
// second, never armed, and any API error is a thrown error (a red run).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  applyPin,
  branchOf,
  compareTags,
  type Exec,
  openPr,
  plan,
  rewritePin,
  STALE_PR_MS,
} from "./pin-bump.ts";

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
    expect(jobs.prepare.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
    expect(jobs.open.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
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

  it("prepare sends out only the lockfile", () => {
    const ups = stepsOf("prepare").filter((s) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(ups).toHaveLength(1);
    expect(ups[0].with.path).toMatch(/\/pnpm-lock\.yaml$/);
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
