// The overlay workspace-reads check (#17, #135), against a throwaway git repo:
// public's packages are tracked, cloud's are not, as in the overlay.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { listed } from "./workspace-reads-overlay.ts";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "workspace-reads-overlay.ts",
);
const PUBLIC_KNOWN = "scripts/ci/workspace-reads-known.txt";
const CLOUD_KNOWN = "scripts/audit/workspace-reads-overlay-known.txt";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const pkg = (name: string) => JSON.stringify({ name, private: true });

/**
 * packages/pub is public (tracked); apps/hosted is cloud (untracked) and reads
 * packages/pub by path without declaring it.
 */
function fixture(known: { pub?: string; cloud?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wr-overlay-"));
  dirs.push(root);
  put(root, "packages/pub/package.json", pkg("@oa/pub"));
  put(root, "packages/pub/src/a.ts", "export const a = 1;\n");
  put(root, "packages/pub/src/b.ts", "export const b = 1;\n");
  put(root, PUBLIC_KNOWN, known.pub ?? "");
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd: root,
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "public");
  put(root, "apps/hosted/package.json", pkg("@oa/hosted"));
  put(
    root,
    "apps/hosted/test/x.test.ts",
    'export const p = "../../../packages/pub/src/a.ts";\n',
  );
  put(root, CLOUD_KNOWN, known.cloud ?? "");
  return root;
}

const run = (root: string) => {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", SCRIPT],
    { cwd: root, encoding: "utf8" },
  );
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("workspace-reads-overlay", () => {
  it("lists an untracked file with git ls-files -co", () => {
    const root = fixture();
    const paths = listed(root).map((f) => f.path);
    expect(paths).toContain("apps/hosted/test/x.test.ts");
    expect(paths).toContain("packages/pub/src/a.ts");
  });

  it("reads the cloud list for an untracked reader and names its package", () => {
    const root = fixture({
      cloud: "apps/hosted/test/x.test.ts @oa/pub # why\n",
    });
    const r = run(root);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 cross-package read(s), 1 known");
    expect(r.out).toContain("checked cloud packages: apps/hosted");
  });

  it("merges the public and cloud lists", () => {
    const root = fixture({
      pub: "packages/pub/src/b.ts @oa/hosted\n",
      cloud: "apps/hosted/test/x.test.ts @oa/pub\n",
    });
    put(
      root,
      "packages/pub/src/b.ts",
      'export const p = "../../../apps/hosted/package.json";\n',
    );
    const r = run(root);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 cross-package read(s), 2 known");
  });

  it("exits 1 on a new read", () => {
    const root = fixture();
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.err).toContain("apps/hosted/test/x.test.ts: reads");
    expect(r.err).toContain("@oa/pub");
  });

  it("exits 1 on a stale cloud line and names the cloud file", () => {
    const root = fixture({
      cloud:
        "apps/hosted/test/x.test.ts @oa/pub\napps/hosted/test/gone.test.ts @oa/pub\n",
    });
    const r = run(root);
    expect(r.code).toBe(1);
    const stale = r.err
      .split("\n")
      .filter((l) => l.includes("gone.test.ts @oa/pub: stale"));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain(CLOUD_KNOWN);
    expect(stale[0]).not.toContain(PUBLIC_KNOWN);
  });

  it("exits 1 on a stale public line and keeps public's file name", () => {
    const root = fixture({
      pub: "packages/pub/src/gone.ts @oa/hosted\n",
      cloud: "apps/hosted/test/x.test.ts @oa/pub\n",
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.err).toContain("gone.ts @oa/hosted: stale entry");
    expect(r.err).not.toContain(CLOUD_KNOWN);
  });
});
