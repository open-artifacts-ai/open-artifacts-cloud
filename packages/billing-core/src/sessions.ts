// Stripe Checkout and Customer Portal sessions, and the install's Stripe
// customer, for oa-<p>-billing's signed POST /checkout and /portal routes
// (the install asks through BillingGate; billing holds the secret key and
// answers only the URL). No Stripe SDK: one form-encoded POST each, with an
// Idempotency-Key.
//
// Every URL is billing's own (passed in by billing, never taken from a
// request), https only. Stripe test mode only: a key that isn't sk_test_ or
// rk_test_ is refused before any call. Errors never carry Stripe's body.

export const STRIPE_API = "https://api.stripe.com";

export interface StripeConfig {
  /** sk_test_... or rk_test_... (a Worker secret; never in code or argv). */
  secretKey: string;
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Test seam; defaults to STRIPE_API. */
  apiBase?: string;
}

export type CheckoutTier = "solo" | "team" | "business";

export interface CheckoutInput {
  customerId: string;
  priceId: string;
  /**
   * The paid tier this price buys. Written to the session's and the
   * subscription's metadata[tier], which the webhook prefers over the price.
   */
  tier: CheckoutTier;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  /** Seats at checkout (the creator count follows on each report). Default 1. */
  quantity?: number;
  /**
   * End of a free period (epoch seconds), sent as
   * subscription_data[trial_end]: nothing is charged until then, and the card
   * is still collected (payment_method_collection stays at its default).
   * Solo paying during its no-card trial keeps the free days with it. Stripe
   * needs it at least 48 hours ahead: the caller checks.
   */
  trialEnd?: number;
}

export interface PortalInput {
  customerId: string;
  returnUrl: string;
  idempotencyKey: string;
}

export type StripeSession = { id: string; url: string };

export interface CustomerInput {
  /** The install id (i + 11 of [a-z0-9]); Stripe keeps it as metadata[install_id]. */
  installId: string;
  /** Billing's key for this install, e.g. cust-<installId>: a retry is one customer. */
  idempotencyKey: string;
  /**
   * A Stripe test clock to attach the customer to (staging only: the Solo
   * trial can then be advanced instead of waited out).
   */
  testClockId?: string;
}

/** A refused input or key, before any call. */
export class StripeConfigError extends Error {
  constructor(public field: string) {
    super(`invalid ${field}`);
    this.name = "StripeConfigError";
  }
}

/** Stripe answered with an error (status and error type only). */
export class StripeApiError extends Error {
  constructor(
    public status: number,
    public type: string,
  ) {
    super(`stripe ${status} ${type}`);
    this.name = "StripeApiError";
  }
}

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]{8,255}$/;
const CUSTOMER = /^cus_[A-Za-z0-9]{1,255}$/;
const PRICE = /^price_[A-Za-z0-9]{1,255}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_:.-]{8,255}$/;
const INSTALL = /^i[a-z0-9]{11}$/;
const CHECKOUT_SESSION = /^cs_[A-Za-z0-9_]{1,255}$/;
const TEST_CLOCK = /^clock_[A-Za-z0-9]{1,255}$/;
const SUBSCRIPTION = /^sub_[A-Za-z0-9]{1,255}$/;
const CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\//;
const PORTAL_URL = /^https:\/\/billing\.stripe\.com\//;

function https(field: string, v: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new StripeConfigError(field);
  }
  if (u.protocol !== "https:" || u.username || u.password)
    throw new StripeConfigError(field);
  return u.toString();
}

function check(re: RegExp, field: string, v: string): string {
  if (!re.test(v)) throw new StripeConfigError(field);
  return v;
}

/**
 * One call; Stripe's JSON answer (an error keeps status and type only). A
 * POST is form-encoded with an Idempotency-Key; a GET or DELETE has no body.
 */
