import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authServer,
  refreshCapS,
  refreshTtlFor,
} from "../src/auth/oauth/server.js";
import {
  createSession,
  SESSION_COOKIE,
  sessionCookie,
} from "../src/auth/session.js";
import { adminSessionTtlMs, SESSION_TTL_MS } from "../src/auth/session-ttl.js";
import { mintAgentToken } from "../src/services/tokens.js";
import { seedAdmin } from "./admin.js";
import { platformDb } from "./db.js";
import { fakeEnv } from "./fakes.js";

// The admin session lifetime: 8 h everywhere, 168 h only on staging with
// ADMIN_SESSION_TTL_HOURS set. The helper is the one reader; the cookie, the
// session row, the grant end and the refresh cap all follow it.

const H = 3_600_000;
const T = 1_800_000_000_000;
const EIGHT = 8 * H;
const stg = (v?: unknown) => ({
  OA_ENV: "staging" as const,
  ADMIN_SESSION_TTL_HOURS: v,
});
const prod = (v?: unknown) => ({
  OA_ENV: "prod" as const,
  ADMIN_SESSION_TTL_HOURS: v,
});

describe("adminSessionTtlMs", () => {
  it("is 8 h on prod with the var unset", () => {
    expect(adminSessionTtlMs(prod())).toBe(EIGHT);
    expect(SESSION_TTL_MS).toBe(EIGHT);
  });
  it("is 8 h on prod with the var set, whatever the value", () => {
    for (const v of ["168", "24", "1", "9999"])
      expect(adminSessionTtlMs(prod(v))).toBe(EIGHT);
  });
  it("is 8 h on staging with the var unset", () => {
    expect(adminSessionTtlMs(stg())).toBe(EIGHT);
  });
  it("honours whole hours from 1 to 168 on staging", () => {
    expect(adminSessionTtlMs(stg("168"))).toBe(168 * H);
    expect(adminSessionTtlMs(stg("1"))).toBe(H);
    expect(adminSessionTtlMs(stg("24"))).toBe(24 * H);
  });
  it("falls back to 8 h on staging for anything else, and never throws", () => {
    for (const v of [
      "0",
      "-1",
      "abc",
      "169",
      "",
      " ",
      "1.5",
      "1e2",
      "0168",
      "999",
      "1000",
      "+5",
      " 24",
      168,
      null,
      {},
      [],
      undefined,
    ])
      expect(adminSessionTtlMs(stg(v))).toBe(EIGHT);
  });
  it("never exceeds 168 h", () => {
    for (let h = 1; h <= 2000; h++)
      expect(adminSessionTtlMs(stg(String(h)))).toBeLessThanOrEqual(168 * H);
  });
});

describe("what follows the helper", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the cookie Max-Age", () => {
    const e = (v: string, env: "staging" | "prod") =>
      fakeEnv({ OA_ENV: env, ADMIN_SESSION_TTL_HOURS: v }).env;
    expect(sessionCookie(e("168", "staging"), "sid")).toContain(
      `${SESSION_COOKIE}=sid; Max-Age=${168 * 3600};`,
    );
    expect(sessionCookie(e("168", "prod"), "sid")).toContain("Max-Age=28800;");
    expect(sessionCookie(fakeEnv().env, "sid")).toContain("Max-Age=28800;");
  });

  it("createSession sets the row's expiry", async () => {
    for (const [oa, v, ms] of [
      ["staging", "168", 168 * H],
      ["staging", "abc", EIGHT],
      ["prod", "168", EIGHT],
    ] as const) {
      const db = await platformDb();
      const { env } = fakeEnv({
        PLATFORM_DB: db,
        OA_ENV: oa,
        ADMIN_SESSION_TTL_HOURS: v,
      });
      const s = await createSession(
        env,
        { email: `${oa}${v}@example.com`, sub: "1", authAt: T },
        T,
      );
      expect(s.expiresAt).toBe(T + ms);
    }
  });

  it("a grant ends with its session, at most the session length (staging 168 h)", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T, {
      expires_at: T + 200 * H,
    });
    Object.assign(env, { OA_ENV: "staging", ADMIN_SESSION_TTL_HOURS: "168" });
    const m = await mintAgentToken(env, principal, {
      kind: "oauth",
      scopes: ["installs:read"],
      clientId: "c",
      clientName: "Claude",
    });
    expect(m.expiresAt).toBe(T + 168 * H);
  });

  it("a grant is capped at 8 h on prod even when the session is longer and the var is set", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T, {
      expires_at: T + 200 * H,
    });
    Object.assign(env, { OA_ENV: "prod", ADMIN_SESSION_TTL_HOURS: "168" });
    const m = await mintAgentToken(env, principal, {
      kind: "oauth",
      scopes: ["installs:read"],
      clientId: "c",
      clientName: "Claude",
    });
    expect(m.expiresAt).toBe(T + EIGHT);
  });

  it("a grant never outlives a shorter session", async () => {
    const db = await platformDb();
    const { env, principal } = await seedAdmin(db, T, {
      expires_at: T + 2 * H,
    });
    Object.assign(env, { OA_ENV: "staging", ADMIN_SESSION_TTL_HOURS: "168" });
    const m = await mintAgentToken(env, principal, {
      kind: "oauth",
      scopes: ["installs:read"],
      clientId: "c",
      clientName: "Claude",
    });
    expect(m.expiresAt).toBe(T + 2 * H);
  });

  it("the refresh cap follows the session and never passes the grant's end", () => {
    expect(refreshCapS(stg("168"))).toBe(168 * 3600);
    expect(refreshCapS(prod("168"))).toBe(8 * 3600);
    expect(refreshTtlFor(stg("168"), T + 100 * H, T)).toBe(100 * 3600);
    expect(refreshTtlFor(stg("168"), T + 500 * H, T)).toBe(168 * 3600);
    expect(refreshTtlFor(prod("168"), T + 500 * H, T)).toBe(8 * 3600);
    expect(refreshTtlFor(stg(), T + 500 * H, T)).toBe(8 * 3600);
  });

  it("authServer is cached per refresh cap, so two envs never share one", () => {
    const base = {
      APP_DOMAIN: "x.test",
      MCP_REDIRECT_URIS: "https://a.test/cb",
    };
    const a = authServer({ ...base, ...stg("168") });
    const b = authServer({ ...base, ...stg() });
    const c = authServer({ ...base, ...prod("168") });
    expect(a).not.toBe(b);
    expect(b).toBe(c);
    expect(authServer({ ...base, ...stg("168") })).toBe(a);
  });
});
