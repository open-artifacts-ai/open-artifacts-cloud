// Evidence for #1133: what a connection reset looked like. Each one becomes a
// note with the method, the route's first segments, the host's hash and
// whether the socket was new or reused, and how long it had sat idle. The
// file's totals go with them: "resets hit reused sockets" means nothing unless
// you know how many requests did. Node's own diagnostics channels, read only:
// no request is changed, and no header or body is read. Logs are public: no
// full path, query or host name.
//
// It also tells src/transport.ts which socket a fetch went out on: a fetch
// run under track() gets the sent record of its own undici request, matched
// by the AsyncLocalStorage context the request was created in.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { subscribe } from "node:diagnostics_channel";
import { EDGE_PREFIX } from "./edge-probe.ts";
import { networkCode } from "./fetch-timeout.ts";
import { note } from "./notes.ts";

const RESET_PREFIX = "reset: ";
const CONNECTIONS_PREFIX = "connections: ";

type Req = { method?: string; origin?: unknown; path?: string };
export type Sent = { reused: boolean; idleMs: number; nth: number };
type Sock = {
  requests: number;
  lastDone: number;
  /** The last valid cf-ray a response on this socket carried, and when. */
  ray?: { id: string; at: number };
};
/** One fetch attempt under track(): its socket, once its headers went out. */
export type Attempt = { sent?: Sent };

/** The route, not the resource: ids sit past the third segment. */
export const routeOf = (path = ""): string =>
  path.split("?")[0]?.split("/").slice(0, 4).join("/") ?? "";

export const hostOf = (origin: unknown): string =>
  createHash("sha256").update(String(origin)).digest("hex").slice(0, 8);

/** How a reset note names the socket. */
export const socketText = (s: Sent | undefined): string =>
  s
    ? s.reused
      ? `reused socket, idle ${s.idleMs} ms, request ${s.nth} on it`
      : "new socket"
    : "before the request was sent";

/**
 * A Cloudflare ray id: 8 to 32 hex digits, a dash, the three-letter edge
 * location. Anything else is dropped, never logged (header values are data).
 */
export const RAY_RE = /^[0-9a-f]{8,32}-[A-Z]{3}$/;

/** The valid ray among a `cf-ray` value, or undefined. */
export const validRay = (v: unknown): string | undefined =>
  typeof v === "string" && RAY_RE.test(v.trim()) ? v.trim() : undefined;

/** The edge location of a valid ray: the part after the last dash. */
export const coloOf = (ray: string): string =>
  ray.slice(ray.lastIndexOf("-") + 1);

/** The cf-ray value of undici's raw header list (Buffers or strings, in pairs). */
function rayOfHeaders(headers: unknown): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  for (let i = 0; i + 1 < headers.length; i += 2) {
    if (String(headers[i]).toLowerCase() === "cf-ray")
      return validRay(String(headers[i + 1]));
  }
  return undefined;
}

/** `ms` as seconds with one decimal, for notes. */
export const secondsText = (ms: number): string =>
  `${(ms / 1000).toFixed(1)} s`;

/** The reset note's tail: when, and the last ray seen on the socket. */
export function rayText(sock: Sock | undefined, at: number): string {
  return sock?.ray
    ? `last ray ${sock.ray.id} ${Math.max(0, at - sock.ray.at)} ms earlier`
    : "no ray seen";
}

export interface ResetWatch {
  /** This file's totals, as a note's text. */
  totals: () => string;
  /** The edge locations seen, as a note's text; undefined when none. */
  edge: () => string | undefined;
  /** Runs `f`; `a.sent` is set when the fetch it starts sends its headers. */
  track: <T>(a: Attempt, f: () => T) => T;
}

/** REDLINE_SUITE_START_MS: when scripts/redline.ts began, for notes' "at N s". */
export function suiteStartFromEnv(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const n = Number(env.REDLINE_SUITE_START_MS);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function watchResets(
  now: () => number = Date.now,
  suiteStart: number | undefined = suiteStartFromEnv(),
): ResetWatch {
  const sockets = new WeakMap<object, Sock>();
  const sent = new WeakMap<object, Sent>();
  const socketOf = new WeakMap<object, object>();
  const attempts = new AsyncLocalStorage<Attempt>();
  const attemptOf = new WeakMap<object, Attempt>();
  const edges = new Map<string, number>();
  let requests = 0;
  let fresh = 0;
  // A listener that throws would surface as an uncaught error and fail a
  // case. Evidence is never worth that: it drops the record instead.
  const on = (channel: string, f: (m: unknown) => void) =>
    subscribe(channel, (m) => {
      try {
        f(m);
      } catch {}
    });
  // Published while dispatching, in the context of the fetch that made it.
  on("undici:request:create", (m) => {
    const a = attempts.getStore();
    if (a) attemptOf.set((m as { request: object }).request, a);
  });
  on("undici:client:sendHeaders", (m) => {
    const { request, socket } = m as { request: Req; socket: object };
    let s = sockets.get(socket);
    const reused = s !== undefined;
    if (!s) {
      s = { requests: 0, lastDone: now() };
      sockets.set(socket, s);
      fresh++;
    }
    s.requests++;
    requests++;
    const record = {
      reused,
      idleMs: reused ? now() - s.lastDone : 0,
      nth: s.requests,
    };
    sent.set(request, record);
    const a = attemptOf.get(request);
    if (a) a.sent = record;
    socketOf.set(request, socket);
  });
  // Only the cf-ray header is read, and only a value of the expected shape is
  // kept: the response's other headers are never looked at.
  on("undici:request:headers", (m) => {
    const { request, response } = m as {
      request: object;
      response: { headers?: unknown };
    };
    const ray = rayOfHeaders(response?.headers);
    if (!ray) return;
    const colo = coloOf(ray);
    edges.set(colo, (edges.get(colo) ?? 0) + 1);
    const socket = socketOf.get(request);
    const s = socket && sockets.get(socket);
    if (s) s.ray = { id: ray, at: now() };
  });
  on("undici:request:trailers", (m) => {
    const { request } = m as { request: object };
    const socket = socketOf.get(request);
    const s = socket && sockets.get(socket);
    if (s) s.lastDone = now();
  });
  on("undici:request:error", (m) => {
    const { request, error } = m as { request: Req; error: unknown };
    // Our own bound (src/fetch-timeout.ts) or a caller's abort: not a reset.
    const name = (error as Error).name;
    if (name === "AbortError" || name === "TimeoutError") return;
    const s = sent.get(request);
    const where = `${request.method} ${routeOf(request.path)} host ${hostOf(request.origin)}`;
    const at = now();
    const socket = socketOf.get(request);
    const when =
      suiteStart === undefined ? "" : `; at ${secondsText(at - suiteStart)}`;
    note(
      `${RESET_PREFIX}${networkCode(error)} ${where}, ${socketText(s)}${when}; ${rayText(socket && sockets.get(socket), at)}`,
    );
  });
  return {
    totals: () =>
      `${CONNECTIONS_PREFIX}${requests} requests, ${fresh} on new sockets`,
    edge: () =>
      edges.size
        ? `${EDGE_PREFIX}${[...edges]
            .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
            .map(([c, n]) => `${c} ${n}`)
            .join(", ")}`
        : undefined,
    track: (a, f) => attempts.run(a, f),
  };
}