async function send(
  cfg: StripeConfig,
  method: "POST" | "GET" | "DELETE",
  path: string,
  form: Record<string, string> | null,
  idempotencyKey: string | null,
): Promise<{ status: number; out: Record<string, unknown> | null }> {
  check(TEST_KEY, "secretKey", cfg.secretKey);
  if (idempotencyKey !== null)
    check(IDEMPOTENCY, "idempotencyKey", idempotencyKey);
  const res = await (cfg.fetch ?? fetch)(
    `${cfg.apiBase ?? STRIPE_API}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${cfg.secretKey}`,
        ...(form === null
          ? {}
          : { "content-type": "application/x-www-form-urlencoded" }),
        ...(idempotencyKey === null
          ? {}
          : { "idempotency-key": idempotencyKey }),
      },
      ...(form === null ? {} : { body: new URLSearchParams(form).toString() }),
      redirect: "manual",
    },
  );
  let out: Record<string, unknown> | null = null;
  try {
    const j: unknown = await res.json();
    out =
      typeof j === "object" && j !== null
        ? (j as Record<string, unknown>)
        : null;
  } catch {
    out = null;
  }
  if (!res.ok) {
    const err = out?.error as { type?: unknown } | undefined;
    throw new StripeApiError(
      res.status,
      typeof err?.type === "string" ? err.type : "unknown",
    );
  }
  return { status: res.status, out };
}

/** One form POST with an Idempotency-Key. */
const post = (
  cfg: StripeConfig,
  path: string,
  form: Record<string, string>,
  idempotencyKey: string,
) => send(cfg, "POST", path, form, idempotencyKey);

/** A session answer: its id and a Stripe-hosted URL, else bad_answer. */
async function session(
  answer: Promise<{ status: number; out: Record<string, unknown> | null }>,
  urlHost: RegExp,
): Promise<StripeSession> {
  const { status, out } = await answer;
  const id = out?.id;
  const url = out?.url;
  if (typeof id !== "string" || typeof url !== "string" || !urlHost.test(url))
    throw new StripeApiError(status, "bad_answer");
  return { id, url };
}

/** A subscription Checkout session for `customerId` at `priceId`. */
export function createCheckoutSession(
  input: CheckoutInput,
  cfg: StripeConfig,
): Promise<StripeSession> {
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000)
    throw new StripeConfigError("quantity");
  if (
    input.trialEnd !== undefined &&
    !(Number.isSafeInteger(input.trialEnd) && input.trialEnd > 0)
  )
    throw new StripeConfigError("trialEnd");
  if (
    input.tier !== "solo" &&
    input.tier !== "team" &&
    input.tier !== "business"
  )
    throw new StripeConfigError("tier");
  return session(
    post(
      cfg,
      "/v1/checkout/sessions",
      {
        mode: "subscription",
        customer: check(CUSTOMER, "customerId", input.customerId),
        "line_items[0][price]": check(PRICE, "priceId", input.priceId),
        "line_items[0][quantity]": String(quantity),
        success_url: https("successUrl", input.successUrl),
        cancel_url: https("cancelUrl", input.cancelUrl),
        "metadata[tier]": input.tier,
        "subscription_data[metadata][tier]": input.tier,
        ...(input.trialEnd === undefined
          ? {}
          : { "subscription_data[trial_end]": String(input.trialEnd) }),
      },
      input.idempotencyKey,
    ),
    CHECKOUT_URL,
  );
}

/** A Customer Portal session for `customerId`. */
export function createPortalSession(
  input: PortalInput,
  cfg: StripeConfig,
): Promise<StripeSession> {
  return session(
    post(
      cfg,
      "/v1/billing_portal/sessions",
      {
        customer: check(CUSTOMER, "customerId", input.customerId),
        return_url: https("returnUrl", input.returnUrl),
      },
      input.idempotencyKey,
    ),
    PORTAL_URL,
  );
}

/**
 * The install's Stripe customer, with metadata[install_id]. Billing calls it
 * from /checkout before creating the session and writes the id with a
 * conditional UPDATE; the Idempotency-Key (cust-<installId>) makes a retry
 * the same customer. Answers the cus_ id only.
 */
export async function createCustomer(
  input: CustomerInput,
  cfg: StripeConfig,
): Promise<{ id: string }> {
  const { status, out } = await post(
    cfg,
    "/v1/customers",
    {
      "metadata[install_id]": check(INSTALL, "installId", input.installId),
      ...(input.testClockId === undefined
        ? {}
        : { test_clock: check(TEST_CLOCK, "testClockId", input.testClockId) }),
    },
    input.idempotencyKey,
  );
  const id = out?.id;
  if (typeof id !== "string" || !CUSTOMER.test(id))
    throw new StripeApiError(status, "bad_answer");
  return { id };
}

