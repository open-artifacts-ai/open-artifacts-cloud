import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root } from "../ci/stubs.ts";

// deploy-waves.sh: the parallel waves of deploy-hosted-platform.yml.
const SCRIPT = join(root, "scripts/ops/deploy-waves.sh");
const ORDER = [
  "platform-db",
  "auth-broker",
  "directory-broker",
  "billing",
  "provision-token",
  "provisioner",
  "provisioning",
  "dispatch",
  "inventory",
  "zones",
  "scheduler",
];
const plan = (targets: string) => {
  const r = spawnSync("bash", [SCRIPT, targets], { encoding: "utf8" });
  return {
    code: r.status,
    err: r.stderr,
    waves: r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ")),
  };
};
// What must already be deployed before each target (deploy-hosted-platform.sh).
const MUST_FOLLOW: Record<string, string[]> = {
  "auth-broker": ["platform-db"],
  "directory-broker": ["platform-db"],
  billing: ["platform-db"],
  "provision-token": ["platform-db"],
  inventory: ["platform-db"],
  provisioner: ["billing", "provision-token"],
  provisioning: ["provisioner", "auth-broker"],
  dispatch: ["auth-broker", "directory-broker", "billing", "provisioning"],
  zones: ["dispatch", "auth-broker", "directory-broker", "provisioning"],
  scheduler: ORDER.filter((t) => t !== "scheduler"),
};

describe("deploy-waves.sh", () => {
  it("plans the full list in waves, every target exactly once", () => {
    const r = plan(ORDER.join(","));
    expect(r.code).toBe(0);
    expect(r.waves).toEqual([
      ["platform-db"],
      [
        "auth-broker",
        "directory-broker",
        "billing",
        "provision-token",
        "inventory",
      ],
      ["provisioner"],
      ["provisioning"],
      ["dispatch"],
      ["zones"],
      ["scheduler"],
    ]);
    expect(r.waves.flat().sort()).toEqual([...ORDER].sort());
  });

  it("every required order holds: each target is in a later wave than what it needs", () => {
    const r = plan(ORDER.join(","));
    const at = (t: string) => r.waves.findIndex((w) => w.includes(t));
    expect(at("platform-db")).toBe(0);
    for (const [t, after] of Object.entries(MUST_FOLLOW))
      for (const a of after)
        expect(at(t), `${t} after ${a}`).toBeGreaterThan(at(a));
    expect(at("scheduler")).toBe(r.waves.length - 1);
  });

  it("a partial (break-glass) list waits only for the targets it holds, and omits the rest", () => {
    expect(plan("dispatch,scheduler").waves).toEqual([
      ["dispatch"],
      ["scheduler"],
    ]);
    expect(plan("auth-broker,directory-broker,inventory").waves).toEqual([
      ["auth-broker", "directory-broker", "inventory"],
    ]);
    expect(
      plan("billing,provision-token,provisioner,provisioning").waves,
    ).toEqual([
      ["billing", "provision-token"],
      ["provisioner"],
      ["provisioning"],
    ]);
    expect(plan("zones").waves).toEqual([["zones"]]);
  });

  it("each prefix of the order is planned with every target once, none before what it needs", () => {
    for (let n = 1; n <= ORDER.length; n++) {
      const list = ORDER.slice(0, n);
      const r = plan(list.join(","));
      expect(r.waves.flat().sort()).toEqual([...list].sort());
      const at = (t: string) => r.waves.findIndex((w) => w.includes(t));
      for (const t of list)
        for (const a of MUST_FOLLOW[t] ?? [])
          if (list.includes(a)) expect(at(t)).toBeGreaterThan(at(a));
    }
  });

  it("refuses an unknown, repeated or out-of-order target, and an empty list", () => {
    for (const bad of ["nope", "dispatch,dispatch", "dispatch,billing", ""]) {
      const r = plan(bad);
      expect(r.code, bad).toBe(2);
      expect(r.waves).toEqual([]);
    }
  });
});
