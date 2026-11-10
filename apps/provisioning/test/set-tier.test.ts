import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { TokenScope } from "@oa/provisioning-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { csrfToken } from "../src/auth/csrf.js";
import { createSession, SESSION_COOKIE } from "../src/auth/session.js";
import type { BillingOperatorRpc, BillingSetTierResult } from "../src/env.js";
import { ApiError } from "../src/errors.js";
import worker from "../src/index.js";
import type { McpDeps } from "../src/mcp/index.js";
import { handleMcp } from "../src/mcp/index.js";
import type { Principal } from "../src/principal.js";
import {
  SET_TIER_ACTION,
  SET_TIER_TOOL,
  setTier,
} from "../src/routes/set-tier.js";
import { mintAgentToken, principalByTokenId } from "../src/services/tokens.js";
import { seedAdmin } from "./admin.js";
import {
  ADMIN,
  ADMIN_P,
  API,
  ctx,
  db,
  fakeEnv,
  OIDC_P,
  resetDb,
  seedInstall,
  tokenP,
  userP,
} from "./fakes.js";

// #66: an operator sets an install's billing tier through billing's
// BillingOperatorRpc; authorized, audited, refused by billing while a Stripe
// subscription is live. Billing itself is fake here (its rules have their own
// tests in apps/billing).

// admin_audit is append-only and survives resetDb, so a case's rows are the
// ones for the installs it seeded.
let seeded: string[] = [];
beforeEach(async () => {
  seeded = [];
  await resetDb();
});
const seed = async (o: Parameters<typeof seedInstall>[0] = {}) => {
  const r = await seedInstall(o);
  seeded.push(r.id);
  return r;
};

const REASON = "comp for the launch partner, ticket 66";
const admin = (over: Partial<Principal> = {}): Principal => ({
  ...ADMIN_P,
  authAt: Date.now(),
  ...over,
});
const grant = (scopes: TokenScope[] = ["installs:write"]): Principal => ({
  ...tokenP(scopes),
  tokenKind: "oauth",
  client: "Claude",
});

type Call = { install: string; tier: string };
/** A fake BILLING: records calls, answers `answer` (or throws if it is an Error). */
function billing(answer?: BillingSetTierResult | Error) {
  const calls: Call[] = [];
  const rpc: BillingOperatorRpc = {
    async setTier(install, tier) {
      calls.push({ install, tier });
      if (answer instanceof Error) throw answer;
      return (
        answer ?? {
          ok: true,
          tier,
          status: "active",
          version: 4,
          updatedAt: 1234,
          previous: { tier: "solo", status: "active", version: 3 },
        }
      );
    },
  };
  return { rpc, calls };
}
const run = (
  p: Principal,
  id: string,
  body: unknown,
  b: { rpc?: BillingOperatorRpc } = billing(),
  surface: Parameters<typeof setTier>[4] = { kind: "http", ip: "192.0.2.1" },
) => {
  const { env } = fakeEnv(b.rpc ? { BILLING: b.rpc } : {});
  return setTier(env, p, id, body, surface);
};
const code = async (f: Promise<unknown>) => {
  try {
    await f;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  return "ok";
};
const audits = (action = SET_TIER_ACTION) =>
  db
    .prepare("SELECT * FROM admin_audit WHERE action = ? ORDER BY id")
    .bind(action)
    .all<Record<string, unknown>>()
    .then((r) =>
      action === SET_TIER_ACTION
        ? r.results.filter((x) => seeded.includes(String(x.install_id)))
        : r.results,
    );
const detail = (r: Record<string, unknown>) =>
  JSON.parse(String(r.detail)) as Record<string, unknown>;

describe("authz", () => {
  it("an admin session and an admin's OAuth grant with installs:write may; nothing else", async () => {
    const { id } = await seed();
    const body = { tier: "team", reason: REASON };
    expect((await run(admin(), id, body)).status).toBe(200);
    expect((await run(grant(), id, body)).status).toBe(200);
    const before = (await audits("authz.refused")).length;
    const nope: Principal[] = [
      userP("u1", "u1@acme.test"),
      OIDC_P,
      { ...ADMIN_P, kind: "system" },
      tokenP(["installs:read", "installs:write", "installs:delete"]), // an oat_
      grant(["installs:read", "audit:read"]), // a grant without write
    ];
    const b = billing();
    for (const p of nope)
      expect(await code(run(p, id, body, b)), p.kind).toBe("forbidden");
    expect(b.calls).toEqual([]);
    expect((await audits("authz.refused")).length - before).toBe(nope.length);
  });

  it("a session needs a recent sign-in; a grant does not", async () => {
    const { id } = await seed();
    const body = { tier: "team", reason: REASON };
    const b = billing();
    for (const authAt of [null, Date.now() - 11 * 60_000])
      expect(await code(run(admin({ authAt }), id, body, b))).toBe(
        "reauth_required",
      );
    expect(b.calls).toEqual([]);
    expect((await run(grant(), id, body)).status).toBe(200);
  });
});

describe("the write", () => {
  it("calls billing once with the install and tier, answers its result, and audits who, what and why", async () => {
    const { id } = await seed();
    const b = billing();
    const r = await run(admin(), id, { tier: "business", reason: REASON }, b);
    expect(b.calls).toEqual([{ install: id, tier: "business" }]);
    expect(r).toEqual({
      status: 200,
      body: {
        installId: id,
        tier: "business",
        status: "active",
        version: 4,
        updatedAt: 1234,
        previous: { tier: "solo", status: "active", version: 3 },
      },
    });
    const [row, ...rest] = await audits();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      outcome: "ok",
      install_id: id,
      actor_kind: "admin",
      actor_label: ADMIN_P.label,
    });
    expect(detail(row as Record<string, unknown>)).toMatchObject({
      tier: "business",
      reason: REASON,
      version: 4,
      previous: { tier: "solo", status: "active", version: 3 },
    });
  });

  it("each of team, business and solo goes through", async () => {
    const { id } = await seed();
    const b = billing();
    for (const tier of ["team", "business", "solo"])
      await run(admin(), id, { tier, reason: REASON }, b);
    expect(b.calls.map((c) => c.tier)).toEqual(["team", "business", "solo"]);
  });

  it("an MCP call is audited with its surface, tool and the grant's client", async () => {
    const { id } = await seed();
    await run(grant(), id, { tier: "team", reason: REASON }, billing(), {
      kind: "mcp",
      clientVersion: "9.9.9",
    });
    const [row] = await audits();
    expect(detail(row as Record<string, unknown>)).toMatchObject({
      surface: "mcp",
      tool: SET_TIER_TOOL,
      via: "oauth",
      client: "Claude",
      clientVersion: "9.9.9",
    });
  });
});