/**
 * A Stripe test clock frozen at `frozenTime` (epoch seconds), named for the
 * install. Test mode only (the key check); a live key can't make one. Answers
 * the clock_ id only.
 */
export async function createTestClock(
  input: { installId: string; frozenTime: number },
  cfg: StripeConfig,
): Promise<{ id: string }> {
  if (!Number.isSafeInteger(input.frozenTime) || input.frozenTime <= 0)
    throw new StripeConfigError("frozenTime");
  const { status, out } = await send(
    cfg,
    "POST",
    "/v1/test_helpers/test_clocks",
    {
      frozen_time: String(input.frozenTime),
      name: check(INSTALL, "installId", input.installId),
    },
    // No key: frozen_time moves with each call, so a replayed key would 400.
    // Billing keeps one clock per install (the row's winner).
    null,
  );
  const id = out?.id;
  if (typeof id !== "string" || !TEST_CLOCK.test(id))
    throw new StripeApiError(status, "bad_answer");
  return { id };
}

/** Solo's trial: 30 days, no card (#1568). */
export const SOLO_TRIAL_DAYS = 30;

export interface SoloTrialInput {
  customerId: string;
  /** The Solo price (monthly or yearly): the plan the trial converts to. */
  priceId: string;
  /** Billing's key for this install, e.g. solo-trial-<installId>: a retry is one subscription. */
  idempotencyKey: string;
}

/**
 * Solo's no-card trial, through the API (no Checkout visit): a subscription
 * with trial_period_days 30 and no payment method on file. When the trial
 * ends with none, Stripe cancels it (missing_payment_method=cancel), which
 * the webhook records as a lapsed Solo; adding a card before then (Portal or
 * Checkout) keeps it. Answers the sub_ id only.
 */
export async function createSoloTrialSubscription(
  input: SoloTrialInput,
  cfg: StripeConfig,
): Promise<{ id: string }> {
  const { status, out } = await post(
    cfg,
    "/v1/subscriptions",
    {
      customer: check(CUSTOMER, "customerId", input.customerId),
      "items[0][price]": check(PRICE, "priceId", input.priceId),
      trial_period_days: String(SOLO_TRIAL_DAYS),
      "trial_settings[end_behavior][missing_payment_method]": "cancel",
      "metadata[tier]": "solo",
    },
    input.idempotencyKey,
  );
  const id = out?.id;
  if (typeof id !== "string" || !SUBSCRIPTION.test(id))
    throw new StripeApiError(status, "bad_answer");
  return { id };
}

/**
 * Cancels a subscription (an upgrade replaces the Solo one; #1568), with its
 * unused time prorated onto the customer's credit balance. Safe to repeat: it
 * reads the subscription first and does nothing for one already canceled or
 * gone (404), so a webhook retry can run it again (and never credits twice). Answers the sub_ id.
 */
export async function cancelSubscription(
  input: { subscriptionId: string },
  cfg: StripeConfig,
): Promise<{ id: string }> {
  const id = check(SUBSCRIPTION, "subscriptionId", input.subscriptionId);
  const path = `/v1/subscriptions/${id}`;
  try {
    const { out } = await send(cfg, "GET", path, null, null);
    // incomplete_expired: the first payment never completed; nothing to cancel.
    if (out?.status === "canceled" || out?.status === "incomplete_expired")
      return { id };
    // An active subscription is cancelled with a final invoice that prorates
    // the unused time: it lands on the customer's credit balance, which Stripe
    // applies to later invoices (what was paid for before an upgrade is not
    // lost). Anything else is cancelled plain: a trialing one has nothing paid
    // to credit, and a past_due or unpaid one is delinquent (Stripe advises no
    // proration there). The parameters go in the query string with no body, as
    // the official clients send a DELETE's.
    const credit = out?.status === "active";
    await send(
      cfg,
      "DELETE",
      `${path}${credit ? "?invoice_now=true&prorate=true" : ""}`,
      null,
      null,
    );
  } catch (e) {
    if (e instanceof StripeApiError && e.status === 404) return { id };
    throw e;
  }
  return { id };
}

