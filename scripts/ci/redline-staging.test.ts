// redline-staging.yml: the red-line suite against rl-a and rl-b, on demand.
// Secrets live only in the redline-staging Environment and reach the suite as
// 0600 files by path; no other step sees them.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const text = readFileSync(
  join(root, ".github/workflows/redline-staging.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const w: any = parse(text);
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const job: any = w.jobs.redline;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const steps: Record<string, any>[] = job.steps;
// The T19 job (#1730): beside the suite, no id-token.
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const t19Job: any = w.jobs.t19;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const t19Steps: Record<string, any>[] = t19Job.steps;
const SHA_PIN =
  /^(actions\/(checkout|upload-artifact|setup-node)|pnpm\/action-setup)@[0-9a-f]{40}$/;
const SECRETS = ["REDLINE_PROD_R2_TOKEN", "REDLINE_PROD_SCRIPTS_TOKEN"];
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const pick = (
  list: Record<string, any>[],
  n: string,
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
): Record<string, any> => {
  const s = list.find((x) => x.name === n || x.id === n);
  if (!s) throw new Error(`no step ${n}`);
  return s;
};
const named = (n: string) => pick(steps, n);
const t19Named = (n: string) => pick(t19Steps, n);
const runBash = (
  script: string,
  env: Record<string, string>,
  cwd?: string,
) =>
  spawnSync("bash", ["-c", script], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    cwd,
  });

