// An ordering barrier between lanes (#1730). A lane writes a mark when its
// part of a shared, order-sensitive step is done; another lane waits for the
// mark before it starts something that would break the first lane's cases.
// It only adds a wait: a wait past its deadline is an InfraError (never a
// verdict), and a lane that ended without marking releases its waiters
// through the `lane-exit.<name>` file scripts/redline.ts writes when a lane's
// child closes.
//
// Off unless scripts/redline.ts set REDLINE_BARRIER_DIR (a plan with lanes),
// so a lone vitest run, the local pair and the unit tests never wait.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InfraError } from "./fetch-timeout.ts";

/** The barriers lanes may name (test/lanes.test.ts reads this list). */
export const BARRIERS = ["broker-done"] as const;
export type BarrierName = (typeof BARRIERS)[number];

export const BARRIER_DIR_ENV = "REDLINE_BARRIER_DIR";
/** How long a waiter waits for a mark or a lane exit: past it, InfraError. */
export const BARRIER_DEADLINE_MS = 600_000;
const POLL_MS = 250;

/** The barrier directory of a report file (scripts/redline.ts wipes it at start). */
export const barrierDirOf = (reportFile: string): string =>
  `${reportFile}.barriers`;

const dirFrom = (dir: string | undefined): string | undefined =>
  dir ?? process.env[BARRIER_DIR_ENV] ?? undefined;

export const markFile = (dir: string, name: string): string =>
  join(dir, `mark.${name}`);
export const laneExitFile = (dir: string, lane: string): string =>
  join(dir, `lane-exit.${lane}`);

/** Marks `name` done. A no-op when barriers are off; safe to call twice. */
export function mark(name: BarrierName, dir?: string): void {
  const d = dirFrom(dir);
  if (!d) return;
  mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(markFile(d, name), String(Date.now()), { mode: 0o600 });
}

export interface WaitOpts {
  /** A lane whose exit also releases the wait (it ended before it marked). */
  orLaneExit?: string;
  deadlineMs?: number;
  dir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits for `name`'s mark, or `orLaneExit`'s exit file. Resolves "off" at
 * once when barriers are off. Throws InfraError past the deadline.
 */
export async function waitFor(
  name: BarrierName,
  o: WaitOpts = {},
): Promise<"marked" | "lane-exit" | "off"> {
  const d = dirFrom(o.dir);
  if (!d) return "off";
  const now = o.now ?? Date.now;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = now() + (o.deadlineMs ?? BARRIER_DEADLINE_MS);
  for (;;) {
    if (existsSync(markFile(d, name))) return "marked";
    if (o.orLaneExit && existsSync(laneExitFile(d, o.orLaneExit)))
      return "lane-exit";
    if (now() >= end)
      throw new InfraError(
        `barrier ${name}: not marked${o.orLaneExit ? ` and lane ${o.orLaneExit} still running` : ""} after ${(o.deadlineMs ?? BARRIER_DEADLINE_MS) / 1000} s`,
      );
    await sleep(POLL_MS);
  }
}
