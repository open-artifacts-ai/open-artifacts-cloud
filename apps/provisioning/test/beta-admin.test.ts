import { beforeEach, describe, expect, it } from "vitest";
import { csrfToken } from "../src/auth/csrf.js";
import { createSession, SESSION_COOKIE } from "../src/auth/session.js";
import { ApiError } from "../src/errors.js";
import worker from "../src/index.js";
import type { Principal } from "../src/principal.js";
import { betaApi, PUBLIC_MAIL_DOMAINS } from "../src/routes/beta.js";
import { approvalEmail } from "../src/signup/approval-email.js";
import {
  ADMIN,
  ADMIN_P,
  ctx,
  db,
  fakeEnv,
  OIDC_P,
  resetDb,
  seedInstall,
  tokenP,
  userP,
} from "./fakes.js";

// #2096 (beta gate 3/4): the admin API behind the Beta tab. The tables are
// PR 1's (migration 0013); the email goes through the WELCOME_EMAIL fake.

type Sent = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};
function mailer(fail?: Error) {
  const sent: Sent[] = [];
  const rpc = {
    async send(m: Sent) {
      if (fail) throw fail;
      sent.push(m);
      return { messageId: "m1" };
    },
  } as unknown as SendEmail;
  return { sent, rpc };
}
const envWith = (m = mailer(), over = {}) =>
  fakeEnv({
    WELCOME_EMAIL: m.rpc,
    WELCOME_FROM: "noreply@mail.hosted.test",
    SIGNUPS_ENABLED: "invite",
    SIGNUP_DAILY_CAP: "20",
    ...over,
  }).env;