describe("refusals (each audited, none writes an ok row)", () => {
  const refusedRows = async () =>
    (await audits()).filter((r) => r.outcome === "refused");

  it("billing's subscription_active is invalid_state, with the install and billing's code in the audit", async () => {
    const { id } = await seed();
    const b = billing({ ok: false, error: "subscription_active" });
    expect(
      await code(run(admin(), id, { tier: "team", reason: REASON }, b)),
    ).toBe("invalid_state");
    const [row, ...rest] = await refusedRows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ install_id: id, code: "invalid_state" });
    expect(detail(row as Record<string, unknown>)).toMatchObject({
      billing: "subscription_active",
      tier: "team",
      reason: REASON,
    });
    expect((await audits()).filter((r) => r.outcome === "ok")).toEqual([]);
  });

  it("billing unknown_install is invalid_state; billing unavailable is unavailable", async () => {
    const { id } = await seed();
    for (const [error, want] of [
      ["unknown_install", "invalid_state"],
      ["unavailable", "unavailable"],
    ] as const)
      expect(
        await code(
          run(
            admin(),
            id,
            { tier: "team", reason: REASON },
            billing({ ok: false, error }),
          ),
        ),
        error,
      ).toBe(want);
  });

  it("a billing call that throws is unavailable and audited as unknown", async () => {
    const { id } = await seed();
    expect(
      await code(
        run(
          admin(),
          id,
          { tier: "team", reason: REASON },
          billing(new Error("boom")),
        ),
      ),
    ).toBe("unavailable");
    const [row] = await refusedRows();
    expect(detail(row as Record<string, unknown>)).toMatchObject({
      outcome: "unknown",
    });
    expect(JSON.stringify(row)).not.toContain("boom");
  });

  it("no BILLING binding is unavailable and calls nothing", async () => {
    const { id } = await seed();
    expect(
      await code(
        run(admin(), id, { tier: "team", reason: REASON }, { rpc: undefined }),
      ),
    ).toBe("unavailable");
    expect(await refusedRows()).toHaveLength(1);
  });

  it("an unknown install is not_found; a deleted one is invalid_state; billing is never called", async () => {
    const gone = await seed({ state: "deleted" });
    const b = billing();
    expect(
      await code(
        run(admin(), "iaaaaaaaaaaa", { tier: "team", reason: REASON }, b),
      ),
    ).toBe("not_found");
    expect(
      await code(run(admin(), gone.id, { tier: "team", reason: REASON }, b)),
    ).toBe("invalid_state");
    expect(b.calls).toEqual([]);
  });

  it("a bad body is invalid_input: tier outside team/business/solo, short or missing reason, extra keys", async () => {
    const { id } = await seed();
    const b = billing();
    for (const body of [
      { tier: "free", reason: REASON },
      { tier: "trial", reason: REASON },
      { tier: "enterprise", reason: REASON },
      { reason: REASON },
      { tier: "team" },
      { tier: "team", reason: "short" },
      { tier: "team", reason: REASON, extra: 1 },
      undefined,
      "team",
    ])
      expect(await code(run(admin(), id, body, b)), JSON.stringify(body)).toBe(
        "invalid_input",
      );
    expect(b.calls).toEqual([]);
  });

  it("a malformed install id is not_found", async () => {
    expect(
      await code(run(admin(), "../x", { tier: "team", reason: REASON })),
    ).toBe("not_found");
  });
});

