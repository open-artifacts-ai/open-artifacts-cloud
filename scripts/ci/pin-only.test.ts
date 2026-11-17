// The pin-only decision for ci.yml (run the suite once, in the merge queue): a
// pure rule over a fake git, then the same rule over a real throwaway repository.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BOT, PIN_FILES } from "./pin-bump-arm.ts";
import { changedFiles, decide, type Env, type Git } from "./pin-only.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const H = "c".repeat(40);
const entry = (path: string, status = "M", old = "100644", now = "100644") =>
  `:${old} ${now} ${H} ${H} ${status}\0${path}\0`;
const gitOut =
  (stdout: string, code = 0): Git =>
  () => ({ code, stdout });
const PIN_DIFF = PIN_FILES.map((f) => entry(f)).join("");
const env = (o: Env = {}): Env => ({
  EVENT_NAME: "pull_request",
  AUTHOR: BOT,
  HEAD_REF: "pin-bump/v0.200.0",
  HEAD_REPO: "o/r",
  REPO: "o/r",
  BASE_SHA: BASE,
  HEAD_SHA: HEAD,
  ...o,
});
const full = (e: Env, git: Git, why: RegExp) => {
  const v = decide(e, git);
  expect(v.pinOnly).toBe(false);
  expect(v.why).toMatch(why);
};

describe("decide", () => {
  it("is pin-only for the bot's bump that changes only the pin files", () => {
    expect(decide(env(), gitOut(PIN_DIFF)).pinOnly).toBe(true);
  });
  it("asks git for base...head without renames", () => {
    let args: string[] = [];
    decide(env(), (a) => {
      args = a;
      return { code: 0, stdout: PIN_DIFF };
    });
    expect(args).toContain(`${BASE}...${HEAD}`);
    expect(args).toContain("--no-renames");
  });
  it("accepts the two pin files without a lockfile change", () => {
    const d = entry("PUBLIC_PIN") + entry("SYNCED_FROM");
    expect(decide(env(), gitOut(d)).pinOnly).toBe(true);
  });
  it("is full for the wrong branch", () => {
    for (const ref of [
      "main",
      "feature/x",
      "pin-bump/",
      "pin-bump/v1.2",
      "pin-bump/v0.200.0/x",
      "xpin-bump/v0.200.0",
      "",
    ])
      full(env({ HEAD_REF: ref }), gitOut(PIN_DIFF), /branch/);
  });
  it("is full for the wrong author, including a lookalike", () => {
    for (const a of [
      "leo",
      "open-artifacts-release",
      "open-artifacts-release[bot]x",
      "Open-Artifacts-Release[bot]",
      "dependabot[bot]",
      "",
    ])
      full(env({ AUTHOR: a }), gitOut(PIN_DIFF), /author/);
    const e = env();
    delete e.AUTHOR;
    full(e, gitOut(PIN_DIFF), /author/);
  });
  it("is full for a fork or an unknown head repository", () => {
    full(env({ HEAD_REPO: "fork/r" }), gitOut(PIN_DIFF), /repository/);
    full(env({ HEAD_REPO: "" }), gitOut(PIN_DIFF), /repository/);
    full(env({ REPO: "", HEAD_REPO: "" }), gitOut(PIN_DIFF), /repository/);
  });
  it("is full when any other file changed", () => {
    for (const extra of [
      "apps/x.ts",
      "README.md",
      ".github/workflows/ci.yml",
      "scripts/ci/pin-only.ts",
      "pnpm-lock.yaml.bak",
      "sub/PUBLIC_PIN",
    ])
      full(env(), gitOut(PIN_DIFF + entry(extra)), /not pin-only/);
  });
  it("is full for a pin file that is added, deleted, renamed, copied or mode-changed", () => {
    for (const [s, o, n] of [
      ["A", "000000", "100644"],
      ["D", "100644", "000000"],
      ["T", "100644", "120000"],
      ["M", "100644", "100755"],
      ["M", "100644", "120000"],
    ] as const)
      full(
        env(),
        gitOut(entry("PUBLIC_PIN", s, o, n) + entry("SYNCED_FROM")),
        /not pin-only/,
      );
    for (const s of ["R", "C", "U", "X"])
      full(
        env(),
        gitOut(entry("PUBLIC_PIN", s) + entry("SYNCED_FROM")),
        /not pin-only/,
      );
  });
  it("is full when a pin file is renamed away (a delete plus an add)", () => {
    const d =
      entry("PUBLIC_PIN", "D", "100644", "000000") +
      entry("PUBLIC_PIN.new", "A", "000000", "100644") +
      entry("SYNCED_FROM");
    full(env(), gitOut(d), /not pin-only/);
  });
  it("is full when PUBLIC_PIN or SYNCED_FROM is not changed, or a file repeats", () => {
    full(env(), gitOut(entry("pnpm-lock.yaml")), /not changed/);
    full(
      env(),
      gitOut(entry("PUBLIC_PIN") + entry("pnpm-lock.yaml")),
      /SYNCED_FROM is not changed/,
    );
    full(
      env(),
      gitOut(entry("SYNCED_FROM") + entry("pnpm-lock.yaml")),
      /PUBLIC_PIN is not changed/,
    );
    full(env(), gitOut(PIN_DIFF + entry("PUBLIC_PIN")), /twice/);
  });
  it("is full for an empty diff", () => full(env(), gitOut(""), /empty/));
  it("is full when git fails or prints junk", () => {
    full(env(), gitOut("", 128), /error/);
    full(env(), gitOut(PIN_DIFF, 1), /error/);
    full(env(), gitOut("garbage\0"), /error/);
    full(env(), gitOut(PIN_DIFF.slice(0, -1)), /error/);
    full(env(), gitOut(":100644 100644 x x M\0PUBLIC_PIN\0"), /error/);
    full(
      env(),
      () => {
        throw new Error("spawn failed");
      },
      /spawn failed/,
    );
  });
  it("is never pin-only on any event but pull_request", () => {
    for (const ev of [
      "merge_group",
      "push",
      "workflow_dispatch",
      "pull_request_target",
      "schedule",
      "workflow_run",
      "",
      "PULL_REQUEST",
      "unknown",
    ])
      full(env({ EVENT_NAME: ev }), gitOut(PIN_DIFF), /event/);
    const e = env();
    delete e.EVENT_NAME;
    full(e, gitOut(PIN_DIFF), /event/);
  });
  it("is full for any missing or malformed variable", () => {
    for (const k of [
      "AUTHOR",
      "HEAD_REF",
      "HEAD_REPO",
      "REPO",
      "BASE_SHA",
      "HEAD_SHA",
    ]) {
      const e = env();
      delete e[k];
      expect(decide(e, gitOut(PIN_DIFF)).pinOnly).toBe(false);
      expect(decide(env({ [k]: "" }), gitOut(PIN_DIFF)).pinOnly).toBe(false);
    }
    full(env({ BASE_SHA: "main" }), gitOut(PIN_DIFF), /sha/);
    full(env({ HEAD_SHA: "B".repeat(40) }), gitOut(PIN_DIFF), /sha/);
    full(env({ HEAD_SHA: `${HEAD} --output=x` }), gitOut(PIN_DIFF), /sha/);
  });
  it("never runs git when an earlier rule already failed", () => {
    const git: Git = () => {
      throw new Error("git ran");
    };
    for (const e of [
      env({ EVENT_NAME: "push" }),
      env({ AUTHOR: "x" }),
      env({ HEAD_REF: "x" }),
    ])
      expect(decide(e, git).why).not.toMatch(/git ran/);
  });
  it("uses the same bot and file set as pin-bump-arm", () => {
    expect(BOT).toBe("open-artifacts-release[bot]");
    expect(PIN_FILES).toEqual(["PUBLIC_PIN", "SYNCED_FROM", "pnpm-lock.yaml"]);
  });
});

