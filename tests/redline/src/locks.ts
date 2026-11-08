// A readers-writer lock between processes of one run (#1730), for a state key
// one lane compares before and after (credentials' member list on rl-b) while
// other lanes change it. Writers are exclusive, readers share, and a writer's
// intent blocks new readers so a writer never starves.
//
// Built on files, like src/../hook-ledger.ts: a holder creates its own file
// with an exclusive create (EEXIST means taken), nothing is read and
// rewritten. A file names its holder's pid; a holder that is gone
// (kill(pid, 0) says ESRCH) is freed by the next process that sees it.
// An acquire past its deadline is an InfraError, never a verdict.
//
// Off unless scripts/redline.ts set REDLINE_LOCK_DIR (a plan with lanes).

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { InfraError } from "./fetch-timeout.ts";

export const LOCK_DIR_ENV = "REDLINE_LOCK_DIR";
/** An acquire waits at most this long: past it, InfraError. */
export const LOCK_DEADLINE_MS = 120_000;
const POLL_MS = 50;

/** The lock directory of a report file (scripts/redline.ts wipes it at start). */
export const lockDirOf = (reportFile: string): string => `${reportFile}.locks`;

export type LockMode = "shared" | "exclusive";

export interface LockOpts {
  dir?: string;
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Is this pid alive? Default: kill(pid, 0). */
  alive?: (pid: number) => boolean;
  pid?: number;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const dirFrom = (dir: string | undefined): string | undefined =>
  dir ?? process.env[LOCK_DIR_ENV] ?? undefined;

/** Exclusive holds of this process, by lock name (a holder's own requests skip the shared side). */
const heldHere = new Map<string, number>();
export const holdsExclusive = (name: string): boolean =>
  (heldHere.get(name) ?? 0) > 0;

interface Entry {
  file: string;
  kind: "w" | "wi" | "r";
  pid: number;
}

/** The live entries of lock `name`; a dead holder's file is removed on sight. */
function entries(
  dir: string,
  alive: (pid: number) => boolean,
  mine: number,
): Entry[] {
  const out: Entry[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of names) {
    const m = /^(w|wi|r)\.(.*)$/.exec(file);
    if (!m) continue;
    let pid = Number.NaN;
    try {
      pid = Number(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue; // gone between the listing and the read
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      // A file is written whole by its creator in one call, but a reader may
      // list it between create and write: treat an empty file as live.
      out.push({ file, kind: m[1] as Entry["kind"], pid: mine });
      continue;
    }
    if (pid !== mine && !alive(pid)) {
      rmSync(join(dir, file), { force: true });
      continue;
    }
    out.push({ file, kind: m[1] as Entry["kind"], pid });
  }
  return out;
}

export type Release = () => void;

/**
 * Takes lock `name` in `mode`. Returns its release; null when locks are off.
 * A shared acquire waits while a writer holds or intends; an exclusive one
 * announces its intent, then waits for the writer slot and for every reader
 * to leave.
 */
export async function acquire(
  name: string,
  mode: LockMode,
  o: LockOpts = {},
): Promise<Release | null> {
  const root = dirFrom(o.dir);
  if (!root) return null;
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = o.now ?? Date.now;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alive = o.alive ?? isAlive;
  const pid = o.pid ?? process.pid;
  const id = `${pid}.${randomBytes(5).toString("hex")}`;
  const end = now() + (o.deadlineMs ?? LOCK_DEADLINE_MS);
  const late = () =>
    new InfraError(
      `lock ${name} (${mode}): not free after ${(o.deadlineMs ?? LOCK_DEADLINE_MS) / 1000} s`,
    );
  const create = (file: string): boolean => {
    try {
      writeFileSync(join(dir, file), String(pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };
  const drop = (file: string) => rmSync(join(dir, file), { force: true });

  if (mode === "shared") {
    const file = `r.${id}`;
    for (;;) {
      const writers = entries(dir, alive, pid).filter((e) => e.kind !== "r");
      if (writers.length === 0) {
        create(file);
        // A writer that announced between the check and the create sees this
        // reader and waits; one that announced before it is seen here.
        if (entries(dir, alive, pid).every((e) => e.kind === "r"))
          return () => drop(file);
        drop(file);
      }
      if (now() >= end) throw late();
      await sleep(POLL_MS);
    }
  }

  const intent = `wi.${id}`;
  create(intent);
  try {
    // The writer slot: one writer at a time, the one that creates w.slot.
    for (;;) {
      if (create("w.slot")) break;
      entries(dir, alive, pid); // frees a dead holder's w.slot
      if (now() >= end) throw late();
      await sleep(POLL_MS);
    }
    try {
      for (;;) {
        const readers = entries(dir, alive, pid).filter((e) => e.kind === "r");
        if (readers.length === 0) break;
        if (now() >= end) throw late();
        await sleep(POLL_MS);
      }
    } catch (e) {
      drop("w.slot");
      throw e;
    }
  } catch (e) {
    drop(intent);
    throw e;
  }
  heldHere.set(name, (heldHere.get(name) ?? 0) + 1);
  return () => {
    heldHere.set(name, (heldHere.get(name) ?? 1) - 1);
    drop("w.slot");
    drop(intent);
  };
}

/** Runs `fn` holding `name` in `mode`; the release always runs. */
export async function withLock<T>(
  name: string,
  mode: LockMode,
  fn: () => Promise<T>,
  o: LockOpts = {},
): Promise<T> {
  const release = await acquire(name, mode, o);
  try {
    return await fn();
  } finally {
    release?.();
  }
}
