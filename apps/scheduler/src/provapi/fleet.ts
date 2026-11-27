// The fleet rollout (#955): every install follows the platform's release.
// The target is this Worker's own release, its version tag (the
// "workers/tag" annotation deploy-hosted-platform sets on every platform
// Worker), so the fleet moves when the platform does: staging on the staging
// deploy, prod on the prod deploy, which a green staging red-line gates.
//
// The canary (FLEET_CANARY) goes first, must answer one healthy probe, and
// then must pass the canary smoke (smoke.ts, #1343): short active checks as a
// dedicated smoke member. Then every other install that is behind moves at
// once (cloud #433, Leo: "as soon as we have a healthy probe, we can keep
// going"; leo goes with the rest). FLEET_CONCURRENCY only bounds how many
// upgrades are open at a time. Nothing here waits or polls (cloud #264, Leo:
// "Everything should be event-based, push, never PULL"): each run is one
// pass, started by an event (the deploy's wake, and every ManageInstall
// job's end, wake.ts), and a pass that only time can finish (a probe or
// smoke to repeat) asks its message back with a backoff. Only serving,
// active, idle installs with health ok and test hooks off move: a broken
// install is skipped (version_skew reports it), so it can't halt a release.
// The exception is an install on a halted version, or one that halted a
// version: it gets one try at a later release whatever its health or serving
// mode, as that may be its fix. It has to soak to earn another, so one broken
// install can't halt every release. An install above the target is never
// downgraded.
//
// Settle (the "soaked" marks, so state carries over): every pass probes the
// installs upgraded to the target. With the smoke required, one passing probe
// settles an install (FLEET_SOAK_MS is 0). With the smoke off, its
// probes must pass unbroken for FLEET_SOAK_MIN; a gap over FLEET_SOAK_GAP_MS
// restarts that clock, as a failure does. That soak is a timer by design, so
// where the smoke is off the 2-minute tick keeps its fleet duty
// (provapi/index.ts tickRunsFleet).
//
// Every pass works from state, never from the message that started it: any
// event (a job's end, a deploy's wake) re-reads the whole fleet, so one lost
// message is recovered by the next event of any kind. Where the smoke is
// required no tick runs the fleet (cloud #264); the 2-minute cron
// keeps only its alert marks (fleetMarks).
//
// Smoke: once the canary has settled, smoke() runs in the same pass, then
// once per pass until it passes (fleet_smoked). The canary answering wrongly
// halts the version at once; a timeout, network error or 5xx counts once, and a second at least
// FLEET_FAIL_GAP_MS later halts. A smoke that can't run as set up (no token, smoke not a plain
// member, a bad share target) never passes and never halts: fleet_halted names it
// (smoke_unconfigured). Running out of the tick's time is neither.
//
// Halt: a failed fleet upgrade, or a second failed probe of that version at
// least FLEET_FAIL_GAP_MS after the first, on any install, halts the version for good and alerts. Nothing
// resets a failed probe: not a pass, and not the install leaving the watch,
// so flapping halts, and so does a release failing once on every install. A person
// decides what happens to the install: there is no automatic rollback here
// (#1105), though ManageInstall reverts an upgrade that fails its own checks.
// A halt never blocks the next release. The insert re-reads the halt and the
// batch in the same statement, so an overlapping tick can't queue onto a
// halted version or past an unsoaked batch, and halting cancels what is still
// queued for it.
import { isInstallId } from "@oa/provision/names";
import { compareVersions } from "@oa/provision/versions";
import type { AlertRow } from "@oa/provisioning-contract/alerts";
import { alertStateKey } from "@oa/provisioning-contract/state";
import { SYSTEM_ACTOR } from "@oa/provisioning-contract/system";
import type { Condition } from "./conditions.js";
import { bound, d1, type ProvapiEnv, within } from "./env.js";
import { type HealthProbe, publicRouteProbe } from "./health.js";
import { insertSystemJob, startJob } from "./jobs.js";
import { dutyCategory } from "./run.js";
import {
  SMOKE_BUDGET_MS,
  SMOKE_CALL_MS,
  type SmokeInput,
  type SmokeResult,
  smoke,
} from "./smoke.js";
import { claimState, unclaimState } from "./state.js";

/**
 * Open fleet upgrades at a time, the insert's own guard included. After the
 * canary, everything behind moves at once (cloud #433); this only bounds a
 * fleet far larger than today's.
 */
export const FLEET_CONCURRENCY = 50;
/**
 * With the smoke required: one passing probe and an install has settled
 * (cloud #433: no settle wait, the canary smoke guards the rest).
 */
export const FLEET_SOAK_MS = 0;
/**
 * A second failed probe (or smoke transport failure) of a version halts it
 * only this long after the first: a quick retry must not halt on one blip.
 */
export const FLEET_FAIL_GAP_MS = 60_000;
/**
 * A pass's deadline from its start on the 2-minute tick (smoke off only):
 * the fleet duty's 25 s budget less a 2 s margin. The smoke gets only the
 * time left, its cleanup aside (smokeCanary). A wake (wake.ts) passes its own.
 */
export const FLEET_TICK_DEADLINE_MS = 23_000;
/**
 * The fleet run's lease (platform_state), ported from cloud #458: one run at
 * a time, the 2-minute tick's fleet duty and the deploy's wake run (wake.ts)
 * alike, so the two never act side by side. A run that never gives it back
 * (killed mid-run) holds it this long, longer than the longest run
 * (FLEET_WAKE_TIMEOUT_MS in wake.ts): the ticks in between skip the fleet,
 * and the first one after it takes it.
 */
export const FLEET_LEASE_KEY = "scheduler_fleet_lease";
export const FLEET_LEASE_MS = 320_000;
/** The smoke's cleanup runs past its budget: two calls (unshare, delete). */
export const FLEET_SMOKE_CLEANUP_MS = 2 * SMOKE_CALL_MS;
/**
 * With the smoke off (FLEET_SMOKE "off"): the passive soak as before #1343's
 * smoke, FLEET_SOAK_MIN minutes per env (staging 15, prod 60), and no smoke.
 * This is the soak with FLEET_SOAK_MIN unset.
 */
export const FLEET_SOAK_OFF_MS = 15 * 60_000;
/** FLEET_SOAK_MIN's bound, in minutes. */
export const FLEET_SOAK_MIN_MAX = 24 * 60;

/**
 * FLEET_SOAK_MIN as milliseconds, for FLEET_SMOKE "off": unset or empty is
 * FLEET_SOAK_OFF_MS; a whole number of minutes from 1 to FLEET_SOAK_MIN_MAX
 * is that; anything else is the longest soak, so a typo never shortens it.
 */
export function fleetSoakOffMs(v: string | undefined): number {
  const s = v?.trim() ?? "";
  if (s === "") return FLEET_SOAK_OFF_MS;
  const n = /^[1-9]\d{0,3}$/.test(s) ? Number(s) : Number.NaN;
  return n <= FLEET_SOAK_MIN_MAX ? n * 60_000 : FLEET_SOAK_MIN_MAX * 60_000;
}

/**
 * FLEET_SMOKE, per env: "off" keeps the passive soak (FLEET_SOAK_MIN) and
 * runs no smoke; "required" settles (FLEET_SOAK_MS) and must pass the smoke.
 * Anything else, unset included, is "required": a typo never skips it.
 */
export type SmokeMode = "required" | "off";
export const fleetSmokeMode = (v: string | undefined): SmokeMode =>
  v?.trim() === "off" ? "off" : "required";
