import { STAGING_TEST_DOMAIN } from "@oa/provision/names";
import {
  authorize,
  fixtureOwnerKeyId,
  isApiRoute,
  ROUTE_IDS,
  TEST_INSTALL,
  TEST_MEMBER,
  testInstallActorKey,
  testInstallDeleteActorKey,
} from "@oa/provisioning-contract";
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "../src/principal.js";
import { call } from "./call.js";
import {
  APP,
  db,
  fakeEnv,
  insert,
  next,
  OIDC_P,
  requestId,
  resetDb,
  seedInstall,
  seedJob,
} from "./fakes.js";

// The disposable staging test-install workflow (staging-test-install.yml):
// R3, R4, R9, R11, R15 and R26 (hookKeyOnly only) in create mode, and R3, R9,
// R11, R15 in verified delete mode (staging only). Ownership is bound to the
// original create's GitHub-signed run_id + Ed25519 owner key fingerprint, and
// later cleanup requires a verified Ed25519 delete proof.

beforeEach(resetDb);

const ALLOWED = TEST_INSTALL.routes;
const DELETE_ALLOWED = TEST_INSTALL.deleteRoutes;
const REPO_ID = "42";
const OWNER_PUB_A = `${"A".repeat(42)}A`;
const OWNER_PUB_B = `${"B".repeat(42)}A`;
const KEY_ID_A = await fixtureOwnerKeyId(OWNER_PUB_A);
const KEY_ID_B = await fixtureOwnerKeyId(OWNER_PUB_B);

const tiCreate = (
  runId: string,
  ownerKeyId: string,
  repoId = REPO_ID,
): Principal => ({
  ...OIDC_P,
  actorKey: testInstallActorKey(repoId, runId, ownerKeyId),
  rateKey: `oidc:${repoId}${TEST_INSTALL.actorSuffix}`,
  oidcWorkflow: "test-install",
  testInstallMode: "create",
});

const tiDelete = (
  ownerKeyId: string,
  installId: string,
  repoId = REPO_ID,
): Principal => ({
  ...OIDC_P,
  actorKey: testInstallDeleteActorKey(repoId, ownerKeyId, installId),
  rateKey: `oidc:${repoId}${TEST_INSTALL.actorSuffix}`,
  oidcWorkflow: "test-install",
  testInstallMode: "delete",
});

const TI_CREATE_A = tiCreate("1001", KEY_ID_A);
const TI_CREATE_B = tiCreate("1002", KEY_ID_B);
const RL: Principal = { ...OIDC_P, oidcWorkflow: "redline" };
const TM: Principal = {
  ...OIDC_P,
  actorKey: `${OIDC_P.actorKey}${TEST_MEMBER.actorSuffix}`,
  rateKey: `${OIDC_P.actorKey}${TEST_MEMBER.actorSuffix}`,
  oidcWorkflow: "test-member",
};
const KEY = `${"C".repeat(42)}A`;

const createBody = (slug: string, over: Record<string, unknown> = {}) => ({
  requestId: requestId(),
  slug,
  ownerEmail: `fixture-owner@${STAGING_TEST_DOMAIN}`,
  tier: "team",
  testHooks: true,
  auth: {
    providers: ["email"],
    domains: [STAGING_TEST_DOMAIN],
    domainCodes: true,
  },
  ...over,
});

/** Marks an R4-created fixture active in D1 so lifecycle routes see it live. */
async function activateFixture(
  installId: string,
  slug: string,
  createJobId: string,
) {
  await insert("installs", {
    id: installId,
    slug,
    app_host: `${slug}.${APP}`,
    content_host: `${slug}.content.test`,
    owner_email: `fixture-owner@${STAGING_TEST_DOMAIN}`,
    rl_ns: 8 * next(),
    inputs_hash: "h",
    version: "1.42.0",
    previous_version: null,
    test_hooks: 1,
    state: "active",
    vars: JSON.stringify({
      AUTH_PROVIDERS: "email",
      AUTH_DOMAINS: STAGING_TEST_DOMAIN,
      EMAIL_CODE_DOMAIN: "on",
      TEST_DOMAIN: STAGING_TEST_DOMAIN,
      TIER: "team",
    }),
    lease_until: null,
    created_at: 1,
    updated_at: 1,
  });
  await db
    .prepare(
      "UPDATE signups SET install_id = ?, status = 'ready' WHERE signup_id = ?",
    )
    .bind(installId, createJobId)
    .run();
  await db
    .prepare("UPDATE jobs SET status = 'done', finished_at = 2 WHERE id = ?")
    .bind(createJobId)
    .run();
  await db
    .prepare(
      "UPDATE install_lifecycle SET serving_mode = 'serving', health = 'ok' WHERE install_id = ?",
    )
    .bind(installId)
    .run();
}