const IP = "192.0.2.1";
const url = (p: string) => new URL(`https://admin.hosted.test/api/v1/beta${p}`);
const call = (
  env: ReturnType<typeof envWith>,
  p: Principal,
  method: string,
  sub: string,
  body?: unknown,
) =>
  betaApi(
    env,
    p,
    {
      method,
      sub: sub.split("?")[0] ?? "",
      url: url(sub),
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
const msg = async (f: Promise<unknown>) => {
  try {
    await f;
  } catch (e) {
    if (e instanceof ApiError) return e.message;
    throw e;
  }
  return "ok";
};

const wl = (
  sub: string,
  email: string,
  o: { note?: string | null; at?: number; status?: string } = {},
) =>
  db
    .prepare(
      "INSERT INTO signup_waitlist (sub, email, note, joined_at, status) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(sub, email, o.note ?? null, o.at ?? 1000, o.status ?? "waiting")
    .run();
const rows = <T = Record<string, unknown>>(sql: string, ...b: unknown[]) =>
  db
    .prepare(sql)
    .bind(...b)
    .all<T>()
    .then((r) => r.results);
// admin_audit is append-only and survives resetDb: a case sees its own rows.
let base = 0;
const audits = (action: string) =>
  rows<Record<string, unknown>>(
    "SELECT * FROM admin_audit WHERE action = ? AND id > ? ORDER BY id",
    action,
    base,
  );

let tag = "";
beforeEach(async () => {
  await resetDb();
  base =
    (
      await db
        .prepare("SELECT max(id) AS m FROM admin_audit")
        .first<{ m: number | null }>()
    )?.m ?? 0;
  tag = crypto.randomUUID().slice(0, 8);
});

describe("auth", () => {
  it("only an admin session; every other principal is forbidden and audited", async () => {
    const env = envWith();
    const before = (await audits("authz.refused")).length;
    const nope: Principal[] = [
      userP("u1", "u1@acme.test"),
      OIDC_P,
      { ...ADMIN_P, kind: "system" },
      tokenP(["installs:read", "installs:write"]),
    ];
    for (const p of nope) {
      expect(await code(call(env, p, "GET", "/stats")), p.kind).toBe(
        "forbidden",
      );
      expect(
        await code(call(env, p, "POST", "/allowlist", { entries: ["a@b.co"] })),
        p.kind,
      ).toBe("forbidden");
    }
    expect((await audits("authz.refused")).length - before).toBe(
      nope.length * 2,
    );
    expect(await rows("SELECT * FROM signup_allowlist")).toEqual([]);
    expect((await call(env, ADMIN_P, "GET", "/stats")).status).toBe(200);
  });

  describe("over HTTP", () => {
    const req = (path: string, init: RequestInit = {}) =>
      new Request(`${ADMIN}/api/v1/beta${path}`, {
        ...init,
        headers: {
          "cf-connecting-ip": IP,
          "content-type": "application/json",
          ...init.headers,
        },
      }) as unknown as Parameters<typeof worker.fetch>[0];

    it("no credential is 401, a bad csrf token is refused, a session works", async () => {
      const env = envWith();
      const anon = await worker.fetch(
        req("/stats", { headers: { origin: ADMIN } }),
        env,
        ctx(),
      );
      expect(anon.status).toBe(401);
      const { sid } = await createSession(
        env,
        { email: "me@example.com", sub: "123", authAt: Date.now() },
        Date.now(),
      );
      const cookie = `${SESSION_COOKIE}=${sid}`;
      const bad = await worker.fetch(
        req("/allowlist", {
          method: "POST",
          body: JSON.stringify({ entries: ["a@b.co"] }),
          headers: { origin: ADMIN, cookie, "x-csrf-token": "nope" },
        }),
        env,
        ctx(),
      );
      expect(bad.status).toBe(403);
      const ok = await worker.fetch(
        req("/allowlist", {
          method: "POST",
          body: JSON.stringify({ entries: ["a@b.co"] }),
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
      const list = await worker.fetch(
        req("/allowlist", { headers: { origin: ADMIN, cookie } }),
        env,
        ctx(),
      );
      expect(
        ((await list.json()) as { items: { entry: string }[] }).items.map(
          (i) => i.entry,
        ),
      ).toEqual(["a@b.co"]);
      const del = await worker.fetch(
        req(`/allowlist/${encodeURIComponent("a@b.co")}`, {
          method: "DELETE",
          headers: {
            origin: ADMIN,
            cookie,
            "x-csrf-token": await csrfToken(env, sid),
          },
        }),
        env,
        ctx(),
      );
      expect(del.status).toBe(200);
      const none = await worker.fetch(
        req("/nope", { headers: { origin: ADMIN, cookie } }),
        env,
        ctx(),
      );
      expect(none.status).toBe(404);
    });
  });
});

describe("the waitlist list", () => {
  it("oldest first, waiting by default, declined on request, searchable by email or note", async () => {
    const env = envWith();
    await wl("s3", "carol@acme.com", {
      at: 3000,
      note: "Status pages for agents",
    });
    await wl("s1", "alice@acme.com", { at: 1000 });
    await wl("s2", "bob@other.io", { at: 2000, note: "client reports" });
    await wl("s4", "dan@acme.com", { at: 500, status: "declined" });
    await wl("s5", "eve@acme.com", { at: 600, status: "approved" });
    const emails = async (q = "") =>
      (
        (await call(env, ADMIN_P, "GET", `/waitlist${q}`)).body as {
          items: { email: string }[];
        }
      ).items.map((i) => i.email);
    expect(await emails()).toEqual([
      "alice@acme.com",
      "bob@other.io",
      "carol@acme.com",
    ]);
    expect(await emails("?status=declined")).toEqual(["dan@acme.com"]);
    expect(await emails("?status=all")).toHaveLength(5);
    expect(await emails("?q=OTHER")).toEqual(["bob@other.io"]);
    expect(await emails("?q=status%20pages")).toEqual(["carol@acme.com"]);
    expect(await emails("?q=%25")).toEqual([]);
    expect(
      await code(call(env, ADMIN_P, "GET", "/waitlist?status=bogus")),
    ).toBe("invalid_input");
  });

  it("returns the note raw (the panel renders it as text)", async () => {
    const env = envWith();
    await wl("s1", "a@acme.com", { note: "<img src=x onerror=alert(1)>‮" });
    const { items } = (await call(env, ADMIN_P, "GET", "/waitlist")).body as {
      items: { note: string }[];
    };
    expect(items[0]?.note).toBe("<img src=x onerror=alert(1)>‮");
  });
});

describe("approve", () => {
  it("allows the exact email, marks the row, sends the email and audits", async () => {
    const m = mailer();
    const env = envWith(m);
    await wl("s1", "Maya@Acme.com");
    const r = await call(env, ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1"],
    });
    expect(r.body).toMatchObject({
      approved: 1,
      emailFailed: 0,
      results: [{ sub: "s1", result: "approved", emailSent: true }],
    });
    expect(await rows("SELECT entry, added_by FROM signup_allowlist")).toEqual([
      { entry: "maya@acme.com", added_by: ADMIN_P.email ?? ADMIN_P.label },
    ]);
    expect(
      await rows("SELECT status, decided_by FROM signup_waitlist"),
    ).toMatchObject([{ status: "approved" }]);
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toMatchObject({
      from: "noreply@mail.hosted.test",
      to: "maya@acme.com",
      subject: "You're in: Open Artifacts beta",
    });
    expect(m.sent[0]?.text).toContain(
      "Sign in with maya@acme.com at https://signup.hosted.test/. It's free during the private beta.",
    );
    const [a, ...rest] = await audits("beta.approve");
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ outcome: "ok", actor_kind: "admin" });
  });

  it("is idempotent: a second approve sends nothing and audits nothing", async () => {
    const m = mailer();
    const env = envWith(m);
    await wl("s1", "a@acme.com");
    await call(env, ADMIN_P, "POST", "/waitlist/approve", { subs: ["s1"] });
    const again = await call(env, ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1", "s1", "ghost"],
    });
    expect(again.body).toMatchObject({
      approved: 0,
      results: [
        { result: "already_approved" },
        { sub: "ghost", result: "not_found" },
      ],
    });
    expect(m.sent).toHaveLength(1);
    expect(await audits("beta.approve")).toHaveLength(1);
    expect(await rows("SELECT * FROM signup_allowlist")).toHaveLength(1);
  });

  it("approves many in one call, one email each", async () => {
    const m = mailer();
    const env = envWith(m);
    await wl("s1", "a@acme.com");
    await wl("s2", "b@acme.com");
    await wl("s3", "c@acme.com");
    const r = await call(env, ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1", "s2", "s3"],
    });
    expect((r.body as { approved: number }).approved).toBe(3);
    expect(m.sent.map((s) => s.to).sort()).toEqual([
      "a@acme.com",
      "b@acme.com",
      "c@acme.com",
    ]);
  });

  it("a declined person can still be approved", async () => {
    const m = mailer();
    const env = envWith(m);
    await wl("s1", "a@acme.com");
    await call(env, ADMIN_P, "POST", "/waitlist/decline", { sub: "s1" });
    expect(m.sent).toEqual([]);
    const r = await call(env, ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1"],
    });
    expect(r.body).toMatchObject({ approved: 1 });
    expect(await rows("SELECT status FROM signup_waitlist")).toEqual([
      { status: "approved" },
    ]);
    expect(await rows("SELECT entry FROM signup_allowlist")).toEqual([
      { entry: "a@acme.com" },
    ]);
    expect(m.sent).toHaveLength(1);
  });

  it("an email failure still records the approval, is reported and audited", async () => {
    const m = mailer(
      Object.assign(new Error("boom"), { code: "E_SENDER_NOT_VERIFIED" }),
    );
    const env = envWith(m);
    await wl("s1", "a@acme.com");
    const r = await call(env, ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1"],
    });
    expect(r.body).toMatchObject({
      approved: 1,
      emailFailed: 1,
      results: [
        {
          result: "approved",
          emailSent: false,
          emailError: "E_SENDER_NOT_VERIFIED",
        },
      ],
    });
    expect(await rows("SELECT status FROM signup_waitlist")).toEqual([
      { status: "approved" },
    ]);
    expect(await rows("SELECT entry FROM signup_allowlist")).toEqual([
      { entry: "a@acme.com" },
    ]);
    const [f] = await audits("beta.email_failed");
    expect(f).toMatchObject({ outcome: "error", code: "email_failed" });
    // a later approve does not resend
    await call(envWith(mailer()), ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1"],
    });
  });

  it("with no sender bound, the approval stands and the failure says why", async () => {
    const env = fakeEnv({ SIGNUPS_ENABLED: "invite" }).env;
    await wl("s1", "a@acme.com");
    const r = await call(env, ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1"],
    });
    expect(r.body).toMatchObject({
      approved: 1,
      emailFailed: 1,
      results: [{ emailError: "email_not_configured" }],
    });
    expect(await rows("SELECT status FROM signup_waitlist")).toEqual([
      { status: "approved" },
    ]);
  });

  it("refuses an empty or oversized subs list", async () => {
    const env = envWith();
    expect(
      await code(call(env, ADMIN_P, "POST", "/waitlist/approve", { subs: [] })),
    ).toBe("invalid_input");
    expect(
      await code(call(env, ADMIN_P, "POST", "/waitlist/approve", {})),
    ).toBe("invalid_input");
  });
});

