import {
  ASSERTION_SKEW_MS,
  lookupInstall,
  verifyAssertion,
} from "@oa/broker-core";
import { GATE_INSTALL_HEADER } from "@oa/broker-core/gate-header";
import { bump, HOUR_MS } from "../auth/counters.js";
import type { Env } from "../env.js";

// The hosted-wide email opt-out list (open-artifacts#2652). Same trust path as
// login-change.ts: the instance reaches it only through dispatch's LoginGate
// (LOGIN binding, LoginChangeGate entrypoint), the install id is the gate's
// x-oa-gate-install, the body is signed with one of that install's registry
// keys (x-oa-kid, x-oa-sig over path, kid and exact body text, ts within
// ASSERTION_SKEW_MS), the nonce is stored per install (a replay is a 409), and
// a request with cf-connecting-ip (the internet) is the plain 404. OPTOUT_LIST
// must be "1"; off, every route is the plain 404.
//
// The platform never receives an address. The install sends h1 =
// HMAC-SHA256(OPTOUT_HASH_KEY, normalized address); OPTOUT_HASH_KEY is held by
// hosted installs only (the provisioner sets it at render), never by the
// platform. The list stores h2 = HMAC-SHA256(OPTOUT_STORE_KEY, h1), never h1.
//
//   POST /optouts/check {ts, nonce, h1}          -> {optedOut: boolean}
//   POST /optouts/mint  {ts, nonce, h1}          -> {token}   (for the unsubscribe link)
//   POST /optouts/add   {ts, nonce, h1, token}   -> 204       (idempotent)
//
// An add needs a valid, unexpired token this platform minted for that same
// install and h1 (HMAC with OPTOUT_TOKEN_KEY): a compromised install cannot
// opt out an address it was never given to mint. There is no removal route;
// operators remove a row by hand (docs/ops/hosted.md).

export const OPTOUT_PATHS: ReadonlySet<string> = new Set([
  "/optouts/check",
  "/optouts/mint",
  "/optouts/add",
]);
export const OPTOUT_ADD_ACTION = "optout.add";
export const OPTOUT_ACTOR = "system:optout";
export const TOKEN_TTL_MS = 30 * 86_400_000;
export const CHECKS_PER_MIN = 600;
export const MINTS_PER_HOUR = 600;
export const ADDS_PER_HOUR = 60;
export const DEFAULT_CHECK_SPIKE = 5000;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const NONCE_KEEP_MS = 10 * 60_000;
const MAX_BODY = 4096;
const INSTALL_ID = /^i[a-z0-9]{11}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const H1 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}$/;
const FIELDS: Record<string, string[]> = {
  "/optouts/check": ["h1", "nonce", "ts"],
  "/optouts/mint": ["h1", "nonce", "ts"],
  "/optouts/add": ["h1", "nonce", "token", "ts"],
};

const noStore = { "cache-control": "no-store" };
const notFound = () =>
  new Response("Not found", { status: 404, headers: noStore });
const reply = (status: number, error: string) =>
  Response.json({ error }, { status, headers: noStore });

type Body = { ts: number; nonce: string; h1: string; token?: string };

function parseBody(path: string, text: string): Body | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  const want = FIELDS[path] ?? [];
  const keys = Object.keys(b).sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i]))
    return null;
  if (
    typeof b.ts !== "number" ||
    !Number.isFinite(b.ts) ||
    typeof b.nonce !== "string" ||
    !NONCE.test(b.nonce) ||
    typeof b.h1 !== "string" ||
    !H1.test(b.h1)
  )
    return null;
  if (
    path === "/optouts/add" &&
    (typeof b.token !== "string" || !TOKEN.test(b.token))
  )
    return null;
  return b as unknown as Body;
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

const enc = new TextEncoder();
async function hmacBytes(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(value)),
  );
}
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64u = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );

/** h2: what the list stores for an h1. */
export async function storedHash(key: string, h1: string): Promise<string> {
  return hex(await hmacBytes(key, `optout-store:${h1}`));
}

/** A token binding h1, the install and an expiry: payload.mac, both base64url. */
export async function mintToken(
  key: string,
  install: string,
  h1: string,
  now: number,
): Promise<string> {
  const payload = b64u(
    enc.encode(JSON.stringify({ h1, i: install, exp: now + TOKEN_TTL_MS })),
  );
  return `${payload}.${b64u(await hmacBytes(key, `optout-token:${payload}`))}`;
}

/** True when `token` was minted by this platform for exactly this install and h1, and hasn't expired. */
export async function tokenValid(
  key: string,
  token: string,
  install: string,
  h1: string,
  now: number,
): Promise<boolean> {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return false;
  const want = b64u(await hmacBytes(key, `optout-token:${payload}`));
  let diff = want.length ^ mac.length;
  for (let i = 0; i < want.length; i++)
    diff |= want.charCodeAt(i) ^ (mac.charCodeAt(i) || 0);
  if (diff !== 0) return false;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64u(payload))) as {
      h1?: unknown;
      i?: unknown;
      exp?: unknown;
    };
    return (
      p.h1 === h1 && p.i === install && typeof p.exp === "number" && p.exp > now
    );
  } catch {
    return false;
  }
}

