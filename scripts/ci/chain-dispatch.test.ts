// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// chain-dispatch.ts (cloud #264): the prod chain's dispatch starts one run
// and ends. It never looks for the run, never waits and never sleeps: the
// run's own completion is the chain's next event. gh is a stub; nothing is
// dispatched.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  billingConfigured,
  CHAIN_RE,
  dispatch,
  type Exec,
  ghRead,
  outputLine,
} from "./chain-dispatch.ts";

const CHAIN = "c555-1";

function harness(o: { dispatchFails?: boolean } = {}) {
  const calls: string[][] = [];
  const exec: Exec = (_c, a) => {
    calls.push(a);
    if (a[0] === "workflow")
      return o.dispatchFails
        ? { code: 1, stdout: "", stderr: "HTTP 403" }
        : { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected call: gh ${a.join(" ")}`);
  };
  return { exec, calls };
}

describe("chain-dispatch", () => {
  it("dispatches main's deploy with the chain's inputs and ends: one call, no read, no wait", () => {
    const h = harness();
    const r = dispatch({
      exec: h.exec,
      repo: "o/r",
      tag: "v1.2.3",
      chainId: CHAIN,
    });
    expect(r).toEqual({
      title: `deploy-hosted-platform prod v1.2.3 [${CHAIN}]`,
    });
    expect(h.calls).toHaveLength(1);
    const d = h.calls[0] as string[];
    expect(d.slice(0, 2)).toEqual(["workflow", "run"]);
    expect(d).toContain("deploy-hosted-platform.yml");
    expect(d[d.indexOf("--ref") + 1]).toBe("main");
    for (const f of [
      "env=prod",
      "tag=v1.2.3",
      "reason=",
      "verify_only=false",
      "require_newer=true",
      `chain_id=${CHAIN}`,
    ])
      expect(d).toContain(f);
  });
  it("the title it returns is the deploy's own run-name for those inputs", () => {
    const deploy = readFileSync(
      join(
        import.meta.dirname,
        "../../.github/workflows/deploy-hosted-platform.yml",
      ),
      "utf8",
    );
    expect(deploy).toContain(
      "run-name: deploy-hosted-platform ${{ inputs.env }} ${{ inputs.tag }}${{ inputs.chain_id && format(' [{0}]', inputs.chain_id) || '' }}",
    );
    const publish = readFileSync(
      join(import.meta.dirname, "../../.github/workflows/hosted-publish.yml"),
      "utf8",
    );
    expect(publish).toContain(
      "${{ inputs.chain_id && format(' [{0}]', inputs.chain_id) || '' }}",
    );
  });
  it("billing (#1568): the deploy targets carry billing before provision-token only when prod's billing is configured; otherwise the default list, so no release breaks", () => {
    const targets = (billing: boolean | undefined) => {
      const h = harness();
      dispatch({
        exec: h.exec,
        repo: "o/r",
        tag: "v1.2.3",
        chainId: CHAIN,
        ...(billing === undefined ? {} : { billing }),
      });
      const d = h.calls[0] as string[];
      return d.find((x) => x.startsWith("targets=")) as string;
    };
    const FULL =
      "targets=platform-db,auth-broker,directory-broker,provision-token,provisioner,provisioning,dispatch,inventory,zones,scheduler";
    const WITH =
      "targets=platform-db,auth-broker,directory-broker,billing,provision-token,provisioner,provisioning,dispatch,inventory,zones,scheduler";
    expect(targets(undefined)).toBe(FULL);
    expect(targets(false)).toBe(FULL);
    expect(targets(true)).toBe(WITH);
  });
  it("billingConfigured: the four required prices filled means configured; all empty or absent means skip; partly filled, a malformed id or bad JSON throws", () => {
    const four = {
      stripe_price_team: "price_Team1",
      stripe_price_business: "price_Biz1",
      stripe_price_solo_monthly: "price_SoloM1",
      stripe_price_solo_yearly: "price_SoloY1",
    };
    const empty = Object.fromEntries(Object.keys(four).map((k) => [k, ""]));
    expect(billingConfigured(JSON.stringify(four))).toBe(true);
    expect(
      billingConfigured(
        JSON.stringify({ ...four, stripe_price_team_yearly: "" }),
      ),
    ).toBe(true);
    expect(billingConfigured(JSON.stringify(empty))).toBe(false);
    expect(billingConfigured(JSON.stringify({}))).toBe(false);
    expect(() =>
      billingConfigured(
        JSON.stringify({ ...empty, stripe_price_team: "price_1" }),
      ),
    ).toThrow("partly filled");
    expect(() =>
      billingConfigured(
        JSON.stringify({ ...four, stripe_price_team: "prod_1" }),
      ),
    ).toThrow("not a Stripe price id");
    expect(() => billingConfigured("{not json")).toThrow();
  });
  it("the committed prod.json skips billing until its prices are filled", () => {
    const prod = readFileSync(
      join(import.meta.dirname, "../../.github/hosted/prod.json"),
      "utf8",
    );
    expect(billingConfigured(prod)).toBe(
      /"stripe_price_team":\s*"price_/.test(prod),
    );
  });
  it("dispatches hosted-publish.yml (#1412) with env, tag and chain id only", () => {
    const h = harness();
    const r = dispatch({
      exec: h.exec,
      repo: "o/r",
      tag: "v1.2.3",
      chainId: "p555-1",
      workflow: "publish",
    });
    expect(r.title).toBe("hosted-publish prod v1.2.3 [p555-1]");
    expect(h.calls).toHaveLength(1);
    const d = h.calls[0] as string[];
    expect(d).toContain("hosted-publish.yml");
    for (const f of ["env=prod", "tag=v1.2.3", "chain_id=p555-1"])
      expect(d).toContain(f);
    // None of the deploy's inputs, and never a floor.
    expect(d.join(" ")).not.toMatch(/targets|verify_only|require_newer|floor/);
  });
  it("refuses a bad tag, a bad chain id, or the other step's chain id, before any call", () => {
    for (const [workflow, tag, chainId] of [
      ["deploy", "v1.2", CHAIN],
      ["deploy", "v1.2.3-rc.1", CHAIN],
      ["deploy", "v1.2.3", "c555"],
      ["deploy", "v1.2.3", "c555-1 x"],
      ["deploy", "v1.2.3", "p555-1"],
      ["deploy", "v1.2.3", "sc555-1"],
      ["publish", "v1.2.3", CHAIN],
      ["publish", "v1.2.3", "p-1"],
    ] as const) {
      const h = harness();
      expect(() =>
        dispatch({ exec: h.exec, repo: "o/r", tag, chainId, workflow }),
      ).toThrow();
      expect(h.calls).toEqual([]);
    }
    expect(CHAIN_RE.deploy.test("c42109047045-2")).toBe(true);
    expect(CHAIN_RE.publish.test("p42109047045-2")).toBe(true);
  });
  it("a refused dispatch throws once: a write is never retried", () => {
    const h = harness({ dispatchFails: true });
    expect(() =>
      dispatch({ exec: h.exec, repo: "o/r", tag: "v1.2.3", chainId: CHAIN }),
    ).toThrow(/HTTP 403/);
    expect(h.calls).toHaveLength(1);
  });
  it("holds no wait: no sleep, poll, timeout or run lookup in the script", () => {
    const src = readFileSync(
      join(import.meta.dirname, "chain-dispatch.ts"),
      "utf8",
    ).replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(
      /Atomics\.wait|setTimeout|pollMs|TimeoutMs|\/cancel|dispatchAndWait/,
    );
    expect(src).not.toMatch(/actions\/workflows\/[^`]*\/runs\?/);
  });
});