describe("decline", () => {
  it("is quiet: no email, no allow-list entry, an audit row, and it is idempotent", async () => {
    const m = mailer();
    const env = envWith(m);
    await wl("s1", "a@acme.com");
    expect(
      (await call(env, ADMIN_P, "POST", "/waitlist/decline", { sub: "s1" }))
        .body,
    ).toMatchObject({ status: "declined" });
    await call(env, ADMIN_P, "POST", "/waitlist/decline", { sub: "s1" });
    expect(m.sent).toEqual([]);
    expect(await rows("SELECT * FROM signup_allowlist")).toEqual([]);
    expect(
      await rows("SELECT status, decided_by FROM signup_waitlist"),
    ).toMatchObject([{ status: "declined" }]);
    expect(await audits("beta.decline")).toHaveLength(1);
  });

  it("unknown is not_found; approved is invalid_state", async () => {
    const env = envWith();
    await wl("s1", "a@acme.com", { status: "approved" });
    expect(
      await code(
        call(env, ADMIN_P, "POST", "/waitlist/decline", { sub: "nope" }),
      ),
    ).toBe("not_found");
    expect(
      await code(
        call(env, ADMIN_P, "POST", "/waitlist/decline", { sub: "s1" }),
      ),
    ).toBe("invalid_state");
  });
});

