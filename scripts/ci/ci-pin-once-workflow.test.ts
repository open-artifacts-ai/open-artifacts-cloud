// The shape of ci.yml for "pin bumps run once" (the suite runs in the merge queue
// only): the required jobs decide inside the job, keep their names, gate every
// heavy step on the decision, and the decision step really answers from the base
// commit's script. The rule itself is tested in pin-only.test.ts.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// In the overlay tree ci.yml is public's (the overlay never copies this repo's), and
// this repo's checkout sits beside it at ../private; run from this repo alone, it
// is root's own. The private one is the file with the overlay-action job.
const src = [
  join(root, "../private/.github/workflows/ci.yml"),
  join(root, ".github/workflows/ci.yml"),
]
  .filter((f) => existsSync(f))
  .map((f) => readFileSync(f, "utf8"))
  .find((t) => /^ {2}overlay-action:$/m.test(t)) as string;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const ci: any = parse(src);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
type Step = Record<string, any>;
const GATE = "steps.ro.outputs.pin_only != 'true'";
/** The jobs that carry a required check, with the checkout dir their ro step reads. */
const GATED = { overlay: "private", lint: "_cloud", e2e: "_cloud" } as const;
/** Overlay steps that stay on the PR: cheap checks of the pin files themselves. */
const STAYS = ["pin", "synced"];

const steps = (job: string): Step[] => ci.jobs[job].steps;
const roOf = (job: string): Step => {
  const s = steps(job).filter((x) => x.id === "ro");
  expect(s).toHaveLength(1);
  return s[0] as Step;
};

