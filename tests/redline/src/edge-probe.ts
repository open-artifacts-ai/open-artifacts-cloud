// Evidence for the connection resets the gate sometimes sees (#1133): a control
// that does not touch our code. While the suite runs, scripts/redline.ts sends
// one GET a second to https://<rl-a's app host>/cdn-cgi/trace. Cloudflare
// answers that path at the edge, without running our Worker, so a failure on
// it that lines up with suite resets points at the network path or the edge,
// not at us.
//
// Rules this file keeps:
// - It is a diagnostic only: it never fails the run and never throws into the
//   suite (every error is a counted sample), its timer is unref'd, and
//   stop() ends it, so scripts/redline.ts runs it in a try/finally.
// - It uses its own sockets, never the suite's pool: it alternates a
//   kept-alive socket (reused after the first request) with a fresh one, so
//   both kinds are sampled.
// - It sends nothing: no credential, cookie, token or body. The orchestrator's
//   process has no pacing ledger and no 429 tripwire (those live in the vitest
//   lanes' fetch, src/rl-anon.ts), and /cdn-cgi/ never reaches the Worker, so
//   it spends no RL_ANON key.
// - Only the `colo=` line of the trace answer is read. The rest (it holds the
//   runner's IP) is never kept, logged or reported.
import http from "node:http";
import https from "node:https";

export type FailCode = "ECONNRESET" | "timeout" | "other";
export const FAIL_CODES: readonly FailCode[] = [
  "ECONNRESET",
  "timeout",
  "other",
];

export interface ControlFailure {
  /** Milliseconds since the suite started. */
  atMs: number;
  code: FailCode;
  reused: boolean;
}

/** What the probe saw, as the report keeps it. */
export interface ControlStats {
  sent: number;
  ok: number;
  /** Failures by code, split by the kind of socket. */
  by: Record<FailCode, { reused: number; fresh: number }>;
  /** Each failure's time (the first MAX_FAILURES). */
  failures: ControlFailure[];
  /** The edge locations the trace named, in the order first seen. */
  colos: string[];
}

/** The note src/resets.ts keeps per file: edge locations seen and response counts. */
export const EDGE_PREFIX = "edge: ";
export const MAX_FAILURES = 200;
export const PROBE_INTERVAL_MS = 1000;
export const PROBE_TIMEOUT_MS = 5000;
/** A suite reset this close to a control failure counts as near it. */
export const NEAR_MS = 2000;

/** One sample's wire call, injectable. A failure rejects, with `code` and `reused` set when known. */
export type ProbeSend = (
  url: string,
  o: { keepAlive: boolean; timeoutMs: number; signal: AbortSignal },
) => Promise<{ status: number; body: string; reused: boolean }>;

