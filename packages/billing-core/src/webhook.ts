// POST billing.<zone>/stripe/webhook, mounted by oa-<p>-billing (#849):
//   handleStripeWebhook(req, { BILLING_DB, STRIPE_WEBHOOK_SECRET }, now)
//
// 1. The raw body is read once (at most MAX_WEBHOOK_BODY bytes, UTF-8) and
//    the Stripe-Signature checked over it, timestamp within 5 minutes,
//    BEFORE anything parses it. Bad: 400 bad_signature, nothing written.
// 2. Idempotency: the event id goes into stripe_events in the same D1 batch
//    as the change, and the change runs only when that insert added the row
//    (changes() = 1). A replay is 200 with no change.
// 3. The customer maps to an install only by tiers.stripe_customer_id: an
//    event can only ever change the row whose customer it names, never an
//    install it names in metadata or anywhere else. An unknown customer is
//    409 and its event id is NOT recorded, so Stripe retries it (billing's
//    /checkout writes the customer id before the session exists; this is
//    the backstop for the window in between) while the event is under an
//    hour old; an older one is recorded and answered 200.
//    Subscription and invoice events apply only to the row's own
//    subscription (or while it has none); the tier comes from the
//    subscription's current price, then its metadata. A suspended row's
//    status and grace are never overwritten; grace runs from `created`.
// 4. Ordering: Stripe delivers out of order. Two streams, each with its own
//    key: the subscription (checkout and customer.subscription.*) keeps its
//    newest applied event's `created` (last_event_created), invoices keep
//    theirs (last_invoice_created). An older event is recorded and skipped.
//    At the same second, nothing changes a lapsed row, so a delayed update
//    or a retried checkout never revives a deleted subscription. An invoice
//    never moves the subscription's key (a later-arriving tier change still
//    applies) and never applies over a newer subscription change.
// 5. The row's tier, status, trial_ends_at and grace_until move as below,
//    with version = version + 1 (installs never accept an older version).
//
// Logs: fixed categories and the install id only; never a body, header or
// Stripe id. Stripe test mode only: a livemode event changes nothing.

/** Webhook bodies are a few KB; anything this large is refused unread. */
export const MAX_WEBHOOK_BODY = 1024 * 1024;
/** past_due keeps the paid tier this long (then the install is read-only). */
export const GRACE_MS = 7 * 86_400_000;

export interface WebhookEnv {
  BILLING_DB: D1Database;
  STRIPE_WEBHOOK_SECRET: string;
  /** The Stripe price ids billing sells (optional): a price id matching one names the tier. */
  STRIPE_PRICE_TEAM?: string;
  STRIPE_PRICE_BUSINESS?: string;
  /** Solo's two prices (#1568); either one names the tier solo. */
  STRIPE_PRICE_SOLO_MONTHLY?: string;
  STRIPE_PRICE_SOLO_YEARLY?: string;
  /**
   * Stripe test-mode key (a Worker secret), only for cancelling the
   * subscription an upgrade replaces. Without it (or with a live key) that
   * cancel can't run: the webhook answers 500 and keeps the intent.
   */
  STRIPE_SECRET_KEY?: string;
  /** Test seam for that cancel; defaults to the global fetch. */
  stripeFetch?: typeof fetch;
}

/** The price ids that name a tier (from the webhook env, when it has them). */
export type PriceIds = {
  team?: string;
  business?: string;
  soloMonthly?: string;
  soloYearly?: string;
};

/** The price ids of a webhook env, in PriceIds' shape. */
export const pricesOf = (env: WebhookEnv): PriceIds => ({
  team: env.STRIPE_PRICE_TEAM,
  business: env.STRIPE_PRICE_BUSINESS,
  soloMonthly: env.STRIPE_PRICE_SOLO_MONTHLY,
  soloYearly: env.STRIPE_PRICE_SOLO_YEARLY,
});

const anyConfigured = (p: PriceIds): boolean =>
  Boolean(p.team || p.business || p.soloMonthly || p.soloYearly);

import { cancelSubscription, type StripeConfig } from "./sessions.js";
import { verifyStripeSignature } from "./signature.js";

export type PaidTier = "solo" | "team" | "business";
export type TierStatus = "active" | "past_due" | "lapsed" | "suspended";

