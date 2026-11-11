import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { run } from "./billing-db.ts";
import { loadMigrations } from "./platform-db.ts";

// billing-db.ts (the billing target's migrations) against a local SQLite
// standing in for D1: every pinned file applied once, in order, each recorded
// with its pin in the same request, then read back.
const root = join(import.meta.dirname, "../..");
const DIR = join(root, "apps/billing/migrations");
const LOCK = join(root, "apps/billing/migration-lock.json");
const migrations = loadMigrations(DIR, LOCK);
const names = migrations.map((m) => m.name);

const fakeDb = (sqlite = new DatabaseSync(":memory:")) => {
  const execs: string[] = [];
  return {
    sqlite,
    execs,
    db: {
      all: async (sql: string, params?: SQLInputValue[]) =>
        sqlite.prepare(sql).all(...(params ?? [])),
      exec: async (sql: string) => {
        execs.push(sql);
        sqlite.exec(sql);
      },
    },
  };
};
const go = async (
  f: ReturnType<typeof fakeDb>,
  o: { verifyOnly?: boolean; migrations?: typeof migrations } = {},
) => {
  const log: string[] = [];
  try {
    await run({
      db: f.db,
      migrations: o.migrations ?? migrations,
      verifyOnly: Boolean(o.verifyOnly),
      now: () => 1_700_000_000_000,
      log: (s) => log.push(s),
    });
    return { ok: true, log, err: "" };
  } catch (e) {
    return { ok: false, log, err: (e as Error).message };
  }
};
const tracked = (f: ReturnType<typeof fakeDb>) =>
  f.sqlite
    .prepare("SELECT name, sha256 FROM billing_migrations ORDER BY name")
    .all() as { name: string; sha256: string }[];

