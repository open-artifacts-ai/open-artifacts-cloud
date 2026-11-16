import { keyId, publicFromPkcs8, signRequest } from "@oa/auth-core";
import { clearRegistryCache } from "@oa/broker-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACK_PATH,
  CALLS_PER_HOUR,
  consumeEmailEvents,
  emailEventsGate,
  installOfSender,
  MAX_PER_INSTALL,
  PULL_PATH,
  parseEvent,
  pruneEmailEvents,
  RETAIN_MS,
} from "../src/routes/email-events.js";
import { APP, db, fakeEnv, pkcs8, resetDb, seedInstall } from "./fakes.js";

// Open-artifacts#2650: Email Service bounce and complaint events, routed to
// the sending install. The consumer is the queue side, the gate is what an
// install pulls and acks through dispatch's LoginGate.

const KEY = pkcs8(41);
const OTHER_KEY = pkcs8(42);
const ORIGIN = "https://login.oa.internal";
const NOW = 1_800_000_000_000;
const DOMAIN = `mail.${APP}`;

async function registry(keys: Record<string, string>) {
  const entries = new Map<string, unknown>();
  for (const [id, key] of Object.entries(keys)) {
    const x = await publicFromPkcs8(key);
    entries.set(`install:${id}`, {
      installId: id,
      origin: `https://${id}.example.test`,
      keys: [{ kid: await keyId(x), x }],
    });
  }
  return {
    get: async (k: string) => entries.get(k) ?? null,
  } as unknown as KVNamespace;
}

let n = 0;
const nonce = () => `nonce-${String(++n).padStart(12, "0")}`;
let ev = 0;
const event = (
  install: string,
  o: {
    type?: string;
    eventId?: string;
    messageId?: string;
    sender?: string;
    bounce?: unknown;
  } = {},
) => ({
  type: o.type ?? "cf.email.sending.message.bounced",
  source: { type: "email.sending", domain: DOMAIN },
  payload: {
    eventId: o.eventId ?? `ev-${++ev}`,
    messageId: o.messageId ?? `msg-${ev}`,
    sender: o.sender ?? `noreply+${install}@${DOMAIN}`,
    recipient: "someone@secret.example",
    subject: "A secret subject",
    bounce: "bounce" in o ? o.bounce : { type: "hard" },
  },
});
const batch = (bodies: unknown[]) => {
  const acked: number[] = [];
  const retried: number[] = [];
  return {
    acked,
    retried,
    messages: bodies.map((body, i) => ({
      body,
      ack: () => void acked.push(i),
      retry: () => void retried.push(i),
    })),
  };
};
const rows = (install?: string) =>
  db
    .prepare(
      install
        ? "SELECT * FROM email_events WHERE install_id = ?1 ORDER BY seq"
        : "SELECT * FROM email_events ORDER BY seq",
    )
    .bind(...(install ? [install] : []))
    .all<Record<string, unknown>>()
    .then((r) => r.results);

async function req(
  path: string,
  b: Record<string, unknown> | string,
  o: { install: string; key?: string; headers?: Record<string, string> },
) {
  const text = typeof b === "string" ? b : JSON.stringify(b);
  const key = o.key ?? KEY;
  const kid = await keyId(await publicFromPkcs8(key));
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oa-gate-install": o.install,
      "x-oa-kid": kid,
      "x-oa-sig": await signRequest(key, path, kid, text),
      ...o.headers,
    },
    body: text,
  });
}
const pull = (install: string, over: Record<string, unknown> = {}) =>
  req(PULL_PATH, { ts: NOW, nonce: nonce(), ...over }, { install });
const ack = (
  install: string,
  eventIds: string[],
  over: Record<string, unknown> = {},
) => req(ACK_PATH, { ts: NOW, nonce: nonce(), eventIds, ...over }, { install });

let a: string;
let b: string;
async function world(over: Record<string, unknown> = {}) {
  a = (await seedInstall()).id;
  b = (await seedInstall()).id;
  return fakeEnv({
    EMAIL_EVENTS: "1",
    BROKER_REGISTRY: await registry({ [a]: KEY, [b]: OTHER_KEY }),
    ...over,
  }).env;
}