describe("ci.yml pin-only gating", () => {
  it("keeps every trigger, and never adds a path filter or pull_request_target", () => {
    expect(Object.keys(ci.on).sort()).toEqual(
      ["merge_group", "pull_request", "push", "workflow_dispatch"].sort(),
    );
    expect(ci.on.merge_group).toEqual({ types: ["checks_requested"] });
    expect(src).not.toMatch(/pull_request_target|^\s*paths(-ignore)?:/m);
    expect(ci.permissions).toEqual({ contents: "read" });
  });
  it("keeps the five required check names, with no job-level if", () => {
    expect(Object.keys(ci.jobs)).toEqual(
      expect.arrayContaining(["scripts", "overlay", "lint", "e2e"]),
    );
    expect(ci.jobs.e2e.strategy.matrix.app).toEqual(["provisioning", "admin"]);
    expect(ci.jobs.e2e.name).toBeUndefined();
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    for (const [name, job] of Object.entries(ci.jobs))
      expect(
        (job as any).if,
        `${name} must not have a job-level if`,
      ).toBeUndefined();
  });
  for (const [job, dir] of Object.entries(GATED)) {
    describe(job, () => {
      it("decides in the job, after its first checkout and a pinned setup-node, with the full history", () => {
        const s = steps(job);
        const at = s.findIndex((x) => x.id === "ro");
        expect(at).toBe(2);
        expect(s[0]?.uses).toMatch(/^actions\/checkout@/);
        expect(s[0]?.with["fetch-depth"]).toBe(0);
        // Node 22.6+ is needed for --experimental-strip-types: a pinned setup-node,
        // from this repo's own .nvmrc, with no pnpm cache, comes first.
        expect(s[1]?.uses).toBe(
          "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
        );
        expect(s[1]?.with).toEqual({ "node-version-file": `${dir}/.nvmrc` });
        expect(s[1]?.if).toBeUndefined();
        expect(s[0]?.with["persist-credentials"]).toBe(false);
        expect(roOf(job)["working-directory"]).toBe(dir);
        expect(roOf(job)["continue-on-error"]).toBe(true);
      });
      it("gives the decision only data, through env, never through the script text", () => {
        const ro = roOf(job);
        expect(Object.keys(ro.env).sort()).toEqual(
          [
            "AUTHOR",
            "BASE_SHA",
            "EVENT_NAME",
            "HEAD_REF",
            "HEAD_REPO",
            "HEAD_SHA",
            "REPO",
          ].sort(),
        );
        expect(ro.run).not.toContain("${{");
        expect(ro.env.BASE_SHA).toBe(
          "${{ github.event.pull_request.base.sha }}",
        );
        expect(ro.env.AUTHOR).toBe(
          "${{ github.event.pull_request.user.login }}",
        );
      });
      it("runs the base commit's script, never the checkout's own copy", () => {
        const run: string = roOf(job).run;
        expect(run).toContain('git show "$BASE_SHA:scripts/ci/$f.ts"');
        expect(run).toContain("for f in pin-only pin-bump-arm pin-bump; do");
        expect(run).toContain('"$d/pin-only.ts"');
        expect(run).not.toMatch(
          /(private|_cloud)\/scripts|\.\/scripts|scripts\/ci\/pin-only\.ts"? *\)/,
        );
        expect(run).toContain('[ "$out" = "pin-only" ]');
      });
      it("prints the one clear line when it skips", () => {
        const msg = steps(job).find((x) => x.name === "pin-only bot PR");
        expect(msg?.if).toBe("${{ steps.ro.outputs.pin_only == 'true' }}");
        expect(msg?.run).toBe(
          'echo "pin-only bot PR - the merge queue runs this job in full"',
        );
      });
      it("gates every other step after it, except the cheap pin checks", () => {
        const s = steps(job);
        const from = s.findIndex((x) => x.id === "ro") + 2;
        for (const x of s.slice(from)) {
          const label = x.name ?? x.uses ?? x.run ?? x.id;
          if (STAYS.includes(x.id)) {
            expect(job, label).toBe("overlay");
            expect(x.if, label).toBeUndefined();
            continue;
          }
          expect(String(x.if), `${job}: ${label}`).toMatch(
            new RegExp(
              `^\\$\\{\\{ ${GATE.replace(/[.']/g, (c) => `\\${c}`)}( && .+)? \\}\\}$`,
            ),
          );
        }
      });
    });
  }
  it("keeps the pin read and SYNCED_FROM read on the PR, ahead of every gated step", () => {
    const ids = steps("overlay").map((x) => x.id);
    expect(ids.indexOf("pin")).toBeGreaterThan(ids.indexOf("ro"));
    expect(ids.indexOf("synced")).toBeGreaterThan(ids.indexOf("pin"));
    expect(steps("overlay").find((x) => x.id === "pin")?.run).toContain(
      "is not vX.Y.Z",
    );
  });
  it("runs the three decision steps identically", () => {
    const text = (j: string) =>
      JSON.stringify({ ...roOf(j), "working-directory": 0 });
    expect(text("lint")).toBe(text("overlay"));
    expect(text("e2e")).toBe(text("overlay"));
  });
  it("leaves the scripts and overlay-action jobs alone", () => {
    for (const j of ["scripts", "overlay-action"]) {
      expect(steps(j).some((x) => x.id === "ro")).toBe(false);
      expect(
        steps(j).some((x) => String(x.if ?? "").includes("pin_only")),
      ).toBe(false);
    }
  });
});

