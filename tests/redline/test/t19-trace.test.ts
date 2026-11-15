import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dropErrorContext,
  dropMedia,
  readZip,
  scanDirs,
  scrubDirs,
  scrubTraceZip,
  secretLiterals,
  stripEmbeddedMedia,
  writeZip,
} from "../src/t19-trace.ts";

const PAT = "oa_pat_AbCdEf0123456789AbCdEf0123456789";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln";
const HOOK = "hookkeyvalue0123456789ABCDEFGHIJKL";
const ndjson = (...e: unknown[]) =>
  `${e.map((x) => JSON.stringify(x)).join("\n")}\n`;

const trace = ndjson(
  {
    type: "context-options",
    version: 8,
    browserName: "chromium",
    title: `t ${PAT}`,
    options: {
      extraHTTPHeaders: { "x-oa-hook-key": HOOK },
      storageState: { cookies: [{ value: JWT }] },
    },
  },
  {
    type: "before",
    callId: "c1",
    startTime: 1,
    apiName: "locator.fill",
    class: "Frame",
    method: "fill",
    params: { value: PAT },
  },
  {
    type: "console",
    pageId: "p",
    time: 2,
    messageType: "log",
    text: `minted ${PAT}`,
    args: [{ value: PAT }],
    location: {
      url: `https://app.example/x?token=${PAT}`,
      lineNumber: 1,
      columnNumber: 2,
    },
  },
  {
    type: "log",
    callId: "c1",
    time: 3,
    message: `Authorization: Bearer ${JWT}`,
  },
  { type: "frame-snapshot", snapshot: { html: ["div", {}, PAT] } },
  { type: "screencast-frame", sha1: "abc" },
  {
    type: "after",
    callId: "c1",
    endTime: 4,
    error: { name: "Error", message: `timeout ${PAT} ${HOOK}` },
  },
);
const network = ndjson({
  type: "resource-snapshot",
  snapshot: {
    pageref: "p",
    time: 5,
    request: {
      method: "POST",
      url: `https://app.example/api/s/abcdefghijklmnopqrstuvwxyz0123?code=${JWT}`,
      headers: [
        { name: "Cookie", value: `session=${JWT}` },
        { name: "Authorization", value: `Bearer ${PAT}` },
        { name: "x-oa-hook-key", value: HOOK },
        { name: "Content-Type", value: "application/json" },
      ],
      cookies: [{ name: "session", value: JWT }],
      queryString: [{ name: "code", value: JWT }],
      postData: { text: JSON.stringify({ pat: PAT }), _sha1: "def" },
    },
    response: {
      status: 200,
      headers: [
        { name: "Set-Cookie", value: `session=${JWT}; HttpOnly` },
        { name: "Content-Type", value: "application/json" },
      ],
      content: {
        size: 10,
        mimeType: "application/json",
        text: PAT,
        _sha1: "ghi",
      },
      redirectURL: "",
    },
  },
});
const fixture = () =>
  writeZip([
    { name: "trace.trace", data: Buffer.from(trace) },
    { name: "trace.network", data: Buffer.from(network) },
    { name: "trace.stacks", data: Buffer.from("{}") },
    { name: "resources/def", data: Buffer.from(JSON.stringify({ pat: PAT })) },
  ]);
