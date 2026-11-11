#!/usr/bin/env node
// Staging only: makes the per-creator yearly Stripe prices, idempotently.
//   oa_team_yearly      $100 per creator per year (10000 cents)
//   oa_business_yearly  $250 per creator per year (25000 cents)
// Each is found by lookup_key and created only if missing, on the same Stripe
// Product as the env's monthly price (STRIPE_PRICE_TEAM / STRIPE_PRICE_BUSINESS,
// loaded by scripts/ci/hosted-constants.sh). Runs only in CI
// (.github/workflows/staging-stripe-prices.yml); the key never touches a laptop.
// Test-mode keys only (the same guard as staging-solo-clock.ts).
//
// Env: STRIPE_SECRET_KEY (test key only), STRIPE_PRICE_TEAM,
// STRIPE_PRICE_BUSINESS, DRY_RUN (1 = look, never create). Prints the price
// ids as STRIPE_PRICE_TEAM_YEARLY=... lines; never prints the key.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Refused, stripeClient } from "./staging-solo-clock.ts";

export { Refused };

type Obj = Record<string, unknown>;

export interface Plan {
  lookupKey: string;
  name: string;
  /** The env var holding the monthly price whose product this shares. */
  monthlyEnv: string;
  /** The env var name this id loads as. */
  out: string;
  cents: number;
}

export const PLANS: Plan[] = [
  {
    lookupKey: "oa_team_yearly",
    name: "Team (yearly, per creator)",
    monthlyEnv: "STRIPE_PRICE_TEAM",
    out: "STRIPE_PRICE_TEAM_YEARLY",
    cents: 10000,
  },
  {
    lookupKey: "oa_business_yearly",
    name: "Business (yearly, per creator)",
    monthlyEnv: "STRIPE_PRICE_BUSINESS",
    out: "STRIPE_PRICE_BUSINESS_YEARLY",
    cents: 25000,
  },
];

const PRICE = /^price_[A-Za-z0-9]{1,255}$/;

export interface Io {
  fetch: typeof fetch;
  log: (s: string) => void;
}

const idOf = (v: unknown): string =>
  typeof v === "string"
    ? v
    : typeof (v as Obj | null)?.id === "string"
      ? String((v as Obj).id)
      : "";

export async function run(
  env: Record<string, string | undefined>,
  io: Io,
): Promise<Record<string, string>> {
  const stripe = stripeClient(env.STRIPE_SECRET_KEY ?? "", io.fetch);
  const dry = env.DRY_RUN === "1";
  const ids: Record<string, string> = {};
  for (const p of PLANS) {
    const monthly = env[p.monthlyEnv] ?? "";
    if (!PRICE.test(monthly))
      throw new Refused(`${p.monthlyEnv} is not a Stripe price id`);
    const mp = await stripe("GET", `/v1/prices/${monthly}`);
    const product = idOf(mp.product);
    if (!product) throw new Refused(`no product on ${p.monthlyEnv}`);
    const tax = String(mp.tax_behavior ?? "unspecified");
    const found = await stripe(
      "GET",
      `/v1/prices?lookup_keys[]=${p.lookupKey}&active=true&limit=1`,
    );
    const hit = (found.data as Obj[] | undefined)?.[0];
    if (hit) {
      const rec = hit.recurring as Obj | undefined;
      const bad = [
        hit.unit_amount === p.cents || "amount",
        hit.currency === "usd" || "currency",
        rec?.interval === "year" || "interval",
        rec?.interval_count === 1 || "interval_count",
        rec?.usage_type === "licensed" || "usage_type",
        hit.billing_scheme === "per_unit" || "billing_scheme",
        idOf(hit.product) === product || "product",
        String(hit.tax_behavior ?? "unspecified") === tax || "tax_behavior",
      ].filter((x) => x !== true);
      if (bad.length)
        throw new Refused(
          `${p.lookupKey} exists but differs (${bad.join(", ")}): expected $${p.cents / 100}/year, licensed, per unit, on the ${p.monthlyEnv} product with its tax behavior; fix it in Stripe`,
        );
      ids[p.out] = idOf(hit.id);
      io.log(`${p.out}=${ids[p.out]} (found)`);
      continue;
    }
    if (dry) {
      io.log(
        `${p.out} would be created: ${p.cents} usd/year on ${product} (dry run)`,
      );
      continue;
    }
    const made = await stripe("POST", "/v1/prices", {
      currency: "usd",
      unit_amount: String(p.cents),
      "recurring[interval]": "year",
      product,
      lookup_key: p.lookupKey,
      nickname: p.name,
      ...(tax === "inclusive" || tax === "exclusive"
        ? { tax_behavior: tax }
        : {}),
    });
    ids[p.out] = idOf(made.id);
    if (!ids[p.out]) throw new Refused("no id in the created price");
    io.log(`${p.out}=${ids[p.out]} (created)`);
  }
  return ids;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === self) {
  run(process.env, { fetch, log: (s) => console.log(s) }).catch((e) => {
    console.error(e instanceof Refused ? e.message : "stripe-prices failed");
    process.exit(1);
  });
}