describe("the allow list", () => {
  it("lists newest first with kind and who added it", async () => {
    const env = envWith();
    await db.batch([
      db.prepare("INSERT INTO signup_allowlist VALUES ('old@a.co','x',1)"),
      db.prepare("INSERT INTO signup_allowlist VALUES ('@new.co','y',3)"),
      db.prepare("INSERT INTO signup_allowlist VALUES ('mid@a.co','z',2)"),
    ]);
    const { items } = (await call(env, ADMIN_P, "GET", "/allowlist")).body as {
      items: { entry: string; kind: string; addedBy: string }[];
    };
    expect(items.map((i) => i.entry)).toEqual([
      "@new.co",
      "mid@a.co",
      "old@a.co",
    ]);
    expect(items[0]).toMatchObject({ kind: "domain", addedBy: "y" });
  });

  it("normalizes to lower(trim()) before validating and inserting", async () => {
    const env = envWith();
    const r = await call(env, ADMIN_P, "POST", "/allowlist", {
      entries: ["  Maya@ACME.com ", "@ACME.COM"],
    });
    expect(r.body).toMatchObject({ added: ["maya@acme.com", "@acme.com"] });
    expect(
      (
        await rows<{ entry: string }>(
          "SELECT entry FROM signup_allowlist ORDER BY entry",
        )
      ).map((x) => x.entry),
    ).toEqual(["@acme.com", "maya@acme.com"]);
    // the same entry in another spelling is a duplicate
    expect(
      await msg(
        call(env, ADMIN_P, "POST", "/allowlist", {
          entries: [" MAYA@acme.com"],
        }),
      ),
    ).toBe("maya@acme.com is already on the list.");
  });

  it("names each kind of bad entry with Product's strings; any bad entry refuses the whole call, naming every one", async () => {
    const env = envWith();
    await db
      .prepare("INSERT INTO signup_allowlist VALUES ('maya@acme.com','x',1)")
      .run();
    const cases: [string[], string][] = [
      [["acme"], `"acme" isn't an email address or a domain like @acme.com.`],
      [["@acme"], `"@acme" isn't an email address or a domain like @acme.com.`],
      [
        ["a b@c.co"],
        `"a b@c.co" isn't an email address or a domain like @acme.com.`,
      ],
      [["x@y"], `"x@y" isn't an email address or a domain like @acme.com.`],
      [[""], `"" isn't an email address or a domain like @acme.com.`],
      [["maya@acme.com"], "maya@acme.com is already on the list."],
      [["new@a.co", "new@a.co"], "new@a.co is already on the list."],
      [
        ["@gmail.com"],
        "@gmail.com would let in anyone with a Gmail address. Add emails one at a time instead.",
      ],
      [
        ["ok@a.co", "lee@initech.com", "acme", "@gmail.com", "maya@acme.com"],
        [
          `"acme" isn't an email address or a domain like @acme.com.`,
          "@gmail.com would let in anyone with a Gmail address. Add emails one at a time instead.",
          "maya@acme.com is already on the list.",
        ].join("\n"),
      ],
    ];
    for (const [entries, want] of cases) {
      expect(
        await msg(call(env, ADMIN_P, "POST", "/allowlist", { entries })),
        entries.join(),
      ).toBe(want);
      expect(
        await code(call(env, ADMIN_P, "POST", "/allowlist", { entries })),
        entries.join(),
      ).toBe("invalid_input");
    }
    // nothing from any refused call was added
    expect(await rows("SELECT entry FROM signup_allowlist")).toEqual([
      { entry: "maya@acme.com" },
    ]);
    expect(
      (await audits("beta.allow_add")).every((a) => a.outcome === "refused"),
    ).toBe(true);
    // the details list every bad entry, one per line of the message
    const err = await call(env, ADMIN_P, "POST", "/allowlist", {
      entries: ["acme", "ok@a.co", "x@y"],
    }).catch((e) => e as ApiError);
    expect((err as ApiError).details).toMatchObject({
      errors: [{ entry: "acme" }, { entry: "x@y" }],
    });
  });

  it("refuses every public mail domain, by name; an exact public address is fine", async () => {
    const env = envWith();
    expect(Object.keys(PUBLIC_MAIL_DOMAINS).sort()).toEqual(
      [
        "gmail.com",
        "googlemail.com",
        "hotmail.com",
        "icloud.com",
        "outlook.com",
        "proton.me",
        "protonmail.com",
        "yahoo.com",
        "aol.com",
        "live.com",
        "msn.com",
        "me.com",
        "mac.com",
        "gmx.com",
        "gmx.de",
        "yandex.com",
        "yandex.ru",
        "mail.com",
        "zoho.com",
      ].sort(),
    );
    for (const [d, brand] of Object.entries(PUBLIC_MAIL_DOMAINS))
      expect(
        await msg(
          call(env, ADMIN_P, "POST", "/allowlist", {
            entries: [`@${d.toUpperCase()}`],
          }),
        ),
      ).toBe(
        `@${d} would let in anyone with a ${brand} address. Add emails one at a time instead.`,
      );
    expect(
      (
        await call(env, ADMIN_P, "POST", "/allowlist", {
          entries: ["j.okafor@gmail.com"],
        })
      ).status,
    ).toBe(200);
  });

  it("adds several at once and audits each", async () => {
    const m = mailer();
    const env = envWith(m);
    const r = await call(env, ADMIN_P, "POST", "/allowlist", {
      entries: ["ada@lovelace.dev", "@northwind.io", "grace@hopper.org"],
    });
    expect((r.body as { added: string[] }).added).toHaveLength(3);
    expect(await audits("beta.allow_add")).toHaveLength(3);
    // no waitlist rows: nobody is approved or emailed
    expect(m.sent).toEqual([]);
  });

  it("an exact email with a waiting or declined row is approved and emailed, as Approve does", async () => {
    const m = mailer();
    const env = envWith(m);
    await wl("s1", "maya@acme.com");
    await wl("s2", "dan@acme.com", { status: "declined" });
    const r = await call(env, ADMIN_P, "POST", "/allowlist", {
      entries: ["Maya@acme.com", "dan@acme.com", "new@acme.com"],
    });
    expect((r.body as { results: unknown[] }).results).toEqual([
      { entry: "maya@acme.com", approved: true, emailSent: true },
      { entry: "dan@acme.com", approved: true, emailSent: true },
      { entry: "new@acme.com" },
    ]);
    expect(
      (
        await rows<{ status: string }>("SELECT status FROM signup_waitlist")
      ).map((x) => x.status),
    ).toEqual(["approved", "approved"]);
    expect(m.sent.map((x) => x.to).sort()).toEqual([
      "dan@acme.com",
      "maya@acme.com",
    ]);
    expect(m.sent[0]?.subject).toBe("You're in: Open Artifacts beta");
    expect(await audits("beta.approve")).toHaveLength(2);
    expect(await rows("SELECT entry FROM signup_allowlist")).toHaveLength(3);
  });

  it("an email failure on add still records the approval and is reported per entry", async () => {
    const m = mailer(
      Object.assign(new Error("boom"), { code: "E_SENDER_NOT_VERIFIED" }),
    );
    const env = envWith(m);
    await wl("s1", "maya@acme.com");
    const r = await call(env, ADMIN_P, "POST", "/allowlist", {
      entries: ["maya@acme.com"],
    });
    expect((r.body as { results: unknown[] }).results).toEqual([
      {
        entry: "maya@acme.com",
        approved: true,
        emailSent: false,
        emailError: "E_SENDER_NOT_VERIFIED",
      },
    ]);
    expect(await rows("SELECT status FROM signup_waitlist")).toEqual([
      { status: "approved" },
    ]);
    expect(await rows("SELECT entry FROM signup_allowlist")).toEqual([
      { entry: "maya@acme.com" },
    ]);
    expect(await audits("beta.email_failed")).toHaveLength(1);
  });

  it("a whole-domain add approves and emails nobody, leaves rows waiting, and counts them", async () => {
    const m = mailer();
    const env = envWith(m);
    await wl("s1", "maya@acme.com");
    await wl("s2", "sam@acme.com");
    await wl("s3", "dan@acme.com", { status: "declined" });
    await wl("s4", "eve@notacme.com");
    await wl("s5", "li@sub.acme.com");
    const r = await call(env, ADMIN_P, "POST", "/allowlist", {
      entries: ["@ACME.com", "@empty.io"],
    });
    expect((r.body as { results: unknown[] }).results).toEqual([
      { entry: "@acme.com", waitingOnDomain: 2 },
      { entry: "@empty.io", waitingOnDomain: 0 },
    ]);
    expect(m.sent).toEqual([]);
    expect(await audits("beta.approve")).toEqual([]);
    expect(
      (
        await rows<{ status: string }>(
          "SELECT status FROM signup_waitlist ORDER BY sub",
        )
      ).map((x) => x.status),
    ).toEqual(["waiting", "waiting", "declined", "waiting", "waiting"]);
  });

  it("removing an entry that came from an approved row puts that row back to waiting", async () => {
    const m = mailer();
    const env = envWith(m);
    await wl("s1", "maya@acme.com");
    await wl("s2", "sam@acme.com");
    await call(env, ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1", "s2"],
    });
    expect(
      await rows(
        "SELECT status, decided_by, emailed_at FROM signup_waitlist WHERE sub = 's1'",
      ),
    ).toMatchObject([{ status: "approved", emailed_at: expect.any(Number) }]);
    await call(env, ADMIN_P, "DELETE", "/allowlist/Maya%40acme.com");
    expect(
      await rows(
        "SELECT sub, status, decided_by, decided_at, emailed_at FROM signup_waitlist ORDER BY sub",
      ),
    ).toMatchObject([
      {
        sub: "s1",
        status: "waiting",
        decided_by: null,
        decided_at: null,
        emailed_at: null,
      },
      { sub: "s2", status: "approved", emailed_at: expect.any(Number) },
    ]);
    // approvable again, and emailed again
    const r = await call(env, ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1"],
    });
    expect(r.body).toMatchObject({ approved: 1 });
    expect(m.sent.filter((x) => x.to === "maya@acme.com")).toHaveLength(2);
    // a domain entry's removal resets nobody
    await call(env, ADMIN_P, "POST", "/allowlist", { entries: ["@zed.io"] });
    await call(env, ADMIN_P, "DELETE", "/allowlist/%40zed.io");
    expect(
      await rows("SELECT status FROM signup_waitlist ORDER BY sub"),
    ).toEqual([{ status: "approved" }, { status: "approved" }]);
  });

  it("remove deletes only the entry: installs, sign-ups and the waitlist stay", async () => {
    const env = envWith();
    const { id } = await seedInstall({
      ownerEmail: `owner-${tag}@acme.com`,
    } as never);
    await wl("s1", "owner@acme.com", { status: "approved" });
    await db
      .prepare("INSERT INTO signup_allowlist VALUES ('@acme.com','x',1)")
      .run();
    const installBefore = await rows("SELECT * FROM installs WHERE id = ?", id);
    const signupsBefore = await rows("SELECT * FROM signups");
    const r = await call(
      env,
      ADMIN_P,
      "DELETE",
      `/allowlist/${encodeURIComponent("@ACME.com")}`,
    );
    expect(r.body).toEqual({ removed: "@acme.com" });
    expect(await rows("SELECT * FROM signup_allowlist")).toEqual([]);
    expect(await rows("SELECT * FROM installs WHERE id = ?", id)).toEqual(
      installBefore,
    );
    expect(await rows("SELECT * FROM signups")).toEqual(signupsBefore);
    expect(await rows("SELECT status FROM signup_waitlist")).toEqual([
      { status: "approved" },
    ]);
    expect(installBefore).toHaveLength(1);
    const [a] = await audits("beta.allow_remove");
    expect(a).toMatchObject({ outcome: "ok" });
    expect(
      await code(call(env, ADMIN_P, "DELETE", "/allowlist/%40acme.com")),
    ).toBe("not_found");
  });
});

