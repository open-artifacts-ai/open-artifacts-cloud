import { fakeProvisionerRpc } from "@oa/provisioning-contract/fakes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../src/app.js";
import { operatorEmail } from "../src/signup/contact.js";
import { CONTACT_JS } from "../src/signup/contact-page.js";
import { ctx, db, fakeEnv, resetDb, SIGNUP } from "./fakes.js";

// open-artifacts#2404: the public Business contact form. The clock is pinned
// (only Date is faked); the Turnstile and the mailer are fakes.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const IP = "192.0.2.10";

type Sent = {
  from: { email: string; name: string };
  to: string;
  replyTo: string;
  subject: string;
  text: string;
};
function mailer(fail?: Error | "hang") {
  const sent: Sent[] = [];
  const rpc = {
    async send(m: Sent) {
      if (fail instanceof Error) throw fail;
      sent.push(m);
      return { messageId: "m1" };
    },
  } as unknown as SendEmail;
  return { sent, rpc };
}

const envWith = (m = mailer(), over: Record<string, unknown> = {}) =>
  fakeEnv({
    WELCOME_EMAIL: m.rpc,
    WELCOME_FROM: "noreply@mail.hosted.test",
    BUSINESS_REQUESTS_TO: "ops@hosted.test",
    ...over,
  });
type E = ReturnType<typeof envWith>;

const body = (over: Record<string, unknown> = {}) => ({
  name: "Ana Lopez",
  email: "Ana@Acme.test",
  company: "Acme",
  teamSize: "11-50",
  needs: ["audit_log", "group_sync"],
  note: "We use Google Workspace.",
  turnstile: "tok",
  ...over,
});

const post = (e: E, b: unknown, h: Record<string, string> = {}, ip = IP) =>
  handle(
    new Request(`${SIGNUP}/api/v1/contact`, {
      method: "POST",
      headers: {
        origin: SIGNUP,
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        ...h,
      },
      body: JSON.stringify(b),
    }),
    e.env,
    ctx(),
  );
const rows = () =>
  db
    .prepare("SELECT * FROM business_requests ORDER BY created_at, id")
    .all<Record<string, unknown>>()
    .then((r) => r.results);
