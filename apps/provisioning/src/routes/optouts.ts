import {
  ASSERTION_SKEW_MS,
  lookupInstall,
  verifyAssertion,
} from "@oa/broker-core";
import { GATE_INSTALL_HEADER } from "@oa/broker-core/gate-header";
import { hmac16 } from "../audit.js";
import { bump, HOUR_MS, peek } from "../auth/counters.js";
import type { Env } from "../env.js";

// The hosted-wide email opt-out list (open-artifacts#2652).
//
// Gate routes (check, mint): same trust path as login-change.ts. The instance
// reaches them only through dispatch's LoginGate (LOGIN binding,
// LoginChangeGate entrypoint); the install id is the gate's x-oa-gate-install;
// the body is signed with one of that install's registry keys (x-oa-kid,
// x-oa-sig over path, kid and exact body text, ts within ASSERTION_SKEW_MS);
// the nonce is stored per install (a replay is a 409; the nonce table,
// login_change_nonces, is shared with login changes); a request with
// cf-connecting-ip is the plain 404. OPTOUT_LIST must be "1"; off, every route
// is the plain 404.
//
// The platform never receives an address. The install sends h1 =
// HMAC-SHA256(OPTOUT_HASH_KEY, normalized address); OPTOUT_HASH_KEY is held by
// hosted installs only, never by the platform. The list stores h2 =
// HMAC-SHA256(OPTOUT_STORE_KEY, h1), never h1.
//
//   POST /optouts/check {ts, nonce, h1} -> {optedOut: boolean}  (gate)
//   POST /optouts/mint  {ts, nonce, h1} -> {token}              (gate)
//   GET|POST signup.<app>/unsubscribe?t=<token>                 (public, below)
//
// A token (HMAC with OPTOUT_TOKEN_KEY) names the minting install and h1 and
// lasts a year. It does NOT stop a compromised install from redeeming its own
// links: it can mint a token for any h1 it computes. Only the mint rate limit,
// the per-install daily redemption cap and the audit row bound that. There is
// no add route on the gate and no removal route; operators remove a row by
// hand (docs/ops/hosted.md). The one other removal is the recipient's Undo
// (#2665): only the exact token that added a row removes it (undo_key), so a
// token minted later, by any install, can never undo an opt-out.

export const OPTOUT_PATHS: ReadonlySet<string> = new Set([
  "/optouts/check",
  "/optouts/mint",
]);
export const UNSUBSCRIBE_PATH = "/unsubscribe";
export const OPTOUT_ADD_ACTION = "optout.add";
export const OPTOUT_UNDO_ACTION = "optout.undo";
export const OPTOUT_ACTOR = "system:optout";
export const TOKEN_TTL_MS = 365 * 86_400_000;
export const CHECKS_PER_MIN = 60;
export const CHECKS_PER_DAY = 1000;
/** Mints per install per day: about what an install really sends. */
export const MINTS_PER_DAY = 150;
/** Redemptions per minting install per day: a warn line at 150; past 200 that install's mint answers 429 (redemptions are still stored). */
export const ADDS_PER_DAY = 200;
/** Requests with a token that does not verify, per client IP per hour. */
export const UNSUB_PER_IP_HOUR = 30;
export const DEFAULT_CHECK_SPIKE = 800;
export const DEFAULT_ADD_SPIKE = 150;
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
};

const noStore = { "cache-control": "no-store" };
const notFound = () =>
  new Response("Not found", { status: 404, headers: noStore });
const reply = (status: number, error: string) =>
  Response.json({ error }, { status, headers: noStore });

type Body = { ts: number; nonce: string; h1: string };

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

