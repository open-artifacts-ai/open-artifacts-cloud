import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root } from "../ci/stubs.ts";

// deploy-waves.sh: what each target of deploy-hosted-platform.yml waits for
// (#264 step 6: each starts as soon as its own needs succeeded).
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
const BUILD = "provisioning-build";
const plan = (targets: string, ...more: string[]) => {
  const r = spawnSync("bash", [SCRIPT, targets, ...more], { encoding: "utf8" });
  const lines = r.stdout.split("\n").filter(Boolean);
  return {
    code: r.status,
    err: r.stderr,
    order: lines.map((l) => l.split(" ")[0] as string),
    needs: Object.fromEntries(
      lines.map((l) => {
        const [t, ...n] = l.split(" ");
        return [t as string, n];
      }),
    ) as Record<string, string[]>,
  };
};
// Every needs edge, and why (deploy-hosted-platform.sh). A target outside
// this table needs nothing.
const NEEDS: Record<string, string[]> = {
  // The migrations-first rule (kept: Leo's call, as for prod in step 3).
  "auth-broker": ["platform-db"],
  "directory-broker": ["platform-db"],
  billing: ["platform-db"],
  // Binds PLATFORM_DB.
  inventory: ["platform-db"],
  // PLATFORM_DB, the BILLING binding, the PROVISION_TOKEN secret.
  provisioner: ["platform-db", "billing", "provision-token"],
  // need_workers provisioner and auth-broker; PROVISIONER and AUTH_BROKER
  // bindings; billing's binding; the rest by the same rule.
  provisioning: [
    "platform-db",
    "provisioner",
    "auth-broker",
    "directory-broker",
    "billing",
  ],
  // need_workers on both brokers and billing; LOGIN is provisioning's.
  dispatch: [
    "platform-db",
    "auth-broker",
    "directory-broker",
    "billing",
    "provisioning",
  ],
  // Routes send traffic to these Workers: never before their releases passed.
  zones: [
    "platform-db",
    "auth-broker",
    "directory-broker",
    "billing",
    "provisioning",
    "dispatch",
  ],
  // Last: its tag is the fleet's target (#1343).
  scheduler: ORDER.filter((t) => t !== "scheduler"),
};
// The targets that run wrangler, which bundles workspace code the
// provisioning build writes into.
const BUNDLES = ORDER.filter(
  (t) => !["platform-db", "provision-token", "zones"].includes(t),
);
const sorted = (a: string[]) => [...a].sort();

describe("deploy-waves.sh", () => {
  it("the full list: every target once, in order, with exactly its needs", () => {
    const r = plan(ORDER.join(","));
    expect(r.code).toBe(0);
    expect(r.order).toEqual(ORDER);
    for (const t of ORDER)
      expect(sorted(r.needs[t] ?? []), t).toEqual(sorted(NEEDS[t] ?? []));
    // provision-token is a read only: it no longer waits for the migrations.
    expect(r.needs["provision-token"]).toEqual([]);
    expect(r.needs["platform-db"]).toEqual([]);
    // inventory holds up only the scheduler.
    for (const t of ORDER.filter((x) => x !== "scheduler"))
      expect(r.needs[t], t).not.toContain("inventory");
  });

  it("with build: the build first, needing nothing; every bundling target needs it, nothing else does", () => {
    const r = plan(ORDER.join(","), "build");
    expect(r.code).toBe(0);
    expect(r.order).toEqual([BUILD, ...ORDER]);
    expect(r.needs[BUILD]).toEqual([]);
    for (const t of ORDER) {
      const want = [
        ...(NEEDS[t] ?? []),
        ...(BUNDLES.includes(t) ? [BUILD] : []),
      ];
      expect(sorted(r.needs[t] ?? []), t).toEqual(sorted(want));
    }
    for (const t of ["platform-db", "provision-token", "zones"])
      expect(r.needs[t], t).not.toContain(BUILD);
  });

  it("a schedule that starts each target once its needs are done never starts one early, and starts them all", () => {
    for (const extra of [[], ["build"]]) {
      const r = plan(ORDER.join(","), ...extra);
      const done = new Set<string>();
      const rounds: string[][] = [];
      while (done.size < r.order.length) {
        const ready = r.order.filter(
          (t) => !done.has(t) && (r.needs[t] ?? []).every((n) => done.has(n)),
        );
        expect(ready.length).toBeGreaterThan(0);
        rounds.push(ready);
        for (const t of ready) done.add(t);
      }
      const at = (t: string) => rounds.findIndex((w) => w.includes(t));
      for (const [t, after] of Object.entries(NEEDS))
        for (const a of after)
          expect(at(t), `${t} after ${a}`).toBeGreaterThan(at(a));
      expect(rounds.at(-1)).toEqual(["scheduler"]);
      expect(rounds[0]).toEqual(
        extra.length
          ? [BUILD, "platform-db", "provision-token"]
          : ["platform-db", "provision-token"],
      );
    }
  });

  it("a partial (break-glass) list waits only for the targets it holds", () => {
    expect(plan("dispatch,scheduler").needs).toEqual({
      dispatch: [],
      scheduler: ["dispatch"],
    });
    expect(plan("auth-broker,directory-broker,inventory").needs).toEqual({
      "auth-broker": [],
      "directory-broker": [],
      inventory: [],
    });
    expect(
      plan("billing,provision-token,provisioner,provisioning").needs,
    ).toEqual({
      billing: [],
      "provision-token": [],
      provisioner: ["billing", "provision-token"],
      provisioning: ["provisioner", "billing"],
    });
    expect(plan("provisioning,zones", "build").needs).toEqual({
      [BUILD]: [],
      provisioning: [BUILD],
      zones: ["provisioning"],
    });
    expect(plan("zones").needs).toEqual({ zones: [] });
  });

  it("each prefix of the order lists every target once, needing only targets in the list", () => {
    for (let n = 1; n <= ORDER.length; n++) {
      const list = ORDER.slice(0, n);
      const r = plan(list.join(","));
      expect(r.order).toEqual(list);
      for (const t of list)
        expect(sorted(r.needs[t] ?? [])).toEqual(
          sorted((NEEDS[t] ?? []).filter((x) => list.includes(x))),
        );
    }
  });

  it("refuses an unknown, repeated or out-of-order target, an empty list and an unknown option", () => {
    for (const bad of [
      ["nope"],
      ["dispatch,dispatch"],
      ["dispatch,billing"],
      [""],
      ["dispatch", "nope"],
      ["dispatch", "build", "x"],
    ]) {
      const r = spawnSync("bash", [SCRIPT, ...bad], { encoding: "utf8" });
      expect(r.status, bad.join(" ")).toBe(2);
      expect(r.stdout).toBe("");
    }
  });
});