const all = (z: Buffer) =>
  readZip(z)
    .map((e) => e.data.toString("utf8"))
    .join("\n");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t19-trace-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("T19 trace scrub (src/t19-trace.ts)", () => {
  it("keeps only the allowlisted entries and events, with no secret left", () => {
    const out = scrubTraceZip(fixture(), [HOOK]);
    expect(
      readZip(out)
        .map((e) => e.name)
        .sort(),
    ).toEqual(["trace.network", "trace.trace"]);
    const text = all(out);
    for (const bad of [
      PAT,
      JWT,
      HOOK,
      "oa_pat_",
      "eyJ",
      "x-oa-",
      "Bearer",
      "Set-Cookie",
      "session=",
      '"name":"cookie"',
      '"name":"authorization"',
      "postData",
      "frame-snapshot",
    ])
      expect(text.toLowerCase()).not.toContain(bad.toLowerCase());
    expect(text).toContain("application/json");
    expect(text).toContain("locator.fill");
    expect(text).toContain("https://app.example/api/s/[redacted]?code=");
  });

  it("drops log events and reduces errors; fill values, OAuth params and page text do not survive", () => {
    const FILL = "hunter2-secret-value";
    const PAGE = "Welcome back dana@example.com";
    const t = ndjson(
      { type: "context-options", version: 8 },
      { type: "log", callId: "c1", time: 1, message: `fill("${FILL}")` },
      {
        type: "log",
        callId: "c2",
        time: 2,
        message:
          "navigated to https://app.example/cb?code=AUTHCODE123&state=STATE456#oa=FRAGTOKEN789",
      },
      {
        type: "after",
        callId: "c3",
        endTime: 3,
        error: {
          name: "Error",
          message: `expect(locator).toHaveText(expected)\nExpected: "ok"\nReceived: "${PAGE}"\nat https://app.example/cb?code=AUTHCODE123&state=STATE456#oa=FRAGTOKEN789`,
        },
      },
      {
        type: "error",
        message: `page.goto: Timeout navigating to https://app.example/cb?code=AUTHCODE123&state=STATE456#oa=FRAGTOKEN789 expecting '${FILL}'\nCall log:\n  - Received "${PAGE}"`,
      },
    );
    const out = scrubTraceZip(
      writeZip([{ name: "trace.trace", data: Buffer.from(t) }]),
      [],
    );
    const text = all(out);
    expect(text).not.toContain('"type":"log"');
    for (const bad of [
      FILL,
      PAGE,
      "dana@",
      "AUTHCODE123",
      "STATE456",
      "FRAGTOKEN789",
      "Received",
      "Call log",
    ])
      expect(text).not.toContain(bad);
    expect(text).toContain("<redacted>");
    expect(text).toContain("expect(locator).toHaveText(expected)");
  });

  it("an unmatched quote cuts the error to the end of the line", () => {
    const n = ndjson({
      type: "error",
      message: `fill failed: value 'abc-unterminated-secret https://x.example/?code=ZZZ and more`,
    });
    const text = all(
      scrubTraceZip(
        writeZip([{ name: "trace.trace", data: Buffer.from(n) }]),
        [],
      ),
    );
    expect(text).not.toContain("unterminated");
    expect(text).not.toContain("more");
    expect(text).toContain("fill failed: value");
  });

  it("redacts path segments of 24+ characters, dots and escapes included", () => {
    const n = ndjson({
      type: "resource-snapshot",
      snapshot: {
        request: {
          method: "GET",
          url: "https://a.example/x/abc.def.ghi.jkl.mno.pqrstuv/ok/a%20b%20c%20d%20e%20f%20g%20h%20i%20j",
        },
        response: { status: 200 },
      },
    });
    const out = scrubTraceZip(
      writeZip([
        {
          name: "trace.trace",
          data: Buffer.from('{"type":"context-options"}\n'),
        },
        { name: "trace.network", data: Buffer.from(n) },
      ]),
      [],
    );
    const text = all(out);
    expect(text).toContain("/x/[redacted]/ok/[redacted]");
  });

  it("secretLiterals matches each line of a file and the URL-encoded form", () => {
    writeFileSync(
      join(dir, "k"),
      "first-secret-line one\nsecond&secret=line\n",
    );
    const l = secretLiterals(dir);
    expect(l).toContain("second&secret=line");
    expect(l).toContain(encodeURIComponent("second&secret=line"));
    expect(l).toContain("first-secret-line one");
    const z = writeZip([
      {
        name: "trace.trace",
        data: Buffer.from(
          ndjson({
            type: "before",
            callId: "c",
            apiName: "x second%26secret%3Dline",
          }),
        ),
      },
    ]);
    expect(all(scrubTraceZip(z, l))).not.toContain("second%26secret");
  });

  it("scrubs the zip files under the directories in place", () => {
    mkdirSync(join(dir, "data"));
    const f = join(dir, "data", "a.zip");
    writeFileSync(f, fixture());
    expect(scrubDirs([dir, join(dir, "missing")], [HOOK])).toEqual({
      scrubbed: 1,
    });
    expect(all(readFileSync(f))).not.toContain(PAT);
  });

  it("an unparseable line drops every trace zip and returns a reason code", () => {
    const good = join(dir, "good.zip");
    const bad = join(dir, "bad.zip");
    writeFileSync(good, fixture());
    writeFileSync(
      bad,
      writeZip([
        {
          name: "trace.trace",
          data: Buffer.from(`{"type":"log"}\nnot json ${PAT}\n`),
        },
      ]),
    );
    expect(scrubDirs([dir], [])).toEqual({
      scrubbed: 0,
      dropped: "an-unparseable-line",
    });
    expect(existsSync(good)).toBe(false);
    expect(existsSync(bad)).toBe(false);
  });

  it("a corrupt or trace-less zip fails closed", () => {
    expect(() => scrubTraceZip(Buffer.from("PK nonsense"), [])).toThrow();
    expect(() =>
      scrubTraceZip(writeZip([{ name: "other", data: Buffer.from("x") }]), []),
    ).toThrow(/no trace\.trace/);
    const f = join(dir, "c.zip");
    writeFileSync(f, "garbage");
    expect(scrubDirs([dir], []).dropped).toBeTruthy();
    expect(existsSync(f)).toBe(false);
  });
});

