// oa-<p>-billing: the tier store (self-serve step 1). See wrangler.jsonc.
//
// Gate routes (GET /tier, POST /trial/start, POST /usage, GET /health) are
// reachable only over a service binding: every internet request carries
// cf-connecting-ip and a binding request does not, so one that has it gets
// the plain 404. The install id comes only from x-oa-gate-install, which
// BillingGate sets to its own install; never from a query or a body.
//
// POST /checkout and POST /portal (self-serve step 3) answer a Stripe
// Checkout or Customer Portal URL, through @oa/billing-core (the one Stripe
// client). Their success, cancel and return URLs are built here from the
// app host the gate sends (x-oa-gate-app-host, from the gate's props), never
// from the request; a body with any field beyond the route's own is refused.
// The install's Stripe customer is created here only, and mapped in tiers
// before any session is made.
//
// Every POST also carries the install's Ed25519 assertion (defense in
// depth), the auth broker's redeem scheme: x-oa-kid names one of the gate
// install's registry keys, x-oa-sig signs requestTranscript(path, kid, body)
// over the exact body text, and the body's `ts` is within ASSERTION_SKEW_MS.
// Anything else is 401 bad_signature and writes nothing.
//
// The provisioner starts an install's 30-day no-card Solo trial through a named
// RPC entrypoint, BillingProvisionerRpc.soloStart (service binding with
// entrypoint "BillingProvisionerRpc"), never an HTTP route: the provisioner
// holds no install key to sign one with. The install must be in BROKER_REGISTRY
// (its entry is written by the provisioner; KV is eventually consistent, so an
// unknown install is a retryable answer). #1568.
//
// POST /stripe/webhook is the one public route (internet traffic, with
// cf-connecting-ip). @oa/billing-core's handleStripeWebhook reads the raw
// body once and checks its Stripe-Signature itself, so billing never reads
// the body first. A missing STRIPE_WEBHOOK_SECRET (a Worker secret) is 500
// config, body unread. Any other method or path stays the plain 404.
//
// A daily cron prunes stripe_events older than 30 days (#1479).
//
// Logs carry fixed categories and install ids only: never bodies, headers or
// URLs.

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type CheckoutTier,
  createCheckoutSession,
  createCustomer,
  createPortalSession,
  createSoloTrialSubscription,
  createTestClock,
  expireCheckoutSession,
  handleStripeWebhook,
  pruneStripeEvents,
  SET_TIER_TIERS,
  type SetTierError,
  type SetTierResult,
  type SetTierTier,
  SOLO_START_RETRYABLE,
  SOLO_TRIAL_DAYS,
  type SoloStartError,
  type SoloStartResult,
  type SoloStartView,
  StripeApiError,
  type StripeConfig,
  StripeConfigError,
  SUBSCRIPTION_LIVE_SQL,
  setSubscriptionQuantity,
  TIERS_OF_MAX,
  type TierOfView,
  type TiersOfResult,
} from "@oa/billing-core";
import {
  ASSERTION_SKEW_MS,
  lookupInstall,
  verifyAssertion,
} from "@oa/broker-core";
import {
  GATE_APP_HOST_HEADER,
  GATE_INSTALL_HEADER,
} from "@oa/broker-core/gate-header";
import { isAppHost, type Env as OaEnv, TRIAL_MS } from "@oa/provision/names";
import { isClockInstall } from "./test-clock.js";

/** Dashboard page Checkout and the portal return to. */
const PLAN_PATH = "/settings/plan";

export interface Env {
  BILLING_DB: D1Database;
  /** The install registry (read-only): the namespace the auth broker reads. */
  BROKER_REGISTRY: KVNamespace;
  /** staging or prod: picks the app domain the gate's app host must be on. */
  OA_ENV: OaEnv;
  /** Stripe test-mode secret key (a Worker secret; billing-core refuses live keys). */
  STRIPE_SECRET_KEY?: string;
  /** Stripe webhook signing secret (a Worker secret: never a var, never logged). */
  STRIPE_WEBHOOK_SECRET?: string;
  /** The env's Stripe price ids, one per paid plan (placeholders, filled at deploy). */
  STRIPE_PRICE_TEAM: string;
  STRIPE_PRICE_BUSINESS: string;
  /** Solo's two prices (#1568): $1/month and $10/year, one per interval. */
  STRIPE_PRICE_SOLO_MONTHLY: string;
  STRIPE_PRICE_SOLO_YEARLY: string;
  /**
   * Staging only: comma list of exact install ids whose customer is made on a
   * Stripe test clock (test-clock.ts). Absent in prod; ignored unless staging
   * with a test key.
   */
  STAGING_TEST_CLOCK_INSTALLS?: string;
}

export { TRIAL_MS };
/** The most creators one usage report may list. */
export const MAX_CREATORS = 10_000;
/**
 * The largest body billing reads: room for MAX_CREATORS ids at their longest.
 * Gate traffic is already capped lower (GATE_MAX_BODY).
 */
export const MAX_BODY = 2 * 1024 * 1024;

const INSTALL_ID = /^i[a-z0-9]{11}$/;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
/** An opaque creator id: the install chooses it; billing only counts it. */
const CREATOR = /^[A-Za-z0-9_-]{1,128}$/;

const notFound = () => new Response("Not found", { status: 404 });
const bad = (error: string, status = 400) =>
  Response.json({ error }, { status });

interface TierRow {
  tier: string | null;
  status: string | null;
  trial_ends_at: number | null;
  grace_until: number | null;
  solo_trial_ends_at: number | null;
  /** 1 when tiers.stripe_customer_id is set, else 0 (see COLS). */
  has_customer: number;
  version: number;
}

/** What an install sees: no Stripe ids, ever. */
function view(r: TierRow | null, now: number) {
  if (!r)
    return {
      tier: "solo",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      soloTrialEndsAt: null,
      hasCustomer: false,
      version: 0,
      asOf: now,
    };
  return {
    tier: r.tier,
    status: r.status,
    trialEndsAt: r.trial_ends_at,
    graceUntil: r.grace_until,
    // The Solo subscription's own trial end. trialEndsAt stays the 30-day
    // Business trial's: the server's trial eligibility is trialEndsAt === null.
    // Only while it is still ahead: once past it is null (the column keeps it).
    soloTrialEndsAt:
      r.solo_trial_ends_at !== null && r.solo_trial_ends_at > now
        ? r.solo_trial_ends_at
        : null,
    // Whether a Stripe customer exists (the portal needs one). The id
    // itself never leaves billing.
    hasCustomer: r.has_customer === 1,
    version: r.version,
    asOf: now,
  };
}

