/**
 * The self-serve trial-ending reminder (cloud #39). The welcome email says
 * "we'll remind you a week before"; this is that email.
 *
 * An hourly gate on the 2-minute tick (platform_state) asks billing for the Solo
 * trials ending in the next 7 days (GET /solo/trial-ending over the BILLING
 * binding: the trial end is billing's solo_trial_ends_at, and only a live
 * Solo row with a trial still ahead is listed, so a paid install, another
 * tier or a lapsed row never is). Of those, only a self-serve install that
 * is active, ready and not suspended and has no reminder row is mailed.
 *
 * At most once: the claim is the INSERT of the install's trial_reminders row
 * (0010), before the send, like the welcome claim. A send that fails keeps its
 * claim (a timed-out send may have gone out; a second email is worse than a
 * late one), and the row with no sent_at is what the operator alert counts.
 *
 * The alert is an email to ALERT_TO, once a day while any claim is over
 * UNSENT_MS old and unsent. It is not an ALERT_KEYS entry (those live in the
 * public contract); the follow-up is a public `trial_reminder_unsent` key.
 * Without the BILLING and REMINDER_EMAIL bindings and REMINDER_FROM the send
 * does nothing, as billing-health does without BILLING. Logs carry counts,
 * install ids and fixed categories only, never an address.
 */
import { BILLING_ORIGIN } from "@oa/broker-core/billing-gate";
import { isInstallId, ownerEmailOf } from "@oa/provision/names";
import { DutyFailure, d1, type ProvapiEnv, within } from "./provapi/env.js";
import { claimState, getState, unclaimState } from "./provapi/state.js";
import { trialReminderEmail } from "./trial-reminder-email.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The reminder goes out once the trial ends within this long. */
export const REMINDER_LEAD_MS = 7 * DAY;
/** A trial ending sooner than this gets none: it would arrive too late to act on. */
export const REMINDER_MIN_LEFT_MS = DAY;
/** platform_state: when the duty last ran (hourly). */
export const REMINDER_GATE_KEY = "trial_reminder_checked_at";
export const REMINDER_GATE_MS = HOUR;
/** platform_state: when the unsent alert last went out. */
export const REMINDER_ALERT_KEY = "trial_reminder_unsent_notified_at";
export const REMINDER_ALERT_MS = DAY;
/** A claim this old that was never marked sent is "unsent". */
export const UNSENT_MS = 15 * 60_000;
export const REMINDER_PAGE = 100;
export const REMINDER_MAX_PAGES = 10;
/** Sends per run; the rest wait for the next tick (the gate is given back). */
export const REMINDER_MAX_SENDS = 50;
export const REMINDER_SEND_TIMEOUT_MS = 2_000;
/** The duty's whole budget (provapi/index.ts DUTY_TIMEOUT_MS.reminders). */
export const REMINDER_BUDGET_MS = 4_500;

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;

// The installs read goes through ownerEmailOf (a source test pins it).
const SELECT_OWNER =
  "SELECT i.id AS id, i.app_host AS app_host, i.owner_email AS owner_email FROM installs i";
const ELIGIBLE = `JOIN signups s ON s.install_id = i.id
WHERE s.source = 'self-serve' AND s.status = 'ready' AND i.state = 'active'
  AND NOT EXISTS (SELECT 1 FROM install_lifecycle l WHERE l.install_id = i.id AND l.suspended_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM trial_reminders r WHERE r.install_id = i.id)`;
const CLAIM_SQL =
  "INSERT INTO trial_reminders (install_id, trial_ends_at, claimed_at) VALUES (?1, ?2, ?3) ON CONFLICT (install_id) DO NOTHING";
const SENT_SQL =
  "UPDATE trial_reminders SET sent_at = ?2 WHERE install_id = ?1 AND sent_at IS NULL";
const UNSENT_SQL =
  "SELECT COUNT(*) AS n, MIN(claimed_at) AS since FROM trial_reminders WHERE sent_at IS NULL AND claimed_at <= ?1";

export interface Due {
  installId: string;
  trialEndsAt: number;
}