/**
 * Expires an open Checkout session, so only the newest one can be paid
 * (#1568). Safe to repeat and to race: it reads the session first and leaves
 * one that is not open (complete, expired) or gone (404) alone; an expire that
 * loses a race with the customer paying (400 or 404 after the read) is fine.
 * Any other Stripe error is thrown (status and type only).
 */
export async function expireCheckoutSession(
  input: { sessionId: string },
  cfg: StripeConfig,
): Promise<{ id: string }> {
  const id = check(CHECKOUT_SESSION, "sessionId", input.sessionId);
  const path = `/v1/checkout/sessions/${id}`;
  let open: boolean;
  try {
    open = (await send(cfg, "GET", path, null, null)).out?.status === "open";
  } catch (e) {
    if (e instanceof StripeApiError && e.status === 404) return { id };
    throw e;
  }
  if (!open) return { id };
  try {
    // No Idempotency-Key: Stripe replays a saved 500 for 24 hours, which would
    // block Checkout. Expiring is idempotent anyway (a second call finds it
    // expired).
    await send(cfg, "POST", `${path}/expire`, {}, null);
  } catch (e) {
    // Lost a race with the customer paying (or with another expire).
    if (e instanceof StripeApiError && (e.status === 400 || e.status === 404))
      return { id };
    throw e;
  }
  return { id };
}

/**
 * A subscription's state, read from Stripe (a Checkout adopts a subscription
 * only if it is live, #1568). One GET; answers the id and status only, or
 * status "missing" for a 404. Any other error is thrown (status and type
 * only).
 */
export async function retrieveSubscription(
  input: { subscriptionId: string },
  cfg: StripeConfig,
): Promise<{ id: string; status: string }> {
  const id = check(SUBSCRIPTION, "subscriptionId", input.subscriptionId);
  try {
    const { status, out } = await send(
      cfg,
      "GET",
      `/v1/subscriptions/${id}`,
      null,
      null,
    );
    if (typeof out?.status !== "string")
      throw new StripeApiError(status, "bad_answer");
    return { id, status: out.status };
  } catch (e) {
    if (e instanceof StripeApiError && e.status === 404)
      return { id, status: "missing" };
    throw e;
  }
}

/** What setSubscriptionQuantity did. */
export type QuantityOutcome =
  /** The item's quantity was set (proration_behavior none). */
  | "updated"
  /**
   * With input.forbidMonthly: the subscription is now monthly, so nothing was
   * written (a month from its yearly era must not set a monthly quantity).
   */
  | "plan_changed"
  /** The item already had this quantity: no write. */
  | "unchanged"
  /**
   * The subscription's one item is not a monthly price billing names (a
   * yearly prepaid-seat price, #2123 PR 4b, or anything unknown): left alone.
   */
  | "not_monthly"
  /** Canceled, incomplete, gone (404) or trialing in Stripe: left alone. */
  | "not_live";

export interface QuantityInput {
  subscriptionId: string;
  /** The creator count to bill (1..10000). */
  quantity: number;
  /**
   * The monthly per-creator prices this may change (Team's and Business's).
   * The item's price must be one of them and recur monthly; a yearly price
   * is recognised by its recurring interval and never changed here.
   */
  monthlyPriceIds: readonly string[];
  /** Billing's key, e.g. qty-<install>-<month>-<quantity>: a retry is one write. */
  idempotencyKey: string;
  /**
   * The month belongs to a yearly subscription's era: if the subscription is
   * now a live monthly one, answer plan_changed and write nothing.
   */
  forbidMonthly?: boolean;
}

const PAYMENT_METHOD = /^pm_[A-Za-z0-9_]{1,255}$/;
/** A Stripe id that may come as a string or an expanded object. */
const idString = (v: unknown, re: RegExp): string | null => {
  const id =
    typeof v === "object" && v !== null ? (v as { id?: unknown }).id : v;
  return typeof id === "string" && re.test(id) ? id : null;
};

/** Stripe statuses whose quantity follows the creator count. */
const QUANTITY_LIVE = new Set(["active", "past_due"]);
const SUBSCRIPTION_ITEM = /^si_[A-Za-z0-9]{1,255}$/;

