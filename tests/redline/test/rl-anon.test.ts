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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimHookSlot,
  HOOK_LIMIT,
  HOOK_WINDOW_MS,
  hookWindowCount,
} from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";
import { InfraError } from "../src/fetch-timeout.ts";
import { LOCK_DIR_ENV, withLock } from "../src/locks.ts";
import {
  type AnonTarget,
  anonKeys,
  classify,
  guardedFetch,
  KEY_TABLE,
  ledgerClaimWith,
  liveTargetsFromEnv,
  MEMBERS_LOCK,
  paceAnon,
  pacingNote,
  phaseScopes,
  resetPacingStats,
  targetsFromEnv,
  tripwire,
  WAIT_BUDGET_MS,
} from "../src/rl-anon.ts";

const A: AnonTarget = {
  name: "rl-a",
  installId: "iaaaaaaaaaaa",
  app: "https://rl-a.open-artifacts-staging.app",
  content: "https://rl-a.open-artifacts-staging.page",
};
const B: AnonTarget = {
  name: "rl-b",
  installId: "ibbbbbbbbbbb",
  app: "https://rl-b.open-artifacts-staging.app",
  content: "https://rl-b.open-artifacts-staging.page",
};
const T = [A, B];
const req = (
  method: string,
  url: string,
  headers: Record<string, string> = {},
) => ({ method, url, headers: new Headers(headers) });

describe("anonKeys: what a request spends", () => {
  it.each([
    ["POST", `${A.app}/oauth/register`, {}, ["reg:ip"]],
    ["POST", `${B.app}/oauth/register`, {}, ["reg:ip"]],
    ["POST", `${A.app}/oauth/token`, {}, ["tok:ip"]],
    [
      "GET",
      `${A.app}/oauth/authorize?x=1`,
      { cookie: "s=1" },
      [`consent:u:${A.installId}`],
    ],
    [
      "GET",
      `${B.app}/oauth/authorize`,
      { cookie: "s=1" },
      [`consent:u:${B.installId}`],
    ],
    ["GET", `${A.app}/oauth/authorize`, {}, []],
    ["POST", `${A.app}/bus/device`, {}, ["bus-dev:ip"]],
    ["POST", `${A.app}/bus/device/token`, {}, ["bus-tok:ip"]],
    ["POST", `${A.app}/bus/approve`, {}, ["bus-code:ip"]],
    [
      "POST",
      `${A.app}/bus/approve`,
      { cookie: "s=1" },
      [
        "bus-code:ip",
        `bus-approve:u:${A.installId}`,
        `bus-code:u:${A.installId}`,
      ],
    ],
    [
      "PUT",
      `${A.app}/api/v1/bus/roles`,
      { cookie: "s=1" },
      [`bus-write:u:${A.installId}`],
    ],
    ["GET", `${A.app}/api/v1/bus/roles`, { cookie: "s=1" }, []],
    ["GET", `${A.app}/api/v1/artifacts/abc/data-subscribe`, {}, ["sub:ip"]],
    ["GET", `${A.app}/api/v1/artifacts/abc/events`, {}, ["ev:ip"]],
    ["GET", `${A.app}/api/v1/artifacts/abc/anon-id`, {}, ["anonid:ip"]],
    ["PUT", `${A.app}/api/v1/artifacts/abc/data/c/d`, {}, ["ip"]],
    ["POST", `${A.app}/api/v1/artifacts/abc/data/c/query`, {}, ["ip"]],
    ["GET", `${A.app}/api/v1/artifacts/abc/data/c/d`, {}, []],
    // Signed in: no anonymous key; the embed header makes any call anonymous.
    ["PUT", `${A.app}/api/v1/artifacts/abc/data/c/d`, { cookie: "s=1" }, []],
    [
      "PUT",
      `${A.app}/api/v1/artifacts/abc/data/c/d`,
      { cookie: "s=1", "x-oa-embed": "1" },
      ["ip"],
    ],
    [
      "GET",
      `${A.app}/api/v1/artifacts/abc/data-subscribe`,
      { authorization: "Bearer x" },
      [],
    ],
    // Not ours: never paced.
    ["POST", "https://example.com/oauth/token", {}, []],
    ["POST", "https://auth.open-artifacts-staging.app/oauth/token", {}, []],
  ] as [string, string, Record<string, string>, string[]][])(
    "%s %s %j",
    (m, url, h, want) => {
      expect(anonKeys(req(m, url, h), T)).toEqual(want);
    },
  );

  it("key names carry no install where rl-a and rl-b share the bucket", () => {
    const a = anonKeys(req("POST", `${A.app}/oauth/token`), T);
    const b = anonKeys(req("POST", `${B.app}/oauth/token`), T);
    expect(a).toEqual(b);
  });

  it("every paced key the table gives a request has a row in KEY_TABLE", () => {
    const all = [
      ...anonKeys(req("POST", `${A.app}/oauth/register`), T),
      ...anonKeys(req("POST", `${A.app}/oauth/token`), T),
      ...anonKeys(req("GET", `${A.app}/oauth/authorize`, { cookie: "a=b" }), T),
      ...anonKeys(req("GET", `${A.app}/api/v1/artifacts/x/events`), T),
    ];
    for (const k of all)
      expect(
        Object.keys(KEY_TABLE).some(
          (p) => `${k}:`.startsWith(p) || k.startsWith(p),
        ),
        k,
      ).toBe(true);
  });
});