const COLS =
  "tier, status, trial_ends_at, grace_until, solo_trial_ends_at, (stripe_customer_id IS NOT NULL) AS has_customer, version";
// The read records last_read_at on the install's own row and writes nothing
// when there is no row (create writes rows, not this route).
const READ_SQL = `UPDATE tiers SET last_read_at = ?2 WHERE install_id = ?1 RETURNING ${COLS}`;
const SELECT_SQL = `SELECT ${COLS} FROM tiers WHERE install_id = ?1`;
// Only solo/active (or free, the pre-Solo value) with no trial before: the
// 30-day Business trial never starts twice. No row is the solo/active default,
// so a trial can start from it too (an install made before create writes
// rows); an existing row moves only from solo/free and active, and only once
// (trial_ends_at stays set after). The Solo subscription under it is kept as
// solo_status active only when it is known live: a stored id plus
// solo_trial_ends_at (set by the Solo trial start, a Solo trialing or active event, or a
// paid Solo checkout); an id with none is a pending first payment. Solo's own
// 30-day no-card trial is a Stripe
// subscription and never sets trial_ends_at, so it doesn't use this up.
const TRIAL_SQL = `INSERT INTO tiers (install_id, tier, status, trial_ends_at, version, updated_at) VALUES (?1, 'trial', 'active', ?2, 1, ?3) ON CONFLICT (install_id) DO UPDATE SET tier = 'trial', trial_ends_at = ?2, solo_status = CASE WHEN tiers.stripe_subscription_id IS NOT NULL AND tiers.solo_trial_ends_at IS NOT NULL THEN 'active' END, solo_grace_until = NULL, version = tiers.version + 1, updated_at = ?3 WHERE tiers.tier IN ('solo', 'free') AND tiers.status = 'active' AND tiers.trial_ends_at IS NULL RETURNING ${COLS}`;
// The 30-day Business trial ended (trial_ends_at, set once, stays set so it
// never restarts): the row is Solo again, active while the Solo subscription
// it kept (solo_status, recorded by the webhook while the trial ran) is
// alive, lapsed if not or if there never was one. A change made only by time
// passing, so it bumps version here: the install stores an answer only when
// its version is higher. One UPDATE, idempotent (it needs tier trial), run at
// the start of every read and answer. A suspended row stays suspended.
// The pieces tiersOf projects without writing (one source, so the two cannot
// drift): when the trial has ended (?n is now), and the status the Solo row
// takes then.
const trialEnded = (now: string) =>
  `tier = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at <= ${now}`;
const ENDED_STATUS_SQL =
  "CASE WHEN status = 'suspended' THEN status WHEN solo_status IN ('active', 'past_due') THEN solo_status ELSE 'lapsed' END";
const MATERIALIZE_SQL = `UPDATE tiers SET tier = 'solo', status = ${ENDED_STATUS_SQL}, grace_until = CASE WHEN status = 'suspended' THEN grace_until WHEN solo_status = 'past_due' THEN solo_grace_until END, version = version + 1, updated_at = ?2 WHERE install_id = ?1 AND ${trialEnded("?2")}`;
const materialize = (db: D1Database, install: string, now: number) =>
  db.prepare(MATERIALIZE_SQL).bind(install, now).run();
const OPEN_SQL =
  "SELECT open_checkout_id, open_checkout_key FROM tiers WHERE install_id = ?1";
const STORE_OPEN_SQL =
  "UPDATE tiers SET open_checkout_id = ?1, open_checkout_key = ?2 WHERE install_id = ?3 AND open_checkout_id IS ?4 AND open_checkout_key IS ?5 RETURNING 1 AS ok";
const SOLO_HELD_SQL =
  "SELECT tier, status, stripe_subscription_id, solo_trial_ends_at FROM tiers WHERE install_id = ?1";
const SOLO_TRIAL_MS = SOLO_TRIAL_DAYS * 86_400_000;
const SOLO_START_SQL = `UPDATE tiers SET tier = 'solo', stripe_subscription_id = ?2, solo_trial_ends_at = ?3, version = version + 1, updated_at = ?4 WHERE install_id = ?1 AND tier IN ('solo', 'free') AND solo_trial_ends_at IS NULL AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ?2) RETURNING ${COLS}`;
const USAGE_SQL =
  "INSERT INTO usage (install_id, month, creators_json, count, received_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (install_id, month) DO UPDATE SET creators_json = excluded.creators_json, count = excluded.count, received_at = excluded.received_at";

/** The body's exact text (JSON content type, UTF-8, at most MAX_BODY), or null. */
async function bodyText(req: Request): Promise<string | null> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) return null;
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BODY)) return null;
  try {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BODY) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** 401 bad_signature, logged by fixed outcome and install id. */
function badSignature(outcome: string, install: string) {
  console.log("billing signature", outcome, install);
  return bad("bad_signature", 401);
}

/**
 * A signed POST's body as a JSON object, or the refusal. The kid must be one
 * of the GATE install's registry keys (never the body's install), the
 * signature must cover this route's path and the exact body text, and the
 * body's `ts` must be within ASSERTION_SKEW_MS of now. Runs before any write.
 *
 * There is no nonce (jti): the same signed body can be replayed within the
 * skew window. That is accepted only because every POST is idempotent (a
 * trial starts once; /usage overwrites the month with the same data;
 * /checkout and /portal key each Stripe call by the body's ts, so a replay
 * gets the same session and the customer is made once). Any future POST that
 * is not idempotent must add a nonce and a seen-store first.
 */
async function signedBody(
  req: Request,
  env: Env,
  install: string,
  path: string,
  now: number,
): Promise<Record<string, unknown> | Response> {
  const kid = req.headers.get("x-oa-kid") ?? "";
  const sig = req.headers.get("x-oa-sig") ?? "";
  const text = await bodyText(req);
  if (text === null) return bad("bad_body");
  if (!kid || !sig) return badSignature("missing", install);
  const entry = await lookupInstall(env.BROKER_REGISTRY, install, now);
  if (!entry) return badSignature("unknown_install", install);
  if (!(await verifyAssertion(entry, path, kid, text, sig)))
    return badSignature("bad", install);
  const body = jsonObject(text);
  if (!body) return bad("bad_body");
  if (
    typeof body.ts !== "number" ||
    !(Math.abs(now - body.ts) <= ASSERTION_SKEW_MS)
  )
    return badSignature("stale", install);
  return body;
}

/** The text as a JSON object, or null for anything else. */
function jsonObject(text: string): Record<string, unknown> | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** A body naming an install names the gate's own (defense in depth). */
const mismatched = (body: Record<string, unknown>, install: string) =>
  Object.hasOwn(body, "install") && body.install !== install;

