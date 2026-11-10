import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  FLEET_VERIFIED_PREFIX,
  fleetTarget,
} from "../../apps/scheduler/src/provapi/fleet.ts";
import {
  d1,
  loadMigrations,
  markVerified,
  pinDrift,
  Refused,
  run,
  unmarkVerified,
} from "./platform-db.ts";

// platform-db.ts (design v7 8.4) against a local SQLite standing in for D1:
// bootstrap by schema, the shape check before any record, apply in order,
// read back; verify only reads.
const root = join(import.meta.dirname, "../..");
const DIR = join(root, "apps/platform-db/migrations");
const LOCK = join(root, "apps/platform-db/migration-lock.json");
type M = { name: string; sql: string; sha256: string };
const migrations: M[] = loadMigrations(DIR, LOCK);
const names = migrations.map((m) => m.name);

// A fake D1: every call logged, so the tests can see what ran and in what order.
const fakeDb = (sqlite = new DatabaseSync(":memory:")) => {
  const calls: string[] = [];
  return {
    sqlite,
    calls,
    db: {
      all: async (sql: string, params?: SQLInputValue[]) => {
        calls.push(`all ${sql}`);
        return sqlite.prepare(sql).all(...(params ?? []));
      },
      exec: async (sql: string) => {
        calls.push(`exec ${sql.slice(0, 60)}`);
        sqlite.exec(sql);
      },
    },
  };
};
const applied = (n: number) => {
  const f = fakeDb();
  for (const m of migrations.slice(0, n)) f.sqlite.exec(m.sql);
  return f;
};
const go = async (
  f: ReturnType<typeof fakeDb>,
  opts: { verifyOnly?: boolean; upTo?: number } = {},
) => {
  const log: string[] = [];
  try {
    await run({
      db: f.db,
      migrations: migrations.slice(0, opts.upTo ?? migrations.length),
      verifyOnly: Boolean(opts.verifyOnly),
      now: () => 1_700_000_000_000,
      log: (s: string) => log.push(s),
    });
    return { ok: true, log, err: "" };
  } catch (e) {
    return { ok: false, log, err: (e as Error).message };
  }
};
const tracker = (f: ReturnType<typeof fakeDb>) =>
  f.sqlite
    .prepare(
      "SELECT name, sha256, applied_at FROM platform_migrations ORDER BY name",
    )
    .all();
const writes = (f: ReturnType<typeof fakeDb>) =>
  f.calls.filter((c) => c.startsWith("exec") || c.includes("INSERT"));

// #859's 0007 signups shape (as packages/provision's schema test pins it).
const SIGNUPS_859 = `CREATE TABLE signups (
  signup_id TEXT NOT NULL PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  slug TEXT NOT NULL,
  install_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','queued','waiting_cap','creating','ready','failed')),
  admitted_at INTEGER,
  welcome_claimed_at INTEGER,
  welcome_sent_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE signup_secret (signup_id TEXT NOT NULL PRIMARY KEY, owner_email TEXT NOT NULL);
CREATE INDEX signups_admitted_at ON signups (admitted_at);`;

