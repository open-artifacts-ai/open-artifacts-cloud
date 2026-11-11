// T3b: the hosted release jobs in this repo's hosted-release.yml (mirror,
// guard, build, check, sign and attach per env) and hosted-floor.yml. They
// never read the public repo's release-please.yml or ci.yml: those are public's
// files, and the hosted jobs are gone from them after the split (#1056 F1). The signing key never
// shares a job with installed code.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const fw: any = parse(read(".github/workflows/hosted-floor.yml"));
const ENVS = ["staging", "prod"] as const;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
type Step = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const stepsOf = (wf: any, job: string): Step[] => wf.jobs[job].steps;
const runOf = (st: Step[]) => st.map((s) => s.run ?? "").join("\n");
const APP_TOKEN =
  "actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349";
const SHA_PIN =
  /^(actions\/(checkout|download-artifact|upload-artifact|setup-node|create-github-app-token)|pnpm\/action-setup)@[0-9a-f]{40}$/;
// Any invocation (the lockfile path "pnpm-lock.yaml" is not one).
const INSTALL = /(^|[\s;|&(`])(pnpm|npm|npx|corepack|yarn)(?=$|[\s;|&)`])/m;

// The v22 assert step, verbatim (H-N22).
const NODE22_ASSERT =
  'v=$(node --version); case "$v" in v22.*) ;; *) echo "expected Node 22, got $v" >&2; exit 1;; esac';

/**
 * Decision 4 (Manager's security review, fix round 2), H-N22: a key job runs
 * ONLY checkout, setup-node (Node 22 from .nvmrc, no cache), a v22 assert,
 * download-artifact (for sign) and the sign step, every action pinned by SHA:
 * no install, no strip-types, plain .mjs. The key and every other secret
 * appear only in the sign step's env: never job-level env or defaults.
 */
function keyJobShape(job: Step, o: { download: boolean; script: string }) {
  expect(job.env).toBeUndefined();
  expect(job.defaults).toBeUndefined();
  const st: Step[] = job.steps;
  expect(JSON.stringify({ ...job, steps: undefined })).not.toContain(
    "secrets.",
  );
  // Exact keys per step: no if, continue-on-error, shell or env sneaks in.
  expect(st.map((s) => Object.keys(s).sort().join(","))).toEqual([
    "uses,with",
    "uses,with",
    "name,run",
    ...(o.download ? ["uses,with"] : []),
    "env,id,name,run",
  ]);
  const uses = st.map((s) => s.uses).filter(Boolean) as string[];
  expect(uses.map((u) => u.split("@")[0])).toEqual([
    "actions/checkout",
    "actions/setup-node",
    ...(o.download ? ["actions/download-artifact"] : []),
  ]);
  for (const u of uses)
    expect(u).toMatch(
      /^actions\/(checkout|setup-node|download-artifact)@[0-9a-f]{40}$/,
    );
  expect(st).toHaveLength(uses.length + 2);
  expect(st[0]?.uses).toMatch(/^actions\/checkout@/);
  expect(st[0]?.with?.["persist-credentials"]).toBe(false);
  const setup = st[1] as Step;
  expect(setup.uses).toBe(
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  );
  expect(setup.with).toEqual({ "node-version-file": ".nvmrc" });
  expect(setup.env).toBeUndefined();
  expect(read(".nvmrc").trim()).toBe("22");
  const assert = st[2] as Step;
  expect(assert.uses).toBeUndefined();
  expect(assert.env).toBeUndefined();
  expect(String(assert.run).trim()).toBe(NODE22_ASSERT);
  expect(Object.keys(st[0]?.with ?? {}).sort()).toEqual([
    "persist-credentials",
    "ref",
  ]);
  if (o.download) {
    expect(st[3]?.uses).toMatch(/^actions\/download-artifact@/);
    expect(Object.keys(st[3]?.with ?? {}).sort()).toEqual(["name", "path"]);
  }
  // No cache action and no package-manager cache anywhere in the job.
  expect(JSON.stringify(st)).not.toMatch(/cache/i);
  const last = st.at(-1) as Step;
  expect(last.uses).toBeUndefined();
  for (const s of st) expect(s.run ?? "").not.toMatch(INSTALL);
  const withKey = st.filter((s) =>
    JSON.stringify(s).includes("RELEASE_SIGNING_KEY"),
  );
  expect(withKey).toEqual([last]);
  expect(last.env?.RELEASE_SIGNING_KEY).toBe(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    "${{ secrets.RELEASE_SIGNING_KEY }}",
  );
  const run = String(last.run);
  expect(run).toMatch(
    new RegExp(
      `printf '%s' "\\$RELEASE_SIGNING_KEY" \\| node scripts/ci/${o.script.replace(".", "\\.")} `,
    ),
  );
  expect(run).not.toContain("--experimental-strip-types");
  expect(run.match(/RELEASE_SIGNING_KEY/g)).toHaveLength(1);
  expect(run).not.toMatch(/set -x|set -o xtrace|--key/);
  expect(JSON.stringify(st.slice(0, -1))).not.toContain("secrets.");
  expect(JSON.stringify(last).match(/secrets\./g)).toHaveLength(1);
  expect(JSON.stringify(st)).not.toMatch(/CLOUDFLARE_/);
}

describe("hosted-floor.yml (H1)", () => {
  it("is dispatch-only with validated-shape inputs and no workflow-wide grant", () => {
    expect(Object.keys(fw.on)).toEqual(["workflow_dispatch"]);
    const inp = fw.on.workflow_dispatch.inputs;
    expect(inp.env.type).toBe("choice");
    expect(inp.env.options).toEqual(["staging", "prod"]);
    for (const k of ["seq", "min_version", "revoked"])
      expect(inp[k], k).toBeDefined();
    expect(fw.permissions).toEqual({});
  });
  it("floor-guard: main only, branch SHA, no secrets, read-only", () => {
    const job = fw.jobs["floor-guard"];
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(job)).not.toContain("secrets.");
    const run = runOf(stepsOf(fw, "floor-guard"));
    expect(run).toContain('gh api "repos/$REPO/git/ref/heads/main"');
    expect(run).not.toContain("${{");
    expect(job.outputs.sha).toMatch(/steps\.\w+\.outputs\.sha/);
  });
  it("hosted-floor: the key-job shape, environment hosted-<env>, no install", () => {
    const job = fw.jobs["hosted-floor"];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(job.environment).toBe("hosted-${{ inputs.env }}");
    expect([job.needs].flat()).toEqual(["floor-guard"]);
    expect(job.permissions).toEqual({ contents: "read" });
    const st = stepsOf(fw, "hosted-floor");
    keyJobShape(job, { download: false, script: "sign-floor.mjs" });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(st[0]?.with?.ref).toBe("${{ needs.floor-guard.outputs.sha }}");
    const run = String(st.at(-1)?.run);
    expect(run).not.toContain("${{");
    for (const f of ["--env", "--seq", "--min-version", "--revoked"])
      expect(run).toContain(f);
    expect(Object.keys(job.outputs).sort()).toEqual([
      "floor_record_sha256",
      "floor_signature",
    ]);
  });
  it("hosted-floor-upload: no key, rebuilds with --assemble, uploads a workflow artifact, never a release asset", () => {
    const job = fw.jobs["hosted-floor-upload"];
    expect(job.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect([job.needs].flat()).toEqual(
      expect.arrayContaining(["floor-guard", "hosted-floor"]),
    );
    const st = stepsOf(fw, "hosted-floor-upload");
    for (const s of st) if (s.uses) expect(s.uses).toMatch(SHA_PIN);
    const run = runOf(st);
    expect(run).toContain("scripts/ci/sign-floor.mjs");
    expect(run).toContain("--assemble");
    expect(run).not.toContain("gh release");
    const up = st.filter((s) =>
      String(s.uses ?? "").startsWith("actions/upload-artifact"),
    );
    expect(up).toHaveLength(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(up[0]?.with?.name).toBe("floor-${{ inputs.env }}-${{ inputs.seq }}");
  });
  it("docs/ops/hosted.md names the hosted-floor job in the checklists", () => {
    const doc = read("docs/ops/hosted.md");
    const first = doc.slice(doc.indexOf("### First-create checklist"));
    expect(first).toContain("hosted-floor");
    const rev = doc.slice(doc.indexOf("### Release checklist"));
    expect(rev).toContain("hosted-floor");
  });
});

describe("the key jobs' scripts: plain .mjs, node:* only, Node 22", () => {
  const FORBIDDEN =
    /\bimport\s*\(\s*[^"'\s)]|\bcreateRequire\b|\brequire\s*\(|["']node:(child_process|module|worker_threads|vm)["']|\bprocess\.dlopen\b/;
  // APIs and syntax missing from some Node 22.x (the key jobs run any 22 from
  // .nvmrc): added after 22.0, flagged in 22, or 23+.
  const POST_22 =
    /\bprocess\.getBuiltinModule\b|\bURL\.parse\b|\bWebSocket\b|\bnode:sqlite\b|\bglob\(|\bfromBase64\b|\btoBase64\b|\bPromise\.try\b|\busing\s+\w+\s*=|\bRegExp\.escape\b|\bError\.isError\b|\bFloat16Array\b|\bimport\.meta\.main\b|\bprocess\.features\.typescript\b|\bcrc32\b|\bmatchesGlob\b|\bduplexPair\b|\bgetCallSites\b/;
  const importsOf = (src: string): string[] =>
    [
      ...src.matchAll(
        /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g,
      ),
    ].map((m) => (m[1] ?? m[2] ?? m[3]) as string);
  /** The import closure, resolved recursively; anything but node:* or a local .mjs is bad. */
  const closure = (entry: string) => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const visit = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      const src = readFileSync(f, "utf8");
      const hit = FORBIDDEN.exec(src);
      if (hit) bad.push(`${f}: ${hit[0]}`);
      for (const spec of importsOf(src)) {
        if (spec.startsWith("node:")) continue;
        if (/^\.\.?\//.test(spec) && spec.endsWith(".mjs")) {
          const p = resolve(dirname(f), spec);
          if (!p.startsWith(join(root, "scripts/ci/")))
            bad.push(`${f}: ${spec}`);
          else visit(p);
        } else bad.push(`${f}: ${spec}`);
      }
    };
    visit(entry);
    return { seen: [...seen], bad };
  };
  const ENTRIES = [
    "sign-release.mjs",
    "sign-floor.mjs",
    "assemble-release.mjs",
  ];
  for (const entry of ENTRIES)
    it(`${entry}: node:* only, every file plain .mjs with // @ts-check, no post-22 API`, () => {
      const { seen, bad } = closure(join(root, "scripts/ci", entry));
      expect(bad).toEqual([]);
      expect(seen.length).toBeGreaterThan(1);
      for (const f of seen) {
        expect(f.endsWith(".mjs"), f).toBe(true);
        const src = readFileSync(f, "utf8");
        expect(src.startsWith("// @ts-check\n"), f).toBe(true);
        // Static Node 22 check (comments stripped so prose can't trip it).
        const code = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
        expect(POST_22.exec(code)?.[0], f).toBeUndefined();
      }
    });
  it("no TypeScript copies of the key-job scripts remain", () => {
    for (const n of [
      "release-artifact",
      "release-pubkeys",
      "sign-release",
      "sign-floor",
      "assemble-release",
    ])
      expect(existsSync(join(root, `scripts/ci/${n}.ts`)), n).toBe(false);
  });
  it("tsc checks them: the root tsconfig has allowJs, checkJs and scripts/**/*.mjs", () => {
    const t = JSON.parse(read("tsconfig.json"));
    expect(t.compilerOptions.allowJs).toBe(true);
    expect(t.compilerOptions.checkJs).toBe(true);
    expect(t.include).toContain("scripts/**/*.mjs");
  });
  it("the scan flags a package import, a dynamic import, require, child_process, a .ts import and post-22 APIs", () => {
    const d = mkdtempSync(join(tmpdir(), "oa-scan-"));
    for (const [n, src] of [
      ["pkg.mjs", 'import { parse } from "yaml";\n'],
      ["dyn.mjs", "const m = await import(spec);\n"],
      ["req.mjs", 'import { createRequire } from "node:module";\n'],
      ["cjs.mjs", 'const x = require("fs");\n'],
      ["cp.mjs", 'import { spawn } from "node:child_process";\n'],
      ["dl.mjs", "process.dlopen(m, p);\n"],
      ["ts.mjs", 'import { x } from "./other.ts";\n'],
    ] as const) {
      writeFileSync(join(d, n), src);
      expect(closure(join(d, n)).bad.length, n).toBeGreaterThan(0);
    }
    writeFileSync(
      join(d, "ok.mjs"),
      'import { createHash } from "node:crypto";\n',
    );
    expect(closure(join(d, "ok.mjs")).bad).toEqual([]);
    for (const x of [
      "process.getBuiltinModule(m)",
      "URL.parse(u)",
      "using r = open();",
      "RegExp.escape(s)",
      "zlib.crc32(b)",
      "path.matchesGlob(p, g)",
      "duplexPair()",
      "util.getCallSites()",
    ])
      expect(POST_22.test(x), x).toBe(true);
    for (const x of [
      "const a = b;",
      "import.meta.dirname",
      "Promise.withResolvers()",
      "Object.groupBy(a, f)",
      "a.union(b)",
      "Object.hasOwn(o, k)",
      "x.at(-1)",
      "structuredClone(v)",
      "c ? a : b;",
    ])
      expect(POST_22.test(x), x).toBe(false);
  });
});

describe("docs/ops/hosted.md first-create checklist", () => {
  it("applies the platform D1 migrations, the floor one included, before the first create", () => {
    const doc = read("docs/ops/hosted.md");
    const at = doc.indexOf("### First-create checklist");
    expect(at).toBeGreaterThan(-1);
    const section = doc.slice(at, doc.indexOf("\n## ", at) >>> 0 || undefined);
    expect(section).toContain("0001_installs.sql");
    expect(section).toContain("0002_release_floor.sql");
  });
});

// deploy-prod is a public job (release-please.yml is public's file and keeps
// it after the split). Not a hosted job: this only reads it.
describe("deploy-prod checks the release bundle before Upgrade", () => {
  // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
  const rp: any = parse(read(".github/workflows/release-please.yml"));
  const st: Step[] = rp.jobs["deploy-prod"].steps;
  // Stable release, and not held by the non-additive migration guard.
  const GATE =
    "steps.guard.outputs.deploy == 'true' && steps.migration.outputs.hold == 'false'";
  const at = (m: string) => st.findIndex((s) => (s.run ?? "").includes(m));
  it("builds the release bundle and runs check-no-test-hooks on it before the upgrade", () => {
    const build = at("build-release-bundle.ts");
    const check = at("pnpm check-no-test-hooks");
    const up = at("prod-setup.sh upgrade");
    expect(build).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(build);
    expect(up).toBeGreaterThan(check);
    for (const i of [build, check]) {
      expect(st[i]?.if).toBe(GATE);
      expect(st[i]?.["continue-on-error"]).toBeUndefined();
      expect(JSON.stringify(st[i]?.env ?? {})).not.toContain("secrets.");
    }
    expect(st[build]?.run).toContain("--variant release");
  });
  it("runs check-no-fake-idp on the same bundle after the hooks check, before the upgrade", () => {
    const check = at("pnpm check-no-test-hooks");
    const fake = at('pnpm check-no-fake-idp "$RUNNER_TEMP/release-bundle"');
    expect(fake).toBeGreaterThan(check);
    expect(at("prod-setup.sh upgrade")).toBeGreaterThan(fake);
    expect(st[fake]?.if).toBe(GATE);
    expect(st[fake]?.["continue-on-error"]).toBeUndefined();
  });
  it("L10: the upgrade itself runs check-no-test-hooks on the bundle it deploys", () => {
    const up = st[at("prod-setup.sh upgrade")];
    expect(up?.env?.OA_CHECK_NO_TEST_HOOKS).toBe("1");
  });
});

// The old "ci.yml no-test-hooks job" test read the public repo's ci.yml, which
// drops that job at the split. Its N5 guard (the real-build pin test in
// packages/provision/test/release-t3b.test.ts runs required, never skipped) is
// kept in this repo's own CI: ci.yml's overlay job sets OA_REQUIRE_REAL_BUILD
// and runs every private package's tests, provision's included. That file is
// this repo's, never overlaid, so scripts/overlay.test.sh checks it.

describe("ci.yml: no signer-node20 job (H-N22)", () => {
  // The key jobs sign on Node 22 (setup-node, .nvmrc), the same major as the
  // normal CI run, so the separate Node 20 signer job is gone.
  it("has no signer-node20 job, and nothing needs or names it", () => {
    const src = read(".github/workflows/ci.yml");
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const ci: any = parse(src);
    expect(ci.jobs["signer-node20"]).toBeUndefined();
    expect(src).not.toMatch(/signer-node20|OA_NODE20|OA_REQUIRE_NODE20/);
    expect(read("docs/ops/hosted.md")).not.toContain("signer-node20");
  });
});

describe("build-release-bundle.ts", () => {
  it("takes --variant release|redline, defaulting to release", () => {
    const src = read("scripts/ci/build-release-bundle.ts");
    expect(src).toContain("--variant");
    expect(src).toMatch(/"release"/);
    expect(src).toMatch(/"redline"/);
  });
});

// #1056 C3: hosted-release.yml in this repo, the hosted release jobs moved out
// of the public repo's release-please.yml. Same rules, on the overlay tree.
describe("hosted-release.yml (the cloud repo's hosted release)", () => {
  const src = read(".github/workflows/hosted-release.yml");
  // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
  const hr: any = parse(src);
  const jobs: Record<string, Step> = hr.jobs;
  const JOBS = [
    "mirror",
    "hosted-guard",
    "hosted-build",
    "hosted-check",
    "hosted-sign-staging",
    "hosted-sign-prod",
    "hosted-attach-staging",
    "hosted-attach-prod",
    "hosted-dry-run",
  ];
  const needsOf = (j: string): string[] => [jobs[j].needs ?? []].flat();
  const allSteps = (j: string): Step[] => jobs[j].steps;
  const PUB_COMMIT = "${{ needs.hosted-guard.outputs.public_sha }}";

  it("has exactly the mirror and the moved hosted jobs", () => {
    expect(Object.keys(jobs)).toEqual(JOBS);
  });

  it("runs on a push to main that changes PUBLIC_PIN, and on dispatch with dry_run defaulting to true", () => {
    expect(Object.keys(hr.on)).toEqual(["push", "workflow_dispatch"]);
    expect(hr.on.push).toEqual({ branches: ["main"], paths: ["PUBLIC_PIN"] });
    const input = hr.on.workflow_dispatch.inputs;
    expect(Object.keys(input)).toEqual(["dry_run"]);
    expect(input.dry_run.type).toBe("boolean");
    expect(input.dry_run.default).toBe(true);
    expect(hr.permissions).toEqual({});
  });

  it("a push (no inputs, so inputs.dry_run is null) is a real run, never a dry run", () => {
    const text = read(".github/workflows/hosted-release.yml");
    // Every use of the input is a bare truthiness test, so null means "not a dry run".
    const uses = [...text.matchAll(/[^\n]*inputs\.dry_run[^\n]*/g)]
      .map((m) => m[0].trim())
      .filter((l) => !l.startsWith("#"));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l).not.toMatch(/inputs\.dry_run\s*(==|!=)/);
    // Parsed, not matched as text: the guard's env is exactly the input.
    const guardEnvs = stepsOf(hr, "hosted-guard")
      .filter((st) => st.env && "DRY_RUN" in st.env)
      .map((st) => st.env.DRY_RUN);
    expect(guardEnvs).toEqual(["${{ inputs.dry_run }}"]);
    // No condition compares the input the other way round ('true' == inputs.dry_run, or false, or '').
    const ifs: string[] = [];
    const collect = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(collect);
      else if (o && typeof o === "object")
        for (const [k, v] of Object.entries(o)) {
          if (k === "if" && typeof v === "string") ifs.push(v);
          else collect(v);
        }
    };
    collect(hr.jobs);
    expect(ifs.length).toBeGreaterThan(0);
    for (const c of ifs) expect(c).not.toMatch(/[!=]=\s*inputs\.dry_run/);
    // The guard's shell test treats anything but the string true as a real run.
    expect(text).toContain('if [ "$DRY_RUN" != true ]; then');
    // The mirror runs on a push because the ref is main.
    expect(jobs.mirror.if).toBe(
      "${{ inputs.dry_run || github.ref == 'refs/heads/main' }}",
    );
    expect(hr["run-name"]).toBe(
      "${{ inputs.dry_run && 'hosted-release (dry run)' || 'hosted-release' }}",
    );
  });

  it("names a dry run '(dry run)', the name tag-passed-checks.sh skips", () => {
    expect(hr["run-name"]).toContain("inputs.dry_run");
    expect(hr["run-name"]).toContain("(dry run)");
    expect(read("scripts/ci/tag-passed-checks.sh")).toContain('"(dry run)"');
  });

  it("job ids are the names tag-passed-checks.sh requires", () => {
    const gate = read("scripts/ci/tag-passed-checks.sh");
    for (const j of [
      "mirror",
      "hosted-guard",
      "hosted-build",
      "hosted-check",
      "hosted-sign-$env",
      "hosted-attach-$env",
    ])
      expect(gate).toContain(j);
    for (const j of JOBS) expect(jobs[j].name).toBeUndefined();
  });

  it("chains guard to build to check to sign to attach, behind the mirror", () => {
    expect(needsOf("mirror")).toEqual([]);
    expect(needsOf("hosted-guard")).toEqual(["mirror"]);
    expect(needsOf("hosted-build")).toEqual(["hosted-guard"]);
    expect(needsOf("hosted-check")).toEqual(["hosted-guard", "hosted-build"]);
    for (const e of ENVS) {
      expect(needsOf(`hosted-sign-${e}`)).toEqual([
        "hosted-guard",
        "hosted-build",
        "hosted-check",
      ]);
      expect(needsOf(`hosted-attach-${e}`)).toEqual([
        "hosted-guard",
        "hosted-build",
        "hosted-check",
        `hosted-sign-${e}`,
      ]);
    }
  });

  it("the mirror mints the release App token, only outside a dry run", () => {
    const st = allSteps("mirror");
    const app = st.find((s) => s.id === "app") as Step;
    expect(app.uses).toBe(APP_TOKEN);
    expect(app.with).toEqual({
      "app-id": "${{ secrets.RELEASE_APP_ID }}",
      "private-key": "${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
    });
    expect(app.if).toBe("${{ !inputs.dry_run }}");
    const create = st.find((s) => s.name === "Create the tag and the release");
    expect(create?.if).toBe("${{ !inputs.dry_run }}");
    expect(create?.env.GH_TOKEN).toBe("${{ steps.app.outputs.token }}");
    // The read step uses GITHUB_TOKEN and cannot create anything.
    const reads = st.find((s) =>
      /published, on public main/.test(s.name ?? ""),
    );
    expect(reads?.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(reads?.run).not.toMatch(/-X POST|release create|--method/);
    // Only the create step writes, and only after the checks.
    for (const s of st)
      if (s !== create)
        expect(s.run ?? "").not.toMatch(/git\/refs|release create/);
    expect(st.indexOf(create as Step)).toBeGreaterThan(
      st.indexOf(reads as Step),
    );
    // A real run needs main.
    expect(jobs.mirror.if).toContain("github.ref == 'refs/heads/main'");
    expect(jobs.mirror.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(jobs.mirror.environment).toBeUndefined();
  });

  it("the mirror checks the public release before any tag", () => {
    const run = runOf(allSteps("mirror"));
    expect(run).toContain("prerelease");
    expect(run).toContain("compare/$main_sha...$PUB_SHA");
    expect(run).toContain("release-please.yml/runs");
    for (const j of ["release-please", "verify-release"])
      expect(run).toContain(j);
    expect(run).toContain("package.json?ref=$PUB_SHA");
    // The tag it creates is this repo's commit, which must be main's head.
    expect(run).toContain('[ "$main_sha" = "$SHA" ]');
  });

  // Runs the real create step with a fake gh. A re-run after main moved must
  // not fail (the tag cannot be changed, so a stuck release is permanent).
  describe("create step behavior", () => {
    const MAIN = "b".repeat(40);
    const X = "a".repeat(40);
    function runCreate(o: {
      tagAt?: string;
      main: string;
      compare: string;
      sha: string;
      readAfter?: number; // a new tag reads back on this many-th read (default 1)
      neverReads?: boolean;
      createFailsTimes?: number; // release create says "doesn't exist" this often
      releaseExists?: boolean;
    }) {
      const dir = mkdtempSync(join(tmpdir(), "relcreate-"));
      const log = join(dir, "calls.log");
      const fake = [
        "#!/usr/bin/env bash",
        'echo "$*" >> "$LOG"',
        'case "$*" in',
        '  "api repos/o/r/git/ref/heads/main -q .object.sha") echo "$MAIN" ;;',
        `  "api repos/o/r/git/ref/tags/"*)`,
        '    if [ -z "${TAG_AT:-}" ]; then',
        '      grep -q -- "-X POST" "$LOG" || exit 1',
        '      [ -z "${NEVER:-}" ] || exit 1',
        '      n=$(grep -c "git/ref/tags/" "$LOG")',
        '      [ "$n" -ge "$READ_AFTER" ] || exit 1',
        '      case "$*" in *" -q "*) echo "$SHA_" ;; *) echo \'{"object":{"type":"commit","sha":"\'"$SHA_"\'"}}\' ;; esac',
        "    else",
        `      echo '{"object":{"type":"commit","sha":"'"$TAG_AT"'"}}'`,
        "    fi ;;",
        '  "api repos/o/r/compare/"*) echo "$COMPARE" ;;',
        '  "release view"*) [ -z "${REL_EXISTS:-}" ] || exit 0; grep -q "^release create" "$LOG" && [ "$(grep -c "^release create" "$LOG")" -gt "${CREATE_FAILS:-0}" ] ;;',
        '  "release create"*)',
        '    [ "$(grep -c "^release create" "$LOG")" -gt "${CREATE_FAILS:-0}" ] || { echo "tag v1.2.3 doesn\'t exist" >&2; exit 1; } ;;',
        "  *) exit 0 ;;",
        "esac",
      ].join("\n");
      writeFileSync(join(dir, "gh"), fake, { mode: 0o755 });
      // No real sleeping: the stub records the delay.
      writeFileSync(
        join(dir, "sleep"),
        '#!/usr/bin/env bash\necho "sleep $*" >> "$LOG"\n',
        {
          mode: 0o755,
        },
      );
      const st = allSteps("mirror").find(
        (x) => x.name === "Create the tag and the release",
      ) as Step;
      const r = spawnSync("bash", ["-c", st.run], {
        encoding: "utf8",
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          LOG: log,
          MAIN: o.main,
          COMPARE: o.compare,
          TAG_AT: o.tagAt ?? "",
          SHA_: o.sha,
          READ_AFTER: String(o.readAfter ?? 1),
          NEVER: o.neverReads ? "1" : "",
          CREATE_FAILS: String(o.createFailsTimes ?? 0),
          REL_EXISTS: o.releaseExists ? "1" : "",
          REPO: "o/r",
          TAG: "v1.2.3",
          SHA: o.sha,
          PUBLIC_REPO: "p/p",
        },
      });
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      return { status: r.status, out: r.stdout + r.stderr, calls };
    }
    it("tag exists at SHA and main has moved: a no-op success", () => {
      const r = runCreate({ tagAt: X, main: MAIN, compare: "behind", sha: X });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("already points at");
      expect(r.calls).not.toContain("-X POST");
    });
    it("tag exists at SHA but SHA left main: fails", () => {
      const r = runCreate({
        tagAt: X,
        main: MAIN,
        compare: "diverged",
        sha: X,
      });
      expect(r.status).toBe(1);
      expect(r.out).toContain("is not on main");
    });
    it("tag exists at another commit: fails", () => {
      const r = runCreate({
        tagAt: MAIN,
        main: MAIN,
        compare: "behind",
        sha: X,
      });
      expect(r.status).toBe(1);
      expect(r.out).toContain("already exists and is not");
    });
    it("no tag and main has moved: fails, creates nothing", () => {
      const r = runCreate({ main: MAIN, compare: "behind", sha: X });
      expect(r.status).toBe(1);
      expect(r.out).toContain("not the head of main");
      expect(r.calls).not.toContain("-X POST");
    });
    it("no tag and SHA is main's head: creates the tag", () => {
      const r = runCreate({ main: X, compare: "identical", sha: X });
      expect(r.status, r.out).toBe(0);
      expect(r.calls).toContain("-X POST");
      expect(r.calls).toContain("release create");
    });
    it("a new tag that reads back only after several tries: waits, then releases", () => {
      const r = runCreate({
        main: X,
        compare: "identical",
        sha: X,
        readAfter: 5,
      });
      expect(r.status, r.out).toBe(0);
      expect(r.calls.match(/^sleep /gm)?.length).toBe(3);
      expect(r.calls.indexOf("release create")).toBeGreaterThan(
        r.calls.lastIndexOf("git/ref/tags/"),
      );
    });
    it("a new tag that never reads back: fails after a bounded wait, no release", () => {
      const r = runCreate({
        main: X,
        compare: "identical",
        sha: X,
        neverReads: true,
      });
      expect(r.status).toBe(1);
      expect(r.out).toContain("did not read back");
      expect(r.calls).not.toContain("release create");
      const total = [...r.calls.matchAll(/^sleep (\d+)$/gm)].reduce(
        (a, m) => a + Number(m[1]),
        0,
      );
      expect(total).toBeGreaterThanOrEqual(60);
      expect(total).toBeLessThan(75);
    });
    it("release create retries on 'doesn't exist', then succeeds once", () => {
      const r = runCreate({
        main: X,
        compare: "identical",
        sha: X,
        createFailsTimes: 2,
      });
      expect(r.status, r.out).toBe(0);
      expect(r.calls.match(/^release create/gm)?.length).toBe(3);
    });
    it("release create gives up after a bounded number of tries", () => {
      const r = runCreate({
        main: X,
        compare: "identical",
        sha: X,
        createFailsTimes: 99,
      });
      expect(r.status).toBe(1);
      expect(r.calls.match(/^release create/gm)?.length).toBe(5);
    });
    it("a release that already exists is never created again", () => {
      const r = runCreate({
        tagAt: X,
        main: MAIN,
        compare: "behind",
        sha: X,
        releaseExists: true,
      });
      expect(r.status, r.out).toBe(0);
      expect(r.calls).not.toContain("release create");
    });
  });

  it("a real run needs main; the guard ties the tag, the commit and PUBLIC_PIN", () => {
    const run = runOf(allSteps("hosted-guard"));
    expect(run).toContain("refs/heads/main");
    expect(run).toContain("PUBLIC_PIN?ref=$sha");
    expect(run).toContain("git/ref/tags/$TAG");
    expect(run).toContain('"$tsha" = "$sha"');
    expect(run).toContain("target_commitish");
    expect(jobs["hosted-guard"].permissions).toEqual({ contents: "read" });
  });

  it("every job sets its own permissions; only attach writes contents", () => {
    for (const j of JOBS) {
      expect(jobs[j].permissions, j).toBeDefined();
      const writes = Object.entries(jobs[j].permissions).filter(
        ([, v]) => v === "write",
      );
      expect(writes.length, j).toBe(j.startsWith("hosted-attach-") ? 1 : 0);
    }
    for (const e of ENVS)
      expect(jobs[`hosted-attach-${e}`].permissions).toEqual({
        contents: "write",
      });
  });

  it("pins every action by SHA, the release App's too", () => {
    for (const j of JOBS)
      for (const s of allSteps(j)) {
        if (!s.uses) continue;
        expect(s.uses, `${j}: ${s.uses}`).toMatch(SHA_PIN);
      }
  });

  it("secrets: the App secrets only in the mirror, the key only in a sign step", () => {
    for (const j of JOBS) {
      const job = jobs[j];
      const outside = JSON.stringify({ ...job, steps: undefined });
      expect(outside, j).not.toContain("secrets.");
      for (const s of allSteps(j)) {
        const text = JSON.stringify(s);
        if (j === "mirror") {
          expect(text).not.toContain("RELEASE_SIGNING_KEY");
          continue;
        }
        expect(text).not.toMatch(/RELEASE_APP_/);
        const inSign = j.startsWith("hosted-sign-") && s.id === "sign";
        if (!inSign) expect(text, `${j}: ${s.name}`).not.toContain("secrets.");
      }
    }
    for (const e of ENVS) {
      const sign = allSteps(`hosted-sign-${e}`).find(
        (s) => s.id === "sign",
      ) as Step;
      expect(sign.env.RELEASE_SIGNING_KEY).toBe(
        "${{ secrets.RELEASE_SIGNING_KEY }}",
      );
      expect(jobs[`hosted-sign-${e}`].environment).toBe(`hosted-${e}`);
      // stdin only, not argv or the shell's history.
      expect(sign.run).toContain(
        "printf '%s' \"$RELEASE_SIGNING_KEY\" | node scripts/ci/sign-release.mjs",
      );
      expect(sign.run).not.toMatch(/--key/);
    }
  });

  it("the key jobs install nothing and run only node", () => {
    for (const e of ENVS) {
      const j = `hosted-sign-${e}`;
      const st = allSteps(j);
      expect(runOf(st).replace(/pnpm-lock\.yaml/g, "")).not.toMatch(INSTALL);
      expect(runOf(st)).not.toContain("strip-types");
      expect(
        st.map((s) => (s.uses ?? "").split("@")[0]).filter(Boolean),
      ).toEqual([
        "actions/checkout",
        "actions/checkout",
        "actions/setup-node",
        "actions/download-artifact",
      ]);
      expect(st.some((s) => s.run === NODE22_ASSERT)).toBe(true);
      for (const s of st)
        if (s.uses?.startsWith("actions/setup-node"))
          expect(s.with).toEqual({ "node-version-file": "public/.nvmrc" });
      expect(jobs[j].env).toBeUndefined();
    }
  });

  it("a dry run signs with staging only, and attaches nothing", () => {
    expect(jobs["hosted-sign-staging"].if).not.toContain("inputs.dry_run");
    expect(jobs["hosted-sign-prod"].if).toContain("!inputs.dry_run");
    for (const e of ENVS)
      expect(jobs[`hosted-attach-${e}`].if).toContain("!inputs.dry_run");
    const dry = jobs["hosted-dry-run"];
    expect(dry.if).toContain("inputs.dry_run");
    expect(dry.if).not.toContain("!inputs.dry_run");
    expect(dry.permissions).toEqual({ contents: "read" });
    const run = runOf(dry.steps);
    expect(run).toContain("assemble-release.mjs");
    expect(run).not.toMatch(/gh release|gh api/);
    const up = dry.steps.at(-1);
    expect(up.uses).toMatch(/^actions\/upload-artifact@/);
    expect(up.with.name).toBe("hosted-signed-staging-dry-run");
  });

  it("builds on the overlay: public at the pinned commit, this repo on top", () => {
    for (const j of [
      "hosted-build",
      "hosted-check",
      ...ENVS.flatMap((e) => [`hosted-sign-${e}`, `hosted-attach-${e}`]),
      "hosted-dry-run",
    ]) {
      const st = allSteps(j);
      const [priv, pub] = st;
      expect(priv.uses).toMatch(/^actions\/checkout@/);
      expect(priv.with.ref).toBe("${{ needs.hosted-guard.outputs.sha }}");
      expect(priv.with.path).toBe("private");
      expect(priv.with["persist-credentials"]).toBe(false);
      expect(pub.with.repository).toBe("open-artifacts-ai/open-artifacts");
      expect(pub.with.ref).toBe(PUB_COMMIT);
      expect(pub.with.path).toBe("public");
      expect(pub.with["persist-credentials"]).toBe(false);
      expect(st[2].run).toBe(
        "private/scripts/overlay.sh --auto-split public private",
      );
    }
  });

  it("records the public commit everywhere, never this repo's", () => {
    for (const j of JOBS.filter((x) => /build|sign|attach|dry-run/.test(x))) {
      const run = runOf(allSteps(j));
      for (const m of run.matchAll(/--commit "\$(\w+)"/g))
        expect(m[1], j).toBe("PUB_SHA");
    }
    expect(src).not.toMatch(/--commit "\$GUARD_SHA"/);
    // The lockfile is the overlay's merged one, from public's root.
    expect(src).toContain("--lockfile pnpm-lock.yaml");
  });

  it("attaches to this repo's release, once per env, refusing existing assets", () => {
    for (const e of ENVS) {
      const run = runOf(allSteps(`hosted-attach-${e}`));
      expect(run).toContain(`grep '^oa-release-${e}-'`);
      expect(run).toContain('gh release upload "$TAG" --repo "$REPO"');
      expect(
        allSteps(`hosted-attach-${e}`).some(
          (s) => s.env?.REPO === "${{ github.repository }}",
        ),
      ).toBe(true);
      expect(jobs[`hosted-attach-${e}`].concurrency.group).toContain(
        `hosted-attach-${e}-`,
      );
    }
  });

  it("never writes to the public repo", () => {
    expect(src).not.toMatch(/-R\s+\$PUBLIC_REPO|--repo\s+"?\$PUBLIC_REPO/);
    for (const m of src.matchAll(/gh api -X (POST|PUT|PATCH|DELETE)[^\n]*/g))
      expect(m[0]).toContain("repos/$REPO/");
  });

  // The guards that used to be asserted against the public release-please.yml's
  // hosted-* jobs, now on this repo's own jobs. (Pre-split and strict mode alike:
  // nothing here reads a public workflow.)
  const SHA_OUT = "${{ needs.hosted-guard.outputs.sha }}";
  const TAG_OUT = "${{ needs.hosted-guard.outputs.tag }}";
  const stepKeys = (st: Step[]) =>
    st.map((x) => Object.keys(x).sort().join(","));

  it("sign and attach are split per env: no matrix, no extra hosted jobs", () => {
    for (const n of JOBS) expect(jobs[n].strategy, n).toBeUndefined();
    for (const n of Object.keys(jobs))
      if (n.startsWith("hosted-")) expect(JOBS, n).toContain(n);
  });

  it("hosted-guard has no secrets, no checkout and read-only permissions", () => {
    const job = jobs["hosted-guard"];
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(JSON.stringify(job)).not.toContain("actions/checkout");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.outputs.sha).toMatch(/steps\.\w+\.outputs\.sha/);
    const run = runOf(allSteps("hosted-guard"));
    // L4: main is read as the branch ref, never the bare (tag-shadowable) name.
    expect(run).toContain('gh api "repos/$REPO/git/ref/heads/main"');
    expect(run).toContain('compare/$main_sha...$sha"');
    expect(run).not.toContain("compare/main...");
    expect(run).toMatch(/behind\|identical/);
    expect(run).not.toContain("${{");
  });

  // L5, moved from the public release-please hosted-guard. This repo has no
  // package.json, so the release commit is proved where the version lives: in
  // the public commit the pin names. The mirror checks it before any tag.
  it("L5: the mirror proves the pinned public commit is the release commit", () => {
    const run = runOf(allSteps("mirror"));
    expect(run).toContain("target_commitish");
    expect(run).toContain('"$target" != "$PUB_SHA"');
    expect(run).toContain(".parents[0].sha");
    expect(run).toContain("package.json?ref=$parent");
    expect(run).toMatch(/\[ "\$prev" != "\$version" \]/);
    // After the version check, before the release run is looked up.
    expect(run.indexOf("package.json?ref=$PUB_SHA")).toBeLessThan(
      run.indexOf("package.json?ref=$parent"),
    );
    expect(run.indexOf("package.json?ref=$parent")).toBeLessThan(
      run.indexOf("release-please.yml/runs"),
    );
  });

  describe("L5 behavior (the real read step, a fake gh)", () => {
    const PUB = "c".repeat(40);
    const PARENT = "d".repeat(40);
    const OTHER = "e".repeat(40);
    function runRead(o: { target: string; prev: string; version?: string }) {
      const dir = mkdtempSync(join(tmpdir(), "relread-"));
      const fake = [
        "#!/usr/bin/env bash",
        'case "$*" in',
        '  "api repos/p/p/releases/tags/v1.2.3") echo \'{"draft":false,"prerelease":false,"published_at":"2026-01-01T00:00:00Z","target_commitish":"\'"$TARGET"\'"}\' ;;',
        '  "api repos/p/p/git/ref/tags/v1.2.3") echo \'{"object":{"type":"commit","sha":"\'"$PUB"\'"}}\' ;;',
        '  "api repos/p/p/git/ref/heads/main -q .object.sha") echo "$PUB" ;;',
        '  "api repos/p/p/compare/"*) echo identical ;;',
        '  *"package.json?ref=$PUB") echo \'{"version":"\'"$VERSION"\'"}\' ;;',
        '  *"package.json?ref=$PARENT") echo \'{"version":"\'"$PREV"\'"}\' ;;',
        '  "api repos/p/p/commits/$PUB -q .parents[0].sha") echo "$PARENT" ;;',
        '  *"release-please.yml/runs"*) echo \'{"workflow_runs":[{"id":7,"head_sha":"\'"$PUB"\'","event":"push","created_at":"2026-01-01T00:00:00Z"}]}\' ;;',
        '  *"actions/runs/7/jobs"*) echo \'{"jobs":[{"name":"release-please","conclusion":"success"},{"name":"verify-release","conclusion":"success"}]}\' ;;',
        '  *) echo "unexpected gh call: $*" >&2; exit 1 ;;',
        "esac",
      ].join("\n");
      writeFileSync(join(dir, "gh"), fake, { mode: 0o755 });
      const st = allSteps("mirror").find((x) =>
        /published, on public main/.test(x.name ?? ""),
      ) as Step;
      const r = spawnSync("bash", ["-c", st.run], {
        encoding: "utf8",
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          PUBLIC_REPO: "p/p",
          TAG: "v1.2.3",
          PUB_SHA: PUB,
          PUB,
          PARENT,
          TARGET: o.target,
          PREV: o.prev,
          VERSION: o.version ?? "1.2.3",
        },
      });
      return { status: r.status, out: r.stdout + r.stderr };
    }
    it("a version bump in the pinned commit passes", () => {
      const r = runRead({ target: PUB, prev: "1.2.2" });
      expect(r.status, r.out).toBe(0);
    });
    it("a release whose target is a branch name passes too", () => {
      const r = runRead({ target: "main", prev: "1.2.2" });
      expect(r.status, r.out).toBe(0);
    });
    it("a pin on a commit that did not change the version fails", () => {
      const r = runRead({ target: PUB, prev: "1.2.3" });
      expect(r.status).toBe(1);
      expect(r.out).toContain("not the release commit");
    });
    it("a release that targets another commit fails", () => {
      const r = runRead({ target: OTHER, prev: "1.2.2" });
      expect(r.status).toBe(1);
      expect(r.out).toContain("its release targets");
    });
  });

  it("every hosted job after the guard needs it and checks out exactly its SHA, no credentials kept", () => {
    for (const name of JOBS.slice(2)) {
      expect(needsOf(name), name).toContain("hosted-guard");
      const co = allSteps(name).filter((x) =>
        String(x.uses ?? "").startsWith("actions/checkout"),
      );
      expect(co.length, name).toBeGreaterThan(0);
      for (const c of co)
        expect(c.with?.["persist-credentials"], name).toBe(false);
      expect(co[0]?.with?.ref, name).toBe(SHA_OUT);
    }
  });

  it("hosted-build and hosted-check use no dependency cache (a main-scoped store would feed the signed bytes)", () => {
    for (const name of ["hosted-build", "hosted-check"])
      for (const x of allSteps(name)) {
        expect(x.with?.cache, `${name} ${x.uses}`).toBeUndefined();
        expect(String(x.uses ?? ""), name).not.toMatch(/^actions\/cache/);
      }
  });

  it("hosted-build has no secrets, contents: read, builds both variants and uploads one artifact", () => {
    const job = jobs["hosted-build"];
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(job.permissions).toEqual({ contents: "read" });
    const st = allSteps("hosted-build");
    expect(runOf(st)).toMatch(
      /build-hosted-release\.ts "\$RUNNER_TEMP\/hosted" --commit "\$PUB_SHA"/,
    );
    const up = st.filter((x) =>
      String(x.uses ?? "").startsWith("actions/upload-artifact"),
    );
    expect(up).toHaveLength(1);
    expect(up[0]?.with?.name).toBe("hosted-release");
  });

  it("hosted-build fetches the public tag and checks it is the public commit, before building", () => {
    const st = allSteps("hosted-build");
    const i = st.findIndex((x) => (x.run ?? "").includes("refs/tags/$TAG"));
    const b = st.findIndex((x) =>
      (x.run ?? "").includes("build-hosted-release"),
    );
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(b);
    expect(st[i]?.env?.TAG).toBe(TAG_OUT);
    expect(st[i]?.env?.PUB_SHA).toBe(PUB_COMMIT);
    expect(st[i]?.run).toContain(
      'git fetch --no-tags --depth=1 origin "+refs/tags/$TAG:refs/tags/$TAG"',
    );
    expect(st[i]?.run).toContain(
      'test "$(git rev-parse "$TAG^{commit}")" = "$PUB_SHA"',
    );
  });

  it("hosted-build fails unless the built server reports exactly the release version", () => {
    const st = allSteps("hosted-build");
    const b = st.findIndex((x) =>
      (x.run ?? "").includes("build-hosted-release"),
    );
    const v = st.findIndex((x) => (x.run ?? "").includes("version.gen.ts"));
    expect(v).toBeGreaterThan(b);
    expect(st[v]?.env?.VERSION).toBe(
      "${{ needs.hosted-guard.outputs.version }}",
    );
    expect(st[v]?.run).toContain(
      'grep -Fqx "export const VERSION = \\"$VERSION\\";" apps/server/src/version.gen.ts',
    );
  });

  it("hosted-check has no secrets, verifies the manifest, runs the hook checks on the artifact and outputs the hashes", () => {
    const job = jobs["hosted-check"];
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(needsOf("hosted-check")).toContain("hosted-build");
    const run = runOf(allSteps("hosted-check"));
    expect(run).toContain("scripts/ci/check-hosted-release.ts");
    expect(run).toMatch(
      /pnpm check-no-test-hooks "\$RUNNER_TEMP\/hosted\/release"\n\s*pnpm check-no-fake-idp "\$RUNNER_TEMP\/hosted\/release"/,
    );
    expect(Object.keys(job.outputs).sort()).toEqual([
      "bundle_sha256",
      "manifest_sha256",
    ]);
  });

  for (const env of ENVS)
    describe(`hosted-sign-${env} (key-job shape)`, () => {
      const name = `hosted-sign-${env}`;
      const job = jobs[name];
      const st = allSteps(name);
      it("runs in its environment, serialized per tag, read-only, no job-level env or defaults", () => {
        expect(job.environment).toBe(`hosted-${env}`);
        expect(job.permissions).toEqual({ contents: "read" });
        expect(job.concurrency).toEqual({
          group: `hosted-sign-${env}-${TAG_OUT}`,
          "cancel-in-progress": false,
        });
        expect(job.env).toBeUndefined();
        expect(job.defaults).toBeUndefined();
      });
      it("has exactly the steps: two checkouts, overlay, setup-node 22, the v22 assert, download-artifact, sign", () => {
        expect(stepKeys(st)).toEqual([
          "uses,with",
          "uses,with",
          "name,run",
          "uses,with",
          "name,run",
          "uses,with",
          "env,id,name,run,working-directory",
        ]);
        expect(st[3]?.with).toEqual({ "node-version-file": "public/.nvmrc" });
        expect(st[3]?.env).toBeUndefined();
        expect(String(st[4]?.run).trim()).toBe(NODE22_ASSERT);
        expect(Object.keys(st[5]?.with ?? {}).sort()).toEqual(["name", "path"]);
        expect(read(".nvmrc").trim()).toBe("22");
      });
      it("keeps the key to the last step's env, once, on stdin, with no cache and no install", () => {
        const last = st.at(-1) as Step;
        expect(JSON.stringify(st)).not.toMatch(/cache/i);
        for (const x of st) expect(x.run ?? "").not.toMatch(INSTALL);
        expect(
          st.filter((x) => JSON.stringify(x).includes("RELEASE_SIGNING_KEY")),
        ).toEqual([last]);
        expect(JSON.stringify(st.slice(0, -1))).not.toContain("secrets.");
        expect(JSON.stringify(last).match(/secrets\./g)).toHaveLength(1);
        expect(String(last.run).match(/RELEASE_SIGNING_KEY/g)).toHaveLength(1);
        expect(last.run).not.toMatch(/set -x|set -o xtrace|--key/);
        expect(last.run).not.toContain("--experimental-strip-types");
        expect(JSON.stringify(st)).not.toMatch(/CLOUDFLARE_/);
      });
      it("signs only its own env and outputs only its own names", () => {
        const env2 = st.at(-1)?.env ?? {};
        expect(env2.SIGN_ENV).toBe(env);
        expect(env2.PUB_SHA).toBe(PUB_COMMIT);
        expect(env2.MANIFEST_SHA256).toBe(
          "${{ needs.hosted-check.outputs.manifest_sha256 }}",
        );
        expect(env2.BUNDLE_SHA256).toBe(
          "${{ needs.hosted-check.outputs.bundle_sha256 }}",
        );
        const variants = env === "prod" ? ["release"] : ["release", "redline"];
        expect(Object.keys(job.outputs).sort()).toEqual(
          [
            `${env}_signed`,
            ...variants.flatMap((v) =>
              ["signature", "tar_sha256", "record_sha256"].map(
                (k) => `${env}_${v}_${k}`,
              ),
            ),
          ].sort(),
        );
      });
    });

  for (const env of ENVS)
    it(`hosted-attach-${env}: contents: write, no key, only its own sign job's outputs, refuses existing assets`, () => {
      const name = `hosted-attach-${env}`;
      const job = jobs[name];
      const other = env === "prod" ? "staging" : "prod";
      expect(job.permissions).toEqual({ contents: "write" });
      expect(JSON.stringify(job)).not.toContain("RELEASE_SIGNING_KEY");
      expect(JSON.stringify(job)).not.toContain("secrets.");
      expect(needsOf(name)).not.toContain(`hosted-sign-${other}`);
      expect(JSON.stringify(job)).not.toContain(`hosted-sign-${other}`);
      expect(job.if).toContain(
        `needs.hosted-sign-${env}.outputs.${env}_signed == 'true'`,
      );
      expect(job.concurrency).toEqual({
        group: `hosted-attach-${env}-${TAG_OUT}`,
        "cancel-in-progress": false,
      });
      const run = runOf(allSteps(name));
      expect(run).toContain("scripts/ci/assemble-release.mjs");
      expect(run).toContain(`--env ${env}`);
      expect(run).toContain("gh release view");
      expect(run).toContain(`oa-release-${env}-`);
      expect(run.indexOf("gh release view")).toBeLessThan(
        run.indexOf("gh release upload"),
      );
      expect(run).not.toContain("--clobber");
      expect(
        allSteps(name).filter((x) =>
          String(x.uses ?? "").startsWith("actions/setup-node@"),
        ),
      ).toHaveLength(1);
    });

  it("no job has actions: write", () => {
    expect(hr.permissions ?? {}).toEqual({});
    for (const [n, job] of Object.entries(jobs))
      expect(job.permissions?.actions, n).not.toBe("write");
  });
});
