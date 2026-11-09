// The pin-bump PR opener: one PR for the newest public release, never a
// second, never armed, and any API error is a thrown error (a red run).
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
} from "./pin-bump.ts";

const REPO = "open-artifacts-ai/open-artifacts-cloud";
const PUB = "open-artifacts-ai/open-artifacts";
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
  open?: { number: number; headRefName: string; url: string }[];
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
  plan({ exec: world(o).exec, repo: REPO, publicRepo: PUB, pin });

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
      open: [{ number: 3, headRefName: "pin-bump/v0.136.2", url: "u3" }],
    });
    const r = plan({ exec, repo: REPO, publicRepo: PUB, pin: PIN });
    expect(r.bump).toBe(false);
    expect(r.why).toContain("u3");
    expect(calls.some((c) => c[1] === "create")).toBe(false);
  });

  it("an open PR from another branch is not a pin-bump PR", () => {
    expect(
      go({ open: [{ number: 3, headRefName: "feature/x", url: "u" }] }),
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
      open: [{ number: 8, headRefName: "pin-bump/v0.137.0", url: "u8" }],
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
  const steps: any[] = w.jobs.bump.steps;
  const step = (id: string) => steps.find((s) => s.id === id);

  it("runs on a schedule, and by dispatch", () => {
    expect(Object.keys(w.on)).toEqual(["schedule", "workflow_dispatch"]);
    expect(w.on.schedule).toHaveLength(1);
    expect(w.on.schedule[0].cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
  });

  it("grants nothing wide: the token only reads, one run at a time", () => {
    expect(w.permissions).toEqual({});
    expect(w.jobs.bump.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
    expect(w.concurrency).toEqual({
      group: "pin-bump",
      "cancel-in-progress": false,
    });
  });

  it("pins every third-party action by full SHA", () => {
    const uses = steps.map((s) => s.uses).filter(Boolean) as string[];
    expect(uses.length).toBeGreaterThan(4);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}( |$)/);
  });

  it("writes only with the release App's token, scoped to contents and PRs", () => {
    const app = step("app");
    expect(app.uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(app.with["app-id"]).toBe("${{ secrets.RELEASE_APP_ID }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    const key = "${{ secrets.RELEASE_APP_PRIVATE_KEY }}";
    expect(app.with["private-key"]).toBe(key);
    expect(app.with["permission-contents"]).toBe("write");
    expect(app.with["permission-pull-requests"]).toBe("write");
    const planStep = step("plan");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(planStep.env.GH_TOKEN).toBe("${{ github.token }}");
  });

  it("never arms or merges", () => {
    expect(text).not.toMatch(
      /gh pr merge|--auto(?![-\w])|--admin|auto-merge|enablePullRequestAutoMerge/,
    );
    expect(
      readFileSync(join(root, "scripts/ci/pin-bump.ts"), "utf8"),
    ).not.toMatch(/"merge"|--auto(?![-\w])|--admin/);
  });

  it("every step after the plan runs only when the plan says bump", () => {
    const i = steps.findIndex((s) => s.id === "plan");
    for (const s of steps.slice(i + 1))
      expect(s.if).toContain("steps.plan.outputs.bump == 'true'");
  });

  it("checks out only the pinned sha of public, with no stored credentials", () => {
    const pub = steps.find(
      (s) => s.with?.repository === "open-artifacts-ai/open-artifacts",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(pub.with.ref).toBe("${{ steps.plan.outputs.sha }}");
    expect(pub.with["persist-credentials"]).toBe(false);
  });
});