describe("POST /api/v1/installs/:id/tier over HTTP", () => {
  const url = (id: string) => `${ADMIN}/api/v1/installs/${id}/tier`;
  const req = (id: string, init: RequestInit = {}) =>
    new Request(url(id), {
      method: "POST",
      ...init,
      headers: {
        "cf-connecting-ip": "192.0.2.1",
        "content-type": "application/json",
        ...init.headers,
      },
    }) as unknown as Parameters<typeof worker.fetch>[0];
  const errCode = async (r: Response) =>
    ((await r.json()) as { error: { code: string } }).error.code;

  it("no Origin is csrf_failed, no credential 401, GET 405, the api host has no route", async () => {
    const e = fakeEnv({ BILLING: billing().rpc });
    const { id } = await seed();
    const noOrigin = await worker.fetch(req(id, { body: "{}" }), e.env, ctx());
    expect([noOrigin.status, await errCode(noOrigin)]).toEqual([
      403,
      "csrf_failed",
    ]);
    const anon = await worker.fetch(
      req(id, { body: "{}", headers: { origin: ADMIN } }),
      e.env,
      ctx(),
    );
    expect(anon.status).toBe(401);
    const get = await worker.fetch(
      req(id, { method: "GET", headers: { origin: ADMIN } }),
      e.env,
      ctx(),
    );
    expect(get.status).toBe(405);
    const api = await worker.fetch(
      new Request(`${API}/v1/installs/${id}/tier`, {
        method: "POST",
        headers: { "cf-connecting-ip": "192.0.2.1" },
      }) as unknown as Parameters<typeof worker.fetch>[0],
      e.env,
      ctx(),
    );
    expect(api.status).toBe(404);
  });

  it("a session with a wrong x-csrf-token is refused and billing is not called", async () => {
    const b = billing();
    const e = fakeEnv({ BILLING: b.rpc });
    const { id } = await seed();
    const { sid } = await createSession(
      e.env,
      { email: "me@example.com", sub: "123", authAt: Date.now() },
      Date.now(),
    );
    for (const tok of [undefined, `${await csrfToken(e.env, sid)}x`]) {
      const r = await worker.fetch(
        req(id, {
          body: JSON.stringify({ tier: "team", reason: REASON }),
          headers: {
            origin: ADMIN,
            cookie: `${SESSION_COOKIE}=${sid}`,
            ...(tok === undefined ? {} : { "x-csrf-token": tok }),
          },
        }),
        e.env,
        ctx(),
      );
      expect([r.status, await errCode(r)]).toEqual([403, "csrf_failed"]);
    }
    expect(b.calls).toEqual([]);
  });

  it("a valid session sets the tier and the body is billing's result", async () => {
    const b = billing();
    const e = fakeEnv({ BILLING: b.rpc });
    const { id } = await seed();
    const { sid } = await createSession(
      e.env,
      { email: "me@example.com", sub: "123", authAt: Date.now() },
      Date.now(),
    );
    const r = await worker.fetch(
      req(id, {
        body: JSON.stringify({ tier: "business", reason: REASON }),
        headers: {
          origin: ADMIN,
          cookie: `${SESSION_COOKIE}=${sid}`,
          "x-csrf-token": await csrfToken(e.env, sid),
        },
      }),
      e.env,
      ctx(),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      installId: id,
      tier: "business",
      version: 4,
    });
    expect(b.calls).toEqual([{ install: id, tier: "business" }]);
    expect((await audits()).filter((a) => a.outcome === "ok")).toHaveLength(1);
  });

  it("a bearer token is refused on the admin host", async () => {
    const e = fakeEnv({ BILLING: billing().rpc });
    const { id } = await seed();
    const r = await worker.fetch(
      req(id, {
        body: "{}",
        headers: { origin: ADMIN, authorization: "Bearer oat_x" },
      }),
      e.env,
      ctx(),
    );
    expect(r.status).toBe(401);
  });
});