describe("billing-db.ts", () => {
  it("the repo's lock is frozen and pins every file (the wrapper refuses a deploy otherwise)", () => {
    expect(names).toEqual([
      "0001_init.sql",
      "0002_solo_tier.sql",
      "0003_solo_checked_out.sql",
      "0004_test_clock.sql",
      "0005_usage_applied.sql",
    ]);
  });

  it("a fresh database: every file applied in order, each with its tracker row in the same request, then read back", async () => {
    const f = fakeDb();
    const r = await go(f);
    expect(r.err).toBe("");
    expect(r.log).toEqual([
      "0001_init.sql applied",
      "0002_solo_tier.sql applied",
      "0003_solo_checked_out.sql applied",
      "0004_test_clock.sql applied",
      "0005_usage_applied.sql applied",
      "5 migrations tracked, tables present",
    ]);
    expect(tracked(f)).toEqual(
      migrations.map((m) => ({ name: m.name, sha256: m.sha256 })),
    );
    // Tracker creation, then one request per file carrying its own record.
    expect(f.execs).toHaveLength(6);
    for (const [i, m] of migrations.entries()) {
      const e = f.execs[i + 1] as string;
      expect(e).toContain(m.sql.trimEnd());
      expect(e).toContain(
        `INSERT INTO billing_migrations (name, sha256, applied_at) VALUES ('${m.name}', '${m.sha256}', 1700000000000)`,
      );
    }
    // 0002 left tiers able to hold solo.
    f.sqlite.exec(
      "INSERT INTO tiers (install_id, tier, status, updated_at) VALUES ('i1', 'solo', 'active', 0)",
    );
  });

  it("a rerun on a migrated database changes nothing", async () => {
    const f = fakeDb();
    await go(f);
    const before = JSON.stringify(tracked(f));
    f.execs.length = 0;
    const r = await go(f);
    expect(r.ok, r.err).toBe(true);
    expect(r.log).toEqual(["5 migrations tracked, tables present"]);
    expect(f.execs).toEqual([
      expect.stringContaining("CREATE TABLE IF NOT EXISTS billing_migrations"),
    ]);
    expect(JSON.stringify(tracked(f))).toBe(before);
  });

  it("a file added later is applied alone; the earlier ones are not run again", async () => {
    const f = fakeDb();
    await go(f, { migrations: migrations.slice(0, 1) });
    // 0002 on top of a database that has only 0001 and its record.
    const r = await go(f);
    expect(r.log[0]).toBe("0002_solo_tier.sql applied");
    expect(tracked(f).map((t) => t.name)).toEqual(names);
  });

  it("verify only: reads only; passes on a migrated database, fails while a file is pending", async () => {
    const f = fakeDb();
    // No tracker yet: not "pending", an accurate message, and still a refusal.
    const none = await go(f, { verifyOnly: true });
    expect(none.ok).toBe(false);
    expect(none.err).toContain(
      "billing_migrations tracker is missing or unreadable",
    );
    expect(none.err).not.toContain("pending");
    expect(f.execs).toEqual([]);
    // A tracker that is behind: that is pending.
    await go(f, { migrations: migrations.slice(0, 1) });
    f.execs.length = 0;
    const pend = await go(f, { verifyOnly: true });
    expect(pend.ok).toBe(false);
    expect(pend.err).toContain(
      "0002_solo_tier.sql, 0003_solo_checked_out.sql, 0004_test_clock.sql, 0005_usage_applied.sql pending (verify only)",
    );
    expect(f.execs).toEqual([]);
    await go(f);
    f.execs.length = 0;
    expect((await go(f, { verifyOnly: true })).ok).toBe(true);
    expect(f.execs).toEqual([]);
  });

  it("a tracker row that isn't its pin, isn't pinned or isn't a prefix stops the run before any file", async () => {
    for (const [why, rows, want] of [
      ["wrong sha", [["0001_init.sql", "f".repeat(64)]], "is not its pin"],
      ["not pinned", [["0009_x.sql", "a"]], "is not pinned"],
      [
        "a gap",
        [["0002_solo_tier.sql", migrations[1]?.sha256 as string]],
        "not a prefix",
      ],
    ] as const) {
      const f = fakeDb();
      f.sqlite.exec(
        "CREATE TABLE billing_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)",
      );
      for (const [n, s] of rows)
        f.sqlite
          .prepare("INSERT INTO billing_migrations VALUES (?, ?, 0)")
          .run(n, s);
      const r = await go(f);
      expect(r.ok, why).toBe(false);
      expect(r.err, why).toContain(want);
      expect(
        f.execs.filter((e) => e.includes("INSERT INTO billing_migrations")),
        why,
      ).toEqual([]);
    }
  });

  it("a file that fails to apply records nothing (the request carries its record, so it fails whole)", async () => {
    const f = fakeDb();
    const bad = [
      migrations[0] as (typeof migrations)[number],
      {
        name: "0002_solo_tier.sql",
        sql: "CREATE TABLE nope (",
        sha256: "a".repeat(64),
      },
    ];
    const r = await go(f, { migrations: bad });
    expect(r.ok).toBe(false);
    expect(tracked(f).map((t) => t.name)).toEqual(["0001_init.sql"]);
  });

  it("the script refuses before any call: not staging, no token, a bad account or database id, no main lock", () => {
    const base = {
      PATH: process.env.PATH ?? "",
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "26ac346086d4405f7a976d48747a2a75",
      BILLING_DB_ID: "6ca9103e-507e-4541-b3bb-2485e699512b",
      MAIN_BILLING_MIGRATION_LOCK: LOCK,
    };
    const exec = (arg: string, env: Record<string, string>) =>
      spawnSync(
        "node",
        [
          "--experimental-strip-types",
          "--no-warnings",
          join(root, "scripts/ops/billing-db.ts"),
          arg,
        ],
        { env, encoding: "utf8" },
      );
    expect(exec("prod", base).status).toBe(2);
    expect(exec("staging", { ...base, CLOUDFLARE_API_TOKEN: "" }).status).toBe(
      2,
    );
    expect(
      exec("staging", { ...base, CLOUDFLARE_ACCOUNT_ID: "x" }).status,
    ).toBe(2);
    expect(exec("staging", { ...base, BILLING_DB_ID: "x" }).status).toBe(2);
    expect(
      exec("staging", { ...base, MAIN_BILLING_MIGRATION_LOCK: "" }).status,
    ).toBe(2);
  });
});
