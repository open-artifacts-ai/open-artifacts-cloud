// RL_ANON pacing for the lanes of one run (#1730, #1254). RL_ANON is a
// 30-per-60-s binding per key, and its keys carry no install (apps/server:
// `reg:ip:`, `tok:ip:`, `sub:ip:` ...), so rl-a and rl-b share them, and so do
// the lanes now running side by side. Hooks (`test:<install>:<ip>`) are paced
// by paceHook (src/http.ts) already; this paces the rest.
//
// anonKeys() maps a request to the keys it spends. Each key is paced with the
// public hook ledger (apps/dashboard/e2e/staging/hook-ledger.ts), one ledger
// per key, 25 per 60 s (HOOK_LIMIT: 5 kept back, as for hooks), shared by
// every process on the runner. The wrapper (live/setup.ts) paces outside
// boundFetch, so a wait never counts against a request's timeout.
//
// Tripwire: a 429 from rl-a or rl-b on a request this table did not classify
// is an InfraError naming the route, never a verdict: a key we do not pace is
// being spent, and the table needs a row (test/rl-anon.test.ts also reads the
// server's source for every key it limits on).
import { claimHookSlot } from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";
import { InfraError } from "./fetch-timeout.ts";
import { holdsExclusive, withLock } from "./locks.ts";

/** The lock name for rl-b's member list and its member-user (state key `rl-b/members+member-user`). */
export const MEMBERS_LOCK = "rl-b-members";

/** The part of a target this module reads. */
export interface AnonTarget {
  name: string;
  installId: string;
  app: string;
  content: string;
}

/** What a key is: paced (the suite spends it) or not, and why. */
export interface KeyRow {
  paced: boolean;
  why: string;
}

/**
 * Every RL_ANON / RL_AUTH key prefix apps/server limits on, as the server
 * writes it (test/rl-anon.test.ts fails on a prefix missing here).
 */
export const KEY_TABLE: Record<string, KeyRow> = {
  "reg:ip:": { paced: true, why: "POST /oauth/register, per IP" },
  "tok:ip:": { paced: true, why: "POST /oauth/token, per IP" },
  "consent:u:": {
    paced: true,
    why: "GET /oauth/authorize with a session, per user",
  },
  "tok:": {
    paced: false,
    why: "per OAuth client (refresh storms); a client is made per case",
  },
  "dir:": {
    paced: false,
    why: "per user, directory reads; not spent by the suite",
  },
  "test:": { paced: false, why: "hooks: paced by paceHook (src/http.ts)" },
  "${installKey}:": {
    paced: false,
    why: "RL_AUTH one-time codes; the front lane only (src/lanes.ts, bucket codes)",
  },
  "oauth-copy:": {
    paced: false,
    why: "per install and IP; the oauth-store copy route, no suite case",
  },
  "sub:ip:": { paced: true, why: "anonymous data-subscribe" },
  "ev:ip:": { paced: true, why: "anonymous events" },
  "anonid:ip:": { paced: true, why: "anonymous anon-id mint" },
  "ip:": { paced: true, why: "anonymous data writes" },
  "bus-dev:ip:": { paced: true, why: "POST /bus/device, per IP" },
  "bus-tok:ip:": { paced: true, why: "POST /bus/device/token, per IP" },
  "bus-tok:dc:": { paced: false, why: "per device code" },
  "bus-approve:u:": { paced: true, why: "POST /bus/approve, per member" },
  "bus-code:u:": {
    paced: true,
    why: "POST /bus/approve step=code, per member",
  },
  "bus-code:ip:": { paced: true, why: "POST /bus/approve step=code, per IP" },
  "bus-write:u:": {
    paced: true,
    why: "bus roles and links writes, per member",
  },
};

export interface Classified {
  /** The ledger keys the request spends (without the `rl-anon/` prefix). */
  keys: string[];
  /** Some row of the table covers it (a paced key, hooks, or the codes bucket). */
  known: boolean;
}

const urlOf = (u: string): URL | null => {
  try {
    return new URL(u);
  } catch {
    return null;
  }
};

/** The target whose app or content origin `url` is on, and which origin. */
export function targetOf(
  url: URL,
  targets: readonly AnonTarget[],
): { t: AnonTarget; host: "app" | "content" } | null {
  for (const t of targets) {
    if (urlOf(t.app)?.origin === url.origin) return { t, host: "app" };
    if (urlOf(t.content)?.origin === url.origin) return { t, host: "content" };
  }
  return null;
}

export interface ReqLike {
  method: string;
  url: string;
  headers: Headers;
}

const RUNTIME =
  /^\/api\/v1\/artifacts\/[^/]+\/(data|data-count|data-subscribe|events|anon-id|storage)(\/|$)/;