describe("authz: test-install allowlist", () => {
  it("pins prefix, suffixes, headers and routes (no R2; delete mode drops R4 and R26)", () => {
    expect(TEST_INSTALL.slugPrefix).toBe("t-");
    expect(TEST_INSTALL.actorSuffix).toBe(":test-install");
    expect(TEST_INSTALL.deleteActorSuffix).toBe(":test-install-delete");
    expect(TEST_INSTALL.ownerKeyHeader).toBe("x-oa-fixture-owner-key");
    expect(TEST_INSTALL.deleteProofHeader).toBe("x-oa-fixture-delete-proof");
    expect(TEST_INSTALL.routes).toEqual([
      "R3",
      "R4",
      "R9",
      "R11",
      "R15",
      "R26",
    ]);
    expect(TEST_INSTALL.deleteRoutes).toEqual(["R3", "R9", "R11", "R15"]);
  });

  it("staging admits only TEST_INSTALL routes with own reach; prod is 401", () => {
    const delP = tiDelete(KEY_ID_A, "iabcdefgh234");
    for (const route of ROUTE_IDS) {
      const st = authorize(route, TI_CREATE_A, "staging");
      if ((ALLOWED as readonly string[]).includes(route))
        expect(st, route).toEqual({ ok: true, reach: "own" });
      else expect(st, route).toEqual({ ok: false, code: "forbidden" });
      const dst = authorize(route, delP, "staging");
      if ((DELETE_ALLOWED as readonly string[]).includes(route))
        expect(dst, route).toEqual({ ok: true, reach: "own" });
      else expect(dst, route).toEqual({ ok: false, code: "forbidden" });
      expect(authorize(route, TI_CREATE_A, "prod"), route).toEqual({
        ok: false,
        code: "unauthenticated",
      });
      expect(authorize(route, delP, "prod"), route).toEqual({
        ok: false,
        code: "unauthenticated",
      });
    }
  });

  it("through invokeRoute: every API route off the allowlist (including R2) is 403", async () => {
    const e = fakeEnv();
    const { id } = await seedInstall({ slug: "t-any", testHooks: true });
    for (const route of ROUTE_IDS.filter(isApiRoute)) {
      if ((ALLOWED as readonly string[]).includes(route)) continue;
      const r = await call(e, TI_CREATE_A, route, { params: { id } });
      expect(r.status, route).toBe(403);
      expect(r.code, route).toBe("forbidden");
    }
  });
});

describe("R4 create validation for test-install", () => {
  it("refuses R4 when authenticated with a delete-mode proof", async () => {
    const e = fakeEnv();
    const r = await call(e, tiDelete(KEY_ID_A, "iabcdefgh234"), "R4", {
      body: createBody("t-bound"),
    });
    expect(r.status).toBe(403);
    expect(r.code).toBe("forbidden");
  });

  it("returns 400 invalid_input when auth is omitted, 403 forbidden for disallowed auth/slug/testHooks", async () => {
    const e = fakeEnv();
    const missingAuth = createBody("t-noauth");
    delete (missingAuth as { auth?: unknown }).auth;
    const r400 = await call(e, TI_CREATE_A, "R4", { body: missingAuth });
    expect(r400.status).toBe(400);
    expect(r400.code).toBe("invalid_input");

    for (const bad of [
      createBody("t-badprov", {
        auth: {
          providers: ["google"],
          domains: [STAGING_TEST_DOMAIN],
        },
      }),
      createBody("t-baddom", {
        auth: {
          providers: ["email"],
          domains: ["acme.test"],
          domainCodes: true,
        },
      }),
      createBody("t-nocodes", {
        auth: {
          providers: ["email"],
          domains: [STAGING_TEST_DOMAIN],
          domainCodes: false,
        },
      }),
      createBody("t-nohooks", { testHooks: false }),
      createBody("rl-agents"),
      createBody("customer1"),
    ]) {
      const res = await call(e, TI_CREATE_A, "R4", { body: bad });
      expect(res.status, String(bad.slug)).toBe(403);
      expect(res.code, String(bad.slug)).toBe("forbidden");
    }
  });
});

