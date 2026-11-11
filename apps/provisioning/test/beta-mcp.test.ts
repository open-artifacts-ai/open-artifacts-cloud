import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { TokenScope } from "@oa/provisioning-contract";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import type { McpDeps } from "../src/mcp/index.js";
import { handleMcp } from "../src/mcp/index.js";
import { mintAgentToken, principalByTokenId } from "../src/services/tokens.js";
import { seedAdmin } from "./admin.js";
import { API, ctx, db, resetDb } from "./fakes.js";

// #2096 (beta gate 4/4): the beta lists as oa-admin MCP tools. The logic is
// beta.ts's (beta-admin.test.ts covers it over HTTP); here: who may call, that
// the shared functions run, the audit surface, and the prod write behaviour
// (no server-side confirm, exactly as set_install_tier: the yes is the client's).

const sent: string[] = [];
const mailer = (fail?: Error) =>
  ({
    async send(m: { to: string }) {
      if (fail) throw fail;
      sent.push(m.to);
      return { messageId: "m1" };
    },
  }) as unknown as SendEmail;

async function connectAs(
  kind: "oauth" | "oat",
  scopes: TokenScope[],
  over: Record<string, unknown> = {},
) {
  const a = await seedAdmin(db, Date.now());
  const env = {
    ...a.env,
    WELCOME_EMAIL: mailer(),
    WELCOME_FROM: "noreply@mail.hosted.test",
    SIGNUPS_ENABLED: "invite" as const,
    ...over,
  };
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
type R = { isError?: boolean; structuredContent?: any; content: any[] };
const callIt = async (c: Client, name: string, args: Record<string, unknown>) =>
  (await c.callTool({ name, arguments: args })) as unknown as R;

const wl = (sub: string, email: string, status = "waiting") =>
  db
    .prepare(
      "INSERT INTO signup_waitlist (sub, email, note, joined_at, status) VALUES (?1, ?2, NULL, 1000, ?3)",
    )
    .bind(sub, email, status)
    .run();
let base = 0;
const audits = (action: string) =>
  db
    .prepare(
      "SELECT * FROM admin_audit WHERE action = ? AND id > ? ORDER BY id",
    )
    .bind(action, base)
    .all<Record<string, unknown>>()
    .then((r) => r.results);
const detail = (r: Record<string, unknown>) =>
  JSON.parse(String(r.detail)) as Record<string, unknown>;
const WRITE: TokenScope[] = ["installs:read", "installs:write"];

let tag = "";
beforeEach(async () => {
  await resetDb();
  sent.length = 0;
  base =
    (
      await db
        .prepare("SELECT max(id) AS m FROM admin_audit")
        .first<{ m: number | null }>()
    )?.m ?? 0;
  tag = crypto.randomUUID().slice(0, 8);
});

const TOOLS = [
  "list_waitlist",
  "beta_stats",
  "approve_waitlist",
  "allow_signup",
  "remove_allowed",
];

describe("listing", () => {
  it("lists the five tools, reads read-only and writes not", async () => {
    const c = await connectAs("oauth", WRITE);
    const { tools } = await c.listTools();
    for (const n of TOOLS) expect(tools.map((t) => t.name)).toContain(n);
    const ro = (n: string) =>
      tools.find((t) => t.name === n)?.annotations?.readOnlyHint;
    expect([ro("list_waitlist"), ro("beta_stats")]).toEqual([true, true]);
    expect([
      ro("approve_waitlist"),
      ro("allow_signup"),
      ro("remove_allowed"),
    ]).toEqual([false, false, false]);
    expect(
      Object.keys(
        tools.find((t) => t.name === "approve_waitlist")?.inputSchema
          .properties ?? {},
      ),
    ).toEqual(["subs"]);
  });
});

describe("authz", () => {
  it("an oat_ token and a grant without the scope are forbidden and audited; nothing is written", async () => {
    await wl(`s-${tag}`, `a-${tag}@acme.test`);
    const before = (await audits("authz.refused")).length;
    const cases: [Client, string, Record<string, unknown>][] = [
      [
        await connectAs("oat", WRITE),
        "approve_waitlist",
        { subs: [`s-${tag}`] },
      ],
      [await connectAs("oat", WRITE), "list_waitlist", {}],
      [
        await connectAs("oauth", ["installs:read"]),
        "allow_signup",
        { entries: [`x-${tag}@acme.test`] },
      ],
      [
        await connectAs("oauth", ["installs:read"]),
        "remove_allowed",
        { entry: "x@acme.test" },
      ],
      [await connectAs("oauth", ["installs:write"]), "list_waitlist", {}],
      [await connectAs("oauth", ["audit:read"]), "beta_stats", {}],
    ];
    for (const [c, name, args] of cases) {
      const r = await callIt(c, name, args);
      expect(r.isError, name).toBe(true);
      expect(r.structuredContent.error.code, name).toBe("forbidden");
    }
    const rows = await audits("authz.refused");
    expect(rows.length - before).toBe(cases.length);
    expect(detail(rows.at(-1) as Record<string, unknown>)).toMatchObject({
      surface: "mcp",
      tool: "beta_stats",
    });
    expect(sent).toEqual([]);
    expect(
      (
        await db
          .prepare("SELECT status FROM signup_waitlist WHERE sub = ?")
          .bind(`s-${tag}`)
          .first<{ status: string }>()
      )?.status,
    ).toBe("waiting");
  });

  it("a read-only grant may read", async () => {
    const c = await connectAs("oauth", ["installs:read"]);
    const r = await callIt(c, "beta_stats", {});
    expect(r.isError ?? false).toBe(false);
    expect(r.structuredContent).toMatchObject({ mode: "invite" });
  });
});

describe("tools", () => {
  it("list_waitlist filters by status and q", async () => {
    await wl(`a-${tag}`, `ann-${tag}@acme.test`);
    await wl(`b-${tag}`, `bob-${tag}@acme.test`, "declined");
    const c = await connectAs("oauth", WRITE);
    const w = await callIt(c, "list_waitlist", { q: tag });
    expect(w.structuredContent.items.map((i: any) => i.sub)).toEqual([
      `a-${tag}`,
    ]);
    const all = await callIt(c, "list_waitlist", { status: "all", q: tag });
    expect(all.structuredContent.items).toHaveLength(2);
    const bad = await callIt(c, "list_waitlist", { status: "nope" });
    expect(bad.isError).toBe(true);
  });

  it("approve_waitlist approves, emails, reports emailSent, audits with the surface", async () => {
    await wl(`a-${tag}`, `ann-${tag}@acme.test`);
    const c = await connectAs("oauth", WRITE);
    const r = await callIt(c, "approve_waitlist", {
      subs: [`a-${tag}`, `ghost-${tag}`],
    });
    expect(r.isError ?? false).toBe(false);
    expect(r.structuredContent.results).toEqual([
      {
        sub: `a-${tag}`,
        email: `ann-${tag}@acme.test`,
        result: "approved",
        emailSent: true,
      },
      { sub: `ghost-${tag}`, result: "not_found" },
    ]);
    expect(sent).toEqual([`ann-${tag}@acme.test`]);
    const [row] = (await audits("beta.approve")).slice(-1);
    expect(detail(row as Record<string, unknown>)).toMatchObject({
      surface: "mcp",
      tool: "approve_waitlist",
      via: "oauth",
      client: "Claude",
      sub: `a-${tag}`,
    });
  });

  it("approve_waitlist reports a send failure per sub and still approves", async () => {
    await wl(`a-${tag}`, `ann-${tag}@acme.test`);
    const c = await connectAs("oauth", WRITE, {
      WELCOME_EMAIL: mailer(Object.assign(new Error("x"), { code: "E_BAD" })),
    });
    const r = await callIt(c, "approve_waitlist", { subs: [`a-${tag}`] });
    expect(r.structuredContent.results[0]).toMatchObject({
      result: "approved",
      emailSent: false,
      emailError: "E_BAD",
    });
    expect(r.structuredContent.emailFailed).toBe(1);
    expect(await audits("beta.email_failed")).not.toHaveLength(0);
  });

  it("approve_waitlist refuses empty and oversized subs", async () => {
    const c = await connectAs("oauth", WRITE);
    expect((await callIt(c, "approve_waitlist", { subs: [] })).isError).toBe(
      true,
    );
    expect(
      (await callIt(c, "approve_waitlist", { subs: Array(101).fill("s") }))
        .isError,
    ).toBe(true);
  });

  it("allow_signup adds emails and domains with the HTTP validation and strings", async () => {
    const c = await connectAs("oauth", WRITE);
    const ok = await callIt(c, "allow_signup", {
      entries: [` New-${tag}@Acme.test `, `@${tag}.example.com`],
    });
    expect(ok.structuredContent).toEqual({
      added: [`new-${tag}@acme.test`, `@${tag}.example.com`],
    });
    const rows = await audits("beta.allow_add");
    expect(rows).toHaveLength(2);
    expect(detail(rows[0] as Record<string, unknown>)).toMatchObject({
      surface: "mcp",
      tool: "allow_signup",
      entry: `new-${tag}@acme.test`,
    });
    const gmail = await callIt(c, "allow_signup", { entries: ["@gmail.com"] });
    expect(gmail.isError).toBe(true);
    expect(gmail.content[0].text).toContain(
      "@gmail.com would let in anyone with a Gmail address. Add emails one at a time instead.",
    );
    const bad = await callIt(c, "allow_signup", { entries: ["nope"] });
    expect(bad.content[0].text).toContain(
      `"nope" isn't an email address or a domain like @acme.com.`,
    );
    const dup = await callIt(c, "allow_signup", {
      entries: [`@${tag}.example.com`],
    });
    expect(dup.content[0].text).toContain("is already on the list.");
  });

  it("remove_allowed removes, audits, and refuses an unknown entry", async () => {
    const c = await connectAs("oauth", WRITE);
    await callIt(c, "allow_signup", { entries: [`gone-${tag}@acme.test`] });
    const r = await callIt(c, "remove_allowed", {
      entry: `Gone-${tag}@acme.test`,
    });
    expect(r.structuredContent).toEqual({ removed: `gone-${tag}@acme.test` });
    const [row] = (await audits("beta.allow_remove")).slice(-1);
    expect(detail(row as Record<string, unknown>)).toMatchObject({
      surface: "mcp",
      tool: "remove_allowed",
    });
    const again = await callIt(c, "remove_allowed", {
      entry: `gone-${tag}@acme.test`,
    });
    expect(again.structuredContent.error.code).toBe("not_found");
  });

  it("prod: a write is not gated by a server confirm, like set_install_tier; the same grant works with OA_ENV=production", async () => {
    await wl(`a-${tag}`, `ann-${tag}@acme.test`);
    const c = await connectAs("oauth", WRITE, { OA_ENV: "production" });
    const r = await callIt(c, "approve_waitlist", { subs: [`a-${tag}`] });
    expect(r.isError ?? false).toBe(false);
  });
});