/** Passes further apart than this aren't unbroken: the clock restarts. */
export const FLEET_SOAK_GAP_MS = 5 * 60_000;
/** The canary isn't settled and smoked on the target this long: fleet_halted opens. */
export const FLEET_BLOCKED_MS = 45 * 60_000;
/** With the smoke off, canary_blocked opens this long after the soak, never mid-soak. */
export const FLEET_BLOCKED_EXTRA_MS = 30 * 60_000;

/**
 * canary_blocked's window: FLEET_BLOCKED_MS with the smoke required (a 2-min
 * settle and the smoke); the env's soak plus FLEET_BLOCKED_EXTRA_MS with it
 * off (staging 45, prod 90), so it never opens mid-soak.
 */
export const fleetBlockedMs = (
  env: Pick<ProvapiEnv, "FLEET_SMOKE" | "FLEET_SOAK_MIN">,
): number =>
  fleetSmokeMode(env.FLEET_SMOKE) === "off"
    ? fleetSoakOffMs(env.FLEET_SOAK_MIN) + FLEET_BLOCKED_EXTRA_MS
    : FLEET_BLOCKED_MS;
/** version_skew: an install off the target this long. */
export const FLEET_SKEW_MS = 6 * 60 * 60_000;
/** One /healthz probe; every probe of a tick runs at once. */
export const FLEET_PROBE_TIMEOUT_MS = 8_000;
/** Halts on other versions stay on fleet_halted this long. */
export const FLEET_HALT_ALERT_MS = 6 * 60 * 60_000;
/** Marks of versions below the target are pruned after this long. */
export const FLEET_KEEP_MS = 7 * 24 * 60 * 60_000;
/** `fleet_halt:<version>:<id>`: that install halted the version. */
export const FLEET_HALT_PREFIX = "fleet_halt:";
/** `fleet_fail:<version>`: that version's first failed probe. Nothing resets it. */
export const FLEET_FAIL_PREFIX = "fleet_fail:";
/** `fleet_pass:<version>:<id>`: value, the run's start; updated_at, its last pass. */
export const FLEET_PASS_PREFIX = "fleet_pass:";
/** `fleet_soaked:<version>:<id>`: it soaked on that version. */
export const FLEET_SOAKED_PREFIX = "fleet_soaked:";
/** `fleet_smoked:<version>:<id>`: the canary passed the smoke on that version. */
export const FLEET_SMOKED_PREFIX = "fleet_smoked:";
/** `fleet_smoke_fail:<version>:<check>`: the smoke's first transport failure. */
export const FLEET_SMOKE_FAIL_PREFIX = "fleet_smoke_fail:";
/** `fleet_smoke_halt:<version>:<check>`: the check whose failure halted it. */
export const FLEET_SMOKE_HALT_PREFIX = "fleet_smoke_halt:";
/** `fleet_smoke_config:<version>:<check>`: the smoke can't run as set up. */
export const FLEET_SMOKE_CONFIG_PREFIX = "fleet_smoke_config:";
/** `fleet_blocked:<version>`: when the duty first saw it as the target, the canary not soaked on it. */
export const FLEET_BLOCKED_PREFIX = "fleet_blocked:";
/** `fleet_retry:<id>`: it spent its one try while broken. Soaking clears it. */
export const FLEET_RETRY_PREFIX = "fleet_retry:";
/** `fleet_behind:<id>`: when the duty first saw it off the target. */
export const FLEET_BEHIND_PREFIX = "fleet_behind:";
/**
 * `fleet_done:<version>` (cloud #264): when a pass first found the rollout
 * finished: the canary settled and smoked, nothing open, every upgraded
 * install settled, and every install it waits for (eligible, busy or not) on
 * the version or above and idle: a busy install never counts as upgraded. Installs the
 * fleet leaves out (broken, suspended, paused, red-line) are not waited on;
 * version_skew reports them. Set once; the next prod deploy records it
 * (platform-db.ts fleet-done-all).
 */
export const FLEET_DONE_PREFIX = "fleet_done:";

/**
 * `platform_verified:<version>` (#1229): written by the platform deploy once
 * every Worker's read-back passed (scripts/ops/platform-verified.ts). A target
 * without it starts no fleet job.
 */
export const FLEET_VERIFIED_PREFIX = "platform_verified:";
/** `fleet_unverified:<version>`: when the duty first held for want of that mark. */
export const FLEET_UNVERIFIED_PREFIX = "fleet_unverified:";

const VERSIONED_PREFIXES = [
  FLEET_VERIFIED_PREFIX,
  FLEET_UNVERIFIED_PREFIX,
  FLEET_HALT_PREFIX,
  FLEET_FAIL_PREFIX,
  FLEET_PASS_PREFIX,
  FLEET_SOAKED_PREFIX,
  FLEET_BLOCKED_PREFIX,
  FLEET_SMOKED_PREFIX,
  FLEET_SMOKE_FAIL_PREFIX,
  FLEET_SMOKE_HALT_PREFIX,
  FLEET_SMOKE_CONFIG_PREFIX,
  FLEET_DONE_PREFIX,
] as const;

const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;

/** The platform's release: the version tag "vX.Y.Z" as "X.Y.Z", else null. */
export function fleetTarget(
  meta: Pick<WorkerVersionMetadata, "tag"> | undefined,
): string | null {
  return STABLE_TAG.exec(meta?.tag ?? "")?.[1] ?? null;
}

/** FLEET_CANARY when it is an install id, else null (no rollout). */
export const fleetCanary = (v: string | undefined): string | null => {
  const id = v?.trim() ?? "";
  return isInstallId(id) ? id : null;
};

/** A fleet upgrade's request id: one per install and target. */
export function fleetRequestId(installId: string, to: string): string {
  if (!isInstallId(installId) || !/^\d+\.\d+\.\d+$/.test(to))
    throw new Error("fleet request id: bad install id or version");
  return `fleet-${installId}-${to.replaceAll(".", "_")}`;
}

const haltKey = (v: string, id: string) => `${FLEET_HALT_PREFIX}${v}:${id}`;
const failKey = (v: string) => `${FLEET_FAIL_PREFIX}${v}`;
const passKey = (v: string, id: string) => `${FLEET_PASS_PREFIX}${v}:${id}`;
const soakedKey = (v: string, id: string) => `${FLEET_SOAKED_PREFIX}${v}:${id}`;
const blockedKey = (v: string) => `${FLEET_BLOCKED_PREFIX}${v}`;
const retryKey = (id: string) => `${FLEET_RETRY_PREFIX}${id}`;

const SYS = `'${SYSTEM_ACTOR.key}'`;
// Every fleet upgrade: request ids `fleet-…` (no LIKE wildcard in the prefix).
// `j` is the jobs alias.
const FLEET_UP = `j.actor_key = ${SYS} AND j.kind = 'upgrade' AND j.request_id LIKE 'fleet-%'`;
// A failure of the release: an operator's cancel, or the halt's own, is not.
const FAILED = `j.status = 'failed' AND COALESCE(j.error_code, '') <> 'canceled'`;
// What the duty may upgrade: active (not suspended, not upgrading), idle, test
// hooks off, and either serving and healthy or on its one try: on a halted
// version, or having halted one, with no try spent.
const ON_TRY = `(EXISTS (SELECT 1 FROM platform_state v WHERE v.key GLOB '${FLEET_HALT_PREFIX}' || version || ':*' OR v.key GLOB '${FLEET_HALT_PREFIX}*:' || install_id)
  AND NOT EXISTS (SELECT 1 FROM platform_state t WHERE t.key = '${FLEET_RETRY_PREFIX}' || install_id))`;
