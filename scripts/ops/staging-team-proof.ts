#!/usr/bin/env node
// #2123 (per-creator monthly billing), staging only: a real Stripe test-mode
// Team MONTHLY subscription on a throwaway `bill-proof-` install, so the
// webhook and the creator-count quantity sync can be watched end to end.
// Runs only in CI (.github/workflows/staging-team-proof.yml); the Stripe key
// never touches a laptop.
//
//   create  take the install's Stripe customer from its billing tiers row (the
//           webhook maps events to an install only by tiers.stripe_customer_id;
//           none yet: make one with metadata[install_id] as /checkout does and
//           map it with the same conditional UPDATE), attach pm_card_visa as
//           the default card, then create a Team monthly subscription at
//           quantity 1 with metadata[tier]=team (what Checkout writes). The
//           billing webhook then moves the tiers row to team / active.
//   cancel  cancel that install's proof subscription at once.
//   read    print the proof subscription's item quantity.
//
// The install is named by its slug, which must start with `bill-proof-`. It is
// resolved through the staging platform D1 (installs) and the staging broker
// registry: the registry entry's origin must be exactly https://<slug>.<the
// staging app zone>. rl-a, rl-b, m2-walk and every other slug are refused.
//
// Env: SLUG, ACTION (create|cancel|read), STRIPE_SECRET_KEY (test key only),
// STRIPE_PRICE_TEAM, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
// PLATFORM_DB_ID, BILLING_DB_ID, BROKER_REGISTRY_ID. Output: the subscription
// id, status, quantity and price id. Secrets are never printed.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, d1, Refused } from "./platform-db.ts";

export { Refused };

const STRIPE = "https://api.stripe.com";
const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]{8,255}$/;
export const SLUG_RE = /^bill-proof-[a-z0-9]+(-[a-z0-9]+)*$/;
export const STAGING_APP_ZONE = "open-artifacts-staging.app";
const INSTALL = /^i[a-z0-9]{11}$/;
const PRICE = /^price_[A-Za-z0-9]+$/;
const CUSTOMER = /^cus_[A-Za-z0-9]+$/;
/** Marks the subscriptions this script makes (and the only ones it touches). */
export const PROOF = "2123";
const LIVE = new Set([
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "incomplete",
]);

export interface Io {
  fetch: typeof fetch;
  platformDb: Db;
  billingDb: Db;
  /** The broker registry KV value of a key, or null. */
  registryGet: (key: string) => Promise<string | null>;
  log: (s: string) => void;
}

type Obj = Record<string, unknown>;
type Call = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  form?: Record<string, string>,
  headers?: Record<string, string>,
) => Promise<Obj>;

