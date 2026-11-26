import {
  authorize,
  isApiRoute,
  ROUTE_IDS,
  TEST_MEMBER,
} from "@oa/provisioning-contract";
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "../src/principal.js";
import { call } from "./call.js";
import {
  db,
  fakeEnv,
  OIDC_P,
  requestId,
  resetDb,
  seedInstall,
  seedJob,
} from "./fakes.js";

// The staging test member's workflow (staging-test-member.yml): its OIDC
// caller may call R2, R15 and R26, on the one install `rl-agents`, staging
// only, plus R3 and R5 once the pin carries public #3167 (Leo's pick, cloud
// #264: rl-agents follows staging's release). Every other route is 403,
// every other install 404.

beforeEach(resetDb);

const BEFORE_3167 = ["R2", "R15", "R26"];
const WITH_3167 = ["R2", "R3", "R5", "R15", "R26"];
const ALLOWED = TEST_MEMBER.routes;
const UPGRADES = ALLOWED.includes("R5");
const TM: Principal = {
  ...OIDC_P,
  actorKey: `${OIDC_P.actorKey}${TEST_MEMBER.actorSuffix}`,
  rateKey: `${OIDC_P.actorKey}${TEST_MEMBER.actorSuffix}`,
  oidcWorkflow: "test-member",
};
const RL: Principal = { ...OIDC_P, oidcWorkflow: "redline" };
const TA: Principal = { ...OIDC_P, oidcWorkflow: "test-admin" };
// An obvious fake, a valid X25519 public key shape.
const KEY = `${"A".repeat(42)}A`;
const mint = () => ({ requestId: requestId(), recipientKey: KEY });

describe("authz: the test member's allowlist", () => {
  it("pins the slug, the routes and the key suffix", () => {
    expect(TEST_MEMBER.slug).toBe("rl-agents");
    expect(TEST_MEMBER.actorSuffix).toBe(":test-member");
    // One of exactly two lists: before or with public #3167, never more.
    expect([BEFORE_3167, WITH_3167]).toContainEqual([...TEST_MEMBER.routes]);
  });

  it("staging: exactly its routes, each with own reach; every other route is 403", () => {
    for (const route of ROUTE_IDS) {
      const d = authorize(route, TM, "staging");
      if ((ALLOWED as readonly string[]).includes(route))
        expect(d, route).toEqual({ ok: true, reach: "own" });
      else expect(d, route).toEqual({ ok: false, code: "forbidden" });
    }
  });

  it("prod: every route is unauthenticated", () => {
    for (const route of ROUTE_IDS)
      expect(authorize(route, TM, "prod"), route).toEqual({
        ok: false,
        code: "unauthenticated",
      });
  });

  it("through invokeRoute: every API route off the allowlist answers 403 forbidden", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall({ slug: "rl-agents", testHooks: true });
    for (const route of ROUTE_IDS.filter(isApiRoute)) {
      if ((ALLOWED as readonly string[]).includes(route)) continue;
      const r = await call(e, TM, route, { params: { id } });
      expect(r.code, route).toBe("forbidden");
      expect(r.status, route).toBe(403);
    }
  });

  it("the other OIDC scopes are unchanged: red-line keeps rl- reach and no R28; the test admin only R28", () => {
    for (const route of ROUTE_IDS) {
      const plain = authorize(route, OIDC_P, "staging");
      expect(authorize(route, RL, "staging"), route).toEqual(plain);
      if (route === "R28") expect(plain.ok).toBe(false);
      expect(authorize(route, TA, "staging").ok, route).toBe(route === "R28");
    }
    for (const r of ["R3", "R4", "R5", "R9", "R11", "R14", "R17"] as const)
      expect(authorize(r, RL, "staging"), r).toEqual({
        ok: true,
        reach: "own",
      });
  });
});

