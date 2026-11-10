import { spawnSync } from "node:child_process";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { markVerified } from "./platform-verified.ts";

// #1229: the deploy's mark that every Worker's read-back passed. A local
// SQLite stands in for D1.
const fakeDb = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "CREATE TABLE platform_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  );
  return {
    sqlite,
    db: {
      all: async (sql: string, params?: SQLInputValue[]) =>
        sqlite.prepare(sql).all(...(params ?? [])),
      exec: async (sql: string) => sqlite.exec(sql),
    },
  };
};
const rows = (s: DatabaseSync) =>
  s.prepare("SELECT key, value FROM platform_state ORDER BY key").all();

describe("markVerified", () => {
  it("writes platform_verified:<version> without the v, and logs no counts", async () => {
    const f = fakeDb();
    const log: string[] = [];
    await markVerified({
      db: f.db,
      tag: "v0.150.0",
      now: () => 1_000,
      log: (s) => log.push(s),
    });
    expect(rows(f.sqlite)).toEqual([
      { key: "platform_verified:0.150.0", value: 1_000 },
    ]);
    expect(log).toEqual(["platform_verified:0.150.0 written"]);
  });

  it("a rerun keeps the first time and adds no row", async () => {
    const f = fakeDb();
    for (const t of [1_000, 2_000])
      await markVerified({
        db: f.db,
        tag: "v0.150.0",
        now: () => t,
        log: () => {},
      });
    expect(rows(f.sqlite)).toEqual([
      { key: "platform_verified:0.150.0", value: 1_000 },
    ]);
  });

  it("refuses a tag that is not a stable release", async () => {
    const f = fakeDb();
    for (const tag of ["0.150.0", "v0.150", "v0.150.0-rc.1", ""])
      await expect(
        markVerified({ db: f.db, tag, now: () => 1, log: () => {} }),
      ).rejects.toThrow(/stable/);
    expect(rows(f.sqlite)).toEqual([]);
  });

  it("fails when the read-back finds no row", async () => {
    const f = fakeDb();
    const db = {
      ...f.db,
      all: async (sql: string) => (sql.startsWith("SELECT") ? [] : []),
    };
    await expect(
      markVerified({ db, tag: "v0.150.0", now: () => 1, log: () => {} }),
    ).rejects.toThrow(/read back/);
  });

  it("as a script: bad usage exits 2 and prints no secret", () => {
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "platform-verified.ts",
        "nope",
        "v1.2.3",
      ],
      {
        cwd: import.meta.dirname,
        env: { ...process.env, CLOUDFLARE_API_TOKEN: "tok-secret-1" },
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain("tok-secret-1");
  });
});
