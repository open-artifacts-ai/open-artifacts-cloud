import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertKeyCheckDenied, deniedSessionRows } from "../src/audit.ts";
import { RETIRED } from "../src/retired.ts";
import type { Target } from "../src/targets.ts";

// The guard's "a wrong hook key gets the 404" takes the audit row as proof that
// the 404 was the key check's, not RL_ANON's (which writes none). It matters if
// the t19 runner ever shares this runner's IP.

const T = { name: "rl-a" } as Target;
const ev = (action: string, outcome: string) => ({
  action,
  at: 1,
  actorId: null,
  targetId: null,
  detail: { hook: "session", ip: "1.2.3.4", outcome },
});
const log =
  (...events: unknown[]) =>
  async () => ({ events });

describe("deniedSessionRows", () => {
  it("counts only test_hook.session rows whose outcome is denied", async () => {
    const n = await deniedSessionRows(
      T,
      0,
      log(
        ev("test_hook.session", "denied"),
        ev("test_hook.session", "ok"),
        ev("test_hook.audit", "denied"),
        ev("test_hook.session", "denied"),
        { action: "test_hook.session" },
      ),
    );
    expect(n).toBe(2);
  });

  it("asks for rows since the given time through the audit hook", async () => {
    let seen: unknown[] = [];
    await deniedSessionRows(T, 1234, async (_t, path, body) => {
      seen = [path, body];
      return { events: [] };
    });
    expect(seen).toEqual(["/__test/audit", { since: 1234 }]);
  });

  it("an answer without an events array throws; so does a hook that errors", async () => {
    await expect(deniedSessionRows(T, 0, async () => ({}))).rejects.toThrow(
      /no events array/,
    );
    await expect(
      deniedSessionRows(T, 0, async () => {
        throw new Error("404");
      }),
    ).rejects.toThrow("404");
  });
});

describe("assertKeyCheckDenied", () => {
  it("passes when the denied rows grew, throws when they did not (a limited 404 writes none)", () => {
    expect(() => assertKeyCheckDenied("rl-a", 3, 4)).not.toThrow();
    expect(() => assertKeyCheckDenied("rl-a", 3, 3)).toThrow(
      /may be the rate limit's 404/,
    );
    expect(() => assertKeyCheckDenied("rl-a", 3, 2)).toThrow();
  });
});

describe("live/guard.test.ts no longer runs the wrong-key case (cloud #264 step 2)", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../live/guard.test.ts"),
    "utf8",
  );
  it("the case moved to PR CI and is retired with the test that guards it", () => {
    expect(src).not.toContain("`${k}: a wrong hook key gets the 404`");
    expect(src).not.toContain("deniedSessionRows");
    for (const k of ["a", "b"])
      expect(
        RETIRED.some(
          (r) =>
            r.file === "live/guard.test.ts" &&
            r.name === `hooks > ${k}: a wrong hook key gets the 404`,
        ),
      ).toBe(true);
  });
});
