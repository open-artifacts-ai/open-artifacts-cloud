import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ControlStats,
  coloOfTrace,
  controlProbeFor,
  controlSummary,
  controlUrlFromEnv,
  createControlProbe,
  failCodeOf,
  nearSummary,
  type ProbeSend,
  resetTimesMs,
} from "../src/edge-probe.ts";
import { setCurrentTest, takeFileNotes } from "../src/notes.ts";
import { buildReport, edgeSummary, formatReport } from "../src/report.ts";
import { validRay, watchResets } from "../src/resets.ts";

// Evidence only (src/resets.ts, src/edge-probe.ts): none of it may change a
// verdict. Pinned clocks, a fake wire for the probe, no real sleeps.

const RAY = "8f1c2d3e4a5b6c7d-IAD";

describe("ray capture on resets", () => {
  let origin = "";
  let t = 1_000_000;
  const start = 1_000_000;
  // The pinned clock: only moved by the test.
  const watch = watchResets(() => t, start);
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/cut")) {
      req.socket.destroy();
      return;
    }
    const ray = req.url?.startsWith("/ray/") ? req.url.slice(5) : undefined;
    if (ray) res.setHeader("cf-ray", decodeURIComponent(ray));
    res.end("ok");
  });

  beforeAll(async () => {
    setCurrentTest(() => undefined);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const get = async (path: string) => {
    const r = await fetch(`${origin}${path}`);
    await r.text();
    // Lets undici return the socket to its pool: the next request reuses it
    // (a signal, not a sleep).
    await new Promise(setImmediate);
  };

  it("the reset note names the last ray on its socket, how long before, and when it happened", async () => {
    server.closeAllConnections();
    t = start + 70_000;
    await get(`/ray/${RAY}`);
    t += 412;
    await expect(get("/cut")).rejects.toThrow("fetch failed");
    const [n = "", ...rest] = takeFileNotes();
    expect(rest).toEqual([]);
    expect(n).toMatch(
      /^reset: \S+ GET \/cut host [0-9a-f]{8}, reused socket, idle 412 ms, request 2 on it; at 70\.4 s; last ray 8f1c2d3e4a5b6c7d-IAD 412 ms earlier$/,
    );
  });

  it("a reset on a socket that saw no ray says so", async () => {
    server.closeAllConnections();
    t = start + 1_000;
    await get("/plain");
    await expect(get("/cut")).rejects.toThrow("fetch failed");
    expect(takeFileNotes()[0]).toMatch(
      /request 2 on it; at 1\.0 s; no ray seen$/,
    );
  });

  it("a reset before any request on its socket also says no ray seen", async () => {
    server.closeAllConnections();
    await expect(get("/cut")).rejects.toThrow("fetch failed");
    expect(takeFileNotes()[0]).toMatch(
      /, new socket; at \d+\.\d s; no ray seen$/,
    );
  });

  it("a ray is per socket: another socket's ray is not named", async () => {
    server.closeAllConnections();
    await get(`/ray/${RAY}`);
    server.closeAllConnections();
    await expect(get("/cut")).rejects.toThrow("fetch failed");
    expect(takeFileNotes()[0]).toMatch(
      /new socket; at \d+\.\d s; no ray seen$/,
    );
  });

  it("drops a header that is not a ray, and never logs it", async () => {
    server.closeAllConnections();
    await get("/ray/not-a-ray");
    await get("/ray/8f1c2d3e4a5b6c7d-iad");
    await get(`/ray/${encodeURIComponent("abc")}`);
    await expect(get("/cut")).rejects.toThrow("fetch failed");
    const n = takeFileNotes()[0] ?? "";
    expect(n).toMatch(/no ray seen$/);
    expect(n).not.toMatch(/not-a-ray|iad|abc/);
  });

  it("counts responses per edge location, most first; the note is `edge: ...`", async () => {
    server.closeAllConnections();
    const other = watchResets(() => t, start);
    await get("/ray/00aa11bb22cc33dd-EWR");
    await get("/ray/00aa11bb22cc33de-EWR");
    const e = other.edge();
    expect(e).toBe("edge: EWR 2");
    // The first watch also saw the IAD responses of the tests above.
    expect(watch.edge()).toBe("edge: EWR 2, IAD 2");
    takeFileNotes();
  });
});

describe("validRay", () => {
  it("accepts <8-32 lowercase hex>-<3 capitals> only", () => {
    expect(validRay(RAY)).toBe(RAY);
    expect(validRay("8f1c2d3e-EWR")).toBe("8f1c2d3e-EWR");
    expect(validRay(`${"a".repeat(32)}-SEA`)).toBeDefined();
    for (const bad of [
      "",
      "abc-IAD",
      `${"a".repeat(33)}-IAD`,
      "8f1c2d3e4a5b6c7d-iad",
      "8f1c2d3e4a5b6c7d-IADX",
      "8F1C2D3E4A5B6C7D-IAD",
      "8f1c2d3e4a5b6c7d",
      "8f1c2d3e4a5b6c7d-IAD\nSet-Cookie: x=1",
      "ghijklmn-IAD",
      undefined,
      42,
    ])
      expect(validRay(bad)).toBeUndefined();
  });
});

