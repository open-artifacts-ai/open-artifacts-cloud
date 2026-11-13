import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { TokenScope } from "@oa/provisioning-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { csrfToken } from "../src/auth/csrf.js";
import { createSession, SESSION_COOKIE } from "../src/auth/session.js";
import { ApiError } from "../src/errors.js";
import worker from "../src/index.js";
import type { McpDeps } from "../src/mcp/index.js";
import { handleMcp } from "../src/mcp/index.js";
import type { Principal } from "../src/principal.js";
import { businessApi } from "../src/routes/business.js";
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
  tokenP,
  userP,
} from "./fakes.js";

// open-artifacts#2404: the admin list and status patch, and the
// list_business_requests MCP tool. Rows are seeded straight into the table.

const IP = "192.0.2.1";
let n = 0;
const seed = (o: Record<string, unknown> = {}) => {
  const row = {
    id: `01JZ${String(++n).padStart(22, "0")}`,
    created_at: 1_000 + n,
    name: "Ana",
    email: `a${n}@acme.test`,
    company: "Acme",
    team_size: "11-50",
    needs: '["audit_log"]',
    note: null,
    source: "landing",
    instance_host: null,
    ...o,
  };
  const cols = Object.keys(row);
  return db
    .prepare(
      `INSERT INTO business_requests (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    )
    .bind(...Object.values(row))
    .run()
    .then(() => row);
};
const call = (
  p: Principal,
  method: string,
  sub: string,
  body?: unknown,
  env = fakeEnv().env,
) =>
  businessApi(
    env,
    p,
    {
      method,
      sub: sub.split("?")[0] ?? "",
      url: new URL(`https://admin.hosted.test/api/v1/business-requests${sub}`),
      body: async () => body,
    },
    IP,
  );
const code = async (f: Promise<unknown>) => {
  try {
    await f;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  return "ok";
};

let base = 0;
const audits = (action: string) =>
  db
    .prepare(
      "SELECT * FROM admin_audit WHERE action = ? AND id > ? ORDER BY id",
    )
    .bind(action, base)
    .all<Record<string, unknown>>()
    .then((r) => r.results);

beforeEach(async () => {
  await resetDb();
  base =
    (
      await db
        .prepare("SELECT max(id) AS m FROM admin_audit")
        .first<{ m: number | null }>()
    )?.m ?? 0;
});

describe("auth", () => {
  it("only an admin session; every other principal is forbidden and audited", async () => {
    const row = await seed();
    const nope: Principal[] = [
      userP("u1", "u1@acme.test"),
      OIDC_P,
      { ...ADMIN_P, kind: "system" },
      tokenP(["installs:read", "installs:write"]),
    ];
    for (const p of nope) {
      expect(await code(call(p, "GET", ""))).toBe("forbidden");
      expect(
        await code(call(p, "PATCH", `/${row.id}`, { status: "closed" })),
      ).toBe("forbidden");
    }
    expect((await audits("authz.refused")).length).toBe(nope.length * 2);
    expect(
      (
        await db
          .prepare("SELECT status FROM business_requests WHERE id = ?")
          .bind(row.id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("new");
    expect(await code(call(ADMIN_P, "GET", ""))).toBe("ok");
  });

  describe("over HTTP", () => {
    const req = (path: string, init: RequestInit = {}) =>
      new Request(`${ADMIN}/api/v1/business-requests${path}`, {
        ...init,
        headers: {
          "cf-connecting-ip": IP,
          "content-type": "application/json",
          ...init.headers,
        },
      }) as unknown as Parameters<typeof worker.fetch>[0];

    it("no credential is 401, a bad csrf token is 403, a session lists and patches", async () => {
      const env = fakeEnv().env;
      const row = await seed({ email: "http@acme.test" });
      expect(
        (
          await worker.fetch(
            req("", { headers: { origin: ADMIN } }),
            env,
            ctx(),
          )
        ).status,
      ).toBe(401);
      const { sid } = await createSession(
        env,
        { email: "me@example.com", sub: "123", authAt: Date.now() },
        Date.now(),
      );
      const cookie = `${SESSION_COOKIE}=${sid}`;
      const bad = await worker.fetch(
        req(`/${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "contacted" }),
          headers: { origin: ADMIN, cookie, "x-csrf-token": "nope" },
        }),
        env,
        ctx(),
      );
      expect(bad.status).toBe(403);
      const ok = await worker.fetch(
        req(`/${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "contacted" }),
          headers: {
            origin: ADMIN,
            cookie,
            "x-csrf-token": await csrfToken(env, sid),
          },
        }),
        env,
        ctx(),
      );
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        id: row.id,
        status: "contacted",
        statusChangedBy: "me@example.com",
      });
      const list = await worker.fetch(
        req("?status=contacted", { headers: { origin: ADMIN, cookie } }),
        env,
        ctx(),
      );
      expect(
        ((await list.json()) as { items: { id: string }[] }).items.map(
          (i) => i.id,
        ),
      ).toEqual([row.id]);
    });
  });
});