/** undo_key: the token that added a row, keyed; only that token removes it. */
export async function undoKey(key: string, token: string): Promise<string> {
  return hex(await hmacBytes(key, `optout-undo:${token}`));
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

/** The {h1, install} a valid, unexpired token this platform minted names, else null. */
export async function readToken(
  key: string,
  token: string,
  now: number,
): Promise<{ h1: string; install: string } | null> {
  if (!TOKEN.test(token)) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const want = b64u(await hmacBytes(key, `optout-token:${payload}`));
  let diff = want.length ^ mac.length;
  for (let i = 0; i < want.length; i++)
    diff |= want.charCodeAt(i) ^ (mac.charCodeAt(i) || 0);
  if (diff !== 0) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64u(payload))) as {
      h1?: unknown;
      i?: unknown;
      exp?: unknown;
    };
    if (
      typeof p.h1 === "string" &&
      H1.test(p.h1) &&
      typeof p.i === "string" &&
      INSTALL_ID.test(p.i) &&
      typeof p.exp === "number" &&
      p.exp > now
    )
      return { h1: p.h1, install: p.i };
  } catch {}
  return null;
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
      : { n: MINTS_PER_DAY, ms: DAY_MS };
  const count = await bump(
    env.PLATFORM_DB,
    `optout:${kind}:${install}`,
    limit.ms,
    now,
  );
  if (count > limit.n) return reply(429, "rate_limited");
  if (kind === "check") {
    // The per-install daily count: a warn line at the threshold
    // (optout_check_spike), a hard cap past it.
    const day = await bump(
      env.PLATFORM_DB,
      `optout:checkday:${install}`,
      DAY_MS,
      now,
    );
    const spike = Number(env.OPTOUT_CHECK_SPIKE) || DEFAULT_CHECK_SPIKE;
    if (day === spike) console.warn("optout_check_spike", install, day);
    if (day > CHECKS_PER_DAY) return reply(429, "daily_cap");
    const h2 = await storedHash(env.OPTOUT_STORE_KEY, body.h1);
    // An 'all' row counts for everyone; an install-scoped row only for the
    // caller that holds it (the gate's install, never a body value).
    const row = await env.PLATFORM_DB.prepare(
      `SELECT 1 AS x FROM email_optouts WHERE addr_hash = ?1
UNION ALL SELECT 1 FROM email_optouts_install WHERE addr_hash = ?1 AND install_id = ?2 LIMIT 1`,
    )
      .bind(h2, install)
      .first();
    return Response.json({ optedOut: row !== null }, { headers: noStore });
  }
  // An install past its daily redemption cap mints no more until someone
  // looks (an opt-out is never dropped; this is what the cap does instead).
  const redeemed = await peek(
    env.PLATFORM_DB,
    `optout:addday:${install}`,
    DAY_MS,
    now,
  );
  if (redeemed > ADDS_PER_DAY) {
    console.warn("optout_mint_blocked", install, redeemed);
    return reply(429, "mint_blocked");
  }
  return Response.json(
    { token: await mintToken(env.OPTOUT_TOKEN_KEY, install, body.h1, now) },
    { headers: noStore },
  );
}

// The public unsubscribe page (signup.<app>/unsubscribe, no gate). A recipient
// (or a mail client's RFC 8058 one-click POST, `List-Unsubscribe=One-Click`)
// holds only the token. GET changes nothing; POST takes only the token (query
// or form field `t`), adds the opt-out and answers the same page whether the
// address was new or already listed. No Turnstile, no cookies read or set.

const STYLE =
  "body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}button{font:inherit;padding:.6rem 1rem;cursor:pointer}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}";
/** The CSP sha256 of STYLE (a test recomputes it). */
export const UNSUB_STYLE_HASH =
  "sha256-Zo+JMTX83jHilR5wlehyj4yHgg1XfdIBiVLnfoWhHac=";
export const UNSUB_CSP = `default-src 'none'; style-src '${UNSUB_STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
export const UNSUB_STYLE = STYLE;
const UNSUB_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": UNSUB_CSP,
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};
const page = (title: string, inner: string) =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>${STYLE}</style><body>${inner}</body></html>`,
    { headers: UNSUB_HEADERS },
  );