/** Billing's Solo trials ending in (from, to], every page (bounded). */
async function dueFromBilling(
  billing: Fetcher,
  from: number,
  to: number,
): Promise<Due[]> {
  const out: Due[] = [];
  let after = "";
  for (let page = 0; page < REMINDER_MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      from: String(from),
      to: String(to),
      limit: String(REMINDER_PAGE),
    });
    if (after) qs.set("after", after);
    let body: { installs?: unknown; next?: unknown };
    try {
      const r = await billing.fetch(
        `${BILLING_ORIGIN}/solo/trial-ending?${qs}`,
      );
      if (r.status !== 200) {
        await r.body?.cancel();
        throw new Error("status");
      }
      body = (await r.json()) as typeof body;
    } catch {
      throw new DutyFailure("rpc_error");
    }
    if (!Array.isArray(body.installs)) throw new DutyFailure("parse_error");
    for (const x of body.installs as {
      installId?: unknown;
      trialEndsAt?: unknown;
    }[]) {
      if (
        typeof x?.installId === "string" &&
        isInstallId(x.installId) &&
        typeof x.trialEndsAt === "number" &&
        Number.isFinite(x.trialEndsAt)
      )
        out.push({ installId: x.installId, trialEndsAt: x.trialEndsAt });
    }
    if (typeof body.next !== "string" || !isInstallId(body.next)) return out;
    after = body.next;
  }
  return out;
}

/** The ids (of those given) that are mailable, with host and owner address. */
async function mailable(
  db: D1Database,
  ids: string[],
): Promise<Map<string, { appHost: string; to: string }>> {
  const out = new Map<string, { appHost: string; to: string }>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await d1(
      db
        .prepare(
          `${SELECT_OWNER} ${ELIGIBLE} AND i.id IN (${chunk.map((_, n) => `?${n + 1}`).join(",")})`,
        )
        .bind(...chunk)
        .all<Record<string, unknown>>(),
    );
    for (const r of results) {
      const to = ownerEmailOf(r);
      if (
        typeof r.id === "string" &&
        typeof r.app_host === "string" &&
        r.app_host !== "" &&
        to !== null &&
        ADDRESS.test(to)
      )
        out.set(r.id, { appHost: r.app_host, to });
    }
  }
  return out;
}

export type Outcome = "sent" | "failed" | "raced";

/** Claim, send, mark sent. Never throws. */
async function remind(
  env: ProvapiEnv,
  send: SendEmail,
  from: string,
  d: Due,
  m: { appHost: string; to: string },
  now: number,
): Promise<Outcome> {
  const db = env.PLATFORM_DB;
  try {
    const claim = await db
      .prepare(CLAIM_SQL)
      .bind(d.installId, d.trialEndsAt, now)
      .run();
    if (claim.meta.changes !== 1) return "raced";
  } catch {
    console.error("provapi reminders db_error", d.installId);
    return "failed";
  }
  try {
    await within(
      Promise.resolve().then(() =>
        send.send(
          trialReminderEmail({
            from,
            to: m.to,
            appHost: m.appHost,
            trialEndsAt: d.trialEndsAt,
          }),
        ),
      ),
      REMINDER_SEND_TIMEOUT_MS,
    );
  } catch (e) {
    // Claimed, maybe sent: kept, and the unsent alert says so.
    const code = (e as { code?: unknown } | null)?.code;
    console.error(
      "provapi reminders send_failed",
      d.installId,
      typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
        ? code
        : "send_error",
    );
    return "failed";
  }
  try {
    await db.prepare(SENT_SQL).bind(d.installId, now).run();
  } catch {
    console.error("provapi reminders db_error", d.installId);
  }
  console.log("provapi reminders sent", d.installId);
  return "sent";
}

