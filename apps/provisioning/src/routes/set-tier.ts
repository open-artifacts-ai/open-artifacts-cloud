import { INSTALL_ID_RE } from "@oa/provisioning-contract";
import { z } from "zod";
import { type AuditEntry, audit } from "../audit.js";
import type { BillingSetTierResult, Env } from "../env.js";
import { ApiError } from "../errors.js";
import { loadStatus } from "../model.js";
import type { Principal } from "../principal.js";
import { PURGE_REAUTH_MS } from "./writes.js";

// Operator-only: set an install's billing tier (#66), a comp. Billing owns the
// tiers table, so the write goes through billing's BillingOperatorRpc, never
// a D1 write from here; this side authorizes, checks the install exists and
// writes the audit row. Not a contract route (the route and authz tables are
// public): app.ts serves it on the admin host, and the admin MCP server
// registers it as a hosted-only tool. Who may call it is this file's rule:
// an admin session, or an admin's OAuth grant with installs:write (the same
// principal the admin MCP tools run as). Everything else is 403 and audited.

export const SET_TIER_PATH_RE = /^\/api\/v1\/installs\/([^/%]+)\/tier$/;
export const SET_TIER_ACTION = "install.tier_set";
export const SET_TIER_TOOL = "set_install_tier";

export const SetTierSchema = z
  .object({
    tier: z.enum(["team", "business", "solo"]),
    reason: z.string().trim().min(8).max(500),
  })
  .strict();

/** The MCP tool's input: the body plus the install. */
export const SetTierInputSchema = SetTierSchema.extend({
  id: z.string().regex(INSTALL_ID_RE),
}).strict();

const tryAudit = (env: Env, e: AuditEntry) => audit(env, e).catch(() => {});

/** An admin session, or an admin's OAuth grant that may write installs. */
const mayComp = (p: Principal) =>
  p.kind === "admin" ||
  (p.kind === "token" &&
    p.tokenKind === "oauth" &&
    p.scopes.includes("installs:write"));

export type SetTierSurface =
  | { kind: "http"; ip: string }
  | { kind: "mcp"; clientVersion: string | null };

/** Billing's refusals as API errors; the code is billing's, never its text. */
function billingRefusal(
  r: Extract<BillingSetTierResult, { ok: false }>,
): ApiError {
  switch (r.error) {
    case "subscription_active":
      return new ApiError(
        "invalid_state",
        "the install has a live Stripe subscription; Stripe owns its tier",
      );
    case "unknown_install":
      return new ApiError(
        "invalid_state",
        "billing does not know the install (not registered yet)",
      );
    case "bad_tier":
    case "bad_install":
      return new ApiError("invalid_input", r.error);
    default:
      return new ApiError("unavailable", "billing is unavailable; retry");
  }
}

export async function setTier(
  env: Env,
  p: Principal,
  installId: unknown,
  body: unknown,
  surface: SetTierSurface,
): Promise<{ status: number; body: unknown }> {
  const ip = surface.kind === "http" ? surface.ip : undefined;
  const via =
    surface.kind === "mcp"
      ? {
          surface: "mcp",
          tool: SET_TIER_TOOL,
          clientVersion: surface.clientVersion,
          ...(p.kind === "token"
            ? { via: p.tokenKind, client: p.client ?? null }
            : {}),
        }
      : {};
  const entry = (
    outcome: AuditEntry["outcome"],
    detail: Record<string, unknown>,
    over: Partial<AuditEntry> = {},
  ): AuditEntry => ({
    action: SET_TIER_ACTION,
    actor: p,
    outcome,
    ip,
    ...(typeof installId === "string" && INSTALL_ID_RE.test(installId)
      ? { installId }
      : {}),
    detail: { ...via, ...detail },
    ...over,
  });

  if (!mayComp(p)) {
    await tryAudit(env, {
      action: "authz.refused",
      actor: p,
      outcome: "refused",
      code: "forbidden",
      ip,
      detail: { action: SET_TIER_ACTION },
    });
    throw new ApiError("forbidden");
  }
  // A session needs a recent sign-in (as purge and claim-free do); a grant
  // has no sign-in time, and its authority is the admin's consent.
  if (
    p.kind === "admin" &&
    (p.authAt == null || Date.now() - p.authAt > PURGE_REAUTH_MS)
  )
    throw new ApiError("reauth_required", "sign in again to set a tier", {
      reauthUrl: `https://admin.${env.APP_DOMAIN}/auth/start?reauth=1&return=${encodeURIComponent("/")}`,
    });
  const parsed = SetTierSchema.safeParse(body);
  if (typeof installId !== "string" || !INSTALL_ID_RE.test(installId))
    throw new ApiError("not_found");
  if (!parsed.success)
    throw new ApiError("invalid_input", "invalid input", {
      fields: parsed.error.issues.map((i) => i.path.join(".") || "body"),
    });
  const { tier, reason } = parsed.data;

  const refuse = async (
    code: "not_found" | "invalid_state" | "unavailable" | "invalid_input",
    message: string,
    detail: Record<string, unknown> = {},
  ): Promise<never> => {
    await tryAudit(
      env,
      entry("refused", { tier, reason, ...detail }, { code }),
    );
    throw new ApiError(code, message);
  };

  const row = await loadStatus(env, installId);
  if (!row) return refuse("not_found", "no such install");
  if (row.install_state === null || row.install_state === "deleted")
    return refuse("invalid_state", "the install is not live", {
      state: row.state,
    });
  if (!env.BILLING) return refuse("unavailable", "billing is not bound here");

  let r: BillingSetTierResult;
  try {
    r = await env.BILLING.setTier(installId, tier);
  } catch {
    // The call itself failed: whether billing wrote is unknown.
    return refuse("unavailable", "billing did not answer; check, then retry", {
      outcome: "unknown",
    });
  }
  if (!r.ok) {
    const e = billingRefusal(r);
    return refuse(
      e.code as "invalid_state" | "unavailable" | "invalid_input",
      e.message,
      { billing: r.error },
    );
  }
  // Billing wrote; the audit row records it. If this insert fails the tier
  // is changed with no row: surface that rather than answer ok.
  await audit(
    env,
    entry("ok", {
      tier,
      reason,
      previous: r.previous,
      version: r.version,
    }),
  );
  return {
    status: 200,
    body: {
      installId,
      tier: r.tier,
      status: r.status,
      version: r.version,
      updatedAt: r.updatedAt,
      previous: r.previous,
    },
  };
}
