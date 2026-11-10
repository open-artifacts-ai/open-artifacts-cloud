#!/usr/bin/env node
// M2 exit test, step 8 (staging only): proves a self-serve install's 30-day
// Solo trial ends and the $1 Solo charge is paid, with a Stripe test clock.
// Runs only in CI (.github/workflows/staging-solo-clock.yml); the Stripe key
// never touches a laptop. The install must be listed in billing's
// STAGING_TEST_CLOCK_INSTALLS so its customer was made on a clock
// (apps/billing/src/test-clock.ts).
//
//   advance  attach pm_card_visa to the customer and make it the default,
//            advance the clock to trial_end + 1h, wait for the clock to be
//            ready, then print the proof.
//   cleanup  delete the install's clock (Stripe deletes its customers and
//            subscriptions) and reset its billing rows (the tiers row, which
//            holds the customer map) through the billing D1.
//
// Env: INSTALL_ID, ACTION (advance|cleanup), STRIPE_SECRET_KEY (test key only),
// CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, BILLING_DB_ID. Secrets are
// never printed.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { d1, type Db, Refused } from "./platform-db.ts";

export { Refused };

const STRIPE = "https://api.stripe.com";
const INSTALL = /^i[a-z0-9]{11}$/;
const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]{8,255}$/;
/** Poll the clock every 3 s, for at most 5 minutes. */
export const POLL_MS = 3_000;
export const POLL_TIMEOUT_MS = 300_000;
/** The billing /tier answer follows the webhooks: wait up to 90 s for them. */
export const TIER_TIMEOUT_MS = 90_000;
const HOUR_S = 3600;

export interface Io {
  fetch: typeof fetch;
  db: Db;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (s: string) => void;
}

type Obj = Record<string, unknown>;

