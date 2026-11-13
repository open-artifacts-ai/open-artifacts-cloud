#!/usr/bin/env node
// Prod's BILLING bind guard (#1568, prod bring-up): refuses to bind BILLING
// (the deploy of dispatch, the scheduler, the provisioner or provisioning,
// when the tag declares it) while any active install's rendered vars, the
// stored platform D1 `installs.vars` that verify_clean makes the live
// bindings match, lack a valid TIER. The server reads an install with no TIER
// and no billing row as Solo (S3), so such an install would lock to Solo the
// moment dispatch passes it the billing gate. Fail closed: a missing,
// unreadable or non-JSON vars value refuses too. Prints no number, id, slug
// or var value (the cloud repo's Actions logs are public); the list is read
// with oa-admin-prod. Read-only.
// Usage: CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID PLATFORM_DB_ID
//   node scripts/ops/billing-tier-check.ts prod
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { d1 } from "./platform-db.ts";

const TIERS = new Set(["trial", "team", "business"]);

export interface InstallRow {
  id: unknown;
  slug: unknown;
  state: unknown;
  vars: unknown;
}

/**
 * How many live installs (every state but deleted or deleting) have rendered vars without a valid TIER (missing,
 * unreadable or non-object vars count). A count only: the cloud repo's Actions
 * logs are public, so no install id or slug is ever returned or printed.
 */
export function tierProblemCount(rows: InstallRow[]): number {
  let n = 0;
  for (const r of rows) {
    if (r.state === "deleted" || r.state === "deleting") continue;
    let v: unknown;
    try {
      v = typeof r.vars === "string" ? JSON.parse(r.vars) : null;
    } catch {
      v = null;
    }
    const tier =
      v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>).TIER
        : undefined;
    if (typeof tier !== "string" || !TIERS.has(tier)) n++;
  }
  return n;
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const fail = (msg: string, code = 1): never => {
    console.error(msg);
    process.exit(code);
  };
  if (process.argv[2] !== "prod") fail("usage: billing-tier-check.ts prod", 2);
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, PLATFORM_DB_ID } =
    process.env;
  if (!CLOUDFLARE_API_TOKEN) fail("CLOUDFLARE_API_TOKEN is required", 2);
  if (!/^[0-9a-f]{32}$/.test(CLOUDFLARE_ACCOUNT_ID ?? ""))
    fail("CLOUDFLARE_ACCOUNT_ID must be 32 hex", 2);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      PLATFORM_DB_ID ?? "",
    )
  )
    fail("PLATFORM_DB_ID must be a uuid", 2);
  let bad = false;
  try {
    const rows = await d1({
      token: CLOUDFLARE_API_TOKEN as string,
      accountId: CLOUDFLARE_ACCOUNT_ID as string,
      databaseId: PLATFORM_DB_ID as string,
    }).all("SELECT id, slug, state, vars FROM installs ORDER BY id");
    bad = tierProblemCount(rows as unknown as InstallRow[]) > 0;
  } catch {
    fail(
      "billing bind check: the installs could not be read; refusing (fail closed)",
    );
  }
  if (bad)
    fail(
      "refusing: a live install has no valid TIER; read the list with oa-admin-prod",
    );
  console.log("billing bind check: ok");
}
