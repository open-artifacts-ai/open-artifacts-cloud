import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InfraError } from "../src/fetch-timeout.ts";
import {
  acquire,
  holdsExclusive,
  LOCK_DEADLINE_MS,
  lockDirOf,
  withLock,
} from "../src/locks.ts";

const pkg = join(import.meta.dirname, "..");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rl-locks-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A pinned clock: sleep advances it and yields, nothing real waits. */
function clock() {
  let t = 5_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      await new Promise((r) => setImmediate(r));
    },
    at: () => t,
  };
}
const alive = () => true;

describe("src/locks.ts, in one process", () => {
  it("is off without a directory", async () => {
    expect(await acquire("x", "exclusive")).toBeNull();
    expect(await withLock("x", "shared", async () => 7)).toBe(7);
  });

  it("readers share, and a writer waits for them to leave", async () => {
    const c = clock();
    const o = { dir, ...c, alive };
    const r1 = await acquire("m", "shared", { ...o, pid: 1001 });
    const r2 = await acquire("m", "shared", { ...o, pid: 1002 });
    expect(r1 && r2).toBeTruthy();
    let got = false;
    const w = acquire("m", "exclusive", { ...o, pid: 1003 }).then((r) => {
      got = true;
      return r;
    });
    for (let i = 0; i < 5; i++) await c.sleep(10);
    expect(got).toBe(false);
    r1?.();
    for (let i = 0; i < 5; i++) await c.sleep(10);
    expect(got).toBe(false);
    r2?.();
    (await w)?.();
    expect(got).toBe(true);
  });

  it("a writer excludes writers and readers", async () => {
    const c = clock();
    const o = { dir, ...c, alive, deadlineMs: 1_000 };
    const w = await acquire("m", "exclusive", { ...o, pid: 2001 });
    await expect(
      acquire("m", "exclusive", { ...o, pid: 2002 }),
    ).rejects.toBeInstanceOf(InfraError);
    await expect(
      acquire("m", "shared", { ...o, pid: 2003 }),
    ).rejects.toBeInstanceOf(InfraError);
    w?.();
    (await acquire("m", "shared", { ...o, pid: 2003 }))?.();
  });

  it("a writer's intent blocks new readers: no writer starves", async () => {
    const c = clock();
    const o = { dir, ...c, alive };
    const order: string[] = [];
    const r1 = await acquire("m", "shared", { ...o, pid: 3001 });
    const w = acquire("m", "exclusive", { ...o, pid: 3002 }).then((r) => {
      order.push("writer");
      return r;
    });
    // The writer has announced; a reader arriving now queues behind it.
    for (let i = 0; i < 3; i++) await c.sleep(10);
    const r2 = acquire("m", "shared", { ...o, pid: 3003 }).then((r) => {
      order.push("reader2");
      return r;
    });
    for (let i = 0; i < 5; i++) await c.sleep(10);
    expect(order).toEqual([]);
    r1?.();
    const wr = await w;
    expect(order).toEqual(["writer"]);
    wr?.();
    (await r2)?.();
    expect(order).toEqual(["writer", "reader2"]);
  });

  it("frees a stale holder: a dead pid's writer and reader files are removed", async () => {
    const c = clock();
    const dead = 4242;
    const live = (p: number) => p !== dead;
    // A writer that died holding the lock, and a reader that died.
    await acquire("m", "exclusive", { dir, ...c, alive, pid: dead });
    const o = { dir, ...c, alive: live, pid: 4300, deadlineMs: 2_000 };
    const w = await acquire("m", "exclusive", o);
    expect(w).toBeTruthy();
    w?.();
    await acquire("m", "shared", { dir, ...c, alive, pid: dead });
    const w2 = await acquire("m", "exclusive", o);
    expect(w2).toBeTruthy();
    w2?.();
    expect(readdirSync(join(dir, "m"))).toEqual([]);
  });

  it("a live holder is never freed", async () => {
    const c = clock();
    await acquire("m", "exclusive", { dir, ...c, alive, pid: 5001 });
    await expect(
      acquire("m", "shared", {
        dir,
        ...c,
        alive,
        pid: 5002,
        deadlineMs: 3_000,
      }),
    ).rejects.toBeInstanceOf(InfraError);
  });

  it("an acquire past its deadline (120 s by default) is an InfraError, never a verdict", async () => {
    const c = clock();
    await acquire("m", "exclusive", { dir, ...c, alive, pid: 6001 });
    const start = c.at();
    await expect(
      acquire("m", "shared", { dir, ...c, alive, pid: 6002 }),
    ).rejects.toThrow(/infra: lock m \(shared\): not free after 120 s/);
    expect(c.at() - start).toBeGreaterThanOrEqual(LOCK_DEADLINE_MS);
    expect(c.at() - start).toBeLessThan(LOCK_DEADLINE_MS + 1_000);
    // A writer that timed out leaves no intent behind.
    await expect(
      acquire("m", "exclusive", {
        dir,
        ...c,
        alive,
        pid: 6003,
        deadlineMs: 500,
      }),
    ).rejects.toBeInstanceOf(InfraError);
    expect(
      readdirSync(join(dir, "m")).filter((f) => f.startsWith("wi.")).length,
    ).toBe(1);
  });

  it("withLock releases on a throw, and an exclusive holder knows it holds", async () => {
    const c = clock();
    const o = { dir, ...c, alive, pid: 7001 };
    await expect(
      withLock(
        "wl",
        "exclusive",
        async () => {
          expect(holdsExclusive("wl")).toBe(true);
          throw new Error("boom");
        },
        o,
      ),
    ).rejects.toThrow("boom");
    expect(holdsExclusive("wl")).toBe(false);
    expect(readdirSync(join(dir, "wl"))).toEqual([]);
  });

  it("the directory is the report's, wiped by redline.ts at the start", () => {
    expect(lockDirOf("/x/report.json")).toBe("/x/report.json.locks");
    mkdirSync(join(dir, "z"));
    writeFileSync(join(dir, "z", "w.slot"), "1");
    expect(existsSync(join(dir, "z", "w.slot"))).toBe(true);
  });
});