/** Each signed POST's allowed body keys; any other field is 400 bad_body. */
const BODY_KEYS: Readonly<Record<string, readonly string[]>> = {
  "/checkout": ["install", "ts", "plan", "interval", "creators"],
  "/portal": ["install", "ts"],
  "/trial/start": ["install", "ts"],
  "/usage": ["install", "ts", "month", "creators", "count"],
};
/** Only a Stripe-hosted page is ever passed back. */
const CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\//;
const PORTAL_URL = /^https:\/\/billing\.stripe\.com\//;
/** Stripe: a Checkout trial_end must be 48 hours out; plus a safety hour. */
const MIN_TRIAL_END_MS = 49 * 3_600_000;
/** billing-core's price id shape; checked before any customer is made. */
const PRICE_ID = /^price_[A-Za-z0-9]{1,255}$/;

// The solo/active row, created first when missing (as /trial/start does).
// Version 0 is what GET /tier shows for no row, so the view is unchanged.
const ENSURE_ROW_SQL =
  "INSERT INTO tiers (install_id, tier, status, version, updated_at) VALUES (?1, 'solo', 'active', 0, ?2) ON CONFLICT (install_id) DO NOTHING";
const CUSTOMER_SQL =
  "SELECT stripe_customer_id FROM tiers WHERE install_id = ?1";
const SUBSCRIPTION_SQL =
  "SELECT stripe_subscription_id, status, tier, solo_trial_ends_at, solo_status FROM tiers WHERE install_id = ?1";
// Only where none is mapped yet: a concurrent winner's id is kept.
const CLOCK_SQL =
  "SELECT stripe_customer_id, stripe_test_clock_id FROM tiers WHERE install_id = ?1";
// Only where none is stored: one clock per install, a concurrent winner's kept.
const SET_CLOCK_SQL =
  "UPDATE tiers SET stripe_test_clock_id = ? WHERE install_id = ? AND stripe_test_clock_id IS NULL";
const MAP_CUSTOMER_SQL =
  "UPDATE tiers SET stripe_customer_id = ? WHERE install_id = ? AND stripe_customer_id IS NULL";

/** A Stripe failure, as the route's answer (logged by category only). */
class StripeFailure {
  constructor(
    public res: Response,
    /** The same failure as a fixed code (the provisioner RPC's answers). */
    public code: "config" | "retry" | "bad_upstream" | "upstream",
    /** Stripe's HTTP status, when it answered one (not a network error). */
    public status?: number,
  ) {}
}

/**
 * Runs one billing-core call: StripeConfigError is 500 config and
 * StripeApiError (bad_answer: bad_upstream) or a network error is 502
 * upstream, each logged as a fixed category with the install id.
 */
async function stripe<T>(install: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StripeConfigError) {
      console.error("billing stripe config", install);
      throw new StripeFailure(bad("config", 500), "config");
    }
    // An idempotent request still in progress (a concurrent call with the
    // same key): the caller may retry it.
    if (e instanceof StripeApiError && e.status === 409) {
      console.error("billing stripe retry", install);
      throw new StripeFailure(bad("retry", 503), "retry");
    }
    if (e instanceof StripeApiError && e.type === "bad_answer") {
      console.error("billing stripe bad_upstream", install);
      throw new StripeFailure(bad("bad_upstream", 502), "bad_upstream");
    }
    console.error("billing stripe upstream", install);
    throw new StripeFailure(
      bad("upstream", 502),
      "upstream",
      e instanceof StripeApiError ? e.status : undefined,
    );
  }
}

/** The body's own fields only, and an integer ts (it keys the session). */
function strictBody(body: Record<string, unknown>, path: string): boolean {
  const keys = BODY_KEYS[path] ?? [];
  return (
    Object.keys(body).every((k) => keys.includes(k)) &&
    Number.isSafeInteger(body.ts)
  );
}

/**
 * The install's Stripe customer id. The mapping is read first; with none,
 * the row is made if missing, billing-core creates the customer (one per
 * install: Idempotency-Key cust-<install>), the id is written only where
 * none is mapped, and the row is read again so a concurrent winner's id is
 * the one used.
 */
async function customerFor(
  db: D1Database,
  install: string,
  cfg: StripeConfig,
  now: number,
  /** Staging test clocks (test-clock.ts): this install's customer is on one. */
  clocked = false,
): Promise<string> {
  const read = async () =>
    (await db.prepare(CLOCK_SQL).bind(install).first<{
      stripe_customer_id: string | null;
      stripe_test_clock_id: string | null;
    }>()) ?? { stripe_customer_id: null, stripe_test_clock_id: null };
  const mapped = await read();
  if (mapped.stripe_customer_id) {
    // A listed install never reuses a customer that is not on a clock: the
    // trial could not be advanced, and a silent fallback would hide it.
    if (clocked && !mapped.stripe_test_clock_id) {
      console.error("billing test_clock refused_existing_customer", install);
      throw new StripeFailure(bad("config", 500), "config");
    }
    return mapped.stripe_customer_id;
  }
  await db.prepare(ENSURE_ROW_SQL).bind(install, now).run();
  let testClockId: string | undefined;
  if (clocked) {
    // The clock first, kept on the row before the customer is made: a retry
    // after a failed customer call finds it, so there is one clock per install.
    testClockId = (await read()).stripe_test_clock_id ?? undefined;
    if (!testClockId) {
      const clock = await stripe(install, () =>
        createTestClock(
          {
            installId: install,
            frozenTime: Math.floor(now / 1000),
          },
          cfg,
        ),
      );
      await db.prepare(SET_CLOCK_SQL).bind(clock.id, install).run();
      testClockId = (await read()).stripe_test_clock_id ?? undefined;
      if (!testClockId) throw new Error("test clock missing after write");
      // A concurrent start won the row: this clock is an orphan, for the sweep.
      if (testClockId !== clock.id)
        console.error("billing test_clock lost", install, clock.id);
      console.log("billing test_clock mapped", install);
    }
  }
  const { id } = await stripe(install, () =>
    createCustomer(
      {
        installId: install,
        // A clock's customer is keyed by its clock: after a cleanup the next
        // one is new, never a replay of the deleted customer.
        idempotencyKey: testClockId
          ? `cust-${install}-${testClockId}`
          : `cust-${install}`,
        ...(testClockId ? { testClockId } : {}),
      },
      cfg,
    ),
  );
  // One in-request retry of the write; a second failure is the route's 503.
  const map = () => db.prepare(MAP_CUSTOMER_SQL).bind(id, install).run();
  const wrote = await map().catch(() => {
    console.error("billing customer map_retry", install);
    return map();
  });
  console.log(
    "billing customer",
    wrote.meta.changes === 1 ? "mapped" : "kept",
    install,
  );
  const winner = (await read()).stripe_customer_id;
  if (!winner) throw new Error("customer mapping missing after write");
  return winner;
}