beforeEach(async () => {
  await resetDb();
  clearRegistryCache();
});

describe("the sender names the install", () => {
  it("noreply+<id> and the fallback i<id> on mail.<app domain>, case-folded, with a display name", () => {
    const id = "iabc123def45";
    expect(installOfSender(`noreply+${id}@${DOMAIN}`, APP)).toBe(id);
    expect(installOfSender(`NoReply+${id}@MAIL.${APP}`, APP)).toBe(id);
    expect(installOfSender(`i${id}@${DOMAIN}`, APP)).toBe(id);
    expect(installOfSender(`Acme <noreply+${id}@${DOMAIN}>`, APP)).toBe(id);
  });
  it.each([
    "noreply@mail.hosted.test",
    "noreply+iabc123def45@hosted.test",
    "noreply+iabc123def45@evil.test",
    "noreply+iabc123def45@x.mail.hosted.test",
    "noreply+abc@mail.hosted.test",
    "owner+iabc123def45@mail.hosted.test",
    "noreply+iabc123def45+x@mail.hosted.test",
    "",
    42,
    null,
  ])("not %j", (s) => {
    expect(installOfSender(s, APP)).toBeNull();
    expect(
      installOfSender("noreply+iabc123def45@mail.hosted.test", undefined),
    ).toBeNull();
  });
});