/**
 * Sets a monthly Team or Business subscription's quantity to the creator
 * count (#2123), with proration_behavior none: nothing is charged or
 * credited now, and the next invoice bills that many creators. Reads the
 * subscription first and changes nothing unless it is live (active or
 * past_due) with exactly one item at one of `monthlyPriceIds` recurring
 * monthly; an item already at `quantity` is not written. Safe to repeat.
 * Any Stripe error but a 404 on the read is thrown (status and type only).
 */
export async function setSubscriptionQuantity(
  input: QuantityInput,
  cfg: StripeConfig,
): Promise<{
  outcome: QuantityOutcome;
  previous?: number;
  /** With not_monthly on a one-item subscription: what that item is. */
  item?: { priceId: string; interval: string | null; quantity: number | null };
  /**
   * With not_monthly: the subscription's payment method and when its current
   * billing cycle began (epoch seconds; Stripe resets it when the interval
   * changes, so a monthly-to-yearly switch moves it to the switch).
   */
  subscription?: {
    defaultPaymentMethod: string | null;
    billingCycleAnchor: number | null;
    startDate: number | null;
  };
}> {
  const id = check(SUBSCRIPTION, "subscriptionId", input.subscriptionId);
  const quantity = input.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000)
    throw new StripeConfigError("quantity");
  for (const p of input.monthlyPriceIds) check(PRICE, "monthlyPriceIds", p);
  check(IDEMPOTENCY, "idempotencyKey", input.idempotencyKey);
  let status: number;
  let out: Record<string, unknown> | null;
  try {
    ({ status, out } = await send(
      cfg,
      "GET",
      `/v1/subscriptions/${id}`,
      null,
      null,
    ));
  } catch (e) {
    if (e instanceof StripeApiError && e.status === 404)
      return { outcome: "not_live" };
    throw e;
  }
  if (typeof out?.status !== "string")
    throw new StripeApiError(status, "bad_answer");
  if (!QUANTITY_LIVE.has(out.status)) return { outcome: "not_live" };
  const items = (out.items as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(items)) throw new StripeApiError(status, "bad_answer");
  if (items.length !== 1) return { outcome: "not_monthly" };
  const item = items[0] as {
    id?: unknown;
    quantity?: unknown;
    price?: { id?: unknown; recurring?: { interval?: unknown } | null };
  };
  if (typeof item?.id !== "string" || !SUBSCRIPTION_ITEM.test(item.id))
    throw new StripeApiError(status, "bad_answer");
  if (
    typeof item.price?.id !== "string" ||
    !input.monthlyPriceIds.includes(item.price.id) ||
    item.price.recurring?.interval !== "month"
  )
    return {
      outcome: "not_monthly",
      item: {
        priceId: typeof item.price?.id === "string" ? item.price.id : "",
        interval:
          typeof item.price?.recurring?.interval === "string"
            ? item.price.recurring.interval
            : null,
        quantity: typeof item.quantity === "number" ? item.quantity : null,
      },
      subscription: {
        defaultPaymentMethod: idString(
          out.default_payment_method,
          PAYMENT_METHOD,
        ),
        billingCycleAnchor:
          typeof out.billing_cycle_anchor === "number"
            ? out.billing_cycle_anchor
            : null,
        startDate: typeof out.start_date === "number" ? out.start_date : null,
      },
    };
  const previous =
    typeof item.quantity === "number" ? item.quantity : undefined;
  if (input.forbidMonthly) return { outcome: "plan_changed" };
  if (previous === quantity) return { outcome: "unchanged", previous };
  await post(
    cfg,
    `/v1/subscription_items/${item.id}`,
    { quantity: String(quantity), proration_behavior: "none" },
    input.idempotencyKey,
  );
  return {
    outcome: "updated",
    ...(previous === undefined ? {} : { previous }),
  };
}

// ------------------------------------------------- yearly overage (#2235)

const INVOICE_ITEM = /^ii_[A-Za-z0-9_]{1,255}$/;
const INVOICE = /^in_[A-Za-z0-9_]{1,255}$/;
const MONTH_KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/;

const idOf = (
  out: Record<string, unknown> | null,
  re: RegExp,
  status: number,
): string => {
  if (typeof out?.id !== "string" || !re.test(out.id))
    throw new StripeApiError(status, "bad_answer");
  return out.id;
};