const ELIGIBLE = `state = 'active' AND install_state = 'active' AND active_job_id IS NULL AND COALESCE(test_hooks, 0) = 0 AND version IS NOT NULL AND ((serving_mode = 'serving' AND health = 'ok') OR ${ON_TRY})`;
// The installs a finished rollout waits for (cloud #264): ELIGIBLE, busy or
// not. A busy one can't be started now, but it is not upgraded either: it
// keeps fleet_done unwritten until it is on the target and idle.
const WAITED = `state = 'active' AND install_state = 'active' AND COALESCE(test_hooks, 0) = 0 AND version IS NOT NULL AND ((serving_mode = 'serving' AND health = 'ok') OR ${ON_TRY})`;
const UNFINISHED = `SELECT version, active_job_id FROM install_status WHERE ${WAITED} AND install_id <> ?2 AND (version <> ?1 OR active_job_id IS NOT NULL)`;
const CANARY = `SELECT install_id, version, app_host, state, install_state, serving_mode, active_job_id, test_hooks, health FROM install_status WHERE install_id = ?1`;
// The canary's latest upgrade to ?2, any actor.
const CANARY_JOB = `SELECT status, error_code FROM jobs WHERE install_id = ?1 AND kind = 'upgrade' AND json_extract(args, '$.to') = ?2 ORDER BY created_at DESC, id DESC LIMIT 1`;
const BEHIND = `SELECT install_id, version, serving_mode, health FROM install_status WHERE ${ELIGIBLE} AND version <> ?1 AND install_id <> ?2 ORDER BY created_at, install_id`;
const OPEN = `SELECT COUNT(*) AS n FROM jobs j WHERE ${FLEET_UP} AND j.status IN ('queued', 'running')`;
// The batch of version `to`, as SQL: every install a fleet upgrade to it
// reached, not yet soaked there. A canceled job counts if the install is on
// `to`: R25 can land after the version moved. Only soaking takes an install
// out, or the install going away. Suspended, paused, busy or rolled back, it
// still holds the next batch: a person acted on it, so nothing moves past it.
const BATCH = (to: string) =>
  `SELECT j.install_id AS install_id FROM jobs j JOIN install_status s ON s.install_id = j.install_id
WHERE ${FLEET_UP} AND json_extract(j.args, '$.to') = ${to}
  AND (j.status = 'done' OR (j.status = 'failed' AND j.error_code = 'canceled' AND s.version = ${to}))
  AND s.state NOT IN ('deleting', 'deleted')
  AND NOT EXISTS (SELECT 1 FROM platform_state p WHERE p.key = '${FLEET_SOAKED_PREFIX}' || ${to} || ':' || j.install_id)`;
const HELD = `${BATCH("?1")} LIMIT 1`;
// Every failed fleet upgrade, with the version it halts. A member held by a
// migration only a person may cross doesn't halt it: it stays behind, version_skew
// shows it, and the rollout carries on. The canary's hold (?1) still halts.
const HALT_JOBS = `SELECT j.install_id AS install_id, j.id AS job_id, j.kind AS job_kind, j.error_code AS code, substr(j.error_message, 1, 200) AS message, COALESCE(j.finished_at, j.updated_at) AS since, json_extract(j.args, '$.to') AS version
FROM jobs j WHERE ${FLEET_UP} AND ${FAILED} AND (COALESCE(j.error_code, '') <> 'migration_held' OR j.install_id = ?1)`;
// The fleet upgrade behind a mark, for the alert.
const MARK_JOB = `SELECT j.id AS id, j.kind AS kind FROM jobs j WHERE ${FLEET_UP} AND j.install_id = ?1 AND json_extract(j.args, '$.to') = ?2 LIMIT 1`;
const STATE = `SELECT key, value, updated_at FROM platform_state WHERE key GLOB 'fleet_*' OR key GLOB 'platform_verified:*'`;
// The watch: installs still on an upgrade to the target (?1) that is done,
// serving, active and idle, not yet soaked, on a version not halted. Only the
// target's, so it never outgrows a batch and old marks can go.
const WATCH = `SELECT j.install_id AS install_id, st.app_host AS app_host
FROM jobs j JOIN install_status st ON st.install_id = j.install_id
WHERE ${FLEET_UP} AND (j.status = 'done' OR (j.status = 'failed' AND j.error_code = 'canceled')) AND json_extract(j.args, '$.to') = ?1 AND st.version = ?1
  AND st.state = 'active' AND st.install_state = 'active' AND st.serving_mode = 'serving' AND st.active_job_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM platform_state p WHERE p.key = '${FLEET_SOAKED_PREFIX}' || ?1 || ':' || j.install_id)
  AND NOT EXISTS (SELECT 1 FROM platform_state p WHERE p.key GLOB '${FLEET_HALT_PREFIX}' || ?1 || ':*')
ORDER BY j.finished_at, j.install_id`;
const LAGGING = `SELECT install_id FROM install_status
WHERE state = 'active' AND serving_mode = 'serving' AND COALESCE(test_hooks, 0) = 0 AND version IS NOT NULL AND version <> ?1`;
// The insert's own checks, in the same statement, so nothing can change
// between them and the insert. ?9 is `from`; ?10, the args, holds the version.
const STILL_ON = `EXISTS (SELECT 1 FROM install_status WHERE install_id = ?3 AND ${ELIGIBLE} AND version = ?9)`;
const UNDER_CAP = `(SELECT COUNT(*) FROM jobs j WHERE ${FLEET_UP} AND j.status IN ('queued', 'running')) < ${FLEET_CONCURRENCY}`;
// A held job isn't a failure of the release here: on the canary, the tick's
// haltFailedJobs has already marked the version, and the first line stops it.
const NOT_HALTED = `NOT EXISTS (SELECT 1 FROM platform_state p WHERE p.key GLOB '${FLEET_HALT_PREFIX}' || json_extract(?10, '$.to') || ':*')
AND NOT EXISTS (SELECT 1 FROM jobs j WHERE ${FLEET_UP} AND ${FAILED} AND COALESCE(j.error_code, '') <> 'migration_held' AND json_extract(j.args, '$.to') = json_extract(?10, '$.to'))
AND NOT EXISTS (${BATCH("json_extract(?10, '$.to')")})`;
const SET_ONCE =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO NOTHING";
const SET_PASS =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";
const CLEAR = "DELETE FROM platform_state WHERE key = ?1";
// Both only for a new mark, so they run before the batch writes it.
const AUDIT = `INSERT INTO hosted_audit (at, actor, install_id, action, detail) SELECT ?1, '${SYSTEM_ACTOR.key}', ?2, 'fleet.halted', ?3 WHERE NOT EXISTS (SELECT 1 FROM platform_state WHERE key = ?4)`;
// A new halt owes an email, even while the alert is already open.
const OWE_EMAIL =
  "UPDATE platform_state SET value = 0 WHERE key = ?1 AND NOT EXISTS (SELECT 1 FROM platform_state WHERE key = ?2)";
// A started instance stops at its recheck (checkJob: the job is failed), so
// no terminate. Queued only: one already running finishes.
const CANCEL_QUEUED = `UPDATE jobs AS j SET status = 'failed', error_code = 'canceled', error_message = 'the fleet rollout of this version halted', finished_at = ?2, updated_at = ?2
WHERE ${FLEET_UP} AND j.status = 'queued' AND json_extract(j.args, '$.to') = ?1`;

interface CanaryRow {
  install_id: string;
  version: string | null;
  app_host: string | null;
  state: string;
  install_state: string | null;
  serving_mode: string | null;
  active_job_id: string | null;
  test_hooks: number | null;
  health: string | null;
}

