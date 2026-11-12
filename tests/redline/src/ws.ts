import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { paceAnon, targetsFromEnv, tripwire } from "./rl-anon.ts";

// WebSocket handshakes and raw-Host requests over node:http(s). fetch can't
// send Upgrade or a Host that differs from the URL. Both resolve to a
// Response (a 101 included), so crossCheck and expectRefused judge them like
// any other reply. A timeout or socket error rejects, never a refusal; under
// sendProbe it is tried once more, then infra.

const TIMEOUT_MS = 15_000;

function toResponse(res: IncomingMessage, body: Buffer): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const status = res.statusCode ?? 0;
  if (status >= 200 && status <= 599)
    return new Response(
      status === 204 || status === 304 ? null : new Uint8Array(body),
      {
        status,
        headers,
      },
    );
  // Response can't carry a 1xx: keep the real status on a bodiless one.
  const r = new Response(null, { status: 200, headers });
  Object.defineProperty(r, "status", { value: status });
  return r;
}

interface RawOpts {
  url: string;
  method?: string;
  headers: Headers;
  /** Sent as the Host header (and TLS SNI unless `servername`). */
  host?: string;
  servername?: string;
  timeoutMs?: number;
  /**
   * An upgrade keeps its socket and hands it here instead of destroying it
   * (holdSocket). The caller owns the socket from then on.
   */
  keep?: (socket: Duplex) => void;
}

/** One request over node:http(s); the reply (any status) as a Response. */
export function rawRequest(o: RawOpts): Promise<Response> {
  const u = new URL(o.url);
  const headers: Record<string, string> = {};
  o.headers.forEach((v, k) => {
    headers[k] = v;
  });
  if (o.host) headers.host = o.host;
  const tls = u.protocol === "https:";
  const req = (tls ? httpsRequest : httpRequest)({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (tls ? 443 : 80),
    path: `${u.pathname}${u.search}`,
    method: o.method ?? "GET",
    headers,
    ...(tls
      ? {
          servername: o.servername ?? (o.host ?? u.hostname).split(":")[0],
        }
      : {}),
    agent: false,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      // Named TimeoutError so sendProbe reads it as no response (infra).
      const e = new Error(`timed out after ${o.timeoutMs ?? TIMEOUT_MS} ms`);
      e.name = "TimeoutError";
      reject(e);
    }, o.timeoutMs ?? TIMEOUT_MS);
    const done = (r: Response) => {
      clearTimeout(timer);
      resolve(r);
    };
    req.on("upgrade", (res, socket) => {
      if (o.keep) o.keep(socket);
      else socket.destroy();
      done(toResponse(res, Buffer.alloc(0)));
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done(toResponse(res, Buffer.concat(chunks))));
      res.on("error", () => {
        clearTimeout(timer);
        // A response came: no code, so it is never read as no response and
        // never retried (a retry's answer must not replace this one).
        reject(new Error(`body failed after status ${res.statusCode ?? "?"}`));
      });
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      // Never the message: it can carry the URL. The code is enough, and it
      // stays on the error so sendProbe can tell no response (ECONNRESET, ...)
      // from a verdict: one retry, then infra.
      const code = (e as { code?: string }).code;
      reject(
        Object.assign(new Error(`request failed (${code ?? "?"})`), { code }),
      );
    });
    req.end();
  });
}

/**
 * The WebSocket handshake for `req` (its URL and headers, plus Upgrade). 101
 * when the server upgraded; the socket is closed straight away.
 */
export async function wsHandshake(req: Request): Promise<Response> {
  // An anonymous upgrade spends RL_ANON (`ev:ip:`, `sub:ip:`): paced like the
  // fetches in live/setup.ts, before the request's own timeout starts.
  const targets = targetsFromEnv();
  if (targets.length) await paceAnon(req, targets);
  const res = await upgrade(req);
  if (targets.length) tripwire(req, res.status, targets);
  return res;
}

function upgrade(req: Request): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set("connection", "Upgrade");
  headers.set("upgrade", "websocket");
  headers.set("sec-websocket-version", "13");
  headers.set("sec-websocket-key", randomBytes(16).toString("base64"));
  return rawRequest({ url: req.url, headers });
}

