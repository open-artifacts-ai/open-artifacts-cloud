import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, script } from "./stubs.ts";

// fleet-wake-capable.sh (cloud #264): the deploy wakes the fleet and waits
// for it only when the tag's scheduler consumes the env's fleet-wake queue.
// An older tag (a recovery deploy of a release from before the wake) declares
// none and never writes fleet_done: no wake for it.
const SCRIPT = script("fleet-wake-capable.sh");
const REAL = readFileSync(join(root, "apps/scheduler/wrangler.jsonc"), "utf8");
const ENV_TS = join(root, "scripts/ops/wrangler-env.ts");
// The real config with no consumers, the shape of a tag before the wake
// (v0.250.0's scheduler declares only its SIGNUPS producer).
const OLD = REAL.replace(/,\s*"consumers": \[[\s\S]*?\n {8}\]/g, "");

const run = (env: string, config: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), "oa-wake-capable-"));
  const cfg = join(dir, "wrangler.jsonc");
  if (config !== null) writeFileSync(cfg, config);
  const out = join(dir, "out");
  writeFileSync(out, "");
  const r = spawnSync("bash", [SCRIPT, env, cfg, ENV_TS], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: out },
  });
  return {
    code: r.status,
    out: r.stdout,
    err: r.stderr,
    output: readFileSync(out, "utf8"),
  };
};

describe("fleet-wake-capable.sh", () => {
  it("a tag whose scheduler consumes the env's fleet-wake queue: capable, one line", () => {
    for (const [env, p] of [
      ["prod", "p"],
      ["staging", "s"],
    ] as const) {
      const r = run(env, REAL);
      expect(r.code, r.err).toBe(0);
      expect(r.output).toBe("capable=true\n");
      expect(r.out).toBe(
        `the tag's scheduler consumes oa-${p}-fleet-wake: wake the fleet and wait for it\n`,
      );
    }
  });

  it("an older tag with no consumer (a v0.250.0 recovery deploy): not capable, one line, exit 0", () => {
    expect(OLD).not.toContain('"consumers"');
    expect(OLD).toContain('"producers"');
    const r = run("prod", OLD);
    expect(r.code, r.err).toBe(0);
    expect(r.output).toBe("capable=false\n");
    expect(r.out).toBe(
      "the tag's scheduler does not consume oa-p-fleet-wake: no wake and no wait; the 2-minute tick moves the fleet\n",
    );
  });

  it("only the other env's queue, or a config it can't read: not capable, exit 0", () => {
    const other = REAL.replaceAll(
      '"queue": "oa-p-fleet-wake"',
      '"queue": "oa-s-fleet-wake"',
    );
    for (const [config, why] of [
      [other, "other env's queue"],
      [null, "missing file"],
      ["{ not json", "unparsable"],
    ] as const) {
      const r = run("prod", config);
      expect(r.code, why).toBe(0);
      expect(r.output, why).toBe("capable=false\n");
    }
  });

  it("bad usage exits 2 and writes nothing", () => {
    const r = spawnSync("bash", [SCRIPT, "dev", "x", "y"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
  });
});