export function stripeClient(key: string, f: typeof fetch): Call {
  if (!TEST_KEY.test(key))
    throw new Refused("STRIPE_SECRET_KEY must be a Stripe test-mode key");
  return async (method, path, form, headers) => {
    const res = await f(`${STRIPE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(form
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
        ...(headers ?? {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      redirect: "manual",
    });
    let out: Obj = {};
    try {
      out = (await res.json()) as Obj;
    } catch {
      // Falls through to the status check.
    }
    if (!res.ok) {
      const e = out.error as
        | { type?: unknown; code?: unknown; message?: unknown }
        | undefined;
      // On a 403 name only the missing permissions (rak_*). The message also
      // holds a partly masked key, so it is never printed.
      const needs =
        res.status === 403 && typeof e?.message === "string"
          ? [...new Set(e.message.match(/\brak_[a-z_]+\b/g) ?? [])]
          : [];
      throw new Refused(
        `stripe ${method} ${path.replace(/\/(cus|sub|pm|in)_[A-Za-z0-9]+/g, "/<id>").replace(/\?.*$/, "")}: ${res.status} ${String(e?.code ?? e?.type ?? "error")}${needs.length > 0 ? ` (needs ${needs.join(", ")})` : ""}`,
      );
    }
    return out;
  };
}

const str = (o: Obj, k: string): string => {
  const v = o[k];
  if (typeof v !== "string" || v === "") throw new Refused(`no ${k} in answer`);
  return v;
};

/**
 * The install id of a `bill-proof-` slug, or a refusal. Three agreeing
 * sources: the platform D1 installs row (slug, app host, active), and the
 * broker registry entry (same id, origin exactly https://<slug>.<zone>).
 */
export async function resolveInstall(io: Io, slug: string): Promise<string> {
  if (!SLUG_RE.test(slug))
    throw new Refused("the slug must start with bill-proof-");
  const r = (
    await io.platformDb.all(
      "SELECT id, slug, app_host, state FROM installs WHERE slug = ?1",
      [slug],
    )
  )[0];
  if (!r) throw new Refused("no such install in the staging platform");
  const id = r.id;
  if (typeof id !== "string" || !INSTALL.test(id))
    throw new Refused("the install row has no install id");
  const host = `${slug}.${STAGING_APP_ZONE}`;
  if (r.slug !== slug || r.app_host !== host)
    throw new Refused("the install is not on the staging app zone");
  if (r.state !== "active") throw new Refused("the install is not active");
  const raw = await io.registryGet(`install:${id}`);
  let entry: Obj | null = null;
  try {
    entry = raw === null ? null : (JSON.parse(raw) as Obj);
  } catch {
    // Refused below.
  }
  if (!entry) throw new Refused("no broker registry entry for the install");
  if (entry.installId !== id || entry.origin !== `https://${host}`)
    throw new Refused("the broker registry origin is not the proof install's");
  return id;
}

interface Row {
  customer: string | null;
}

async function rowOf(db: Db, install: string): Promise<Row> {
  const r = (
    await db.all("SELECT stripe_customer_id FROM tiers WHERE install_id = ?1", [
      install,
    ])
  )[0];
  if (!r)
    throw new Refused("the install has no billing row in staging billing");
  const c = r.stripe_customer_id;
  return { customer: typeof c === "string" && c ? c : null };
}

/** The install's Stripe customer: the mapped one, else a new one mapped now. */
async function customerOf(
  io: Io,
  call: Call,
  install: string,
  row: Row,
): Promise<string> {
  if (row.customer) {
    if (!CUSTOMER.test(row.customer))
      throw new Refused("the stored customer id is not a customer id");
    return row.customer;
  }
  // As billing's /checkout: metadata[install_id], Idempotency-Key cust-<id>,
  // then a conditional UPDATE where none is mapped yet.
  const made = await call(
    "POST",
    "/v1/customers",
    { "metadata[install_id]": install },
    { "idempotency-key": `cust-${install}` },
  );
  const id = str(made, "id");
  await io.billingDb.all(
    "UPDATE tiers SET stripe_customer_id = ?1 WHERE install_id = ?2 AND stripe_customer_id IS NULL",
    [id, install],
  );
  const now = await rowOf(io.billingDb, install);
  if (now.customer !== id)
    throw new Refused("the customer did not map to the install");
  return id;
}

interface Sub {
  id: string;
  status: string;
  quantity: string;
  price: string;
}

const subOf = (s: Obj): Sub => {
  const item = (s.items as { data?: Obj[] } | undefined)?.data?.[0];
  return {
    id: str(s, "id"),
    status: String(s.status),
    quantity: String(item?.quantity ?? "none"),
    price: String(((item?.price ?? {}) as Obj).id ?? "none"),
  };
};

/** The customer's proof subscriptions, newest first. */
async function proofSubs(call: Call, customer: string): Promise<Obj[]> {
  const out = await call(
    "GET",
    `/v1/subscriptions?customer=${customer}&status=all&limit=100`,
  );
  return ((out.data as Obj[] | undefined) ?? []).filter(
    (s) => (s.metadata as Obj | undefined)?.proof === PROOF,
  );
}

const print = (io: Io, s: Sub) =>
  io.log(
    `subscription ${s.id} status ${s.status} quantity ${s.quantity} price ${s.price}`,
  );

export interface Input {
  slug: string;
  action: string;
  priceTeam: string;
  /** staging.json's stripe_price_team: the price must be this one. */
  stagingPriceTeam: string;
}

export async function run(io: Io, call: Call, i: Input): Promise<void> {
  if (i.action !== "create" && i.action !== "cancel" && i.action !== "read")
    throw new Refused("ACTION is create, cancel or read");
  if (!PRICE.test(i.priceTeam) || i.priceTeam !== i.stagingPriceTeam)
    throw new Refused("STRIPE_PRICE_TEAM is not staging's Team monthly price");
  const install = await resolveInstall(io, i.slug);
  const row = await rowOf(io.billingDb, install);

  if (i.action === "create") {
    const customer = await customerOf(io, call, install, row);
    if (
      (await proofSubs(call, customer)).some((s) => LIVE.has(String(s.status)))
    )
      throw new Refused("a live proof subscription exists: cancel it first");
    const pm = await call("POST", "/v1/payment_methods/pm_card_visa/attach", {
      customer,
    });
    const pmId = str(pm, "id");
    await call("POST", `/v1/customers/${customer}`, {
      "invoice_settings[default_payment_method]": pmId,
    });
    const sub = await call("POST", "/v1/subscriptions", {
      customer,
      "items[0][price]": i.priceTeam,
      "items[0][quantity]": "1",
      default_payment_method: pmId,
      "metadata[tier]": "team",
      "metadata[proof]": PROOF,
    });
    print(io, subOf(sub));
    return;
  }

  if (!row.customer) throw new Refused("the install has no Stripe customer");
  const subs = await proofSubs(call, row.customer);
  if (i.action === "read") {
    const s = subs[0];
    if (!s) throw new Refused("no proof subscription");
    print(io, subOf(s));
    return;
  }
  const live = subs.find((s) => LIVE.has(String(s.status)));
  if (!live) throw new Refused("no live proof subscription");
  print(
    io,
    subOf(await call("DELETE", `/v1/subscriptions/${str(live, "id")}`)),
  );
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const fail = (msg: string): never => {
    console.error(`staging-team-proof: ${msg}`);
    process.exit(1);
  };
  const e = process.env;
  const uuid = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  if (!SLUG_RE.test(e.SLUG ?? "")) fail("SLUG must start with bill-proof-");
  if (!["create", "cancel", "read"].includes(e.ACTION ?? ""))
    fail("ACTION is create, cancel or read");
  if (!e.CLOUDFLARE_API_TOKEN) fail("CLOUDFLARE_API_TOKEN is required");
  const acct = e.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (!/^[0-9a-f]{32}$/.test(acct))
    fail("CLOUDFLARE_ACCOUNT_ID must be 32 hex");
  if (!uuid.test(e.PLATFORM_DB_ID ?? "")) fail("PLATFORM_DB_ID must be a uuid");
  if (!uuid.test(e.BILLING_DB_ID ?? "")) fail("BILLING_DB_ID must be a uuid");
  if (!/^[0-9a-f]{32}$/.test(e.BROKER_REGISTRY_ID ?? ""))
    fail("BROKER_REGISTRY_ID must be 32 hex");
  try {
    const staging = JSON.parse(
      readFileSync(
        new URL("../../.github/hosted/staging.json", import.meta.url),
        "utf8",
      ),
    ) as Obj;
    if (staging.app_zone !== STAGING_APP_ZONE)
      throw new Refused("staging.json is not the staging app zone");
    const token = e.CLOUDFLARE_API_TOKEN as string;
    const db = (databaseId: string) =>
      d1({ token, accountId: acct, databaseId });
    const io: Io = {
      fetch,
      platformDb: db(e.PLATFORM_DB_ID as string),
      billingDb: db(e.BILLING_DB_ID as string),
      registryGet: async (key) => {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${e.BROKER_REGISTRY_ID}/values/${encodeURIComponent(key)}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (res.status === 404) return null;
        if (!res.ok) throw new Refused(`registry read failed: ${res.status}`);
        return res.text();
      },
      log: (s) => console.log(`staging-team-proof: ${s}`),
    };
    await run(io, stripeClient(e.STRIPE_SECRET_KEY ?? "", fetch), {
      slug: e.SLUG as string,
      action: e.ACTION as string,
      priceTeam: e.STRIPE_PRICE_TEAM ?? "",
      stagingPriceTeam: String(staging.stripe_price_team),
    });
  } catch (err) {
    fail(err instanceof Refused ? err.message : "failed");
  }
}
