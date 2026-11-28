import { STAGING_TEST_DOMAIN } from "@oa/provision/names";
import {
  authorize,
  isApiRoute,
  ROUTE_IDS,
  TEST_INSTALL,
  TEST_MEMBER,
  testInstallActorKey,
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
// R3, R4, R9, R11, R15 and R26 (hookKeyOnly only), staging only, bound by
// x-oa-fixture-install-id + creator provenance to the exact t-* test-hooks
// install it created.

beforeEach(resetDb);

const ALLOWED = TEST_INSTALL.routes;
const REPO_ID = "42";
const TI_CREATE: Principal = {
  ...OIDC_P,
  actorKey: testInstallActorKey(REPO_ID),
  rateKey: testInstallActorKey(REPO_ID),
  oidcWorkflow: "test-install",
};
const tiBound = (installId: string, repoId = REPO_ID): Principal => ({
  ...OIDC_P,
  actorKey: testInstallActorKey(repoId, installId),
  rateKey: testInstallActorKey(repoId),
  oidcWorkflow: "test-install",
});
const RL: Principal = { ...OIDC_P, oidcWorkflow: "redline" };
const TM: Principal = {
  ...OIDC_P,
  actorKey: `${OIDC_P.actorKey}${TEST_MEMBER.actorSuffix}`,
  rateKey: `${OIDC_P.actorKey}${TEST_MEMBER.actorSuffix}`,
  oidcWorkflow: "test-member",
};
const KEY = `${"A".repeat(42)}A`;

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
  it("pins prefix, suffix, header and routes (no R2)", () => {
    expect(TEST_INSTALL.slugPrefix).toBe("t-");
    expect(TEST_INSTALL.actorSuffix).toBe(":test-install");
    expect(TEST_INSTALL.installIdHeader).toBe("x-oa-fixture-install-id");
    expect(TEST_INSTALL.routes).toEqual([
      "R3",
      "R4",
      "R9",
      "R11",
      "R15",
      "R26",
    ]);
  });

  it("staging admits only TEST_INSTALL.routes with own reach; prod is 401", () => {
    for (const route of ROUTE_IDS) {
      const st = authorize(route, TI_CREATE, "staging");
      if ((ALLOWED as readonly string[]).includes(route))
        expect(st, route).toEqual({ ok: true, reach: "own" });
      else expect(st, route).toEqual({ ok: false, code: "forbidden" });
      expect(authorize(route, TI_CREATE, "prod"), route).toEqual({
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
      const r = await call(e, tiBound(id), route, { params: { id } });
      expect(r.status, route).toBe(403);
      expect(r.code, route).toBe("forbidden");
    }
  });
});

describe("R4 create validation for test-install", () => {
  it("refuses R4 when x-oa-fixture-install-id is set", async () => {
    const e = fakeEnv();
    const r = await call(e, tiBound("iabcdefgh234"), "R4", {
      body: createBody("t-bound"),
    });
    expect(r.status).toBe(403);
    expect(r.code).toBe("forbidden");
  });

  it("returns 400 invalid_input when auth is omitted, 403 forbidden for disallowed auth/slug/testHooks", async () => {
    const e = fakeEnv();
    const missingAuth = createBody("t-noauth");
    delete (missingAuth as { auth?: unknown }).auth;
    const r400 = await call(e, TI_CREATE, "R4", { body: missingAuth });
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
      const res = await call(e, TI_CREATE, "R4", { body: bad });
      expect(res.status, String(bad.slug)).toBe(403);
      expect(res.code, String(bad.slug)).toBe("forbidden");
    }
  });
});