describe("platform-db.ts", () => {
  it("a fresh database: every file applied in order, each recorded with its pin, then read back", async () => {
    const f = fakeDb();
    const r = await go(f);
    expect(r.err).toBe("");
    expect(r.ok).toBe(true);
    expect(r.log).toEqual([
      ...names.map((n) => `${n}: applied`),
      `${names.length} migrations tracked, shapes match`,
    ]);
    expect(tracker(f)).toEqual(
      migrations.map((m) => ({
        name: m.name,
        sha256: m.sha256,
        applied_at: 1_700_000_000_000,
      })),
    );
  });

  it("today's envs (0001-0005, no tracker): records 0001-0005 by schema, applies 0006-0008", async () => {
    const f = applied(5);
    const r = await go(f);
    expect(r.err).toBe("");
    expect(r.log).toEqual([
      ...names.slice(0, 5).map((n) => `${n}: present, recorded`),
      ...names.slice(5).map((n) => `${n}: applied`),
      `${names.length} migrations tracked, shapes match`,
    ]);
    // 0001-0005 never run again (0004 and 0005 are not re-runnable).
    const execs = f.calls.filter((c) => c.startsWith("exec"));
    // The tracker, then 0006 onward.
    expect(execs).toHaveLength(1 + names.slice(5).length);
    expect(execs[0]).toContain("CREATE TABLE IF NOT EXISTS platform_migrat");
  });

  // Prod's oa-p-platform before its first platform-db run: 0001-0005 applied
  // by hand (docs/ops/hosted.md), no tracker, plus D1's _cf_KV and wrangler's
  // d1_migrations (with sqlite_sequence). Table set as read: _cf_KV,
  // d1_migrations, hosted_audit, hosts, install_versions, installs,
  // release_floor, sqlite_sequence. detect() compares object names (tables,
  // triggers, indexes) and column names only; _cf_*, sqlite_* and
  // d1_migrations are skipped, so d1_migrations' rows never matter.
  describe("prod's legacy pre-tracker schema", () => {
    const legacy = (n: number, d1Rows: string[] = names.slice(0, n)) => {
      const f = applied(n);
      f.sqlite.exec(
        "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID",
      );
      f.sqlite.exec(
        "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
      );
      for (const r of d1Rows)
        f.sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(r);
      return f;
    };
    const tables = (f: ReturnType<typeof fakeDb>) =>
      f.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
    const PROD_TABLES = [
      "_cf_KV",
      "d1_migrations",
      "hosted_audit",
      "hosts",
      "install_versions",
      "installs",
      "release_floor",
      "sqlite_sequence",
    ];
    const adopted = (n: number) => [
      ...names.slice(0, n).map((x) => `${x}: present, recorded`),
      ...names.slice(n).map((x) => `${x}: applied`),
      `${names.length} migrations tracked, shapes match`,
    ];

    it("0001-0005 (any d1_migrations rows): records 0001-0005, applies 0006 onward", async () => {
      for (const rows of [names.slice(0, 5), [], ["0001_installs.sql"]]) {
        const f = legacy(5, rows);
        expect(tables(f)).toEqual(PROD_TABLES);
        const r = await go(f);
        expect(r.err).toBe("");
        expect(r.log).toEqual(adopted(5));
        // d1_migrations is left as it was.
        expect(
          f.sqlite.prepare("SELECT name FROM d1_migrations").all(),
        ).toHaveLength(rows.length);
      }
    });

    it("prod's exact DDL as read on 2026-11-01: 0001-0005 recorded, 0006 onward applied, a second run changes nothing", async () => {
      const f = fakeDb();
      f.sqlite.exec(
        readFileSync(
          join(
            import.meta.dirname,
            "testdata/prod-oa-p-platform-2026-11-01.sql",
          ),
          "utf8",
        ),
      );
      expect(tables(f)).toEqual(PROD_TABLES);
      const r = await go(f);
      expect(r.err).toBe("");
      expect(r.log).toEqual(adopted(5));
      // The tables the inventory reads exist now (#1041).
      for (const t of [
        "platform_migrations",
        "install_lifecycle",
        "platform_state",
      ])
        expect(tables(f), t).toContain(t);
      const again = await go(f);
      expect(again.err).toBe("");
      expect(again.log.at(-1)).toBe(
        `${names.length} migrations tracked, shapes match`,
      );
      expect(again.log.some((l) => l.endsWith(": applied"))).toBe(false);
    });

    it("0001-0003 or 0001-0004 (same table set): records the prefix, applies the rest", async () => {
      for (const n of [3, 4]) {
        const f = legacy(n);
        expect(tables(f)).toEqual(PROD_TABLES);
        const r = await go(f);
        expect(r.err).toBe("");
        expect(r.log).toEqual(adopted(n));
      }
    });

    it("an extra legacy column on installs is not compared: adopted", async () => {
      const f = legacy(5);
      f.sqlite.exec("ALTER TABLE installs ADD COLUMN legacy_note TEXT");
      const r = await go(f);
      expect(r.err).toBe("");
      expect(r.log).toEqual(adopted(5));
    });

    it("refuses, before any write: 0005 without 0004, a missing trigger, 0005's index missing", async () => {
      const no0004 = legacy(3);
      no0004.sqlite.exec((migrations[4] as M).sql);
      const a = await go(no0004);
      expect(a.err).toBe(
        "0005_directory_revoke.sql is applied but 0004_audit_actor.sql is not; refusing",
      );
      expect(writes(no0004)).toEqual([]);

      const noTrigger = legacy(5);
      noTrigger.sqlite.exec("DROP TRIGGER hosted_audit_no_delete");
      const b = await go(noTrigger);
      expect(b.err).toBe(
        "0001_installs.sql is only partly applied (4 of 5 of its objects); fix it by hand, then rerun",
      );
      expect(writes(noTrigger)).toEqual([]);

      const noIndex = legacy(5);
      noIndex.sqlite.exec("DROP INDEX installs_revoke_pending");
      const c = await go(noIndex);
      expect(c.err).toBe(
        "0005_directory_revoke.sql is only partly applied (4 of 5 of its objects); fix it by hand, then rerun",
      );
      expect(writes(noIndex)).toEqual([]);
    });
  });

  it("refuses #859's hand-applied signups shape before recording anything", async () => {
    const f = applied(6);
    f.sqlite.exec(SIGNUPS_859);
    const r = await go(f);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("the live schema differs from the migrations");
    expect(r.err).toContain("signups has columns");
    expect(r.err).toContain("add a new numbered migration");
    expect(writes(f)).toEqual([]);
    expect(
      f.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'platform_migrations'",
        )
        .all(),
    ).toEqual([]);
  });

  it("refuses an index of the same name with other columns", async () => {
    const f = applied(6);
    f.sqlite.exec(
      migrations[6]?.sql.replace(
        "ON signups (source, admitted_at)",
        "ON signups (admitted_at)",
      ) as string,
    );
    const r = await go(f);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("index signups_admitted_at on signups is");
    expect(writes(f)).toEqual([]);
  });

  it("refuses a partial index with another WHERE, and a view with another body", async () => {
    const idx = applied(6);
    idx.sqlite.exec(
      migrations[6]?.sql.replace(
        "WHERE status <> 'failed'",
        "WHERE status = 'ready'",
      ) as string,
    );
    const r = await go(idx);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("signups_live_slug is");
    expect(writes(idx)).toEqual([]);
    // The same columns, another body: only the sql tells them apart.
    const view = applied(7);
    const body = "ORDER BY created_at DESC, id DESC LIMIT 1)";
    expect(migrations[7]?.sql).toContain(body);
    view.sqlite.exec(
      migrations[7]?.sql.replace(
        body,
        "ORDER BY created_at ASC, id DESC LIMIT 1)",
      ) as string,
    );
    const v = await go(view);
    expect(v.ok).toBe(false);
    expect(v.err).toContain("install_status is");
    expect(writes(view)).toEqual([]);
  });

  it("a run stopped between applying 0001-0005 and recording them converges: the tracker lists 0001-0002, the schema has 0001-0005", async () => {
    const f = fakeDb();
    // A fresh env: 0008's tracker, 0001-0005 applied, only 0001-0002 recorded.
    const ddl =
      /CREATE TABLE IF NOT EXISTS platform_migrations \([^;]*\);/.exec(
        migrations[7]?.sql as string,
      )?.[0] as string;
    f.sqlite.exec(ddl);
    for (const m of migrations.slice(0, 5)) f.sqlite.exec(m.sql);
    for (const m of migrations.slice(0, 2))
      f.sqlite
        .prepare(
          "INSERT INTO platform_migrations (name, sha256, applied_at) VALUES (?, ?, 1)",
        )
        .run(m.name, m.sha256);
    const r = await go(f);
    expect(r.err).toBe("");
    expect(r.log).toEqual([
      ...names.slice(2, 5).map((n) => `${n}: present, recorded`),
      ...names.slice(5).map((n) => `${n}: applied`),
      `${names.length} migrations tracked, shapes match`,
    ]);
    // 0003-0005 (ADD COLUMN) never run again.
    expect(f.calls.filter((c) => c.startsWith("exec"))).toHaveLength(
      names.slice(5).length,
    );
    expect(tracker(f)).toHaveLength(names.length);
    // The tracker lists 0001-0003 and 0004 is absent: 0004 onward applied.
    const g = fakeDb();
    g.sqlite.exec(ddl);
    for (const m of migrations.slice(0, 3)) {
      g.sqlite.exec(m.sql);
      g.sqlite
        .prepare(
          "INSERT INTO platform_migrations (name, sha256, applied_at) VALUES (?, ?, 1)",
        )
        .run(m.name, m.sha256);
    }
    const r2 = await go(g);
    expect(r2.err).toBe("");
    expect(r2.log.slice(0, 2)).toEqual([
      `${names[3]}: applied`,
      `${names[4]}: applied`,
    ]);
  });

  it("a hand-applied 0006 and 0007 with the right shape are recorded, not refused", async () => {
    const f = applied(7);
    const r = await go(f);
    expect(r.err).toBe("");
    expect(tracker(f)).toHaveLength(names.length);
  });

  it("refuses a 0001-0005 file that is only partly there, or a gap", async () => {
    const partial = applied(4);
    partial.sqlite.exec(
      "ALTER TABLE installs ADD COLUMN directory_revoke TEXT",
    );
    const r = await go(partial);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("0005_directory_revoke.sql is only partly applied");
    expect(writes(partial)).toEqual([]);

    const gap = fakeDb();
    for (const m of [0, 2].map((i) => migrations[i] as M))
      gap.sqlite.exec(m.sql);
    const g = await go(gap);
    expect(g.ok).toBe(false);
    expect(g.err).toMatch(/0003_lifecycle\.sql is applied but 0002_/);
    expect(writes(gap)).toEqual([]);
  });

  it("a tracker row that isn't its pin, isn't pinned or isn't a prefix stops the run", async () => {
    for (const [name, sha] of [
      [names[0], "0".repeat(64)],
      ["0099_rogue.sql", "0".repeat(64)],
      [names[1], migrations[1]?.sha256],
    ]) {
      const f = applied(8);
      f.sqlite
        .prepare("INSERT INTO platform_migrations VALUES (?, ?, 1)")
        .run(name as string, sha as string);
      const r = await go(f);
      expect(r.ok, name).toBe(false);
      expect(r.err, name).toMatch(/tracker/);
      expect(writes(f).filter((c) => c.includes("INSERT"))).toEqual([]);
    }
  });

  it("a rerun on a migrated database changes nothing", async () => {
    const f = fakeDb();
    await go(f);
    f.calls.length = 0;
    const r = await go(f);
    expect(r.err).toBe("");
    expect(r.log).toEqual([`${names.length} migrations tracked, shapes match`]);
    expect(writes(f)).toEqual([]);
  });

  // v0.89.0: 0009 (ALTER TABLE jobs) was refused before it ran, as the check
  // compared the live jobs table with its shape after 0009.
  const tracked = migrations.findIndex((m) =>
    m.sql.includes("platform_migrations"),
  );
  it.each(names.slice(tracked, -1).map((n, i) => [n, tracked + i + 1]))(
    "a database tracked up to %s applies every later file, ALTER TABLE ones too",
    async (_n, k) => {
      const f = fakeDb();
      expect((await go(f, { upTo: k })).err).toBe("");
      const r = await go(f);
      expect(r.err).toBe("");
      expect(r.log).toEqual([
        ...names.slice(k).map((n) => `${n}: applied`),
        `${names.length} migrations tracked, shapes match`,
      ]);
    },
  );

  it("refuses a pending ALTER TABLE file already applied by hand, before any write", async () => {
    const f = fakeDb();
    expect((await go(f, { upTo: 8 })).err).toBe("");
    f.sqlite.exec(migrations[8]?.sql ?? "");
    f.calls.length = 0;
    const r = await go(f);
    expect(r.err).toContain("the live schema differs from the migrations");
    expect(r.err).toContain("jobs has columns");
    expect(writes(f)).toEqual([]);
  });

  it("refuses an extra live column on a tracked table while a file is pending", async () => {
    const f = fakeDb();
    expect((await go(f, { upTo: 8 })).err).toBe("");
    f.sqlite.exec("ALTER TABLE jobs ADD COLUMN extra TEXT");
    f.calls.length = 0;
    const r = await go(f);
    expect(r.err).toContain("jobs has columns");
    expect(writes(f)).toEqual([]);
  });

  it("verify only: reads only; passes on a migrated database, fails while a file is pending", async () => {
    const done = fakeDb();
    await go(done);
    done.calls.length = 0;
    const ok = await go(done, { verifyOnly: true });
    expect(ok.err).toBe("");
    expect(writes(done)).toEqual([]);

    const old = applied(5);
    const r = await go(old, { verifyOnly: true });
    expect(r.ok).toBe(false);
    expect(r.err).toContain("not migrated");
    expect(writes(old)).toEqual([]);
  });

  it("fails the read-back when an object is gone after the run", async () => {
    const f = fakeDb();
    const real = f.db.exec;
    f.db.exec = async (sql: string) => {
      await real(sql);
      if (sql.includes("CREATE VIEW IF NOT EXISTS install_status"))
        f.sqlite.exec("DROP VIEW install_status");
    };
    const r = await go(f);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("read back: install_status is missing");
  });

  it("refuses a lock that doesn't hold", () => {
    expect(() => loadMigrations(DIR, "/nonexistent/lock.json")).toThrow(
      /missing or not JSON/,
    );
  });

  it("d1: the token only in the header; a failed statement or call throws", async () => {
    const TOKEN = "tok-SHOULD-NEVER-APPEAR";
    const seen: { url: string; init: RequestInit }[] = [];
    const answer =
      (body: unknown) => async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify(body));
      };
    const ok = d1({
      token: TOKEN,
      accountId: "a".repeat(32),
      databaseId: "db",
      fetch: answer({
        success: true,
        result: [{ success: true, results: [{ x: 1 }] }],
      }),
    });
    expect(await ok.all("SELECT 1 AS x", [1])).toEqual([{ x: 1 }]);
    expect(seen[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/d1/database/db/query`,
    );
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({
      sql: "SELECT 1 AS x",
      params: [1],
    });
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    for (const body of [
      { success: false, errors: [{ code: 7500 }] },
      { success: true, result: [{ success: false }] },
    ]) {
      const bad = d1({
        token: TOKEN,
        accountId: "a".repeat(32),
        databaseId: "db",
        fetch: answer(body),
      });
      await expect(bad.exec("x")).rejects.toThrow(/D1 query failed/);
      await expect(bad.exec("x")).rejects.not.toThrow(TOKEN);
    }
  });

  describe("main's lock against the tag's (pinDrift)", () => {
    /** A tag's tree: the repo's migrations and lock, then `edit` applied. */
    const tagTree = (
      edit: (dir: string, lock: Record<string, string>) => void,
    ) => {
      const t = mkdtempSync(join(tmpdir(), "oa-tag-db-"));
      cpSync(DIR, join(t, "migrations"), { recursive: true });
      const lock = JSON.parse(readFileSync(LOCK, "utf8"));
      edit(join(t, "migrations"), lock.pins);
      writeFileSync(join(t, "lock.json"), JSON.stringify(lock));
      return { dir: join(t, "migrations"), lock: join(t, "lock.json") };
    };
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    it("refuses an edited pinned migration whose pin the tag updated (its own lock holds)", () => {
      const t = tagTree((dir, pins) => {
        const f = join(dir, "0007_signups.sql");
        const sql = `${readFileSync(f, "utf8")}\n-- edited\n`;
        writeFileSync(f, sql);
        pins["0007_signups.sql"] = sha(sql);
      });
      // The tag's own lock vouches for the edit...
      expect(() => loadMigrations(t.dir, t.lock)).not.toThrow();
      // ...main's doesn't.
      expect(pinDrift(LOCK, t.lock)).toEqual([
        "0007_signups.sql's pin differs from main's (an edited migration)",
      ]);
    });
    it("refuses a pin main has that the tag dropped", () => {
      const t = tagTree((_, pins) => {
        delete pins["0008_provisioning.sql"];
      });
      expect(pinDrift(LOCK, t.lock)).toEqual([
        "0008_provisioning.sql is pinned on main, not in the tag",
      ]);
    });
    it("accepts a new migration the tag pins", () => {
      const t = tagTree((dir, pins) => {
        const sql = "CREATE TABLE IF NOT EXISTS x (id TEXT PRIMARY KEY);\n";
        writeFileSync(join(dir, "0009_x.sql"), sql);
        pins["0009_x.sql"] = sha(sql);
      });
      expect(() => loadMigrations(t.dir, t.lock)).not.toThrow();
      expect(pinDrift(LOCK, t.lock)).toEqual([]);
      expect(pinDrift(LOCK, LOCK)).toEqual([]);
    });
    it("refuses a lock it can't read", () => {
      expect(() => pinDrift("/nonexistent/lock.json", LOCK)).toThrow(
        "main's migration lock is missing or not JSON",
      );
      const t = tagTree(() => {});
      writeFileSync(t.lock, "{}");
      expect(() => pinDrift(LOCK, t.lock)).toThrow(
        "the tag's migration lock has no pins",
      );
    });
  });

  it("the CLI refuses a bad env or missing inputs before any call", () => {
    const cli = (args: string[], env: Record<string, string>) =>
      spawnSync(
        "node",
        [
          "--experimental-strip-types",
          "--no-warnings",
          join(import.meta.dirname, "platform-db.ts"),
          ...args,
        ],
        {
          env: { PATH: process.env.PATH as string, ...env },
          encoding: "utf8",
        },
      );
    const ok = {
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      PLATFORM_DB_ID: "6ca9103e-507e-4541-b3bb-2485e699512b",
      MAIN_MIGRATION_LOCK: LOCK,
    };
    expect(cli(["dev"], ok).status).toBe(2);
    expect(cli(["prod"], { ...ok, MAIN_MIGRATION_LOCK: "" }).status).toBe(2);
    // main pins a file the tag re-pinned: refused before any call to D1.
    const main = join(
      mkdtempSync(join(tmpdir(), "oa-main-lock-")),
      "lock.json",
    );
    const lock = JSON.parse(readFileSync(LOCK, "utf8"));
    lock.pins["0007_signups.sql"] = "0".repeat(64);
    writeFileSync(main, JSON.stringify(lock));
    const drift = cli(["prod"], { ...ok, MAIN_MIGRATION_LOCK: main });
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain(
      "0007_signups.sql's pin differs from main's (an edited migration); refusing",
    );
    expect(cli(["prod"], { ...ok, PLATFORM_DB_ID: "x" }).status).toBe(2);
    expect(cli(["prod"], { ...ok, CLOUDFLARE_API_TOKEN: "" }).status).toBe(2);
  });

  it("the CLI never prints the token", () => {
    const src = readFileSync(
      join(import.meta.dirname, "platform-db.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/console\.\w+\([^)]*TOKEN/);
  });

  // #1229: the deploy's mark that every Worker's read-back passed.
  describe("the platform_verified mark", () => {
    const stateDb = () => {
      const sqlite = new DatabaseSync(":memory:");
      sqlite.exec(
        "CREATE TABLE platform_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      );
      let failures = 0;
      const sleeps: number[] = [];
      return {
        sqlite,
        sleeps,
        failNext: (n: number) => {
          failures = n;
        },
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        db: {
          all: async (sql: string, params?: SQLInputValue[]) => {
            if (failures > 0) {
              failures--;
              throw new Refused("D1 query failed: network error");
            }
            return sqlite.prepare(sql).all(...(params ?? []));
          },
          exec: async (sql: string) => sqlite.exec(sql),
        },
      };
    };
    const keys = (s: DatabaseSync) =>
      s.prepare("SELECT key, value FROM platform_state ORDER BY key").all();

    it("writes the key the scheduler reads, and logs no counts", async () => {
      const f = stateDb();
      const log: string[] = [];
      await markVerified({
        db: f.db,
        tag: "v0.150.0",
        now: () => 1_000,
        sleep: f.sleep,
        log: (s) => log.push(s),
      });
      const target = fleetTarget({ tag: "v0.150.0" });
      expect(keys(f.sqlite)).toEqual([
        { key: `${FLEET_VERIFIED_PREFIX}${target}`, value: 1_000 },
      ]);
      expect(log).toEqual(["platform_verified:0.150.0 written"]);
    });

    it("a rerun keeps the first time", async () => {
      const f = stateDb();
      for (const t of [1_000, 2_000])
        await markVerified({
          db: f.db,
          tag: "v0.150.0",
          now: () => t,
          sleep: f.sleep,
          log: () => {},
        });
      expect(keys(f.sqlite)).toEqual([
        { key: "platform_verified:0.150.0", value: 1_000 },
      ]);
    });

    it("refuses a tag that is not a stable release", async () => {
      const f = stateDb();
      for (const tag of ["0.150.0", "v0.150", "v0.150.0-rc.1", ""])
        await expect(
          markVerified({
            db: f.db,
            tag,
            now: () => 1,
            sleep: f.sleep,
            log: () => {},
          }),
        ).rejects.toThrow(/stable/);
      expect(keys(f.sqlite)).toEqual([]);
    });

    it("retries D1 errors (3 attempts, 1 s then 2 s), then fails", async () => {
      const f = stateDb();
      f.failNext(2);
      await markVerified({
        db: f.db,
        tag: "v0.150.0",
        now: () => 1,
        sleep: f.sleep,
        log: () => {},
      });
      expect(f.sleeps).toEqual([1_000, 2_000]);
      expect(keys(f.sqlite)).toHaveLength(1);
      const g = stateDb();
      g.failNext(3);
      await expect(
        markVerified({
          db: g.db,
          tag: "v0.150.0",
          now: () => 1,
          sleep: g.sleep,
          log: () => {},
        }),
      ).rejects.toThrow(/D1 query failed/);
      expect(g.sleeps).toEqual([1_000, 2_000]);
      expect(keys(g.sqlite)).toEqual([]);
    });

    it("fails when the read-back finds no row", async () => {
      const f = stateDb();
      const db = {
        ...f.db,
        all: async (sql: string) => (sql.startsWith("SELECT") ? [] : []),
      };
      await expect(
        markVerified({
          db,
          tag: "v0.150.0",
          now: () => 1,
          sleep: f.sleep,
          log: () => {},
        }),
      ).rejects.toThrow(/read back/);
    });

    it("unmark deletes every platform_verified key and nothing else, with retries", async () => {
      const f = stateDb();
      f.sqlite.exec(
        "INSERT INTO platform_state VALUES ('platform_verified:0.1.0',1,1),('platform_verified:0.2.0',1,1),('fleet_halt:0.1.0:x',1,1)",
      );
      f.failNext(1);
      const log: string[] = [];
      await unmarkVerified({
        db: f.db,
        sleep: f.sleep,
        log: (s) => log.push(s),
      });
      expect(keys(f.sqlite)).toEqual([{ key: "fleet_halt:0.1.0:x", value: 1 }]);
      expect(f.sleeps).toEqual([1_000]);
      expect(log).toEqual(["platform_verified marks cleared"]);
    });

    it("the CLI modes refuse bad usage before any call, and never print the token", () => {
      const cli = (args: string[], env: Record<string, string>) =>
        spawnSync(
          "node",
          [
            "--experimental-strip-types",
            "--no-warnings",
            join(import.meta.dirname, "platform-db.ts"),
            ...args,
          ],
          {
            env: { PATH: process.env.PATH as string, ...env },
            encoding: "utf8",
          },
        );
      const ok = {
        CLOUDFLARE_API_TOKEN: "tok-secret-1",
        CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
        PLATFORM_DB_ID: "6ca9103e-507e-4541-b3bb-2485e699512b",
      };
      for (const args of [
        ["mark-verified", "dev", "v1.2.3"],
        ["mark-verified", "prod"],
        ["unmark-verified", "dev"],
      ]) {
        const r = cli(args, ok);
        expect(r.status, args.join(" ")).toBe(2);
        expect(r.stdout + r.stderr).not.toContain("tok-secret-1");
      }
      expect(
        cli(["mark-verified", "prod", "v1.2.3"], {
          ...ok,
          PLATFORM_DB_ID: "x",
        }).status,
      ).toBe(2);
    });
  });
});
