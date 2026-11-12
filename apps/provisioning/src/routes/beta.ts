import { z } from "zod";
import { type AuditEntry, audit, auditStatement } from "../audit.js";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";
import type { Principal } from "../principal.js";
import { ADDRESS_RE, approvalEmail } from "../signup/approval-email.js";
import { normEmail } from "../signup/gate.js";

// The private beta's admin API (#2096): who may sign up while
// SIGNUPS_ENABLED=invite. Not contract routes (the route and authz tables are
// public): app.ts serves them on the admin host, after authn, CSRF and the
// write limit, and this file repeats the kind check and fails closed: an
// admin session only (no token, no OIDC principal).
//
//   GET    /api/v1/beta/stats                   header numbers and the mode
//   GET    /api/v1/beta/waitlist?status=&q=     oldest first
//   POST   /api/v1/beta/waitlist/approve        { subs: string[] }
//   POST   /api/v1/beta/waitlist/decline        { sub }
//   GET    /api/v1/beta/allowlist               newest first
//   POST   /api/v1/beta/allowlist               { entries: string[] }
//   DELETE /api/v1/beta/allowlist/:entry
//
// No write here touches an install, a signup or a signup_accounts row.

/** Extra audit detail naming the surface (an MCP call); empty for HTTP. */
export type Via = Record<string, unknown>;

export const BETA_PATH_RE = /^\/api\/v1\/beta(\/[^?]*)?$/;

export const BETA_ACTIONS = {
  approve: "beta.approve",
  decline: "beta.decline",
  allowAdd: "beta.allow_add",
  allowRemove: "beta.allow_remove",
  emailFailed: "beta.email_failed",
} as const;

/** Public mail domains an `@domain` entry may never name, and what to call them. */
export const PUBLIC_MAIL_DOMAINS: Readonly<Record<string, string>> = {
  "gmail.com": "Gmail",
  "googlemail.com": "Gmail",
  "outlook.com": "Outlook",
  "hotmail.com": "Hotmail",
  "yahoo.com": "Yahoo",
  "icloud.com": "iCloud",
  "proton.me": "Proton",
  "protonmail.com": "Proton",
  "aol.com": "AOL",
  "live.com": "Live",
  "msn.com": "MSN",
  "me.com": "iCloud",
  "mac.com": "iCloud",
  "gmx.com": "GMX",
  "gmx.de": "GMX",
  "yandex.com": "Yandex",
  "yandex.ru": "Yandex",
  "mail.com": "Mail.com",
  "zoho.com": "Zoho",
};

const DOMAIN_RE = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
// Printable ASCII only (ADDRESS_RE): no controls, spaces or bidi characters.
const EMAIL_RE = ADDRESS_RE;
const MAX_ENTRIES = 100;
const MAX_SUBS = 100;
const LIST_LIMIT = 500;
const EMAIL_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;

/** Product's strings. */
export const badEntryMessage = (e: string) =>
  `"${e}" isn't an email address or a domain like @acme.com.`;
export const duplicateMessage = (e: string) => `${e} is already on the list.`;
export const publicDomainMessage = (e: string, brand: string) =>
  `${e} would let in anyone with a ${brand} address. Add emails one at a time instead.`;

const tryAudit = (env: Env, e: AuditEntry) => audit(env, e).catch(() => {});

type Json = { status: number; body: unknown };
const ok = (body: unknown): Json => ({ status: 200, body });

// "unsent": approved, but the approval email never went out (Send email again).
const WaitlistStatus = z.enum([
  "waiting",
  "approved",
  "declined",
  "unsent",
  "all",
]);
const ApproveSchema = z
  .object({ subs: z.array(z.string().min(1).max(255)).min(1).max(MAX_SUBS) })
  .strict();
const DeclineSchema = z.object({ sub: z.string().min(1).max(255) }).strict();
const AddSchema = z
  .object({ entries: z.array(z.string().max(320)).min(1).max(MAX_ENTRIES) })
  .strict();

const invalid = (message: string, details?: unknown) =>
  new ApiError("invalid_input", message, details);

/** Lowercased, trimmed; "" and the rest are judged by validateEntry. */
export const normEntry = (raw: string): string => raw.trim().toLowerCase();