async function checkout(
  env: Env,
  install: string,
  appHost: string,
  body: Record<string, unknown>,
) {
  const { plan, interval, creators } = body;
  if (plan !== "solo" && plan !== "team" && plan !== "business")
    return bad("bad_plan");
  // Team and Business bill per creator (#2123): the instance's own count for
  // this month (0..MAX_CREATORS), billed as at least 1. Solo takes none.
  if (
    creators !== undefined &&
    (plan === "solo" ||
      !Number.isInteger(creators) ||
      (creators as number) < 0 ||
      (creators as number) > MAX_CREATORS)
  )
    return bad("bad_creators");
  const quantity =
    typeof creators === "number" ? Math.max(1, creators) : undefined;
  // Solo names its billing interval; no other plan takes one (the shared
  // BillingCheckoutInput contract).
  if (
    plan === "solo"
      ? interval !== "month" && interval !== "year"
      : interval !== undefined
  )
    return bad("bad_plan");
  const tier: CheckoutTier = plan;
  const priceId =
    plan === "solo"
      ? interval === "month"
        ? env.STRIPE_PRICE_SOLO_MONTHLY
        : env.STRIPE_PRICE_SOLO_YEARLY
      : plan === "team"
        ? env.STRIPE_PRICE_TEAM
        : env.STRIPE_PRICE_BUSINESS;
  // An unfilled or malformed price never gets as far as a customer.
  if (typeof priceId !== "string" || !PRICE_ID.test(priceId)) {
    console.error("billing stripe config", install);
    return bad("config", 500);
  }
  // A live subscription is changed in the Portal, never by a second
  // Checkout (a second subscription would be billed alongside the first).
  const held = await env.BILLING_DB.prepare(SUBSCRIPTION_SQL)
    .bind(install)
    .first<{
      stripe_subscription_id: string | null;
      status: string;
      tier: string | null;
      solo_trial_ends_at: number | null;
      solo_status: string | null;
    }>();
  // A live Team or Business subscription is changed in the Portal, and so is
  // a suspended one. A live Solo subscription (its own row's, or, during the
  // 30-day Business trial, the one kept in solo_status) refuses a second Solo
  // (a card is added through Checkout only while it is still the no-card
  // trial, #1568) but is upgraded through Checkout: the webhook cancels it
  // once the Team or Business subscription is paid, so there is never a
  // double bill. A trial or free row whose id is an unfinished first payment
  // may retry.
  const heldSolo = held?.tier === "solo" || held?.tier === "trial";
  const soloState = held?.tier === "trial" ? held.solo_status : held?.status;
  const soloLive =
    Boolean(held?.stripe_subscription_id) &&
    heldSolo &&
    (soloState === "active" || soloState === "past_due");
  const inSoloTrial =
    soloLive &&
    soloState === "active" &&
    held?.solo_trial_ends_at != null &&
    held.solo_trial_ends_at > Date.now();
  if (
    held?.stripe_subscription_id &&
    (held.status === "suspended" ||
      ((held.tier === "team" || held.tier === "business") &&
        (held.status === "active" || held.status === "past_due")) ||
      (plan === "solo" && soloLive && !inSoloTrial))
  ) {
    console.log("billing checkout subscription_exists", install);
    return bad("subscription_exists", 409);
  }
  // Solo's prices are for a Solo (or pre-Solo free, or trial) instance: the
  // server checks this first; billing keeps it too, so a Team or Business
  // row never gets a Solo session.
  if (
    plan === "solo" &&
    held?.tier &&
    held.tier !== "solo" &&
    held.tier !== "free" &&
    held.tier !== "trial"
  ) {
    console.log("billing checkout plan_conflict", install);
    return bad("plan_conflict", 409);
  }
  const cfg: StripeConfig = { secretKey: env.STRIPE_SECRET_KEY ?? "" };
  const customerId = await customerFor(
    env.BILLING_DB,
    install,
    cfg,
    Date.now(),
    isClockInstall(
      env,
      env.STAGING_TEST_CLOCK_INSTALLS,
      install,
      (await lookupInstall(env.BROKER_REGISTRY, install, Date.now()))?.origin,
    ),
  );
  const base = `https://${appHost}${PLAN_PATH}`;
  // Paying during the no-card Solo trial keeps the free days: the new
  // subscription's trial ends where the old one's does, so no money moves
  // until then and the card is collected. Stripe needs trial_end at least 48
  // hours ahead (checked here with a safety hour for the time it takes to
  // arrive); with less left the Checkout charges now.
  const now = Date.now();
  const trialEnd =
    plan === "solo" &&
    inSoloTrial &&
    held?.solo_trial_ends_at != null &&
    held.solo_trial_ends_at - now >= MIN_TRIAL_END_MS
      ? Math.floor(held.solo_trial_ends_at / 1000)
      : undefined;
  // Plan (and Solo's interval) in the key: the same ts with another plan is a
  // new session, never Stripe's 400 for a reused key with other params.
  const idempotencyKey =
    plan === "solo"
      ? `checkout-${install}-solo-${interval}${trialEnd === undefined ? "" : "-trial"}-${body.ts}`
      : `checkout-${install}-${tier}${quantity === undefined ? "" : `-q${quantity}`}-${body.ts}`;
  // Only the newest Checkout can be paid: the install's open session (kept
  // below) is expired first. A retry with the same key is the same session
  // (Stripe replays it), so it is not expired. Order matters for a crash: the
  // expire comes first, so a crash after it leaves nothing open (the next
  // try finds it expired and makes one); a crash after the create but before
  // the id is stored leaves one unknown open session, which the webhook
  // still handles (the later paid session wins, the earlier is cancelled).
  const open = await env.BILLING_DB.prepare(OPEN_SQL).bind(install).first<{
    open_checkout_id: string | null;
    open_checkout_key: string | null;
  }>();
  if (open?.open_checkout_id && open.open_checkout_key !== idempotencyKey) {
    const sessionId = open.open_checkout_id;
    await stripe(install, () => expireCheckoutSession({ sessionId }, cfg));
  }
  const s = await stripe(install, () =>
    createCheckoutSession(
      {
        customerId,
        priceId,
        tier,
        ...(quantity === undefined ? {} : { quantity }),
        ...(trialEnd === undefined ? {} : { trialEnd }),
        successUrl: `${base}?checkout=done`,
        cancelUrl: `${base}?checkout=cancel`,
        idempotencyKey,
      },
      cfg,
    ),
  );
  // Store it, only if no other call stored its own meanwhile; the loser
  // expires its session and answers 409 checkout_in_progress (a new request
  // then expires the winner's: the later call wins).
  const stored = await env.BILLING_DB.prepare(STORE_OPEN_SQL)
    .bind(
      s.id,
      idempotencyKey,
      install,
      open?.open_checkout_id ?? null,
      open?.open_checkout_key ?? null,
    )
    .first();
  if (!stored) {
    const now2 = await env.BILLING_DB.prepare(OPEN_SQL)
      .bind(install)
      .first<{ open_checkout_id: string | null }>();
    if (now2?.open_checkout_id !== s.id) {
      await stripe(install, () =>
        expireCheckoutSession({ sessionId: s.id }, cfg),
      ).catch(() => undefined);
      console.log("billing checkout lost_race", install);
      // 409, not 503: the server retries a 503 automatically with the same
      // request (the same key), which would return this dead session's URL.
      return bad("checkout_in_progress", 409);
    }
  }
  return answer(install, "checkout", s.url, CHECKOUT_URL);
}

