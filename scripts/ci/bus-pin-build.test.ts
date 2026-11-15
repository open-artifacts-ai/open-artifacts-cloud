import { describe, expect, it } from "vitest";
import { buildWithPin, readFallbackFor, readPin } from "./bus-pin-build.ts";

const INTEG = `sha512-${"A".repeat(86)}==`;
const gen = (v: string, pin: unknown) =>
  `// Generated\nexport const VERSION = ${JSON.stringify(v)};\nexport const COMMIT = "abc1234";\nexport const BUS_PKG: { version: string; integrity: string } | null = ${JSON.stringify(pin)};\nexport const BUS_PKG_WHY = "";\n`;
const pinned = (v: string) => gen(v, { version: v, integrity: INTEG });
const unpinned = (v: string) => gen(v, null);

const run = (outputs: (string | false)[]) => {
  let i = 0;
  let sleeps = 0;
  let cur = "";
  return {
    calls: () => i,
    sleeps: () => sleeps,
    deps: {
      build: () => {
        const o = outputs[Math.min(i++, outputs.length - 1)] as string | false;
        if (o === false) return false;
        cur = o;
        return true;
      },
      read: () => cur,
      sleep: async () => {
        sleeps++;
      },
    },
  };
};

describe("readPin", () => {
  it("parses the version and the sha512 integrity", () => {
    expect(readPin(pinned("1.2.3"))).toEqual({
      version: "1.2.3",
      pin: { version: "1.2.3", integrity: INTEG },
    });
  });
  it("null pin, malformed integrity and a missing line read as no pin", () => {
    expect(readPin(unpinned("1.2.3")).pin).toBeNull();
    expect(
      readPin(gen("1.2.3", { version: "1.2.3", integrity: "sha1-x" })).pin,
    ).toBeNull();
    expect(readPin('export const VERSION = "1.2.3";\n')).toEqual({
      version: "1.2.3",
      pin: null,
    });
  });
});

describe("buildWithPin", () => {
  it("succeeds at once when the build pins the release's own version", async () => {
    const r = run([pinned("1.2.3")]);
    expect((await buildWithPin("1.2.3", r.deps)).integrity).toBe(INTEG);
    expect(r.calls()).toBe(1);
    expect(r.sleeps()).toBe(0);
  });
  it("a lower pin passes with a warning naming both versions and the why", async () => {
    const logs: string[] = [];
    const src =
      `${gen("1.2.3", { version: "1.2.2", integrity: INTEG })}`.replace(
        'BUS_PKG_WHY = ""',
        'BUS_PKG_WHY = "1.2.3 not verified"',
      );
    const r = run([src]);
    const pin = await buildWithPin("1.2.3", {
      ...r.deps,
      log: (s) => logs.push(s),
    });
    expect(pin.version).toBe("1.2.2");
    expect(logs).toEqual([
      "::warning::bus pin is 1.2.2, older than the release 1.2.3 (1.2.3 not verified)",
    ]);
  });
  it("a recorded fallback warns with both versions and the why", async () => {
    const logs: string[] = [];
    const src =
      `${gen("1.2.3", { version: "1.2.2", integrity: INTEG })}export const BUS_PKG_FALLBACK_FOR: string | null = "1.2.3";\n`.replace(
        'BUS_PKG_WHY = ""',
        'BUS_PKG_WHY = "attestation missing"',
      );
    await buildWithPin("1.2.3", {
      ...run([src]).deps,
      log: (s) => logs.push(s),
    });
    expect(logs).toEqual([
      "::warning::bus pin fell back from 1.2.3 to 1.2.2 (attestation missing)",
    ]);
  });
  it("no fallback marker and the release's own pin: no warning", async () => {
    const logs: string[] = [];
    const src = `${pinned("1.2.3")}export const BUS_PKG_FALLBACK_FOR: string | null = null;\n`;
    await buildWithPin("1.2.3", {
      ...run([src]).deps,
      log: (s) => logs.push(s),
    });
    expect(logs).toEqual([]);
    expect(readFallbackFor(src)).toBeNull();
  });
  it("a null pin fails at once, without retrying", async () => {
    const r = run([unpinned("1.2.3")]);
    await expect(buildWithPin("1.2.3", r.deps)).rejects.toThrow(
      /no bus pin for 1.2.3/,
    );
    expect(r.calls()).toBe(1);
  });
  it("a higher pin fails", async () => {
    const r = run([gen("1.2.3", { version: "1.3.0", integrity: INTEG })]);
    await expect(buildWithPin("1.2.3", r.deps)).rejects.toThrow(
      /newer than the release 1.2.3/,
    );
  });
  it("a built server of another version fails", async () => {
    const r = run([pinned("1.2.4")]);
    await expect(buildWithPin("1.2.3", r.deps)).rejects.toThrow(
      /built server version 1.2.4/,
    );
  });
  it("one transient build error is retried once; two fail", async () => {
    const ok = run([false, pinned("1.2.3")]);
    expect((await buildWithPin("1.2.3", ok.deps)).version).toBe("1.2.3");
    expect(ok.calls()).toBe(2);
    const bad = run([false]);
    await expect(buildWithPin("1.2.3", bad.deps)).rejects.toThrow(
      /failed twice/,
    );
    expect(bad.calls()).toBe(2);
  });
});
