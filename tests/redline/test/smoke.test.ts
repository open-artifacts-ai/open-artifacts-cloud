import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_PURGE_PREFIX } from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import { InfraError } from "../src/fetch-timeout.ts";
import type { Run } from "../src/provisioning.ts";
import {
  cookieProblems,
  FRESH_FILE,
  freshEmail,
  googleProblems,
  healthProblems,
  heldOtp,
  OTP_HOLD_MS,
  PURGE_DONE,
  PURGE_LOG,
  parseSetCookie,
  purgeFresh,
  purgeWait,
  QUICK_MAX,
  refusalProblem,
  req,
  retryWithBackoff,
  SEARCH_BACKOFF_MS,
  SMOKE_ADDED,
  SMOKE_CASES,
  SMOKE_ROWS,
  SWEEP_DONE,
  smokePeoplePrefix,
  spawnPurge,
  spawnSweep,
  staleFresh,
  sweepFresh,
  sweepWait,
  VERSIONS_HOLD_MS,
  versionsIndexed,
} from "../src/smoke.ts";
import { parseTargets, secretsOf } from "../src/targets.ts";

const pkg = join(import.meta.dirname, "..");
const tmp = () => mkdtempSync(join(tmpdir(), "smoke-test-"));

describe("the smoke's cases", () => {
  it("keeps the page's 27 smoke rows, each named once, each with where it runs", () => {
    expect(SMOKE_ROWS).toHaveLength(27);
    expect(new Set(SMOKE_ROWS.map((r) => r.page)).size).toBe(27);
    for (const r of SMOKE_ROWS) expect(r.where.length).toBeGreaterThan(0);
  });

  it("runs every smoke case for some page row or the canary", () => {
    const all = Object.values(SMOKE_CASES).flat();
    for (const c of all)
      expect(
        [...SMOKE_ROWS, ...SMOKE_ADDED].some((r) => r.where.includes(c)),
        c,
      ).toBe(true);
  });

  it("lists exactly SMOKE_CASES in smoke/manifest.json", () => {
    const m = JSON.parse(
      readFileSync(join(pkg, "smoke/manifest.json"), "utf8"),
    ) as { cases: { file: string; name: string }[] };
    expect(m.cases).toEqual(
      Object.entries(SMOKE_CASES).flatMap(([file, names]) =>
        names.map((name) => ({ file, name })),
      ),
    );
  });

  it("names each case in its file from SMOKE_CASES, and nothing waits on a ledger, lock or barrier", () => {
    for (const f of ["smoke/fresh.test.ts", "smoke/standing.test.ts"]) {
      const src = readFileSync(join(pkg, f), "utf8");
      expect(src).toContain(`SMOKE_CASES["${f}"]`);
    }
    for (const f of [
      "src/smoke.ts",
      "smoke/fresh.test.ts",
      "smoke/standing.test.ts",
      "smoke/setup.ts",
    ]) {
      const src = readFileSync(join(pkg, f), "utf8");
      // The tracks sleep nowhere: their polls run on the Run's clock.
      if (f.startsWith("smoke/"))
        expect(src, `${f} sleeps`).not.toMatch(/setTimeout|sleep\(|delay\(/);
      for (const banned of [
        "rl-anon",
        "locks.ts",
        "barrier.ts",
        "lanes.ts",
        "paceHook",
        "claimSuiteSlot",
      ])
        expect(src, `${f} uses ${banned}`).not.toContain(banned);
    }
  });
});

describe("retryWithBackoff (the one wait the smoke allows)", () => {
  it("tries once, then once after each backoff while not ready, on the given clock", async () => {
    const waits: number[] = [];
    let n = 0;
    const got = await retryWithBackoff(
      async () => (++n === 3 ? "code" : undefined),
      {
        backoffMs: [250, 500, 1000],
        wait: async (ms) => {
          waits.push(ms);
        },
        notReady: "no code",
      },
    );
    expect(got).toBe("code");
    expect(waits).toEqual([250, 500]);
  });

  it("gives up after the last backoff, naming what never got ready", async () => {
    const waits: number[] = [];
    await expect(
      retryWithBackoff(async () => undefined, {
        backoffMs: SEARCH_BACKOFF_MS,
        wait: async (ms) => {
          waits.push(ms);
        },
        notReady: "no code was sent",
      }),
    ).rejects.toThrow("no code was sent");
    expect(waits).toEqual([...SEARCH_BACKOFF_MS]);
  });

  it("the only waits are the search fallback's backoff; the code and the edge reads never sleep", () => {
    const lib = readFileSync(join(pkg, "src/smoke.ts"), "utf8");
    expect(lib).not.toMatch(/CACHE_BACKOFF_MS|OTP_BACKOFF_MS|run\.within\(/);
    expect((lib.match(/retryWithBackoff\(/g) ?? []).length).toBe(0);
    const st = readFileSync(join(pkg, "smoke/standing.test.ts"), "utf8");
    expect((st.match(/retryWithBackoff\(/g) ?? []).length).toBe(1);
  });

  it("the tracks use nothing else that waits: no run.within, no setTimeout", () => {
    for (const f of ["smoke/standing.test.ts", "smoke/fresh.test.ts"]) {
      const src = readFileSync(join(pkg, f), "utf8");
      expect(src, f).not.toMatch(/run\.within\(|setTimeout|sleep\(/);
    }
  });
});

describe("heldOtp: held asks, no client sleep", () => {
  const clock = (step: number) => {
    let t = 0;
    return {
      now: () => t,
      tick: () => {
        t += step;
      },
    };
  };

  it("asks again at once after a held pending answer, until the code comes", async () => {
    const c = clock(OTP_HOLD_MS);
    const waits: number[] = [];
    let n = 0;
    const code = await heldOtp(
      async (wait) => {
        waits.push(wait);
        c.tick();
        return ++n === 3 ? { code: "123456" } : { outcome: "pending" };
      },
      { now: c.now },
    );
    expect(code).toBe("123456");
    expect(waits).toEqual([OTP_HOLD_MS, OTP_HOLD_MS, OTP_HOLD_MS]);
  });

  it("never holds past its deadline: the last ask is for the time left", async () => {
    const c = clock(OTP_HOLD_MS);
    const waits: number[] = [];
    await expect(
      heldOtp(
        async (wait) => {
          waits.push(wait);
          c.tick();
          return { outcome: "pending" };
        },
        { now: c.now, deadlineMs: 20_000 },
      ),
    ).rejects.toThrow("before the deadline");
    expect(waits).toEqual([8_000, 8_000, 4_000]);
  });

  it("a final outcome without a code, or a hook that doesn't hold, fails at once", async () => {
    const c = clock(OTP_HOLD_MS);
    await expect(
      heldOtp(async () => ({ outcome: "send_failed" }), { now: c.now }),
    ).rejects.toThrow("(send_failed)");
    const q = clock(10);
    let asks = 0;
    await expect(
      heldOtp(
        async () => {
          asks++;
          q.tick();
          return { outcome: "pending" };
        },
        { now: q.now },
      ),
    ).rejects.toThrow("without holding");
    expect(asks).toBe(QUICK_MAX);
  });
});

describe("versionsIndexed: one held read picks the search path", () => {
  const answer = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));
  it("indexed when the newest version says textIndexed, asking with ?wait", async () => {
    const f = answer([
      { version: 2, textIndexed: true },
      { version: 1, textIndexed: true },
    ]);
    vi.stubGlobal("fetch", f);
    try {
      expect(await versionsIndexed("https://a.example", "p", "art1")).toBe(
        "indexed",
      );
      expect(String((f.mock.calls[0] as unknown[])[0])).toBe(
        `https://a.example/api/v1/artifacts/art1/versions?wait=${VERSIONS_HOLD_MS}`,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("not-held when the build answers unindexed or without the field (no #3221)", async () => {
    for (const body of [
      [{ version: 1, textIndexed: false }],
      [{ version: 1 }],
      { items: [{ version: 3 }] },
    ]) {
      vi.stubGlobal("fetch", answer(body));
      try {
        expect(
          await versionsIndexed("https://a.example", "p", "x"),
          JSON.stringify(body),
        ).toBe("not-held");
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
});

describe("healthProblems (the shared health check)", () => {
  const want = { name: "rl-a", installId: "i1", version: "0.250.0" };
  const good = {
    ok: true,
    installId: "i1",
    version: "0.250.0",
    testHooks: true,
    oauthStore: { mode: "d1" },
  };
  it("accepts a healthy test build in d1 or dual", () => {
    expect(healthProblems(200, good, want)).toEqual([]);
    expect(
      healthProblems(200, { ...good, oauthStore: { mode: "dual" } }, want),
    ).toEqual([]);
  });
  it("names each problem", () => {
    expect(healthProblems(503, good, want)).toEqual([
      "rl-a /healthz is 503, want 200",
    ]);
    expect(
      healthProblems(
        200,
        {
          ok: false,
          installId: "i2",
          version: "0.249.0",
          oauthStore: { mode: "kv" },
        },
        want,
      ),
    ).toEqual([
      "rl-a: ok is not true",
      "rl-a: installId is not i1",
      "rl-a: version is 0.249.0, want 0.250.0",
      "rl-a: testHooks is not true (not the test build)",
      "rl-a: oauthStore.mode is kv, want d1 or dual",
    ]);
    expect(healthProblems(200, { ...good, oauthStore: null }, want)).toEqual([
      "rl-a: oauthStore.mode is missing, want d1 or dual",
    ]);
  });
});

describe("cookieProblems", () => {
  it("accepts only __Host-, Secure, Path=/ and no Domain", () => {
    expect(
      cookieProblems(
        parseSetCookie(
          "__Host-oa_session=v; Path=/; Secure; HttpOnly; SameSite=Lax",
        ),
      ),
    ).toEqual([]);
    expect(
      cookieProblems(parseSetCookie("oa_code=v; Path=/a; Domain=x.app")),
    ).toEqual([
      "oa_code is not __Host-",
      "oa_code is not Secure",
      "oa_code Path is not /",
      "oa_code has a Domain",
    ]);
  });
});

describe("googleProblems", () => {
  const state = (i: string) =>
    `${Buffer.from(JSON.stringify({ i })).toString("base64url")}.sig`;
  const g = (q: Record<string, string>) =>
    new URL(
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(q)}`,
    );
  const broker = "https://auth.example";
  it("accepts the broker's callback and a state for the install", () => {
    expect(
      googleProblems(
        g({
          client_id: "123-abc.apps.googleusercontent.com",
          redirect_uri: `${broker}/google/callback`,
          state: state("i1"),
        }),
        { broker, app: "https://a.example", installId: "i1" },
      ),
    ).toEqual([]);
  });
  it("refuses another install's state, a missing client id and a wrong callback", () => {
    expect(
      googleProblems(
        g({ redirect_uri: "https://evil.example/cb", state: state("i2") }),
        { broker, app: "https://a.example", installId: "i1" },
      ),
    ).toEqual([
      "no Google OAuth client id",
      "redirect_uri is not the broker's callback",
      "the broker state names another install",
    ]);
  });
  it("without a broker, wants the install's own callback", () => {
    expect(
      googleProblems(
        g({
          client_id: "x.apps.googleusercontent.com",
          redirect_uri: "https://a.example/auth/callback/google",
          state: "s",
        }),
        { app: "https://a.example", installId: "i1" },
      ),
    ).toEqual([]);
  });
});

describe("the smoke's people", () => {
  it("live under a t19- prefix the people-purge hook accepts, apart from T19's own runs", () => {
    const prefix = smokePeoplePrefix("45795302019-1");
    expect(prefix).toBe("t19-s45795302019-1-");
    expect(TEST_PURGE_PREFIX.test(prefix)).toBe(true);
    const e = freshEmail("45795302019-1", "code", "test.example");
    expect(e.startsWith(prefix)).toBe(true);
    expect(e).toMatch(/^t19-s45795302019-1-code-[0-9a-f]{6}@test\.example$/);
    // T19's own run ids are hex: an `s` never starts one.
    expect(/^t19-[0-9a-f]{6}-/.test(prefix)).toBe(false);
  });
});

describe("refusalProblem", () => {
  it("wants 401, 403 or 404 with no session cookie", () => {
    expect(refusalProblem(401, [])).toBeNull();
    expect(refusalProblem(200, [])).toBe("answered 200");
    expect(refusalProblem(404, ["__Host-oa_session=x; Path=/"])).toBe(
      "set a session cookie",
    );
  });
});

describe("req", () => {
  it("turns a 429 into infra, never a verdict", async () => {
    const f = vi.fn(async () => new Response("slow down", { status: 429 }));
    await expect(
      req("https://a.example/api/v1/me", {}, f as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(InfraError);
    const ok = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await req(
      "https://a.example/x",
      {},
      ok as unknown as typeof fetch,
    );
    expect(r.status).toBe(200);
    expect(ok).toHaveBeenCalledWith("https://a.example/x", {
      redirect: "manual",
    });
  });
});

describe("the background purge", () => {
  it("starts nothing when no fresh install was recorded", () => {
    const go = vi.fn();
    expect(spawnPurge(tmp(), "/x/smoke.ts", go as never)).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });

  it("starts a detached purge and does not wait for it", () => {
    const d = tmp();
    writeFileSync(join(d, FRESH_FILE), '{"slug":"rl-n-1-1"}');
    const unref = vi.fn();
    const go = vi.fn(() => ({ unref }));
    expect(spawnPurge(d, "/x/smoke.ts", go as never)).toBe(true);
    const [, args, opts] = go.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean },
    ];
    expect(args.slice(-2)).toEqual(["/x/smoke.ts", "purge"]);
    expect(opts.detached).toBe(true);
    expect(unref).toHaveBeenCalled();
  });

  it("purges only an rl-n slug, and writes its done file either way", async () => {
    const d = tmp();
    const out: string[] = [];
    // No live row for the slug: removeInstall has nothing to do.
    const run = {
      v1: vi.fn(async () => ({ status: 200, json: { items: [] } })),
    } as unknown as Run;
    writeFileSync(join(d, FRESH_FILE), '{"slug":"rl-n-9-1"}');
    expect(await purgeFresh(run, d, (s) => out.push(s))).toBe(true);
    expect(readFileSync(join(d, PURGE_DONE), "utf8")).toBe("ok\n");
    writeFileSync(join(d, FRESH_FILE), '{"slug":"rl-a"}');
    expect(await purgeFresh(run, d, (s) => out.push(s))).toBe(false);
    expect(readFileSync(join(d, PURGE_DONE), "utf8")).toBe("failed\n");
    expect(out.join("")).toContain("purge failed: no fresh slug recorded");
  });

  it("the report reads once and waits for nothing: the log so far, without workflow commands", async () => {
    const d = tmp();
    const out: string[] = [];
    expect(await purgeWait(d, { write: (s) => out.push(s) })).toBe(true);
    writeFileSync(join(d, FRESH_FILE), '{"slug":"rl-n-9-1"}');
    writeFileSync(join(d, PURGE_LOG), "::add-mask::x\nrl-n-9-1: deleted\n");
    expect(await purgeWait(d, { write: (s) => out.push(s) })).toBe(false);
    expect(out.join("")).toContain("has not ended");
    expect(out.join("")).not.toContain("add-mask");
    writeFileSync(join(d, PURGE_DONE), "ok\n");
    expect(await purgeWait(d, { write: (s) => out.push(s) })).toBe(true);
    expect(out.join("")).toContain("rl-n-9-1: deleted");
  });
});

describe("the sweep of leftover fresh installs", () => {
  const NOW = Date.parse("2026-11-26T12:00:00Z");
  const H = 60 * 60_000;
  const item = (slug: string, agoMs: number, state = "active") => ({
    slug,
    state,
    createdAt: NOW - agoMs,
  });
  /** A fake Run: R2 pages, then whatever removeInstall asks (no live row: a no-op). */
  const fakeRun = (
    pages: unknown[][],
    api = "https://api.open-artifacts-staging.app",
  ) => {
    const seen: string[] = [];
    let page = 0;
    const run = {
      c: { api },
      v1: vi.fn(async (path: string) => {
        seen.push(path);
        if (
          path === "/installs?q=rl-n-" ||
          path.startsWith("/installs?q=rl-n-&")
        ) {
          const items = pages[page] ?? [];
          page++;
          return {
            status: 200,
            json: {
              items,
              nextCursor: page < pages.length ? `c${page}` : null,
            },
          };
        }
        // removeInstall's own list by slug: nothing live, so it is done.
        return { status: 200, json: { items: [] } };
      }),
    } as unknown as Run;
    return { run, seen };
  };

  it("lists rl-n-* older than 2 h, not deleted, across pages; never a young one or another slug", async () => {
    const { run, seen } = fakeRun([
      [item("rl-n-1-1", 3 * H), item("rl-n-2-1", H), item("rl-p-3-1", 5 * H)],
      [
        item("rl-n-4-1", 26 * H, "deleted"),
        item("rl-n-5-1", 2 * H + 1),
        item("rl-a", 9 * H),
      ],
    ]);
    expect(await staleFresh(run, NOW)).toEqual(["rl-n-1-1", "rl-n-5-1"]);
    expect(seen).toEqual(["/installs?q=rl-n-", "/installs?q=rl-n-&cursor=c1"]);
  });

  it("reads every page to the end: a leftover on page 25 is found", async () => {
    const pages: unknown[][] = Array.from({ length: 25 }, (_, i) =>
      i === 24 ? [item("rl-n-late-1", 3 * H)] : [item(`rl-n-young-${i}`, H)],
    );
    const { run, seen } = fakeRun(pages);
    expect(await staleFresh(run, NOW)).toEqual(["rl-n-late-1"]);
    expect(seen).toHaveLength(25);
  });

  it("a page that can't be read, has no items, or repeats a cursor fails loudly, never a partial list", async () => {
    let n = 0;
    const failing = {
      c: { api: "https://api.open-artifacts-staging.app" },
      v1: vi.fn(async () =>
        n++ < 21
          ? { status: 200, json: { items: [], nextCursor: `c${n}` } }
          : { status: 503, json: {} },
      ),
    } as unknown as Run;
    await expect(staleFresh(failing, NOW)).rejects.toThrow(/sweep R2: 503/);
    const noItems = {
      c: { api: "https://api.open-artifacts-staging.app" },
      v1: vi.fn(async () => ({ status: 200, json: { nextCursor: null } })),
    } as unknown as Run;
    await expect(staleFresh(noItems, NOW)).rejects.toThrow(/has no items/);
    const loop = {
      c: { api: "https://api.open-artifacts-staging.app" },
      v1: vi.fn(async () => ({
        status: 200,
        json: { items: [], nextCursor: "same" },
      })),
    } as unknown as Run;
    await expect(staleFresh(loop, NOW)).rejects.toThrow(/repeats a cursor/);
  });

  it("reads a createdAt in seconds as seconds, never as 1970", async () => {
    const { run } = fakeRun([
      [
        {
          slug: "rl-n-1-1",
          state: "active",
          createdAt: Math.floor((NOW - H) / 1000),
        },
      ],
    ]);
    expect(await staleFresh(run, NOW)).toEqual([]);
  });

  it("runs on staging only", async () => {
    const { run } = fakeRun([[]], "https://api.open-artifacts.app");
    await expect(staleFresh(run, NOW)).rejects.toThrow(/staging only/);
  });

  it("removes each leftover with the purge's own mechanism and writes its done file", async () => {
    const d = tmp();
    const out: string[] = [];
    const { run, seen } = fakeRun([[item("rl-n-1-1", 3 * H)]]);
    expect(await sweepFresh(run, d, NOW, (s) => out.push(s))).toBe(true);
    expect(seen).toContain("/installs?q=rl-n-1-1");
    expect(readFileSync(join(d, SWEEP_DONE), "utf8")).toBe("ok\n");
    expect(out.join("")).toContain("rl-n-1-1: deleted and purged");
  });

  it("a failed list still writes the done file, as failed", async () => {
    const d = tmp();
    const run = {
      c: { api: "https://api.open-artifacts-staging.app" },
      v1: vi.fn(async () => ({ status: 503, json: {} })),
    } as unknown as Run;
    expect(await sweepFresh(run, d, NOW, () => {})).toBe(false);
    expect(readFileSync(join(d, SWEEP_DONE), "utf8")).toBe("failed\n");
  });

  it("starts detached, and its wait is a no-op when no sweep started", async () => {
    const d = tmp();
    expect(await sweepWait(d, { write: () => {} })).toBe(true);
    const unref = vi.fn();
    const go = vi.fn(() => ({ unref }));
    spawnSweep(d, "/x/smoke.ts", go as never);
    const [, args, opts] = go.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean },
    ];
    expect(args.slice(-2)).toEqual(["/x/smoke.ts", "sweep"]);
    expect(opts.detached).toBe(true);
    expect(unref).toHaveBeenCalled();
    writeFileSync(join(d, SWEEP_DONE), "ok\n");
    expect(await sweepWait(d, { write: () => {} })).toBe(true);
  });
});

describe("parseTargets for the smoke (rl-a only)", () => {
  it("loads rl-a's secrets without rl-b's files", () => {
    const d = tmp();
    writeFileSync(join(d, "REDLINE_RL_A_HOOK_KEY"), "k".repeat(40), {
      mode: 0o600,
    });
    const env = {
      REDLINE_TARGETS: JSON.stringify({
        mode: "staging",
        secretsDir: d,
        a: {
          name: "rl-a",
          installId: "i-a",
          app: "https://rl-a.example.app",
          content: "https://rl-a.example.page",
          testDomain: "t.example",
        },
        b: {
          name: "rl-b",
          installId: "i-b",
          app: "https://rl-b.example.app",
          content: "https://rl-b.example.page",
          testDomain: "t2.example",
        },
      }),
    };
    expect(() => parseTargets(env)).toThrow(/rl-b hook key/);
    const t = parseTargets(env, { onlyA: true });
    expect(t.a.installId).toBe("i-a");
    expect(secretsOf(t.a).hookKey).toBe("k".repeat(40));
  });
});