async function portal(
  env: Env,
  install: string,
  appHost: string,
  body: Record<string, unknown>,
) {
  const row = await env.BILLING_DB.prepare(CUSTOMER_SQL)
    .bind(install)
    .first<{ stripe_customer_id: string | null }>();
  const customerId = row?.stripe_customer_id;
  if (!customerId) {
    console.log("billing portal no_customer", install);
    return bad("no_customer", 409);
  }
  const cfg: StripeConfig = { secretKey: env.STRIPE_SECRET_KEY ?? "" };
  const s = await stripe(install, () =>
    createPortalSession(
      {
        customerId,
        returnUrl: `https://${appHost}${PLAN_PATH}`,
        idempotencyKey: `portal-${install}-${body.ts}`,
      },
      cfg,
    ),
  );
  return answer(install, "portal", s.url, PORTAL_URL);
}

/** `{url}` only, and only a Stripe-hosted page (else 502 bad_upstream). */
function answer(install: string, route: string, url: string, host: RegExp) {
  if (!host.test(url)) {
    console.error("billing stripe bad_upstream", install);
    return bad("bad_upstream", 502);
  }
  console.log("billing", route, "session", install);
  return Response.json({ url });
}

async function tier(db: D1Database, install: string, now: number) {
  await materialize(db, install, now);
  const r = await db.prepare(READ_SQL).bind(install, now).first<TierRow>();
  console.log("billing tier", r ? "row" : "default", install);
  return Response.json(view(r, now));
}

// Solo trials ending in (from, to], oldest install id first, after a cursor.
// Only a live no-card Solo trial: a Solo row (or a Solo kept live under the
// 30-day Business trial, tier trial with solo_status active), active, that
// never checked out. Another tier, a lapsed or suspended status, a Solo that
// paid (solo_trial_ends_at is then past) and one that checked out during the
// trial (it keeps solo_trial_ends_at but has a card, solo_checked_out) never
// match.
const SOLO_ENDING_SQL =
  "SELECT install_id, solo_trial_ends_at FROM tiers WHERE ((tier = 'solo' AND status = 'active') OR (tier = 'trial' AND status = 'active' AND solo_status = 'active')) AND solo_checked_out IS NULL AND solo_trial_ends_at > ?1 AND solo_trial_ends_at <= ?2 AND install_id > ?3 ORDER BY install_id LIMIT ?4";
const SOLO_ENDING_MAX = 200;

/** GET /solo/trial-ending?from=<ms>&to=<ms>[&after=<install>][&limit=<n>]. */
async function soloTrialEnding(db: D1Database, q: URLSearchParams) {
  const num = (k: string) => {
    const v = q.get(k);
    return v !== null && /^\d{1,15}$/.test(v) ? Number(v) : null;
  };
  const from = num("from");
  const to = num("to");
  const after = q.get("after") ?? "";
  const limit = Math.min(num("limit") ?? 100, SOLO_ENDING_MAX);
  if (
    from === null ||
    to === null ||
    to < from ||
    limit < 1 ||
    (after !== "" && !INSTALL_ID.test(after))
  )
    return bad("bad_query");
  const { results } = await db
    .prepare(SOLO_ENDING_SQL)
    .bind(from, to, after, limit)
    .all<{ install_id: string; solo_trial_ends_at: number }>();
  console.log("billing solo trial-ending", results.length);
  return Response.json({
    installs: results.map((r) => ({
      installId: r.install_id,
      trialEndsAt: r.solo_trial_ends_at,
    })),
    next:
      results.length === limit ? (results.at(-1)?.install_id ?? null) : null,
  });
}

async function trialStart(
  db: D1Database,
  install: string,
  body: Record<string, unknown>,
  now: number,
) {
  if (mismatched(body, install)) return bad("install_mismatch", 403);
  await materialize(db, install, now);
  const started = await db
    .prepare(TRIAL_SQL)
    .bind(install, now + TRIAL_MS, now)
    .first<TierRow>();
  if (started) {
    console.log("billing trial started", install);
    return Response.json(view(started, now));
  }
  // Any other state: unchanged, and still a 200.
  const r = await db.prepare(SELECT_SQL).bind(install).first<TierRow>();
  console.log("billing trial unchanged", install);
  return Response.json(view(r, now));
}

/**
 * The Solo plan's 30-day no-card trial, made through the Stripe API (no
 * Checkout visit), for the provisioner's RPC (BillingProvisionerRpc.soloStart,
 * #1568). Idempotent per install: the subscription is keyed
 * solo-trial-<install>, and nothing is created when the row already holds a
 * subscription or ever had a Solo trial (an "ok" answer all the same). A row
 * on team, business or trial is plan_conflict; a lapsed, past_due or
 * suspended one is not_active, with no customer and no Stripe call. Answers a
 * result; a StripeFailure or a D1 error is the caller's to classify.
 */