export interface OverageItemInput {
  customerId: string;
  /** The draft overage invoice the item is attached to (never a pending item). */
  invoiceId: string;
  install: string;
  /** The closed month, YYYY-MM. */
  month: string;
  /** Extra creators (1..10000). */
  quantity: number;
  /** The monthly per-creator price in cents. */
  unitAmount: number;
  description: string;
  idempotencyKey: string;
}

function overageMeta(install: string, month: string, p: string) {
  check(INSTALL, "install", install);
  check(MONTH_KEY, "month", month);
  return {
    [`${p}[kind]`]: "overage",
    [`${p}[install]`]: install,
    [`${p}[month]`]: month,
  };
}

/**
 * An invoice item for the extra creators, attached to the given draft
 * invoice (so it is never a pending item another invoice could sweep up).
 * Answers its id.
 */
export async function createOverageItem(
  input: OverageItemInput,
  cfg: StripeConfig,
): Promise<string> {
  check(CUSTOMER, "customerId", input.customerId);
  check(INVOICE, "invoiceId", input.invoiceId);
  check(IDEMPOTENCY, "idempotencyKey", input.idempotencyKey);
  if (
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 10_000
  )
    throw new StripeConfigError("quantity");
  if (!Number.isInteger(input.unitAmount) || input.unitAmount < 1)
    throw new StripeConfigError("unitAmount");
  const { status, out } = await post(
    cfg,
    "/v1/invoiceitems",
    {
      customer: input.customerId,
      invoice: input.invoiceId,
      currency: "usd",
      unit_amount: String(input.unitAmount),
      quantity: String(input.quantity),
      description: input.description,
      ...overageMeta(input.install, input.month, "metadata"),
    },
    input.idempotencyKey,
  );
  return idOf(out, INVOICE_ITEM, status);
}

/**
 * A draft one-off invoice, charged automatically, that takes no pending
 * items (its one item is attached to it). Answers its id.
 */
export async function createOverageInvoice(
  input: {
    customerId: string;
    install: string;
    month: string;
    /** The card to charge: a one-off invoice does not inherit the subscription's. */
    paymentMethodId: string;
    idempotencyKey: string;
  },
  cfg: StripeConfig,
): Promise<string> {
  check(CUSTOMER, "customerId", input.customerId);
  check(PAYMENT_METHOD, "paymentMethodId", input.paymentMethodId);
  check(IDEMPOTENCY, "idempotencyKey", input.idempotencyKey);
  const { status, out } = await post(
    cfg,
    "/v1/invoices",
    {
      customer: input.customerId,
      default_payment_method: input.paymentMethodId,
      collection_method: "charge_automatically",
      pending_invoice_items_behavior: "exclude",
      auto_advance: "false",
      ...overageMeta(input.install, input.month, "metadata"),
    },
    input.idempotencyKey,
  );
  return idOf(out, INVOICE, status);
}

/**
 * The customer's invoice_settings.default_payment_method, or null. Checkout
 * saves the card on the subscription, so this is only the fallback.
 */
export async function retrieveCustomerPaymentMethod(
  input: { customerId: string },
  cfg: StripeConfig,
): Promise<string | null> {
  const id = check(CUSTOMER, "customerId", input.customerId);
  const { out } = await send(cfg, "GET", `/v1/customers/${id}`, null, null);
  const s = out?.invoice_settings;
  return idString(
    typeof s === "object" && s !== null
      ? (s as { default_payment_method?: unknown }).default_payment_method
      : null,
    PAYMENT_METHOD,
  );
}

const metaOf = (o: unknown): Record<string, unknown> =>
  typeof o === "object" && o !== null && "metadata" in o
    ? ((o as { metadata?: Record<string, unknown> }).metadata ?? {})
    : {};

/**
 * The draft overage invoice already made for (install, month), if any: how a
 * retry finds an invoice whose answer was lost, without relying on an
 * idempotency key that Stripe forgets after 24 hours. Reads the customer's
 * drafts (the first 100).
 */