describe("paceAnon", () => {
  it("claims one ledger per key, in order, and nothing for an unpaced request", async () => {
    const claimed: string[] = [];
    const claim = async (k: string) => {
      claimed.push(k);
    };
    expect(
      await paceAnon(
        req("POST", `${A.app}/bus/approve`, { cookie: "a=b" }),
        T,
        claim,
      ),
    ).toHaveLength(3);
    expect(claimed).toEqual([
      "bus-code:ip",
      `bus-approve:u:${A.installId}`,
      `bus-code:u:${A.installId}`,
    ]);
    claimed.length = 0;
    await paceAnon(req("GET", `${A.app}/api/v1/me`), T, claim);
    expect(claimed).toEqual([]);
  });
});

describe("the pacing note", () => {
  it("counts each key's claims and the hook calls, per file", async () => {
    resetPacingStats();
    await paceAnon(req("POST", `${A.app}/oauth/token`), T, async () => {});
    await paceAnon(req("POST", `${B.app}/oauth/token`), T, async () => {});
    await paceAnon(req("POST", `${A.app}/oauth/register`), T, async () => {});
    expect(pacingNote("live/x.test.ts", "creds")).toMatch(
      /^pacing \(lane creds, live\/x.test.ts\): 0 hook claim\(s\), 3 RL_ANON claim\(s\) \(reg:ip 1, tok:ip 2\), waited \d+\.\d s in all$/,
    );
    resetPacingStats();
  });
});

describe("the tripwire", () => {
  it("raises on an unclassified 429, naming the route", () => {
    expect(() =>
      tripwire(req("GET", `${A.app}/api/v1/artifacts`), 429, T),
    ).toThrow(InfraError);
    expect(() =>
      tripwire(req("POST", `${B.app}/api/v1/spaces`), 429, T),
    ).toThrow(
      /unclassified 429 from rl-b.open-artifacts-staging.app on POST \/api\/v1\/spaces/,
    );
  });

  it("is quiet for classified routes, hooks, codes, other hosts and other statuses", () => {
    for (const r of [
      req("POST", `${A.app}/oauth/token`),
      req("POST", `${A.app}/__test/session`),
      req("POST", `${A.app}/auth/code/request`),
      req("POST", `${B.app}/auth/code/verify`),
      req("POST", "https://example.com/x"),
    ])
      expect(() => tripwire(r, 429, T)).not.toThrow();
    expect(() =>
      tripwire(req("GET", `${A.app}/api/v1/artifacts`), 200, T),
    ).not.toThrow();
    expect(() =>
      tripwire(req("GET", `${A.app}/api/v1/artifacts`), 404, T),
    ).not.toThrow();
  });

  it("classify says what is known", () => {
    expect(classify(req("GET", `${A.app}/api/v1/artifacts`), T)).toEqual({
      keys: [],
      known: false,
    });
    expect(classify(req("POST", `${A.app}/oauth/token`), T).known).toBe(true);
  });
});