async function soloStartCore(
  env: Env,
  install: string,
  now: number,
): Promise<SoloStartResult> {
  const priceId = env.STRIPE_PRICE_SOLO_MONTHLY;
  if (typeof priceId !== "string" || !PRICE_ID.test(priceId)) {
    console.error("billing stripe config", install);
    return soloFail("config");
  }
  const db = env.BILLING_DB;
  await materialize(db, install, now);
  const held = await db.prepare(SOLO_HELD_SQL).bind(install).first<{
    tier: string | null;
    status: string | null;
    stripe_subscription_id: string | null;
    solo_trial_ends_at: number | null;
  }>();
  if (held?.tier && held.tier !== "solo" && held.tier !== "free") {
    console.log("billing solo plan_conflict", install);
    return soloFail("plan_conflict");
  }
  // A lapsed, past_due or suspended row gets no trial and no Stripe call (a
  // missing row is an active Solo by default).
  if (held && held.status !== "active") {
    console.log("billing solo not_active", install);
    return soloFail("not_active");
  }
  const unchanged = async (): Promise<SoloStartResult> => {
    const r = await db.prepare(SELECT_SQL).bind(install).first<TierRow>();
    console.log("billing solo unchanged", install);
    return soloOk(view(r, now));
  };
  // One trial per install, and nothing beside a subscription already there.
  if (held?.stripe_subscription_id || held?.solo_trial_ends_at != null)
    return unchanged();
  const cfg: StripeConfig = { secretKey: env.STRIPE_SECRET_KEY ?? "" };
  const customerId = await customerFor(
    db,
    install,
    cfg,
    now,
    isClockInstall(
      env,
      env.STAGING_TEST_CLOCK_INSTALLS,
      install,
      (await lookupInstall(env.BROKER_REGISTRY, install, Date.now()))?.origin,
    ),
  );
  const sub = await stripe(install, () =>
    createSoloTrialSubscription(
      { customerId, priceId, idempotencyKey: `solo-trial-${install}` },
      cfg,
    ),
  );
  // Only where no subscription is stored yet (or it is this one: a webhook
  // that got here first), and only once: concurrent starts bump the version
  // once.
  const started = await db
    .prepare(SOLO_START_SQL)
    .bind(install, sub.id, now + SOLO_TRIAL_MS, now)
    .first<TierRow>();
  if (started) {
    console.log("billing solo started", install);
    return soloOk(view(started, now));
  }
  return unchanged();
}

const soloFail = (error: SoloStartError): SoloStartResult => ({
  ok: false,
  error,
  retryable: SOLO_START_RETRYABLE[error],
});
const soloOk = (v: ReturnType<typeof view>): SoloStartResult => ({
  ok: true,
  tier: v.tier as SoloStartView["tier"],
  status: v.status as SoloStartView["status"],
  trialEndsAt: v.trialEndsAt,
  graceUntil: v.graceUntil,
  soloTrialEndsAt: v.soloTrialEndsAt,
  version: v.version,
  asOf: v.asOf,
});

/**
 * The provisioner's call, as a module function (the class below must hold
 * nothing else: Workers RPC exposes every public method). Validates the id,
 * requires the install in BROKER_REGISTRY, runs the core, and turns every
 * outcome into a result: it never throws.
 */
async function provisionerSoloStart(
  env: Env,
  install: unknown,
): Promise<SoloStartResult> {
  if (typeof install !== "string" || !INSTALL_ID.test(install))
    return soloFail("bad_install");
  const now = Date.now();
  try {
    // The provisioner writes the entry before it calls; KV takes time to show
    // it, so "not there" is retryable.
    if (!(await lookupInstall(env.BROKER_REGISTRY, install, now))) {
      console.log("billing solo unknown_install", install);
      return soloFail("unknown_install");
    }
    return await soloStartCore(env, install, now);
  } catch (e) {
    if (e instanceof StripeFailure) {
      // A 4xx Stripe refused outright (other than 409, in progress, and 408,
      // 424 and 429, which may pass) will not change by retrying: a revoked or restricted
      // key, a bad price, a missing customer. The HTTP routes keep answering
      // 502 upstream; only this RPC tells the caller apart. A fixed category
      // and the status number, never Stripe's text.
      if (
        e.code === "upstream" &&
        e.status !== undefined &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 429 &&
        e.status !== 408 &&
        e.status !== 424
      ) {
        console.error("billing solo stripe_refused", install, e.status);
        return soloFail("stripe_refused");
      }
      return soloFail(e.code);
    }
    // Never the error text: it can carry a D1 message.
    console.error("billing solo_start db_error", install);
    return soloFail("unavailable");
  }
}

/**
 * The provisioner's RPC entrypoint (a service binding with
 * `entrypoint: "BillingProvisionerRpc"`). Workers RPC exposes every public
 * method of a WorkerEntrypoint and TS `private` is not enforced at runtime, so
 * this class has exactly one method, delegating to a module function; no
 * helpers on the class (a test pins the prototype).
 */
export class BillingProvisionerRpc extends WorkerEntrypoint<Env> {
  soloStart(install: string): Promise<SoloStartResult> {
    return provisionerSoloStart(this.env, install);
  }
}

// An operator comp (#66): the row's tier and status are set, whatever they
// were, unless a live Stripe subscription owns them (one statement, so a
// webhook cannot slip between check and write). Trial dates stay (the
// 30-day Business trial is still used up); the Solo-under-trial and grace
// state go, as the tier no longer depends on them. A missing row is made.
const SET_TIER_PREV_SQL =
  "SELECT tier, status, version FROM tiers WHERE install_id = ?1";
const SET_TIER_SQL = `INSERT INTO tiers (install_id, tier, status, version, updated_at) VALUES (?1, ?2, 'active', 1, ?3) ON CONFLICT (install_id) DO UPDATE SET tier = ?2, status = 'active', stripe_subscription_id = NULL, grace_until = NULL, solo_status = NULL, solo_grace_until = NULL, version = tiers.version + 1, updated_at = ?3 WHERE NOT ${SUBSCRIPTION_LIVE_SQL} RETURNING tier, status, version, updated_at`;

const setTierFail = (error: SetTierError): SetTierResult => ({
  ok: false,
  error,
});

/**
 * The operator's call (BillingOperatorRpc.setTier), as a module function like
 * provisionerSoloStart: validates, requires the install in BROKER_REGISTRY,
 * writes, and answers a result; it never throws.
 */