describe("resend", () => {
  it("an approved row whose email never went is emailed again; one that went stays already_approved", async () => {
    const bad = mailer(Object.assign(new Error("boom"), { code: "E_DOWN" }));
    await wl("s1", "a@acme.com");
    await wl("s2", "b@acme.com");
    await call(envWith(bad), ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1"],
    });
    const m = mailer();
    const env = envWith(m);
    await call(env, ADMIN_P, "POST", "/waitlist/approve", { subs: ["s2"] });
    expect(
      await rows("SELECT sub, emailed_at FROM signup_waitlist ORDER BY sub"),
    ).toMatchObject([
      { sub: "s1", emailed_at: null },
      { sub: "s2", emailed_at: expect.any(Number) },
    ]);
    // listed as unsent, counted in stats
    const unsent = (await call(env, ADMIN_P, "GET", "/waitlist?status=unsent"))
      .body as {
      items: { sub: string; emailedAt: number | null }[];
    };
    expect(unsent.items.map((i) => i.sub)).toEqual(["s1"]);
    expect(
      ((await call(env, ADMIN_P, "GET", "/stats")).body as { unsent: number })
        .unsent,
    ).toBe(1);
    const r = await call(env, ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1", "s2"],
    });
    expect(r.body).toMatchObject({
      results: [
        { sub: "s1", result: "approved", resent: true, emailSent: true },
        { sub: "s2", result: "already_approved" },
      ],
    });
    expect(m.sent.map((x) => x.to).sort()).toEqual([
      "a@acme.com",
      "b@acme.com",
    ]);
    expect(
      await rows("SELECT emailed_at FROM signup_waitlist WHERE sub = 's1'"),
    ).toMatchObject([{ emailed_at: expect.any(Number) }]);
    // sent now: nothing more to resend
    const again = await call(env, ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1"],
    });
    expect(again.body).toMatchObject({
      approved: 0,
      results: [{ result: "already_approved" }],
    });
    expect(m.sent).toHaveLength(2);
    expect(
      ((await call(env, ADMIN_P, "GET", "/stats")).body as { unsent: number })
        .unsent,
    ).toBe(0);
  });

  it("a resend that fails again stays unsent and is audited", async () => {
    const bad = mailer(Object.assign(new Error("boom"), { code: "E_DOWN" }));
    const env = envWith(bad);
    await wl("s1", "a@acme.com");
    await call(env, ADMIN_P, "POST", "/waitlist/approve", { subs: ["s1"] });
    const r = await call(env, ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1"],
    });
    expect(r.body).toMatchObject({
      results: [{ resent: true, emailSent: false, emailError: "E_DOWN" }],
    });
    expect(await audits("beta.email_failed")).toHaveLength(2);
    expect(await rows("SELECT emailed_at FROM signup_waitlist")).toEqual([
      { emailed_at: null },
    ]);
  });
});

