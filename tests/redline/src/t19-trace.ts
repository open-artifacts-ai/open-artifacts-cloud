// T19's Playwright traces, made safe to upload (#281). The repo and its
// Actions artifacts are public, and a trace zip holds Cookie / Set-Cookie /
// Authorization and x-oa-* hook-key headers, request and response bodies,
// console lines and DOM snapshots (a freshly minted PAT can be on screen). So
// nothing is scrubbed by deleting known-bad fields: the scrubber rebuilds the
// zip from an ALLOWLIST (request and response timing, method, status, a few
// benign headers, URLs without query values or token-shaped path segments,
// action names and timings) and drops everything else: DOM snapshots, frames,
// bodies, params, console text, stdout/stderr, every other zip entry.
// It fails CLOSED: an unreadable zip, an unparseable line or any leftover
// secret shape in the rebuilt zip throws, and `scrubDirs` then deletes every
// trace zip it found, so the caller (the workflow) uploads none.
// No zip library: node:zlib plus a small reader/writer for the plain zips
// Playwright writes (stored or deflated, no zip64).
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const REDACTED = "[redacted]";
const MAX_ENTRY = 200 * 1024 * 1024;

// ---- zip ----------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function readZip(zip: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("trace: not a zip (no end record)");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff)
    throw new Error("trace: zip64 is not supported");
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50)
      throw new Error("trace: bad central directory");
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28);
    const elen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const lho = zip.readUInt32LE(p + 42);
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff)
      throw new Error("trace: zip64 is not supported");
    if (usize > MAX_ENTRY) throw new Error("trace: an entry is too large");
    const name = zip.subarray(p + 46, p + 46 + nlen).toString("utf8");
    if (lho + 30 > zip.length || zip.readUInt32LE(lho) !== 0x04034b50)
      throw new Error("trace: bad local header");
    const start =
      lho + 30 + zip.readUInt16LE(lho + 26) + zip.readUInt16LE(lho + 28);
    if (start + csize > zip.length) throw new Error("trace: truncated entry");
    const raw = zip.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8)
      data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
    else throw new Error(`trace: unsupported zip method ${method}`);
    if (data.length !== usize) throw new Error("trace: entry size mismatch");
    out.push({ name, data });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

export function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const body = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    parts.push(lh, name, body);
    central.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---- scrubbing ----------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const TOKEN_RES = [
  /oa_(?:pat|mac)_[A-Za-z0-9_-]*/g,
  /eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)*/g,
  /\bbearer\s+\S+/gi,
  /\bx-oa-[a-z0-9-]*/gi,
];

/** Free text with every token shape and every known secret value removed. */
export function redactText(s: string, literals: readonly string[]): string {
  let out = s;
  for (const l of literals) if (l) out = out.split(l).join(REDACTED);
  for (const re of TOKEN_RES) out = out.replace(re, REDACTED);
  return out;
}

/** A URL with no credentials, no query values, no fragment, no token-shaped path segment. */
export function scrubUrl(u: unknown, lit: readonly string[]): string {
  if (typeof u !== "string") return REDACTED;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return REDACTED;
  }
  if (url.protocol === "data:" || url.protocol === "blob:")
    return `${url.protocol}${REDACTED}`;
  const path = url.pathname
    .split("/")
    .map((s) => (s.length >= 24 ? REDACTED : s))
    .join("/");
  const keys = [...new Set([...url.searchParams.keys()])];
  const q = keys.length
    ? `?${keys.map((k) => `${encodeURIComponent(k)}=`).join("&")}`
    : "";
  return redactText(`${url.protocol}//${url.host}${path}${q}`, lit);
}

const HEADER_ALLOW = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "cache-control",
  "date",
  "vary",
  "server",
  "cf-ray",
  "cf-cache-status",
  "age",
  "retry-after",
]);

function headers(v: unknown, lit: readonly string[]): Obj[] {
  if (!Array.isArray(v)) return [];
  const out: Obj[] = [];
  for (const h of v) {
    if (!isObj(h) || typeof h.name !== "string") continue;
    const name = h.name.toLowerCase();
    if (name === "location") {
      out.push({ name, value: scrubUrl(h.value, lit) });
    } else if (HEADER_ALLOW.has(name) && typeof h.value === "string") {
      out.push({ name, value: redactText(h.value, lit) });
    }
  }
  return out;
}

