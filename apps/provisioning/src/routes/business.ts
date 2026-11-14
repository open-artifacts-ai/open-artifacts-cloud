import { z } from "zod";
import { type AuditEntry, audit, auditStatement } from "../audit.js";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";
import type { Principal } from "../principal.js";

// The Business requests admin API (open-artifacts#2404): the requests the
// public contact form records. Served on the admin host like the beta API
// (app.ts: authn, CSRF and the read or write limit first); this file repeats
// the kind check and fails closed: an admin session only.
//
//   GET   /api/v1/business-requests?status=   newest first
//   PATCH /api/v1/business-requests/:id       { status }
//
// Over MCP, list_business_requests is a read-only tool with the beta tools'
// authz (betaMcp, in beta.ts).

export const BUSINESS_PATH_RE = /^\/api\/v1\/business-requests(\/[^?]*)?$/;

export const BUSINESS_ACTIONS = { status: "business_request.status" } as const;
export const BUSINESS_TOOL = "list_business_requests";
const LIST_LIMIT = 500;

const STATUSES = ["new", "contacted", "closed"] as const;
const FilterSchema = z.enum([...STATUSES, "all"]);
const PatchSchema = z.object({ status: z.enum(STATUSES) }).strict();
export const ListBusinessInput = z
  .object({ status: FilterSchema.optional() })
  .strict();

type Json = { status: number; body: unknown };

const tryAudit = (env: Env, e: AuditEntry) => audit(env, e).catch(() => {});
const who = (p: Principal) => p.email ?? p.label;

type Row = {
  id: string;
  created_at: number;
  name: string;
  email: string;
  company: string;
  team_size: string;
  needs: string;
  note: string | null;
  source: string;
  instance_host: string | null;
  status: string;
  status_changed_at: number | null;
  status_changed_by: string | null;
};

const needsOf = (raw: string): string[] => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const item = (r: Row) => ({
  id: r.id,
  createdAt: r.created_at,
  name: r.name,
  email: r.email,
  company: r.company,
  teamSize: r.team_size,
  needs: needsOf(r.needs),
  note: r.note,
  source: r.source,
  instanceHost: r.instance_host,
  status: r.status,
  statusChangedAt: r.status_changed_at,
  statusChangedBy: r.status_changed_by,
});

const COLS =
  "id, created_at, name, email, company, team_size, needs, note, source, instance_host, status, status_changed_at, status_changed_by";

export async function listBusinessRequests(env: Env, url: URL): Promise<Json> {
  const st = FilterSchema.safeParse(url.searchParams.get("status") ?? "all");
  if (!st.success)
    throw new ApiError(
      "invalid_input",
      "status: new, contacted, closed or all",
    );
  const rows = await env.PLATFORM_DB.prepare(
    `SELECT ${COLS} FROM business_requests
WHERE (?1 = 'all' OR status = ?1)
ORDER BY created_at DESC, id DESC LIMIT ?2`,
  )
    .bind(st.data, LIST_LIMIT)
    .all<Row>();
  return { status: 200, body: { items: rows.results.map(item) } };
}

export async function setBusinessStatus(
  env: Env,
  p: Principal,
  id: string,
  body: unknown,
  ip: string | undefined,
): Promise<Json> {
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success)
    throw new ApiError("invalid_input", "status: new, contacted or closed");
  const row = await env.PLATFORM_DB.prepare(
    `SELECT ${COLS} FROM business_requests WHERE id = ?1`,
  )
    .bind(id)
    .first<Row>();
  if (!row) throw new ApiError("not_found", "no such request");
  if (row.status === parsed.data.status)
    return { status: 200, body: item(row) };
  const now = Date.now();
  const res = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "UPDATE business_requests SET status = ?2, status_changed_at = ?3, status_changed_by = ?4 WHERE id = ?1 AND status = ?5",
    ).bind(id, parsed.data.status, now, who(p), row.status),
    await auditStatement(
      env,
      {
        action: BUSINESS_ACTIONS.status,
        actor: p,
        outcome: "ok",
        ip,
        email: row.email,
        detail: { id, from: row.status, to: parsed.data.status },
      },
      true,
    ),
  ]);
  if ((res[0]?.meta.changes ?? 0) !== 1)
    throw new ApiError("invalid_state", "the request changed; reload");
  return {
    status: 200,
    body: item({
      ...row,
      status: parsed.data.status,
      status_changed_at: now,
      status_changed_by: who(p),
    }),
  };
}

/** Serves one /api/v1/business-requests request; unknown ones are 404. */
export async function businessApi(
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
      detail: { action: "business_requests", path: req.sub },
    });
    throw new ApiError("forbidden");
  }
  const { method, sub } = req;
  if (method === "GET" && sub === "") return listBusinessRequests(env, req.url);
  const m = method === "PATCH" ? /^\/([^/]+)$/.exec(sub) : null;
  if (m?.[1]) return setBusinessStatus(env, p, m[1], await req.body(), ip);
  throw new ApiError("not_found");
}