// The real `git diff --raw -z` output, in a throwaway repository.
describe("against real git", () => {
  const dir = mkdtempSync(join(tmpdir(), "pin-only-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const real: Git = (a) => {
    const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout };
  };
  const w = (f: string, s: string) => {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), s);
  };
  const commit = (m: string) => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", m);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  for (const f of PIN_FILES) w(f, "one\n");
  w("README.md", "r\n");
  const base = commit("base");
  const bump = (files: string[]) => {
    git("checkout", "-q", "-B", "b", base);
    for (const f of files) w(f, `${Math.random()}\n`);
    return commit("bump");
  };
  const check = (head: string, ev: Env = {}) =>
    decide(env({ BASE_SHA: base, HEAD_SHA: head, ...ev }), real);

  it("passes a bump of the three pin files, and of the two", () => {
    expect(check(bump(PIN_FILES)).pinOnly).toBe(true);
    expect(check(bump(["PUBLIC_PIN", "SYNCED_FROM"])).pinOnly).toBe(true);
  });
  it("lists changes by path, with modes", () => {
    const head = bump(["PUBLIC_PIN"]);
    expect(changedFiles(real, base, head)).toEqual([
      { path: "PUBLIC_PIN", status: "M", old: "100644", now: "100644" },
    ]);
  });
  it("uses the merge base: a moved base does not add files to the diff", () => {
    const head = bump(PIN_FILES);
    git("checkout", "-q", "-B", "main", base);
    w("README.md", "moved\n");
    const moved = commit("main moved");
    const v = decide(env({ BASE_SHA: moved, HEAD_SHA: head }), real);
    expect(v.pinOnly).toBe(true);
  });
  it("is full with an extra or deleted or renamed pin file, or a symlink", () => {
    expect(check(bump([...PIN_FILES, "README.md"])).pinOnly).toBe(false);
    let head = bump(PIN_FILES);
    unlinkSync(join(dir, "pnpm-lock.yaml"));
    head = commit("delete lock");
    expect(check(head).pinOnly).toBe(false);
    bump(PIN_FILES);
    renameSync(join(dir, "pnpm-lock.yaml"), join(dir, "lock.new"));
    head = commit("rename lock");
    expect(check(head).why).toMatch(/pnpm-lock.yaml \(D\)|lock.new/);
    expect(check(head).pinOnly).toBe(false);
    bump(PIN_FILES);
    unlinkSync(join(dir, "SYNCED_FROM"));
    symlinkSync("PUBLIC_PIN", join(dir, "SYNCED_FROM"));
    head = commit("symlink");
    expect(check(head).pinOnly).toBe(false);
  });
  it("is full when the commits are not in the repository", () => {
    expect(check("d".repeat(40)).pinOnly).toBe(false);
  });
  it("is full for a pin-only diff on a non-pull_request event", () => {
    const head = bump(PIN_FILES);
    expect(check(head, { EVENT_NAME: "merge_group" }).pinOnly).toBe(false);
  });
});