describe("one send per approval", () => {
  it("two approves at once send exactly once", async () => {
    const m = mailer();
    const env = envWith(m);
    await wl("s1", "a@acme.com");
    const [x, y] = await Promise.all([
      call(env, ADMIN_P, "POST", "/waitlist/approve", { subs: ["s1"] }),
      call(env, ADMIN_P, "POST", "/waitlist/approve", { subs: ["s1"] }),
    ]);
    expect(m.sent).toHaveLength(1);
    const r = [x, y].flatMap((z) =>
      (z.body as { results: { result: string }[] }).results.map(
        (q) => q.result,
      ),
    );
    expect(r.sort()).toEqual(["already_approved", "approved"]);
    expect(await audits("beta.approve")).toHaveLength(1);
  });
  it("two resends at once send exactly once", async () => {
    const bad = mailer(Object.assign(new Error("boom"), { code: "E_DOWN" }));
    await wl("s1", "a@acme.com");
    await call(envWith(bad), ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1"],
    });
    const m = mailer();
    const env = envWith(m);
    await Promise.all([
      call(env, ADMIN_P, "POST", "/waitlist/approve", { subs: ["s1"] }),
      call(env, ADMIN_P, "POST", "/waitlist/approve", { subs: ["s1"] }),
    ]);
    expect(m.sent).toHaveLength(1);
    expect(await rows("SELECT emailed_at FROM signup_waitlist")).toMatchObject([
      { emailed_at: expect.any(Number) },
    ]);
  });
  it("a failed send gives the claim back, so a resend works", async () => {
    await wl("s1", "a@acme.com");
    await call(
      envWith(mailer(Object.assign(new Error("x"), { code: "E_DOWN" }))),
      ADMIN_P,
      "POST",
      "/waitlist/approve",
      { subs: ["s1"] },
    );
    expect(await rows("SELECT emailed_at FROM signup_waitlist")).toEqual([
      { emailed_at: null },
    ]);
  });
});