/** The event fields we act on; anything else in Stripe's payload is ignored. */
export type StripeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  /** Stripe's event time, epoch seconds: the ordering key. */
  created: number;
  /** data.object */
  object: Record<string, unknown>;
};

export const HANDLED = [
  "checkout.session.completed",
  // A delayed payment method's checkout paid later (#1568): the same change
  // as a paid completed.
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.paid",
] as const;

const EVENT_ID = /^evt_[A-Za-z0-9_]{1,255}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{1,255}$/;
const SUB_ID = /^sub_[A-Za-z0-9]{1,255}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The event, or null when it isn't a Stripe event shape. Pure. */
export function parseEvent(text: string): StripeEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.object !== "event") return null;
  const { id, type, livemode, created, data } = raw;
  if (typeof id !== "string" || !EVENT_ID.test(id)) return null;
  if (typeof type !== "string" || typeof livemode !== "boolean") return null;
  if (
    typeof created !== "number" ||
    !Number.isSafeInteger(created) ||
    created < 0
  )
    return null;
  if (!isObj(data) || !isObj(data.object)) return null;
  return { id, type, livemode, created, object: data.object };
}

/** An object's customer id (a string or an expanded customer), or null. */
export function customerOf(o: Record<string, unknown>): string | null {
  const c = o.customer;
  const id = typeof c === "string" ? c : isObj(c) ? c.id : null;
  return typeof id === "string" && CUSTOMER_ID.test(id) ? id : null;
}

const asTier = (v: unknown): PaidTier | null =>
  v === "solo" || v === "team" || v === "business" ? v : null;

/**
 * A subscription's paid tier, from its current price first, so a plan
 * switch changes the tier: the first item whose price id is one of
 * `prices`, or whose price metadata.tier or lookup_key names one. Only when
 * no price names one: the subscription's metadata.tier (Checkout writes it
 * through subscription_data; it is the tier it was bought at, not the
 * current plan). Null when none does (the tier is then left as it is). Pure.
 */
export function tierFromSubscription(
  sub: Record<string, unknown>,
  prices: PriceIds = {},
): PaidTier | null {
  const items =
    isObj(sub.items) && Array.isArray(sub.items.data) ? sub.items.data : [];
  const configured = anyConfigured(prices);
  for (const item of items) {
    if (!isObj(item) || !isObj(item.price)) continue;
    const p = item.price;
    const byId =
      typeof p.id === "string" && p.id !== ""
        ? p.id === prices.team
          ? "team"
          : p.id === prices.business
            ? "business"
            : p.id === prices.soloMonthly || p.id === prices.soloYearly
              ? "solo"
              : null
        : null;
    // With the configured price ids, only they name a tier; an unknown
    // price falls through to the subscription's metadata.
    const t = configured
      ? byId
      : (byId ??
        (isObj(p.metadata) ? asTier(p.metadata.tier) : null) ??
        asTier(p.lookup_key));
    if (t) return t;
  }
  return isObj(sub.metadata) ? asTier(sub.metadata.tier) : null;
}

/**
 * True when the price ids are configured and a subscription's items have
 * prices, none of which is one of them (a price billing does not sell). Pure.
 */
export function unknownPrice(
  sub: Record<string, unknown>,
  prices: PriceIds,
): boolean {
  if (!anyConfigured(prices)) return false;
  const items =
    isObj(sub.items) && Array.isArray(sub.items.data) ? sub.items.data : [];
  const ids = items.flatMap((i) =>
    isObj(i) && isObj(i.price) && typeof i.price.id === "string"
      ? [i.price.id]
      : [],
  );
  return (
    ids.length > 0 &&
    !ids.some(
      (id) =>
        id === prices.team ||
        id === prices.business ||
        id === prices.soloMonthly ||
        id === prices.soloYearly,
    )
  );
}

/** Stripe subscription status → ours; null leaves the status as it is. Pure. */
export function statusFromSubscription(s: unknown): TierStatus | null {
  switch (s) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "paused":
      return "lapsed";
    default:
      // incomplete: the first payment is still pending; nothing changes.
      // incomplete_expired: it never completed; changeFor only drops the id.
      return null;
  }
}

const PAID = "tier IN ('solo', 'team', 'business')";
/**
 * The row's current subscription is live: a paid tier's, active or past_due,
 * or (during the 14-day Business trial) the Solo subscription under it, whose
 * state lives in solo_status.
 */