/** Anonymous: no cookie and no bearer (the embed header makes any call anonymous too). */
const isAnonymous = (h: Headers) =>
  h.get("x-oa-embed") === "1" || (!h.get("cookie") && !h.get("authorization"));

/** What the request spends. Pure: no I/O. */
export function classify(
  req: ReqLike,
  targets: readonly AnonTarget[],
): Classified {
  const url = urlOf(req.url);
  if (!url) return { keys: [], known: false };
  const hit = targetOf(url, targets);
  if (!hit) return { keys: [], known: true }; // not an install of ours
  const { t } = hit;
  const m = req.method.toUpperCase();
  const p = url.pathname;
  const keys: string[] = [];
  let known = false;
  if (p.startsWith("/__test/")) known = true; // paceHook paces it
  if (m === "POST" && /^\/auth\/code\/(request|verify)$/.test(p)) known = true; // RL_AUTH: codes
  if (m === "POST" && p === "/oauth/register") keys.push("reg:ip");
  if (m === "POST" && (p === "/oauth/token" || p === "/oauth/revoke"))
    keys.push("tok:ip");
  if (m === "GET" && p === "/oauth/authorize" && req.headers.get("cookie"))
    keys.push(`consent:u:${t.installId}`);
  if (m === "POST" && p === "/bus/device") keys.push("bus-dev:ip");
  if (m === "POST" && p === "/bus/device/token") {
    keys.push("bus-tok:ip");
    known = true; // bus-tok:dc is per device code
  }
  if (m === "POST" && p === "/bus/approve") {
    keys.push("bus-code:ip");
    if (req.headers.get("cookie"))
      keys.push(`bus-approve:u:${t.installId}`, `bus-code:u:${t.installId}`);
  }
  if (
    (m === "PUT" || m === "DELETE" || m === "POST") &&
    /^\/api\/v1\/bus\/(roles|links)(\/|$)/.test(p) &&
    req.headers.get("cookie")
  )
    keys.push(`bus-write:u:${t.installId}`);
  if (RUNTIME.test(p) && isAnonymous(req.headers)) {
    const part = RUNTIME.exec(p)?.[1];
    if (part === "data-subscribe") keys.push("sub:ip");
    else if (part === "events") keys.push("ev:ip");
    else if (part === "anon-id") keys.push("anonid:ip");
    else if (part === "data" && m !== "GET") keys.push("ip");
  }
  return { keys, known: known || keys.length > 0 };
}

/** The keys a request spends (see classify). */
export const anonKeys = (
  req: ReqLike,
  targets: readonly AnonTarget[],
): string[] => classify(req, targets).keys;

export type Claim = (key: string) => Promise<unknown>;

/**
 * What this process claimed, for the part's notes (#1730: the first real run
 * measures the pacing): each RL_ANON key's claims, the hook calls, and how
 * long the claims waited in all.
 */
const stats = {
  anon: new Map<string, number>(),
  hooks: 0,
  waitedMs: 0,
};
export const countHook = (waitedMs: number): void => {
  stats.hooks++;
  stats.waitedMs += waitedMs;
};
export function pacingNote(
  file: string,
  lane = process.env.REDLINE_LANE ?? "run",
): string {
  const anon = [...stats.anon].sort(([a], [b]) => a.localeCompare(b));
  const total = anon.reduce((n, [, c]) => n + c, 0);
  return `pacing (lane ${lane}, ${file}): ${stats.hooks} hook claim(s), ${total} RL_ANON claim(s)${anon.length ? ` (${anon.map(([k, c]) => `${k} ${c}`).join(", ")})` : ""}, waited ${(stats.waitedMs / 1000).toFixed(1)} s in all`;
}
/** @internal Test seam. */
export const resetPacingStats = (): void => {
  stats.anon.clear();
  stats.hooks = 0;
  stats.waitedMs = 0;
};

/** The public ledger claim for one key, one ledger per key. */
export const ledgerClaim: Claim = (key) => claimHookSlot(`rl-anon/${key}`);

/** Waits until every key the request spends has room, recording each. */
export async function paceAnon(
  req: ReqLike,
  targets: readonly AnonTarget[],
  claim: Claim = ledgerClaim,
): Promise<string[]> {
  const keys = anonKeys(req, targets);
  for (const k of keys) {
    const t0 = Date.now();
    await claim(k);
    stats.waitedMs += Date.now() - t0;
    stats.anon.set(k, (stats.anon.get(k) ?? 0) + 1);
  }
  return keys;
}

/**
 * A 429 from an install of ours on a request the table did not classify:
 * throws an InfraError naming the route. Anything else passes.
 */
export function tripwire(
  req: ReqLike,
  status: number,
  targets: readonly AnonTarget[],
): void {
  if (status !== 429) return;
  const url = urlOf(req.url);
  if (!url || !targetOf(url, targets)) return;
  if (classify(req, targets).known) return;
  throw new InfraError(
    `unclassified 429 from ${url.host} on ${req.method.toUpperCase()} ${url.pathname}: a rate-limit key the suite does not pace (add it to src/rl-anon.ts)`,
  );
}