/** One run: bounded, never past REMINDER_MAX_SENDS sends. */
export async function sendDueReminders(
  env: ProvapiEnv,
  now: number,
  budgetMs = REMINDER_BUDGET_MS,
): Promise<void> {
  const started = Date.now();
  const from = env.REMINDER_FROM ?? "";
  if (!env.BILLING || !env.REMINDER_EMAIL || !ADDRESS.test(from)) return;
  const db = env.PLATFORM_DB;
  const prev = await d1(getState(db, REMINDER_GATE_KEY));
  if (
    !(await d1(claimState(db, REMINDER_GATE_KEY, now, now - REMINDER_GATE_MS)))
  )
    return;
  let sent = 0;
  let failed = 0;
  let more = false;
  try {
    const due = await dueFromBilling(
      env.BILLING,
      now + REMINDER_MIN_LEFT_MS,
      now + REMINDER_LEAD_MS,
    );
    const ok = await mailable(
      db,
      due.map((x) => x.installId),
    );
    for (const d of due) {
      const m = ok.get(d.installId);
      if (!m) continue;
      // A send that could end past the budget waits for the next tick.
      if (
        sent + failed >= REMINDER_MAX_SENDS ||
        Date.now() - started + REMINDER_SEND_TIMEOUT_MS > budgetMs
      ) {
        more = true;
        break;
      }
      const o = await remind(env, env.REMINDER_EMAIL, from, d, m, now);
      if (o === "sent") sent++;
      else if (o === "failed") failed++;
    }
  } catch (e) {
    // Nothing was listed or checked: give the hour back for the next tick.
    await unclaimState(db, REMINDER_GATE_KEY, now, prev).catch(() => {});
    throw e;
  }
  // Cut short: the rest go on the next tick, not in an hour.
  if (more)
    await unclaimState(db, REMINDER_GATE_KEY, now, prev).catch(() => {});
  if (sent || failed)
    console.log("provapi reminders run", `sent=${sent}`, `failed=${failed}`);
}

/**
 * Emails ALERT_TO, at most once a day, while a reminder was claimed over
 * UNSENT_MS ago and never marked sent. No clear email: the count going to zero
 * is the clear. Never throws.
 */
export async function unsentReminderAlert(
  env: ProvapiEnv,
  now: number,
): Promise<void> {
  const db = env.PLATFORM_DB;
  try {
    const r = await db
      .prepare(UNSENT_SQL)
      .bind(now - UNSENT_MS)
      .first<{ n: number; since: number | null }>();
    if (!r || !(r.n > 0)) return;
    const to = env.ALERT_TO ?? "";
    const from = env.ALERT_FROM ?? "";
    if (!env.ALERT_EMAIL || !ADDRESS.test(to) || !ADDRESS.test(from)) {
      console.log("provapi reminders alert skipped no_destination");
      return;
    }
    const prev = await getState(db, REMINDER_ALERT_KEY);
    if (
      !(await claimState(db, REMINDER_ALERT_KEY, now, now - REMINDER_ALERT_MS))
    )
      return;
    try {
      await within(
        Promise.resolve().then(() =>
          env.ALERT_EMAIL?.send({
            from,
            to,
            subject: `Open Artifacts ${env.OA_ENV}: trial reminder unsent`,
            text: `${r.n} trial-ending reminder email${r.n === 1 ? " was" : "s were"} claimed over ${UNSENT_MS / 60_000} minutes ago and never marked sent (oldest claimed ${new Date(r.since ?? now).toISOString()}). Check the send log first. If one never went out, delete its trial_reminders row in platform D1 and the next hourly run sends it. You get this at most once a day while any stays unsent.\n`,
          }),
        ),
        REMINDER_SEND_TIMEOUT_MS,
      );
      console.log("provapi reminders alert sent");
    } catch {
      // Give the day back, so the next tick retries.
      await unclaimState(db, REMINDER_ALERT_KEY, now, prev).catch(() => {});
      console.error("provapi reminders alert send_failed");
    }
  } catch {
    console.error("provapi reminders alert db_error");
  }
}

/** The duty: the alert first (it needs no bindings of the send), then the sends. */
export async function trialRemindersDue(
  env: ProvapiEnv,
  now: number,
  budgetMs = REMINDER_BUDGET_MS,
): Promise<void> {
  await unsentReminderAlert(env, now);
  await sendDueReminders(env, now, budgetMs);
}