const PREV_LIVE =
  "(stripe_subscription_id IS NOT NULL AND ((tier = 'trial' AND coalesce(solo_status, '') IN ('active', 'past_due')) OR (tier IN ('solo', 'team', 'business') AND status IN ('active', 'past_due'))))";
const NOT_PAID = "coalesce(tier, '') NOT IN ('solo', 'team', 'business')";

/** One column assignment in the row update: SQL and its binds. */
type Set = { sql: string; args: unknown[] };

/**
 * The change an event makes to its customer's row, or null for an event we
 * don't act on. Pure. Grace runs from the event's own time (`created`), not
 * from when it was received, so a late delivery doesn't extend it.
 *
 * A suspended row's status and grace are never overwritten by any event
 * (suspension is set and cleared elsewhere).
 */
export function changeFor(
  ev: StripeEvent,
  prices: PriceIds = {},
): Set[] | null {
  const o = ev.object;
  const graceEnd = ev.created * 1000 + GRACE_MS;
  /**
   * `col = CASE WHEN <keep> THEN col ELSE <value> END`: a suspended row is
   * kept. `paid`: the one invariant of the row: past_due, lapsed and grace
   * apply only to a row on a paid tier (a free or trial row changes only
   * when a subscription goes live, which sets the tier). `stale`: a
   * subscription event older than the last invoice applied leaves status
   * and grace to that invoice (it still moves tier and id).
   */
  const guarded = (
    col: string,
    value: string,
    args: unknown[] = [],
    o: { paid?: boolean; stale?: boolean } = {},
  ): Set => ({
    sql: `${col} = CASE WHEN status = 'suspended'${o.paid ? ` OR ${NOT_PAID}` : ""}${o.stale ? " OR ? < coalesce(last_invoice_created, 0)" : ""} THEN ${col} ELSE ${value} END`,
    args: o.stale ? [ev.created, ...args] : args,
  });
  /**
   * The Solo subscription's state while the Business trial runs over it
   * (tier trial): recorded in solo_status and solo_grace_until, so the row
   * can become Solo when the trial ends. Other rows leave them alone. A
   * suspended row, or an event older than the last invoice (`stale`), too.
   */
  const shadow = (
    col: string,
    value: string,
    args: unknown[] = [],
    stale = false,
  ): Set => ({
    sql: `${col} = CASE WHEN tier = 'trial' AND status IS NOT 'suspended'${stale ? " AND NOT (? < coalesce(last_invoice_created, 0))" : ""} THEN ${value} ELSE ${col} END`,
    args: stale ? [ev.created, ...args] : args,
  });
  /**
   * A Solo-priced event sets tier solo, except on a row in its Business
   * trial: that trial is the row's tier until trial_ends_at passes (read
   * time), and a Solo event never ends it early.
   */
  const SOLO_TIER = "tier = CASE WHEN tier = 'trial' THEN tier ELSE 'solo' END";
  const setTier = (t: PaidTier): Set =>
    t === "solo"
      ? { sql: SOLO_TIER, args: [] }
      : { sql: "tier = ?", args: [t] };
  switch (ev.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const sub =
        typeof o.subscription === "string" && SUB_ID.test(o.subscription)
          ? o.subscription
          : null;
      const sets: Set[] = [];
      const payNow =
        o.payment_status === "paid" ||
        o.payment_status === "no_payment_required";
      if (sub) {
        // An unpaid checkout (a payment still pending) never takes the row's
        // live subscription from it: the row switches when the payment
        // succeeds (async_payment_succeeded). With no live one it records
        // the pending id, so that subscription's invoices apply (N9c).
        sets.push(
          payNow
            ? { sql: "stripe_subscription_id = ?", args: [sub] }
            : {
                sql: `stripe_subscription_id = CASE WHEN ${PREV_LIVE} AND stripe_subscription_id != ? THEN stripe_subscription_id ELSE ? END`,
                args: [sub, sub],
              },
        );
        // A paid checkout for another subscription replaces the live one
        // (Solo upgraded to Team or Business): remember it, and the webhook
        // cancels it after this update (settleCancel), so it is never billed
        // alongside. Once the row holds the new id the old one's own events
        // no longer apply to it. Kept if an earlier intent is still pending.
        if (payNow)
          sets.push({
            sql: `cancel_sub_id = CASE WHEN cancel_sub_id IS NULL AND ${PREV_LIVE} AND stripe_subscription_id != ? THEN stripe_subscription_id ELSE cancel_sub_id END`,
            args: [sub],
          });
      }
      // Paid (or nothing to pay): active at its tier. Otherwise (an async
      // payment still pending) the status and tier wait for the invoice and
      // subscription events.
      if (
        o.payment_status === "paid" ||
        o.payment_status === "no_payment_required"
      ) {
        sets.push(
          guarded("status", "'active'"),
          guarded("grace_until", "NULL"),
        );
        const tier = isObj(o.metadata) ? asTier(o.metadata.tier) : null;
        if (tier) sets.push(setTier(tier));
        if (tier === "solo")
          sets.push(
            shadow("solo_status", "'active'"),
            shadow("solo_grace_until", "NULL"),
          );
      }
      return sets.length ? sets : null;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sets: Set[] = [];
      const status = statusFromSubscription(o.status);
      const subId = typeof o.id === "string" && SUB_ID.test(o.id) ? o.id : null;
      if (o.status === "incomplete_expired") {
        // The first payment never completed: nothing it did stays, except
        // that a subscription id it set is dropped (so /checkout can retry).
        return subId
          ? [
              {
                sql: "stripe_subscription_id = CASE WHEN stripe_subscription_id = ? THEN NULL ELSE stripe_subscription_id END",
                args: [subId],
              },
            ]
          : null;
      }
      // A subscription that is or was live sets the tier: active, or past_due
      // (it has been live; incomplete never reaches past_due) so a reordered
      // or Portal-changed past_due update isn't left on the old tier (#1487).
      // Status and grace stay under their own guards.
      const tier =
        status === "active" || status === "past_due"
          ? tierFromSubscription(o, prices)
          : null;
      if (tier) sets.push(setTier(tier));
      const isSolo = tierFromSubscription(o, prices) === "solo";
      if (isSolo) {
        if (status === "active")
          sets.push(
            shadow("solo_status", "'active'", [], true),
            shadow("solo_grace_until", "NULL", [], true),
          );
        else if (status === "past_due")
          sets.push(
            shadow("solo_status", "'past_due'", [], true),
            shadow(
              "solo_grace_until",
              "coalesce(solo_grace_until, ?)",
              [graceEnd],
              true,
            ),
          );
        else if (status === "lapsed")
          sets.push(
            shadow("solo_status", "'lapsed'", [], true),
            shadow("solo_grace_until", "NULL", [], true),
          );
      }
      if (status === "active")
        sets.push(
          guarded("status", "'active'", [], { stale: true }),
          guarded("grace_until", "NULL", [], { stale: true }),
        );
      else if (status === "past_due")
        sets.push(
          guarded("status", "'past_due'", [], { paid: true, stale: true }),
          guarded("grace_until", "coalesce(grace_until, ?)", [graceEnd], {
            paid: true,
            stale: true,
          }),
        );
      else if (status === "lapsed")
        sets.push(
          guarded("status", "'lapsed'", [], { paid: true, stale: true }),
          guarded("grace_until", "NULL", [], { paid: true, stale: true }),
        );
      // Stripe's own trial (trialing), when one runs: its end. Not Solo's:
      // its 30-day no-card trial must leave trial_ends_at null, or the first
      // invite could never start the 14-day Business trial (billing's
      // TRIAL_SQL needs it unset); the Solo trial ends by cancel (lapsed).
      if (o.status === "trialing" && typeof o.trial_end === "number")
        sets.push({
          sql: isSolo ? "solo_trial_ends_at = ?" : "trial_ends_at = ?",
          args: [o.trial_end * 1000],
        });
      // incomplete (status null) changes nothing, not even the id.
      if (status && subId)
        sets.push({ sql: "stripe_subscription_id = ?", args: [subId] });
      return sets.length ? sets : null;
    }
    case "customer.subscription.deleted":
      // Ended: read-only on the install at once; nothing is deleted. A Solo
      // subscription that ends under a running Business trial is recorded
      // for when the trial ends.
      return [
        guarded("status", "'lapsed'", [], { paid: true }),
        guarded("grace_until", "NULL", [], { paid: true }),
        ...(tierFromSubscription(o, prices) === "solo"
          ? [
              shadow("solo_status", "'lapsed'"),
              shadow("solo_grace_until", "NULL"),
            ]
          : []),
      ];
    case "invoice.payment_failed":
      // Grace from the first failure; a suspended or lapsed row stays so.
      return [
        {
          sql: `status = CASE WHEN status IN ('active', 'past_due') AND ${PAID} THEN 'past_due' ELSE status END`,
          args: [],
        },
        {
          sql: `grace_until = CASE WHEN status IN ('active', 'past_due') AND ${PAID} THEN coalesce(grace_until, ?) ELSE grace_until END`,
          args: [graceEnd],
        },
        // Under a running Business trial: the Solo subscription's own state.
        shadow(
          "solo_status",
          "CASE WHEN solo_status IN ('active', 'past_due') THEN 'past_due' ELSE solo_status END",
        ),
        shadow(
          "solo_grace_until",
          "CASE WHEN solo_status IN ('active', 'past_due') THEN coalesce(solo_grace_until, ?) ELSE solo_grace_until END",
          [graceEnd],
        ),
      ];
    case "invoice.paid":
      // Only a past_due row comes back: an old invoice never revives a
      // lapsed or suspended one.
      return [
        {
          sql: `status = CASE WHEN status = 'past_due' AND ${PAID} THEN 'active' ELSE status END`,
          args: [],
        },
        {
          sql: `grace_until = CASE WHEN status = 'past_due' AND ${PAID} THEN NULL ELSE grace_until END`,
          args: [],
        },
        shadow(
          "solo_status",
          "CASE WHEN solo_status = 'past_due' THEN 'active' ELSE solo_status END",
        ),
        shadow(
          "solo_grace_until",
          "CASE WHEN solo_status = 'past_due' THEN NULL ELSE solo_grace_until END",
        ),
      ];
    default:
      return null;
  }
}