describe("the hosted-only admin MCP tool", () => {
  async function connectAs(
    kind: "oauth" | "oat",
    scopes: TokenScope[],
    b = billing(),
  ) {
    const a = await seedAdmin(db, Date.now());
    const env = { ...a.env, BILLING: b.rpc };
    const m = await mintAgentToken(env, a.principal, {
      kind,
      scopes,
      ...(kind === "oauth"
        ? { clientId: "client-a", clientName: "Claude" }
        : { label: "bot", ttlMinutes: 15, requestId: "req-000000000001" }),
    } as Parameters<typeof mintAgentToken>[2]);
    const deps: McpDeps = {
      oauthPrincipal: (_r, e) => principalByTokenId(e, m.tokenId, "oauth"),
    };
    const client = new Client({ name: "test-client", version: "9.9.9" }, {});
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${API}/mcp`), {
        requestInit: {
          headers: {
            authorization: `Bearer ${kind === "oat" ? (m.token as string) : "grant-access"}`,
          },
        },
        fetch: (u, init) => {
          const r = new Request(String(u), init as RequestInit);
          r.headers.set("cf-connecting-ip", "192.0.2.9");
          return kind === "oat"
            ? worker.fetch(r as Parameters<typeof worker.fetch>[0], env, ctx())
            : handleMcp(r, env, ctx(), deps);
        },
      }),
    );
    return { client, b };
  }
  const callIt = async (client: Client, args: Record<string, unknown>) =>
    (await client.callTool({
      name: SET_TIER_TOOL,
      arguments: args,
    })) as unknown as {
      isError?: boolean;
      structuredContent?: any;
      content: { text?: string }[];
    };

  it("is listed with its input schema and not read-only", async () => {
    const { client } = await connectAs("oauth", ["installs:write"]);
    const t = (await client.listTools()).tools.find(
      (x) => x.name === SET_TIER_TOOL,
    );
    expect(Object.keys(t?.inputSchema.properties ?? {}).sort()).toEqual([
      "id",
      "reason",
      "tier",
    ]);
    expect(t?.annotations?.readOnlyHint).toBe(false);
  });

  it("a grant with installs:write sets the tier", async () => {
    const { client, b } = await connectAs("oauth", ["installs:write"]);
    const { id } = await seed();
    const r = await callIt(client, { id, tier: "team", reason: REASON });
    expect(r.isError ?? false).toBe(false);
    expect(r.structuredContent).toMatchObject({ installId: id, tier: "team" });
    expect(b.calls).toEqual([{ install: id, tier: "team" }]);
    const [row] = await audits();
    expect(detail(row as Record<string, unknown>)).toMatchObject({
      surface: "mcp",
      tool: SET_TIER_TOOL,
      via: "oauth",
    });
  });

  it("a grant without installs:write and an oat_ are forbidden; billing is not called", async () => {
    const { id } = await seed();
    for (const [kind, scopes] of [
      ["oauth", ["installs:read"]],
      ["oat", ["installs:read", "installs:write", "installs:delete"]],
    ] as const) {
      const { client, b } = await connectAs(kind, [...scopes]);
      const r = await callIt(client, { id, tier: "team", reason: REASON });
      expect(r.isError, kind).toBe(true);
      expect(r.structuredContent.error.code, kind).toBe("forbidden");
      expect(b.calls, kind).toEqual([]);
    }
  });

  it("billing's refusal is a tool error with its API code", async () => {
    const { client } = await connectAs(
      "oauth",
      ["installs:write"],
      billing({ ok: false, error: "subscription_active" }),
    );
    const { id } = await seed();
    const r = await callIt(client, { id, tier: "team", reason: REASON });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe("invalid_state");
  });

  it("a tier outside team/business/solo never reaches the tool body", async () => {
    const { client, b } = await connectAs("oauth", ["installs:write"]);
    const { id } = await seed();
    const r = await callIt(client, { id, tier: "free", reason: REASON }).catch(
      (e) => ({ isError: true, thrown: String(e) }),
    );
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(b.calls).toEqual([]);
  });
});