export function stripeClient(key: string, f: typeof fetch) {
  if (!TEST_KEY.test(key))
    throw new Refused("STRIPE_SECRET_KEY must be a Stripe test-mode key");
  return async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    form?: Record<string, string>,
  ): Promise<Obj> => {
    const res = await f(`${STRIPE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(form
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
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
      const e = out.error as { type?: unknown; code?: unknown } | undefined;
      throw new Refused(
        `stripe ${method} ${path.replace(/\/(cus|sub|clock|pm|in)_[A-Za-z0-9]+/g, "/<id>")}: ${res.status} ${String(e?.code ?? e?.type ?? "error")}`,
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
const num = (o: Obj, k: string): number => {
  const v = o[k];
  if (typeof v !== "number") throw new Refused(`no ${k} in answer`);
  return v;
};

interface Row {
  customer: string | null;
  clock: string | null;
  subscription: string | null;
}

async function rowOf(db: Db, install: string): Promise<Row | null> {
  const r = (
    await db.all(
      "SELECT stripe_customer_id, stripe_test_clock_id, stripe_subscription_id FROM tiers WHERE install_id = ?1",
      [install],
    )
  )[0];
  if (!r) return null;
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    customer: s(r.stripe_customer_id),
    clock: s(r.stripe_test_clock_id),
    subscription: s(r.stripe_subscription_id),
  };
}

/** The tiers row as billing's GET /tier shows it (billing's view()). */
async function tierView(db: Db, install: string) {
  const r = (
    await db.all(
      "SELECT tier, status, trial_ends_at, grace_until, solo_trial_ends_at, solo_status, version FROM tiers WHERE install_id = ?1",
      [install],
    )
  )[0];
  return r ?? null;
}

export async function advance(
  io: Io,
  call: ReturnType<typeof stripeClient>,
  install: string,
): Promise<void> {
  const { db, log } = io;
  const row = await rowOf(db, install);
  if (!row?.customer || !row.clock || !row.subscription)
    throw new Refused(
      "the install has no clock customer and Solo trial subscription yet: list it in STAGING_TEST_CLOCK_INSTALLS, deploy billing, and let it start its trial",
    );
  const customer = await call("GET", `/v1/customers/${row.customer}`);
  if (customer.test_clock !== row.clock)
    throw new Refused("the customer is not on the install's test clock");
  const sub0 = await call("GET", `/v1/subscriptions/${row.subscription}`);
  if (sub0.status !== "trialing")
    throw new Refused(
      `the subscription is ${String(sub0.status)}, not trialing`,
    );
  const trialEnd = num(sub0, "trial_end");
  const clock0 = await call("GET", `/v1/test_helpers/test_clocks/${row.clock}`);
  const target = trialEnd + HOUR_S;
  if (num(clock0, "frozen_time") >= target)
    throw new Refused("the clock is already past the trial end");

  // A card for the first charge.
  const pm = await call("POST", "/v1/payment_methods/pm_card_visa/attach", {
    customer: row.customer,
  });
  await call("POST", `/v1/customers/${row.customer}`, {
    "invoice_settings[default_payment_method]": str(pm, "id"),
  });
  log("card attached and set as default");

  await call("POST", `/v1/test_helpers/test_clocks/${row.clock}/advance`, {
    frozen_time: String(target),
  });
  const deadline = io.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const c = await call("GET", `/v1/test_helpers/test_clocks/${row.clock}`);
    if (c.status === "ready") break;
    if (c.status !== "advancing")
      throw new Refused(`the clock is ${String(c.status)}`);
    if (io.now() >= deadline)
      throw new Refused("the clock did not become ready in time");
    await io.sleep(POLL_MS);
  }
  log("clock ready");

  const sub = await call(
    "GET",
    `/v1/subscriptions/${row.subscription}?expand[]=latest_invoice`,
  );
  const inv = sub.latest_invoice as Obj | null;
  if (!inv || typeof inv !== "object")
    throw new Refused("the subscription has no invoice after the trial");
  const item = (sub.items as { data?: Obj[] } | undefined)?.data?.[0];
  const price = (item?.price ?? {}) as Obj;
  // The webhooks move the tiers row; give them a moment to land.
  let tier = await tierView(db, install);
  const until = io.now() + TIER_TIMEOUT_MS;
  while (tier?.solo_status !== "active" && io.now() < until) {
    await io.sleep(POLL_MS);
    tier = await tierView(db, install);
  }
  log(`subscription.status: ${String(sub.status)}`);
  log(`invoice.id: ${String(inv.id)}`);
  log(`invoice.amount_paid: ${String(inv.amount_paid)}`);
  log(`invoice.status: ${String(inv.status)}`);
  log(`invoice.currency: ${String(inv.currency)}`);
  log(
    `solo price: ${String(price.id)} unit_amount ${String(price.unit_amount)} ${String(price.currency)} per ${String((price.recurring as Obj | undefined)?.interval)}`,
  );
  log(`tier row (the /tier answer): ${JSON.stringify(tier)}`);
  const ok =
    sub.status === "active" &&
    inv.status === "paid" &&
    inv.amount_paid === 100 &&
    inv.amount_paid === price.unit_amount;
  log(ok ? "PROOF OK: trial ended, $1.00 Solo charge paid" : "PROOF FAILED");
  if (!ok) throw new Refused("the proof did not hold");
}

export async function cleanup(
  io: Io,
  call: ReturnType<typeof stripeClient>,
  install: string,
): Promise<void> {
  const { db, log } = io;
  const row = await rowOf(db, install);
  // Never reset a row that is not a clock install's: it may be a real staging
  // install's customer map. No row at all is only the orphan-clock sweep.
  if (row && !row.clock)
    throw new Refused(
      "the install's billing row has no test clock: it is not a clock install, refusing to reset it",
    );
  const ids = new Set<string>();
  if (row?.clock) ids.add(row.clock);
  // Orphans too: a clock named for the install whose row never stored it
  // (a lost concurrent start). The list is paged.
  let after = "";
  for (;;) {
    const page = await call(
      "GET",
      `/v1/test_helpers/test_clocks?limit=100${after ? `&starting_after=${after}` : ""}`,
    );
    const data = (page.data as Obj[] | undefined) ?? [];
    for (const c of data)
      if (c.name === install && typeof c.id === "string") ids.add(c.id);
    const last = data.at(-1)?.id;
    if (page.has_more !== true || typeof last !== "string") break;
    after = last;
  }
  for (const id of ids) {
    try {
      await call("DELETE", `/v1/test_helpers/test_clocks/${id}`);
      log("clock deleted");
    } catch (e) {
      // Already gone is fine; anything else stops before the rows reset.
      if (!(e instanceof Refused && /: 404 /.test(e.message))) throw e;
      log("clock already gone");
    }
  }
  if (ids.size === 0) log("no clock found");
  if (!row) {
    log("no billing row: swept clocks only");
    return;
  }
  // Customer map and tiers row go together: the next trial start makes a
  // fresh clock and customer. (There is no billing route for this.)
  await db.all("DELETE FROM tiers WHERE install_id = ?1", [install]);
  log("billing rows reset");
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const fail = (msg: string): never => {
    console.error(`staging-solo-clock: ${msg}`);
    process.exit(1);
  };
  const e = process.env;
  const install = e.INSTALL_ID ?? "";
  const action = e.ACTION ?? "";
  if (!INSTALL.test(install)) fail("INSTALL_ID is not an install id");
  if (action !== "advance" && action !== "cleanup")
    fail("ACTION is advance or cleanup");
  if (!e.CLOUDFLARE_API_TOKEN) fail("CLOUDFLARE_API_TOKEN is required");
  if (!/^[0-9a-f]{32}$/.test(e.CLOUDFLARE_ACCOUNT_ID ?? ""))
    fail("CLOUDFLARE_ACCOUNT_ID must be 32 hex");
  if (
    !/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(e.BILLING_DB_ID ?? "")
  )
    fail("BILLING_DB_ID must be a uuid");
  try {
    const io: Io = {
      fetch,
      db: d1({
        token: e.CLOUDFLARE_API_TOKEN as string,
        accountId: e.CLOUDFLARE_ACCOUNT_ID as string,
        databaseId: e.BILLING_DB_ID as string,
      }),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      log: (s) => console.log(`staging-solo-clock: ${s}`),
    };
    const call = stripeClient(e.STRIPE_SECRET_KEY ?? "", fetch);
    if (action === "advance") await advance(io, call, install);
    else await cleanup(io, call, install);
  } catch (err) {
    fail(err instanceof Refused ? err.message : "failed");
  }
}