/**
 * The subscription an event is about (null when it names none): a
 * subscription event's own id, an invoice's subscription (top level, or
 * under parent.subscription_details on newer API versions). Checkout is not
 * asked: it is the event that sets the row's subscription.
 */
export function subscriptionOf(ev: StripeEvent): string | null {
  const o = ev.object;
  const idOf = (v: unknown) => (isObj(v) ? v.id : v);
  let v: unknown;
  if (ev.type.startsWith("customer.subscription.")) v = o.id;
  else {
    v = idOf(o.subscription);
    if (v === undefined || v === null) {
      const d = isObj(o.parent) ? o.parent.subscription_details : null;
      v = isObj(d) ? idOf(d.subscription) : null;
    }
  }
  return typeof v === "string" && SUB_ID.test(v) ? v : null;
}

/** A subscription event that ends or lapses the subscription (never takes a first one). */
const lapses = (ev: StripeEvent): boolean =>
  ev.type === "customer.subscription.deleted" ||
  ((ev.type === "customer.subscription.created" ||
    ev.type === "customer.subscription.updated") &&
    statusFromSubscription(ev.object.status) === "lapsed");

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** One fixed-category line, the install id only (never a Stripe id). */
const log = (category: string, install?: string | null) =>
  console.log("billing webhook", category, ...(install ? [install] : []));

