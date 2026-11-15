import {
  ASSERTION_SKEW_MS,
  lookupInstall,
  verifyAssertion,
} from "@oa/broker-core";
import { GATE_INSTALL_HEADER } from "@oa/broker-core/gate-header";
import {
  DOMAIN_JOIN_SOURCE_VAR,
  OwnerVarsRefusal,
  ownerVars,
} from "@oa/provision";
import { billingTiersOf } from "../billing-tiers.js";
import type { Env } from "../env.js";
import { ulid } from "../ulid.js";

// An instance's own login-domain change (open-artifacts#2520 slice 3). The
// instance reaches this only through the LoginGate in dispatch (a service
// binding to the LoginChangeGate entrypoint, index.ts): the install id is the
// gate's props (x-oa-gate-install), never a body or query value, and a request
// with cf-connecting-ip (the internet) is the plain 404. The body is signed
// with one of the gate install's registry keys, the auth broker's scheme
// (x-oa-kid, x-oa-sig over the path, kid and exact body text, ts within
// ASSERTION_SKEW_MS).
//
// Exactly two vars change, AUTH_DOMAINS and AUTH_DOMAIN_JOIN (with its
// platform-only marker AUTH_DOMAIN_JOIN_SOURCE=owner when `member`): the write
// is installs.vars, compare-and-set on row_version, in one batch with the
// `update` job (a `login` variant) that redeploys that one install and the
// install.login_change hosted_audit row. A nonce is stored per install; a
// replay is a 409 and never applies twice. LOGIN_CHANGE must be "1"; off, the
// route is the plain 404.
//
// Not covered: broker-signed proof of the owner (install, sub, hd, auth_time);
// the instance checks the owner and the hd, and this side bounds what a
// compromised instance could ask for to its own row and to non-public domains.

export const LOGIN_CHANGE_PATH = "/login-domains";
export const LOGIN_CHANGE_ACTION = "install.login_change";
export const LOGIN_CHANGE_ACTOR = "system:login-change";
export const MAX_LOGIN_DOMAINS = 5;
/** Accepted changes per install in a rolling day. */
export const LOGIN_CHANGES_PER_DAY = 5;
const DAY_MS = 86_400_000;
/** Nonces older than this are pruned; the skew window is far inside it. */
const NONCE_KEEP_MS = 10 * 60_000;
const MAX_BODY = 8192;
const INSTALL_ID = /^i[a-z0-9]{11}$/;
const OWNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const FIELDS = ["autoJoin", "domains", "hd", "nonce", "ownerUserId", "ts"];
const DOMAIN =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Consumer and free mail providers: never a company's login domain. */
export const PUBLIC_MAIL_PROVIDERS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "tuta.io",
]);

/**
 * Public suffixes of more than one label that a registrable name sits under
 * (the common ones; a bare single label is refused anyway). A name equal to
 * one of these is a suffix, not a company's domain.
 */
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "net.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "co.kr",
  "or.kr",
  "co.in",
  "net.in",
  "org.in",
  "com.br",
  "net.br",
  "org.br",
  "com.mx",
  "com.ar",
  "com.co",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.hk",
  "com.sg",
  "com.tw",
  "com.tr",
  "co.za",
  "co.il",
  "com.pl",
  "com.ua",
  "com.ru",
  "github.io",
  "gitlab.io",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "appspot.com",
  "blogspot.com",
  "web.app",
  "firebaseapp.com",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
]);

const noStore = { "cache-control": "no-store" };
const notFound = () =>
  new Response("Not found", { status: 404, headers: noStore });
const reply = (status: number, error: string) =>
  Response.json({ error }, { status, headers: noStore });

/** The refusal for a domain, or null: lowercase registrable, not a suffix or a public mail provider. */
export function domainRefusal(d: string, appDomain?: string): string | null {
  if (!DOMAIN.test(d)) return "not a lowercase hostname";
  if (PUBLIC_SUFFIXES.has(d)) return "a public suffix";
  if (PUBLIC_MAIL_PROVIDERS.has(d)) return "a public mail provider";
  if (appDomain && (d === appDomain || d.endsWith(`.${appDomain}`)))
    return "the platform's own domain";
  return null;
}

type Body = {
  ts: number;
  nonce: string;
  ownerUserId: string;
  hd: string;
  domains: string[];
  autoJoin: boolean;
};