describe("guardedFetch", () => {
  let lockDir: string;
  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), "rl-anon-"));
    process.env[LOCK_DIR_ENV] = lockDir;
  });
  afterEach(() => {
    delete process.env[LOCK_DIR_ENV];
    rmSync(lockDir, { recursive: true, force: true });
  });

  const answer = (status: number) => async () => new Response("x", { status });

  it("paces before the request goes out, so the request's own timeout starts after the wait", async () => {
    const events: string[] = [];
    const f = guardedFetch(
      (async () => {
        events.push("fetch");
        return new Response("ok");
      }) as typeof fetch,
      {
        targets: T,
        claim: async (k) => {
          events.push(`claim ${k}`);
        },
      },
    );
    await f(`${A.app}/oauth/token`, { method: "POST" });
    expect(events).toEqual(["claim tok:ip", "fetch"]);
  });

  it("raises the tripwire on an unclassified 429 and passes a classified one through", async () => {
    const f = guardedFetch(answer(429) as typeof fetch, {
      targets: T,
      claim: async () => {},
    });
    await expect(f(`${A.app}/api/v1/artifacts`)).rejects.toBeInstanceOf(
      InfraError,
    );
    expect((await f(`${A.app}/oauth/token`, { method: "POST" })).status).toBe(
      429,
    );
  });

  it("takes the members lock shared for a non-GET to rl-b's app origin, and only then", async () => {
    const seen: string[][] = [];
    const inner = (async () => {
      seen.push(
        existsSync(join(lockDir, MEMBERS_LOCK))
          ? readdirSync(join(lockDir, MEMBERS_LOCK))
          : [],
      );
      return new Response("ok");
    }) as typeof fetch;
    const f = guardedFetch(inner, { targets: T, claim: async () => {} });
    await f(`${B.app}/api/v1/artifacts`, { method: "POST" });
    await f(`${B.app}/api/v1/artifacts`);
    await f(`${A.app}/api/v1/artifacts`, { method: "POST" });
    await f(`${B.content}/x`, { method: "POST" });
    expect(seen[0]?.some((n) => n.startsWith("r."))).toBe(true);
    expect(seen[1]).toEqual([]);
    expect(seen[2]).toEqual([]);
    expect(seen[3]).toEqual([]);
    expect(readdirSync(join(lockDir, MEMBERS_LOCK))).toEqual([]);
  });

  it("a holder of the exclusive lock does not wait on itself", async () => {
    const f = guardedFetch(answer(200) as typeof fetch, {
      targets: T,
      claim: async () => {},
    });
    const res = await withLock(MEMBERS_LOCK, "exclusive", () =>
      f(`${B.app}/api/v1/artifacts`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
  });

  it("does nothing when there are no targets", async () => {
    const f = guardedFetch(answer(429) as typeof fetch, { targets: [] });
    expect((await f("https://anything.test/x")).status).toBe(429);
  });
});

describe("targetsFromEnv", () => {
  it("reads a and b from REDLINE_TARGETS, none for local mode, unset or junk", () => {
    const json = JSON.stringify({ mode: "staging", a: A, b: B });
    expect(targetsFromEnv({ REDLINE_TARGETS: json }).map((t) => t.app)).toEqual(
      [A.app, B.app],
    );
    expect(
      targetsFromEnv({
        REDLINE_TARGETS: JSON.stringify({ mode: "local", a: A, b: B }),
      }),
    ).toEqual([]);
    expect(targetsFromEnv({})).toEqual([]);
    expect(targetsFromEnv({ REDLINE_TARGETS: "{" })).toEqual([]);
  });
});