interface Watched {
  install_id: string;
  app_host: string | null;
}

type HaltRow = Omit<AlertRow, "version"> & { version: string | null };

interface StateRow {
  key: string;
  value: number;
  updated_at: number;
}

/** The fleet's platform_state rows, kept current through the tick. */
interface FleetState {
  rows: Map<string, StateRow>;
  behind: Map<string, number>;
}

async function fleetState(db: D1Database): Promise<FleetState> {
  const { results } = await d1(db.prepare(STATE).all<StateRow>());
  const s: FleetState = { rows: new Map(), behind: new Map() };
  for (const r of results) {
    s.rows.set(r.key, r);
    if (r.key.startsWith(FLEET_BEHIND_PREFIX))
      s.behind.set(r.key.slice(FLEET_BEHIND_PREFIX.length), r.value);
  }
  return s;
}

/** A versioned key's version, or null for one that isn't. */
function versionOf(key: string): string | null {
  for (const p of VERSIONED_PREFIXES) {
    if (key.startsWith(p)) return key.slice(p.length).split(":")[0] ?? null;
  }
  return null;
}

const failedJobs = async (db: D1Database, canary: string | null) =>
  (await d1(db.prepare(HALT_JOBS).bind(canary).all<HaltRow>())).results;

/** Every halt: failed jobs, and marks with no failed job behind them. */
async function halts(
  db: D1Database,
  st: FleetState,
  canary: string | null,
): Promise<HaltRow[]> {
  const jobs = await failedJobs(db, canary);
  const fromJob = new Set(jobs.map((j) => `${j.version}:${j.install_id}`));
  const marks: HaltRow[] = [];
  for (const [key, r] of st.rows) {
    if (!key.startsWith(FLEET_HALT_PREFIX)) continue;
    const rest = key.slice(FLEET_HALT_PREFIX.length);
    const i = rest.indexOf(":");
    if (i <= 0 || fromJob.has(rest)) continue;
    const install = rest.slice(i + 1);
    const version = rest.slice(0, i);
    const job = await d1(
      db
        .prepare(MARK_JOB)
        .bind(install, version)
        .first<{ id: string; kind: string }>(),
    );
    // A smoke halt names its check (a fixed word), never a body.
    const check =
      install === canary
        ? smokeCheckOf(st, FLEET_SMOKE_HALT_PREFIX, version)
        : null;
    marks.push({
      install_id: install,
      job_id: job?.id ?? null,
      job_kind: job?.kind ?? null,
      code: check === null ? "fleet_halt" : "smoke_failed",
      message: check,
      since: r.value,
      version,
    });
  }
  return [...jobs, ...marks].sort(
    (a, b) =>
      a.since - b.since ||
      String(a.install_id).localeCompare(String(b.install_id)),
  );
}

/** The check named by a `<prefix><version>:<check>` key, if any. */
function smokeCheckOf(
  st: FleetState,
  prefix: string,
  version: string,
): string | null {
  for (const key of st.rows.keys())
    if (key.startsWith(`${prefix}${version}:`))
      return key.slice(`${prefix}${version}:`.length);
  return null;
}

/** Whether any install halted `version`, this tick's halts included. */
function isHalted(st: FleetState, version: string): boolean {
  for (const key of st.rows.keys())
    if (key.startsWith(`${FLEET_HALT_PREFIX}${version}:`)) return true;
  return false;
}

/** Whether this install has its one try: as ON_TRY, for what the tick read. */
function onTry(st: FleetState, id: string, version: string | null): boolean {
  if (st.rows.has(retryKey(id))) return false;
  if (version !== null && isHalted(st, version)) return true;
  for (const key of st.rows.keys())
    if (key.startsWith(FLEET_HALT_PREFIX) && key.endsWith(`:${id}`))
      return true;
  return false;
}

/**
 * Halts `version`, durably: the mark, the audit row, an owed email and the
 * cancel of what is queued for it, in one batch.
 */
async function halt(
  db: D1Database,
  now: number,
  st: FleetState,
  version: string,
  id: string,
): Promise<void> {
  const key = haltKey(version, id);
  await d1(
    db.batch([
      db.prepare(AUDIT).bind(now, id, JSON.stringify({ version }), key),
      db
        .prepare(OWE_EMAIL)
        .bind(alertStateKey("fleet_halted", "notified_at"), key),
      db.prepare(SET_ONCE).bind(key, now),
      db.prepare(CANCEL_QUEUED).bind(version, now),
    ]),
  );
  if (!st.rows.has(key)) st.rows.set(key, { key, value: now, updated_at: now });
  console.log("provapi fleet halted_by", id, version);
}

/** A failed fleet upgrade halts its version: its mark, once. */
async function haltFailedJobs(
  db: D1Database,
  now: number,
  st: FleetState,
  canary: string | null,
): Promise<void> {
  for (const j of await failedJobs(db, canary)) {
    if (typeof j.version !== "string" || typeof j.install_id !== "string")
      continue;
    if (!st.rows.has(haltKey(j.version, j.install_id)))
      await halt(db, now, st, j.version, j.install_id);
  }
}

/**
 * ok iff /healthz answers 200 with ok, this install's id, the version and
 * no test hooks. Never throws.
 */
export async function onTarget(
  probe: HealthProbe,
  id: string,
  appHost: string,
  version: string,
  timeoutMs = FLEET_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    return await within(
      (async () => {
        const res = await probe(id, appHost);
        if (res.status !== 200) {
          await res.body?.cancel();
          return false;
        }
        const j = (await res.json()) as Record<string, unknown> | null;
        return (
          j?.ok === true &&
          j.installId === id &&
          j.version === version &&
          j.testHooks === undefined
        );
      })(),
      timeoutMs,
    );
  } catch {
    return false;
  }
}

export interface FleetOptions {
  probe?: HealthProbe;
  timeoutMs?: number;
  /** Tests only: the pass's clock, for the time left to the smoke. */
  clock?: () => number;
  /** The ms left before the run's deadline; bounds the smoke. */
  left?: () => number;
  /** The run's deadline from its start (default FLEET_TICK_DEADLINE_MS). */
  deadlineMs?: number;
  /** Tests only: the canary smoke (default smoke() over fetch). */
  smoke?: (i: SmokeInput) => Promise<SmokeResult>;
}

/** The fleet duty's env: the smoke also reads the broker origin (a var). */
export type FleetEnv = ProvapiEnv & { AUTH_BROKER_ORIGIN?: string };

/**
 * What one pass left: "canary" while the canary's upgrade to the target is
 * open or done but not yet settled and smoked; "batch" while the rest's
 * upgrades are open or not yet settled; else "idle". Both only with the
 * smoke required: the smoke-off soak is a timer by design.
 */
export type FleetPass = "canary" | "batch" | "idle";

/**
 * One pass and what it needs next. again: only time can finish what is
 * left, so the run's message comes back with a backoff (wake.ts): a probe
 * that failed (the second, FLEET_FAIL_GAP_MS later, halts), a smoke that
 * neither passed nor halted, the release not yet in the catalog, a failed
 * insert. Not again: what is left ends with a job, and that job's end is
 * the next event (ManageInstall posts it).
 */
export interface FleetRun {
  pass: FleetPass;
  again: boolean;
}

/**
 * One fleet run: one pass under the lease, so two runs never act at once
 * (the 2-minute tick beside a wake, a message delivered twice). Without the
 * lease the run does nothing, logs `provapi fleet overlap` and returns null.
 * The lease is given back once the pass has ended, even past the run's
 * timeout. No waits: what is left is the next event's (FleetRun).
 */
