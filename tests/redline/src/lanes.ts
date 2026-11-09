// Which live files may run at the same time (scripts/redline.ts). A file runs
// beside another only when no state or rate-limit bucket it claims could make
// a check pass, or fail, that would not when the files run one at a time.
//
// The plan is a list of phases, run one after another. A phase is a list of
// lanes, run at the same time; a lane is a named list of files, run one at a
// time (vitest.live.config.ts keeps fileParallelism off inside each lane).
// test/lanes.test.ts fails when two lanes of one phase claim the same thing.
//
// #1730: PLAN is one phase of five lanes. Where two lanes touch one thing
// they do not just conflict: the thing is guarded by a lock (src/locks.ts),
// paced by a ledger (hook-ledger.ts, src/rl-anon.ts), or ordered by a barrier
// (src/barrier.ts). Each of those only adds a wait; an overrun is an
// InfraError, never a verdict. REDLINE_PLAN=serial selects PLAN_SERIAL, the
// two-phase plan this replaced (the kill switch).

import { BARRIERS } from "./barrier.ts";
import type { CaseResult } from "./report.ts";

/**
 * How a file touches a state key another file could change or read:
 * - "write": changes it, or reads it exactly (a before/after snapshot);
 * - "use": only uses it in a way another "use" can't disturb;
 * - observe(reason): reads it in a way that holds while others change it,
 *   and says why (a pair with an observer conflicts on nothing);
 * - guarded(lock): changes or reads it only holding the named lock
 *   (src/locks.ts); two sides guarding the key with the same lock don't conflict.
 */
export type StateMode =
  | "write"
  | "use"
  | { observe: string }
  | { guarded: string; as: "shared" | "exclusive" };

export const observe = (reason: string): StateMode => ({ observe: reason });
export const guarded = (
  lock: string,
  as: "shared" | "exclusive",
): StateMode => ({ guarded: lock, as });

/**
 * How a file spends a rate-limit bucket:
 * - "exclusive": only one lane may (the codes bucket, RL_AUTH 20 a minute);
 * - paced(ledger): every spender claims a slot in the named ledger first, so
 *   the sum stays under the limit whoever spends;
 * - ordered(barrier): spenders are ordered by the named barrier
 *   (src/barrier.ts): the one that overspends on purpose waits for the mark.
 */
export type BucketMode = "exclusive" | { paced: string } | { ordered: string };

export const paced = (ledger: string): BucketMode => ({ paced: ledger });
export const ordered = (barrier: string): BucketMode => ({ ordered: barrier });

export interface Claims {
  state: Record<string, StateMode>;
  buckets: Record<string, BucketMode>;
}

/** The names of the locks, ledgers and barriers a claim may name. */
export const LOCKS = ["rl-b-members"] as const;

const MEMBERS = "rl-b/members+member-user";

/**
 * The state every file that calls loadTargets() holds. Not "rl-a" and "rl-b"
 * as a whole any more: the keys are what a file really reads or changes.
 */
const installs = (): Claims["state"] => ({
  // The admin PAT's lastUsedAt (written at most once a minute per use).
  "rl-a/admin-pat": "use",
  "rl-b/admin-pat": "use",
  // The admin's own token and grant lists: a file snapshots them whole only
  // as an actor of its own (edge's csrfWrites runs as redline-csrf@, the
  // grant fallback in src/surfaces.ts keeps only its own client's grants).
  "rl-x/admin-lists": "use",
  // Hook audit rows: every file appends, with a user of its own.
  "rl-x/hook-audit": "use",
});

/**
 * The install-plane buckets, from apps/server (namespace ids are account-wide,
 * so a key without the install in it is shared by every staging install):
 * - hooks: RL_ANON test:<install>:<ip>, 30 a minute; every spender claims the
 *   runner's hook ledger (src/http.ts paceHook), 25 a minute;
 * - rl-anon: every other RL_ANON key (reg:ip, tok:ip, sub:ip, ...), shared by
 *   rl-a and rl-b; src/rl-anon.ts claims one ledger per key, 25 a minute;
 * - codes: RL_AUTH <install>:<ip>, 20 a minute (one-time code requests); only
 *   signin and edge spend it, and they share a lane.
 */