/** One opt-out list request; every answer is a fixed code. */
export async function optout(
  req: Request,
  env: Env,
  now: number = Date.now(),
): Promise<Response> {
  if (req.headers.has("cf-connecting-ip")) return notFound();
  if (env.OPTOUT_LIST !== "1") return notFound();
  const url = new URL(req.url);
  if (
    req.method !== "POST" ||
    !OPTOUT_PATHS.has(url.pathname) ||
    url.search !== ""
  )
    return notFound();
  const path = url.pathname;
  const install = req.headers.get(GATE_INSTALL_HEADER) ?? "";
  if (!INSTALL_ID.test(install)) return notFound();

  const text = await bodyText(req);
  if (text === null) return reply(400, "bad_body");
  const kid = req.headers.get("x-oa-kid") ?? "";
  const sig = req.headers.get("x-oa-sig") ?? "";
  if (!kid || !sig) return reply(401, "bad_signature");
  if (!env.BROKER_REGISTRY || !env.OPTOUT_STORE_KEY || !env.OPTOUT_TOKEN_KEY)
    return reply(503, "unavailable");
  const entry = await lookupInstall(env.BROKER_REGISTRY, install, now);
  if (!entry || !(await verifyAssertion(entry, path, kid, text, sig)))
    return reply(401, "bad_signature");
  const body = parseBody(path, text);
  if (!body) return reply(400, "bad_body");
  if (!(Math.abs(now - body.ts) <= ASSERTION_SKEW_MS))
    return reply(401, "bad_signature");

  const seen = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "DELETE FROM login_change_nonces WHERE at < ?1",
    ).bind(now - NONCE_KEEP_MS),
    env.PLATFORM_DB.prepare(
      "INSERT OR IGNORE INTO login_change_nonces (install_id, nonce, at) VALUES (?1, ?2, ?3)",
    ).bind(install, body.nonce, now),
  ]);
  if ((seen[1]?.meta.changes ?? 0) === 0) return reply(409, "replay");

  const kind = path.slice("/optouts/".length);
  const limit =
    kind === "check"
      ? { n: CHECKS_PER_MIN, ms: MIN_MS }
      : kind === "mint"
        ? { n: MINTS_PER_HOUR, ms: HOUR_MS }
        : { n: ADDS_PER_HOUR, ms: HOUR_MS };
  const count = await bump(
    env.PLATFORM_DB,
    `optout:${kind}:${install}`,
    limit.ms,
    now,
  );
  if (count > limit.n) return reply(429, "rate_limited");

  if (kind === "check") {
    // The per-install daily count; a spike is a log line the alert reads
    // (optout_check_spike), once when the day's count crosses the threshold.
    const day = await bump(
      env.PLATFORM_DB,
      `optout:checkday:${install}`,
      DAY_MS,
      now,
    );
    const spike = Number(env.OPTOUT_CHECK_SPIKE) || DEFAULT_CHECK_SPIKE;
    if (day === spike) console.warn("optout_check_spike", install, day);
    const h2 = await storedHash(env.OPTOUT_STORE_KEY, body.h1);
    const row = await env.PLATFORM_DB.prepare(
      "SELECT 1 AS x FROM email_optouts WHERE addr_hash = ?1",
    )
      .bind(h2)
      .first();
    return Response.json({ optedOut: row !== null }, { headers: noStore });
  }
  if (kind === "mint")
    return Response.json(
      { token: await mintToken(env.OPTOUT_TOKEN_KEY, install, body.h1, now) },
      { headers: noStore },
    );

  if (
    !(await tokenValid(
      env.OPTOUT_TOKEN_KEY,
      body.token as string,
      install,
      body.h1,
      now,
    ))
  )
    return reply(403, "bad_token");
  const h2 = await storedHash(env.OPTOUT_STORE_KEY, body.h1);
  // First writer wins; the audit row is written only for a new row.
  const ins = await env.PLATFORM_DB.prepare(
    "INSERT OR IGNORE INTO email_optouts (addr_hash, source, first_install, created_at) VALUES (?1, 'recipient', ?2, ?3)",
  )
    .bind(h2, install, now)
    .run();
  if ((ins.meta.changes ?? 0) > 0)
    await env.PLATFORM_DB.prepare(
      "INSERT INTO hosted_audit (at, actor, install_id, action, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(
        now,
        OPTOUT_ACTOR,
        install,
        OPTOUT_ADD_ACTION,
        JSON.stringify({ hash: h2.slice(0, 8), kid }),
      )
      .run();
  return new Response(null, { status: 204, headers: noStore });
}