async function operatorSetTier(
  env: Env,
  install: unknown,
  tier: unknown,
): Promise<SetTierResult> {
  if (typeof install !== "string" || !INSTALL_ID.test(install))
    return setTierFail("bad_install");
  if (!SET_TIER_TIERS.includes(tier as SetTierTier))
    return setTierFail("bad_tier");
  const now = Date.now();
  try {
    if (!(await lookupInstall(env.BROKER_REGISTRY, install, now)))
      return setTierFail("unknown_install");
    const db = env.BILLING_DB;
    const prev = await db.prepare(SET_TIER_PREV_SQL).bind(install).first<{
      tier: string | null;
      status: string | null;
      version: number;
    }>();
    const row = await db
      .prepare(SET_TIER_SQL)
      .bind(install, tier, now)
      .first<{ version: number; updated_at: number }>();
    if (!row) {
      console.log("billing set_tier subscription_active", install);
      return setTierFail("subscription_active");
    }
    console.log("billing set_tier", install, tier);
    return {
      ok: true,
      tier: tier as SetTierTier,
      status: "active",
      version: row.version,
      updatedAt: row.updated_at,
      previous: prev
        ? { tier: prev.tier, status: prev.status, version: prev.version }
        : null,
    };
  } catch {
    console.error("billing set_tier db_error", install);
    return setTierFail("unavailable");
  }
}

// The read side of the operator RPC (#2058): the tier GET /tier shows, for
// many installs, in one SELECT, and no write at all (no materialize, no
// version bump, no last_read_at, no Stripe). An ended Business trial is
// projected as MATERIALIZE_SQL would leave it (same fragments). No row: solo,
// active.
// now is inlined (an integer from Date.now()): D1 allows 100 bound values and
// TIERS_OF_MAX ids use them all.
const TIERS_OF_SQL = (n: number, now: number) =>
  `SELECT install_id, CASE WHEN ${trialEnded(String(Math.trunc(now)))} THEN 'solo' ELSE tier END AS tier, CASE WHEN ${trialEnded(String(Math.trunc(now)))} THEN ${ENDED_STATUS_SQL} ELSE status END AS status FROM tiers WHERE install_id IN (${Array.from({ length: n }, () => "?").join(",")})`;
type TiersOfRow = {
  install_id: string;
  tier: string | null;
  status: string | null;
};
async function operatorTiersOf(
  env: Env,
  installs: unknown,
): Promise<TiersOfResult> {
  if (
    !Array.isArray(installs) ||
    installs.length < 1 ||
    installs.length > TIERS_OF_MAX ||
    !installs.every((i) => typeof i === "string" && INSTALL_ID.test(i))
  )
    return { ok: false, error: "bad_installs" };
  const ids = [...new Set(installs as string[])];
  const now = Date.now();
  try {
    const rows = (
      await env.BILLING_DB.prepare(TIERS_OF_SQL(ids.length, now))
        .bind(...ids)
        .all<TiersOfRow>()
    ).results;
    const tiers: Record<string, TierOfView> = {};
    for (const id of ids) tiers[id] = { tier: "solo", status: "active" };
    for (const r of rows)
      tiers[r.install_id] = { tier: r.tier, status: r.status };
    return { ok: true, tiers };
  } catch {
    console.error("billing tiers_of db_error");
    return { ok: false, error: "unavailable" };
  }
}

/**
 * The Provisioning API's operator RPC (a service binding with
 * `entrypoint: "BillingOperatorRpc"`): its own entrypoint, so the one Worker
 * that may comp a tier cannot start a Solo trial and the provisioner cannot
 * comp. Exactly two methods (a test pins the prototype).
 */
export class BillingOperatorRpc extends WorkerEntrypoint<Env> {
  setTier(install: string, tier: SetTierTier): Promise<SetTierResult> {
    return operatorSetTier(this.env, install, tier);
  }

  tiersOf(installs: string[]): Promise<TiersOfResult> {
    return operatorTiersOf(this.env, installs);
  }
}

const USAGE_STATE_SQL =
  "SELECT u.applied_quantity, u.apply_outcome, (SELECT max(l.month) FROM usage l WHERE l.install_id = ?1 AND l.month > ?2 AND l.applied_quantity IS NOT NULL) AS later FROM usage u WHERE u.install_id = ?1 AND u.month = ?2";
const USAGE_TIER_SQL =
  "SELECT tier, status, stripe_subscription_id FROM tiers WHERE install_id = ?1";
const USAGE_APPLIED_SQL =
  "UPDATE usage SET applied_quantity = ?3, applied_at = ?4, apply_outcome = ?5 WHERE install_id = ?1 AND month = ?2";
const USAGE_OUTCOME_SQL =
  "UPDATE usage SET apply_outcome = ?3 WHERE install_id = ?1 AND month = ?2";
/** A UTC calendar month, YYYY-MM. */
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/**
 * Per-creator monthly billing (#2123): a closed month's report sets the
 * install's monthly Team or Business subscription quantity to its creator
 * count (at least 1), with no proration, so the next invoice bills that
 * many. Runs after the report is stored, so a failure here never loses it.
 * Idempotent per (install, month): a month already applied at this quantity
 * changes nothing, and the Stripe write is keyed qty-<install>-<month>-<n>.
 * Skipped, with the reason in usage.apply_outcome: the current (or a future)
 * month, a month older than one already applied, no row or subscription, and
 * Solo, trial, lapsed or suspended rows. billing-core leaves a subscription
 * whose price is not the tier's monthly price alone (not_monthly): a yearly
 * prepaid-seat price recurs yearly and is recognised there (PR 4b bills its
 * overage). Answers null when the route's 200 stands, or the refusal: a
 * Stripe failure the install should retry (network, 5xx, 409, 429, config)
 * is that failure's 5xx, and the instance's usage tick re-sends the month
 * (every 2 minutes) until it is accepted. A Stripe 4xx that a retry can't
 * fix is recorded (failed) and logged, and the 200 stands so later months
 * still report; the next report, or a repeat of this one, tries again.
 */