export interface ProbeOptions {
  /** The wire call; default: node:https on the probe's own agents. */
  send?: ProbeSend;
  /** The clock, ms; default Date.now. */
  now?: () => number;
  /** When the suite started (ms on the same clock); default: when start() was called. */
  startMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  /** Timer seam: default setInterval / clearInterval. */
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface ControlProbe {
  /** One sample now (what the timer calls). Never rejects. Nothing after stop(). */
  tick: () => Promise<void>;
  start: () => void;
  /** Ends the timer, aborts a request in flight, closes the sockets. Idempotent. */
  stop: () => ControlStats;
  stats: () => ControlStats;
}

const emptyStats = (): ControlStats => ({
  sent: 0,
  ok: 0,
  by: {
    ECONNRESET: { reused: 0, fresh: 0 },
    timeout: { reused: 0, fresh: 0 },
    other: { reused: 0, fresh: 0 },
  },
  failures: [],
  colos: [],
});

/** The colo of a trace answer: the one field read. Undefined when absent or odd. */
export function coloOfTrace(body: string): string | undefined {
  return /^colo=([A-Z]{3})\r?$/m.exec(body)?.[1];
}

/** A request's error as a failure code: a reset, our timeout, or other. */
export function failCodeOf(e: unknown): FailCode {
  const x = e as { code?: unknown; name?: unknown; cause?: { code?: unknown } };
  const code = String(x?.code ?? x?.cause?.code ?? "");
  if (code === "ECONNRESET") return "ECONNRESET";
  if (
    code === "ETIMEDOUT" ||
    code === "PROBE_TIMEOUT" ||
    x?.name === "TimeoutError"
  )
    return "timeout";
  return "other";
}

/** The sockets of the default send: one kept alive, one that never is. */
function httpsSender(): { send: ProbeSend; close: () => void } {
  const kept = new https.Agent({ keepAlive: true, maxSockets: 1 });
  const fresh = new https.Agent({ keepAlive: false });
  const keptPlain = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const freshPlain = new http.Agent({ keepAlive: false });
  const send: ProbeSend = (url, o) =>
    new Promise((resolve, reject) => {
      // controlUrlFromEnv only ever builds https URLs; http is for the unit
      // test of this function against a loopback server.
      const plain = url.startsWith("http:");
      const req = (plain ? http : https).request(
        url,
        // No headers beyond the defaults: nothing identifying is sent.
        {
          method: "GET",
          agent: plain
            ? o.keepAlive
              ? keptPlain
              : freshPlain
            : o.keepAlive
              ? kept
              : fresh,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            // The trace answer is a few hundred bytes; keep the head only.
            if (body.length < 4096) body += c;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body,
              reused: req.reusedSocket,
            }),
          );
          res.on("error", fail);
        },
      );
      const fail = (e: Error) => {
        (e as Error & { reused?: boolean }).reused = req.reusedSocket;
        reject(e);
      };
      req.on("error", fail);
      const abort = () => req.destroy(o.signal.reason as Error);
      if (o.signal.aborted) abort();
      else o.signal.addEventListener("abort", abort, { once: true });
      req.end();
    });
  return {
    send,
    close: () => {
      for (const a of [kept, fresh, keptPlain, freshPlain]) a.destroy();
    },
  };
}

/** A probe of `url`. Nothing is sent until tick() or start(). */
export function createControlProbe(
  url: string,
  o: ProbeOptions = {},
): ControlProbe {
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? PROBE_TIMEOUT_MS;
  const own = o.send ? undefined : httpsSender();
  const send = o.send ?? (own as { send: ProbeSend }).send;
  const stopped = new AbortController();
  const s = emptyStats();
  let t0 = o.startMs ?? now();
  let timer: unknown;
  let busy = false;
  let n = 0;

  const tick = async (): Promise<void> => {
    if (stopped.signal.aborted || busy) return;
    busy = true;
    try {
      // Alternates: the kept-alive socket, then a new one.
      const keepAlive = n++ % 2 === 0;
      s.sent++;
      try {
        const r = await send(url, {
          keepAlive,
          timeoutMs,
          signal: AbortSignal.any([
            stopped.signal,
            AbortSignal.timeout(timeoutMs),
          ]),
        });
        if (stopped.signal.aborted) return;
        if (r.status === 200) {
          s.ok++;
          const colo = coloOfTrace(String(r.body));
          if (colo && !s.colos.includes(colo)) s.colos.push(colo);
        } else fail("other", r.reused === true);
      } catch (e) {
        // Ended by stop(): not a sample.
        if (stopped.signal.aborted) return;
        fail(failCodeOf(e), (e as { reused?: unknown })?.reused === true);
      }
    } catch {
      // Evidence is never worth failing the suite: the sample is dropped.
    } finally {
      busy = false;
    }
  };
  const fail = (code: FailCode, reused: boolean) => {
    s.by[code][reused ? "reused" : "fresh"]++;
    if (s.failures.length < MAX_FAILURES)
      s.failures.push({ atMs: now() - t0, code, reused });
  };
  const snapshot = (): ControlStats => ({
    ...s,
    by: {
      ECONNRESET: { ...s.by.ECONNRESET },
      timeout: { ...s.by.timeout },
      other: { ...s.by.other },
    },
    failures: [...s.failures],
    colos: [...s.colos],
  });
  return {
    tick,
    start() {
      if (timer !== undefined || stopped.signal.aborted) return;
      t0 = o.startMs ?? now();
      const set = o.setTimer ?? ((f, ms) => setInterval(f, ms));
      timer = set(() => void tick(), o.intervalMs ?? PROBE_INTERVAL_MS);
      // A probe never keeps the process alive.
      (timer as { unref?: () => void } | undefined)?.unref?.();
    },
    stop() {
      if (timer !== undefined) {
        (o.clearTimer ?? ((t) => clearInterval(t as NodeJS.Timeout)))(timer);
        timer = undefined;
      }
      stopped.abort();
      own?.close();
      return snapshot();
    },
    stats: snapshot,
  };
}