describe("liveTargetsFromEnv fails closed", () => {
  const ok = JSON.stringify({ mode: "staging", a: A, b: B });
  it("reads a and b; local mode is none", () => {
    expect(
      liveTargetsFromEnv({ REDLINE_TARGETS: ok }).map((t) => t.app),
    ).toEqual([A.app, B.app]);
    expect(
      liveTargetsFromEnv({
        REDLINE_TARGETS: JSON.stringify({ mode: "local", a: A, b: B }),
      }),
    ).toEqual([]);
  });
  it.each([
    ["unset", {}, /not set/],
    ["not JSON", { REDLINE_TARGETS: "{" }, /not JSON/],
    ["JSON null", { REDLINE_TARGETS: "null" }, /not a JSON object/],
    [
      "a without app",
      { REDLINE_TARGETS: JSON.stringify({ a: { content: A.content }, b: B }) },
      /REDLINE_TARGETS\.a needs app and content/,
    ],
    [
      "b without content",
      { REDLINE_TARGETS: JSON.stringify({ a: A, b: { app: B.app } }) },
      /REDLINE_TARGETS\.b needs app and content/,
    ],
    [
      "b missing",
      { REDLINE_TARGETS: JSON.stringify({ mode: "staging", a: A }) },
      /REDLINE_TARGETS\.b needs/,
    ],
  ])("%s throws InfraError", (_n, env, re) => {
    let err: unknown;
    try {
      liveTargetsFromEnv(env);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InfraError);
    expect((err as Error).message).toMatch(re);
  });
});

describe("waits stay under the case timeout", () => {
  const answer = (status: number) => async () => new Response("x", { status });
  it("a pacing wait past the budget is an InfraError, not a hang", async () => {
    const f = guardedFetch(answer(200) as typeof fetch, {
      targets: T,
      claim: () => new Promise<void>(() => {}),
      waitBudgetMs: 30,
    });
    await expect(f(`${A.app}/oauth/token`, { method: "POST" })).rejects.toThrow(
      /infra: pacing: this case has waited/,
    );
  });
  it("waits already spent in a case use up its budget", async () => {
    const scope = {};
    const f = guardedFetch(answer(200) as typeof fetch, {
      targets: T,
      claim: () => new Promise<void>((r) => setTimeout(r, 40)),
      waitBudgetMs: 50,
      scope: () => scope,
    });
    await f(`${A.app}/oauth/token`, { method: "POST" });
    await expect(f(`${A.app}/oauth/token`, { method: "POST" })).rejects.toThrow(
      /infra: pacing: this case has waited/,
    );
    await expect(f(`${A.app}/oauth/token`, { method: "POST" })).rejects.toThrow(
      /infra: pacing: this case has waited/,
    );
    // another case starts with a full budget
    const other = guardedFetch(answer(200) as typeof fetch, {
      targets: T,
      claim: async () => {},
      waitBudgetMs: 50,
      scope: () => ({}),
    });
    expect(
      (await other(`${A.app}/oauth/token`, { method: "POST" })).status,
    ).toBe(200);
  });
  it("a members lock held by another process is an InfraError within the budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-anon-wait-"));
    process.env[LOCK_DIR_ENV] = dir;
    try {
      mkdirSync(join(dir, MEMBERS_LOCK), { recursive: true });
      // pid 1 is alive and is not ours: a writer that never leaves.
      writeFileSync(join(dir, MEMBERS_LOCK, "wi.other"), "1");
      const f = guardedFetch(answer(200) as typeof fetch, {
        targets: T,
        claim: async () => {},
        waitBudgetMs: 150,
      });
      await expect(
        f(`${B.app}/api/v1/artifacts`, { method: "POST" }),
      ).rejects.toThrow(/infra: lock .*not free/);
    } finally {
      delete process.env[LOCK_DIR_ENV];
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("the budget stays under the 180 s case timeout", () => {
    expect(WAIT_BUDGET_MS).toBeLessThan(180_000);
  });
});

// --- cloud #24: the wait-budget follow-ups --------------------------------

