/**
 * solo_start_missing: a self-serve install is ready but ProvisionInstall's
 * solo_start step never recorded billing's answer. The signal is local
 * (signups.solo_started_at / solo_skipped_at, 0012), so this never calls
 * billing; the step sets solo_skipped_at where billing is not bound (prod
 * until it ships), so those rows never alert. Excluded: admin and operator
 * creates (source), test-hooks installs, and the operator's own slugs.
 *
 * Like welcome_unsent it needs no clear state: an email to ALERT_TO at most
 * once a day while any row matches; fixing a row (or the count reaching zero)
 * is the clear. It is not an ALERT_KEYS entry (those live in the public
 * contract); the follow-up is a public `solo_start_missing` key. Emails and
 * logs carry counts and install ids only.
 */
import type { AlertEnv } from "./alerts.js";
import { within } from "./env.js";
import { claimState, getState, unclaimState } from "./state.js";

/** A ready self-serve install older than this with no solo_start record. */
export const SOLO_START_MS = 30 * 60_000;
export const SOLO_ALERT_KEY = "solo_start_missing_notified_at";
export const SOLO_ALERT_MS = 24 * 60 * 60_000;
export const SOLO_SEND_TIMEOUT_MS = 5_000;
/** The operator's own installs, never alerted. */
export const SOLO_EXCLUDED_SLUGS = ["leo", "rl-a", "rl-b"] as const;
const IDS_SHOWN = 10;

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;

export const SOLO_MISSING_SQL = `SELECT s.install_id AS install_id, s.updated_at AS since
FROM signups s
WHERE s.source = 'self-serve' AND s.status = 'ready' AND s.test_hooks = 0
  AND s.install_id IS NOT NULL
  AND s.slug NOT IN (${SOLO_EXCLUDED_SLUGS.map((_, i) => `?${i + 2}`).join(", ")})
  AND s.solo_started_at IS NULL AND s.solo_skipped_at IS NULL
  AND s.updated_at <= ?1
ORDER BY s.updated_at, s.signup_id`;

/** Emails ALERT_TO, at most once a day, while any such row exists. Never throws. */
export async function soloStartMissingAlert(
  env: AlertEnv,
  now: number,
): Promise<void> {
  const db = env.PLATFORM_DB;
  try {
    const { results } = await db
      .prepare(SOLO_MISSING_SQL)
      .bind(now - SOLO_START_MS, ...SOLO_EXCLUDED_SLUGS)
      .all<{ install_id: string; since: number }>();
    if (results.length === 0) return;
    const to = env.ALERT_TO ?? "";
    const from = env.ALERT_FROM ?? "";
    if (!env.ALERT_EMAIL || !ADDRESS.test(to) || !ADDRESS.test(from)) {
      console.log("provapi solo_start_missing skipped no_destination");
      return;
    }
    const prev = await getState(db, SOLO_ALERT_KEY);
    if (!(await claimState(db, SOLO_ALERT_KEY, now, now - SOLO_ALERT_MS)))
      return;
    const ids = results.slice(0, IDS_SHOWN).map((r) => r.install_id);
    const more = results.length - ids.length;
    try {
      await within(
        Promise.resolve().then(() =>
          env.ALERT_EMAIL?.send({
            from,
            to,
            subject: "Open Artifacts: Solo start missing",
            text: `${results.length} self-serve install${results.length === 1 ? " is" : "s are"} ready but billing never confirmed the Solo start (oldest ready ${new Date(results[0]?.since ?? now).toISOString()}). Check ProvisionInstall's solo_start step in the logs, and billing's soloStart for the install; fix by running billing's soloStart for it, then set signups.solo_started_at. You get this at most once a day while any stays missing.\n\nInstalls:\n${ids.join("\n")}${more > 0 ? `\n... and ${more} more` : ""}\n(alert solo_start_missing)\n`,
          }),
        ),
        SOLO_SEND_TIMEOUT_MS,
      );
      console.log("provapi solo_start_missing sent");
    } catch {
      // Give the day back, so the next tick retries.
      await unclaimState(db, SOLO_ALERT_KEY, now, prev).catch(() => {});
      console.error("provapi solo_start_missing send_failed");
    }
  } catch {
    console.error("provapi solo_start_missing db_error");
  }
}