describe("the list", () => {
  it("is newest first, camel-cased, with needs as an array", async () => {
    const a = await seed({ created_at: 100, needs: '["group_sync","other"]' });
    const b = await seed({
      created_at: 300,
      note: "hi",
      source: "dashboard",
      instance_host: "acme.example.app",
    });
    const c = await seed({ created_at: 200 });
    const r = (await call(ADMIN_P, "GET", "")).body as {
      items: Record<string, unknown>[];
    };
    expect(r.items.map((i) => i.id)).toEqual([b.id, c.id, a.id]);
    expect(r.items[0]).toEqual({
      id: b.id,
      createdAt: 300,
      name: "Ana",
      email: b.email,
      company: "Acme",
      teamSize: "11-50",
      needs: ["audit_log"],
      note: "hi",
      source: "dashboard",
      instanceHost: "acme.example.app",
      status: "new",
      statusChangedAt: null,
      statusChangedBy: null,
    });
    expect(r.items[2]?.needs).toEqual(["group_sync", "other"]);
  });

  it("filters by status and refuses an unknown one", async () => {
    await seed();
    const c = await seed({ status: "closed" });
    const only = (await call(ADMIN_P, "GET", "?status=closed")).body as {
      items: { id: string }[];
    };
    expect(only.items.map((i) => i.id)).toEqual([c.id]);
    expect(await code(call(ADMIN_P, "GET", "?status=bogus"))).toBe(
      "invalid_input",
    );
  });
});

describe("the status patch", () => {
  it("sets the status, who and when, and audits it", async () => {
    const row = await seed();
    const r = await call(ADMIN_P, "PATCH", `/${row.id}`, {
      status: "contacted",
    });
    expect(r.status).toBe(200);
    const stored = await db
      .prepare("SELECT * FROM business_requests WHERE id = ?")
      .bind(row.id)
      .first<Record<string, unknown>>();
    expect(stored).toMatchObject({
      status: "contacted",
      status_changed_by: "me@example.com",
    });
    expect(stored?.status_changed_at).toBeGreaterThan(0);
    const [a] = await audits("business_request.status");
    expect(JSON.parse(String(a?.detail))).toMatchObject({
      id: row.id,
      from: "new",
      to: "contacted",
    });
  });

  it("the same status again changes and audits nothing", async () => {
    const row = await seed();
    await call(ADMIN_P, "PATCH", `/${row.id}`, { status: "closed" });
    await call(ADMIN_P, "PATCH", `/${row.id}`, { status: "closed" });
    expect(await audits("business_request.status")).toHaveLength(1);
  });

  it("refuses a bad status or extra keys, and an unknown id is not_found", async () => {
    const row = await seed();
    for (const b of [{ status: "done" }, {}, { status: "new", x: 1 }, null])
      expect(await code(call(ADMIN_P, "PATCH", `/${row.id}`, b))).toBe(
        "invalid_input",
      );
    expect(
      await code(call(ADMIN_P, "PATCH", "/nope", { status: "closed" })),
    ).toBe("not_found");
    expect(await code(call(ADMIN_P, "DELETE", `/${row.id}`))).toBe("not_found");
  });
});

describe("list_business_requests over MCP", () => {
  async function connectAs(kind: "oauth" | "oat", scopes: TokenScope[]) {
    const a = await seedAdmin(db, Date.now());
    const env = { ...a.env };
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
    return client;
  }
  type R = { isError?: boolean; structuredContent?: any };
  const callIt = async (c: Client, args: Record<string, unknown>) =>
    (await c.callTool({
      name: "list_business_requests",
      arguments: args,
    })) as unknown as R;

  it("is listed read-only", async () => {
    const c = await connectAs("oauth", ["installs:read"]);
    const { tools } = await c.listTools();
    expect(
      tools.find((t) => t.name === "list_business_requests")?.annotations
        ?.readOnlyHint,
    ).toBe(true);
  });

  it("a read grant lists newest first and filters by status", async () => {
    const old = await seed({ created_at: 10 });
    const fresh = await seed({ created_at: 20, status: "contacted" });
    const c = await connectAs("oauth", ["installs:read"]);
    const all = await callIt(c, {});
    expect(all.isError ?? false).toBe(false);
    expect(all.structuredContent.items.map((i: any) => i.id)).toEqual([
      fresh.id,
      old.id,
    ]);
    const only = await callIt(c, { status: "new" });
    expect(only.structuredContent.items.map((i: any) => i.id)).toEqual([
      old.id,
    ]);
  });

  it("an oat_ token and a grant without the scope are forbidden and audited", async () => {
    await seed();
    const before = (await audits("authz.refused")).length;
    for (const c of [
      await connectAs("oat", ["installs:read", "installs:write"]),
      await connectAs("oauth", ["audit:read"]),
      await connectAs("oauth", ["installs:write"]),
    ]) {
      const r = await callIt(c, {});
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error.code).toBe("forbidden");
    }
    expect((await audits("authz.refused")).length - before).toBe(3);
  });
});
