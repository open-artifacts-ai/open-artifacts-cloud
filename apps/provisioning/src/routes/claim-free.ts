import { z } from "zod";
import { type AuditEntry, audit, auditStatement } from "../audit.js";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";
import type { Principal } from "../principal.js";
import { PURGE_REAUTH_MS } from "./writes.js";

// Operator-only: free a kept signup_accounts claim (#52). A purge of a
// suspended install keeps the owner's claim as a ban (#51); support lifts it
// here instead of editing D1 by hand. Not a contract route: the route
// contract is public, and this belongs to the hosted service. app.ts serves
// it on the admin host only, after authn and CSRF, so only an admin session
// reaches it; the kind check here repeats that and fails closed.

export const CLAIM_FREE_PATH = "/api/v1/signup-claims/free";

export const ClaimFreeSchema = z
  .object({
    sub: z.string().min(1).max(255).optional(),
    email: z.string().min(3).max(320).optional(),
    reason: z.string().trim().min(8).max(500),
  })
  .strict()
  .refine((b) => (b.sub === undefined) !== (b.email === undefined), {
    message: "exactly one of sub or email",
  });

export const CLAIM_FREE_ACTION = "signup_claim.free";

/** A signup still in flight, or whose install is not `deleted`: the claim is in use. */
const LIVE_SQL = `SELECT 1 AS x FROM signups s
  LEFT JOIN installs i ON i.id = s.install_id
WHERE s.signup_id = ?1
  AND (s.status IN ('pending', 'queued', 'waiting_cap', 'creating')
    OR (i.id IS NOT NULL AND i.state <> 'deleted'))
UNION ALL
SELECT 1 FROM jobs j JOIN installs i2 ON i2.id = j.install_id
WHERE j.signup_id = ?1 AND i2.state <> 'deleted'
LIMIT 1`;

/** The Google subs an email has signed up with (installs or the signup queue). */
async function subsOfEmail(env: Env, email: string): Promise<string[]> {
  const rows = await env.PLATFORM_DB.prepare(
    `SELECT DISTINCT s.owner_sub AS sub FROM signups s
JOIN installs i ON i.id = s.install_id
WHERE s.owner_sub IS NOT NULL AND lower(i.owner_email) = lower(?1)
UNION
SELECT s.owner_sub FROM signups s
JOIN signup_secret k ON k.signup_id = s.signup_id
WHERE s.owner_sub IS NOT NULL AND lower(k.owner_email) = lower(?1)`,
  )
    .bind(email)
    .all<{ sub: string }>();
  return rows.results.map((r) => r.sub);
}

const tryAudit = (env: Env, e: AuditEntry) => audit(env, e).catch(() => {});

/** The handler: `body` is the parsed JSON (or undefined). */
export async function freeClaim(
  env: Env,
  p: Principal,
  body: unknown,
  ip: string,
): Promise<{ status: number; body: unknown }> {
  if (p.kind !== "admin") {
    await tryAudit(env, {
      action: "authz.refused",
      actor: p,
      outcome: "refused",
      code: "forbidden",
      ip,
      detail: { action: CLAIM_FREE_ACTION },
    });
    throw new ApiError("forbidden");
  }
  if (p.authAt == null || Date.now() - p.authAt > PURGE_REAUTH_MS)
    throw new ApiError("reauth_required", "sign in again to free a claim", {
      reauthUrl: `https://admin.${env.APP_DOMAIN}/auth/start?reauth=1&return=${encodeURIComponent("/")}`,
    });
  const parsed = ClaimFreeSchema.safeParse(body);
  if (!parsed.success)
    throw new ApiError("invalid_input", "invalid input", {
      fields: parsed.error.issues.map((i) => i.path.join(".") || "body"),
    });
  const { reason, email } = parsed.data;

  const refuse = async (
    code: "not_found" | "invalid_state" | "invalid_input",
    message: string,
    detail: Record<string, unknown> = {},
  ): Promise<never> => {
    await tryAudit(env, {
      action: CLAIM_FREE_ACTION,
      actor: p,
      outcome: "refused",
      code,
      ip,
      email,
      detail: { reason, ...detail },
    });
    throw new ApiError(code, message);
  };

  let sub = parsed.data.sub;
  if (sub === undefined && email !== undefined) {
    const subs = await subsOfEmail(env, email);
    if (subs.length === 0) return refuse("not_found", "no account for email");
    if (subs.length > 1)
      return refuse("invalid_input", "email matches several accounts; use sub");
    sub = subs[0];
  }
  if (sub === undefined) return refuse("invalid_input", "sub or email");

  const claim = await env.PLATFORM_DB.prepare(
    "SELECT owner_sub, signup_id, created_at, freed_at FROM signup_accounts WHERE owner_sub = ?1",
  )
    .bind(sub)
    .first<{
      owner_sub: string;
      signup_id: string;
      created_at: number;
      freed_at: number | null;
    }>();
  if (!claim) return refuse("not_found", "no claim for that account", { sub });
  if (claim.freed_at !== null)
    return refuse("invalid_state", "the claim is already free", {
      sub,
      signupId: claim.signup_id,
    });
  const live = await env.PLATFORM_DB.prepare(LIVE_SQL)
    .bind(claim.signup_id)
    .first();
  if (live)
    return refuse("invalid_state", "the claim's install is still live", {
      sub,
      signupId: claim.signup_id,
    });

  const now = Date.now();
  // One batch: the claim is never freed without its audit row.
  const res = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "UPDATE signup_accounts SET freed_at = ?3 WHERE owner_sub = ?1 AND signup_id = ?2 AND freed_at IS NULL",
    ).bind(sub, claim.signup_id, now),
    await auditStatement(env, {
      action: CLAIM_FREE_ACTION,
      actor: p,
      outcome: "ok",
      ip,
      email,
      detail: {
        sub,
        signupId: claim.signup_id,
        claimedAt: claim.created_at,
        reason,
      },
    }),
  ]);
  if ((res[0]?.meta.changes ?? 0) !== 1) throw new ApiError("invalid_state");
  return { status: 200, body: { freed: true, sub, freedAt: now } };
}