describe("ghRead: a read-only call retried on an API error", () => {
  const harnessRead = (failures: number) => {
    const sleeps: number[] = [];
    let n = 0;
    const exec: Exec = () =>
      n++ < failures
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: "ok", stderr: "" };
    const go = () =>
      ghRead({ exec, sleep: (ms) => void sleeps.push(ms) }, ["api", "x"]);
    return { go, sleeps, calls: () => n };
  };
  it("one failed read then success passes", () => {
    const h = harnessRead(1);
    expect(h.go()).toBe("ok");
    expect(h.sleeps).toEqual([2000]);
  });
  it("three failed reads fail with the gh error", () => {
    const h = harnessRead(3);
    expect(() => h.go()).toThrow(/gh api x: exit 1/);
    expect(h.calls()).toBe(3);
    expect(h.sleeps).toEqual([2000, 5000]);
  });
});

describe("outputLine", () => {
  it("is one line: a multi-line error cannot add a deploy_run= line", () => {
    const evil =
      "boom\ndeploy_run=999\r\ndeploy_url=http://x\u2028deploy_conclusion=success\u0000";
    const line = outputLine("deploy_note", evil);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(line.includes("\u0000")).toBe(false);
    const lines = line.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("deploy_note=")).toBe(true);
    expect(lines.some((l) => l.startsWith("deploy_run="))).toBe(false);
  });
  it("caps the length", () => {
    expect(outputLine("k", "a".repeat(1000)).length).toBeLessThanOrEqual(303);
  });
});