describe("the queue consumer", () => {
  it("stores a bounce and a complaint, with the bounce type, and no recipient or subject", async () => {
    const env = await world();
    const bt = batch([
      event(a, { eventId: "e1", messageId: "m1", bounce: { type: "hard" } }),
      event(a, { eventId: "e2", messageId: "m2", bounce: { type: "soft" } }),
      event(a, { eventId: "e3", messageId: "m3", bounce: { type: "weird" } }),
      event(a, {
        eventId: "e4",
        messageId: "m4",
        type: "cf.email.sending.message.complained",
        bounce: undefined,
      }),
    ]);
    const c = await consumeEmailEvents(bt, env, NOW);
    expect(c.stored).toBe(4);
    expect(bt.acked).toEqual([0, 1, 2, 3]);
    const r = await rows(a);
    expect(
      r.map((x) => [x.event_id, x.message_id, x.kind, x.bounce_type, x.at]),
    ).toEqual([
      ["e1", "m1", "bounced", "hard", NOW],
      ["e2", "m2", "bounced", "soft", NOW],
      ["e3", "m3", "bounced", "soft", NOW],
      ["e4", "m4", "complained", null, NOW],
    ]);
    expect(JSON.stringify(r)).not.toMatch(/secret/);
    expect(Object.keys(r[0] ?? {}).sort()).toEqual([
      "at",
      "bounce_type",
      "event_id",
      "install_id",
      "kind",
      "message_id",
      "seq",
    ]);
  });

  it("acks and drops other types, unknown senders and malformed events; logs counters only", async () => {
    const env = await world();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const bt = batch([
      event(a, { type: "cf.email.sending.message.delivered" }),
      event(a, { sender: `noreply@${DOMAIN}` }),
      event(a, { sender: `noreply+${a}@evil.test` }),
      { type: "cf.email.sending.message.bounced" },
      "nope",
      null,
      event(a, { eventId: "bad id with spaces" }),
      event(a, { eventId: "ok1" }),
    ]);
    const c = await consumeEmailEvents(bt, env, NOW);
    expect(c).toEqual({
      stored: 1,
      duplicate: 0,
      ignored: 1,
      unknown: 2,
      malformed: 4,
      failed: 0,
    });
    expect(bt.acked).toHaveLength(8);
    expect(bt.retried).toEqual([]);
    expect(await rows()).toHaveLength(1);
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).not.toContain(a);
    expect(logged).not.toMatch(/secret|evil|noreply/);
  });

  it("is idempotent on event_id", async () => {
    const env = await world();
    const e = event(a, { eventId: "same" });
    await consumeEmailEvents(batch([e]), env, NOW);
    const c = await consumeEmailEvents(batch([e, e]), env, NOW + 1);
    expect(c.duplicate).toBe(2);
    expect(await rows(a)).toHaveLength(1);
  });

  it("keeps the newest 1000 per install and leaves another install alone", async () => {
    const env = await world();
    await consumeEmailEvents(batch([event(b, { eventId: "b-1" })]), env, NOW);
    const total = MAX_PER_INSTALL + 3;
    for (let i = 0; i < total; i += 50) {
      const ids = Array.from(
        { length: Math.min(50, total - i) },
        (_, k) => i + k,
      );
      await consumeEmailEvents(
        batch(ids.map((x) => event(a, { eventId: `a-${x}` }))),
        env,
        NOW,
      );
    }
    const r = await rows(a);
    expect(r).toHaveLength(MAX_PER_INSTALL);
    expect(r[0]?.event_id).toBe("a-3");
    expect(r.at(-1)?.event_id).toBe(`a-${total - 1}`);
    expect(await rows(b)).toHaveLength(1);
  }, 60_000);

  it("prunes rows older than 14 days", async () => {
    const env = await world();
    await consumeEmailEvents(batch([event(a, { eventId: "old" })]), env, NOW);
    await consumeEmailEvents(
      batch([event(a, { eventId: "new" })]),
      env,
      NOW + RETAIN_MS + 1,
    );
    expect((await rows(a)).map((x) => x.event_id)).toEqual(["new"]);
    await pruneEmailEvents(env, NOW + 3 * RETAIN_MS);
    expect(await rows(a)).toEqual([]);
  });

  it("retries a message whose write fails", async () => {
    const env = await world();
    const broken = {
      ...env,
      PLATFORM_DB: {
        prepare: () => {
          throw new Error("d1 down");
        },
      } as unknown as D1Database,
    };
    const bt = batch([event(a)]);
    const c = await consumeEmailEvents(bt, broken, NOW);
    expect(c.failed).toBe(1);
    expect(bt.retried).toEqual([0]);
    expect(bt.acked).toEqual([]);
  });

  it("with the flag off acks everything and stores nothing", async () => {
    const env = await world({ EMAIL_EVENTS: "0" });
    const bt = batch([event(a)]);
    await consumeEmailEvents(bt, env, NOW);
    expect(bt.acked).toEqual([0]);
    expect(await rows()).toEqual([]);
  });

  it("bounceType is only hard, soft or null: other and missing bounce values are soft, complaints null", () => {
    const t = (bounce: unknown, type = "cf.email.sending.message.bounced") =>
      (
        parseEvent(event("iabc123def45", { type, bounce }), APP) as {
          bounceType: unknown;
        }
      ).bounceType;
    expect(t({ type: "hard" })).toBe("hard");
    expect(t({ type: "soft" })).toBe("soft");
    expect(t({ type: "Permanent" })).toBe("soft");
    expect(t({ type: 5 })).toBe("soft");
    expect(t(undefined)).toBe("soft");
    expect(
      t({ type: "hard" }, "cf.email.sending.message.complained"),
    ).toBeNull();
  });

  it("parseEvent: complained carries no bounce type", () => {
    expect(
      parseEvent(
        event("iabc123def45", { type: "cf.email.sending.message.delivered" }),
        APP,
      ),
    ).toBe("ignored");
    expect(
      parseEvent(
        event("iabc123def45", {
          type: "cf.email.sending.message.complained",
          bounce: { type: "hard" },
        }),
        APP,
      ),
    ).toMatchObject({ kind: "complained", bounceType: null });
  });
});