describe("edgeSummary", () => {
  it("adds the files' edge notes, most requests first", () => {
    expect(
      edgeSummary([
        "edge: IAD 2000, EWR 100",
        "reset: ECONNRESET GET /x host aa, new socket",
        "edge: IAD 310, EWR 50",
      ]),
    ).toBe("Edge: IAD 2310, EWR 150");
    expect(
      edgeSummary(["connections: 1 requests, 1 on new sockets"]),
    ).toBeUndefined();
  });
});

// A fake wire and a pinned clock. Failures carry what the real send sets.
const trace = "fl=1\nip=203.0.113.9\ncolo=IAD\nhttp=http/1.1\nloc=US\n";

function wire(script: (n: number, keepAlive: boolean) => unknown) {
  const calls: { url: string; keepAlive: boolean; timeoutMs: number }[] = [];
  const send: ProbeSend = async (url, o) => {
    calls.push({ url, keepAlive: o.keepAlive, timeoutMs: o.timeoutMs });
    const r = script(calls.length, o.keepAlive);
    if (r instanceof Error) throw r;
    return r as { status: number; body: string; reused: boolean };
  };
  return { send, calls };
}
const okAnswer = (keepAlive: boolean, n: number) => ({
  status: 200,
  body: trace,
  reused: keepAlive && n > 1,
});
const reset = (reused: boolean) =>
  Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", reused });

