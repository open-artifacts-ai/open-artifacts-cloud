import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Exec, gh, sleeper } from "./gh-retry.ts";

const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });

function script(results: ReturnType<typeof fail>[]) {
  let n = 0;
  const exec: Exec = () => results[n++] ?? ok("extra");
  return { exec, calls: () => n };
}

describe("gh retry", () => {
  const sleeps: number[] = [];
  beforeEach(() => {
    sleeps.length = 0;
    vi.spyOn(sleeper, "sleep").mockImplementation((ms) => {
      sleeps.push(ms);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("a 502 then success returns the result", () => {
    const s = script([fail("gh: Server Error (HTTP 502)"), ok("fine")]);
    expect(gh(s.exec, ["api", "x"])).toBe("fine");
    expect(s.calls()).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it("three 502s throw after 3 attempts", () => {
    const s = script(Array(5).fill(fail("gh: Server Error (HTTP 502)")));
    expect(() => gh(s.exec, ["api", "x"])).toThrow(/HTTP 502/);
    expect(s.calls()).toBe(3);
    expect(sleeps).toEqual([2000, 5000]);
  });

  it("a 404 throws on the first try", () => {
    const s = script([fail("gh: Not Found (HTTP 404)"), ok("no")]);
    expect(() => gh(s.exec, ["api", "x"])).toThrow(/404/);
    expect(s.calls()).toBe(1);
  });

  it("GraphQL's 502 wording is transient too (pin-bump-arm, 11-25)", () => {
    const s = script([
      fail('non-200 OK status code: 502 Bad Gateway body: "<html>502</html>"'),
      ok("fine"),
    ]);
    expect(gh(s.exec, ["pr", "view", "1"])).toBe("fine");
    expect(s.calls()).toBe(2);
  });

  it("an idempotent write retries like a read", () => {
    const s = script([fail("gh: Server Error (HTTP 502)"), ok("armed")]);
    expect(
      gh(s.exec, ["pr", "merge", "1"], { write: true, idempotent: true }),
    ).toBe("armed");
    expect(s.calls()).toBe(2);
  });

  it("a write is not retried", () => {
    const s = script([fail("gh: Server Error (HTTP 502)"), ok("no")]);
    expect(() => gh(s.exec, ["pr", "create"], { write: true })).toThrow(/502/);
    expect(s.calls()).toBe(1);
  });
});