describe("two staging fixtures: isolation, hookKeyOnly R26, and bound delete+purge", () => {
  it("isolates t-alpha and t-beta end-to-end and forbids generic PAT minting", async () => {
    const e = fakeEnv();
    const adminT = await seedInstall({ slug: "t-admin", testHooks: true });
    const rlAgents = await seedInstall({ slug: "rl-agents", testHooks: true });

    // Create two disposable staging fixtures.
    const aCreate = await call(e, TI_CREATE, "R4", {
      body: createBody("t-alpha"),
    });
    const bCreate = await call(e, TI_CREATE, "R4", {
      body: createBody("t-beta"),
    });
    expect(aCreate.status).toBe(202);
    expect(bCreate.status).toBe(202);
    const alphaId = aCreate.body.job.installId as string;
    const betaId = bCreate.body.job.installId as string;
    await activateFixture(alphaId, "t-alpha", aCreate.body.job.id as string);
    await activateFixture(betaId, "t-beta", bCreate.body.job.id as string);

    const alphaP = tiBound(alphaId);
    const betaP = tiBound(betaId);

    // Unbound principal sees nothing on R3.
    expect(
      (await call(e, TI_CREATE, "R3", { params: { id: alphaId } })).status,
    ).toBe(404);

    // Each bound principal sees ONLY its own fixture, never the other or admin/rl installs.
    expect(
      (await call(e, alphaP, "R3", { params: { id: alphaId } })).status,
    ).toBe(200);
    for (const foreignId of [betaId, adminT.id, rlAgents.id]) {
      expect(
        (await call(e, alphaP, "R3", { params: { id: foreignId } })).status,
        foreignId,
      ).toBe(404);
      expect(
        (
          await call(e, alphaP, "R26", {
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

    // Wrong repo cannot reach alphaId even with the right install ID header.
    expect(
      (await call(e, tiBound(alphaId, "99"), "R3", { params: { id: alphaId } }))
        .status,
    ).toBe(404);

    // Generic R26 PAT mint and revoke are 403 for test-install; zero jobs started.
    const jobsBefore = await db
      .prepare("SELECT COUNT(*) AS n FROM jobs")
      .first<{ n: number }>();
    for (const badCreds of [
      { requestId: requestId(), recipientKey: KEY },
      { requestId: requestId(), revoke: true },
    ]) {
      const r = await call(e, alphaP, "R26", {
        params: { id: alphaId },
        body: badCreds,
      });
      expect(r.status).toBe(403);
      expect(r.code).toBe("forbidden");
    }
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>(),
    ).toEqual(jobsBefore);

    // Non-fixture workflows (redline, test-member) cannot request hookKeyOnly.
    for (const otherP of [RL, TM]) {
      const r = await call(e, otherP, "R26", {
        params: { id: rlAgents.id },
        body: { requestId: requestId(), hookKeyOnly: true, recipientKey: KEY },
      });
      expect(r.status).toBe(403);
      expect(r.code).toBe("forbidden");
    }

    // hookKeyOnly R26 succeeds on alphaId and delivers sealed once to alphaP only.
    const aCreds = await call(e, alphaP, "R26", {
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
    // Cross-fixture R15 is 404; redline gets null; alphaP gets sealed once.
    expect(
      (await call(e, betaP, "R15", { params: { jobId: credsJobId } })).status,
    ).toBe(404);
    expect(
      (await call(e, alphaP, "R15", { params: { jobId: credsJobId } })).body
        .sealed,
    ).toBe("sealed-hook-only");
    expect(
      (await call(e, alphaP, "R15", { params: { jobId: credsJobId } })).body
        .sealed,
    ).toBeNull();

    // Cross-fixture R9 delete is 404; own R9 delete + R11 immediate purge succeed.
    expect(
      (
        await call(e, alphaP, "R9", {
          params: { id: betaId },
          body: { requestId: requestId(), confirmSlug: "t-beta" },
        })
      ).status,
    ).toBe(404);
    const aDel = await call(e, alphaP, "R9", {
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
        await call(e, betaP, "R11", {
          params: { id: alphaId },
          body: { requestId: requestId(), confirmSlug: "t-alpha" },
        })
      ).status,
    ).toBe(404);
    const aPurge = await call(e, alphaP, "R11", {
      params: { id: alphaId },
      body: { requestId: requestId(), confirmSlug: "t-alpha" },
    });
    expect(aPurge.status).toBe(202);
    expect(aPurge.body.job.kind).toBe("purge");

    // t-beta independently runs hookKeyOnly R26 and delete.
    const bCreds = await call(e, betaP, "R26", {
      params: { id: betaId },
      body: { requestId: requestId(), hookKeyOnly: true, recipientKey: KEY },
    });
    expect(bCreds.status).toBe(202);
    await db
      .prepare("UPDATE jobs SET status = 'done', finished_at = 5 WHERE id = ?")
      .bind(bCreds.body.job.id)
      .run();
    const bDel = await call(e, betaP, "R9", {
      params: { id: betaId },
      body: { requestId: requestId(), confirmSlug: "t-beta" },
    });
    expect(bDel.status).toBe(202);

    // Unused helper import check: seedJob still works for unbound R15 refusal.
    const strayJob = await seedJob(adminT.id, {
      kind: "redline_creds",
      workflow: "manage_install",
      status: "done",
      actor_kind: "oidc",
      actor_key: alphaP.actorKey,
    });
    expect(
      (await call(e, alphaP, "R15", { params: { jobId: strayJob } })).status,
    ).toBe(404);
  });
});