describe("two same-repo staging fixtures: create-run & cleanup isolation, hookKeyOnly R26", () => {
  it("isolates t-alpha and t-beta across create runs and later cleanup with zero cross-fixture writes", async () => {
    const e = fakeEnv();
    const adminT = await seedInstall({ slug: "t-admin", testHooks: true });
    const rlAgents = await seedInstall({ slug: "rl-agents", testHooks: true });

    // Two independent creates in the same repository (42) produce distinct creator keys.
    const aCreate = await call(e, TI_CREATE_A, "R4", {
      body: createBody("t-alpha"),
    });
    const bCreate = await call(e, TI_CREATE_B, "R4", {
      body: createBody("t-beta"),
    });
    expect(aCreate.status).toBe(202);
    expect(bCreate.status).toBe(202);
    const alphaId = aCreate.body.job.installId as string;
    const betaId = bCreate.body.job.installId as string;
    await activateFixture(alphaId, "t-alpha", aCreate.body.job.id as string);
    await activateFixture(betaId, "t-beta", bCreate.body.job.id as string);

    const aDelP = tiDelete(KEY_ID_A, alphaId);
    const bDelP = tiDelete(KEY_ID_B, betaId);
    // Owner B signing alpha's install ID gets a delete scope with KEY_ID_B (mismatched).
    const bForgingA = tiDelete(KEY_ID_B, alphaId);

    // During create run, each sees ONLY its own fixture, never the other or admin/rl installs.
    expect(
      (await call(e, TI_CREATE_A, "R3", { params: { id: alphaId } })).status,
    ).toBe(200);
    expect(
      (await call(e, TI_CREATE_B, "R3", { params: { id: betaId } })).status,
    ).toBe(200);
    const jobsBeforeCross = await db
      .prepare("SELECT COUNT(*) AS n FROM jobs")
      .first<{ n: number }>();
    for (const foreignId of [betaId, adminT.id, rlAgents.id]) {
      expect(
        (await call(e, TI_CREATE_A, "R3", { params: { id: foreignId } }))
          .status,
        foreignId,
      ).toBe(404);
      expect(
        (
          await call(e, TI_CREATE_A, "R26", {
            params: { id: foreignId },
            body: {
              requestId: requestId(),
              hookKeyOnly: true,
              recipientKey: KEY,
            },
          })
        ).status,
        foreignId,
      ).toBe(404);
    }
    // Same owner key in a DIFFERENT create run (1099 !== 1001) cannot reach alphaId.
    expect(
      (
        await call(e, tiCreate("1099", KEY_ID_A), "R3", {
          params: { id: alphaId },
        })
      ).status,
    ).toBe(404);
    // Wrong repo cannot reach alphaId even with matching run/owner key.
    expect(
      (
        await call(e, tiCreate("1001", KEY_ID_A, "99"), "R3", {
          params: { id: alphaId },
        })
      ).status,
    ).toBe(404);
    // Delete-mode principal cannot call R26 even on its own fixture.
    expect(
      (
        await call(e, aDelP, "R26", {
          params: { id: alphaId },
          body: {
            requestId: requestId(),
            hookKeyOnly: true,
            recipientKey: KEY,
          },
        })
      ).status,
    ).toBe(403);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>(),
    ).toEqual(jobsBeforeCross);

    // Generic R26 PAT mint and revoke are 403 for test-install; zero jobs started.
    for (const badCreds of [
      { requestId: requestId(), recipientKey: KEY },
      { requestId: requestId(), revoke: true },
    ]) {
      const r = await call(e, TI_CREATE_A, "R26", {
        params: { id: alphaId },
        body: badCreds,
      });
      expect(r.status).toBe(403);
      expect(r.code).toBe("forbidden");
    }
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>(),
    ).toEqual(jobsBeforeCross);

    // Non-fixture workflows (redline, test-member) cannot request hookKeyOnly.
    for (const otherP of [RL, TM]) {
      const r = await call(e, otherP, "R26", {
        params: { id: rlAgents.id },
        body: { requestId: requestId(), hookKeyOnly: true, recipientKey: KEY },
      });
      expect(r.status).toBe(403);
      expect(r.code).toBe("forbidden");
    }

    // hookKeyOnly R26 succeeds on alphaId and delivers sealed once to TI_CREATE_A only
    // (never to TI_CREATE_B or even aDelP).
    const aCreds = await call(e, TI_CREATE_A, "R26", {
      params: { id: alphaId },
      body: { requestId: requestId(), hookKeyOnly: true, recipientKey: KEY },
    });
    expect(aCreds.status).toBe(202);
    expect(aCreds.body.job.args).toEqual({
      revoke: false,
      hookKeyOnly: true,
      recipientKey: KEY,
    });
    const credsJobId = aCreds.body.job.id as string;
    await db
      .prepare(
        "UPDATE jobs SET status = 'done', sealed = 'sealed-hook-only', finished_at = 3 WHERE id = ?",
      )
      .bind(credsJobId)
      .run();
    expect(
      (await call(e, TI_CREATE_B, "R15", { params: { jobId: credsJobId } }))
        .status,
    ).toBe(404);
    expect(
      (await call(e, aDelP, "R15", { params: { jobId: credsJobId } })).body
        .sealed,
    ).toBeNull();
    expect(
      (await call(e, TI_CREATE_A, "R15", { params: { jobId: credsJobId } }))
        .body.sealed,
    ).toBe("sealed-hook-only");
    expect(
      (await call(e, TI_CREATE_A, "R15", { params: { jobId: credsJobId } }))
        .body.sealed,
    ).toBeNull();

    // Later cleanup: cross-fixture delete creates ZERO jobs; own signed delete+purge succeed.
    const jobsBeforeDel = await db
      .prepare("SELECT COUNT(*) AS n FROM jobs")
      .first<{ n: number }>();
    for (const [p, targetId, slug] of [
      [aDelP, betaId, "t-beta"],
      [bDelP, alphaId, "t-alpha"],
      [bForgingA, alphaId, "t-alpha"],
      [TI_CREATE_A, betaId, "t-beta"],
    ] as const) {
      expect(
        (
          await call(e, p, "R9", {
            params: { id: targetId },
            body: { requestId: requestId(), confirmSlug: slug },
          })
        ).status,
      ).toBe(404);
    }
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>(),
    ).toEqual(jobsBeforeDel);

    const aDel = await call(e, aDelP, "R9", {
      params: { id: alphaId },
      body: { requestId: requestId(), confirmSlug: "t-alpha" },
    });
    expect(aDel.status).toBe(202);
    await db
      .prepare("UPDATE jobs SET status = 'done', finished_at = 4 WHERE id = ?")
      .bind(aDel.body.job.id)
      .run();
    await db
      .prepare("UPDATE installs SET state = 'deleting' WHERE id = ?")
      .bind(alphaId)
      .run();
    await db
      .prepare(
        "UPDATE install_lifecycle SET deleted_at = 4, purge_at = 9999999999999 WHERE install_id = ?",
      )
      .bind(alphaId)
      .run();
    expect(
      (
        await call(e, bForgingA, "R11", {
          params: { id: alphaId },
          body: { requestId: requestId(), confirmSlug: "t-alpha" },
        })
      ).status,
    ).toBe(404);
    const aPurge = await call(e, aDelP, "R11", {
      params: { id: alphaId },
      body: { requestId: requestId(), confirmSlug: "t-alpha" },
    });
    expect(aPurge.status).toBe(202);
    expect(aPurge.body.job.kind).toBe("purge");

    // t-beta independently runs hookKeyOnly R26 and later cleanup R9 delete.
    const bCreds = await call(e, TI_CREATE_B, "R26", {
      params: { id: betaId },
      body: { requestId: requestId(), hookKeyOnly: true, recipientKey: KEY },
    });
    expect(bCreds.status).toBe(202);
    await db
      .prepare("UPDATE jobs SET status = 'done', finished_at = 5 WHERE id = ?")
      .bind(bCreds.body.job.id)
      .run();
    const bDel = await call(e, bDelP, "R9", {
      params: { id: betaId },
      body: { requestId: requestId(), confirmSlug: "t-beta" },
    });
    expect(bDel.status).toBe(202);

    // Stray job on admin-created t-* install is 404.
    const strayJob = await seedJob(adminT.id, {
      kind: "redline_creds",
      workflow: "manage_install",
      status: "done",
      actor_kind: "oidc",
      actor_key: TI_CREATE_A.actorKey,
    });
    expect(
      (await call(e, TI_CREATE_A, "R15", { params: { jobId: strayJob } }))
        .status,
    ).toBe(404);
  });
});