/**
 * The refusal for one normalized entry, or null when it is a plain email or an
 * `@domain` that is not a public mail domain. Duplicates are the caller's.
 */
export function entryRefusal(
  e: string,
): { message: string; reason: string } | null {
  if (DOMAIN_RE.test(e)) {
    const brand = PUBLIC_MAIL_DOMAINS[e.slice(1)];
    return brand
      ? { message: publicDomainMessage(e, brand), reason: "public_domain" }
      : null;
  }
  if (e.startsWith("@") || !EMAIL_RE.test(e) || e.length > 320)
    return { message: badEntryMessage(e), reason: "invalid_entry" };
  return null;
}

const who = (p: Principal) => p.email ?? p.label;

export async function stats(env: Env): Promise<Json> {
  const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const [w, a, s] = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "SELECT sum(status = 'waiting') AS waiting, sum(status = 'declined') AS declined, sum(status = 'approved' AND emailed_at IS NULL) AS unsent FROM signup_waitlist",
    ),
    env.PLATFORM_DB.prepare(
      "SELECT sum(substr(entry, 1, 1) <> '@') AS emails, sum(substr(entry, 1, 1) = '@') AS domains FROM signup_allowlist",
    ),
    // The cap counts self-serve admissions only, as the scheduler's signups
    // duty and signup_cap do.
    env.PLATFORM_DB.prepare(
      "SELECT count(*) AS n FROM signups WHERE source = 'self-serve' AND admitted_at >= ?1",
    ).bind(dayStart),
  ]);
  const wr = w?.results[0] as {
    waiting: number | null;
    declined: number | null;
    unsent: number | null;
  };
  const ar = a?.results[0] as { emails: number | null; domains: number | null };
  const cap = Number.parseInt(env.SIGNUP_DAILY_CAP ?? "", 10);
  return ok({
    waiting: wr?.waiting ?? 0,
    declined: wr?.declined ?? 0,
    unsent: wr?.unsent ?? 0,
    allowedEmails: ar?.emails ?? 0,
    allowedDomains: ar?.domains ?? 0,
    signupsToday: (s?.results[0] as { n: number } | undefined)?.n ?? 0,
    // 0 or unset: the cap is off.
    cap: Number.isFinite(cap) && cap > 0 ? cap : null,
    mode: env.SIGNUPS_ENABLED,
  });
}

type WaitRow = {
  sub: string;
  email: string;
  note: string | null;
  joined_at: number;
  status: string;
  decided_by: string | null;
  decided_at: number | null;
  emailed_at: number | null;
};
const waitItem = (r: WaitRow) => ({
  sub: r.sub,
  email: r.email,
  note: r.note,
  joinedAt: r.joined_at,
  status: r.status,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  emailedAt: r.emailed_at,
});

export async function listWaitlist(env: Env, url: URL): Promise<Json> {
  const st = WaitlistStatus.safeParse(
    url.searchParams.get("status") ?? "waiting",
  );
  if (!st.success)
    throw invalid("status: waiting, approved, declined, unsent or all");
  const q = (url.searchParams.get("q") ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 200);
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await env.PLATFORM_DB.prepare(
    `SELECT sub, email, note, joined_at, status, decided_by, decided_at, emailed_at FROM signup_waitlist
WHERE (?1 = 'all' OR status = ?1 OR (?1 = 'unsent' AND status = 'approved' AND emailed_at IS NULL))
  AND (?2 = '' OR lower(email) LIKE ?3 ESCAPE '\\' OR lower(coalesce(note, '')) LIKE ?3 ESCAPE '\\')
ORDER BY joined_at ASC, sub ASC LIMIT ?4`,
  )
    .bind(st.data, q, like, LIST_LIMIT)
    .all<WaitRow>();
  return ok({ items: rows.results.map(waitItem) });
}

type SendResult = { sent: true } | { sent: false; error: string };