// The decision step, run for real: bash on its run text, in a throwaway repository
// whose BASE commit holds the scripts.
describe("the decision step, run as written", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ci-pin-once-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const BOT = "open-artifacts-release[bot]";
  const git = (dir: string, ...a: string[]) => {
    const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const commit = (dir: string, m: string) => {
    git(dir, "add", "-A");
    git(
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "-m",
      m,
    );
    return git(dir, "rev-parse", "HEAD");
  };
  const mk = (name: string, withScripts: boolean) => {
    const dir = join(tmp, name);
    mkdirSync(join(dir, "scripts/ci"), { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    if (withScripts)
      for (const f of ["pin-only", "pin-bump-arm", "pin-bump"])
        copyFileSync(
          join(root, `scripts/ci/${f}.ts`),
          join(dir, `scripts/ci/${f}.ts`),
        );
    for (const f of [
      "PUBLIC_PIN",
      "SYNCED_FROM",
      "pnpm-lock.yaml",
      "README.md",
    ])
      writeFileSync(join(dir, f), "one\n");
    const base = commit(dir, "base");
    return { dir, base };
  };
  const bump = (dir: string, files: string[]) => {
    for (const f of files) writeFileSync(join(dir, f), `${f} two\n`);
    return commit(dir, "bump");
  };
  const decide = (
    dir: string,
    base: string,
    head: string,
    o: Record<string, string> = {},
  ) => {
    const out = join(dir, "..", `out-${Math.random()}`);
    writeFileSync(out, "");
    const r = spawnSync("bash", ["-c", roOf("overlay").run], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
        HOME: tmp,
        RUNNER_TEMP: tmp,
        GITHUB_OUTPUT: out,
        EVENT_NAME: "pull_request",
        AUTHOR: BOT,
        HEAD_REF: "pin-bump/v0.200.0",
        HEAD_REPO: "o/r",
        REPO: "o/r",
        BASE_SHA: base,
        HEAD_SHA: head,
        ...o,
      },
    });
    expect(r.status).toBe(0);
    log = r.stdout + r.stderr;
    return readFileSync(out, "utf8").trim();
  };
  let log = "";
  const PINS = ["PUBLIC_PIN", "SYNCED_FROM", "pnpm-lock.yaml"];

  it("says pin_only=true for the bot's bump of the pin files", () => {
    const { dir, base } = mk("ok", true);
    const head = bump(dir, PINS);
    expect(decide(dir, base, head)).toBe("pin_only=true");
    expect(log).toContain("pin-only: yes");
    expect(log).not.toContain("full run");
  });
  it("says false on every event but pull_request", () => {
    const { dir, base } = mk("events", true);
    const head = bump(dir, PINS);
    for (const ev of ["merge_group", "push", "workflow_dispatch"])
      expect(decide(dir, base, head, { EVENT_NAME: ev })).toBe(
        "pin_only=false",
      );
  });
  it("says false for another author, another branch, or an extra file", () => {
    const { dir, base } = mk("no", true);
    const head = bump(dir, PINS);
    expect(decide(dir, base, head, { AUTHOR: "leo" })).toBe("pin_only=false");
    // A silent fallback is visible: the script's own reason is in the log.
    expect(log).toContain("pin-only: no: author is leo");
    expect(log).toContain("full run: the decision did not answer pin-only");
    expect(decide(dir, base, head, { HEAD_REF: "feature/x" })).toBe(
      "pin_only=false",
    );
    const more = bump(dir, [...PINS, "README.md"]);
    expect(decide(dir, base, more)).toBe("pin_only=false");
  });
  it("says false when the base commit has no decision script (this very PR)", () => {
    const { dir, base } = mk("noscript", false);
    const head = bump(dir, PINS);
    expect(decide(dir, base, head)).toBe("pin_only=false");
    expect(log).toContain(
      "full run: the base commit has no scripts/ci/pin-only.ts",
    );
  });
  it("says false when the base sha is missing or unknown", () => {
    const { dir, base } = mk("nobase", true);
    const head = bump(dir, PINS);
    expect(decide(dir, "", head)).toBe("pin_only=false");
    expect(decide(dir, "d".repeat(40), head)).toBe("pin_only=false");
    expect(decide(dir, base, "")).toBe("pin_only=false");
  });
  it("uses the base's script, not the head's: a head that rewrites it to say yes still gets false", () => {
    const { dir, base } = mk("tamper", true);
    writeFileSync(
      join(dir, "scripts/ci/pin-only.ts"),
      'console.log("pin-only");\n',
    );
    const head = bump(dir, [...PINS, "scripts/ci/pin-only.ts"]);
    expect(decide(dir, base, head)).toBe("pin_only=false");
  });
});