const confirmPage = (token: string) =>
  page(
    "Unsubscribe",
    `<h1>Unsubscribe</h1><p>Stop emails from all of Open Artifacts to this address.</p><form method="post" action="/unsubscribe"><input type="hidden" name="t" value="${token}"><button type="submit">Stop emails from all of Open Artifacts</button></form>`,
  );
/** Undo shows only for the link that added the opt-out (canUndo). */
const donePage = (token: string, canUndo: boolean) =>
  page(
    "Unsubscribed",
    `<h1>You are unsubscribed</h1><p>You will not get share emails from Open Artifacts at this address.</p>${
      canUndo
        ? `<form method="post" action="/unsubscribe"><input type="hidden" name="t" value="${token}"><input type="hidden" name="action" value="undo"><button type="submit">Undo</button></form>`
        : ""
    }`,
  );
const undonePage = (token: string) =>
  page(
    "Subscribed again",
    `<h1>You'll get share emails from Open Artifacts again</h1><form method="post" action="/unsubscribe"><input type="hidden" name="t" value="${token}"><button type="submit">Stop emails from all of Open Artifacts</button></form>`,
  );
const bad = () =>
  new Response("Bad request", {
    status: 400,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

/**
 * The token, and whether this is an Undo: only a form POST body names
 * action=undo (a query token, RFC 8058 one-click included, never undoes).
 */
async function tokenOf(
  req: Request,
  url: URL,
): Promise<{ token: string | null; undo: boolean }> {
  const q = url.searchParams.get("t");
  if (q !== null) {
    await req.body?.cancel();
    return { token: q, undo: false };
  }
  if (req.method !== "POST") return { token: null, undo: false };
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded(\s*;|$)/i.test(type))
    return { token: null, undo: false };
  try {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 2048) return { token: null, undo: false };
    const f = new URLSearchParams(new TextDecoder().decode(buf));
    return { token: f.get("t"), undo: f.get("action") === "undo" };
  } catch {
    return { token: null, undo: false };
  }
}