export async function findOverageInvoice(
  input: { customerId: string; install: string; month: string },
  cfg: StripeConfig,
): Promise<string | null> {
  const customer = check(CUSTOMER, "customerId", input.customerId);
  overageMeta(input.install, input.month, "metadata");
  const { status, out } = await send(
    cfg,
    "GET",
    `/v1/invoices?customer=${customer}&status=draft&limit=100`,
    null,
    null,
  );
  if (!Array.isArray(out?.data)) throw new StripeApiError(status, "bad_answer");
  for (const inv of out.data as unknown[]) {
    const m = metaOf(inv);
    const id = (inv as { id?: unknown }).id;
    if (
      m.kind === "overage" &&
      m.install === input.install &&
      m.month === input.month &&
      typeof id === "string" &&
      INVOICE.test(id)
    )
      return id;
  }
  return null;
}

/**
 * The overage item already attached to an invoice for `month`, if any (a
 * retry whose item answer was lost reuses it instead of adding a second).
 */
export async function findOverageItem(
  input: { invoiceId: string; month: string },
  cfg: StripeConfig,
): Promise<string | null> {
  const invoice = check(INVOICE, "invoiceId", input.invoiceId);
  check(MONTH_KEY, "month", input.month);
  const { status, out } = await send(
    cfg,
    "GET",
    `/v1/invoiceitems?invoice=${invoice}&limit=100`,
    null,
    null,
  );
  if (!Array.isArray(out?.data)) throw new StripeApiError(status, "bad_answer");
  for (const it of out.data as unknown[]) {
    const m = metaOf(it);
    const id = (it as { id?: unknown }).id;
    if (
      m.kind === "overage" &&
      m.month === input.month &&
      typeof id === "string" &&
      INVOICE_ITEM.test(id)
    )
      return id;
  }
  return null;
}

/** An invoice's status (draft, open, paid, ...), or "missing" for a 404. */
export async function retrieveInvoiceStatus(
  input: { invoiceId: string },
  cfg: StripeConfig,
): Promise<string> {
  const id = check(INVOICE, "invoiceId", input.invoiceId);
  try {
    const { status, out } = await send(
      cfg,
      "GET",
      `/v1/invoices/${id}`,
      null,
      null,
    );
    if (typeof out?.status !== "string")
      throw new StripeApiError(status, "bad_answer");
    return out.status;
  } catch (e) {
    if (e instanceof StripeApiError && e.status === 404) return "missing";
    throw e;
  }
}

/**
 * Finalizes a draft invoice with auto_advance true: an API-created invoice
 * defaults to false, and a finalized one with it false is never charged.
 * (The draft itself stays at auto_advance false, so an empty draft can't
 * finalize on its own.)
 */
export async function finalizeInvoice(
  input: { invoiceId: string; idempotencyKey: string },
  cfg: StripeConfig,
): Promise<void> {
  const id = check(INVOICE, "invoiceId", input.invoiceId);
  check(IDEMPOTENCY, "idempotencyKey", input.idempotencyKey);
  await post(
    cfg,
    `/v1/invoices/${id}/finalize`,
    { auto_advance: "true" },
    input.idempotencyKey,
  );
}

/**
 * Deletes this (install, month)'s overage items that are still pending
 * (attached to no invoice), so a reset never leaves one a later invoice
 * could sweep up. Reads the customer's pending items (the first 100).
 * Answers how many it deleted.
 */
export async function deletePendingOverageItems(
  input: { customerId: string; install: string; month: string },
  cfg: StripeConfig,
): Promise<number> {
  const customer = check(CUSTOMER, "customerId", input.customerId);
  overageMeta(input.install, input.month, "metadata");
  const { status, out } = await send(
    cfg,
    "GET",
    `/v1/invoiceitems?customer=${customer}&pending=true&limit=100`,
    null,
    null,
  );
  if (!Array.isArray(out?.data)) throw new StripeApiError(status, "bad_answer");
  let n = 0;
  for (const it of out.data as unknown[]) {
    const m = metaOf(it);
    const { id, invoice } = it as { id?: unknown; invoice?: unknown };
    if (
      m.kind === "overage" &&
      m.install === input.install &&
      m.month === input.month &&
      (invoice === null || invoice === undefined) &&
      typeof id === "string" &&
      INVOICE_ITEM.test(id)
    ) {
      try {
        await send(cfg, "DELETE", `/v1/invoiceitems/${id}`, null, null);
      } catch (e) {
        // Already gone.
        if (!(e instanceof StripeApiError && e.status === 404)) throw e;
        continue;
      }
      n++;
    }
  }
  return n;
}
