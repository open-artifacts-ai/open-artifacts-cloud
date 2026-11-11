import type { Socket } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hook } from "../src/http.ts";
import { setCurrentTest, takeFileNotes } from "../src/notes.ts";
import { watchResets } from "../src/resets.ts";
import { loadTargets } from "../src/targets.ts";
import {
  freshAgent,
  IDLE_AGENT_OPTIONS,
  SOCKET_IDLE_MS,
  transportFetch,
  useShortIdleSockets,
} from "../src/transport.ts";
import { fakeServer, json, secretDir } from "./fake.ts";

// #155: the session hook is retried once on a stale (reused) socket, and the
// shared dispatcher drops sockets idle over ~1 s.

const KEY = "k".repeat(40);
const real = globalThis.fetch;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  globalThis.fetch = real;
  for (const c of cleanups.splice(0)) await c();
  takeFileNotes();
});
beforeAll(() => {
  setCurrentTest(() => undefined);
});

/** A target whose session hook resets per `reset(socketRequestNumber, path)`. */
async function install(reset: (nth: number, path: string) => boolean) {
  const hits: { path: string; socket: number; nth: number }[] = [];
  const seen = new WeakMap<Socket, { id: number; n: number }>();
  let ids = 0;
  const f = await fakeServer((req, res) => {
    if (req.url === "/healthz")
      return json(res, 200, {
        ok: true,
        plan: "free",
        version: "x",
        testHooks: true,
        installId: "rl-a-id",
      });
    const rec = seen.get(req.socket) ?? { id: ++ids, n: 0 };
    seen.set(req.socket, rec);
    rec.n++;
    const path = req.url ?? "";
    hits.push({ path, socket: rec.id, nth: rec.n });
    if (reset(rec.n, path)) return void req.socket.resetAndDestroy();
    json(res, 200, { cookie: "c" });
  });
  const other = await fakeServer((req, res) =>
    req.url === "/healthz"
      ? json(res, 200, {
          ok: true,
          plan: "free",
          version: "x",
          testHooks: true,
          installId: "rl-b-id",
        })
      : res.writeHead(404).end(),
  );
  const s = secretDir({ "a-key": KEY, "b-key": KEY });
  cleanups.push(
    () => f.close(),
    () => other.close(),
    s.cleanup,
  );
  const t = (name: string, origin: string, file: string, domain: string) => ({
    name,
    installId: `${name}-id`,
    app: origin,
    content: `http://${name}.content.localhost:1`,
    testDomain: domain,
    hookKeyFile: s.path(file),
  });
  const T = await loadTargets({
    REDLINE_TARGETS: JSON.stringify({
      mode: "local",
      a: t("rl-a", f.origin, "a-key", "oa-redline-a.fyi"),
      b: t("rl-b", other.origin, "b-key", "oa-redline-c.fyi"),
    }),
  });
  // As live/setup.ts composes it, over the real global fetch.
  globalThis.fetch = transportFetch(real, watchResets());
  return { T, hits };
}

const retried = () =>
  takeFileNotes().filter((n) => n.startsWith("request retried: "));

describe("the session hook is idempotent (#155)", () => {
  it("a reset on a reused socket is retried once on a new socket and recovers", async () => {
    const { T, hits } = await install(
      (nth, path) => path === "/__test/session" && nth > 1,
    );
    await hook(T.a, "/__test/session", {});
    // undici hands the socket back to its pool within a turn of the loop.
    await new Promise((r) => setImmediate(r));
    await hook(T.a, "/__test/session", {});
    const tries = hits.filter((h) => h.path === "/__test/session");
    expect(tries).toHaveLength(3);
    expect(tries[1]).toMatchObject({ socket: 1, nth: 2 });
    expect(tries[2]).toMatchObject({ nth: 1 });
    expect(tries[2]?.socket).not.toBe(1);
    expect(retried()).toHaveLength(1);
  });

  it("a reset on a new socket is not retried", async () => {
    const { T, hits } = await install((_n, path) => path === "/__test/session");
    await expect(hook(T.a, "/__test/session", {})).rejects.toThrow();
    expect(hits.filter((h) => h.path === "/__test/session")).toHaveLength(1);
    expect(retried()).toEqual([]);
  });

  it("another hook is still never retried", async () => {
    const { T, hits } = await install(
      (nth, path) => path === "/__test/x" && nth > 1,
    );
    await hook(T.a, "/__test/session", {});
    await new Promise((r) => setImmediate(r));
    await expect(hook(T.a, "/__test/x", {})).rejects.toThrow();
    expect(hits.filter((h) => h.path === "/__test/x")).toHaveLength(1);
  });
});

describe("the shared dispatcher drops sockets idle over ~1 s (#155)", () => {
  class Rec {
    static opts: unknown[] = [];
    constructor(o?: unknown) {
      Rec.opts.push(o);
    }
    close() {
      return Promise.resolve();
    }
  }
  const KEY_SYM = Symbol.for("undici.globalDispatcher.1");
  const g = globalThis as Record<symbol, unknown>;

  it("sets keepAliveTimeout and keepAliveMaxTimeout to 1000 ms", () => {
    expect(SOCKET_IDLE_MS).toBe(1000);
    expect(IDLE_AGENT_OPTIONS).toEqual({
      keepAliveTimeout: 1000,
      keepAliveMaxTimeout: 1000,
    });
  });

  it("useShortIdleSockets installs a new Agent of the global's class with those options", async () => {
    const before = g[KEY_SYM];
    Rec.opts = [];
    g[KEY_SYM] = new Rec();
    try {
      expect(await useShortIdleSockets()).toBe(true);
      expect(Rec.opts.at(-1)).toEqual(IDLE_AGENT_OPTIONS);
      expect(g[KEY_SYM]).toBeInstanceOf(Rec);
      expect(g[KEY_SYM]).not.toBe(before);
      // The retry's agent keeps the same bound.
      expect(freshAgent()).toBeInstanceOf(Rec);
      expect(Rec.opts.at(-1)).toEqual(IDLE_AGENT_OPTIONS);
    } finally {
      g[KEY_SYM] = before;
    }
  });

  it("leaves the default when the global dispatcher takes no options", async () => {
    const before = g[KEY_SYM];
    g[KEY_SYM] = new (class {
      constructor(o?: unknown) {
        if (o) throw new Error("no options");
      }
    })();
    const set = g[KEY_SYM];
    try {
      expect(await useShortIdleSockets()).toBe(false);
      expect(g[KEY_SYM]).toBe(set);
    } finally {
      g[KEY_SYM] = before;
    }
  });
});
