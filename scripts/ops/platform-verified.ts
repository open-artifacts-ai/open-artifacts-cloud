#!/usr/bin/env node
// The platform_verified mark (#1229): once every platform Worker's read-back
// has passed (`platform-tags.sh`, after the scheduler deployed), the deploy
// writes platform_state `platform_verified:<version>` on oa-<p>-platform. The
// scheduler's fleet duty starts no job for a target without it. A rerun keeps
// the first time. The token goes in a request header, never argv, and is never
// printed; the log names the mark and nothing else (no counts).
// Usage: CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID PLATFORM_DB_ID
//   node scripts/ops/platform-verified.ts staging|prod vX.Y.Z
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, d1, Refused } from "./platform-db.ts";

const STABLE = /^v(\d+\.\d+\.\d+)$/;

export async function markVerified({
  db,
  tag,
  now,
  log,
}: {
  db: Db;
  tag: string;
  now: () => number;
  log: (s: string) => void;
}): Promise<void> {
  const m = STABLE.exec(tag);
  if (!m) throw new Refused("tag must be a stable vX.Y.Z");
  const key = `platform_verified:${m[1]}`;
  const t = now();
  await db.all(
    "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO NOTHING",
    [key, t],
  );
  const back = await db.all("SELECT value FROM platform_state WHERE key = ?1", [
    key,
  ]);
  if (back.length !== 1 || typeof back[0]?.value !== "number")
    throw new Refused("read back: the mark is not there");
  log(`${key} written`);
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const [env, tag] = process.argv.slice(2);
  const fail = (msg: string, code = 1): never => {
    console.error(msg);
    process.exit(code);
  };
  if ((env !== "staging" && env !== "prod") || !tag)
    fail("usage: platform-verified.ts staging|prod vX.Y.Z", 2);
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, PLATFORM_DB_ID } =
    process.env;
  if (!CLOUDFLARE_API_TOKEN) fail("CLOUDFLARE_API_TOKEN is required", 2);
  if (!/^[0-9a-f]{32}$/.test(CLOUDFLARE_ACCOUNT_ID ?? ""))
    fail("CLOUDFLARE_ACCOUNT_ID must be 32 hex", 2);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      PLATFORM_DB_ID ?? "",
    )
  )
    fail("PLATFORM_DB_ID must be a uuid", 2);
  try {
    await markVerified({
      db: d1({
        token: CLOUDFLARE_API_TOKEN as string,
        accountId: CLOUDFLARE_ACCOUNT_ID as string,
        databaseId: PLATFORM_DB_ID as string,
      }),
      tag: tag as string,
      now: () => Date.now(),
      log: (s) => console.log(`oa-${env?.[0]}-platform: ${s}`),
    });
  } catch (e) {
    fail(
      `oa-${env?.[0]}-platform: ${e instanceof Refused ? e.message : "failed"}; refusing`,
    );
  }
}