/** Sends the approval email; never throws. */
async function sendApproval(env: Env, to: string): Promise<SendResult> {
  if (!env.WELCOME_EMAIL || !env.WELCOME_FROM)
    return { sent: false, error: "email_not_configured" };
  try {
    const msg = approvalEmail({
      from: env.WELCOME_FROM,
      to,
      appDomain: env.APP_DOMAIN,
      billing: !!env.BILLING,
    });
    // Never send to an address with controls, bidi characters or spaces.
    if (msg.to !== to || !ADDRESS_RE.test(msg.to))
      return { sent: false, error: "invalid_address" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        env.WELCOME_EMAIL.send(msg),
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(Object.assign(new Error("timeout"), { code: "TIMEOUT" })),
            EMAIL_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return { sent: true };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return {
      sent: false,
      error:
        typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
          ? code
          : "send_failed",
    };
  }
}

type ApproveResult = {
  sub: string;
  email?: string;
  result: "approved" | "already_approved" | "not_found";
  emailSent?: boolean;
  emailError?: string;
  /** Approved before but never emailed: the email was sent again. */
  resent?: boolean;
};

/**
 * Sends the approval email for `sub`, once. The send is claimed first with an
 * atomic `emailed_at` update (only if it is still NULL), so two approves at
 * once send exactly once; null means another call holds the claim. A failed
 * send gives the claim back (only if it is still ours), so a resend stays
 * possible. A failure is logged and audited; the approval stands.
 */
async function emailApproved(
  env: Env,
  p: Principal,
  sub: string,
  email: string,
  ip: string | undefined,
  via: Via = {},
): Promise<Pick<ApproveResult, "emailSent" | "emailError"> | null> {
  const claim = Date.now();
  const got = await env.PLATFORM_DB.prepare(
    "UPDATE signup_waitlist SET emailed_at = ?2 WHERE sub = ?1 AND emailed_at IS NULL",
  )
    .bind(sub, claim)
    .run();
  if ((got.meta.changes ?? 0) !== 1) return null;
  const sent = await sendApproval(env, email);
  if (sent.sent) return { emailSent: true };
  await env.PLATFORM_DB.prepare(
    "UPDATE signup_waitlist SET emailed_at = NULL WHERE sub = ?1 AND emailed_at = ?2",
  )
    .bind(sub, claim)
    .run();
  console.error("beta approval email failed", { sub, error: sent.error });
  await tryAudit(env, {
    action: BETA_ACTIONS.emailFailed,
    actor: p,
    outcome: "error",
    code: "email_failed",
    ip,
    email,
    detail: { ...via, sub, error: sent.error },
  });
  return { emailSent: false, emailError: sent.error };
}

/** Approves one waitlist row exactly as Approve does; never throws on a send failure. */
async function approveRow(
  env: Env,
  p: Principal,
  sub: string,
  ip: string | undefined,
  via: Via = {},
): Promise<ApproveResult> {
  const by = who(p);
  const row = await env.PLATFORM_DB.prepare(
    "SELECT email, status, emailed_at FROM signup_waitlist WHERE sub = ?1",
  )
    .bind(sub)
    .first<{ email: string; status: string; emailed_at: number | null }>();
  if (!row) return { sub, result: "not_found" };
  if (row.status === "approved") {
    if (row.emailed_at !== null)
      return { sub, email: row.email, result: "already_approved" };
    // Approved, but the email never went: approving again sends it again.
    const email = normEmail(row.email);
    const r = await emailApproved(env, p, sub, email, ip, via);
    if (!r) return { sub, email, result: "already_approved" };
    return { sub, email, result: "approved", resent: true, ...r };
  }
  const email = normEmail(row.email);
  const now = Date.now();
  // One batch: the allow-list entry, the row's decision and the audit row
  // (only if the decision changed a row, so a racing approve audits once).
  const res = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "INSERT OR IGNORE INTO signup_allowlist (entry, added_by, added_at) VALUES (?1, ?2, ?3)",
    ).bind(email, by, now),
    env.PLATFORM_DB.prepare(
      "UPDATE signup_waitlist SET status = 'approved', decided_by = ?2, decided_at = ?3 WHERE sub = ?1 AND status <> 'approved'",
    ).bind(sub, by, now),
    await auditStatement(
      env,
      {
        action: BETA_ACTIONS.approve,
        actor: p,
        outcome: "ok",
        ip,
        email,
        detail: { ...via, sub, previous: row.status },
      },
      true,
    ),
  ]);
  if ((res[1]?.meta.changes ?? 0) !== 1)
    return { sub, email, result: "already_approved" };
  // The approval stands whatever the send does.
  const r = await emailApproved(env, p, sub, email, ip, via);
  return r
    ? { sub, email, result: "approved", ...r }
    : { sub, email, result: "already_approved" };
}