export async function fleetTick(
  env: FleetEnv,
  now: number,
  o: FleetOptions = {},
): Promise<FleetRun | null> {
  const db = env.PLATFORM_DB;
  if (!(await d1(claimState(db, FLEET_LEASE_KEY, now, now - FLEET_LEASE_MS)))) {
    console.log("provapi fleet overlap");
    return null;
  }
  try {
    const clock = o.clock ?? Date.now;
    const deadline = clock() + (o.deadlineMs ?? FLEET_TICK_DEADLINE_MS);
    return await fleetPass(env, now, { ...o, left: () => deadline - clock() });
  } finally {
    // Only while it is still this run's: an expired lease taken by a later
    // run stays that run's.
    await unclaimState(db, FLEET_LEASE_KEY, now, null).catch(() =>
      console.error("provapi fleet lease_release_failed"),
    );
  }
}

/** One fleet pass: what it left (FleetPass). */
export async function fleetDue(
  env: FleetEnv,
  now: number,
  o: FleetOptions = {},
): Promise<FleetPass> {
  return (await fleetPass(env, now, o)).pass;
}

/** One fleet pass, and whether only time can finish what it left. */
export async function fleetPass(
  env: FleetEnv,
  now: number,
  o: FleetOptions = {},
): Promise<FleetRun> {
  const need: Need = { again: false };
  const pass = await onePass(env, now, o, need);
  return { pass, again: need.again };
}

/** Set by a pass when only time can finish what it left (FleetRun). */
interface Need {
  again: boolean;
}

async function onePass(
  env: FleetEnv,
  now: number,
  o: FleetOptions,
  need: Need,
): Promise<FleetPass> {
  const db = env.PLATFORM_DB;
  const probe = o.probe ?? publicRouteProbe;
  const ms = o.timeoutMs ?? FLEET_PROBE_TIMEOUT_MS;
  const target = fleetTarget(env.CF_VERSION_METADATA);
  const canaryId = fleetCanary(env.FLEET_CANARY);
  const st = await fleetState(db);

  await haltFailedJobs(db, now, st, canaryId);
  await prune(db, now, st, target);
  if (target === null) {
    // With a canary set, fleet_halted opens for it (fleetConditions).
    console.log("provapi fleet no_target");
    return "idle";
  }
  const canary =
    canaryId === null
      ? null
      : await d1(db.prepare(CANARY).bind(canaryId).first<CanaryRow>());
  // Runs with or without a canary: switching the rollout off never drops an
  // upgrade already made.
  const mode = fleetSmokeMode(env.FLEET_SMOKE);
  const hold = await watch(
    db,
    now,
    st,
    target,
    canary,
    probe,
    ms,
    mode === "off" ? fleetSoakOffMs(env.FLEET_SOAK_MIN) : FLEET_SOAK_MS,
    need,
  );
  if (canaryId === null) {
    console.log("provapi fleet no_canary");
    return "idle";
  }
  if (!(await verified(db, now, st, target))) {
    console.log("provapi fleet holding: platform not verified");
    return "idle";
  }
  await trackBehind(db, now, st, target);
  await trackCanary(db, now, st, target, canaryId, mode);
  if (isHalted(st, target)) {
    console.log("provapi fleet halted", target);
    return "idle";
  }
  // The canary mid-upgrade or just on the target: its upgrade's end, or a
  // repeated probe or smoke (need.again), moves it on. Only with the smoke
  // required: the smoke-off soak is a timer by design.
  const waiting = () =>
    mode === "required" && canaryPending(st, canary, target)
      ? "canary"
      : "idle";
  if (hold) {
    console.log("provapi fleet holding");
    // A batch member not yet settled: its job's end, or a repeated probe
    // (need.again), moves it on.
    const w = waiting();
    return w === "idle" && mode === "required" ? "batch" : w;
  }
  const manage = bound(env.MANAGE_INSTALL);

  const ready = await canaryReady(
    env,
    now,
    st,
    canary,
    target,
    manage,
    o,
    need,
  );
  if (!ready) {
    await stamp(db, now, st, target);
    // This pass may have just queued the canary's upgrade: read it again, so
    // the pass says so (cloud #264: the upgrade's end is the next event).
    if (mode !== "required") return "idle";
    const fresh = await d1(
      db.prepare(CANARY).bind(canaryId).first<CanaryRow>(),
    );
    return canaryPending(st, fresh, target) ? "canary" : "idle";
  }
  await clearBlocked(db, st);

  // Everything behind moves at once once the canary is ready (cloud #433);
  // the watch holds while any of them hasn't answered a healthy probe, so a
  // later batch (a fleet over the cap) waits for this one. The insert's
  // guards are what hold the cap and the halt.
  const open = await d1(db.prepare(OPEN).first<{ n: number }>());
  const settling = mode === "required" ? "batch" : "idle";
  if ((open?.n ?? 0) > 0) return settling;
  const { results } = await d1(
    db.prepare(BEHIND).bind(target, canaryId).all<{
      install_id: string;
      version: string;
      serving_mode: string | null;
      health: string | null;
    }>(),
  );
  let slots = FLEET_CONCURRENCY;
  let behind = 0;
  for (const r of results) {
    let below: boolean;
    try {
      below = compareVersions(r.version, target) < 0;
    } catch {
      continue;
    }
    if (!below) continue;
    behind++;
    if (slots <= 0) continue;
    const broken = r.serving_mode !== "serving" || r.health !== "ok";
    if (
      await upgrade(
        env,
        manage,
        now,
        r.install_id,
        r.version,
        target,
        broken,
        need,
      )
    )
      slots--;
  }
  if (behind > 0) return slots < FLEET_CONCURRENCY ? settling : "idle";
  // Done only when every install it waits for is on the target and idle: a
  // busy one (a settings job, say) still on the old version, or busy on the
  // new one, is not upgraded yet. Its job's end is the next event.
  const lagging = await d1(
    db.prepare(UNFINISHED).bind(target, canaryId).all<{
      version: string;
      active_job_id: string | null;
    }>(),
  );
  const waits = lagging.results.some((r) => {
    if (r.active_job_id !== null) return true;
    try {
      return compareVersions(r.version, target) < 0;
    } catch {
      return false;
    }
  });
  if (waits) return settling;
  await markDone(db, now, st, target);
  return "idle";
}

/**
 * The rollout of `target` is finished (FLEET_DONE_PREFIX): its mark, once,
 * and one log line the first time.
 */
async function markDone(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
): Promise<void> {
  const key = `${FLEET_DONE_PREFIX}${target}`;
  if (st.rows.has(key)) return;
  await d1(db.prepare(SET_ONCE).bind(key, now).run());
  st.rows.set(key, { key, value: now, updated_at: now });
  console.log("provapi fleet done", target);
}

/**
 * The fleet's alert marks, on every 2-minute tick (the alerts duty), so they
 * stay current where no tick runs the fleet (cloud #264, smoke required):
 * `fleet_unverified:` (platform_unverified) while the target has no verified
 * mark, then the blocked-canary clock and `fleet_behind:` stamps. The same
 * writes, under the same conditions, as a fleet pass makes, so an install
 * that falls behind or catches up between releases, and a deploy that never
 * marked its release verified, alert as before. Moves nothing: no job, no
 * probe, no lease.
 */