describe("control probe", () => {
  const url = "https://rl-a.example.test/cdn-cgi/trace";

  it("counts sent and ok, alternates kept-alive and new sockets, reads only the colo", async () => {
    let now = 5_000;
    const w = wire((n, k) => okAnswer(k, n));
    const p = createControlProbe(url, {
      send: w.send,
      now: () => now,
      startMs: 5_000,
    });
    for (let i = 0; i < 4; i++) {
      now += 1000;
      await p.tick();
    }
    const s = p.stats();
    expect(s.sent).toBe(4);
    expect(s.ok).toBe(4);
    expect(s.colos).toEqual(["IAD"]);
    expect(w.calls.map((c) => c.keepAlive)).toEqual([true, false, true, false]);
    expect(w.calls.every((c) => c.timeoutMs === 5000 && c.url === url)).toBe(
      true,
    );
    const text = JSON.stringify(s) + controlSummary(s);
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toContain("ip=");
    p.stop();
  });

  it("records failures by code and socket kind, with their time since the suite start", async () => {
    let now = 10_000;
    const script = [
      (k: boolean, n: number) => okAnswer(k, n),
      () => reset(true),
      () => reset(true),
      () => Object.assign(new Error("t"), { name: "TimeoutError" }),
      () => ({ status: 503, body: "", reused: false }),
      () => new Error("boom"),
    ];
    const w = wire((n, k) => script[n - 1]?.(k, n));
    const p = createControlProbe(url, {
      send: w.send,
      now: () => now,
      startMs: 10_000,
    });
    for (let i = 0; i < 6; i++) {
      now = 10_000 + (i === 0 ? 0 : 73_100 + (i - 1) * 300);
      await p.tick();
    }
    const s = p.stats();
    expect(s.sent).toBe(6);
    expect(s.ok).toBe(1);
    expect(s.by.ECONNRESET).toEqual({ reused: 2, fresh: 0 });
    expect(s.by.timeout).toEqual({ reused: 0, fresh: 1 });
    expect(s.by.other).toEqual({ reused: 0, fresh: 2 });
    expect(s.failures.map((f) => f.atMs)).toEqual([
      73_100, 73_400, 73_700, 74_000, 74_300,
    ]);
    p.stop();
  });

  it("the summary line", () => {
    const s: ControlStats = {
      sent: 362,
      ok: 360,
      by: {
        ECONNRESET: { reused: 2, fresh: 0 },
        timeout: { reused: 0, fresh: 0 },
        other: { reused: 0, fresh: 0 },
      },
      failures: [
        { atMs: 73_100, code: "ECONNRESET", reused: true },
        { atMs: 73_400, code: "ECONNRESET", reused: true },
      ],
      colos: ["IAD"],
    };
    expect(controlSummary(s)).toBe(
      "Control: 362 sent, 360 ok, 2 reset (2 reused, 0 new) at 73.1 s and 73.4 s; colo IAD",
    );
    expect(
      controlSummary({
        ...s,
        ok: 362,
        by: { ...s.by, ECONNRESET: { reused: 0, fresh: 0 } },
        failures: [],
      }),
    ).toBe("Control: 362 sent, 362 ok; colo IAD");
  });

  it("never throws or rejects, whatever the wire does", async () => {
    const weird = [undefined, null, 42, "x", { status: "200" }, { body: 1 }];
    const w = wire((n) => (weird[n - 1] as unknown) ?? new Error("x"));
    const p = createControlProbe(url, { send: w.send });
    for (let i = 0; i < 8; i++) await expect(p.tick()).resolves.toBeUndefined();
    expect(p.stats().sent).toBe(8);
    expect(p.stats().ok).toBe(0);
    p.stop();
    // A throwing clock is not the suite's problem either.
    const q = createControlProbe(url, {
      send: wire(() => reset(false)).send,
      now: () => {
        throw new Error("clock");
      },
      startMs: 0,
    });
    await expect(q.tick()).resolves.toBeUndefined();
    q.stop();
  });

  it("stop() ends it: no more samples, a request in flight is aborted and not counted", async () => {
    let release: () => void = () => {};
    let seenSignal: AbortSignal | undefined;
    const send: ProbeSend = (_u, o) => {
      seenSignal = o.signal;
      return new Promise((_res, rej) => {
        release = () => rej(o.signal.reason);
        o.signal.addEventListener("abort", release, { once: true });
      });
    };
    const p = createControlProbe(url, { send });
    const pending = p.tick();
    expect(seenSignal?.aborted).toBe(false);
    const final = p.stop();
    await pending;
    expect(seenSignal?.aborted).toBe(true);
    expect(final.sent).toBe(1);
    expect(p.stats().by.other.fresh + p.stats().by.timeout.fresh).toBe(0);
    await p.tick();
    expect(p.stats().sent).toBe(1);
    // Stopping twice is fine.
    expect(() => p.stop()).not.toThrow();
  });

  it("start() uses an unref'd timer and stop() clears it; a slow request is not overlapped", async () => {
    let fire: () => void = () => {};
    const timer = {
      unref: () => (timer.unrefCalled = true),
      unrefCalled: false,
    };
    const cleared: unknown[] = [];
    let intervalSeen = 0;
    let finish: () => void = () => {};
    const send: ProbeSend = () =>
      new Promise((res) => {
        finish = () => res({ status: 200, body: trace, reused: false });
      });
    const p = createControlProbe(url, {
      send,
      intervalMs: 1000,
      setTimer: (f, ms) => {
        fire = f;
        intervalSeen = ms;
        return timer;
      },
      clearTimer: (t) => cleared.push(t),
    });
    p.start();
    p.start();
    expect(intervalSeen).toBe(1000);
    expect(timer.unrefCalled).toBe(true);
    fire();
    fire();
    expect(p.stats().sent).toBe(1);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    p.stop();
    expect(cleared).toEqual([timer]);
  });

  it("is off with REDLINE_CONTROL_PROBE=0, without a staging https target, and under vitest without a fake wire", () => {
    const targets = JSON.stringify({
      mode: "staging",
      a: {
        app: "https://rl-a.example.test",
        content: "https://rl-a.example.page",
      },
      b: {
        app: "https://rl-b.example.test",
        content: "https://rl-b.example.page",
      },
    });
    const on = { REDLINE_TARGETS: targets };
    const send = wire(() => reset(false)).send;
    expect(controlUrlFromEnv(on)).toBe(
      "https://rl-a.example.test/cdn-cgi/trace",
    );
    expect(controlProbeFor(on, { send })).toBeDefined();
    expect(
      controlProbeFor({ ...on, REDLINE_CONTROL_PROBE: "0" }, { send }),
    ).toBeUndefined();
    expect(controlProbeFor({ ...on, VITEST: "true" })).toBeUndefined();
    expect(controlProbeFor({ ...on, VITEST: "true" }, { send })).toBeDefined();
    expect(controlProbeFor({})).toBeUndefined();
    expect(controlProbeFor({ REDLINE_TARGETS: "not json" })).toBeUndefined();
    expect(
      controlProbeFor({ REDLINE_TARGETS: JSON.stringify({ mode: "local" }) }),
    ).toBeUndefined();
    expect(
      controlUrlFromEnv({
        REDLINE_TARGETS: JSON.stringify({
          a: { app: "http://127.0.0.1:8787" },
        }),
      }),
    ).toBeUndefined();
    // The host comes from the targets, with no path, query or userinfo.
    expect(
      controlUrlFromEnv({
        REDLINE_TARGETS: JSON.stringify({
          a: { app: "https://u:p@rl-a.example.test/x?y=1" },
        }),
      }),
    ).toBe("https://rl-a.example.test/cdn-cgi/trace");
  });

  it("coloOfTrace reads only a three-letter colo; failCodeOf classes the errors", () => {
    expect(coloOfTrace(trace)).toBe("IAD");
    expect(coloOfTrace("colo=iad\n")).toBeUndefined();
    expect(coloOfTrace("ip=1.2.3.4\n")).toBeUndefined();
    expect(failCodeOf(reset(true))).toBe("ECONNRESET");
    expect(failCodeOf({ cause: { code: "ECONNRESET" } })).toBe("ECONNRESET");
    expect(failCodeOf({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(failCodeOf({ name: "TimeoutError" })).toBe("timeout");
    expect(failCodeOf(new Error("x"))).toBe("other");
  });
});

describe("control probe, default sender, against a loopback server", () => {
  it("alternates one kept-alive socket with new ones, and classes a reset", async () => {
    const ports = new Set<number | undefined>();
    let mode: "ok" | "cut" = "ok";
    const server = createServer((req, res) => {
      ports.add(req.socket.remotePort);
      if (mode === "cut") req.socket.destroy();
      else res.end(trace);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cdn-cgi/trace`;
    const p = createControlProbe(url);
    try {
      for (let i = 0; i < 4; i++) {
        await p.tick();
        await new Promise(setImmediate);
      }
      expect(p.stats().ok).toBe(4);
      // Kept-alive requests 1 and 3 share a socket; 2 and 4 each have their own.
      expect(ports.size).toBe(3);
      expect(p.stats().colos).toEqual(["IAD"]);
      mode = "cut";
      await p.tick();
      await p.tick();
      expect(
        p.stats().by.ECONNRESET.reused + p.stats().by.ECONNRESET.fresh,
      ).toBe(2);
      expect(p.stats().sent).toBe(6);
    } finally {
      p.stop();
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("resets near a control failure", () => {
  const stats = (at: number[]): ControlStats => ({
    sent: 100,
    ok: 100 - at.length,
    by: {
      ECONNRESET: { reused: at.length, fresh: 0 },
      timeout: { reused: 0, fresh: 0 },
      other: { reused: 0, fresh: 0 },
    },
    failures: at.map((atMs) => ({ atMs, code: "ECONNRESET", reused: true })),
    colos: ["IAD"],
  });
  const note = (s: number) =>
    `reset: ECONNRESET GET /x host aa, reused socket, idle 9 ms, request 2 on it; at ${s.toFixed(1)} s; no ray seen`;

  it("counts the suite resets within 2 s of a control failure", () => {
    const notes = [
      note(73.2),
      note(74.9),
      note(80.0),
      note(10.0),
      note(75.2),
      "connections: 5 requests, 1 on new sockets",
    ];
    expect(resetTimesMs(notes)).toEqual([
      73_200, 74_900, 80_000, 10_000, 75_200,
    ]);
    expect(nearSummary(notes, stats([73_100, 73_400]))).toBe(
      "Resets near a control failure: 3 of 5",
    );
    // Exactly 2 s is near.
    expect(nearSummary([note(75.1)], stats([73_100]))).toBe(
      "Resets near a control failure: 1 of 1",
    );
  });

  it("says 0 of N when the control saw nothing, and nothing without both sides", () => {
    expect(nearSummary([note(1), note(2)], stats([]))).toBe(
      "Resets near a control failure: 0 of 2",
    );
    expect(nearSummary([], stats([1000]))).toBeUndefined();
    expect(nearSummary([note(1)], undefined)).toBeUndefined();
    expect(nearSummary([note(1)], { ...stats([]), sent: 0 })).toBeUndefined();
    // A reset note with no time (no suite start) can't be placed.
    expect(
      nearSummary(
        ["reset: ECONNRESET GET /x host aa, new socket"],
        stats([1000]),
      ),
    ).toBeUndefined();
  });

  it("the report prints the evidence lines before the gate line and changes no verdict", () => {
    const base = buildReport([
      {
        name: "f > a",
        level: "pass",
        notes: [note(73.2), "edge: IAD 10, EWR 2"],
      } as never,
    ]);
    const r = { ...base, edge: { control: stats([73_100, 73_400]) } };
    const text = formatReport(r);
    const lines = text.trimEnd().split("\n");
    expect(lines).toContain("Edge: IAD 10, EWR 2");
    expect(lines).toContain(
      "Control: 100 sent, 98 ok, 2 reset (2 reused, 0 new) at 73.1 s and 73.4 s; colo IAD",
    );
    expect(lines).toContain("Resets near a control failure: 1 of 1");
    expect(lines.at(-1)).toMatch(/^Gate: /);
    // Same verdict with and without the evidence.
    expect(r.gate).toEqual(
      buildReport([{ name: "f > a", level: "pass" } as never]).gate,
    );
  });
});