/** The strict body, or null: exactly the six fields, each of its type. */
function parseBody(text: string): Body | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  const keys = Object.keys(b).sort();
  if (keys.length !== FIELDS.length || keys.some((k, i) => k !== FIELDS[i]))
    return null;
  if (
    typeof b.ts !== "number" ||
    !Number.isFinite(b.ts) ||
    typeof b.nonce !== "string" ||
    !NONCE.test(b.nonce) ||
    typeof b.ownerUserId !== "string" ||
    !OWNER_ID.test(b.ownerUserId) ||
    // hd reaches the audit row: a lowercase hostname, or empty (a Gmail
    // owner), and an empty one proves no domain (checked with the list).
    typeof b.hd !== "string" ||
    (b.hd !== "" && !DOMAIN.test(b.hd)) ||
    !Array.isArray(b.domains) ||
    !b.domains.every((d) => typeof d === "string") ||
    typeof b.autoJoin !== "boolean"
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

async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

type Row = {
  id: string;
  state: string;
  vars: string | null;
  row_version: number;
  test_hooks: number;
  source: "admin" | "self-serve";
  serving_mode: string | null;
  suspended_at: number | null;
  deleted_at: number | null;
};

const ROW_SQL = `SELECT i.id, i.state, i.vars, i.row_version, i.test_hooks, l.source, l.serving_mode, l.suspended_at, l.deleted_at
FROM installs i JOIN install_lifecycle l ON l.install_id = i.id WHERE i.id = ?1`;

const isConstraint = (e: unknown) =>
  e instanceof Error && /constraint/i.test(e.message);

const parseVars = (raw: string | null): Record<string, string> | null => {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return Object.values(v).every((x) => typeof x === "string")
      ? (v as Record<string, string>)
      : null;
  } catch {
    return null;
  }
};

const joinOf = (v: Record<string, string>) => v.AUTH_DOMAIN_JOIN ?? "invite";
const domainsOf = (v: Record<string, string>) =>
  v.AUTH_DOMAINS ? v.AUTH_DOMAINS.split(",") : [];

/**
 * One change request. Every answer is a fixed code; nothing is logged but
 * fixed categories and the install id.
 */