describe("redline-staging.yml", () => {
  it("passes the REDLINE_PLAN repository variable to the suite, so serial is a settings flip", () => {
    expect(named("Run the suite").env.REDLINE_PLAN).toBe(
      "${{ vars.REDLINE_PLAN }}",
    );
  });

  it("runs only on demand for a tag, in the redline-staging Environment, bounded; id-token on the job only", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch", "workflow_call"]);
    expect(w.on.workflow_call.inputs.tag).toEqual({
      type: "string",
      required: true,
    });
    expect(w.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(w.permissions).toEqual({ contents: "read" });
    expect(Object.keys(w.jobs)).toEqual(["platform-tags", "t19", "redline"]);
    expect(job.environment).toBe("redline-staging");
    // `actions: read` is for the t19 hand-off (this run's artifacts and jobs).
    expect(job.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      actions: "read",
    });
    expect(job["timeout-minutes"]).toBe(150);
    expect(w.concurrency).toEqual({
      group: "redline",
      "cancel-in-progress": false,
    });
  });

  it("refuses to start on a stale Worker: platform-tags (main's script, the staging deploy token) runs first (#1040)", () => {
    const pt = w.jobs["platform-tags"];
    expect(job.needs).toBe("platform-tags");
    expect(t19Job.needs).toBe("platform-tags");
    expect(pt["runs-on"]).toBe("ubuntu-latest");
    expect(pt.environment).toBe("hosted-staging-deploy");
    expect(pt.permissions).toEqual({ contents: "read" });
    expect(pt.needs).toBeUndefined();
    expect(pt["timeout-minutes"]).toBeLessThanOrEqual(10);
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const all: Record<string, any>[] = pt.steps;
    // First: refuse anything but main, before any checkout.
    expect(all[0]).toMatchObject({
      name: "On main",
      env: { REF: "${{ github.ref }}" },
    });
    expect(all[0]?.run).toContain('[ "$REF" = refs/heads/main ]');
    const ps = all.slice(1);
    expect(ps[0]?.uses).toMatch(SHA_PIN);
    expect(ps[0]?.with).toEqual({
      ref: "${{ github.sha }}",
      "sparse-checkout": "scripts/ci\n.github/hosted\n",
      "persist-credentials": false,
    });
    expect(ps.map((s) => s.name ?? s.uses)).toEqual([
      ps[0]?.uses,
      "Load the hosted constants",
      "Every staging platform Worker runs the tag",
    ]);
    expect(ps[1]?.run).toBe(
      "bash scripts/ci/hosted-constants.sh staging .github/hosted > /dev/null",
    );
    expect(ps[2]).toMatchObject({
      env: {
        TAG: "${{ inputs.tag }}",
        CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      },
      run: 'bash scripts/ci/platform-tags.sh staging "$TAG"',
    });
    // Only that step sees the token.
    expect(
      ps.filter((s) => JSON.stringify(s).includes("secrets.")),
    ).toHaveLength(1);
    expect(JSON.stringify(job)).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(JSON.stringify(t19Job)).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  // P30 runs only with this set, and without it a dispatched run fails the
  // gate: only a scheduled run may leave it out (report.test.ts).
  it("sets REDLINE_DISPATCH on a dispatch, and only then (#1137)", () => {
    expect(named("Run the suite").env.REDLINE_DISPATCH).toBe(
      "${{ github.event_name == 'workflow_dispatch' && '1' || '' }}",
    );
  });

  it("names each run after its tag, the shape staging-first-gate.sh matches", () => {
    expect(w["run-name"]).toBe("redline-staging ${{ inputs.tag }}");
    const gateTest = readFileSync(
      join(root, "scripts/ci/staging-first-gate.test.ts"),
      "utf8",
    );
    expect(gateTest).toContain("display_title: `redline-staging ${TAG}`");
  });

  it("pins every action by SHA and keeps no git credentials", () => {
    for (const list of [steps, t19Steps]) {
      for (const s of list)
        if (s.uses && s.uses !== "./_cloud/.github/actions/overlay")
          expect(s.uses).toMatch(SHA_PIN);
      const checkouts = list.filter((s) =>
        String(s.uses).startsWith("actions/checkout@"),
      );
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with?.["persist-credentials"]).toBe(false);
      for (const s of list) expect(s.with?.cache).toBeUndefined();
    }
  });

  it("no stored red-line or inventory key: only the prod probe's two tokens are secrets", () => {
    expect(text).not.toMatch(/INVENTORY_KEY|REDLINE_RL_/);
    const withSecrets = steps.filter((s) =>
      JSON.stringify(s).includes("secrets."),
    );
    expect(withSecrets).toHaveLength(1);
    const st = withSecrets[0] as Record<string, any>;
    expect(st.run).not.toContain("secrets.");
    expect(Object.values(st.env as object).sort()).toEqual(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expressions
      SECRETS.map((n) => "${{ secrets." + n + " }}").sort(),
    );
    expect(st.run).toMatch(/^set -euo pipefail\numask 077\n/);
    for (const n of SECRETS) expect(st.run).toContain(`> "$d/${n}"`);
    expect(job.env).toBeUndefined();
    expect(w.env).toBeUndefined();
    // The t19 job references no secret and no Environment (whose secrets it
    // would otherwise be able to reach).
    expect(JSON.stringify(t19Job)).not.toContain("secrets.");
    expect(t19Job.environment).toBeUndefined();
    expect(t19Job.env).toBeUndefined();
  });

  it("the prod probe's files: written only when its secrets are set, both or the job fails", () => {
    const st = named("Write the suite's secrets as 0600 files");
    const write = (prod: Record<string, string>) => {
      const tmp = mkdtempSync(join(tmpdir(), "rl-write-"));
      try {
        const r = runBash(String(st.run), {
          RUNNER_TEMP: tmp,
          // Actions passes a missing secret as an empty string.
          PROD_R2_TOKEN: "",
          PROD_SCRIPTS_TOKEN: "",
          ...prod,
        });
        const d = join(tmp, "redline-secrets");
        const files = r.status === 0 ? readdirSync(d).sort() : [];
        return { code: r.status, files, out: r.stdout };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };
    const none = write({});
    expect(none.code).toBe(0);
    expect(none.files).toEqual([]);
    const all = write({ PROD_R2_TOKEN: "r", PROD_SCRIPTS_TOKEN: "s" });
    expect(all.code).toBe(0);
    expect(all.files).toEqual([
      "REDLINE_PROD_R2_TOKEN",
      "REDLINE_PROD_SCRIPTS_TOKEN",
    ]);
    // A partial set is a misconfiguration: the empty-file check stops the job.
    const partial = write({ PROD_R2_TOKEN: "r" });
    expect(partial.code).toBe(1);
    expect(partial.out).toContain("empty secret file: REDLINE_PROD_");
  });

  it("checks the input before anything else, then runs from exactly the tag's checkout (#1137)", () => {
    const guard = named("On main, for a release tag");
    expect(steps[0]).toBe(guard);
    expect(steps[1]?.uses).toMatch(/^actions\/checkout@/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(steps[1]?.with?.ref).toBe("refs/tags/${{ inputs.tag }}");
    // The CLOUD tag goes to _cloud; the overlay action puts it on the public
    // tree at the tag's PUBLIC_PIN and refuses anything but exactly the tag.
    expect(steps[1]?.with?.path).toBe("_cloud");
    expect(steps[2]?.uses).toBe("./_cloud/.github/actions/overlay");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(steps[2]?.with).toEqual({ "exact-tag": "${{ inputs.tag }}" });
    // Nothing else may check out a different ref, and the deploy logic stays
    // main's: platform-tags keeps its own checkout of the workflow's commit.
    expect(text.match(/refs\/tags\//g)).toHaveLength(2);
    expect(guard.run).not.toContain("${{");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(guard.env).toEqual({
      TAG: "${{ inputs.tag }}",
      REF: "${{ github.ref }}",
    });
    const go = (TAG: string, REF: string) =>
      runBash(String(guard.run), { TAG, REF });
    expect(go("v0.82.0", "refs/heads/main").status).toBe(0);
    for (const bad of ["0.82.0", "v0.82", "v1.2.3; echo x", "main", "../x"]) {
      const r = go(bad, "refs/heads/main");
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("tag must be vX.Y.Z");
    }
    // The gate counts main's runs only, so a dispatch off main stops here.
    for (const ref of ["refs/heads/pl/x", "refs/tags/v0.82.0", ""]) {
      const r = go("v0.82.0", ref);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("dispatch redline-staging on main");
    }
  });

  // A rename on main breaks every tag still in use: the workflow is main's and
  // these are the tag's. Change this list only with the tags in mind (#1137).
  it("keeps the commands main's workflow calls in a tag's checkout (#1137)", () => {
    const CLI = [
      "mint-oidc",
      "bringup",
      "staged-version",
      "revoke",
      "t19-recipient",
      "t19-seal",
      "t19-open",
    ];
    const called = [
      ...text.matchAll(/pnpm --filter @oa\/redline provisioning ([a-z0-9-]+)/g),
    ].map((m) => m[1]);
    expect([...new Set(called)].sort()).toEqual([...CLI].sort());
    const cli = readFileSync(
      join(root, "tests/redline/scripts/provisioning.ts"),
      "utf8",
    );
    for (const c of CLI) expect(cli).toContain(`cmd === "${c}"`);
    const scripts = JSON.parse(
      readFileSync(join(root, "tests/redline/package.json"), "utf8"),
    ).scripts;
    expect(Object.keys(scripts)).toEqual(
      expect.arrayContaining(["live", "provisioning"]),
    );
    expect(text).toContain("playwright test -c playwright.staging.config.ts");
    expect(
      existsSync(join(root, "apps/dashboard/playwright.staging.config.ts")),
    ).toBe(true);
    // What the workflow hands the suite, by name.
    const read = ["REDLINE_RELEASE", "REDLINE_TARGETS", "REDLINE_REPORT"];
    const src = ["src/provisioning.ts", "src/targets.ts", "src/reporter.ts"]
      .map((f) => readFileSync(join(root, "tests/redline", f), "utf8"))
      .join("\n");
    for (const v of read) {
      expect(text).toContain(v);
      expect(src).toContain(v);
    }
  });

  it("the targets step sets REDLINE_TARGETS, REDLINE_RELEASE and REDLINE_RUN_ID", () => {
    const st = named("Set the targets");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(st.env.TAG).toBe("${{ inputs.tag }}");
    expect(st.run).not.toContain("${{");
    const go = (env: Record<string, string>, prodTokens = false) => {
      const tmp = mkdtempSync(join(tmpdir(), "rl-targets-"));
      const ghEnv = join(tmp, "env");
      writeFileSync(ghEnv, "");
      if (prodTokens) {
        mkdirSync(join(tmp, "redline-secrets"));
        writeFileSync(
          join(tmp, "redline-secrets", "REDLINE_PROD_R2_TOKEN"),
          "r",
        );
      }
      try {
        const r = runBash(String(st.run), {
          RUNNER_TEMP: tmp,
          GITHUB_ENV: ghEnv,
          REDLINE_TARGETS_BASE:
            '{"mode":"staging","a":{"name":"rl-a"},"b":{"name":"rl-b"}}',
          RUN_ID: "123-1",
          ...env,
        });
        return {
          code: r.status,
          out: r.stdout,
          env: readFileSync(ghEnv, "utf8"),
          tmp,
        };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };
    const ok = go(
      { TAG: "v0.82.0", REDLINE_PROD_INVENTORY_URL: "https://inv.p" },
      true,
    );
    expect(ok.code).toBe(0);
    const lines = Object.fromEntries(
      ok.env
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(lines.REDLINE_RELEASE).toBe("0.82.0");
    expect(lines.REDLINE_RUN_ID).toBe("123-1");
    const t = JSON.parse(lines.REDLINE_TARGETS as string);
    expect(t.secretsDir).toBe(join(ok.tmp, "redline-secrets"));
    expect(t.a.turnstileFile).toBe(join(ok.tmp, "redline-turnstile-token"));
    expect(t.prod).toEqual({ inventoryUrl: "https://inv.p" });
    // No prod tokens: no .prod, so loadTargets reports prod not-applicable
    // instead of failing on the missing token files.
    const noTokens = go({
      TAG: "v0.82.0",
      REDLINE_PROD_INVENTORY_URL: "https://inv.p",
    });
    expect(noTokens.code).toBe(0);
    const t2 = JSON.parse(
      (
        noTokens.env.match(/^REDLINE_TARGETS=(.*)$/m) as RegExpMatchArray
      )[1] as string,
    );
    expect(t2.prod).toBeUndefined();
  });

  it("mints the staging audiences, brings rl-a and rl-b up, mints prod's after bring-up, then the suite", () => {
    expect(named("mint").run).toBe(
      "pnpm --filter @oa/redline provisioning mint-oidc provisioning stagingInventory",
    );
    const prodMint = named("Mint the prod inventory OIDC JWT");
    expect(prodMint.run).toContain(
      'if [ -s "$RUNNER_TEMP/redline-secrets/REDLINE_PROD_R2_TOKEN" ]; then',
    );
    expect(prodMint.run).toContain("mint-oidc prodInventory");
    expect(steps.indexOf(prodMint)).toBeGreaterThan(
      steps.indexOf(named("bringup")),
    );
    expect(named("bringup").run).toBe(
      "pnpm --filter @oa/redline provisioning bringup",
    );
    expect(text).not.toContain("redline-deploy.sh");
    const suite = named("Run the suite");
    expect(suite.run).toContain("pnpm --filter @oa/redline live");
    // The gate is enforced through env, not a flag (#1137): the prod gate
    // reads only this run's conclusion.
    expect(suite.run).not.toContain("--gate");
    expect(suite.env.REDLINE_GATE).toBe("1");
    // T19 is not a step of this job any more (#1730).
    expect(JSON.stringify(job)).not.toContain("playwright test");
    expect(JSON.stringify(job)).not.toContain("T19_EXPECT");
  });

  it("uploads redline-staged-version (version.txt) after bring-up, only once rl-a and rl-b /healthz report the tag", () => {
    const staged = named("staged");
    expect(staged.run).toBe(
      'pnpm --filter @oa/redline provisioning staged-version "$RUNNER_TEMP/redline-staged/version.txt"',
    );
    expect(staged.if).toBeUndefined();
    expect(steps.indexOf(staged)).toBe(steps.indexOf(named("bringup")) + 1);
    const up = steps.filter((s) => s.with?.name === "redline-staged-version");
    expect(up).toHaveLength(1);
    expect(String(up[0]?.uses)).toMatch(SHA_PIN);
    expect(up[0]?.if).toBe("steps.staged.outcome == 'success'");
    expect(up[0]?.with).toEqual({
      name: "redline-staged-version",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      path: "${{ runner.temp }}/redline-staged/version.txt",
      "if-no-files-found": "error",
    });
    expect(steps.indexOf(up[0] ?? {})).toBe(steps.indexOf(staged) + 1);
  });

  describe("the t19 job (#1730): beside the suite, no id-token", () => {
    it("holds no id-token, no Environment and no secret, and runs beside the redline job, not after it", () => {
      expect(t19Job.permissions).toEqual({
        contents: "read",
        actions: "read",
      });
      expect(JSON.stringify(t19Job)).not.toMatch(
        /id-token|ACTIONS_ID_TOKEN|secrets\.|REDLINE_PROD|mint-oidc/,
      );
      // Neither job waits for the other through `needs`: they overlap.
      expect(t19Job.needs).toBe("platform-tags");
      expect(job.needs).toBe("platform-tags");
      // The workflow no longer records a deviation from 4.4, and T19's shell
      // has nothing to unset.
      expect(text).not.toContain("Deviation from 4.4");
      expect(text).toContain('id-token on the redline job only, not t19" holds');
      expect(
        steps.some((s) => /Delete the JWT and prod files/.test(s.name ?? "")),
      ).toBe(false);
      expect(t19Job["timeout-minutes"]).toBeLessThanOrEqual(30);
    });

    it("a failed T19 fails the run: nothing in the job is allowed to fail softly", () => {
      expect(t19Job["continue-on-error"]).toBeUndefined();
      expect(t19Job.if).toBeUndefined();
      for (const s of t19Steps) expect(s["continue-on-error"]).toBeUndefined();
      // The one soft step of the workflow is the redline job's seal, and a
      // missing key fails the t19 job (its wait step), so the run still fails.
      const soft = steps.filter((s) => s["continue-on-error"]);
      expect(soft.map((s) => s.id)).toEqual(["t19-key"]);
      const t19 = t19Named("t19");
      // T19 itself runs only after the key was opened: no key, no T19, and
      // the failed wait or open step already failed the job.
      expect(t19.if).toBeUndefined();
      expect(t19Steps.indexOf(t19)).toBeGreaterThan(
        t19Steps.indexOf(t19Named("open")),
      );
    });

    it("opens the same guard as the redline job before any checkout", () => {
      expect(t19Steps[0]).toMatchObject({
        name: "On main, for a release tag",
        env: { TAG: "${{ inputs.tag }}", REF: "${{ github.ref }}" },
      });
      expect(t19Steps[0]?.run).toBe(steps[0]?.run);
      expect(t19Steps[1]?.uses).toMatch(/^actions\/checkout@/);
      expect(t19Steps[1]?.with).toEqual(steps[1]?.with);
      expect(t19Steps[2]).toEqual(steps[2]);
    });

    it("keeps the pin: T19_EXPECT_VERSION is the staged version.txt handed over with the key, and no file or an empty one stops it (#1251)", () => {
      const t19 = t19Named("t19");
      expect(t19.env).toEqual({ T19_EXPECT_TIER: "team" });
      const run = String(t19.run);
      const pin =
        'T19_EXPECT_VERSION="$(cat "$RUNNER_TEMP/t19-sealed/version.txt")"';
      expect(run).toContain(pin);
      expect(run).toContain(
        'if [ -z "$T19_EXPECT_VERSION" ]; then echo "T19: no staged version to pin"; exit 1; fi',
      );
      expect(run).toContain("export T19_EXPECT_VERSION");
      expect(run.indexOf(pin)).toBeLessThan(
        run.indexOf("playwright test -c playwright.staging.config.ts"),
      );
      // leo's pin stays unset in CI until #955 keeps leo current (#1251).
      expect(text).not.toContain("T19_EXPECT_LEO_VERSION");
      const pre = run.slice(0, run.indexOf("pnpm --filter @oa/dashboard"));
      const temp = mkdtempSync(join(tmpdir(), "t19-pin-"));
      try {
        mkdirSync(join(temp, "t19-sealed"));
        writeFileSync(join(temp, "t19-sealed", "version.txt"), "0.97.0\n");
        const ok = runBash(`${pre}\nenv`, { RUNNER_TEMP: temp });
        expect(ok.status).toBe(0);
        expect(ok.stdout).toMatch(/^T19_EXPECT_VERSION=0\.97\.0$/m);
        // The OIDC request variables are not in this job at all.
        expect(ok.stdout).not.toContain("ACTIONS_ID_TOKEN_REQUEST_");
        rmSync(join(temp, "t19-sealed", "version.txt"));
        expect(runBash(pre, { RUNNER_TEMP: temp }).status).not.toBe(0);
        writeFileSync(join(temp, "t19-sealed", "version.txt"), "");
        const empty = runBash(pre, { RUNNER_TEMP: temp });
        expect(empty.status).toBe(1);
        expect(empty.stdout).toContain("T19: no staged version to pin");
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });

    it("the t19 job's targets: the base JSON plus its own secretsDir, nothing else", () => {
      const st = t19Named("Set the targets");
      expect(st.env).toEqual({ REDLINE_TARGETS_BASE: "${{ vars.REDLINE_TARGETS }}" });
      expect(st.run).not.toContain("${{");
      const tmp = mkdtempSync(join(tmpdir(), "t19-targets-"));
      try {
        const ghEnv = join(tmp, "env");
        writeFileSync(ghEnv, "");
        const r = runBash(String(st.run), {
          RUNNER_TEMP: tmp,
          GITHUB_ENV: ghEnv,
          REDLINE_TARGETS_BASE:
            '{"mode":"staging","a":{"name":"rl-a","installId":"i1"},"b":{"name":"rl-b","installId":"i2"}}',
        });
        expect(r.status).toBe(0);
        const line = readFileSync(ghEnv, "utf8").trim();
        const t = JSON.parse(line.slice("REDLINE_TARGETS=".length));
        expect(t.secretsDir).toBe(join(tmp, "redline-secrets"));
        expect(t.a.name).toBe("rl-a");
        expect(t.prod).toBeUndefined();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("the hook key hand-off: per run, sealed only, the private key stays", () => {
    const uploads = (list: Record<string, any>[]) =>
      list.filter((s) => String(s.uses ?? "").startsWith("actions/upload-artifact"));

    it("the artifacts are named per run and attempt, and carry only the public key, the sealed key and the version", () => {
      const names = (list: Record<string, any>[]) =>
        uploads(list).map((u) => String(u.with.name));
      const per = "${{ github.run_id }}-${{ github.run_attempt }}";
      expect(names(t19Steps)).toEqual([
        `t19-recipient-${per}`,
        "t19-report",
      ]);
      expect(names(steps)).toEqual([
        "redline-staged-version",
        `t19-handoff-${per}`,
        `t19-handoff-${per}`,
        "redline-report",
      ]);
      const pub = uploads(t19Steps)[0];
      expect(pub?.with.path).toBe("${{ runner.temp }}/t19-recipient/public-key");
      // Never the private key, the recipient directory, or a secrets directory.
      const all = JSON.stringify([...uploads(steps), ...uploads(t19Steps)]);
      expect(all).not.toMatch(/private-key|redline-secrets|HOOK_KEY/);
      expect(all).not.toMatch(/t19-recipient"|t19-recipient\/?"/);
      const handoff = uploads(steps).filter((u) =>
        String(u.with.name).startsWith("t19-handoff-"),
      );
      expect(handoff.map((u) => u.with.path)).toEqual([
        "${{ runner.temp }}/t19-handoff",
        "${{ runner.temp }}/t19-nohandoff",
      ]);
      for (const u of [...handoff, pub]) expect(u?.with["retention-days"]).toBe(1);
    });

    it("the redline job seals only after rl-a and rl-b report the tag, to the public key the t19 job uploaded", () => {
      const key = named("t19-key");
      expect(key.if).toBe("steps.staged.outcome == 'success'");
      expect(steps.indexOf(key)).toBeGreaterThan(
        steps.indexOf(named("staged")),
      );
      expect(key.run).toContain(
        'pnpm --filter @oa/redline provisioning t19-seal "$pub/public-key" "$out/sealed"',
      );
      expect(key.run).toContain(
        't19-recipient-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}',
      );
      expect(key.run).toContain('cp "$RUNNER_TEMP/redline-staged/version.txt" "$out/version.txt"');
      expect(key.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    });

    /** A fake `gh`: each `gh run download` and `gh api` answers from a script of files. */
    function sandbox() {
      const dir = mkdtempSync(join(tmpdir(), "t19-gh-"));
      const bin = join(dir, "bin");
      mkdirSync(bin);
      // download: fails until FAIL_N calls were made, then writes FILES into -D.
      // api: prints the n-th line of $STATUSES through the real jq filter.
      writeFileSync(
        join(bin, "gh"),
        `#!/usr/bin/env bash
n=$(( $(cat "$GH_STATE/calls" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$GH_STATE/calls"
echo "$*" >> "$GH_STATE/log"
if [ "$1" = run ] && [ "$2" = download ]; then
  [ "$n" -gt "\${FAIL_N:-0}" ] || exit 1
  d=""; prev=""
  for a in "$@"; do [ "$prev" = -D ] && d="$a"; prev="$a"; done
  mkdir -p "$d"
  for f in $FILES; do echo "content-of-$f" > "$d/$f"; done
  exit 0
fi
if [ "$1" = api ]; then
  line=$(sed -n "\${n}p" "$GH_STATE/statuses"); [ -n "$line" ] || line=$(tail -n 1 "$GH_STATE/statuses")
  [ "$line" != ERROR ] || exit 1
  expr=""; prev=""
  for a in "$@"; do [ "$prev" = --jq ] && expr="$a"; prev="$a"; done
  jq -r "$expr" <<< "$line"
  exit 0
fi
exit 2
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "pnpm"),
        `#!/usr/bin/env bash
echo "$*" >> "$GH_STATE/pnpm"
for last; do :; done
case "$*" in *t19-seal*) echo "sealed-by-pnpm" > "$last";; esac
`,
        { mode: 0o755 },
      );
      const state = join(dir, "state");
      mkdirSync(state);
      const temp = join(dir, "temp");
      mkdirSync(temp);
      const env = (extra: Record<string, string> = {}) => ({
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: temp,
        GH_STATE: state,
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_REPOSITORY: "o/r",
        POLL_S: "0",
        ...extra,
      });
      const read = (f: string) =>
        existsSync(join(state, f)) ? readFileSync(join(state, f), "utf8") : "";
      return { dir, temp, state, env, read };
    }

    it("t19 waits for the sealed key, opens nothing until it has it, and fails for a marker or a timeout", () => {
      const wait = t19Named("wait");
      const sb = sandbox();
      try {
        // Available after two failed tries: the wait polls, then stops.
        const ok = runBash(String(wait.run), sb.env({ FAIL_N: "2", FILES: "sealed version.txt" }));
        expect(ok.status, ok.stdout + ok.stderr).toBe(0);
        expect(sb.read("log").split("\n").filter(Boolean)).toHaveLength(3);
        expect(sb.read("log")).toContain(
          "run download 42 -R o/r -n t19-handoff-42-2 -D " + join(sb.temp, "t19-sealed"),
        );
        expect(existsSync(join(sb.temp, "t19-sealed", "sealed"))).toBe(true);
      } finally {
        rmSync(sb.dir, { recursive: true, force: true });
      }
      // The redline job's marker (no `sealed`): fails at once, says why.
      const sb2 = sandbox();
      try {
        const none = runBash(String(wait.run), sb2.env({ FILES: "none" }));
        expect(none.status).toBe(1);
        expect(none.stdout).toContain("handed over no key");
      } finally {
        rmSync(sb2.dir, { recursive: true, force: true });
      }
      // Nothing ever arrives: the deadline fails it.
      const sb3 = sandbox();
      try {
        const late = runBash(String(wait.run), sb3.env({ FAIL_N: "999", WAIT_S: "0" }));
        expect(late.status).toBe(1);
        expect(late.stdout).toContain("no hand-off from the redline job within 0 s");
      } finally {
        rmSync(sb3.dir, { recursive: true, force: true });
      }
    });

    it("the redline job seals to the downloaded public key and copies the staged version; no public key fails the step", () => {
      const key = named("t19-key");
      const sb = sandbox();
      try {
        mkdirSync(join(sb.temp, "redline-staged"));
        writeFileSync(join(sb.temp, "redline-staged", "version.txt"), "0.97.0\n");
        const ok = runBash(
          String(key.run),
          sb.env({ FAIL_N: "1", FILES: "public-key" }),
        );
        expect(ok.status, ok.stdout + ok.stderr).toBe(0);
        const out = join(sb.temp, "t19-handoff");
        expect(readdirSync(out).sort()).toEqual(["sealed", "version.txt"]);
        expect(readFileSync(join(out, "version.txt"), "utf8")).toBe("0.97.0\n");
        expect(sb.read("pnpm")).toContain(
          `--filter @oa/redline provisioning t19-seal ${join(sb.temp, "t19-recipient-pub", "public-key")} ${join(out, "sealed")}`,
        );
      } finally {
        rmSync(sb.dir, { recursive: true, force: true });
      }
      const sb2 = sandbox();
      try {
        const late = runBash(String(key.run), sb2.env({ FAIL_N: "999", WAIT_S: "0" }));
        expect(late.status).toBe(1);
        expect(late.stdout).toContain("no public key from the t19 job within 0 s");
        expect(sb2.read("pnpm")).toBe("");
      } finally {
        rmSync(sb2.dir, { recursive: true, force: true });
      }
    });

    it("when no key is handed over, the redline job uploads a marker with the same name, so t19 never waits for one", () => {
      const [real, marker] = steps.filter((s) =>
        String(s.with?.name ?? "").startsWith("t19-handoff-"),
      );
      expect(real?.id).toBe("handoff-up");
      expect(real?.if).toBe("steps.t19-key.outcome == 'success'");
      expect(marker?.if).toBe("always() && steps.handoff-up.outcome != 'success'");
      expect(real?.with.name).toBe(marker?.with.name);
      const mk = named("Tell the t19 job no key is coming");
      expect(mk.if).toBe(marker?.if);
      expect(steps.indexOf(mk)).toBe(steps.indexOf(marker ?? {}) - 1);
      const tmp = mkdtempSync(join(tmpdir(), "t19-marker-"));
      try {
        expect(runBash(String(mk.run), { RUNNER_TEMP: tmp }).status).toBe(0);
        expect(readdirSync(join(tmp, "t19-nohandoff"))).toEqual(["none"]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("the revoke can't cut T19 off: it comes after a wait for the t19 job, which only a finished job or the deadline ends", () => {
      const done = named("t19-done");
      const revoke = named("Revoke this run's R26 credentials");
      expect(steps.indexOf(done)).toBe(steps.indexOf(revoke) - 1);
      expect(done.if).toBe("always() && steps.handoff-up.outcome == 'success'");
      expect(revoke.if).toBe("always() && steps.mint.outcome == 'success'");
      // The wait outlasts the t19 job's own timeout, so only a hung API ends it first.
      expect(Number(/WAIT_S:-(\d+)/.exec(String(done.run))?.[1])).toBeGreaterThan(
        t19Job["timeout-minutes"] * 60,
      );
      const sb = sandbox();
      try {
        writeFileSync(
          join(sb.state, "statuses"),
          [
            '{"jobs":[{"name":"platform-tags","status":"completed"},{"name":"t19","status":"queued"}]}',
            "ERROR",
            '{"jobs":[{"name":"t19","status":"in_progress"}]}',
            '{"jobs":[{"name":"x / t19","status":"completed"}]}',
          ].join("\n") + "\n",
        );
        const ok = runBash(String(done.run), sb.env());
        expect(ok.status, ok.stdout + ok.stderr).toBe(0);
        expect(ok.stdout).toContain("the t19 job has ended");
        // queued, an API error, in progress, then completed: four polls.
        expect(sb.read("log").split("\n").filter(Boolean)).toHaveLength(4);
        expect(sb.read("log")).toContain("repos/o/r/actions/runs/42/attempts/2/jobs");
      } finally {
        rmSync(sb.dir, { recursive: true, force: true });
      }
      // Never completed, deadline reached: it warns and lets the revoke go.
      const sb2 = sandbox();
      try {
        writeFileSync(
          join(sb2.state, "statuses"),
          '{"jobs":[{"name":"t19","status":"in_progress"}]}\n',
        );
        const late = runBash(String(done.run), sb2.env({ WAIT_S: "0" }));
        expect(late.status).toBe(0);
        expect(late.stdout).toContain("::warning::the t19 job is still in_progress after 0 s: revoking anyway");
      } finally {
        rmSync(sb2.dir, { recursive: true, force: true });
      }
      // A job whose name merely ends in t19 text elsewhere is not it.
      const sb3 = sandbox();
      try {
        writeFileSync(
          join(sb3.state, "statuses"),
          '{"jobs":[{"name":"redline-t19x","status":"completed"}]}\n',
        );
        const other = runBash(String(done.run), sb3.env({ WAIT_S: "0" }));
        expect(other.stdout).toContain("still none");
      } finally {
        rmSync(sb3.dir, { recursive: true, force: true });
      }
    });

    it("the nightly's caller grants what the called jobs need: actions read beside id-token", () => {
      const nightly = readFileSync(
        join(root, ".github/workflows/redline-nightly.yml"),
        "utf8",
      );
      const nw = parse(nightly) as Record<string, any>;
      expect(nw.jobs.redline.permissions).toEqual({
        contents: "read",
        "id-token": "write",
        actions: "read",
      });
      // A called job's permissions can't exceed its caller's.
      for (const j of [job, t19Job])
        for (const [k, v] of Object.entries(j.permissions as object))
          expect(nw.jobs.redline.permissions[k], k).toBe(v);
    });
  });

  it("installs without lifecycle scripts: every step of the job can reach the OIDC request token", () => {
    expect(
      steps.some(
        (s) => s.run === "pnpm install --frozen-lockfile --ignore-scripts",
      ),
    ).toBe(true);
    expect(steps.some((s) => s.run === "pnpm install --frozen-lockfile")).toBe(
      false,
    );
  });

  it("order (redline job): install, builds, secrets, targets, mint, bring-up, staged, seal, hand-off upload, prod mint, suite, scan, report upload, wait for t19, revoke, remove", () => {
    const at = (pred: (s: Record<string, any>) => boolean) =>
      steps.findIndex(pred);
    const order = [
      at((s) => s.run === "pnpm install --frozen-lockfile --ignore-scripts"),
      at((s) => s.id === "prep"),
      at((s) => JSON.stringify(s).includes("secrets.")),
      at((s) => s.name === "Set the targets"),
      at((s) => s.id === "mint"),
      at((s) => s.id === "bringup"),
      at((s) => s.id === "staged"),
      at((s) => s.id === "t19-key"),
      at((s) => s.id === "handoff-up"),
      at((s) => s.name === "Mint the prod inventory OIDC JWT"),
      at((s) => (s.run ?? "").includes("@oa/redline live")),
      at((s) => s.id === "scan-suite"),
      at((s) => s.with?.name === "redline-report"),
      at((s) => s.id === "t19-done"),
      at((s) => (s.run ?? "").includes("provisioning revoke")),
      at((s) => s.name === "Remove the secret files"),
    ];
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual(order.slice().sort((x, y) => x - y));
    // The job ends with the revoke and the file removal, both always.
    expect(steps.slice(-2).map((s) => s.name)).toEqual([
      "Revoke this run's R26 credentials",
      "Remove the secret files",
    ]);
    expect(steps.at(-2)?.if).toBe(
      "always() && steps.mint.outcome == 'success'",
    );
    expect(steps.at(-1)?.if).toBe("always()");
    expect(steps.at(-1)?.run).toBe(
      'rm -rf "$RUNNER_TEMP/redline-secrets" "$RUNNER_TEMP/redline-turnstile-token" "$RUNNER_TEMP/t19-handoff" "$RUNNER_TEMP/t19-nohandoff" "$RUNNER_TEMP/t19-recipient-pub"',
    );
    expect(
      steps.filter((s) => (s.run ?? "").includes("@oa/provision build")),
    ).toHaveLength(1);
  });

  it("order (t19 job): install, prep, targets, key pair, public key up, wait for the sealed key, open, T19, scan, report, remove", () => {
    const at = (pred: (s: Record<string, any>) => boolean) =>
      t19Steps.findIndex(pred);
    const order = [
      at((s) => s.run === "pnpm install --frozen-lockfile --ignore-scripts"),
      at((s) => s.id === "prep"),
      at((s) => s.name === "Set the targets"),
      at((s) => s.name === "Make this run's recipient key"),
      at((s) => String(s.with?.name ?? "").startsWith("t19-recipient-")),
      at((s) => s.id === "wait"),
      at((s) => s.id === "open"),
      at((s) => s.id === "t19"),
      at((s) => s.id === "scan"),
      at((s) => s.with?.name === "t19-report"),
      at((s) => s.name === "Remove the hook key and the private key"),
    ];
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual(order.slice().sort((x, y) => x - y));
    expect(t19Named("Make this run's recipient key").run).toBe(
      "pnpm --filter @oa/redline provisioning t19-recipient",
    );
    expect(t19Named("open").run).toBe(
      "pnpm --filter @oa/redline provisioning t19-open",
    );
    // The hook key and the private key are removed at the end, whatever happened.
    expect(t19Steps.at(-1)?.if).toBe("always()");
    expect(t19Steps.at(-1)?.run).toBe(
      'rm -rf "$RUNNER_TEMP/redline-secrets" "$RUNNER_TEMP/t19-recipient" "$RUNNER_TEMP/t19-sealed"',
    );
    // The playwright command is main's contract with the tag's config.
    expect(String(t19Named("t19").run)).toContain(
      "pnpm --filter @oa/dashboard exec playwright test -c playwright.staging.config.ts",
    );
  });

  /** A fake pnpm: logs its args, fails when they contain $FAIL. */
  function fakePnpm(dir: string) {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "pnpm"),
      '#!/usr/bin/env bash\necho "$*" >> "$CALLS"\ncase "$*" in *"$FAIL"*) exit 3;; esac\n',
      { mode: 0o755 },
    );
    return bin;
  }

  it("prep (redline job): the two builds only, Chromium is the t19 job's", () => {
    const prep = named("prep");
    expect(prep.if).toBeUndefined();
    expect(prep["continue-on-error"]).toBeUndefined();
    expect(String(prep.run)).not.toContain("playwright");
    const dir = mkdtempSync(join(tmpdir(), "rl-prep-"));
    try {
      const bin = fakePnpm(dir);
      const run = (fail: string) => {
        const calls = join(dir, `calls-${fail || "none"}`);
        const r = runBash(prep.run, {
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: dir,
          CALLS: calls,
          FAIL: fail || "no-such-arg",
        });
        return {
          status: r.status,
          calls: existsSync(calls)
            ? readFileSync(calls, "utf8").trim().split("\n")
            : [],
        };
      };
      expect(run("")).toEqual({
        status: 0,
        calls: ["--filter @oa/provision build", "--filter @oa/shared build"],
      });
      expect(run("provision").status).toBe(3);
      expect(run("shared").status).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prep (t19 job): Chromium installs beside the builds, and either failing fails the step", () => {
    const prep = t19Named("prep");
    expect(prep.if).toBeUndefined();
    expect(prep["continue-on-error"]).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "rl-prep-"));
    try {
      const bin = fakePnpm(dir);
      const run = (fail: string) => {
        const calls = join(dir, `calls-${fail || "none"}`);
        const r = runBash(prep.run, {
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: dir,
          CALLS: calls,
          FAIL: fail || "no-such-arg",
        });
        return {
          status: r.status,
          calls: existsSync(calls)
            ? readFileSync(calls, "utf8").trim().split("\n").sort()
            : [],
        };
      };
      const all = [
        "--filter @oa/dashboard exec playwright install --with-deps chromium",
        "--filter @oa/provision build",
        "--filter @oa/shared build",
      ];
      expect(run("")).toEqual({ status: 0, calls: all });
      // The install fails in the background: the step still fails.
      expect(run("playwright").status).toBe(1);
      // A build fails: the step fails, and the install was still waited on.
      const b = run("provision");
      expect(b.status).toBe(1);
      expect(b.calls).toEqual(all.filter((c) => !c.includes("shared")));
      expect(run("shared").status).toBe(1);
      // The install's log is printed and removed, never left in RUNNER_TEMP.
      expect(existsSync(join(dir, "playwright-install.log"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the suite's report is scanned for every secret file before upload, and a hit stops the upload", () => {
    const scan = named("scan-suite");
    expect(scan.if).toBe("always()");
    // -f: the key is read from its file, never put in argv.
    expect(scan.run).toContain(
      'if grep -rqF -f "$f" "$r"; then echo "secret in report: ${f##*/}"; exit 1; fi',
    );
    expect(scan.run).not.toContain("$(cat");
    const up = steps.filter((s) => s.with?.name === "redline-report");
    expect(up).toHaveLength(1);
    expect(up[0]?.if).toBe("always() && steps.scan-suite.outcome == 'success'");
    expect(steps.indexOf(up[0] ?? {})).toBeGreaterThan(steps.indexOf(scan));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(up[0]?.with.path).toBe("${{ runner.temp }}/redline-report");
  });

  it("the t19 report is scanned for the hook key it holds, and a hit stops its upload; the key is deleted whatever happened", () => {
    const scan = t19Named("scan");
    expect(scan.if).toBe("always()");
    expect(scan.run).toContain(
      'if grep -rqF -f "$f" "${dirs[@]}"; then echo "secret in report: ${f##*/}"; exit 1; fi',
    );
    expect(scan.run).not.toContain("$(cat");
    const up = t19Steps.filter((s) => s.with?.name === "t19-report");
    expect(up).toHaveLength(1);
    expect(up[0]?.if).toBe(
      "always() && steps.scan.outcome == 'success' && steps.t19.outcome != 'skipped'",
    );
    expect(t19Steps.indexOf(up[0] ?? {})).toBeGreaterThan(
      t19Steps.indexOf(scan),
    );
    expect(up[0]?.with.path).toBe("apps/dashboard/playwright-report");
    const tmp = mkdtempSync(join(tmpdir(), "t19-scan-"));
    try {
      mkdirSync(join(tmp, "redline-secrets"));
      mkdirSync(join(tmp, "work", "apps", "dashboard", "playwright-report"), {
        recursive: true,
      });
      writeFileSync(
        join(tmp, "redline-secrets", "REDLINE_RL_A_HOOK_KEY"),
        "hk_s3cret_value",
      );
      const report = join(
        tmp,
        "work",
        "apps",
        "dashboard",
        "playwright-report",
        "index.html",
      );
      const run = () =>
        runBash(String(scan.run), { RUNNER_TEMP: tmp }, join(tmp, "work"));
      writeFileSync(report, "all clear");
      expect(run().status).toBe(0);
      writeFileSync(report, "a hk_s3cret_value b");
      const leak = run();
      expect(leak.status).toBe(1);
      expect(leak.stdout).toContain("secret in report: REDLINE_RL_A_HOOK_KEY");
      expect(leak.stdout).not.toContain("hk_s3cret_value");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the suite scan fails on a leaked key or JWT and passes a clean report", () => {
    const scan = named("scan-suite");
    const tmp = mkdtempSync(join(tmpdir(), "rl-scan-"));
    try {
      mkdirSync(join(tmp, "redline-secrets"));
      mkdirSync(join(tmp, "redline-report"));
      writeFileSync(
        join(tmp, "redline-secrets", "REDLINE_RL_A_PAT"),
        "oa_pat_s3cret",
      );
      writeFileSync(
        join(tmp, "redline-secrets", "REDLINE_PROVISIONING_OIDC"),
        "eyJ.eyJ.sig",
      );
      const run = () => runBash(String(scan.run), { RUNNER_TEMP: tmp });
      writeFileSync(join(tmp, "redline-report", "r.txt"), "all clear");
      expect(run().status).toBe(0);
      writeFileSync(join(tmp, "redline-report", "r.txt"), "x oa_pat_s3cret y");
      const leak = run();
      expect(leak.status).toBe(1);
      expect(leak.stdout).toContain("secret in report: REDLINE_RL_A_PAT");
      expect(leak.stdout).not.toContain("oa_pat_s3cret");
      writeFileSync(join(tmp, "redline-report", "r.txt"), "jwt eyJ.eyJ.sig");
      expect(run().stdout).toContain(
        "secret in report: REDLINE_PROVISIONING_OIDC",
      );
      // A JWT a re-mint replaced lives on only in the minted list.
      writeFileSync(
        join(tmp, "redline-secrets", "REDLINE_MINTED_OIDC"),
        "eyJ.old.sig\neyJ.eyJ.sig\n",
      );
      writeFileSync(join(tmp, "redline-report", "r.txt"), "jwt eyJ.old.sig");
      const old = run();
      expect(old.status).toBe(1);
      expect(old.stdout).toContain("secret in report: REDLINE_MINTED_OIDC");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the live suite prints each case as it runs and still writes the report", () => {
    const cfg = readFileSync(
      join(root, "tests/redline/vitest.live.config.ts"),
      "utf8",
    );
    expect(cfg).toContain('reporters: ["verbose", "./src/reporter.ts"],');
  });

  it("both targets send Cloudflare's dummy Turnstile token from a 0600 file outside the secrets dir", () => {
    const st = named("Set the targets");
    expect(st.run).toContain('t="$RUNNER_TEMP/redline-turnstile-token"');
    expect(st.run).toContain(`printf '%s' 'XXXX.DUMMY.TOKEN.XXXX' > "$t"`);
    expect(st.run).toMatch(/umask 077[\s\S]*printf '%s' 'XXXX/);
    expect(st.run).not.toContain("redline-secrets/redline-turnstile");
  });

  it("the OIDC audiences the probes mint match the API's and the inventories' configs", () => {
    const strip = (f: string) =>
      readFileSync(join(root, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const oidc = readFileSync(join(root, "tests/redline/src/oidc.ts"), "utf8");
    const api = strip("apps/provisioning/wrangler.jsonc").match(
      /"OIDC_AUDIENCE":\s*"([^"]+)"/,
    )?.[1];
    expect(api).toBeTruthy();
    expect(oidc).toContain(`provisioning: "${api}"`);
    expect(oidc).toContain('stagingInventory: "https://oa-s-inventory"');
    expect(oidc).toContain('prodInventory: "https://oa-p-inventory"');
    expect(strip("apps/provisioning/wrangler.jsonc")).toContain(
      "redline-staging.yml@refs/heads/main",
    );
  });
});