/** This token's own rows (it can undo) and whether any row lists the address for its install. */
async function standing(
  env: Env,
  h2: string,
  install: string,
  uk: string,
): Promise<{ own: boolean; listed: boolean }> {
  const r = await env.PLATFORM_DB.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM email_optouts WHERE addr_hash = ?1 AND source = 'recipient' AND undo_key = ?3)
       OR EXISTS (SELECT 1 FROM email_optouts_install WHERE addr_hash = ?1 AND undo_key = ?3) AS own,
       EXISTS (SELECT 1 FROM email_optouts WHERE addr_hash = ?1)
       OR EXISTS (SELECT 1 FROM email_optouts_install WHERE addr_hash = ?1 AND install_id = ?2) AS listed`,
  )
    .bind(h2, install, uk)
    .first<{ own: number; listed: number }>();
  return { own: r?.own === 1, listed: r?.listed === 1 };
}

/** GET (the confirm page, no change) and POST (the opt-out) of /unsubscribe. */
export async function unsubscribe(
  req: Request,
  env: Env,
  ipKey: string,
  now: number = Date.now(),
): Promise<Response> {
  if (env.OPTOUT_LIST !== "1") return notFound();
  if (req.method !== "GET" && req.method !== "POST")
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, POST", "cache-control": "no-store" },
    });
  if (!env.OPTOUT_STORE_KEY || !env.OPTOUT_TOKEN_KEY)
    return new Response("Unavailable", { status: 503, headers: noStore });
  const url = new URL(req.url);
  const { token, undo } = await tokenOf(req, url);
  const named = token
    ? await readToken(env.OPTOUT_TOKEN_KEY, token, now)
    : null;
  if (!token || !named) {
    // Only a request whose token does not verify is limited per IP; a valid
    // token never is.
    const ip = await bump(
      env.PLATFORM_DB,
      `optout:unsub:${await hmac16(env, ipKey)}`,
      HOUR_MS,
      now,
    );
    if (ip > UNSUB_PER_IP_HOUR)
      return new Response("Too many requests", {
        status: 429,
        headers: noStore,
      });
    return bad();
  }
  const h2 = await storedHash(env.OPTOUT_STORE_KEY, named.h1);
  const uk = await undoKey(env.OPTOUT_STORE_KEY, token);
  if (req.method === "GET") {
    // A later visit: listed shows the done page (with Undo for the link that
    // added it); otherwise the confirm page. GET never writes.
    const st = await standing(env, h2, named.install, uk);
    return st.listed ? donePage(token, st.own) : confirmPage(token);
  }
  if (undo) {
    // Only this token's own recipient rows go; bounce and complaint rows, and
    // rows another link added, stay.
    if ((await standing(env, h2, named.install, uk)).own) {
      await env.PLATFORM_DB.batch([
        env.PLATFORM_DB.prepare(
          "DELETE FROM email_optouts WHERE addr_hash = ?1 AND source = 'recipient' AND undo_key = ?2",
        ).bind(h2, uk),
        env.PLATFORM_DB.prepare(
          "DELETE FROM email_optouts_install WHERE addr_hash = ?1 AND undo_key = ?2",
        ).bind(h2, uk),
        env.PLATFORM_DB.prepare(
          "INSERT INTO hosted_audit (at, actor, install_id, action, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        ).bind(
          now,
          OPTOUT_ACTOR,
          named.install,
          OPTOUT_UNDO_ACTION,
          JSON.stringify({ hash: h2.slice(0, 8) }),
        ),
      ]);
    }
    const st = await standing(env, h2, named.install, uk);
    return st.listed ? donePage(token, false) : undonePage(token);
  }

  // Per minting install: a warn line at 150. Past 200 the opt-out is stored
  // install-scoped (never dropped); that install's mint answers 429 for the rest of
  // the day instead.
  const day = await bump(
    env.PLATFORM_DB,
    `optout:addday:${named.install}`,
    DAY_MS,
    now,
  );
  const spike = Number(env.OPTOUT_ADD_SPIKE) || DEFAULT_ADD_SPIKE;
  if (day === spike) console.warn("optout_add_spike", named.install, day);
  // Past the cap the opt-out is still stored, scoped to the minting install
  // (check honours it for that install only until an operator widens it), so
  // a stockpile of tokens redeemed at once cannot opt out the whole list. An
  // under-cap add always creates or keeps the 'all' row and never narrows one.
  const scope = day > ADDS_PER_DAY ? "install" : "all";
  if (scope === "install") console.warn("optout_scoped", named.install, day);
  const ins =
    scope === "all"
      ? await env.PLATFORM_DB.prepare(
          "INSERT OR IGNORE INTO email_optouts (addr_hash, source, first_install, created_at, undo_key) VALUES (?1, 'recipient', ?2, ?3, ?4)",
        )
          .bind(h2, named.install, now, uk)
          .run()
      : await env.PLATFORM_DB.prepare(
          "INSERT OR IGNORE INTO email_optouts_install (addr_hash, install_id, created_at, undo_key) SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM email_optouts WHERE addr_hash = ?1)",
        )
          .bind(h2, named.install, now, uk)
          .run();
  if (scope === "all")
    // Widened: the install-scoped rows for this address are now redundant.
    await env.PLATFORM_DB.prepare(
      "DELETE FROM email_optouts_install WHERE addr_hash = ?1",
    )
      .bind(h2)
      .run();
  if ((ins.meta.changes ?? 0) > 0)
    await env.PLATFORM_DB.prepare(
      "INSERT INTO hosted_audit (at, actor, install_id, action, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(
        now,
        OPTOUT_ACTOR,
        named.install,
        OPTOUT_ADD_ACTION,
        JSON.stringify({ hash: h2.slice(0, 8), scope }),
      )
      .run();
  const st = await standing(env, h2, named.install, uk);
  return donePage(token, st.own);
}