export async function fleetMarks(env: FleetEnv, now: number): Promise<void> {
  const target = fleetTarget(env.CF_VERSION_METADATA);
  const canary = fleetCanary(env.FLEET_CANARY);
  if (target === null || canary === null) return;
  const db = env.PLATFORM_DB;
  const st = await fleetState(db);
  if (!(await verified(db, now, st, target))) return;
  await trackBehind(db, now, st, target);
  if (
    fleetSmokeMode(env.FLEET_SMOKE) !== "required" ||
    st.rows.has(blockedKey(target)) ||
    isHalted(st, target) ||
    (st.rows.has(soakedKey(target, canary)) &&
      st.rows.has(smokedKey(target, canary)))
  )
    return;
  // A wake may settle or halt the canary after our read. Check its marks
  // in the insert so a late alert tick cannot restart a finished clock.
  await d1(
    db
      .prepare(
        `INSERT INTO platform_state (key, value, updated_at)
         SELECT ?1, ?2, ?2
         WHERE NOT EXISTS (SELECT 1 FROM platform_state WHERE key GLOB ?3)
           AND (SELECT COUNT(*) FROM platform_state WHERE key IN (?4, ?5)) < 2
         ON CONFLICT (key) DO NOTHING`,
      )
      .bind(
        blockedKey(target),
        now,
        `${FLEET_HALT_PREFIX}${target}:*`,
        soakedKey(target, canary),
        smokedKey(target, canary),
      )
      .run(),
  );
}

/**
 * The canary is on its way to the target and not yet settled and smoked
 * there: its upgrade is open, or it is on the target without both marks.
 */
function canaryPending(
  st: FleetState,
  canary: CanaryRow | null,
  target: string,
): boolean {
  if (canary === null || canary.version === null) return false;
  const id = canary.install_id;
  if (canary.active_job_id !== null) return true;
  if (canary.version !== target) return false;
  return (
    !st.rows.has(soakedKey(target, id)) || !st.rows.has(smokedKey(target, id))
  );
}

/**
 * The clock of canary_blocked: from when the duty first saw a target the canary
 * hasn't soaked on, whatever the reason, and again if a soaked canary can't
 * lead. It stops only once the canary is ready, or the target halted
 * (fleet_halted says so itself). An older stamp stays, so a release shipped
 * during a block doesn't read as an all-clear.
 */
async function trackCanary(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
  canaryId: string,
  mode: SmokeMode,
): Promise<void> {
  if (isHalted(st, target)) await clearBlocked(db, st);
  else if (
    !st.rows.has(soakedKey(target, canaryId)) ||
    (mode === "required" && !st.rows.has(smokedKey(target, canaryId)))
  )
    await stamp(db, now, st, target);
}

async function stamp(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
): Promise<void> {
  const key = blockedKey(target);
  if (st.rows.has(key)) return;
  await d1(db.prepare(SET_ONCE).bind(key, now).run());
  st.rows.set(key, { key, value: now, updated_at: now });
}

/**
 * True once the deploy marked the target verified (#1229), and the first-seen
 * stamp of a hold is gone. Unmarked, the stamp is set once.
 */
async function verified(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
): Promise<boolean> {
  const stampKey = `${FLEET_UNVERIFIED_PREFIX}${target}`;
  if (st.rows.has(`${FLEET_VERIFIED_PREFIX}${target}`)) {
    for (const k of [...st.rows.keys()])
      if (k.startsWith(FLEET_UNVERIFIED_PREFIX)) {
        await d1(db.prepare(CLEAR).bind(k).run());
        st.rows.delete(k);
      }
    return true;
  }
  if (!st.rows.has(stampKey)) {
    await d1(db.prepare(SET_ONCE).bind(stampKey, now).run());
    st.rows.set(stampKey, { key: stampKey, value: now, updated_at: now });
  }
  return false;
}

async function clearBlocked(db: D1Database, st: FleetState): Promise<void> {
  for (const k of [...st.rows.keys()])
    if (k.startsWith(FLEET_BLOCKED_PREFIX)) {
      await d1(db.prepare(CLEAR).bind(k).run());
      st.rows.delete(k);
    }
}

/** Moves the canary toward the target; true once it has soaked there. */
async function canaryReady(
  env: FleetEnv,
  now: number,
  st: FleetState,
  canary: CanaryRow | null,
  target: string,
  manage: NonNullable<ProvapiEnv["MANAGE_INSTALL"]>,
  o: FleetOptions,
  need: Need,
): Promise<boolean> {
  const db = env.PLATFORM_DB;
  const stuck = (why: string) => {
    console.log("provapi fleet canary_blocked", why);
    return false;
  };
  if (
    canary?.state !== "active" ||
    (canary.test_hooks ?? 0) !== 0 ||
    canary.version === null ||
    canary.app_host === null
  )
    return stuck("unavailable");
  const id = canary.install_id;
  const exempt = onTry(st, id, canary.version);
  if (canary.serving_mode !== "serving" && !exempt) return stuck("unavailable");
  const last = await d1(
    db
      .prepare(CANARY_JOB)
      .bind(id, target)
      .first<{ status: string; error_code: string | null }>(),
  );
  const openJob = last?.status === "queued" || last?.status === "running";
  if (canary.install_state !== "active" || canary.active_job_id !== null) {
    if (!openJob) return stuck("busy");
    console.log("provapi fleet canary_busy");
    return false;
  }
  let c: number;
  try {
    c = compareVersions(canary.version, target);
  } catch {
    return stuck("bad_version");
  }
  if (c > 0) return stuck("off_target");
  if (c < 0 && canary.health !== "ok" && !exempt) return stuck("unhealthy");
  if (!(await published(env, target))) {
    // The catalog may not have it yet: only time tells.
    need.again = true;
    return false;
  }
  if (c < 0) {
    const broken = canary.serving_mode !== "serving" || canary.health !== "ok";
    await upgrade(env, manage, now, id, canary.version, target, broken, need);
    return false;
  }
  // On the target, its upgrade (if it had one) done and not just written. A
  // cancel landed after the version moved: it soaked, so it counts.
  if (
    last !== null &&
    last.status !== "done" &&
    last.error_code !== "canceled"
  ) {
    console.log("provapi fleet canary_not_done");
    return false;
  }
  if (!st.rows.has(soakedKey(target, id))) return false;
  // FLEET_SMOKE "off": the soak alone, as before the smoke.
  if (fleetSmokeMode(env.FLEET_SMOKE) === "off") return true;
  if (st.rows.has(smokedKey(target, id))) return true;
  return await smokeCanary(env, now, st, canary, target, o, need);
}

const smokedKey = (v: string, id: string) => `${FLEET_SMOKED_PREFIX}${v}:${id}`;

/** Deletes every key with `prefix` + version + ":". */
async function clearFor(
  db: D1Database,
  st: FleetState,
  prefix: string,
  v: string,
): Promise<void> {
  for (const k of [...st.rows.keys()])
    if (k.startsWith(`${prefix}${v}:`)) {
      await d1(db.prepare(CLEAR).bind(k).run());
      st.rows.delete(k);
    }
}

async function setOnce(
  db: D1Database,
  st: FleetState,
  key: string,
  now: number,
): Promise<void> {
  if (st.rows.has(key)) return;
  await d1(db.prepare(SET_ONCE).bind(key, now).run());
  st.rows.set(key, { key, value: now, updated_at: now });
}

/**
 * One canary smoke (smoke.ts) on a settled canary; true once it passed. Only
 * check names and kinds are logged or stored: never the token, a body or an
 * address.
 */