describe("addresses", () => {
  const BIDI = String.fromCharCode(0x202e);
  const ZW = String.fromCharCode(0x200b);
  const NUL = String.fromCharCode(0);
  it("the Add box refuses controls, bidi, zero-width, spaces and non-ASCII in an email", async () => {
    const env = envWith();
    for (const bad of [
      `ma${BIDI}ya@acme.com`,
      `ma${ZW}ya@acme.com`,
      `ma${NUL}ya@acme.com`,
      "ma ya@acme.com",
      "josé@acme.com",
      "maya@acmé.com",
    ])
      expect(
        await code(
          call(env, ADMIN_P, "POST", "/allowlist", { entries: [bad] }),
        ),
        JSON.stringify(bad),
      ).toBe("invalid_input");
    expect(
      (
        await call(env, ADMIN_P, "POST", "/allowlist", {
          entries: ["m.a+y_a!#$%&'*/=?^`{|}~@acme.com"],
        })
      ).status,
    ).toBe(200);
  });
  it('the Add box refuses , ; < > and " in the local part', async () => {
    const env = envWith();
    for (const bad of [
      "a,b@acme.com",
      "a;b@acme.com",
      "a<b@acme.com",
      "a>b@acme.com",
      'a"b@acme.com',
      "<a@acme.com>",
    ])
      expect(
        await code(
          call(env, ADMIN_P, "POST", "/allowlist", { entries: [bad] }),
        ),
        bad,
      ).toBe("invalid_input");
  });
  it("approvalEmail returns the sanitized to", () => {
    const m = approvalEmail({
      from: "f@x.app",
      to: ` a${BIDI}b${ZW}@c.co\r\n `,
      appDomain: "x.app",
      billing: true,
    });
    expect(m.to).toBe("ab@c.co");
    expect(m.text).toContain("Sign in with ab@c.co at");
  });
  it("a waitlist address that isn't plain ASCII is approved but not emailed", async () => {
    const m = mailer();
    const env = envWith(m);
    await wl("s1", `ma${BIDI}ya@acme.com`);
    const r = await call(env, ADMIN_P, "POST", "/waitlist/approve", {
      subs: ["s1"],
    });
    expect(r.body).toMatchObject({
      results: [
        { result: "approved", emailSent: false, emailError: "invalid_address" },
      ],
    });
    expect(m.sent).toEqual([]);
  });
});