export async function approve(
  env: Env,
  p: Principal,
  body: unknown,
  ip: string | undefined,
  via: Via = {},
): Promise<Json> {
  const parsed = ApproveSchema.safeParse(body);
  if (!parsed.success) throw invalid("subs: 1 to 100 sub ids");
  const results: ApproveResult[] = [];
  for (const sub of new Set(parsed.data.subs))
    results.push(await approveRow(env, p, sub, ip, via));
  return ok({
    results,
    approved: results.filter((r) => r.result === "approved").length,
    emailFailed: results.filter((r) => r.emailSent === false).length,
  });
}

export async function decline(
  env: Env,
  p: Principal,
  body: unknown,
  ip: string | undefined,
  via: Via = {},
): Promise<Json> {
  const parsed = DeclineSchema.safeParse(body);
  if (!parsed.success) throw invalid("sub is required");
  const { sub } = parsed.data;
  const row = await env.PLATFORM_DB.prepare(
    "SELECT email, status FROM signup_waitlist WHERE sub = ?1",
  )
    .bind(sub)
    .first<{ email: string; status: string }>();
  if (!row) throw new ApiError("not_found", "no such person on the waitlist");
  if (row.status === "approved")
    throw new ApiError(
      "invalid_state",
      "already approved; remove them from Allowed instead",
    );
  if (row.status === "declined")
    return ok({ sub, email: row.email, status: "declined" });
  const now = Date.now();
  // Quiet: no email, and the sign-up page still reads "on the list".
  const res = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "UPDATE signup_waitlist SET status = 'declined', decided_by = ?2, decided_at = ?3 WHERE sub = ?1 AND status = 'waiting'",
    ).bind(sub, who(p), now),
    await auditStatement(
      env,
      {
        action: BETA_ACTIONS.decline,
        actor: p,
        outcome: "ok",
        ip,
        email: row.email,
        detail: { ...via, sub },
      },
      true,
    ),
  ]);
  if ((res[0]?.meta.changes ?? 0) !== 1)
    throw new ApiError("invalid_state", "the person changed; reload");
  return ok({ sub, email: row.email, status: "declined" });
}

export async function listAllowed(env: Env): Promise<Json> {
  const rows = await env.PLATFORM_DB.prepare(
    `SELECT a.entry, a.added_by, a.added_at,
  EXISTS (SELECT 1 FROM signup_waitlist w WHERE w.email = a.entry AND w.status = 'approved') AS from_waitlist
FROM signup_allowlist a ORDER BY a.added_at DESC, a.entry ASC LIMIT ?1`,
  )
    .bind(LIST_LIMIT)
    .all<{
      entry: string;
      added_by: string;
      added_at: number;
      from_waitlist: number;
    }>();
  return ok({
    items: rows.results.map((r) => ({
      entry: r.entry,
      kind: r.entry.startsWith("@") ? "domain" : "email",
      addedBy: r.added_by,
      addedAt: r.added_at,
      fromWaitlist: r.from_waitlist === 1,
    })),
  });
}

type AddResult = {
  entry: string;
  /** An email entry with a waiting or declined waitlist row: approved and emailed. */
  approved?: boolean;
  emailSent?: boolean;
  emailError?: string;
  /** A domain entry: waiting people on it, left waiting. */
  waitingOnDomain?: number;
};