async function rawText(req: Request): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_WEBHOOK_BODY)) {
    await req.body?.cancel();
    return null;
  }
  // Read the stream with a byte cap: a body with no (or a false)
  // Content-Length is never buffered past MAX_WEBHOOK_BODY.
  const reader = req.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_WEBHOOK_BODY) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
    const buf = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      buf.set(p, at);
      at += p.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }
}

/** An unknown customer's event is retried (409) only while this young. */
const UNKNOWN_RETRY_S = 3600;
const INSERT_EVENT =
  "INSERT INTO stripe_events (event_id, received_at) VALUES (?1, ?2) ON CONFLICT (event_id) DO NOTHING";
/** Recorded only when the customer is known (an unknown one is retried). */
const INSERT_KNOWN_EVENT =
  "INSERT INTO stripe_events (event_id, received_at) SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM tiers WHERE stripe_customer_id = ?3) ON CONFLICT (event_id) DO NOTHING";
const KNOWN =
  "SELECT EXISTS (SELECT 1 FROM tiers WHERE stripe_customer_id = ?) AS known";
/**
 * The two ordering streams (Stripe delivers out of order). The subscription
 * (checkout.session.completed, customer.subscription.*) orders by its own
 * last applied event (last_event_created); invoices by theirs
 * (last_invoice_created), so an invoice never advances the subscription's
 * key and never blocks a later-arriving genuine tier change.
 */