/** A WebSocket this run keeps open (holdSocket). */
export interface Held {
  /** The handshake's status: 101 when the server upgraded. */
  status: number;
  /** Resolves when the connection ends, whoever ended it. Never rejects. */
  closed: Promise<void>;
  /** Writes one masked text frame (a client frame must be masked). */
  send: (text: string) => void;
  /** Every text frame the server has sent, in order. */
  texts: string[];
  /** True once a text frame matching `pred` has arrived (or does within `ms`); false on timeout or close. */
  waitText: (pred: (t: string) => boolean, ms: number) => Promise<boolean>;
  /** Ends it from this side; safe to call twice. */
  destroy: () => void;
  /**
   * The code of the server's close frame (RFC 6455 5.5.1), once one came;
   * null before that, for a close frame with no code, and with nothing open.
   */
  closeCode: () => number | null;
}

/** One masked client text frame (RFC 6455 5.2), for a short payload. */
export function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  const n = payload.length;
  const head =
    n < 126
      ? Buffer.from([0x81, 0x80 | n])
      : Buffer.from([0x81, 0x80 | 126, n >> 8, n & 0xff]);
  if (n > 0xffff) throw new Error("textFrame: payload too long");
  const body = Buffer.from(payload);
  for (let i = 0; i < n; i++)
    body[i] = (body[i] as number) ^ (mask[i % 4] as number);
  return Buffer.concat([head, mask, body]);
}

/** The bus keepalive cadence (bus-protocol limits.pingIntervalMs). */
export const KEEPALIVE_MS = 25_000;

/**
 * The handshake for `req`, and the socket kept open when the server upgraded
 * (101): the caller watches `closed`. Any other status has no socket and an
 * already-resolved `closed`. A timeout or socket error before a response
 * rejects, as wsHandshake does. While open it reads the server's text frames
 * (`texts`) and sends the bare keepalive "ping" every `pingMs` (default
 * KEEPALIVE_MS), as a bus client does, so an idle timeout can't be what ends
 * it.
 */
export async function holdSocket(
  req: Request,
  o: { pingMs?: number } = {},
): Promise<Held> {
  const headers = new Headers(req.headers);
  headers.set("connection", "Upgrade");
  headers.set("upgrade", "websocket");
  headers.set("sec-websocket-version", "13");
  headers.set("sec-websocket-key", randomBytes(16).toString("base64"));
  let kept: Duplex | undefined;
  const res = await rawRequest({
    url: req.url,
    headers,
    keep: (s) => {
      kept = s;
    },
  });
  const socket = kept;
  const texts: string[] = [];
  if (!socket)
    return {
      status: res.status,
      closed: Promise.resolve(),
      send: () => {},
      destroy: () => {},
      texts,
      waitText: async () => false,
      closeCode: () => null,
    };
  let ended = false;
  const waiters = new Set<() => void>();
  const closed = new Promise<void>((resolve) => {
    const end = () => {
      ended = true;
      for (const w of waiters) w();
      resolve();
    };
    socket.once("close", end);
    socket.once("end", end);
    socket.once("error", end);
  });
  let buf: Buffer = Buffer.alloc(0);
  let code: number | null = null;
  socket.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) break;
      let len = (buf[1] as number) & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) break;
      const op = (buf[0] as number) & 0x0f;
      if (op === 1) texts.push(buf.subarray(off, off + len).toString("utf8"));
      // A close frame: its first two payload bytes are the code.
      if (op === 8 && code === null && len >= 2) code = buf.readUInt16BE(off);
      buf = buf.subarray(off + len);
    }
    for (const w of waiters) w();
  });
  const ping = setInterval(() => {
    if (!socket.destroyed) socket.write(textFrame("ping"));
  }, o.pingMs ?? KEEPALIVE_MS);
  ping.unref();
  void closed.then(() => clearInterval(ping));
  return {
    status: res.status,
    closed,
    texts,
    send: (text) => {
      if (!socket.destroyed) socket.write(textFrame(text));
    },
    destroy: () => {
      clearInterval(ping);
      socket.destroy();
    },
    closeCode: () => code,
    waitText: (pred, ms) =>
      new Promise<boolean>((resolve) => {
        const done = (v: boolean) => {
          clearTimeout(t);
          waiters.delete(check);
          resolve(v);
        };
        const check = () => {
          if (texts.some(pred)) done(true);
          else if (ended) done(false);
        };
        const t = setTimeout(() => done(false), ms);
        waiters.add(check);
        check();
      }),
  };
}