describe("stats", () => {
  it("counts waiting, allowed emails and domains, today's self-serve admissions, the cap and the mode", async () => {
    const env = envWith(mailer(), {
      SIGNUP_DAILY_CAP: "20",
      SIGNUPS_ENABLED: "invite",
    });
    await wl("s1", "a@acme.com");
    await wl("s2", "b@acme.com", { status: "declined" });
    await db.batch([
      db.prepare("INSERT INTO signup_allowlist VALUES ('a@acme.com','x',1)"),
      db.prepare("INSERT INTO signup_allowlist VALUES ('b@acme.com','x',1)"),
      db.prepare("INSERT INTO signup_allowlist VALUES ('@acme.com','x',1)"),
    ]);
    const b = (await call(env, ADMIN_P, "GET", "/stats")).body;
    expect(b).toEqual({
      waiting: 1,
      declined: 1,
      unsent: 0,
      allowedEmails: 2,
      allowedDomains: 1,
      signupsToday: 0,
      cap: 20,
      mode: "invite",
    });
    const off = (
      await call(
        envWith(mailer(), {
          SIGNUP_DAILY_CAP: undefined,
          SIGNUPS_ENABLED: "true",
        }),
        ADMIN_P,
        "GET",
        "/stats",
      )
    ).body;
    expect(off).toMatchObject({ cap: null, mode: "true" });
  });
});

describe("the approval email", () => {
  it("has the final subject and words, and the sign-up link", () => {
    const m = approvalEmail({
      from: "noreply@mail.x.app",
      to: "maya@acme.com",
      appDomain: "open-artifacts.app",
      billing: true,
    });
    expect(m.subject).toBe("You're in: Open Artifacts beta");
    expect(m.text).toContain(
      "You can create your Open Artifacts now. Sign in with maya@acme.com at https://signup.open-artifacts.app/. Your first 30 days are free.",
    );
    expect(m.html).toContain('href="https://signup.open-artifacts.app/"');
    expect(m.html).toContain("Create your Open Artifacts");
  });
  it("billing bound: the trial line in text and html; unbound: the beta line", () => {
    const o = {
      from: "noreply@mail.x.app",
      to: "maya@acme.com",
      appDomain: "open-artifacts.app",
    };
    const on = approvalEmail({ ...o, billing: true });
    const off = approvalEmail({ ...o, billing: false });
    const flat = (s: string) => s.replace(/&#39;/g, "'");
    for (const part of [on.text, flat(on.html)]) {
      expect(part).toContain("Your first 30 days are free.");
      expect(part).not.toContain("private beta");
    }
    for (const part of [off.text, flat(off.html)]) {
      expect(part).toContain("It's free during the private beta.");
      expect(part).not.toContain("30 days");
    }
  });
  it("the sender picks the line from the BILLING binding", async () => {
    const m = mailer();
    const env = envWith(m, { BILLING: {} });
    await wl("s1", "Maya@Acme.com");
    await call(env, ADMIN_P, "POST", "/waitlist/approve", { subs: ["s1"] });
    expect(m.sent[0]?.text).toContain("Your first 30 days are free.");
  });
  it("cannot inject headers or markup through the address", () => {
    const m = approvalEmail({
      from: "f@x.app",
      to: "a@b.co\r\nBcc: z@z.co<script>",
      appDomain: "x.app",
      billing: true,
    });
    expect(m.text).not.toMatch(/[\r]/);
    expect(m.html).not.toContain("<script>");
  });
});
