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
import { LOCK_DIR_ENV, withLock } from "../src/locks.ts";
import {
  type AnonTarget,
  anonKeys,
  classify,
  guardedFetch,
  liveTargetsFromEnv,
  WAIT_BUDGET_MS,
  KEY_TABLE,
  MEMBERS_LOCK,
  pacingNote,
  paceAnon,
  resetPacingStats,
  targetsFromEnv,
  tripwire,
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
