import {
  ASSERTION_SKEW_MS,
  lookupInstall,
  verifyAssertion,
} from "@oa/broker-core";
import { GATE_INSTALL_HEADER } from "@oa/broker-core/gate-header";
import type { Env } from "../env.js";

// Email Service bounce and complaint events, routed to the sending install
// (open-artifacts#2650).
//
// In: a Queues consumer on the platform's own queue (the Email Service event
// subscription for the hosted sending domain). A hosted install is a user
// Worker and cannot consume a queue, so the platform stores each event under
// the install named by the sender, noreply+<installId>@mail.<app domain>. Only
// bounced and complained events are kept; no recipient and no subject is
// stored, and nothing but fixed counters is logged.
//
// Out: two gate routes, reached only through dispatch's LoginGate (the same
// entrypoint and signed-request scheme as login-change.ts): the install id is
// the gate's x-oa-gate-install, never a body value. /email-events/pull serves
// an install's events oldest first and deletes nothing; /email-events/ack
// deletes only that install's rows with the ids named. Unacked rows are served
// again until the retention prunes them.
//
// A forged sender can only route an event to an install that ignores message
// ids it never sent; the event carries nothing else.

export const PULL_PATH = "/email-events/pull";
export const ACK_PATH = "/email-events/ack";
/** Stored events per install; the oldest go first. */
export const MAX_PER_INSTALL = 1000;
export const RETAIN_MS = 14 * 86_400_000;
export const PULL_LIMIT = 100;
export const ACK_LIMIT = 100;
/** Pull and ack calls per install per hour, combined (installs pull every 2 min). */
export const CALLS_PER_HOUR = 120;
const HOUR_MS = 3_600_000;
const NONCE_KEEP_MS = 10 * 60_000;
const MAX_BODY = 8192;
const INSTALL_ID = /^i[a-z0-9]{11}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MESSAGE_ID = /^[\x21-\x7e]{1,256}$/;
// noreply+<installId>, or the fallback local part i<installId> (hosted.md).
const SENDER_LOCAL = /^(?:noreply\+|i)(i[a-z0-9]{11})$/;

const noStore = { "cache-control": "no-store" };
const notFound = () =>
  new Response("Not found", { status: 404, headers: noStore });
const reply = (status: number, error: string) =>
  Response.json({ error }, { status, headers: noStore });

export type Counters = Record<
  "stored" | "duplicate" | "ignored" | "unknown" | "malformed" | "failed",
  number
>;

type Parsed = {
  installId: string;
  messageId: string;
  kind: "bounced" | "complained";
  bounceType: "hard" | "soft" | null;
  eventId: string;
};

/** The install a sender address names on the sending domain, or null. */
export function installOfSender(
  sender: unknown,
  appDomain: string | undefined,
): string | null {
  if (typeof sender !== "string" || !appDomain) return null;
  const m = /<([^<>]+)>\s*$/.exec(sender);
  const addr = (m?.[1] ?? sender).trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 1 || addr.slice(at + 1) !== `mail.${appDomain.toLowerCase()}`)
    return null;
  return SENDER_LOCAL.exec(addr.slice(0, at))?.[1] ?? null;
}

const KINDS = {
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.complained": "complained",
} as const;

/** "ignored" for another event type, null for a malformed or unknown-sender event. */
export function parseEvent(
  raw: unknown,
  appDomain: string | undefined,
): Parsed | "ignored" | "unknown" | "malformed" {
  if (!raw || typeof raw !== "object") return "malformed";
  const e = raw as Record<string, unknown>;
  if (typeof e.type !== "string") return "malformed";
  const kind = (KINDS as Record<string, "bounced" | "complained">)[e.type];
  if (!kind) return "ignored";
  const p = e.payload;
  if (!p || typeof p !== "object") return "malformed";
  const pl = p as Record<string, unknown>;
  if (
    typeof pl.eventId !== "string" ||
    !EVENT_ID.test(pl.eventId) ||
    typeof pl.messageId !== "string" ||
    !MESSAGE_ID.test(pl.messageId)
  )
    return "malformed";
  const installId = installOfSender(pl.sender, appDomain);
  if (!installId) return "unknown";
  const bt = (pl.bounce as { type?: unknown } | undefined)?.type;
  // Only "hard" or "soft" leave the platform: any other bounce value is soft,
  // and a complaint has none.
  const bounceType =
    kind === "complained" ? null : bt === "hard" ? "hard" : "soft";
  return {
    installId,
    messageId: pl.messageId,
    kind,
    bounceType,
    eventId: pl.eventId,
  };
}

