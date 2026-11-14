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
  readZip,
  scrubDirs,
  scrubTraceZip,
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

  it("scrubs the zip files under the directories in place", () => {
    mkdirSync(join(dir, "data"));
    const f = join(dir, "data", "a.zip");
    writeFileSync(f, fixture());
    expect(scrubDirs([dir, join(dir, "missing")], [HOOK])).toBe(1);
    expect(all(readFileSync(f))).not.toContain(PAT);
  });

  it("an unparseable line fails closed and deletes every trace zip", () => {
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
    expect(() => scrubDirs([dir], [])).toThrow(/unparseable/);
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
    expect(() => scrubDirs([dir], [])).toThrow(/deleted/);
    expect(existsSync(f)).toBe(false);
  });
});