describe("wait budget follow-ups (cloud #24)", () => {
  const answer = (status: number) => async () => new Response("x", { status });
  const post = (f: typeof fetch, host = A.app) =>
    f(`${host}/oauth/token`, { method: "POST" });

  describe("1. a claim that lost the race never takes a slot", () => {
    it("guardedFetch aborts the claim's signal when the budget runs out", async () => {
      let seen: AbortSignal | undefined;
      const f = guardedFetch(answer(200) as typeof fetch, {
        targets: T,
        claim: (_k, signal) =>
          new Promise<void>(() => {
            seen = signal;
          }),
        waitBudgetMs: 20,
      });
      await expect(post(f)).rejects.toThrow(
        /infra: pacing: this case has waited/,
      );
      expect(seen).toBeDefined();
      expect(seen?.aborted).toBe(true);
    });

    it("paceAnon takes no further key's slot once told to stop", async () => {
      const taken: string[] = [];
      const c = new AbortController();
      // A request that spends three keys; the first claim aborts the signal.
      const r = req("POST", `${A.app}/bus/approve`, { cookie: "s=1" });
      expect(anonKeys(r, T).length).toBeGreaterThanOrEqual(2);
      await expect(
        paceAnon(
          r,
          T,
          async (k) => {
            taken.push(k);
            c.abort();
          },
          c.signal,
        ),
      ).rejects.toThrow(/aborted before a slot was taken/);
      expect(taken).toHaveLength(1);
      // Already aborted before the first claim: nothing is taken.
      taken.length = 0;
      await expect(
        paceAnon(r, T, async (k) => void taken.push(k), c.signal),
      ).rejects.toThrow(/aborted before a slot was taken/);
      expect(taken).toEqual([]);
    });

    it("the ledger claim stops waiting on abort and leaves the ledger as it was", async () => {
      const root = mkdtempSync(join(tmpdir(), "rl-anon-ledger-"));
      try {
        let now = 1_000_000;
        // The ledger for tok:ip is full: a new claim has to sleep.
        for (let i = 0; i < HOOK_LIMIT; i++)
          await claimHookSlot("rl-anon/tok:ip", { root, now: () => now });
        expect(
          hookWindowCount("rl-anon/tok:ip", { root, now: () => now }),
        ).toBe(HOOK_LIMIT);
        let wake: () => void = () => {};
        const claim = ledgerClaimWith({
          root,
          now: () => now,
          sleep: () => new Promise<void>((r) => (wake = r)),
        });
        const c = new AbortController();
        const pending = claim("tok:ip", c.signal);
        c.abort();
        await expect(pending).rejects.toThrow(
          /aborted before a slot was taken/,
        );
        // The window passes and the underlying sleep ends: a claim that kept
        // going would now take a slot for the request that was never sent.
        now += HOOK_WINDOW_MS + 1_000;
        wake();
        await new Promise((r) => setImmediate(r));
        expect(
          hookWindowCount("rl-anon/tok:ip", { root, now: () => now }),
        ).toBe(0);
        // An already aborted signal never claims at all.
        await expect(claim("tok:ip", c.signal)).rejects.toThrow(
          /aborted before a slot was taken/,
        );
        expect(
          hookWindowCount("rl-anon/tok:ip", { root, now: () => now }),
        ).toBe(0);
        // And without a signal it claims as before.
        await claim("tok:ip");
        expect(
          hookWindowCount("rl-anon/tok:ip", { root, now: () => now }),
        ).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("1b. an aborted claim leaves no timer armed", () => {
    it("the claim's own sleep timer is cleared on abort", async () => {
      const root = mkdtempSync(join(tmpdir(), "rl-anon-timer-"));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const now = () => 1_000_000;
        for (let i = 0; i < HOOK_LIMIT; i++)
          await claimHookSlot("rl-anon/tok:ip", { root, now });
        // No sleep seam: the default timer, which has to be cleared.
        const claim = ledgerClaimWith({ root, now });
        const c = new AbortController();
        const pending = claim("tok:ip", c.signal);
        expect(vi.getTimerCount()).toBe(1);
        c.abort();
        await expect(pending).rejects.toThrow(/aborted before a slot/);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("2. hooks get a budget per phase, not one per file", () => {
    it("phaseScopes hands out one scope until reset, a new one after", () => {
      const p = phaseScopes();
      const first = p.current();
      expect(p.current()).toBe(first);
      p.reset();
      expect(p.current()).not.toBe(first);
    });

    it("two phases each spend most of a budget; one shared scope would run out", async () => {
      const slow = () => new Promise<void>((r) => setTimeout(r, 40));
      const phase = phaseScopes();
      const split = guardedFetch(answer(200) as typeof fetch, {
        targets: T,
        claim: slow,
        waitBudgetMs: 60,
        scope: () => phase.current(),
      });
      await post(split);
      phase.reset();
      // A fresh phase has the whole budget again.
      expect((await post(split)).status).toBe(200);
      // The same two requests in one scope: the second is over budget.
      const shared = guardedFetch(answer(200) as typeof fetch, {
        targets: T,
        claim: slow,
        waitBudgetMs: 60,
        scope: () => phase.current(),
      });
      await post(shared);
      await expect(post(shared)).rejects.toThrow(/infra: pacing: this case/);
    });

    it("live/setup.ts scopes hooks by phase: a scope per beforeAll and per test end", () => {
      const src = readFileSync(
        join(import.meta.dirname, "../live/setup.ts"),
        "utf8",
      );
      expect(src).toMatch(/const phase = phaseScopes\(\);/);
      expect(src).toMatch(/beforeAll\(\(\) => phase\.reset\(\)\);/);
      expect(src).toMatch(/afterEach\(\(\) => phase\.reset\(\)\);/);
      expect(src).toMatch(
        /scope: \(\) => getCurrentTest\(\) \?\? phase\.current\(\)/,
      );
    });
  });

  describe("3. a request's own time is never charged as wait", () => {
    it("a lock taken at once, then a request that runs long and fails: the budget is intact", async () => {
      const dir = mkdtempSync(join(tmpdir(), "rl-anon-lock-"));
      process.env[LOCK_DIR_ENV] = dir;
      try {
        const scope = {};
        let calls = 0;
        const f = guardedFetch(
          (async () => {
            calls++;
            // The request itself takes longer than the whole budget, then fails.
            await new Promise((r) => setTimeout(r, 70));
            throw new Error("socket hang up");
          }) as typeof fetch,
          {
            targets: T,
            claim: async () => {},
            waitBudgetMs: 50,
            scope: () => scope,
          },
        );
        const write = () => f(`${B.app}/api/v1/artifacts`, { method: "POST" });
        await expect(write()).rejects.toThrow(/socket hang up/);
        // Charged as wait, the 70 ms would have used up the 50 ms budget and
        // this retry would fail as infra before it left.
        await expect(write()).rejects.toThrow(/socket hang up/);
        expect(calls).toBe(2);
      } finally {
        delete process.env[LOCK_DIR_ENV];
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("4. parallel waits are charged as wall time", () => {
    it("two fetches that wait at the same moment spend the wait once", async () => {
      const scope = {};
      const f = guardedFetch(answer(200) as typeof fetch, {
        targets: T,
        claim: () => new Promise<void>((r) => setTimeout(r, 40)),
        waitBudgetMs: 100,
        scope: () => scope,
      });
      // Together: 40 ms of wall time. Summed, 80 ms: the third fetch's own
      // 40 ms wait would then run past the 100 ms budget.
      await Promise.all([post(f), post(f)]);
      expect((await post(f)).status).toBe(200);
    });

    it("waits one after another still add up", async () => {
      const scope = {};
      const f = guardedFetch(answer(200) as typeof fetch, {
        targets: T,
        claim: () => new Promise<void>((r) => setTimeout(r, 40)),
        waitBudgetMs: 70,
        scope: () => scope,
      });
      await post(f);
      await post(f).catch(() => {});
      await expect(post(f)).rejects.toThrow(/infra: pacing: this case/);
    });

    it("WAIT_BUDGET_MS says it is wall time per scope", () => {
      const src = readFileSync(
        join(import.meta.dirname, "../src/rl-anon.ts"),
        "utf8",
      );
      const doc = src.slice(0, src.indexOf("export const WAIT_BUDGET_MS"));
      expect(doc.slice(-600)).toMatch(/wall time per scope/);
    });
  });
});

// --- drift: every key the server limits on has a row ----------------------

const serverSrc = join(import.meta.dirname, "../../../apps/server/src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The prefix of a key expression: its leading text, through the first `${...}` if it starts with one. */
function prefixOf(expr: string, text: string): string {
  const e = expr.trim();
  if (e.startsWith("`")) {
    const body = e.slice(1, e.lastIndexOf("`"));
    if (body.startsWith("${")) {
      const end = body.indexOf("}");
      const next = body.indexOf("${", end);
      return body.slice(0, next === -1 ? body.length : next);
    }
    const i = body.indexOf("${");
    return i === -1 ? body : body.slice(0, i);
  }
  const m = /^([A-Z_]+)\s*\+/.exec(e);
  if (m) {
    const c = new RegExp(`const ${m[1]} = "([^"]+)"`).exec(text);
    return c?.[1] ?? `${m[1]}?`;
  }
  return e;
}

/** Every RL_ANON / RL_AUTH key prefix a server source file limits on. */
function keyPrefixes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    /rl\.limit\(\{\s*key:\s*(`[^`]*`|[A-Z_]+\s*\+\s*[\w.]+)/g,
  ))
    out.push(prefixOf(m[1] as string, text));
  for (const m of text.matchAll(/anonLimit\(c, (`[^`]*`)/g))
    out.push(prefixOf(m[1] as string, text));
  return [...new Set(out)];
}

/** The bus's RL_KEYS values (`export const RL_KEYS = { ... "bus-dev:ip:" ... }`). */
function busKeys(text: string): string[] {
  const block =
    /export const RL_KEYS = \{([\s\S]*?)\n\} as const/.exec(text)?.[1] ?? "";
  return [...block.matchAll(/:\s*"([a-z-]+:[a-z]+:)"/g)].map(
    (m) => m[1] as string,
  );
}

describe("drift: the server's RL_ANON keys against KEY_TABLE", () => {
  it("every prefix apps/server/src limits on has a row", () => {
    expect(existsSync(serverSrc), "the overlay's apps/server/src").toBe(true);
    const found = new Map<string, string>();
    for (const f of walk(serverSrc)) {
      const text = readFileSync(f, "utf8");
      for (const p of keyPrefixes(text)) found.set(p, f);
      if (f.endsWith("bus/routes.ts"))
        for (const p of busKeys(text)) found.set(p, f);
    }
    // The scan must find the keys it is meant to (not silently match nothing).
    for (const p of [
      "reg:ip:",
      "tok:ip:",
      "consent:u:",
      "sub:ip:",
      "anonid:ip:",
      "ev:ip:",
      "ip:",
      "bus-dev:ip:",
      "bus-code:ip:",
    ])
      expect(found.has(p), `the scan finds ${p}`).toBe(true);
    const missing = [...found].filter(([p]) => !(p in KEY_TABLE));
    expect(missing.map(([p, f]) => `${p} (${f})`)).toEqual([]);
  });

  it("the scan flags a prefix the table does not list", () => {
    const text =
      'const NEW_KEY = "newthing:ip:";\nawait rl.limit({ key: NEW_KEY + ip });\nawait anonLimit(c, `fresh:ip:${key}`, "x");\nawait rl.limit({ key: `other:${id}` });';
    const found = keyPrefixes(text);
    expect(found.sort()).toEqual(["fresh:ip:", "newthing:ip:", "other:"]);
    expect(found.filter((p) => !(p in KEY_TABLE)).sort()).toEqual([
      "fresh:ip:",
      "newthing:ip:",
      "other:",
    ]);
  });

  it("every paced row is a key anonKeys can produce", () => {
    const produced = new Set([
      "reg:ip:",
      "tok:ip:",
      "consent:u:",
      "sub:ip:",
      "ev:ip:",
      "anonid:ip:",
      "ip:",
      "bus-dev:ip:",
      "bus-tok:ip:",
      "bus-approve:u:",
      "bus-code:u:",
      "bus-code:ip:",
      "bus-write:u:",
    ]);
    const paced = Object.entries(KEY_TABLE)
      .filter(([, r]) => r.paced)
      .map(([k]) => k)
      .sort();
    expect(paced).toEqual([...produced].sort());
    for (const [, r] of Object.entries(KEY_TABLE))
      expect(r.why.length).toBeGreaterThan(5);
  });
});