/** Delete rows past the retention. */
export async function pruneEmailEvents(
  env: Pick<Env, "PLATFORM_DB">,
  now: number,
): Promise<void> {
  await env.PLATFORM_DB.prepare("DELETE FROM email_events WHERE at < ?1")
    .bind(now - RETAIN_MS)
    .run();
}

/** Store one event (idempotent on event_id) and trim that install to the cap. */
async function store(env: Env, p: Parsed, now: number): Promise<boolean> {
  const r = await env.PLATFORM_DB.prepare(
    "INSERT OR IGNORE INTO email_events (install_id, message_id, kind, bounce_type, event_id, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(p.installId, p.messageId, p.kind, p.bounceType, p.eventId, now)
    .run();
  if ((r.meta.changes ?? 0) === 0) return false;
  await env.PLATFORM_DB.prepare(
    "DELETE FROM email_events WHERE install_id = ?1 AND seq NOT IN (SELECT seq FROM email_events WHERE install_id = ?1 ORDER BY seq DESC LIMIT ?2)",
  )
    .bind(p.installId, MAX_PER_INSTALL)
    .run();
  return true;
}

type Msg = { body: unknown; ack(): void; retry(): void };

/**
 * The queue consumer. An unknown or malformed event is acked and dropped; a
 * D1 failure retries that message. Logs one line of counters, nothing else.
 */
export async function consumeEmailEvents(
  batch: { messages: readonly Msg[] },
  env: Env,
  now: number = Date.now(),
): Promise<Counters> {
  const c: Counters = {
    stored: 0,
    duplicate: 0,
    ignored: 0,
    unknown: 0,
    malformed: 0,
    failed: 0,
  };
  for (const m of batch.messages) {
    if (env.EMAIL_EVENTS !== "1") {
      c.ignored++;
      m.ack();
      continue;
    }
    const p = parseEvent(m.body, env.APP_DOMAIN);
    if (typeof p === "string") {
      c[p]++;
      m.ack();
      continue;
    }
    try {
      if (await store(env, p, now)) c.stored++;
      else c.duplicate++;
      m.ack();
    } catch {
      c.failed++;
      m.retry();
    }
  }
  try {
    if (env.EMAIL_EVENTS === "1") await pruneEmailEvents(env, now);
  } catch {
    // The hourly sweep prunes too.
  }
  console.log(JSON.stringify({ email_events: c }));
  return c;
}

async function bodyText(req: Request): Promise<string | null> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) return null;
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BODY)) return null;
  try {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BODY) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** The strict body: exactly these keys, ts and nonce valid; or null. */
function strictBody(
  text: string,
  keys: string[],
): Record<string, unknown> | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  const got = Object.keys(b).sort();
  if (got.length !== keys.length || got.some((k, i) => k !== keys[i]))
    return null;
  if (
    typeof b.ts !== "number" ||
    !Number.isFinite(b.ts) ||
    typeof b.nonce !== "string" ||
    !NONCE.test(b.nonce)
  )
    return null;
  return b;
}

