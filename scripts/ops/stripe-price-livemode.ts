#!/usr/bin/env node
// Prod's price check (#1568, prod bring-up): every configured Stripe price id
// must resolve under the live key with livemode true. A test-mode price (or a
// test key under the live name) answers livemode false or not found, and a
// deploy with it would sell nothing real. Fail closed: a failed call, a
// non-200, a malformed answer, or livemode anything but true refuses. Names the
// STRIPE_PRICE_* variable, never the price id's answer body, and never the key.
// Read-only (GET /v1/prices/<id>; the key needs Prices: Read).
// Usage: STRIPE_SECRET_KEY STRIPE_PRICE_* node scripts/ops/stripe-price-livemode.ts prod

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PRICE_VARS = [
  "STRIPE_PRICE_TEAM",
  "STRIPE_PRICE_BUSINESS",
  "STRIPE_PRICE_SOLO_MONTHLY",
  "STRIPE_PRICE_SOLO_YEARLY",
  "STRIPE_PRICE_TEAM_YEARLY",
  "STRIPE_PRICE_BUSINESS_YEARLY",
] as const;

const PRICE = /^price_[A-Za-z0-9]{1,255}$/;

/** One refusal per configured price that does not resolve with livemode true. */
export async function livemodeProblems(
  prices: Record<string, string | undefined>,
  key: string,
  f: typeof fetch = fetch,
): Promise<string[]> {
  const out: string[] = [];
  for (const name of PRICE_VARS) {
    const id = prices[name];
    if (!id) continue;
    if (!PRICE.test(id)) {
      out.push(`${name} is not a Stripe price id`);
      continue;
    }
    try {
      const res = await f(`https://api.stripe.com/v1/prices/${id}`, {
        headers: { authorization: `Bearer ${key}` },
      });
      if (res.status !== 200) {
        out.push(
          `${name}: Stripe answered ${res.status} (not found in live mode?)`,
        );
        continue;
      }
      const body = (await res.json()) as { livemode?: unknown };
      if (body.livemode !== true)
        out.push(`${name}: the price is not live mode (livemode is not true)`);
    } catch {
      out.push(`${name}: the price could not be read; refusing (fail closed)`);
    }
  }
  return out;
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const fail = (msg: string, code = 1): never => {
    console.error(msg);
    process.exit(code);
  };
  if (process.argv[2] !== "prod")
    fail("usage: stripe-price-livemode.ts prod", 2);
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!/^rk_live_[A-Za-z0-9]{8,255}$/.test(key))
    fail("STRIPE_SECRET_KEY must be a restricted live key (rk_live_)", 2);
  const problems = await livemodeProblems(
    Object.fromEntries(PRICE_VARS.map((n) => [n, process.env[n]])),
    key,
  );
  if (problems.length) {
    for (const p of problems) console.error(p);
    fail(
      `refusing to deploy billing on prod: ${problems.length} price id(s) are not live-mode prices`,
    );
  }
  console.log("billing price check: every configured price is live mode");
}