export async function add(
  env: Env,
  p: Principal,
  body: unknown,
  ip: string | undefined,
  via: Via = {},
): Promise<Json> {
  const parsed = AddSchema.safeParse(body);
  if (!parsed.success) throw invalid("entries: 1 to 100 emails or @domains");
  // Normalize first (the table has no CHECK), then validate every entry, in
  // order. Any bad entry refuses the whole call, naming all of them: nothing
  // is added.
  const entries = parsed.data.entries.map(normEntry);
  const have = new Set(
    (
      await env.PLATFORM_DB.prepare("SELECT entry FROM signup_allowlist").all<{
        entry: string;
      }>()
    ).results.map((r) => r.entry),
  );
  const seen = new Set<string>();
  const errors: { entry: string; message: string; reason: string }[] = [];
  for (const e of entries) {
    const bad =
      entryRefusal(e) ??
      (have.has(e) || seen.has(e)
        ? { message: duplicateMessage(e), reason: "duplicate" }
        : null);
    if (bad) errors.push({ entry: e, ...bad });
    seen.add(e);
  }
  if (errors.length) {
    await tryAudit(env, {
      action: BETA_ACTIONS.allowAdd,
      actor: p,
      outcome: "refused",
      code: "invalid_input",
      ip,
      detail: {
        ...via,
        entries: errors.slice(0, 20).map((x) => ({
          entry: x.entry.slice(0, 100),
          reason: x.reason,
        })),
      },
    });
    throw invalid(errors.map((x) => x.message).join("\n"), { errors });
  }
  const now = Date.now();
  const by = who(p);
  const stmts: D1PreparedStatement[] = [];
  for (const e of entries) {
    stmts.push(
      env.PLATFORM_DB.prepare(
        "INSERT INTO signup_allowlist (entry, added_by, added_at) VALUES (?1, ?2, ?3)",
      ).bind(e, by, now),
      await auditStatement(
        env,
        {
          action: BETA_ACTIONS.allowAdd,
          actor: p,
          outcome: "ok",
          ip,
          detail: { ...via, entry: e },
        },
        true,
      ),
    );
  }
  try {
    await env.PLATFORM_DB.batch(stmts);
  } catch {
    throw new ApiError("invalid_state", "the list changed; reload and retry");
  }
  const results: AddResult[] = [];
  for (const e of entries) {
    if (e.startsWith("@")) {
      // A domain entry admits only Google Workspace accounts, and waitlist
      // rows don't record hd: nobody is approved or emailed, the rows stay.
      const n = await env.PLATFORM_DB.prepare(
        "SELECT count(*) AS n FROM signup_waitlist WHERE status = 'waiting' AND substr(email, -length(?1)) = ?1",
      )
        .bind(e)
        .first<{ n: number }>();
      results.push({ entry: e, waitingOnDomain: n?.n ?? 0 });
      continue;
    }
    // An exact email with a waiting or declined row: approved as Approve
    // does it, the approval email included, its failure handled the same.
    const subs = (
      await env.PLATFORM_DB.prepare(
        "SELECT sub FROM signup_waitlist WHERE email = ?1 AND status <> 'approved' ORDER BY joined_at, sub",
      )
        .bind(e)
        .all<{ sub: string }>()
    ).results.map((r) => r.sub);
    const [first, ...rest] = subs;
    if (first === undefined) {
      results.push({ entry: e });
      continue;
    }
    const r = await approveRow(env, p, first, ip, via);
    // A second row for the same address is marked approved without a second email.
    for (const sub of rest)
      await env.PLATFORM_DB.prepare(
        "UPDATE signup_waitlist SET status = 'approved', decided_by = ?2, decided_at = ?3 WHERE sub = ?1 AND status <> 'approved'",
      )
        .bind(sub, by, Date.now())
        .run();
    results.push({
      entry: e,
      approved: r.result === "approved",
      ...(r.emailSent === undefined ? {} : { emailSent: r.emailSent }),
      ...(r.emailError ? { emailError: r.emailError } : {}),
    });
  }
  return ok({ added: entries, results });
}