async function applyQuantity(
  env: Env,
  install: string,
  month: string,
  count: number,
  now: number,
): Promise<Response | null> {
  if (month >= monthOf(now)) return null;
  const db = env.BILLING_DB;
  const quantity = Math.max(1, count);
  const outcome = async (o: string) => {
    await db.prepare(USAGE_OUTCOME_SQL).bind(install, month, o).run();
    console.log("billing usage quantity", o, install);
    return null;
  };
  const state = await db.prepare(USAGE_STATE_SQL).bind(install, month).first<{
    applied_quantity: number | null;
    apply_outcome: string | null;
    later: string | null;
  }>();
  if (
    state?.applied_quantity === quantity &&
    (state.apply_outcome === "updated" || state.apply_outcome === "unchanged")
  ) {
    console.log("billing usage quantity repeat", install);
    return null;
  }
  if (state?.later) return outcome("stale");
  const row = await db.prepare(USAGE_TIER_SQL).bind(install).first<{
    tier: string | null;
    status: string | null;
    stripe_subscription_id: string | null;
  }>();
  if (!row?.stripe_subscription_id) return outcome("no_subscription");
  if (row.tier !== "team" && row.tier !== "business")
    return outcome(row.tier === "trial" ? "trial" : "solo");
  if (row.status !== "active" && row.status !== "past_due")
    return outcome(row.status === "suspended" ? "suspended" : "lapsed");
  const priceId =
    row.tier === "team" ? env.STRIPE_PRICE_TEAM : env.STRIPE_PRICE_BUSINESS;
  const cfg: StripeConfig = { secretKey: env.STRIPE_SECRET_KEY ?? "" };
  const subscriptionId = row.stripe_subscription_id;
  let r: Awaited<ReturnType<typeof setSubscriptionQuantity>>;
  try {
    r = await stripe(install, () =>
      setSubscriptionQuantity(
        {
          subscriptionId,
          quantity,
          monthlyPriceIds: typeof priceId === "string" ? [priceId] : [],
          idempotencyKey: `qty-${install}-${month}-${quantity}`,
        },
        cfg,
      ),
    );
  } catch (e) {
    if (!(e instanceof StripeFailure)) throw e;
    await db.prepare(USAGE_OUTCOME_SQL).bind(install, month, "failed").run();
    console.error("billing usage quantity failed", install);
    const permanent =
      e.code === "bad_upstream" ||
      (e.code === "upstream" &&
        e.status !== undefined &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 429);
    return permanent ? null : e.res;
  }
  if (r.outcome !== "updated" && r.outcome !== "unchanged")
    return outcome(r.outcome);
  await db
    .prepare(USAGE_APPLIED_SQL)
    .bind(install, month, quantity, now, r.outcome)
    .run();
  console.log("billing usage quantity", r.outcome, install, quantity);
  return null;
}

async function usage(
  env: Env,
  install: string,
  body: Record<string, unknown>,
  now: number,
) {
  const db = env.BILLING_DB;
  if (mismatched(body, install)) return bad("install_mismatch", 403);
  const { month, creators, count } = body;
  if (typeof month !== "string" || !MONTH.test(month)) return bad("bad_month");
  if (
    !Array.isArray(creators) ||
    creators.length > MAX_CREATORS ||
    !creators.every((c) => typeof c === "string" && CREATOR.test(c)) ||
    new Set(creators).size !== creators.length
  )
    return bad("bad_creators");
  if (count !== creators.length) return bad("bad_count");
  await db
    .prepare(USAGE_SQL)
    .bind(install, month, JSON.stringify(creators), count, now)
    .run();
  console.log("billing usage", install);
  const refused = await applyQuantity(env, install, month, count, now);
  if (refused) return refused;
  return Response.json({ ok: true, month, count });
}

/** Gate routes: method, path. /health takes no install. */
const GATE = new Set([
  "GET /tier",
  "GET /health",
  "GET /solo/trial-ending",
  "POST /trial/start",
  "POST /usage",
  "POST /checkout",
  "POST /portal",
]);

export default {
  async fetch(req, env) {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return notFound();
    }
    const route = `${req.method} ${url.pathname}`;
    // The one public route: reachable with cf-connecting-ip (Stripe's
    // delivery). billing-core reads and verifies the body; billing doesn't.
    if (route === "POST /stripe/webhook") {
      const secret = env.STRIPE_WEBHOOK_SECRET;
      if (!secret) {
        await req.body?.cancel();
        console.error("billing webhook config");
        return bad("config", 500);
      }
      return handleStripeWebhook(
        req,
        {
          BILLING_DB: env.BILLING_DB,
          STRIPE_WEBHOOK_SECRET: secret,
          STRIPE_PRICE_TEAM: env.STRIPE_PRICE_TEAM,
          STRIPE_PRICE_BUSINESS: env.STRIPE_PRICE_BUSINESS,
          STRIPE_PRICE_SOLO_MONTHLY: env.STRIPE_PRICE_SOLO_MONTHLY,
          STRIPE_PRICE_SOLO_YEARLY: env.STRIPE_PRICE_SOLO_YEARLY,
          STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
        },
        Date.now(),
      );
    }
    // Gate routes only over a binding: an internet request always carries
    // cf-connecting-ip.
    if (!GATE.has(route) || req.headers.has("cf-connecting-ip")) {
      await req.body?.cancel();
      return notFound();
    }
    if (route === "GET /health") return Response.json({ ok: true });
    // The scheduler's trial-reminder read (no install: it lists them). The
    // gate's allowlist never forwards this path, so only a raw binding gets here.
    if (route === "GET /solo/trial-ending") {
      try {
        return await soloTrialEnding(env.BILLING_DB, url.searchParams);
      } catch {
        console.error("billing db_error");
        return bad("unavailable", 503);
      }
    }
    // The install is the gate's header and nothing else.
    const install = req.headers.get(GATE_INSTALL_HEADER);
    if (install === null || !INSTALL_ID.test(install)) {
      await req.body?.cancel();
      return notFound();
    }
    const now = Date.now();
    try {
      if (route === "GET /tier")
        return await tier(env.BILLING_DB, install, now);
      // Both POSTs: the install's signature first, before any write.
      const body = await signedBody(req, env, install, url.pathname, now);
      if (body instanceof Response) return body;
      if (route === "POST /checkout" || route === "POST /portal") {
        if (body.install !== install) return bad("install_mismatch", 403);
        if (!strictBody(body, url.pathname)) return bad("bad_body");
        // The redirect origin: the gate's header (its props), and only an
        // app host on this env's app domain.
        const appHost = req.headers.get(GATE_APP_HOST_HEADER);
        if (!isAppHost(appHost, env.OA_ENV)) {
          console.error("billing bad_app_host", install);
          return bad("bad_app_host", 500);
        }
        try {
          return route === "POST /checkout"
            ? await checkout(env, install, appHost, body)
            : await portal(env, install, appHost, body);
        } catch (e) {
          if (e instanceof StripeFailure) return e.res;
          throw e;
        }
      }
      if (!strictBody(body, url.pathname)) return bad("bad_body");
      if (route === "POST /trial/start")
        return await trialStart(env.BILLING_DB, install, body, now);
      return await usage(env, install, body, now);
    } catch {
      // Never the error text: it can carry a D1 message.
      console.error("billing db_error", install);
      return bad("unavailable", 503);
    }
  },
  // The daily cron (wrangler.jsonc triggers): prune the webhook dedupe table
  // (#1479). A failure is logged by category only and retried by the next run.
  async scheduled(controller, env) {
    try {
      const n = await pruneStripeEvents(
        env.BILLING_DB,
        controller.scheduledTime,
      );
      console.log("billing prune stripe_events", n);
    } catch {
      console.error("billing prune db_error");
    }
  },
} satisfies ExportedHandler<Env>;