const errCode = async (r: Response) =>
  ((await r.json()) as { error: { code: string } }).error.code;

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("the page", () => {
  it("serves /contact and /contact.js on the sign-up host with the sign-up shell", async () => {
    const e = envWith();
    const page = await handle(
      new Request(`${SIGNUP}/contact`, {
        headers: { "cf-connecting-ip": IP },
      }),
      e.env,
      ctx(),
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("<title>Let's talk Business</title>");
    expect(html).toContain('href="/app.css"');
    expect(html).toContain('src="/contact.js"');
    expect(page.headers.get("content-security-policy")).toContain(
      "challenges.cloudflare.com",
    );
    const js = await (
      await handle(
        new Request(`${SIGNUP}/contact.js`, {
          headers: { "cf-connecting-ip": IP },
        }),
        e.env,
        ctx(),
      )
    ).text();
    expect(js).toBe(CONTACT_JS);
  });

  it("carries the approved copy and prefill params, and never innerHTML", () => {
    for (const s of [
      "Let's talk Business",
      "Tell us about your team and we'll email you to set up the Business plan.",
      "Your name",
      "Work email",
      "Company",
      "How many people will publish pages?",
      "1 to 10",
      "11 to 50",
      "51 to 200",
      "200+",
      "What do you need? (optional)",
      "Google group sync",
      "Outside-sharing controls",
      "Audit log",
      "Custom domain",
      "Something else",
      "Anything else? (optional)",
      "Send request",
      "Thanks. We have your request.",
      "We'll email you at ",
      "What Business adds to Team",
      "Decide who may share pages outside the company.",
      "per creator per month. Viewers are free.",
      "What happens next",
      "A person reads every request.",
      "Self-hosting? There are no plans to buy: every feature that ships is yours.",
      "Back to Open Artifacts",
      "We use this only to reply to you. ",
      ", where you're an owner.",
      "That didn't send. Try again.",
      "We already have your request from today.",
      "We'll be in touch.",
      'q.get("name")',
      'q.get("email")',
      'q.get("instance")',
      '"dashboard"',
    ])
      expect(CONTACT_JS, s).toContain(s);
    expect(CONTACT_JS).not.toMatch(/innerHTML|—/);
    expect(CONTACT_JS).toContain('theme: "auto"');
    expect(CONTACT_JS).toContain('class: "panel cx-done", role: "status"');
  });

  it("a GET to the API is 405", async () => {
    const e = envWith();
    const r = await handle(
      new Request(`${SIGNUP}/api/v1/contact`, {
        headers: { "cf-connecting-ip": IP },
      }),
      e.env,
      ctx(),
    );
    expect(r.status).toBe(405);
  });
});

describe("POST /api/v1/contact", () => {
  it("stores the row, normalized, and answers 200 duplicate:false", async () => {
    const e = envWith();
    const r = await post(
      e,
      body({ source: "dashboard", instance: "Acme.Example.App " }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ duplicate: false });
    const [row] = await rows();
    expect(row).toMatchObject({
      name: "Ana Lopez",
      email: "ana@acme.test",
      company: "Acme",
      team_size: "11-50",
      note: "We use Google Workspace.",
      source: "dashboard",
      instance_host: "acme.example.app",
      status: "new",
      status_changed_at: null,
      status_changed_by: null,
      created_at: NOW,
    });
    expect(JSON.parse(row?.needs as string)).toEqual([
      "audit_log",
      "group_sync",
    ]);
    expect(String(row?.id)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("defaults: landing source, no needs, no note, no instance; no session is needed", async () => {
    const e = envWith();
    const { needs: _n, note: _t, ...min } = body();
    expect((await post(e, min)).status).toBe(200);
    const [row] = await rows();
    expect(row).toMatchObject({
      source: "landing",
      note: null,
      instance_host: null,
    });
    expect(row?.needs).toBe("[]");
  });

  it("an instance that is not host-shaped is stored as none, not refused", async () => {
    const e = envWith();
    expect((await post(e, body({ instance: "not a host!" }))).status).toBe(200);
    expect((await rows())[0]?.instance_host).toBeNull();
  });

  it("refuses bad input with 400 invalid_input and stores nothing", async () => {
    const e = envWith();
    const bad: Record<string, unknown>[] = [
      { name: "" },
      { name: "A\u0000B" },
      { name: "x".repeat(101) },
      { email: "nope" },
      { email: "a b@acme.test" },
      { company: " " },
      { teamSize: "5" },
      { needs: ["telepathy"] },
      { note: "n".repeat(1001) },
      { source: "elsewhere" },
      { extra: 1 },
      { turnstile: "" },
    ];
    for (const b of bad) {
      const r = await post(e, body(b));
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(await errCode(r)).toBe("invalid_input");
    }
    expect(await rows()).toEqual([]);
    expect(e.provisioner.calls).toEqual([]);
  });

  it("accepts a note of exactly 1000 characters (code points)", async () => {
    const e = envWith();
    const r = await post(e, body({ note: "é".repeat(1000) }));
    expect(r.status).toBe(200);
  });

  it("a body that is not JSON is 415, and a wrong Origin is refused", async () => {
    const e = envWith();
    const r = await handle(
      new Request(`${SIGNUP}/api/v1/contact`, {
        method: "POST",
        headers: {
          origin: SIGNUP,
          "content-type": "text/plain",
          "cf-connecting-ip": IP,
        },
        body: "x",
      }),
      e.env,
      ctx(),
    );
    expect(r.status).toBe(415);
    const o = await post(e, body(), { origin: "https://evil.test" });
    expect(o.status).toBe(403);
    expect(await rows()).toEqual([]);
  });

  it("a failed Turnstile is 403 turnstile_failed, with the signup action and this host, and stores nothing", async () => {
    const prov = fakeProvisionerRpc({ turnstile: () => false });
    const m = mailer();
    const e = envWith(m, { PROVISIONER: prov });
    const r = await post(e, body());
    expect(r.status).toBe(403);
    expect(await errCode(r)).toBe("turnstile_failed");
    expect(await rows()).toEqual([]);
    expect(prov.calls).toHaveLength(1);
    expect(m.sent).toEqual([]);
  });

  it("passes the token, the client address, the signup action and the host to Turnstile", async () => {
    const e = envWith();
    await post(e, body({ turnstile: "tok-1" }));
    expect(e.provisioner.calls.at(-1)).toEqual({
      method: "verifyTurnstile",
      arg: {
        token: "tok-1",
        remoteIp: IP,
        action: "signup",
        hostname: "signup.hosted.test",
        testUser: false,
      },
    });
  });

  it("limits each client address to a few an hour, then lets it through in the next hour", async () => {
    const e = envWith();
    for (let i = 0; i < 5; i++)
      expect((await post(e, body({ email: `p${i}@acme.test` }))).status).toBe(
        200,
      );
    const over = await post(e, body({ email: "p5@acme.test" }));
    expect(over.status).toBe(429);
    expect(await errCode(over)).toBe("rate_limited");
    expect(await rows()).toHaveLength(5);
    // Another address has its own budget.
    expect(
      (await post(e, body({ email: "q@acme.test" }), {}, "192.0.2.77")).status,
    ).toBe(200);
    vi.setSystemTime(NOW + 3_600_000);
    expect((await post(e, body({ email: "p6@acme.test" }))).status).toBe(200);
  });

  it("an IPv6 client is limited by its /64", async () => {
    const e = envWith();
    for (let i = 0; i < 5; i++)
      await post(
        e,
        body({ email: `v${i}@acme.test` }),
        {},
        `2001:db8:1:2:${i}::1`,
      );
    const over = await post(
      e,
      body({ email: "v9@acme.test" }),
      {},
      "2001:db8:1:2:ffff::1",
    );
    expect(over.status).toBe(429);
  });
});

describe("dedupe", () => {
  it("the same email twice in one UTC day stores nothing new and sends nothing", async () => {
    const m = mailer();
    const e = envWith(m);
    expect((await post(e, body())).status).toBe(200);
    const again = await post(e, body({ company: "Other", name: "B" }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true });
    expect(await rows()).toHaveLength(1);
    expect(m.sent).toHaveLength(1);
    // The match ignores case.
    const up = await post(e, body({ email: "ANA@ACME.TEST" }));
    expect(await up.json()).toEqual({ duplicate: true });
  });

  it("the same instance twice in one UTC day is a duplicate, whoever asks", async () => {
    const e = envWith();
    await post(e, body({ instance: "acme.example.app" }));
    const again = await post(
      e,
      body({ email: "bo@acme.test", instance: "ACME.example.app" }),
    );
    expect(await again.json()).toEqual({ duplicate: true });
    expect(await rows()).toHaveLength(1);
  });

  it("no instance is not a match for another request with none", async () => {
    const e = envWith();
    await post(e, body());
    const r = await post(e, body({ email: "bo@acme.test" }));
    expect(await r.json()).toEqual({ duplicate: false });
    expect(await rows()).toHaveLength(2);
  });

  it("the next UTC day stores a new one; the day boundary is UTC midnight", async () => {
    const e = envWith();
    const dayStart = NOW - (NOW % DAY);
    vi.setSystemTime(dayStart + DAY - 1);
    await post(e, body());
    vi.setSystemTime(dayStart + DAY);
    const next = await post(e, body());
    expect(await next.json()).toEqual({ duplicate: false });
    expect(await rows()).toHaveLength(2);
  });
});

describe("the operator email", () => {
  it("sends one plain email to the operator address, reply-to the requester", async () => {
    const m = mailer();
    const e = envWith(m);
    await post(e, body({ source: "dashboard", instance: "acme.example.app" }));
    expect(m.sent).toHaveLength(1);
    const [msg] = m.sent;
    expect(msg).toMatchObject({
      from: { email: "noreply@mail.hosted.test", name: "Open Artifacts" },
      to: "ops@hosted.test",
      replyTo: "ana@acme.test",
      subject: "Business request: Acme",
    });
    expect(msg).not.toHaveProperty("html");
    for (const s of [
      "Ana Lopez",
      "ana@acme.test",
      "Acme",
      "11-50",
      "audit_log, group_sync",
      "dashboard",
      "acme.example.app",
      "We use Google Workspace.",
    ])
      expect(msg?.text, s).toContain(s);
  });

  it("falls back to the shared reply address when the var is unset", async () => {
    const m = mailer();
    const e = envWith(m, { BUSINESS_REQUESTS_TO: undefined });
    await post(e, body());
    expect(m.sent[0]?.to).toBe("hello@open-artifacts.com");
  });

  it("a send failure is logged and the request still succeeds and is stored", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = envWith(
      mailer(Object.assign(new Error("boom"), { code: "E_SEND" })),
    );
    const r = await post(e, body());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ duplicate: false });
    expect(await rows()).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "business request email failed",
      expect.objectContaining({ error: "E_SEND" }),
    );
    log.mockRestore();
  });

  it("no mail binding is logged and the request still succeeds", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = envWith(mailer(), { WELCOME_EMAIL: undefined });
    expect((await post(e, body())).status).toBe(200);
    expect(await rows()).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "business request email failed",
      expect.objectContaining({ error: "email_not_configured" }),
    );
    log.mockRestore();
  });

  it("a subject cannot carry line breaks from the company", () => {
    const e = envWith();
    const m = operatorEmail(e.env, {
      id: "x",
      name: "n",
      email: "a@b.co",
      company: "Acme\r\nBcc: x@y.z",
      teamSize: "1-10",
      needs: [],
      note: null,
      source: "landing",
      instanceHost: null,
    });
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
});
