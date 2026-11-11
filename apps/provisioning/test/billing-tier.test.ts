import { InstallSummarySchema } from "@oa/provisioning-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingOperatorRpc, BillingTiersOfResult } from "../src/env.js";
import { call } from "./call.js";
import { ADMIN_P, fakeEnv, resetDb, seedInstall } from "./fakes.js";

// The billing tier on R2 and R3 (#2058): one batched BILLING.tiersOf per list
// page; unbound, missing, throwing, slow or refused: billingTier null.

beforeEach(async () => {
  await resetDb();
});
afterEach(() => vi.useRealTimers());

function billing(
  answer: (
    ids: string[],
  ) => Promise<BillingTiersOfResult> | BillingTiersOfResult,
) {
  const calls: string[][] = [];
  const rpc: BillingOperatorRpc = {
    async setTier() {
      throw new Error("not used");
    },
    async tiersOf(ids) {
      calls.push(ids);
      return answer(ids);
    },
  };
  return { rpc, calls };
}
const seedTwo = async () => {
  const a = await seedInstall({ slug: "bt-a", createdAt: 100 });
  const b = await seedInstall({ slug: "bt-b", createdAt: 101 });
  return { a: a.id, b: b.id };
};
const list = async (rpc?: BillingOperatorRpc) =>
  (await call(fakeEnv(rpc ? { BILLING: rpc } : {}), ADMIN_P, "R2")).body
    .items as {
    id: string;
    tier: string | null;
    billingTier?: string | null;
    billingStatus?: string | null;
  }[];

describe("billingTier", () => {
  it("bound: one call per page, the billing tier beside the created-as tier", async () => {
    const { a, b } = await seedTwo();
    const m = billing((ids) => ({
      ok: true,
      tiers: Object.fromEntries(
        ids.map((i) => [
          i,
          { tier: i === a ? "team" : "solo", status: "active" },
        ]),
      ),
    }));
    const items = await list(m.rpc);
    expect(m.calls).toHaveLength(1);
    expect([...m.calls[0]].sort()).toEqual([a, b].sort());
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId[a].billingTier).toBe("team");
    expect(byId[b].billingTier).toBe("solo");
    for (const i of items) InstallSummarySchema.parse(i);
  });

  it("carries the status: a lapsed Team is not shown as plain Team", async () => {
    const { a, b } = await seedTwo();
    const m = billing(() => ({
      ok: true,
      tiers: {
        [a]: { tier: "team", status: "lapsed" },
        [b]: { tier: "team", status: "weird" },
      },
    }));
    const byId = Object.fromEntries((await list(m.rpc)).map((i) => [i.id, i]));
    expect(byId[a]).toMatchObject({
      billingTier: "team",
      billingStatus: "lapsed",
    });
    expect(byId[b]).toMatchObject({ billingTier: "team", billingStatus: null });
    const d = await call(fakeEnv({ BILLING: m.rpc }), ADMIN_P, "R3", {
      params: { id: a },
    });
    expect(d.body.billingStatus).toBe("lapsed");
  });

  it("detail carries it too", async () => {
    const { a } = await seedTwo();
    const m = billing(() => ({
      ok: true,
      tiers: { [a]: { tier: "business", status: "active" } },
    }));
    const r = await call(fakeEnv({ BILLING: m.rpc }), ADMIN_P, "R3", {
      params: { id: a },
    });
    expect(r.body.billingTier).toBe("business");
    expect(r.body.tier).toBe("team");
  });

  it("unbound: null, the request succeeds", async () => {
    await seedTwo();
    for (const i of await list()) expect(i.billingTier).toBeNull();
  });

  it("the method is missing (billing deployed later): null", async () => {
    await seedTwo();
    const rpc = {
      async setTier() {
        throw new Error("not used");
      },
    } as BillingOperatorRpc;
    for (const i of await list(rpc)) expect(i.billingTier).toBeNull();
  });

  it("billing throws, refuses, or answers an unknown tier: null", async () => {
    await seedTwo();
    const cases = [
      billing(() => {
        throw new Error("down");
      }),
      billing(() => ({ ok: false, error: "unavailable" })),
      billing((ids) => ({
        ok: true,
        tiers: Object.fromEntries(
          ids.map((i) => [i, { tier: "gold", status: "x" }]),
        ),
      })),
    ];
    for (const m of cases)
      for (const i of await list(m.rpc)) expect(i.billingTier).toBeNull();
  });

  it("a slow billing is cut off: null, and the request still answers", async () => {
    await seedTwo();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = billing(() => new Promise(() => {}));
    const p = list(m.rpc);
    await vi.advanceTimersByTimeAsync(2000);
    for (const i of await p) expect(i.billingTier).toBeNull();
  });
});