const installBuckets = (): Claims["buckets"] => ({
  "rl-a/hooks": paced("hook-ledger/rl-a"),
  "rl-b/hooks": paced("hook-ledger/rl-b"),
  "rl-anon": paced("rl-anon"),
});

const codes = (): Claims["buckets"] => ({
  "rl-a/codes": "exclusive",
  "rl-b/codes": "exclusive",
});

export const CLAIMS: Record<string, Claims> = {
  "live/guard.test.ts": {
    state: {
      ...installs(),
      // The hook-audit cases read the newest rows first, for their own unique
      // user, and the read is capped at TEST_AUDIT_LIMIT (200, packages/shared
      // src/hosted/test-hooks.ts): other lanes' rows can't push theirs out.
      "rl-x/hook-audit": observe(
        "newest-first, unique user, TEST_AUDIT_LIMIT 200",
      ),
    },
    buckets: installBuckets(),
  },
  "live/credentials.test.ts": {
    state: {
      ...installs(),
      // The link cases compare rl-b's whole member list, and the member
      // user's shares and artifacts, before and after (exclusive lock held
      // for the two case bodies); everyone else's writes there take it shared.
      [MEMBERS]: guarded("rl-b-members", "exclusive"),
    },
    buckets: installBuckets(),
  },
  "live/live.test.ts": { state: installs(), buckets: installBuckets() },
  // #1299: a machine on each side (labelled, revoked at the end) and its
  // device-flow requests, which the rl-anon ledgers pace (bus-dev, bus-tok,
  // bus-code, bus-approve in src/rl-anon.ts).
  "live/bus.test.ts": { state: installs(), buckets: installBuckets() },
  "live/surfaces.test.ts": {
    state: {
      ...installs(),
      [MEMBERS]: guarded("rl-b-members", "shared"),
      // The world it seeds on both installs (spaces, groups, artifacts).
      "rl-x/world": "write",
    },
    buckets: installBuckets(),
  },
  "live/edge.test.ts": {
    state: {
      ...installs(),
      [MEMBERS]: guarded("rl-b-members", "shared"),
      // The inventory cases read the host list while provisioning creates and
      // deletes its own installs.
      "staging-inventory": observe(
        "no host claimed twice holds under concurrent creates; complete only false above MAX_HOSTS",
      ),
    },
    buckets: { ...installBuckets(), ...codes() },
  },
  "live/signin.test.ts": {
    state: {
      ...installs(),
      [MEMBERS]: guarded("rl-b-members", "shared"),
      // The rl-guest-* and rl-member-* users it makes on rl-b.
      "rl-b/signin-guests": "write",
    },
    // brokerState and the tamper case go through the staging auth broker
    // from this runner: RL_BROKER_IP, 60 a minute per IP. Signin marks
    // broker-done when its broker cases end; P34 (which spends the bucket on
    // purpose) waits for it.
    buckets: {
      ...installBuckets(),
      ...codes(),
      "broker-ip": ordered("broker-done"),
    },
  },
  "live/provisioning.test.ts": {
    state: {
      // Its own installs (rl-p-<run>, P50's), jobs, clients and audit rows.
      "provisioning-plane": "write",
      // The staging inventory's host list: it creates and deletes installs.
      "staging-inventory": "write",
      // P36 uses the R26 admin PAT on rl-a's /api/v1/me; nothing else of
      // rl-a or rl-b is written (P11/P12 are refusals, the rest reads).
      "rl-a/admin-pat": "use",
    },
    buckets: {
      // P34 spends RL_BROKER_IP past its limit on purpose.
      "broker-ip": ordered("broker-done"),
      // RL_PV_* (P25 spends RL_PV_SIGNIN_IP past its limit on purpose).
      "provisioning-api": "exclusive",
    },
  },
};