/** The probe's URL from REDLINE_TARGETS: rl-a's app host, https only. Undefined: no probe. */
export function controlUrlFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  try {
    const v = JSON.parse(env.REDLINE_TARGETS ?? "") as {
      mode?: unknown;
      a?: { app?: unknown };
    };
    if (v?.mode === "local" || typeof v?.a?.app !== "string") return undefined;
    const u = new URL(v.a.app);
    if (u.protocol !== "https:") return undefined;
    return `https://${u.host}/cdn-cgi/trace`;
  } catch {
    return undefined;
  }
}

/**
 * The probe for this run, or undefined when it is off: REDLINE_CONTROL_PROBE=0,
 * no https staging target, or a unit test (VITEST set) that gave no `send`.
 */
export function controlProbeFor(
  env: Record<string, string | undefined> = process.env,
  o: ProbeOptions = {},
): ControlProbe | undefined {
  if (env.REDLINE_CONTROL_PROBE === "0") return undefined;
  if (env.VITEST && !o.send) return undefined;
  const url = controlUrlFromEnv(env);
  return url ? createControlProbe(url, o) : undefined;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const joined = (xs: string[]) =>
  xs.length < 2
    ? xs.join("")
    : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** `Control: 362 sent, 360 ok, 2 reset (2 reused, 0 new) at 73.1 s and 73.4 s; colo IAD` */
export function controlSummary(c: ControlStats): string {
  const parts = [`${c.sent} sent`, `${c.ok} ok`];
  const names: Record<FailCode, string> = {
    ECONNRESET: "reset",
    timeout: "timeout",
    other: "other",
  };
  for (const k of FAIL_CODES) {
    const { reused, fresh } = c.by[k];
    if (reused + fresh)
      parts.push(
        `${reused + fresh} ${names[k]} (${reused} reused, ${fresh} new)`,
      );
  }
  const times = c.failures.map((f) => secs(f.atMs));
  const total = FAIL_CODES.reduce(
    (a, k) => a + c.by[k].reused + c.by[k].fresh,
    0,
  );
  const shown = times.slice(0, 10);
  const more = total - shown.length;
  const at = shown.length
    ? ` at ${joined(shown)}${more > 0 ? ` and ${more} more` : ""}`
    : "";
  const colo = c.colos.length ? `; colo ${c.colos.join(", ")}` : "";
  return `Control: ${parts.join(", ")}${at}${colo}`;
}

/** When each timed suite reset happened, ms since the suite started. */
export function resetTimesMs(notes: readonly string[]): number[] {
  const out: number[] = [];
  for (const n of notes) {
    if (!n.startsWith("reset: ")) continue;
    const m = /; at (\d+(?:\.\d)?) s(?:;|$)/.exec(n);
    if (m) out.push(Math.round(Number(m[1]) * 1000));
  }
  return out;
}

/** `Resets near a control failure: 3 of 5`; undefined without resets, a timestamp or a probe. */
export function nearSummary(
  notes: readonly string[],
  c: ControlStats | undefined,
): string | undefined {
  if (!c || c.sent === 0) return undefined;
  const resets = notes.filter((n) => n.startsWith("reset: ")).length;
  const times = resetTimesMs(notes);
  if (!resets || !times.length) return undefined;
  const near = times.filter((t) =>
    c.failures.some((f) => Math.abs(f.atMs - t) <= NEAR_MS),
  ).length;
  return `Resets near a control failure: ${near} of ${resets}`;
}