export async function loginChange(
  req: Request,
  env: Env,
  now: number = Date.now(),
): Promise<Response> {
  // The internet (cf-connecting-ip) and the switch off are the plain 404.
  if (req.headers.has("cf-connecting-ip")) return notFound();
  if (env.LOGIN_CHANGE !== "1") return notFound();
  const url = new URL(req.url);
  if (
    req.method !== "POST" ||
    url.pathname !== LOGIN_CHANGE_PATH ||
    url.search !== ""
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
  const body = parseBody(text);
  if (!body) return reply(400, "bad_body");
  if (!(Math.abs(now - body.ts) <= ASSERTION_SKEW_MS))
    return reply(401, "bad_signature");

  // A nonce is seen once per install; a replay never reaches the checks.
  const seen = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "DELETE FROM login_change_nonces WHERE at < ?1",
    ).bind(now - NONCE_KEEP_MS),
    env.PLATFORM_DB.prepare(
      "INSERT OR IGNORE INTO login_change_nonces (install_id, nonce, at) VALUES (?1, ?2, ?3)",
    ).bind(install, body.nonce, now),
  ]);
  if ((seen[1]?.meta.changes ?? 0) === 0) return reply(409, "replay");

  const row = await env.PLATFORM_DB.prepare(ROW_SQL).bind(install).first<Row>();
  if (!row) return reply(404, "unknown_install");
  if (
    row.state !== "active" ||
    row.serving_mode !== "serving" ||
    row.suspended_at !== null ||
    row.deleted_at !== null
  )
    return reply(403, "install_not_serving");

  const plan = (await billingTiersOf(env, [install])).get(install);
  if (!plan) return reply(503, "unavailable");
  if (
    (plan.billingTier !== "team" && plan.billingTier !== "business") ||
    (plan.billingStatus !== "active" && plan.billingStatus !== "past_due")
  )
    return reply(403, "plan_required");

  const before = parseVars(row.vars);
  if (!before) return reply(409, "no_vars");
  if (!(before.AUTH_PROVIDERS ?? "").split(",").includes("google"))
    return reply(403, "google_required");
  if (before.EMAIL_CODE_DOMAIN === "on") return reply(403, "email_codes_on");

  // The body replaces the list.
  const domains = [...new Set(body.domains)].sort();
  if (domains.length > MAX_LOGIN_DOMAINS) return reply(422, "too_many_domains");
  for (const d of domains)
    if (domainRefusal(d, env.APP_DOMAIN) !== null)
      return reply(422, "bad_domain");
  if (domains.some((d) => d !== body.hd)) return reply(403, "domain_unproven");
  if (body.autoJoin && domains.length !== 1)
    return reply(422, "auto_join_needs_one_domain");

  // Exactly two vars (and the marker) change; the rest of installs.vars stays.
  const after: Record<string, string> = { ...before };
  delete after.AUTH_DOMAINS;
  delete after.AUTH_DOMAIN_JOIN;
  delete after[DOMAIN_JOIN_SOURCE_VAR];
  if (domains.length > 0) after.AUTH_DOMAINS = domains.join(",");
  after.AUTH_DOMAIN_JOIN = body.autoJoin ? "member" : "invite";
  if (body.autoJoin) after[DOMAIN_JOIN_SOURCE_VAR] = "owner";

  // What a create would refuse is refused (the provisioner's own schema).
  try {
    const owner: Record<string, string> = {};
    for (const k of [
      "AUTH_PROVIDERS",
      "TIER",
      "EMAIL_CODE_DOMAIN",
      "TEST_DOMAIN",
      "AUTH_DOMAIN_JOIN",
      DOMAIN_JOIN_SOURCE_VAR,
    ])
      if (after[k] !== undefined) owner[k] = after[k] as string;
    owner.AUTH_DOMAINS = after.AUTH_DOMAINS ?? "";
    ownerVars(JSON.stringify(owner), {
      source: row.source,
      selfServeTier: env.SELF_SERVE_TIER,
      testHooks: row.test_hooks === 1,
      env: env.OA_ENV,
      login: true,
    });
  } catch (e) {
    if (e instanceof OwnerVarsRefusal) return reply(422, "vars_refused");
    throw e;
  }

  const open = await env.PLATFORM_DB.prepare(
    "SELECT 1 AS x FROM jobs WHERE install_id = ?1 AND status IN ('queued', 'running') LIMIT 1",
  )
    .bind(install)
    .first();
  if (open) return reply(409, "apply_pending");
  const today = await env.PLATFORM_DB.prepare(
    "SELECT COUNT(*) AS n FROM hosted_audit WHERE install_id = ?1 AND action = ?2 AND at > ?3",
  )
    .bind(install, LOGIN_CHANGE_ACTION, now - DAY_MS)
    .first<{ n: number }>();
  if ((today?.n ?? 0) >= LOGIN_CHANGES_PER_DAY)
    return reply(429, "rate_limited");

  // One batch: the CAS guard (a lost race aborts it), the vars write, the job
  // and the audit row. The unique open-job index aborts it too.
  const jobId = ulid(now);
  const detail = JSON.stringify({
    before: { domains: domainsOf(before), join: joinOf(before) },
    after: { domains, join: after.AUTH_DOMAIN_JOIN },
    kid,
    ownerUserId: body.ownerUserId,
    hd: body.hd,
    jobId,
  });
  try {
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        "INSERT INTO jobs (id) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM installs WHERE id = ?1 AND row_version = ?2)",
      ).bind(install, row.row_version),
      env.PLATFORM_DB.prepare(
        "UPDATE installs SET vars = ?3, updated_at = ?4 WHERE id = ?1 AND row_version = ?2",
      ).bind(install, row.row_version, JSON.stringify(after), now),
      env.PLATFORM_DB.prepare(
        `INSERT INTO jobs (id, kind, workflow, install_id, signup_id, parent_job_id, actor_kind, actor_key, actor_label, token_id, request_id, body_hash, args, status, created_at, updated_at)
VALUES (?1, 'update', 'manage_install', ?2, NULL, NULL, 'system', ?3, 'login-change', NULL, ?4, ?5, ?6, 'queued', ?7, ?7)`,
      ).bind(
        jobId,
        install,
        "system:login-change",
        `${install}:${body.nonce}`,
        await sha256Hex(text),
        JSON.stringify({ login: true }),
        now,
      ),
      env.PLATFORM_DB.prepare(
        "INSERT INTO hosted_audit (at, actor, install_id, action, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind(now, LOGIN_CHANGE_ACTOR, install, LOGIN_CHANGE_ACTION, detail),
    ]);
  } catch (e) {
    if (!isConstraint(e)) throw e;
    return reply(409, "apply_pending");
  }
  try {
    await env.MANAGE_INSTALL.create({ id: jobId, params: { jobId } });
  } catch {
    // The job stays queued; the scheduler's sweep starts it (3.6, 5.8).
  }
  return Response.json(
    { ok: true, applying: true },
    { status: 202, headers: noStore },
  );
}