export interface Lane {
  /** Unique in the plan: the output prefix, the part's file name, the lane-exit mark. */
  readonly name: string;
  /** Run one at a time, in this order. */
  readonly files: readonly string[];
  /** Extra environment for the lane's vitest run. */
  readonly env?: Readonly<Record<string, string>>;
}
export type Phase = readonly Lane[];

const lane = (name: string, ...files: string[]): Lane => ({
  name,
  files: files.map((f) => `live/${f}.test.ts`),
});

/**
 * The run (#1730): one phase, five lanes, the longest file per lane.
 * - prov: provisioning (337.7 s in run 42402998826), P34 behind the broker barrier;
 * - surfaces: surfaces (335.0 s);
 * - creds: credentials (234.8 s), its link cases under the exclusive members lock;
 * - guard: guard (130.8 s; prodClean stays serial inside it), then bus (#1299:
 *   one case, a few requests; unproven-live while the bus is off);
 * - front: signin, edge, live. The only files that spend `codes`, so it stays
 *   in one lane; signin goes first, so its broker cases end early.
 */
export const PLAN: readonly Phase[] = [
  [
    lane("prov", "provisioning"),
    lane("surfaces", "surfaces"),
    lane("creds", "credentials"),
    lane("guard", "guard", "bus"),
    lane("front", "signin", "edge", "live"),
  ],
];

/**
 * The plan #1730 replaced, kept as the kill switch (REDLINE_PLAN=serial).
 * Phase 1: signin (the broker) and edge, with nothing beside them. Phase 2:
 * the other install files, one at a time, beside provisioning.
 */
export const PLAN_SERIAL: readonly Phase[] = [
  [lane("front", "signin", "edge")],
  [
    lane("install", "credentials", "live", "guard", "surfaces"),
    lane("prov", "provisioning"),
  ],
];

/**
 * The plan REDLINE_PLAN names: "lanes" is PLAN, "serial" is PLAN_SERIAL,
 * anything else throws. Unset: PLAN on staging, PLAN_SERIAL on the local pair
 * (one wrangler pair on one machine; the lanes' proof is for staging's).
 */
export function selectPlan(
  env: Record<string, string | undefined> = process.env,
): readonly Phase[] {
  const v = (env.REDLINE_PLAN ?? "").trim();
  if (v === "") {
    try {
      const mode = (
        JSON.parse(env.REDLINE_TARGETS ?? "null") as { mode?: unknown } | null
      )?.mode;
      if (mode === "local") return PLAN_SERIAL;
    } catch {}
    return PLAN;
  }
  if (v === "lanes") return PLAN;
  if (v === "serial") return PLAN_SERIAL;
  throw new Error(`REDLINE_PLAN must be "lanes" or "serial", not "${v}"`);
}

/** A plan's own mistakes: a repeated lane name, a file in two lanes, a lane with no file. */
export function planProblems(plan: readonly Phase[] = PLAN): string[] {
  const out: string[] = [];
  const names = new Set<string>();
  const files = new Set<string>();
  for (const phase of plan)
    for (const l of phase) {
      if (names.has(l.name)) out.push(`lane name ${l.name} is used twice`);
      names.add(l.name);
      if (l.files.length === 0) out.push(`lane ${l.name} has no file`);
      for (const f of l.files) {
        if (files.has(f)) out.push(`${f} is in two lanes`);
        files.add(f);
      }
    }
  return out;
}

const stateOverlap = (k: string, m: StateMode, n: StateMode): string | null => {
  if (m === "use" && n === "use") return null;
  if (typeof m === "object" && "observe" in m)
    return m.observe ? null : `${k}: observe without a reason`;
  if (typeof n === "object" && "observe" in n)
    return n.observe ? null : `${k}: observe without a reason`;
  if (
    typeof m === "object" &&
    "guarded" in m &&
    typeof n === "object" &&
    "guarded" in n &&
    m.guarded === n.guarded
  )
    return null;
  return `both hold ${k}`;
};