export type EventStream = "subscription" | "invoice";
export const streamOf = (type: string): EventStream =>
  type.startsWith("invoice.") ? "invoice" : "subscription";

/**
 * Subscription: newer than its last applied event; at the same second,
 * never on a lapsed row (a delayed update or retried checkout can't revive
 * it). Invoice: not older than the last invoice applied, nor than the
 * subscription's state (a delayed invoice never undoes a newer change).
 */
const IN_ORDER: Record<EventStream, string> = {
  subscription:
    "(?1 > coalesce(last_event_created, 0) OR (?1 = coalesce(last_event_created, 0) AND status IS NOT 'lapsed'))",
  invoice:
    "(?1 >= coalesce(last_invoice_created, 0) AND ?1 >= coalesce(last_event_created, 0))",
};
const ORDER_COLUMN: Record<EventStream, string> = {
  subscription: "last_event_created",
  invoice: "last_invoice_created",
};

/**
 * How long a webhook event id is kept for dedupe: Stripe retries a failed
 * delivery for up to 3 days, and a signature older than 5 minutes is refused,
 * so 30 days is a wide margin (#1479).
 */
export const STRIPE_EVENT_RETENTION_MS = 30 * 86_400_000;

/**
 * Deletes the stripe_events rows received more than STRIPE_EVENT_RETENTION_MS
 * before `now`; answers how many. A pruned id that arrives again is handled
 * as any event: ordered by `created` against the row, so an old event never
 * undoes newer state, and recorded again.
 */
export async function pruneStripeEvents(
  db: D1Database,
  now: number,
): Promise<number> {
  const r = await db
    .prepare("DELETE FROM stripe_events WHERE received_at < ?1")
    .bind(now - STRIPE_EVENT_RETENTION_MS)
    .run();
  return r.meta.changes;
}

/**
 * Cancels the subscription an upgrade replaced (tiers.cancel_sub_id, set in
 * the same update as the switch) and clears the intent. Idempotent: the
 * cancel repeats safely, and the clear is conditional on that id. False when
 * it could not (no or live key, Stripe down): the webhook answers 500, and
 * Stripe's retry (a replay of the recorded event) runs this again.
 */
async function settleCancel(
  db: D1Database,
  customer: string,
  env: WebhookEnv,
): Promise<boolean> {
  const r = await db
    .prepare("SELECT cancel_sub_id FROM tiers WHERE stripe_customer_id = ?")
    .bind(customer)
    .first<{ cancel_sub_id: string | null }>();
  const id = r?.cancel_sub_id;
  if (!id) return true;
  const cfg: StripeConfig = {
    secretKey: env.STRIPE_SECRET_KEY ?? "",
    ...(env.stripeFetch ? { fetch: env.stripeFetch } : {}),
  };
  try {
    await cancelSubscription({ subscriptionId: id }, cfg);
  } catch {
    log("cancel_failed");
    return false;
  }
  await db
    .prepare(
      "UPDATE tiers SET cancel_sub_id = NULL WHERE stripe_customer_id = ? AND cancel_sub_id = ?",
    )
    .bind(customer, id)
    .run();
  log("old_subscription_canceled");
  return true;
}