describe("the gate: pull and ack", () => {
  const seed = async (env: Awaited<ReturnType<typeof world>>) => {
    await consumeEmailEvents(
      batch([
        event(a, { eventId: "a1", messageId: "ma1" }),
        event(a, { eventId: "a2", messageId: "ma2", bounce: { type: "soft" } }),
        event(a, {
          eventId: "a3",
          messageId: "ma3",
          type: "cf.email.sending.message.complained",
          bounce: undefined,
        }),
        event(b, { eventId: "b1", messageId: "mb1" }),
      ]),
      env,
      NOW,
    );
  };

  it("pull serves this install's events oldest first, and serves the same rows again", async () => {
    const env = await world();
    await seed(env);
    const want = {
      events: [
        {
          eventId: "a1",
          messageId: "ma1",
          kind: "bounced",
          bounceType: "hard",
        },
        {
          eventId: "a2",
          messageId: "ma2",
          kind: "bounced",
          bounceType: "soft",
        },
        {
          eventId: "a3",
          messageId: "ma3",
          kind: "complained",
          bounceType: null,
        },
      ],
    };
    for (const _ of [1, 2]) {
      const r = await emailEventsGate(await pull(a), env, NOW);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual(want);
    }
    expect(await rows()).toHaveLength(4);
  });

  it("pull returns at most 100", async () => {
    const env = await world();
    const ids = Array.from({ length: 130 }, (_, i) => i);
    for (let i = 0; i < 130; i += 50)
      await consumeEmailEvents(
        batch(ids.slice(i, i + 50).map((x) => event(a, { eventId: `p-${x}` }))),
        env,
        NOW,
      );
    const r = (await (
      await emailEventsGate(await pull(a), env, NOW)
    ).json()) as { events: { eventId: string }[] };
    expect(r.events).toHaveLength(100);
    expect(r.events[0]?.eventId).toBe("p-0");
  });

  it("ack deletes only that install's named rows; unknown and other installs' ids are ignored", async () => {
    const env = await world();
    await seed(env);
    const r = await emailEventsGate(
      await ack(a, ["a1", "a3", "nope", "b1"]),
      env,
      NOW,
    );
    expect(await r.json()).toEqual({ acked: 2 });
    expect((await rows(a)).map((x) => x.event_id)).toEqual(["a2"]);
    expect((await rows(b)).map((x) => x.event_id)).toEqual(["b1"]);
    const again = await emailEventsGate(await ack(a, ["a1"]), env, NOW);
    expect(await again.json()).toEqual({ acked: 0 });
    expect((await emailEventsGate(await ack(a, []), env, NOW)).status).toBe(
      400,
    );
  });

  it("another install pulls only its own", async () => {
    const env = await world();
    await seed(env);
    const r = await emailEventsGate(
      await req(
        PULL_PATH,
        { ts: NOW, nonce: nonce() },
        { install: b, key: OTHER_KEY },
      ),
      env,
      NOW,
    );
    expect(((await r.json()) as { events: unknown[] }).events).toEqual([
      { eventId: "b1", messageId: "mb1", kind: "bounced", bounceType: "hard" },
    ]);
  });

  it("is the plain 404 when off, for the internet, another path or method", async () => {
    const off = await world({ EMAIL_EVENTS: "0" });
    expect((await emailEventsGate(await pull(a), off, NOW)).status).toBe(404);
    const env = await world();
    expect(
      (
        await emailEventsGate(
          await req(
            PULL_PATH,
            { ts: NOW, nonce: nonce() },
            { install: a, headers: { "cf-connecting-ip": "1.2.3.4" } },
          ),
          env,
          NOW,
        )
      ).status,
    ).toBe(404);
    const noInstall = await pull(a);
    noInstall.headers.delete("x-oa-gate-install");
    expect((await emailEventsGate(noInstall, env, NOW)).status).toBe(404);
    const other = await req(
      "/email-events/list",
      { ts: NOW, nonce: nonce() },
      { install: a },
    );
    expect((await emailEventsGate(other, env, NOW)).status).toBe(404);
    const get = new Request(`${ORIGIN}${PULL_PATH}`, {
      headers: { "x-oa-gate-install": a },
    });
    expect((await emailEventsGate(get, env, NOW)).status).toBe(404);
  });

  it("refuses a bad signature, another install's key, a stale ts and a replayed nonce", async () => {
    const env = await world();
    await seed(env);
    const wrongKey = await req(
      PULL_PATH,
      { ts: NOW, nonce: nonce() },
      { install: a, key: OTHER_KEY },
    );
    expect((await emailEventsGate(wrongKey, env, NOW)).status).toBe(401);
    const stale = await pull(a, { ts: NOW - 120_000 });
    expect((await emailEventsGate(stale, env, NOW)).status).toBe(401);
    const pathMismatch = await req(
      PULL_PATH,
      { ts: NOW, nonce: nonce() },
      { install: a },
    );
    const swapped = new Request(`${ORIGIN}${ACK_PATH}`, {
      method: "POST",
      headers: pathMismatch.headers,
      body: await pathMismatch.text(),
    });
    expect((await emailEventsGate(swapped, env, NOW)).status).toBe(401);
    const fixed = nonce();
    expect(
      (await emailEventsGate(await pull(a, { nonce: fixed }), env, NOW)).status,
    ).toBe(200);
    const replay = await emailEventsGate(
      await pull(a, { nonce: fixed }),
      env,
      NOW,
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: "replay" });
    expect(await rows(a)).toHaveLength(3);
  });

  it("rate-limits pull and ack together per install: 120 an hour, then 429; another install and the next hour are fine", async () => {
    const env = await world();
    for (let i = 0; i < CALLS_PER_HOUR; i++) {
      const r = await emailEventsGate(
        i % 2 ? await ack(a, ["x"]) : await pull(a),
        env,
        NOW,
      );
      expect(r.status).toBe(200);
    }
    for (const mk of [() => pull(a), () => ack(a, ["x"])]) {
      const r = await emailEventsGate(await mk(), env, NOW);
      expect(r.status).toBe(429);
      expect(await r.json()).toEqual({ error: "rate_limited" });
    }
    const other = await emailEventsGate(
      await req(
        PULL_PATH,
        { ts: NOW, nonce: nonce() },
        { install: b, key: OTHER_KEY },
      ),
      env,
      NOW,
    );
    expect(other.status).toBe(200);
    const later = NOW + 3_600_000;
    expect(
      (await emailEventsGate(await pull(a, { ts: later }), env, later)).status,
    ).toBe(200);
  });

  it("an unsigned or malformed call is not charged", async () => {
    const env = await world();
    for (let i = 0; i < CALLS_PER_HOUR + 5; i++) {
      const wrong = await req(
        PULL_PATH,
        { ts: NOW, nonce: nonce() },
        { install: a, key: OTHER_KEY },
      );
      expect((await emailEventsGate(wrong, env, NOW)).status).toBe(401);
    }
    expect((await emailEventsGate(await pull(a), env, NOW)).status).toBe(200);
  });

  it("is strict about the body", async () => {
    const env = await world();
    const bad: [string, () => Promise<Request>][] = [
      ["an extra field on pull", () => pull(a, { install: b })],
      ["an install id in the body", () => pull(a, { installId: a })],
      ["a bad nonce", () => pull(a, { nonce: "short" })],
      ["a string ts", () => pull(a, { ts: "1" })],
      [
        "ack without ids",
        () => req(ACK_PATH, { ts: NOW, nonce: nonce() }, { install: a }),
      ],
      ["ack with a non-array", () => ack(a, "a1" as unknown as string[])],
      [
        "ack with 101 ids",
        () =>
          ack(
            a,
            Array.from({ length: 101 }, (_, i) => `x${i}`),
          ),
      ],
      ["ack with a bad id", () => ack(a, ["has space"])],
      ["ack with a number", () => ack(a, [1 as unknown as string])],
      ["ack with an extra field", () => ack(a, ["x"], { more: 1 })],
      ["not JSON", () => req(PULL_PATH, "nope", { install: a })],
    ];
    for (const [label, mk] of bad) {
      const r = await emailEventsGate(await mk(), env, NOW);
      expect(r.status, label).toBe(400);
    }
    expect(
      (
        await emailEventsGate(
          await ack(
            a,
            Array.from({ length: 100 }, (_, i) => `x${i}`),
          ),
          env,
          NOW,
        )
      ).status,
    ).toBe(200);
  });

  it("503s with no registry bound", async () => {
    const env = await world({ BROKER_REGISTRY: undefined });
    expect((await emailEventsGate(await pull(a), env, NOW)).status).toBe(503);
  });
});
