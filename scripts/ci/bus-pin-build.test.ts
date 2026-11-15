import { describe, expect, it } from "vitest";
import { buildWithPin, readPin } from "./bus-pin-build.ts";

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
  it("succeeds at once when the build pins", async () => {
    const r = run([pinned("1.2.3")]);
    expect((await buildWithPin("1.2.3", r.deps)).integrity).toBe(INTEG);
    expect(r.calls()).toBe(1);
    expect(r.sleeps()).toBe(0);
  });
  it("retries while npm lags (no pin, or a failed build), then succeeds", async () => {
    const r = run([unpinned("1.2.3"), false, pinned("1.2.3")]);
    expect((await buildWithPin("1.2.3", r.deps)).version).toBe("1.2.3");
    expect(r.calls()).toBe(3);
    expect(r.sleeps()).toBe(2);
  });
  it("never pinned: fails after the bounded attempts", async () => {
    const r = run([unpinned("1.2.3")]);
    await expect(buildWithPin("1.2.3", r.deps, 4)).rejects.toThrow(
      /no bus pin for 1.2.3 after 4 attempts/,
    );
    expect(r.calls()).toBe(4);
    expect(r.sleeps()).toBe(3);
  });
  it("a pin for another version fails at once", async () => {
    const r = run([gen("1.2.3", { version: "1.2.2", integrity: INTEG })]);
    await expect(buildWithPin("1.2.3", r.deps)).rejects.toThrow(
      /bus pin is 1.2.2, expected 1.2.3/,
    );
    expect(r.calls()).toBe(1);
  });
  it("a built server of another version fails at once", async () => {
    const r = run([pinned("1.2.4")]);
    await expect(buildWithPin("1.2.3", r.deps)).rejects.toThrow(
      /built server version 1.2.4/,
    );
  });
});
