#!/usr/bin/env node
// The billing target's migrations (deploy-hosted-platform.sh, staging only):
// brings oa-s-billing up to every pinned migration in apps/billing, and reads
// it back. The platform-db runner's rules, for a database that never had a
// legacy schema:
//   1. The lock holds (check-migration-lock.mjs): frozen, every file pinned and
//      unchanged; and every pin on main's lock (MAIN_BILLING_MIGRATION_LOCK) is
//      the tag's too: a tag may add a migration, never edit one and re-pin it.
//   2. Tracker billing_migrations (name, sha256, applied_at), created if absent.
//      Its rows must be a prefix of the pinned files, each with its pin.
//   3. Each pinned file the tracker lacks, in order: the file and its tracker
//      row go in ONE request (one D1 batch), so a run that stops cannot leave a
//      file applied and unrecorded. (A migration here is not IF NOT EXISTS: it
//      is applied once.)
//   4. Read back: the tracker lists every pinned file with its pin, and the
//      tables the files build exist.
// VERIFY_ONLY=1 reads and compares only, and fails while a file is pending.
// The token goes in a request header, never argv, and is never printed.
// Usage: CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID BILLING_DB_ID
//   MAIN_BILLING_MIGRATION_LOCK [VERIFY_ONLY]  node scripts/ops/billing-db.ts staging
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Db,
  d1,
  loadMigrations,
  type Migration,
  pinDrift,
  Refused,
} from "./platform-db.ts";

export { Refused };

const TRACKER_SQL =
  "CREATE TABLE IF NOT EXISTS billing_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)";
/** What the pinned files build (read back). */
const TABLES = ["tiers", "stripe_events", "usage", "pending_cancels"];
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

export async function run(o: {
  db: Db;
  migrations: Migration[];
  verifyOnly: boolean;
  now: () => number;
  log: (s: string) => void;
}): Promise<void> {
  const { db, migrations, verifyOnly, log } = o;
  const pins = new Map(migrations.map((m) => [m.name, m.sha256]));
  // The tracker: created first (it holds no data); verify only never writes.
  if (!verifyOnly) await db.exec(TRACKER_SQL);
  let tracked: { name: string; sha256: string }[];
  try {
    tracked = (
      await db.all("SELECT name, sha256 FROM billing_migrations ORDER BY name")
    ).map((r) => ({ name: String(r.name), sha256: String(r.sha256) }));
  } catch {
    if (!verifyOnly) throw new Refused("the tracker can't be read");
    tracked = [];
  }
  tracked.forEach((r, i) => {
    if (!pins.has(r.name))
      throw new Refused(`the tracker lists ${r.name}, which is not pinned`);
    if (migrations[i]?.name !== r.name)
      throw new Refused(`the tracker is not a prefix of the pinned files`);
    if (pins.get(r.name) !== r.sha256)
      throw new Refused(`the tracker's sha256 for ${r.name} is not its pin`);
  });
  const pending = migrations.slice(tracked.length);
  if (verifyOnly && pending.length)
    throw new Refused(
      `${pending.map((m) => m.name).join(", ")} pending (verify only)`,
    );
  for (const m of pending) {
    // File and tracker row in one request.
    await db.exec(
      `${m.sql.trimEnd()}\nINSERT INTO billing_migrations (name, sha256, applied_at) VALUES (${quote(m.name)}, ${quote(m.sha256)}, ${Math.trunc(o.now())});`,
    );
    log(`${m.name} applied`);
  }
  const after = (
    await db.all("SELECT name, sha256 FROM billing_migrations ORDER BY name")
  ).map((r) => `${r.name}:${r.sha256}`);
  const want = migrations.map((m) => `${m.name}:${m.sha256}`);
  if (after.join(",") !== want.join(","))
    throw new Refused(
      "the tracker does not list every pinned file after the run",
    );
  const live = new Set(
    (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map(
      (r) => String(r.name),
    ),
  );
  const missing = TABLES.filter((t) => !live.has(t));
  if (missing.length)
    throw new Refused(`read back: ${missing.join(", ")} missing`);
  log(`${migrations.length} migrations tracked, tables present`);
}

// Run as a script (paths compared after symlinks).
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const fail = (msg: string, code = 1): never => {
    console.error(msg);
    process.exit(code);
  };
  if (process.argv[2] !== "staging") fail("usage: billing-db.ts staging", 2);
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, BILLING_DB_ID } =
    process.env;
  if (!CLOUDFLARE_API_TOKEN) fail("CLOUDFLARE_API_TOKEN is required", 2);
  if (!/^[0-9a-f]{32}$/.test(CLOUDFLARE_ACCOUNT_ID ?? ""))
    fail("CLOUDFLARE_ACCOUNT_ID must be 32 hex", 2);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      BILLING_DB_ID ?? "",
    )
  )
    fail("BILLING_DB_ID must be a uuid", 2);
  const mainLock = process.env.MAIN_BILLING_MIGRATION_LOCK;
  if (!mainLock)
    fail(
      "MAIN_BILLING_MIGRATION_LOCK (main's migration-lock.json) is required",
      2,
    );
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const lockFile = join(root, "apps/billing/migration-lock.json");
  try {
    const drift = pinDrift(mainLock as string, lockFile);
    if (drift.length) throw new Refused(drift.join("; "));
    await run({
      db: d1({
        token: CLOUDFLARE_API_TOKEN as string,
        accountId: CLOUDFLARE_ACCOUNT_ID as string,
        databaseId: BILLING_DB_ID as string,
      }),
      migrations: loadMigrations(
        join(root, "apps/billing/migrations"),
        lockFile,
      ),
      verifyOnly: Boolean(process.env.VERIFY_ONLY),
      now: () => Date.now(),
      log: (s) => console.log(`oa-s-billing: ${s}`),
    });
  } catch (e) {
    fail(
      `oa-s-billing: ${e instanceof Refused ? e.message : "failed"}; refusing`,
    );
  }
}
