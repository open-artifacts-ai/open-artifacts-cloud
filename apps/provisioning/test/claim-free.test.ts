import { beforeEach, describe, expect, it } from "vitest";
import { csrfToken } from "../src/auth/csrf.js";
import { createSession, SESSION_COOKIE } from "../src/auth/session.js";
import { ApiError } from "../src/errors.js";
import worker from "../src/index.js";
import type { Principal } from "../src/principal.js";
import { CLAIM_FREE_ACTION, freeClaim } from "../src/routes/claim-free.js";
import {
  ADMIN,
  ADMIN_P,
  ctx,
  db,
  fakeEnv,
  insert,
  jobId,
  OIDC_P,
  resetDb,
  seedInstall,
  tokenP,
  userP,
} from "./fakes.js";

// #52: an operator frees a kept signup_accounts claim, with a reason, audited.

beforeEach(() => resetDb());

const NOW = () => Date.now();
const admin = (over: Partial<Principal> = {}): Principal => ({
  ...ADMIN_P,
  authAt: NOW(),
  ...over,
});
const REASON = "support ticket 123: reviewed, unbanned";

let n = 0;
/** A kept claim: signup (failed or ready) plus its claim row, install optional. */
async function seedClaim(
  o: {
    sub?: string;
    email?: string;
    installState?: "active" | "deleting" | "deleted" | null;
    status?: string;
    freedAt?: number | null;
  } = {},
) {
  const sub = o.sub ?? `sub-${++n}`;
  const email = o.email ?? `o${n}@acme.test`;
  const signupId = jobId();
  const state = o.installState === undefined ? "deleted" : o.installState;
  const inst = state ? await seedInstall({ state, ownerEmail: email }) : null;
  await insert("signups", {
    signup_id: signupId,
    source: "self-serve",
    owner_sub: sub,
    slug: `c${n}`,
    install_id: inst?.id ?? null,
    job_id: signupId,
    vars: "{}",
    status: o.status ?? "ready",
    created_at: 1,
    updated_at: 1,
  });
  await insert("signup_accounts", {
    owner_sub: sub,
    signup_id: signupId,
    created_at: 5,
    freed_at: o.freedAt ?? null,
  });
  return { sub, email, signupId };
}