describe("src/locks.ts, between two processes", () => {
  /** A child that takes the lock, logs in and out around a pause, and releases. */
  function child(mode: "shared" | "exclusive", log: string, hold: number) {
    const script = `import { appendFileSync } from "node:fs";
import { withLock } from "./src/locks.ts";
await withLock("m", ${JSON.stringify(mode)}, async () => {
  appendFileSync(${JSON.stringify(log)}, "${mode[0]} in " + process.pid + "\\n");
  await new Promise((r) => setTimeout(r, ${hold}));
  appendFileSync(${JSON.stringify(log)}, "${mode[0]} out " + process.pid + "\\n");
});`;
    const p = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--input-type=module",
        "-e",
        script,
      ],
      {
        cwd: pkg,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          REDLINE_LOCK_DIR: dir,
        },
        stdio: "ignore",
      },
    );
    return new Promise<number>((res) => p.on("close", (c) => res(c ?? 1)));
  }

  it("two writers never overlap; a writer and readers never overlap; readers do", async () => {
    const log = join(dir, "log");
    writeFileSync(log, "");
    const codes = await Promise.all([
      child("exclusive", log, 300),
      child("exclusive", log, 300),
      child("shared", log, 300),
      child("shared", log, 300),
    ]);
    expect(codes).toEqual([0, 0, 0, 0]);
    // Replay the log: a writer must be alone, readers must not coexist with it.
    let writers = 0;
    let readers = 0;
    let maxReaders = 0;
    for (const l of readFileSync(log, "utf8").trim().split("\n")) {
      const [m, dir_] = l.split(" ");
      if (m === "e") writers += dir_ === "in" ? 1 : -1;
      else readers += dir_ === "in" ? 1 : -1;
      maxReaders = Math.max(maxReaders, readers);
      expect(writers).toBeLessThanOrEqual(1);
      if (writers > 0) expect(readers).toBe(0);
    }
    expect(maxReaders).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
