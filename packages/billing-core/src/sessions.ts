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
  input: { installId: string; frozenTime: number; idempotencyKey: string },
  cfg: StripeConfig,
): Promise<{ id: string }> {
  if (!Number.isSafeInteger(input.frozenTime) || input.frozenTime <= 0)
    throw new StripeConfigError("frozenTime");
  const { status, out } = await post(
    cfg,
    "/v1/test_helpers/test_clocks",
    {
      frozen_time: String(input.frozenTime),
      name: check(INSTALL, "installId", input.installId),
    },
    input.idempotencyKey,
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