async function smokeCanary(
  env: FleetEnv,
  now: number,
  st: FleetState,
  canary: CanaryRow,
  target: string,
  o: FleetOptions,
  need: Need,
): Promise<boolean> {
  const db = env.PLATFORM_DB;
  const id = canary.install_id;
  // Only the run's time left, its cleanup aside: too little for one call and
  // the smoke waits for the next pass. Neither a pass nor a fail.
  const budgetMs =
    o.left === undefined
      ? SMOKE_BUDGET_MS
      : Math.min(SMOKE_BUDGET_MS, o.left() - FLEET_SMOKE_CLEANUP_MS);
  if (budgetMs < SMOKE_CALL_MS) {
    console.log("provapi fleet smoke deferred");
    need.again = true;
    return false;
  }
  const r = await (o.smoke ?? smoke)({
    budgetMs,
    fetch: (url, init) => fetch(url, init),
    installId: id,
    appHost: canary.app_host ?? "",
    token: env.FLEET_SMOKE_TOKEN,
    shareTo: env.FLEET_SMOKE_SHARE_TO,
    // Only "off" skips the share check; unset or anything else runs it.
    share: env.FLEET_SMOKE_SHARE?.trim() !== "off",
    // Likewise only "off" skips the bus check (#1299).
    bus: env.FLEET_SMOKE_BUS?.trim() !== "off",
    brokerOrigin: env.AUTH_BROKER_ORIGIN,
    version: target,
  });
  if (r.ok) {
    await clearFor(db, st, FLEET_SMOKE_CONFIG_PREFIX, target);
    await setOnce(db, st, smokedKey(target, id), now);
    console.log("provapi fleet smoke passed", id, target, ...r.notes);
    return true;
  }
  console.log("provapi fleet smoke", r.kind, r.check);
  if (r.kind === "budget") {
    need.again = true;
    return false;
  }
  if (r.kind === "config") {
    await clearFor(db, st, FLEET_SMOKE_CONFIG_PREFIX, target);
    await setOnce(
      db,
      st,
      `${FLEET_SMOKE_CONFIG_PREFIX}${target}:${r.check}`,
      now,
    );
    return false;
  }
  await clearFor(db, st, FLEET_SMOKE_CONFIG_PREFIX, target);
  if (r.kind === "transport") {
    // The first counts; a second FLEET_FAIL_GAP_MS later halts, as probes do.
    const first = [...st.rows.values()].find((x) =>
      x.key.startsWith(`${FLEET_SMOKE_FAIL_PREFIX}${target}:`),
    );
    if (first === undefined || now - first.value < FLEET_FAIL_GAP_MS) {
      await setOnce(
        db,
        st,
        `${FLEET_SMOKE_FAIL_PREFIX}${target}:${r.check}`,
        now,
      );
      // Once more later: a pass, or the second failure that halts.
      need.again = true;
      return false;
    }
  }
  // Named before the halt, so the alert row can say which check.
  await setOnce(db, st, `${FLEET_SMOKE_HALT_PREFIX}${target}:${r.check}`, now);
  await halt(db, now, st, target, id);
  return false;
}

/**
 * The target is in the release catalog, installable as a release: else no
 * fleet job is queued this tick (a job would fail release_not_published and
 * halt the rollout for good). Logged, never thrown.
 */
async function published(env: ProvapiEnv, target: string): Promise<boolean> {
  try {
    const [r] = await within(
      Promise.resolve().then(() =>
        bound(env.PROVISIONER).releases({ version: target }),
      ),
      5_000,
    );
    if (
      r?.version === target &&
      r.installable &&
      r.variants.includes("release")
    )
      return true;
    console.log("provapi fleet release_unpublished", target);
  } catch (e) {
    console.error("provapi fleet release_unknown", dutyCategory(e));
  }
  return false;
}

/**
 * Queues and starts one fleet upgrade; true once inserted (a failed start
 * leaves it queued, the sweep starts it, and it still counts).
 */
async function upgrade(
  env: ProvapiEnv,
  manage: NonNullable<ProvapiEnv["MANAGE_INSTALL"]>,
  now: number,
  installId: string,
  from: string,
  to: string,
  broken = false,
  need?: Need,
): Promise<boolean> {
  let id: string | null;
  try {
    id = await insertSystemJob(
      env.PLATFORM_DB,
      {
        kind: "upgrade",
        installId,
        signupId: null,
        parentJobId: null,
        requestId: fleetRequestId(installId, to),
        args: { from, to },
      },
      now,
      {
        sql: `${STILL_ON} AND ${UNDER_CAP} AND ${NOT_HALTED}`,
        params: [from],
      },
    );
  } catch (e) {
    console.error("provapi fleet install_failed", dutyCategory(e), installId);
    if (need) need.again = true;
    return false;
  }
  // null: already queued for this target, at the cap, halted, held by the
  // last batch, or not eligible.
  if (id === null) {
    const by = await env.PLATFORM_DB.prepare(HELD)
      .bind(to)
      .first<{ install_id: string }>()
      .catch(() => null);
    if (by) console.log(`provapi fleet held by ${by.install_id}`);
    return false;
  }
  if (broken)
    await d1(
      env.PLATFORM_DB.prepare(SET_ONCE).bind(retryKey(installId), now).run(),
    ).catch(() => console.error("provapi fleet retry_mark_failed", installId));
  console.log("provapi fleet upgrade queued", installId, id, `to=${to}`);
  try {
    await startJob(manage, id);
  } catch (e) {
    console.error("provapi fleet start_failed", dutyCategory(e), installId);
  }
  return true;
}

/**
 * Probes every unsoaked install on the target at once, each bounded by its
 * own timeout. A batch at most, so no probe waits on another. True while any
 * of them holds the next one back.
 */
async function watch(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
  canary: CanaryRow | null,
  probe: HealthProbe,
  ms: number,
  soakMs: number,
  need: Need,
): Promise<boolean> {
  const { results } = await d1(db.prepare(WATCH).bind(target).all<Watched>());
  const all = [...results];
  // A canary already on the target with no fleet upgrade soaks all the same.
  if (
    canary !== null &&
    canary.version === target &&
    canary.state === "active" &&
    canary.install_state === "active" &&
    canary.serving_mode === "serving" &&
    canary.active_job_id === null &&
    (canary.test_hooks ?? 0) === 0 &&
    !st.rows.has(soakedKey(target, canary.install_id)) &&
    !isHalted(st, target) &&
    !all.some((r) => r.install_id === canary.install_id)
  )
    all.push({ install_id: canary.install_id, app_host: canary.app_host });
  const verdicts = await Promise.all(
    all.map((r) =>
      r.app_host === null
        ? false
        : onTarget(probe, r.install_id, r.app_host, target, ms),
    ),
  );
  let hold = false;
  for (const [i, r] of all.entries()) {
    try {
      const soaked = verdicts[i]
        ? await passed(db, now, st, target, r.install_id, soakMs)
        : await failed(db, now, st, target, r.install_id);
      if (!soaked) hold = true;
      // A failed probe that didn't halt: probe again later. A passing one
      // still soaking (smoke off) is the soak's timer, not an event's.
      if (!verdicts[i] && !soaked) need.again = true;
    } catch (e) {
      hold = true;
      need.again = true;
      console.error(
        "provapi fleet watch_failed",
        dutyCategory(e),
        r.install_id,
      );
    }
  }
  return hold;
}

/** One passing probe; true once the install has soaked. */
async function passed(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
  id: string,
  soakMs: number,
): Promise<boolean> {
  const key = passKey(target, id);
  const prev = st.rows.get(key);
  const unbroken = prev && now - prev.updated_at <= FLEET_SOAK_GAP_MS;
  const start = unbroken ? prev.value : now;
  if (now - start < soakMs) {
    await d1(db.prepare(SET_PASS).bind(key, start, now).run());
    st.rows.set(key, { key, value: start, updated_at: now });
    return false;
  }
  const done = soakedKey(target, id);
  await d1(
    db.batch([
      db.prepare(SET_ONCE).bind(done, now),
      db.prepare(CLEAR).bind(key),
      db.prepare(CLEAR).bind(retryKey(id)),
    ]),
  );
  st.rows.set(done, { key: done, value: now, updated_at: now });
  st.rows.delete(key);
  st.rows.delete(retryKey(id));
  console.log("provapi fleet soaked", id, target);
  return true;
}