/** The Stripe webhook route. Never throws: a D1 error is 500 (Stripe retries). */
export async function handleStripeWebhook(
  req: Request,
  env: WebhookEnv,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") {
    await req.body?.cancel();
    return json({ error: "method_not_allowed" }, 405);
  }
  const secret = env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!secret.startsWith("whsec_")) {
    await req.body?.cancel();
    log("misconfigured");
    return json({ error: "misconfigured" }, 500);
  }
  const text = await rawText(req);
  if (text === null) {
    log("bad_body");
    return json({ error: "bad_body" }, 400);
  }
  const sig = await verifyStripeSignature(
    text,
    req.headers.get("stripe-signature"),
    secret,
    now,
  );
  if (!sig.ok) {
    log(`bad_signature_${sig.reason}`);
    return json({ error: "bad_signature" }, 400);
  }
  const ev = parseEvent(text);
  if (!ev) {
    log("bad_event");
    return json({ error: "bad_event" }, 400);
  }
  // No live keys anywhere: a live event (only possible on a misconfigured
  // endpoint) is acknowledged and changes nothing.
  if (ev.livemode) {
    log("livemode_ignored");
    return json({ received: true });
  }
  const change = changeFor(ev, pricesOf(env));
  const customer = customerOf(ev.object);
  try {
    const db = env.BILLING_DB;
    if (!change || !customer) {
      const res = await db.batch([db.prepare(INSERT_EVENT).bind(ev.id, now)]);
      const fresh = (res[0]?.meta.changes ?? 0) > 0;
      log(!fresh ? "replay" : !change ? "ignored_type" : "no_customer");
      return json({ received: true });
    }
    if (
      (ev.type === "customer.subscription.created" ||
        ev.type === "customer.subscription.updated") &&
      unknownPrice(ev.object, pricesOf(env))
    )
      log("unknown_price");
    const stream = streamOf(ev.type);
    const sets = [
      ...change,
      { sql: `${ORDER_COLUMN[stream]} = ?`, args: [ev.created] },
      { sql: "version = version + 1", args: [] },
      { sql: "updated_at = ?", args: [now] },
    ];
    // The sets use plain `?`; the WHERE binds by number after them.
    const n = sets.reduce((k, s) => k + s.args.length, 0);
    const isCheckout =
      ev.type === "checkout.session.completed" ||
      ev.type === "checkout.session.async_payment_succeeded";
    // Checkout names the subscription it sets (?n+2); the other events the
    // one they are about.
    const eventSub = isCheckout
      ? typeof ev.object.subscription === "string" &&
        SUB_ID.test(ev.object.subscription)
        ? ev.object.subscription
        : null
      : subscriptionOf(ev);
    let order = IN_ORDER[stream].replaceAll("?1", `?${n + 3}`);
    // A resubscribe's checkout is never "the old subscription revived": in
    // the same second as the old one's deletion it still applies when its
    // subscription differs from the row's.
    if (isCheckout && eventSub)
      order = `(${order} OR (?${n + 3} = coalesce(last_event_created, 0) AND stripe_subscription_id IS NOT ?${n + 2}))`;
    // Subscription and invoice events apply only to the row's own
    // subscription (or while it has none: checkout sets it). An invoice
    // naming no subscription (a one-off) never moves the row.
    const own = isCheckout
      ? ""
      : ev.type.startsWith("invoice.")
        ? // Only the row's own subscription: with none (or an unfinished
          // first payment) an invoice has nothing to move.
          eventSub
          ? ` AND stripe_subscription_id = ?${n + 2}`
          : " AND 0"
        : // A lapse (deleted, canceled) must be the row's own subscription: a
          // row with none is never lapsed by a stray one. Anything else may
          // also take the first live subscription of a row that has none.
          lapses(ev)
          ? ` AND stripe_subscription_id = ?${n + 2}`
          : ` AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ?${n + 2})`;
    const res = await db.batch<{ known?: number; install_id?: string }>([
      db.prepare(KNOWN).bind(customer),
      db.prepare(INSERT_KNOWN_EVENT).bind(ev.id, now, customer),
      db
        .prepare(
          // changes() is the event insert's: 1 the first time, 0 on a
          // replay or an unknown customer.
          `UPDATE tiers SET ${sets.map((s) => s.sql).join(", ")} WHERE stripe_customer_id = ?${n + 1} AND changes() = 1${own} AND ${order} RETURNING install_id`,
        )
        .bind(...sets.flatMap((s) => s.args), customer, eventSub, ev.created),
    ]);
    if (!res[0]?.results[0]?.known) {
      if (now / 1000 - ev.created < UNKNOWN_RETRY_S) {
        // Not recorded: Stripe retries until billing has written the customer.
        log("unknown_customer");
        return json({ error: "unknown_customer" }, 409);
      }
      // Too old to wait for: record it so Stripe stops retrying.
      await db.batch([db.prepare(INSERT_EVENT).bind(ev.id, now)]);
      log("unknown_customer");
      return json({ received: true });
    }
    const settled = await settleCancel(db, customer, env);
    if ((res[1]?.meta.changes ?? 0) === 0) {
      log("replay");
      return settled
        ? json({ received: true })
        : json({ error: "unavailable" }, 500);
    }
    const install = res[2]?.results[0]?.install_id ?? null;
    log(install ? "applied" : "stale", install);
    return settled
      ? json({ received: true })
      : json({ error: "unavailable" }, 500);
  } catch {
    // Never the error text: it can carry a D1 message.
    log("db_error");
    return json({ error: "unavailable" }, 500);
  }
}