export async function remove(
  env: Env,
  p: Principal,
  raw: string,
  ip: string | undefined,
  via: Via = {},
): Promise<Json> {
  let entry: string;
  try {
    entry = normEntry(decodeURIComponent(raw));
  } catch {
    throw invalid("bad entry");
  }
  const res = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "DELETE FROM signup_allowlist WHERE entry = ?1",
    ).bind(entry),
    await auditStatement(
      env,
      {
        action: BETA_ACTIONS.allowRemove,
        actor: p,
        outcome: "ok",
        ip,
        detail: { ...via, entry },
      },
      true,
    ),
    // An approved row whose email this entry is goes back to waiting (and
    // forgets who decided and that it was emailed), so the person can be
    // approved again. Only when the entry was there to remove.
    env.PLATFORM_DB.prepare(
      "UPDATE signup_waitlist SET status = 'waiting', decided_by = NULL, decided_at = NULL, emailed_at = NULL WHERE status = 'approved' AND email = ?1 AND changes() > 0",
    ).bind(entry),
  ]);
  if ((res[0]?.meta.changes ?? 0) !== 1)
    throw new ApiError("not_found", "that entry is not on the list");
  return ok({ removed: entry });
}

/**
 * Serves one /api/v1/beta request. `method` and `sub` (the path after
 * /api/v1/beta) pick the handler; unknown ones are 404.
 */
export async function betaApi(
  env: Env,
  p: Principal,
  req: { method: string; sub: string; url: URL; body: () => Promise<unknown> },
  ip: string,
): Promise<Json> {
  if (p.kind !== "admin") {
    await tryAudit(env, {
      action: "authz.refused",
      actor: p,
      outcome: "refused",
      code: "forbidden",
      ip,
      detail: { action: "beta", path: req.sub },
    });
    throw new ApiError("forbidden");
  }
  const { method, sub } = req;
  if (method === "GET" && sub === "/stats") return stats(env);
  if (method === "GET" && sub === "/waitlist")
    return listWaitlist(env, req.url);
  if (method === "GET" && sub === "/allowlist") return listAllowed(env);
  if (method === "POST" && sub === "/waitlist/approve")
    return approve(env, p, await req.body(), ip);
  if (method === "POST" && sub === "/waitlist/decline")
    return decline(env, p, await req.body(), ip);
  if (method === "POST" && sub === "/allowlist")
    return add(env, p, await req.body(), ip);
  const rm = method === "DELETE" ? /^\/allowlist\/([^/]+)$/.exec(sub) : null;
  if (rm?.[1]) return remove(env, p, rm[1], ip);
  throw new ApiError("not_found");
}

// The admin MCP tools (hosted-tools.ts) call the same functions as betaApi
// above, each surface keeping its own authz. Over MCP the principal is an
// admin's OAuth grant (as set_install_tier): installs:read lists, installs:write
// writes. An oat_ token, OIDC or a session is forbidden. The prod "yes" for a
// write is the operator's own, at the client, as for every admin write tool.

export const BETA_TOOLS = {
  list: "list_waitlist",
  approve: "approve_waitlist",
  allow: "allow_signup",
  remove: "remove_allowed",
  stats: "beta_stats",
} as const;

export const ListWaitlistInput = z
  .object({
    status: WaitlistStatus.optional(),
    q: z.string().max(200).optional(),
  })
  .strict();
export const ApproveInput = ApproveSchema;
export const AllowInput = AddSchema;
export const RemoveInput = z
  .object({ entry: z.string().min(1).max(320) })
  .strict();
export const StatsInput = z.object({}).strict();

/** An admin's OAuth grant holding the scope; nothing else over MCP. */
const mayBetaMcp = (p: Principal, write: boolean) =>
  p.kind === "token" &&
  p.tokenKind === "oauth" &&
  p.scopes.includes(write ? "installs:write" : "installs:read");

/**
 * Runs one beta tool: authz (refusal audited), then the shared function with
 * the surface in every audit row's detail.
 */
export async function betaMcp(
  env: Env,
  p: Principal,
  tool: string,
  write: boolean,
  clientVersion: string | null,
  run: (via: Via) => Promise<Json>,
): Promise<Json> {
  if (!mayBetaMcp(p, write)) {
    await tryAudit(env, {
      action: "authz.refused",
      actor: p,
      outcome: "refused",
      code: "forbidden",
      detail: { action: "beta", surface: "mcp", tool },
    });
    throw new ApiError("forbidden");
  }
  return run({
    surface: "mcp",
    tool,
    clientVersion,
    ...(p.kind === "token"
      ? { via: p.tokenKind, client: p.client ?? null }
      : {}),
  });
}