const free = (p: Principal, body: unknown) => {
  const { env } = fakeEnv();
  return freeClaim(env, p, body, "192.0.2.1");
};
const refused = async (f: Promise<unknown>) => {
  try {
    await f;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  return "ok";
};
const claimRow = (sub: string) =>
  db
    .prepare("SELECT * FROM signup_accounts WHERE owner_sub = ?")
    .bind(sub)
    .first<{ freed_at: number | null }>();
// admin_audit is append-only, so rows are told apart by a detail fragment.
const audits = (has = "", action = CLAIM_FREE_ACTION) =>
  db
    .prepare(
      "SELECT * FROM admin_audit WHERE action = ? AND instr(coalesce(detail, ''), ?) > 0 ORDER BY id",
    )
    .bind(action, has)
    .all<Record<string, unknown>>()
    .then((r) => r.results);

describe("freeClaim authz", () => {
  it("refuses owners, self-serve users, tokens and OIDC; the claim stays", async () => {
    const c = await seedClaim();
    const before = (await audits("", "authz.refused")).length;
    for (const p of [
      userP(c.sub, c.email),
      tokenP(["installs:read", "installs:write", "installs:delete"]),
      OIDC_P,
      { ...ADMIN_P, kind: "system" as const },
    ])
      expect(
        await refused(free(p, { sub: c.sub, reason: REASON })),
        p.kind,
      ).toBe("forbidden");
    expect((await claimRow(c.sub))?.freed_at).toBeNull();
    expect(await audits(c.sub)).toHaveLength(0);
    expect((await audits("", "authz.refused")).length - before).toBe(4);
  });

  it("an admin session needs a recent sign-in", async () => {
    const c = await seedClaim();
    expect(
      await refused(
        free(admin({ authAt: NOW() - 11 * 60_000 }), {
          sub: c.sub,
          reason: REASON,
        }),
      ),
    ).toBe("reauth_required");
    expect((await claimRow(c.sub))?.freed_at).toBeNull();
  });
});

describe("freeClaim", () => {
  it("frees by sub and writes one audit row with who, when and why", async () => {
    const c = await seedClaim();
    const r = await free(admin(), { sub: c.sub, reason: REASON });
    expect(r.status).toBe(200);
    expect((await claimRow(c.sub))?.freed_at).toEqual(expect.any(Number));
    const [a, ...rest] = await audits(c.signupId);
    expect(rest).toHaveLength(0);
    expect(a).toMatchObject({
      actor_kind: "admin",
      actor_label: "me@example.com",
      outcome: "ok",
    });
    expect(a?.at).toEqual(expect.any(Number));
    expect(JSON.parse(a?.detail as string)).toMatchObject({
      sub: c.sub,
      signupId: c.signupId,
      reason: REASON,
    });
  });

  it("frees by email, case-insensitively; the email is stored only as an HMAC", async () => {
    const c = await seedClaim({ email: "Person@Acme.test" });
    await free(admin(), { email: "person@acme.TEST", reason: REASON });
    expect((await claimRow(c.sub))?.freed_at).not.toBeNull();
    const [a] = await audits(c.signupId);
    expect(a?.email_hmac).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(a)).not.toContain("person@acme");
  });

  it("an email that matches two accounts is refused", async () => {
    await seedClaim({ email: "dup@acme.test" });
    await seedClaim({ email: "dup@acme.test" });
    expect(
      await refused(free(admin(), { email: "dup@acme.test", reason: REASON })),
    ).toBe("invalid_input");
  });

  it("refuses while the claim's install is live, in any non-deleted state", async () => {
    const claims = [
      await seedClaim({ installState: "active" }),
      await seedClaim({ installState: "deleting" }),
      await seedClaim({ installState: null, status: "creating" }),
    ];
    for (const c of claims) {
      expect(await refused(free(admin(), { sub: c.sub, reason: REASON }))).toBe(
        "invalid_state",
      );
      expect((await claimRow(c.sub))?.freed_at).toBeNull();
      const rows = await audits(c.signupId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: "refused",
        code: "invalid_state",
      });
    }
  });

  it("concurrent double free leaves exactly one ok audit row", async () => {
    const c = await seedClaim();
    const rs = await Promise.allSettled([
      free(admin(), { sub: c.sub, reason: REASON }),
      free(admin(), { sub: c.sub, reason: REASON }),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const ok = (await audits(c.signupId)).filter((a) => a.outcome === "ok");
    expect(ok).toHaveLength(1);
    expect((await claimRow(c.sub))?.freed_at).not.toBeNull();
  });

  it("an install that goes live between the check and the write is not freed", async () => {
    const c = await seedClaim({ installState: "deleted" });
    const { env } = fakeEnv();
    const racing = {
      prepare: (q: string) => db.prepare(q),
      batch: async (st: D1PreparedStatement[]) => {
        await db
          .prepare(
            "UPDATE installs SET state = 'active' WHERE id = (SELECT install_id FROM signups WHERE signup_id = ?)",
          )
          .bind(c.signupId)
          .run();
        return db.batch(st);
      },
    } as unknown as D1Database;
    const code = await refused(
      freeClaim(
        { ...env, PLATFORM_DB: racing },
        admin(),
        {
          sub: c.sub,
          reason: REASON,
        },
        "192.0.2.1",
      ),
    );
    expect(code).toBe("invalid_state");
    expect((await claimRow(c.sub))?.freed_at).toBeNull();
    const rows = await audits(c.signupId);
    expect(rows.filter((a) => a.outcome === "ok")).toHaveLength(0);
  });

  it("requires a reason and exactly one of sub or email", async () => {
    const c = await seedClaim();
    for (const body of [
      { sub: c.sub },
      { sub: c.sub, reason: "   " },
      { sub: c.sub, reason: "short" },
      { reason: REASON },
      { sub: c.sub, email: c.email, reason: REASON },
      { sub: c.sub, reason: REASON, extra: 1 },
      undefined,
    ])
      expect(await refused(free(admin(), body)), JSON.stringify(body)).toBe(
        "invalid_input",
      );
    expect((await claimRow(c.sub))?.freed_at).toBeNull();
  });

  it("unknown account is not_found; an already-free claim is invalid_state", async () => {
    expect(
      await refused(free(admin(), { sub: "nobody", reason: REASON })),
    ).toBe("not_found");
    const c = await seedClaim({ freedAt: 9 });
    expect(await refused(free(admin(), { sub: c.sub, reason: REASON }))).toBe(
      "invalid_state",
    );
    expect((await claimRow(c.sub))?.freed_at).toBe(9);
  });

  it("a freed claim lets the account sign up again (claimAccount)", async () => {
    const c = await seedClaim();
    await free(admin(), { sub: c.sub, reason: REASON });
    const live = await db
      .prepare(
        "SELECT 1 AS x FROM signup_accounts WHERE owner_sub = ? AND freed_at IS NULL",
      )
      .bind(c.sub)
      .first();
    expect(live).toBeNull();
  });
});

describe("POST /api/v1/signup-claims/free over HTTP", () => {
  const req = (init: RequestInit = {}) =>
    new Request(`${ADMIN}/api/v1/signup-claims/free`, {
      method: "POST",
      ...init,
      headers: {
        "cf-connecting-ip": "192.0.2.1",
        "content-type": "application/json",
        ...init.headers,
      },
    }) as unknown as Parameters<typeof worker.fetch>[0];
  const code = async (r: Response) =>
    ((await r.json()) as { error: { code: string } }).error.code;

  it("no Origin is csrf_failed; no credential is 401; GET is 405; api host has no route", async () => {
    const e = fakeEnv();
    const noOrigin = await worker.fetch(req({ body: "{}" }), e.env, ctx());
    expect([noOrigin.status, await code(noOrigin)]).toEqual([
      403,
      "csrf_failed",
    ]);
    const anon = await worker.fetch(
      req({ body: "{}", headers: { origin: ADMIN } }),
      e.env,
      ctx(),
    );
    expect(anon.status).toBe(401);
    const get = await worker.fetch(
      req({ method: "GET", headers: { origin: ADMIN } }),
      e.env,
      ctx(),
    );
    expect(get.status).toBe(405);
    const api = await worker.fetch(
      new Request("https://api.hosted.test/v1/signup-claims/free", {
        method: "POST",
        headers: { "cf-connecting-ip": "192.0.2.1" },
      }) as unknown as Parameters<typeof worker.fetch>[0],
      e.env,
      ctx(),
    );
    expect(api.status).toBe(404);
  });

  it("a valid admin session with a missing or wrong x-csrf-token is refused; nothing is freed", async () => {
    const e = fakeEnv();
    const c = await seedClaim();
    const { sid } = await createSession(
      e.env,
      { email: "me@example.com", sub: "123", authAt: Date.now() },
      Date.now(),
    );
    const good = await csrfToken(e.env, sid);
    for (const tok of [
      undefined,
      "",
      `${good}x`,
      await csrfToken(e.env, "other"),
    ]) {
      const r = await worker.fetch(
        req({
          body: JSON.stringify({ sub: c.sub, reason: REASON }),
          headers: {
            origin: ADMIN,
            cookie: `${SESSION_COOKIE}=${sid}`,
            ...(tok === undefined ? {} : { "x-csrf-token": tok }),
          },
        }),
        e.env,
        ctx(),
      );
      expect([r.status, await code(r)], String(tok)).toEqual([
        403,
        "csrf_failed",
      ]);
    }
    expect((await claimRow(c.sub))?.freed_at).toBeNull();
    expect(await audits(c.signupId)).toHaveLength(0);
  });

  it("a bearer token is refused on the admin host", async () => {
    const e = fakeEnv();
    const r = await worker.fetch(
      req({
        body: "{}",
        headers: { origin: ADMIN, authorization: "Bearer oat_x" },
      }),
      e.env,
      ctx(),
    );
    expect(r.status).toBe(401);
  });
});