describe("T19 report scan (#294)", () => {
  let d: string;
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), "t19-scan-"));
  });
  afterEach(() => rmSync(d, { recursive: true, force: true }));
  const KEY = "hk_s3cret_value_0123456789";
  const b64 = (b: Buffer) => b.toString("base64");

  it("a clean report passes", () => {
    const blob = b64(writeZip([{ name: "r.json", data: Buffer.from("{}") }]));
    writeFileSync(
      join(d, "index.html"),
      `<script>data:application/zip;base64,${blob}</script>`,
    );
    writeFileSync(
      join(d, "a.zip"),
      writeZip([{ name: "x", data: Buffer.from("ok") }]),
    );
    const r = scanDirs([d], [KEY]);
    expect(r.hits).toEqual([]);
    expect(r.dropped).toEqual([]);
  });

  it("catches a token inside the HTML reporter's embedded base64 zip", () => {
    const blob = b64(
      writeZip([{ name: "r.json", data: Buffer.from(`err ${KEY} end`) }]),
    );
    writeFileSync(
      join(d, "index.html"),
      `<script id="playwrightReportBase64">data:application/zip;base64,${blob}</script>`,
    );
    expect(scanDirs([d], [KEY]).hits).toHaveLength(1);
  });

  it("catches a token inside a nested zip, and a token shape", () => {
    const inner = writeZip([{ name: "i", data: Buffer.from(`${KEY}`) }]);
    writeFileSync(
      join(d, "a.zip"),
      writeZip([{ name: "in.zip", data: inner }]),
    );
    const shape = writeZip([{ name: "i", data: Buffer.from(PAT) }]);
    writeFileSync(join(d, "b.zip"), shape);
    expect(
      scanDirs([d], [KEY])
        .hits.map((f) => f.slice(-5))
        .sort(),
    ).toEqual(["a.zip", "b.zip"]);
  });

  it("drops a zip it cannot read, including a bad embedded one", () => {
    writeFileSync(join(d, "bad.zip"), Buffer.from("PK\x03\x04 garbage"));
    writeFileSync(
      join(d, "index.html"),
      `x ${b64(Buffer.from("PK\x03\x04 garbage garbage garbage garbage garbage garbage garbage garbage"))}`,
    );
    const r = scanDirs([d], [KEY]);
    expect(r.dropped).toHaveLength(2);
    expect(existsSync(join(d, "bad.zip"))).toBe(false);
    expect(existsSync(join(d, "index.html"))).toBe(false);
  });

  it("dropErrorContext removes error-context.md files, wherever they sit", () => {
    mkdirSync(join(d, "data", "x"), { recursive: true });
    writeFileSync(join(d, "data", "x", "error-context.md"), `snapshot ${KEY}`);
    writeFileSync(join(d, "keep.md"), "ok");
    expect(dropErrorContext([d])).toBe(1);
    expect(existsSync(join(d, "data", "x", "error-context.md"))).toBe(false);
    expect(existsSync(join(d, "keep.md"))).toBe(true);
  });

  it("dropMedia removes images and videos anywhere", () => {
    mkdirSync(join(d, "data"), { recursive: true });
    for (const n of [
      "a.png",
      "data/b.JPG",
      "c.jpeg",
      "d.webp",
      "e.gif",
      "data/f.webm",
      "g.mp4",
    ])
      writeFileSync(join(d, n), "x");
    writeFileSync(join(d, "index.html"), "ok");
    expect(dropMedia([d])).toBe(7);
    expect(existsSync(join(d, "index.html"))).toBe(true);
    expect(existsSync(join(d, "a.png"))).toBe(false);
  });

  it("an image inside a zip or the embedded report fails closed (the file is dropped)", () => {
    const z = writeZip([{ name: "data/s.png", data: Buffer.from("\x89PNG") }]);
    writeFileSync(join(d, "a.zip"), z);
    writeFileSync(join(d, "index.html"), `x ${b64(z)}`);
    const r = scanDirs([d], [KEY]);
    expect(r.dropped).toHaveLength(2);
    expect(existsSync(join(d, "index.html"))).toBe(false);
  });

  it("base64 split across lines is not reassembled", () => {
    const blob = b64(
      Buffer.from(`pad ${KEY} pad pad pad pad pad pad pad pad pad pad pad`),
    );
    const split = `${blob.slice(0, 40)}\n${blob.slice(40)}`;
    writeFileSync(join(d, "index.html"), split);
    expect(scanDirs([d], [KEY]).hits).toEqual([]);
  });

  it("stripEmbeddedMedia keeps index.html, its zip loses the media, and the scan passes", () => {
    const z = writeZip([
      { name: "report.json", data: Buffer.from("{}") },
      { name: "data/s.png", data: Buffer.from("\x89PNG screenshot") },
      { name: "data/v.webm", data: Buffer.from("video") },
    ]);
    writeFileSync(
      join(d, "index.html"),
      `<script>data:application/zip;base64,${b64(z)}</script>`,
    );
    expect(stripEmbeddedMedia([d])).toEqual({ stripped: 1, dropped: 0 });
    const html = readFileSync(join(d, "index.html"), "latin1");
    const blob = /[A-Za-z0-9+/]{64,}={0,2}/.exec(html)?.[0] ?? "";
    expect(readZip(Buffer.from(blob, "base64")).map((e) => e.name)).toEqual([
      "report.json",
    ]);
    const r = scanDirs([d], [KEY]);
    expect(r).toMatchObject({ dropped: [], hits: [] });
  });

  it("a corrupt embedded zip drops index.html", () => {
    const z = writeZip([{ name: "report.json", data: Buffer.from("{}") }]);
    writeFileSync(
      join(d, "index.html"),
      `x ${b64(z.subarray(0, z.length - 30))}`,
    );
    expect(stripEmbeddedMedia([d]).dropped).toBe(1);
    expect(existsSync(join(d, "index.html"))).toBe(false);
  });

  it("stripEmbeddedMedia replaces inline image and video data URIs", () => {
    const big = Buffer.alloc(300, 7).toString("base64");
    writeFileSync(
      join(d, "index.html"),
      `<img src="data:image/png;base64,${big}"><video src="data:video/webm;base64,${big}"></video><p>ok</p>`,
    );
    expect(stripEmbeddedMedia([d]).stripped).toBe(1);
    const html = readFileSync(join(d, "index.html"), "latin1");
    expect(html).toBe(
      '<img src="data:,"><video src="data:,"></video><p>ok</p>',
    );
  });
});