/**
 * One failed probe of the version. The first restarts this install's soak and
 * stays; one FLEET_FAIL_GAP_MS later or more, on any install, halts the version. True then: a
 * halted version holds nothing back.
 */
async function failed(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
  id: string,
): Promise<boolean> {
  const key = failKey(target);
  const first = st.rows.get(key);
  if (first !== undefined && now - first.value >= FLEET_FAIL_GAP_MS) {
    await halt(db, now, st, target, id);
    return true;
  }
  await d1(
    db.batch([
      db.prepare(SET_ONCE).bind(key, now),
      db.prepare(CLEAR).bind(passKey(target, id)),
    ]),
  );
  if (first === undefined)
    st.rows.set(key, { key, value: now, updated_at: now });
  st.rows.delete(passKey(target, id));
  console.log("provapi fleet unhealthy", id);
  return false;
}

/** Stamps when each lagging install was first seen off; clears the rest. */
async function trackBehind(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string,
): Promise<void> {
  const { results } = await d1(
    db.prepare(LAGGING).bind(target).all<{ install_id: string }>(),
  );
  const lagging = new Set(results.map((r) => r.install_id));
  for (const id of lagging)
    if (!st.behind.has(id))
      await d1(
        db.prepare(SET_ONCE).bind(`${FLEET_BEHIND_PREFIX}${id}`, now).run(),
      );
  for (const id of st.behind.keys())
    if (!lagging.has(id))
      await d1(db.prepare(CLEAR).bind(`${FLEET_BEHIND_PREFIX}${id}`).run());
}

/**
 * Drops marks of versions below the target past FLEET_KEEP_MS. The watch and
 * the insert only ever read the target's. Never with no target: what is
 * current is then unknown, and a resumed rollout would go onto a halted
 * version.
 */
async function prune(
  db: D1Database,
  now: number,
  st: FleetState,
  target: string | null,
): Promise<void> {
  if (target === null) return;
  for (const [key, r] of st.rows) {
    const v = versionOf(key);
    if (v === null || r.value >= now - FLEET_KEEP_MS) continue;
    let older: boolean;
    try {
      older = compareVersions(v, target) < 0;
    } catch {
      continue;
    }
    if (!older) continue;
    await d1(db.prepare(CLEAR).bind(key).run());
    st.rows.delete(key);
  }
}

/** A row's version and the install's fleet upgrade to it, if it had one. */
async function named(db: D1Database, id: string, version: string | null) {
  if (version === null) return {};
  const job = await d1(
    db
      .prepare(MARK_JOB)
      .bind(id, version)
      .first<{ id: string; kind: string }>(),
  );
  return { version, job_id: job?.id ?? null, job_kind: job?.kind ?? null };
}

const isHeld = async (db: D1Database, target: string) =>
  (await d1(db.prepare(HELD).bind(target).first())) !== null;

/**
 * fleet_halted and version_skew for this tick.
 * - fleet_halted: halts on the target (smoke_failed when the canary smoke
 *   halted it), any halt on another version in the last FLEET_HALT_ALERT_MS,
 *   a canary not settled and smoked on the target fleetBlockedMs after the
 *   duty first saw it (canary_blocked), a smoke that can't run as set up
 *   (smoke_unconfigured), and a canary set with no target (no_target).
 * - version_skew: installs first seen off FLEET_SKEW_MS ago. Unknown with no
 *   canary or no target, so it never sends a false all-clear.
 */
export async function fleetConditions(
  env: Pick<
    ProvapiEnv,
    | "PLATFORM_DB"
    | "CF_VERSION_METADATA"
    | "FLEET_CANARY"
    | "FLEET_SMOKE"
    | "FLEET_SOAK_MIN"
  >,
  now: number,
): Promise<{ fleet_halted: Condition; version_skew: Condition }> {
  const unknown: Condition = { open: null, rows: [] };
  const db = env.PLATFORM_DB;
  const target = fleetTarget(env.CF_VERSION_METADATA);
  const canary = fleetCanary(env.FLEET_CANARY);
  let st: FleetState;
  try {
    st = await fleetState(db);
  } catch {
    console.error("provapi alert fleet query_error");
    return { fleet_halted: unknown, version_skew: unknown };
  }
  const row = (
    o: Partial<AlertRow> & { since: number; code: string },
  ): AlertRow => ({
    install_id: null,
    job_id: null,
    job_kind: null,
    message: null,
    ...o,
  });
  let fleet_halted: Condition;
  try {
    const rows: AlertRow[] = (await halts(db, st, canary))
      .filter(
        (h) =>
          (target !== null && h.version === target) ||
          h.since >= now - FLEET_HALT_ALERT_MS,
      )
      .map((r) => ({ ...r, version: r.version ?? undefined }));
    const stamps = [...st.rows.values()]
      .filter((r) => r.key.startsWith(FLEET_BLOCKED_PREFIX))
      .map((r) => r.value);
    const since = stamps.length > 0 ? Math.min(...stamps) : null;
    const unconfigured =
      canary !== null &&
      target !== null &&
      fleetSmokeMode(env.FLEET_SMOKE) === "required"
        ? smokeCheckOf(st, FLEET_SMOKE_CONFIG_PREFIX, target)
        : null;
    if (unconfigured !== null)
      rows.push(
        row({
          install_id: canary,
          code: "smoke_unconfigured",
          message: unconfigured,
          since:
            st.rows.get(`${FLEET_SMOKE_CONFIG_PREFIX}${target}:${unconfigured}`)
              ?.value ?? now,
        }),
      );
    const unverifiedAt =
      canary !== null &&
      target !== null &&
      !st.rows.has(`${FLEET_VERIFIED_PREFIX}${target}`)
        ? st.rows.get(`${FLEET_UNVERIFIED_PREFIX}${target}`)?.value
        : undefined;
    if (
      target !== null &&
      unverifiedAt !== undefined &&
      now - unverifiedAt >= FLEET_BLOCKED_MS
    )
      rows.push(
        row({
          install_id: canary,
          code: "platform_unverified",
          since: unverifiedAt,
          version: target,
        }),
      );
    if (canary !== null && since !== null && now - since >= fleetBlockedMs(env))
      rows.push(
        row({
          install_id: canary,
          code: "canary_blocked",
          since,
          ...(await named(db, canary, target)),
        }),
      );
    if (canary !== null && target === null)
      rows.push(row({ code: "no_target", since: now }));
    // Nothing to report, but a batch still unsoaked: no all-clear yet.
    const held =
      rows.length === 0 && target !== null && (await isHeld(db, target));
    fleet_halted = held ? unknown : { open: rows.length > 0, rows };
  } catch {
    console.error("provapi alert fleet query_error");
    fleet_halted = unknown;
  }
  if (canary === null || target === null)
    return { fleet_halted, version_skew: unknown };
  const rows: AlertRow[] = [];
  for (const [id, at] of st.behind)
    if (now - at >= FLEET_SKEW_MS)
      rows.push(
        row({
          install_id: id,
          code: "behind",
          since: at,
          ...(await named(db, id, target)),
        }),
      );
  return { fleet_halted, version_skew: { open: rows.length > 0, rows } };
}