/**
 * The targets REDLINE_TARGETS names, read without loading secrets. Lenient:
 * none when unset, not JSON, local mode or incomplete (unit tests, local pair).
 */
export function targetsFromEnv(
  env: Record<string, string | undefined> = process.env,
): AnonTarget[] {
  try {
    return liveTargetsFromEnv(env);
  } catch {
    return [];
  }
}

/**
 * The same read for a run against live installs: none only for local mode
 * (a wrangler pair whose limiter is not the account's). Anything else that
 * leaves a or b unnamed throws InfraError, so pacing, the members lock and
 * the 429 tripwire are never silently dropped.
 */
export function liveTargetsFromEnv(
  env: Record<string, string | undefined> = process.env,
): AnonTarget[] {
  const raw = env.REDLINE_TARGETS;
  if (!raw)
    throw new InfraError(
      "REDLINE_TARGETS is not set: RL_ANON pacing, the members lock and the 429 tripwire cannot run",
    );
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new InfraError(
      "REDLINE_TARGETS is not JSON: RL_ANON pacing, the members lock and the 429 tripwire cannot run",
    );
  }
  if (!v || typeof v !== "object")
    throw new InfraError("REDLINE_TARGETS is not a JSON object");
  if (v.mode === "local") return [];
  const out: AnonTarget[] = [];
  for (const k of ["a", "b"]) {
    const t = v[k] as Partial<AnonTarget> | undefined;
    if (!t || typeof t.app !== "string" || typeof t.content !== "string")
      throw new InfraError(
        `REDLINE_TARGETS.${k} needs app and content: RL_ANON pacing, the members lock and the 429 tripwire cannot run`,
      );
    out.push({
      name: typeof t.name === "string" ? t.name : k,
      installId: typeof t.installId === "string" ? t.installId : k,
      app: t.app,
      content: t.content,
    });
  }
  return out;
}

/** Pacing and lock waits of one case may total this long: under the 180 s case timeout. */
export const WAIT_BUDGET_MS = 120_000;

export interface GuardDeps {
  targets: readonly AnonTarget[];
  claim?: Claim;
  /** rl-b's app origin takes the members lock shared for non-GET requests. */
  membersOrigin?: string;
  /** Total pacing and lock wait one scope (a case) may spend; default WAIT_BUDGET_MS. */
  waitBudgetMs?: number;
  /** The running case, as an object: the budget is per scope. Default: one scope. */
  scope?: () => object | undefined;
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `inner` with this module's rules in front: the keys paced, the members lock
 * taken shared for a non-GET request to rl-b's app origin (unless this
 * process holds it exclusive: its own cases would deadlock), and the tripwire
 * on the answer. `inner` is called last, so its own timeout starts after the
 * waits.
 */
export function guardedFetch(inner: typeof fetch, d: GuardDeps): typeof fetch {
  // targetsFromEnv lists a then b: b is the second.
  const budget = d.waitBudgetMs ?? WAIT_BUDGET_MS;
  const spent = new WeakMap<object, number>();
  const global = {};
  const key = () => d.scope?.() ?? global;
  const left = (what: string): number => {
    const r = budget - (spent.get(key()) ?? 0);
    if (r <= 0)
      throw new InfraError(
        `${what}: this case has waited ${budget / 1000} s on pacing and locks, which would run it past its timeout`,
      );
    return r;
  };
  const spend = (since: number) =>
    spent.set(key(), (spent.get(key()) ?? 0) + Date.now() - since);
  const members = d.membersOrigin ?? urlOf(d.targets[1]?.app ?? "")?.origin;
  return async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const req: ReqLike = { method, url, headers };
    if (d.targets.length === 0) return inner(input, init);
    const t0 = Date.now();
    const ms = left("pacing");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        paceAnon(req, d.targets, d.claim),
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () =>
              rej(
                new InfraError(
                  `pacing: waited ${budget / 1000} s in this case, which would run it past its timeout`,
                ),
              ),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      spend(t0);
    }
    const run = async () => {
      const res = await inner(input, init);
      tripwire(req, res.status, d.targets);
      return res;
    };
    if (
      members &&
      !READS.has(method) &&
      urlOf(url)?.origin === members &&
      !holdsExclusive(MEMBERS_LOCK)
    ) {
      const t1 = Date.now();
      const tl = left("members lock");
      let waited = 0;
      return withLock(
        MEMBERS_LOCK,
        "shared",
        () => {
          waited = Date.now() - t1;
          spend(t1);
          return run();
        },
        { deadlineMs: tl },
      ).catch((e) => {
        if (!waited) spend(t1);
        throw e;
      });
    }
    return run();
  };
}