/** One gate request: pull or ack. Every answer is a fixed code. */
export async function emailEventsGate(
  req: Request,
  env: Env,
  now: number = Date.now(),
): Promise<Response> {
  if (req.headers.has("cf-connecting-ip")) return notFound();
  if (env.EMAIL_EVENTS !== "1") return notFound();
  const url = new URL(req.url);
  if (
    req.method !== "POST" ||
    url.search !== "" ||
    (url.pathname !== PULL_PATH && url.pathname !== ACK_PATH)
  )
    return notFound();
  const install = req.headers.get(GATE_INSTALL_HEADER) ?? "";
  if (!INSTALL_ID.test(install)) return notFound();

  const text = await bodyText(req);
  if (text === null) return reply(400, "bad_body");
  const kid = req.headers.get("x-oa-kid") ?? "";
  const sig = req.headers.get("x-oa-sig") ?? "";
  if (!kid || !sig) return reply(401, "bad_signature");
  if (!env.BROKER_REGISTRY) return reply(503, "unavailable");
  const entry = await lookupInstall(env.BROKER_REGISTRY, install, now);
  if (!entry || !(await verifyAssertion(entry, url.pathname, kid, text, sig)))
    return reply(401, "bad_signature");

  const pull = url.pathname === PULL_PATH;
  const body = strictBody(
    text,
    pull ? ["nonce", "ts"] : ["eventIds", "nonce", "ts"],
  );
  if (!body) return reply(400, "bad_body");
  if (!(Math.abs(now - (body.ts as number)) <= ASSERTION_SKEW_MS))
    return reply(401, "bad_signature");
  let ids: string[] = [];
  if (!pull) {
    const e = body.eventIds;
    if (
      !Array.isArray(e) ||
      e.length < 1 ||
      e.length > ACK_LIMIT ||
      !e.every((x) => typeof x === "string" && EVENT_ID.test(x))
    )
      return reply(400, "bad_body");
    ids = [...new Set(e as string[])];
  }

  // Pull and ack share one fixed hourly window per install; only a signed,
  // well-formed call is charged.
  const charged = await env.PLATFORM_DB.prepare(
    `INSERT INTO rate_counters (key, window_start, count) VALUES (?1, ?2, 1)
ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
RETURNING count`,
  )
    .bind(`email-events:${install}`, now - (now % HOUR_MS))
    .first<{ count: number }>();
  if ((charged?.count ?? Number.POSITIVE_INFINITY) > CALLS_PER_HOUR)
    return reply(429, "rate_limited");

  // A nonce is seen once per install (the login change's table).
  const seen = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "DELETE FROM login_change_nonces WHERE at < ?1",
    ).bind(now - NONCE_KEEP_MS),
    env.PLATFORM_DB.prepare(
      "INSERT OR IGNORE INTO login_change_nonces (install_id, nonce, at) VALUES (?1, ?2, ?3)",
    ).bind(install, body.nonce, now),
  ]);
  if ((seen[1]?.meta.changes ?? 0) === 0) return reply(409, "replay");

  if (pull) {
    const rows = await env.PLATFORM_DB.prepare(
      "SELECT event_id, message_id, kind, bounce_type FROM email_events WHERE install_id = ?1 ORDER BY seq ASC LIMIT ?2",
    )
      .bind(install, PULL_LIMIT)
      .all<{
        event_id: string;
        message_id: string;
        kind: "bounced" | "complained";
        bounce_type: "hard" | "soft" | null;
      }>();
    return Response.json(
      {
        events: rows.results.map((r) => ({
          eventId: r.event_id,
          messageId: r.message_id,
          kind: r.kind,
          bounceType: r.bounce_type,
        })),
      },
      { headers: noStore },
    );
  }
  // json_each: one bound value, since D1 allows 100 variables and 100 ids plus the install is 101.
  const del = await env.PLATFORM_DB.prepare(
    "DELETE FROM email_events WHERE install_id = ?1 AND event_id IN (SELECT value FROM json_each(?2))",
  )
    .bind(install, JSON.stringify(ids))
    .run();
  return Response.json({ acked: del.meta.changes ?? 0 }, { headers: noStore });
}