const bucketOverlap = (m: BucketMode, n: BucketMode): boolean => {
  if (typeof m === "object" && typeof n === "object") {
    if ("paced" in m && "paced" in n) return m.paced !== n.paced;
    if ("ordered" in m && "ordered" in n) return m.ordered !== n.ordered;
  }
  return true;
};

/** Every claim two lanes of one phase share and may not, as readable lines. */
export function conflicts(
  plan: readonly Phase[] = PLAN,
  claims: Record<string, Claims> = CLAIMS,
): string[] {
  const out: string[] = [];
  const of = (f: string): Claims => {
    const c = claims[f];
    if (!c) throw new Error(`${f}: no claims`);
    return c;
  };
  plan.forEach((phase, p) => {
    for (let i = 0; i < phase.length; i++)
      for (let j = i + 1; j < phase.length; j++)
        for (const x of phase[i]?.files ?? [])
          for (const y of phase[j]?.files ?? []) {
            const cx = of(x);
            const cy = of(y);
            for (const [k, m] of Object.entries(cx.state)) {
              const n = cy.state[k];
              if (!n) continue;
              const why = stateOverlap(k, m, n);
              if (why) out.push(`phase ${p + 1}: ${x} and ${y} ${why}`);
            }
            for (const [b, m] of Object.entries(cx.buckets)) {
              const n = cy.buckets[b];
              if (n && bucketOverlap(m, n))
                out.push(`phase ${p + 1}: ${x} and ${y} both spend ${b}`);
            }
          }
  });
  return out;
}

/** The barriers the plan's claims name, each of which must exist in src/barrier.ts. */
export const orderedBarriers = (
  claims: Record<string, Claims> = CLAIMS,
): string[] => [
  ...new Set(
    Object.values(claims).flatMap((c) =>
      Object.values(c.buckets).flatMap((b) =>
        typeof b === "object" && "ordered" in b ? [b.ordered] : [],
      ),
    ),
  ),
];
export const knownBarriers: readonly string[] = BARRIERS;

/** A lane's name (output prefix, part file, lane-exit mark). */
export const laneName = (l: Lane): string => l.name;

/** What one lane's vitest run left: its exit code and its part (null: none). */
export interface LaneResult {
  lane: Lane;
  exit: number;
  part: { cases: CaseResult[]; fileNotes: FileNote[] } | null;
}
type FileNote = { file: string; note: string };

/**
 * The run's cases from every lane. A lane with no part, a case from a file
 * outside the lane (it ran where the plan did not put it), or one case name
 * reported twice, adds a fail case, so the gate can't pass on a lane that
 * didn't report, ran wrong, or ran a case in two places.
 * runExit is the first non-zero lane exit.
 */
export function mergeLanes(results: readonly LaneResult[]): {
  cases: CaseResult[];
  fileNotes: FileNote[];
  runExit: number;
} {
  const cases: CaseResult[] = [];
  const fileNotes: FileNote[] = [];
  const seen = new Set<string>();
  let runExit = 0;
  for (const r of results) {
    if (r.exit !== 0 && runExit === 0) runExit = r.exit;
    const name = laneName(r.lane);
    if (!r.part) {
      cases.push({
        name: `lane ${name}: no results`,
        level: "fail",
        reason: `the lane's vitest run wrote no part (exit ${r.exit})`,
      });
      continue;
    }
    for (const c of r.part.cases) {
      if (c.file !== undefined && !r.lane.files.includes(c.file))
        cases.push({
          name: `lane ${name}: ran ${c.file}`,
          level: "fail",
          reason: "a file outside the lane ran in it",
        });
      const key = `${c.file ?? ""}\u0000${c.name}`;
      if (seen.has(key))
        cases.push({
          name: `lane ${name}: duplicate ${c.file ?? ""} ${c.name}`,
          level: "fail",
          reason: "a case was reported twice",
        });
      seen.add(key);
      cases.push(c);
    }
    fileNotes.push(...r.part.fileNotes);
  }
  return { cases, fileNotes, runExit };
}
