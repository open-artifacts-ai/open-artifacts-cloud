import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BARRIER_DEADLINE_MS,
  BARRIER_DIR_ENV,
  barrierDirOf,
  laneExitFile,
  mark,
  markFile,
  waitFor,
} from "../src/barrier.ts";
import { InfraError } from "../src/fetch-timeout.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rl-barrier-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A pinned clock: sleep advances it, nothing real waits. */
function clock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    at: () => t,
  };
}

describe("src/barrier.ts", () => {
  it("is off without a directory: mark does nothing, waitFor returns at once", async () => {
    delete process.env[BARRIER_DIR_ENV];
    mark("broker-done");
    expect(await waitFor("broker-done")).toBe("off");
  });

  it("waitFor is released by the mark", async () => {
    const c = clock();
    let polls = 0;
    const sleep = async (ms: number) => {
      await c.sleep(ms);
      if (++polls === 3) mark("broker-done", dir);
    };
    expect(
      await waitFor("broker-done", {
        dir,
        now: c.now,
        sleep,
        orLaneExit: "front",
      }),
    ).toBe("marked");
    expect(polls).toBe(3);
    expect(existsSync(markFile(dir, "broker-done"))).toBe(true);
  });

  it("waitFor is released by the lane's exit file", async () => {
    const c = clock();
    const { writeFileSync } = await import("node:fs");
    let polls = 0;
    const sleep = async (ms: number) => {
      await c.sleep(ms);
      if (++polls === 2) writeFileSync(laneExitFile(dir, "front"), "0");
    };
    expect(
      await waitFor("broker-done", {
        dir,
        now: c.now,
        sleep,
        orLaneExit: "front",
      }),
    ).toBe("lane-exit");
  });

  it("another lane's exit does not release it", async () => {
    const c = clock();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(laneExitFile(dir, "guard"), "0");
    await expect(
      waitFor("broker-done", {
        dir,
        now: c.now,
        sleep: c.sleep,
        orLaneExit: "front",
        deadlineMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(InfraError);
  });

  it("raises InfraError at the deadline (600 s by default), never earlier", async () => {
    const c = clock();
    const start = c.at();
    await expect(
      waitFor("broker-done", {
        dir,
        now: c.now,
        sleep: c.sleep,
        orLaneExit: "front",
      }),
    ).rejects.toThrow(
      /infra: barrier broker-done: not marked and lane front still running after 600 s/,
    );
    expect(c.at() - start).toBeGreaterThanOrEqual(BARRIER_DEADLINE_MS);
    expect(c.at() - start).toBeLessThan(BARRIER_DEADLINE_MS + 1_000);
  });

  it("the directory is the report's, wiped by redline.ts at the start", () => {
    expect(barrierDirOf("/x/report.json")).toBe("/x/report.json.barriers");
  });
});