describe("reach: rl-agents with test hooks, nothing else", () => {
  async function seed() {
    return {
      agents: await seedInstall({ slug: "rl-agents", testHooks: true }),
      rlA: await seedInstall({ slug: "rl-a", testHooks: true }),
      // A near miss of the slug, on both sides.
      longer: await seedInstall({ slug: "rl-agents2", testHooks: true }),
      customer: await seedInstall({ slug: "customer1" }),
    };
  }

  it("R2 lists only rl-agents, even with a q that matches more", async () => {
    const e = fakeEnv();
    const s = await seed();
    for (const q of [undefined, "rl-", "rl-agents"]) {
      const r = await call(e, TM, "R2", q ? { query: { q } } : {});
      expect(r.status).toBe(200);
      expect(
        (r.body.items as { id: string; slug: string }[]).map((i) => i.slug),
        String(q),
      ).toEqual(["rl-agents"]);
      expect(r.body.items[0].id).toBe(s.agents.id);
    }
  });

  it("R2 lists nothing when rl-agents has no test hooks", async () => {
    const e = fakeEnv();
    await seedInstall({ slug: "rl-agents", testHooks: false });
    await seedInstall({ slug: "rl-a", testHooks: true });
    expect((await call(e, TM, "R2")).body.items).toEqual([]);
  });

  it("R26 mint and revoke on rl-agents: accepted, stored as oidc under the test member's own key", async () => {
    const e = fakeEnv();
    const s = await seed();
    const m = await call(e, TM, "R26", {
      params: { id: s.agents.id },
      body: mint(),
    });
    expect(m.status).toBe(202);
    expect(m.body.job).toMatchObject({
      kind: "redline_creds",
      args: { revoke: false, recipientKey: KEY },
    });
    const row = await db
      .prepare("SELECT actor_kind, actor_key FROM jobs WHERE id = ?")
      .bind(m.body.job.id)
      .first();
    expect(row).toEqual({ actor_kind: "oidc", actor_key: TM.actorKey });
  });

  it("R26 revoke on rl-agents is accepted", async () => {
    const e = fakeEnv();
    const s = await seed();
    const r = await call(e, TM, "R26", {
      params: { id: s.agents.id },
      body: { requestId: requestId(), revoke: true },
    });
    expect(r.status).toBe(202);
    expect(r.body.job.args).toEqual({ revoke: true });
  });

  it("R26 on any other install is 404, and starts nothing", async () => {
    const e = fakeEnv();
    const s = await seed();
    for (const i of [s.rlA, s.longer, s.customer])
      expect(
        (await call(e, TM, "R26", { params: { id: i.id }, body: mint() })).code,
        i.id,
      ).toBe("not_found");
    expect(e.manageInstall.created).toHaveLength(0);
  });

  // Public #3167: R3 and R5 on rl-agents only, so it follows staging's
  // release. Runs once the pin carries it.
  it.runIf(UPGRADES)(
    "R3 and R5 on rl-agents: read, and an upgrade accepted and stored under the test member's own key",
    async () => {
      const e = fakeEnv();
      const s = await seed();
      const r3 = await call(e, TM, "R3", { params: { id: s.agents.id } });
      expect(r3.status).toBe(200);
      expect(r3.body.slug).toBe("rl-agents");
      const up = await call(e, TM, "R5", {
        params: { id: s.agents.id },
        body: { requestId: requestId() },
      });
      expect(up.status).toBe(202);
      expect(up.body.job.kind).toBe("upgrade");
      const row = await db
        .prepare("SELECT actor_kind, actor_key FROM jobs WHERE id = ?")
        .bind(up.body.job.id)
        .first();
      expect(row).toEqual({ actor_kind: "oidc", actor_key: TM.actorKey });
    },
  );

  it.runIf(UPGRADES)(
    "R3 and R5 on any other install are 404, and start nothing",
    async () => {
      const e = fakeEnv();
      const s = await seed();
      for (const i of [s.rlA, s.longer, s.customer]) {
        expect(
          (await call(e, TM, "R3", { params: { id: i.id } })).code,
          i.id,
        ).toBe("not_found");
        expect(
          (
            await call(e, TM, "R5", {
              params: { id: i.id },
              body: { requestId: requestId() },
            })
          ).code,
          i.id,
        ).toBe("not_found");
      }
      const n = await db.prepare("SELECT COUNT(*) AS n FROM jobs").first();
      expect(n).toEqual({ n: 0 });
    },
  );

  it.runIf(!UPGRADES)("before #3167 is pinned, R3 and R5 are 403", async () => {
    const e = fakeEnv();
    const s = await seed();
    expect(
      (await call(e, TM, "R3", { params: { id: s.agents.id } })).status,
    ).toBe(403);
    expect(
      (
        await call(e, TM, "R5", {
          params: { id: s.agents.id },
          body: { requestId: requestId() },
        })
      ).status,
    ).toBe(403);
  });

  it("R26 on rl-agents without test hooks is 404", async () => {
    const e = fakeEnv();
    const a = await seedInstall({ slug: "rl-agents", testHooks: false });
    expect(
      (await call(e, TM, "R26", { params: { id: a.id }, body: mint() })).code,
    ).toBe("not_found");
  });

  it("red-line's R26 on rl-a is unchanged", async () => {
    const e = fakeEnv();
    const s = await seed();
    expect(
      (await call(e, RL, "R26", { params: { id: s.rlA.id }, body: mint() }))
        .status,
    ).toBe(202);
  });
});

describe("R15: the sealed result goes only to the test member, once", () => {
  const sealedJob = (install: string, actorKey: string) =>
    seedJob(install, {
      kind: "redline_creds",
      workflow: "manage_install",
      status: "done",
      sealed: "fake-ciphertext",
      actor_kind: "oidc",
      actor_key: actorKey,
      actor_label: OIDC_P.label,
    });

  it("its own job: sealed once; red-line never gets it", async () => {
    const e = fakeEnv();
    const a = await seedInstall({ slug: "rl-agents", testHooks: true });
    const j = await sealedJob(a.id, TM.actorKey);
    const rl = await call(e, RL, "R15", { params: { jobId: j } });
    expect(rl.status).toBe(200);
    expect(rl.body.sealed).toBeNull();
    expect(
      (await call(e, TM, "R15", { params: { jobId: j } })).body.sealed,
    ).toBe("fake-ciphertext");
    expect(
      (await call(e, TM, "R15", { params: { jobId: j } })).body.sealed,
    ).toBeNull();
  });

  it("red-line's job on rl-agents: no sealed value for the test member", async () => {
    const e = fakeEnv();
    const a = await seedInstall({ slug: "rl-agents", testHooks: true });
    const j = await sealedJob(a.id, OIDC_P.actorKey);
    expect(
      (await call(e, TM, "R15", { params: { jobId: j } })).body.sealed,
    ).toBeNull();
    expect(
      (await call(e, RL, "R15", { params: { jobId: j } })).body.sealed,
    ).toBe("fake-ciphertext");
  });

  it("a job on any other install is 404", async () => {
    const e = fakeEnv();
    const b = await seedInstall({ slug: "rl-a", testHooks: true });
    const j = await sealedJob(b.id, TM.actorKey);
    expect((await call(e, TM, "R15", { params: { jobId: j } })).code).toBe(
      "not_found",
    );
  });
});