/** Copies the listed keys that are numbers, booleans or (redacted) strings. */
function pick(
  o: unknown,
  keys: readonly string[],
  lit: readonly string[],
): Obj {
  const out: Obj = {};
  if (!isObj(o)) return out;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = redactText(v, lit);
  }
  return out;
}

/**
 * An error message reduced to its first line, every URL through scrubUrl and
 * every quoted string replaced (a fill value, a "Received" page text).
 */
export function scrubError(m: unknown, lit: readonly string[]): string {
  if (typeof m !== "string") return REDACTED;
  const first = m.split("\n")[0] ?? "";
  const noUrls = first.replace(/https?:\/\/[^\s"'`)\]>]+/g, (u) =>
    scrubUrl(u, lit),
  );
  const noQuotes = noUrls
    .replace(/"[^"]*"/g, '"<redacted>"')
    .replace(/'[^']*'/g, "'<redacted>'")
    .replace(/`[^`]*`/g, "`<redacted>`");
  return redactText(noQuotes, lit);
}

function scrubSnapshot(s: unknown, lit: readonly string[]): Obj {
  if (!isObj(s)) throw new Error("trace: a resource snapshot is not an object");
  const rq = isObj(s.request) ? s.request : {};
  const rs = isObj(s.response) ? s.response : {};
  const ct = isObj(rs.content) ? rs.content : {};
  const qs = [
    ...new Set(
      (Array.isArray(rq.queryString) ? rq.queryString : [])
        .map((q) =>
          isObj(q) && typeof q.name === "string" ? redactText(q.name, lit) : "",
        )
        .filter(Boolean),
    ),
  ];
  return {
    ...pick(
      s,
      ["pageref", "_frameref", "_monotonicTime", "startedDateTime", "time"],
      lit,
    ),
    request: {
      ...pick(rq, ["method", "httpVersion", "headersSize", "bodySize"], lit),
      url: scrubUrl(rq.url, lit),
      cookies: [],
      headers: headers(rq.headers, lit),
      queryString: qs.map((name) => ({ name, value: "" })),
    },
    response: {
      ...pick(
        rs,
        [
          "status",
          "statusText",
          "httpVersion",
          "headersSize",
          "bodySize",
          "_transferSize",
        ],
        lit,
      ),
      redirectURL: rs.redirectURL ? scrubUrl(rs.redirectURL, lit) : "",
      cookies: [],
      headers: headers(rs.headers, lit),
      content: pick(ct, ["size", "mimeType"], lit),
    },
    cache: {},
    timings: isObj(s.timings)
      ? pick(
          s.timings,
          ["dns", "connect", "ssl", "send", "wait", "receive", "blocked"],
          lit,
        )
      : {},
  };
}

function scrubEvent(e: Obj, lit: readonly string[]): Obj | null {
  switch (e.type) {
    case "context-options":
      return {
        ...pick(
          e,
          [
            "version",
            "origin",
            "browserName",
            "channel",
            "platform",
            "playwrightVersion",
            "wallTime",
            "monotonicTime",
            "sdkLanguage",
            "testIdAttributeName",
            "title",
            "contextId",
          ],
          lit,
        ),
        type: "context-options",
        options: {},
      };
    case "before":
      return {
        ...pick(
          e,
          [
            "callId",
            "startTime",
            "apiName",
            "class",
            "method",
            "pageId",
            "parentId",
            "stepId",
          ],
          lit,
        ),
        type: "before",
        params: {},
      };
    case "after": {
      const out: Obj = {
        ...pick(e, ["callId", "endTime", "pageId"], lit),
        type: "after",
      };
      if (isObj(e.error))
        out.error = {
          ...pick(e.error, ["name"], lit),
          message: scrubError(e.error.message, lit),
        };
      return out;
    }
    case "console":
      return {
        ...pick(e, ["pageId", "time", "messageType"], lit),
        type: "console",
        text: REDACTED,
        args: [],
        location: isObj(e.location)
          ? {
              ...pick(e.location, ["lineNumber", "columnNumber"], lit),
              url: scrubUrl(e.location.url, lit),
            }
          : {},
      };
    case "event":
      return {
        ...pick(e, ["class", "method", "time", "pageId"], lit),
        type: "event",
        params: {},
      };
    case "error":
      return { message: scrubError(e.message, lit), type: "error" };
    case "resource-snapshot":
      return {
        type: "resource-snapshot",
        snapshot: scrubSnapshot(e.snapshot, lit),
      };
    default:
      // frame-snapshot, screencast-frame, input, stdout, stderr, anything new.
      return null;
  }
}

function scrubLines(text: string, lit: readonly string[]): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      throw new Error("trace: an unparseable line");
    }
    if (!isObj(e) || typeof e.type !== "string")
      throw new Error("trace: a line is not a typed event");
    const s = scrubEvent(e, lit);
    if (s) out.push(JSON.stringify(s));
  }
  return `${out.join("\n")}\n`;
}

const KEEP = /^(?:\d+-)?trace\.(?:trace|network)$/;
const LEFTOVER = [
  /oa_(?:pat|mac)_/i,
  /eyJ/,
  /x-oa-/i,
  /"name":"(?:set-cookie|cookie|authorization|proxy-authorization)"/i,
  /\bbearer\s/i,
];

/** Throws when the text still holds a secret shape or a known secret value. */
export function assertClean(text: string, literals: readonly string[]): void {
  for (const re of LEFTOVER)
    if (re.test(text))
      throw new Error("trace: a secret shape survived the scrub");
  for (const l of literals)
    if (l && text.includes(l))
      throw new Error("trace: a secret value survived the scrub");
}

/** The scrubbed zip, or a throw: never a partly scrubbed one. */
export function scrubTraceZip(
  zip: Buffer,
  literals: readonly string[],
): Buffer {
  const entries = readZip(zip);
  const kept: ZipEntry[] = [];
  for (const e of entries) {
    if (!KEEP.test(e.name)) continue;
    const text = scrubLines(e.data.toString("utf8"), literals);
    assertClean(text, literals);
    kept.push({ name: e.name, data: Buffer.from(text) });
  }
  if (!kept.some((e) => e.name.endsWith("trace.trace")))
    throw new Error("trace: no trace.trace entry");
  const out = writeZip(kept);
  // Read the rebuilt zip back and check it again, byte for byte.
  for (const e of readZip(out)) assertClean(e.data.toString("utf8"), literals);
  return out;
}

// ---- directories --------------------------------------------------------

function* walk(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (s.isFile()) yield p;
  }
}

/** Every file in `dir` as secret values (under 8 bytes skipped), deduplicated. */
export function secretLiterals(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of walk(dir)) {
    const v = readFileSync(f, "utf8");
    // The whole value, each line of it, and the URL-encoded form of both.
    for (const x of [v.trim(), ...v.split("\n").map((l) => l.trim())]) {
      if (x.length < 8) continue;
      out.push(x);
      const enc = encodeURIComponent(x);
      if (enc !== x) out.push(enc);
    }
  }
  return [...new Set(out)];
}

/** A short, static code for a scrub failure: never any trace content. */
export function reasonCode(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  const code = m
    .replace(/^trace:\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return code || "scrub-error";
}

/**
 * Scrubs every zip under `dirs` in place. If any one fails, every zip found
 * (the report's data/ copies too) is deleted and the reason code is returned:
 * the rest of the report can still go up, and no unscrubbed trace can.
 */
export function scrubDirs(
  dirs: readonly string[],
  literals: readonly string[],
): { scrubbed: number; dropped?: string } {
  const zips: string[] = [];
  for (const d of dirs)
    if (existsSync(d))
      for (const f of walk(d)) if (f.endsWith(".zip")) zips.push(f);
  try {
    for (const f of zips)
      writeFileSync(f, scrubTraceZip(readFileSync(f), literals));
    return { scrubbed: zips.length };
  } catch (e) {
    for (const f of zips) rmSync(f, { force: true });
    return { scrubbed: 0, dropped: reasonCode(e) };
  }
}
