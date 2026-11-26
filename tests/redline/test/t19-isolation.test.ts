import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEDGER_HOOK_LIMIT,
  SUITE_HOOK_LIMIT,
  T19_HOOK_GAP_MS,
} from "../src/hook-ledger-compat.ts";
import { KEY_TABLE, WAIT_BUDGET_MS } from "../src/rl-anon.ts";

// credentials' link cases compare rl-b's whole member list (and the member
// user's shares and artifacts) before and after. The plan (#1730) runs T19 and
// surfaces beside it, so neither may read or write that state: T19 stays on
// rl-a, and surfaces' org-level read cases judge a status, never a list body.
const root = join(import.meta.dirname, "../../..");
// Allows only the error code public v0.197.0 added to the GET branch (its comment
// and r.code === "members_only"). Any other "members" is a list-body read.
const BODY_READ = /JSON\.parse|\.body\b|members(?!_only\b)/;
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("T19 targets only rl-a", () => {
  const files = [
    "apps/dashboard/playwright.staging.config.ts",
    "apps/dashboard/e2e/staging/targets.ts",
    "apps/dashboard/e2e/staging/gate.ts",
    "apps/dashboard/e2e/staging/hook-pace.ts",
  ];

  it("its config and targets name rl-a (and leo, anonymously), never rl-b", () => {
    const targets = read("apps/dashboard/e2e/staging/targets.ts");
    expect(targets).toMatch(/a\.name !== "rl-a"/);
    // Only REDLINE_TARGETS.a is read: no `.b` and no RL_B secret file.
    expect(targets).not.toMatch(/\bt\.b\b|raw\(\)\.b\b|REDLINE_RL_B|rl-b/i);
    for (const f of files)
      expect(read(f), f).not.toMatch(/rl-b|RL_B_|REDLINE_RL_B/i);
  });

  it("no T19 spec reaches rl-b or its members", () => {
    for (const dir of ["rl-a", "leo"])
      for (const f of readdirSync(
        join(root, "apps/dashboard/e2e/staging", dir),
      )) {
        const t = read(`apps/dashboard/e2e/staging/${dir}/${f}`);
        expect(t, `${dir}/${f}`).not.toMatch(/rl-b|RL_B_|REDLINE_RL_B/i);
      }
  });
});

describe("surfaces' org-level read cases check a status, never a list body", () => {
  it("the case builder hands every org read to the public probe and parses no body itself", () => {
    const s = read("tests/redline/src/surfaces.ts");
    const block = s.slice(
      s.indexOf("for (const s of ORG_SURFACES)"),
      s.indexOf("for (const s of SPACE_SURFACES)"),
    );
    expect(block.length).toBeGreaterThan(500);
    expect(block).toMatch(/s\.probe\(/);
    expect(block).not.toMatch(
      /JSON\.parse|\.json\(\)|\.text\(\)|readBody|getJson|toEqual/,
    );
  });

  it("the public probe's GET branch classifies by status and error code only", () => {
    const p = read("apps/server/test/authz/surfaces.ts");
    const start = p.indexOf("function orgProbe(");
    const get = p.slice(
      p.indexOf('if (method === "GET")', start),
      p.indexOf("if (!w) throw", start),
    );
    expect(get).toMatch(/classify\(route, r,/);
    expect(get).toMatch(/status\(\.\.\.okStatus\)/);
    expect(get).not.toMatch(BODY_READ);
  });

  it("the body-read guard still matches member reads, not the members_only code", () => {
    expect(BODY_READ.test("r.members")).toBe(true);
    expect(BODY_READ.test("body.members")).toBe(true);
    expect(BODY_READ.test('r.code === "members_only"')).toBe(false);
  });

  it("the member-list compare stays in credentials, under the exclusive lock", () => {
    const c = read("tests/redline/live/credentials.test.ts");
    expect(c).toMatch(/const memberList = async/);
    expect((c.match(/withLock\(MEMBERS_LOCK, "exclusive"/g) ?? []).length).toBe(
      2,
    );
    // No other live file or surfaces helper compares rl-b's whole member list.
    for (const f of [
      "live/surfaces.test.ts",
      "live/edge.test.ts",
      "live/signin.test.ts",
      "src/surfaces.ts",
    ]) {
      const t = read(`tests/redline/${f}`);
      expect(t, f).not.toMatch(
        /memberList|"\/api\/v1\/members"\)[\s\S]{0,80}toEqual/,
      );
    }
  });
});

// #1730: T19 runs in its own job, beside the red-line suite. These pin what it
// writes on rl-a and what it shares with the suite's cases (the evidence is in
// the header of .github/workflows/redline-staging.yml). A change that breaks one
// of them has to re-answer "can T19 beside the suite change a verdict?".
describe("T19 beside the suite: what it writes on rl-a, what it shares", () => {
  const dir = "apps/dashboard/e2e/staging";
  const t19Files = (): string[] => {
    const out: string[] = [];
    for (const d of ["", "rl-a", "leo"])
      for (const f of readdirSync(join(root, dir, d)))
        if (f.endsWith(".ts")) out.push(join(dir, d, f));
    return out;
  };

  it("calls five hooks only: session, oauthClient (the p5-oauth member's grant, #2285), codeCapsReset (its own IP's caps), otpLatest and peoplePurge (t19- people only, #2680)", () => {
    const used = new Set<string>();
    for (const f of t19Files())
      for (const m of read(f).matchAll(/TEST_HOOKS\.(\w+)/g))
        used.add(m[1] as string);
    // oauthClient signs in only the fixed member p5-oauth@TEST_DOMAIN and mints a
    // new OAuth client per call (no shared tok: bucket); the suite uses that
    // member only as a credential, never reading its artifacts or comments.
    // peoplePurge (public v0.199.3, #2680) erases only t19- people under
    // TEST_DOMAIN; the suite's people are redline-*, so it can't touch them.
    expect([...used].sort()).toEqual([
      "codeCapsReset",
      "oauthClient",
      "otpLatest",
      "peoplePurge",
      "session",
    ]);
  });

  it("the people purge matches t19- addresses only, enforced in its SQL", () => {
    const hooks = read("apps/server/src/test-hooks/index.ts");
    expect(hooks).toMatch(/substr\(email, 1, 4\) = 't19-'/);
  });

  it("the hook rate limit is per install and IP, and the caps reset deletes only the caller's IP's rows", () => {
    const hooks = read("apps/server/src/test-hooks/index.ts");
    // Before public #3200 one limiter (RL_ANON) under that key; from #3200 the
    // same key on RL_HOOKS for a right key, RL_ANON for a wrong one.
    // TODO(public #3200): keep the second.
    expect(hooks).toMatch(
      /rl\.limit\(\{ key: `test:\$\{authConfig\(env\)\.installKey\}:\$\{ip\}` \}\)|const key = `test:\$\{authConfig\(env\)\.installKey\}:\$\{ip\}`;[\s\S]{0,80}const limiter = keyed \? \(env\.RL_HOOKS \?\? anon\) : anon;\s*if \(!\(await limiter\.limit\(\{ key \}\)\)\.success\)/,
    );
    expect(hooks).toMatch(/const ik = await ipKey\(env, ip\);/);
    expect(hooks).toMatch(/code:ip:\$\{ik\}`, `code:fail:\$\{ik\}`/);
    expect(hooks).toMatch(/resetCodeCaps\(env, ip\)/);
    // The IP is the caller's: cf-connecting-ip, never a body field.
    expect(hooks).toMatch(/c\.req\.header\("cf-connecting-ip"\)/);
  });

  it("every RL_ANON key the suite knows is per IP, per user, per device code, per client, or per install and IP", () => {
    const named: Record<string, string> = {
      "tok:": "per OAuth client (apps/server/src/mcp/oauth-api.ts)",
      "dir:": "per user (apps/server/src/routes/directory.ts)",
      "test:": "install and IP (apps/server/src/test-hooks/index.ts)",
      "${installKey}:": "install and IP (apps/server/src/routes/codes.ts)",
      "oauth-copy:": "install and IP",
      "ip:": "anonymous data writes, by IP (apps/server/src/runtime/routes.ts)",
    };
    for (const k of Object.keys(KEY_TABLE))
      expect(
        /(:ip:|:u:|:dc:)$/.test(k) || k in named,
        `${k}: a bucket not keyed by IP, user, device code or client is shared by both runners; re-answer the T19 question`,
      ).toBe(true);
  });

  it("T19's people and spaces are its own: t19-<run>-<tag> users and test-t19-* spaces; the suite makes none", () => {
    const fx = read(`${dir}/rl-a/fixtures.ts`);
    expect(fx).toMatch(
      /export const email = \(tag: string\) => `t19-\$\{RUN\}-\$\{tag\}@/,
    );
    expect(fx).toMatch(/id: "test-t19-eng"/);
    expect(fx).toMatch(/id: "test-t19-exec"/);
    // No T19 spec writes through a name outside that prefix on rl-a.
    for (const f of t19Files().filter((f) => f.includes("/rl-a/")))
      expect(read(f), f).not.toMatch(/redline-[a-z]+@|`redline-|"redline-/);
    // And the suite never uses a t19- identity (its own seal files aside).
    for (const d of ["src", "live"])
      for (const f of readdirSync(join(root, "tests/redline", d))) {
        if (!f.endsWith(".ts") || f === "t19-seal.ts") continue;
        expect(read(`tests/redline/${d}/${f}`), `${d}/${f}`).not.toMatch(
          /t19-\$\{|["'`]t19-[a-z0-9-]*@/,
        );
      }
  });

  it("the suite's whole member-list reads: credentials' compare on rl-b, and surfaces' memberId, which .finds its own address on whichever side it is given (rl-a too)", () => {
    const hits: string[] = [];
    for (const d of ["src", "live"])
      for (const f of readdirSync(join(root, "tests/redline", d))) {
        if (!f.endsWith(".ts")) continue;
        const t = read(`tests/redline/${d}/${f}`);
        if (/["'`]\/api\/v1\/members["'`]/.test(t)) hits.push(`${d}/${f}`);
      }
    expect(hits.sort()).toEqual([
      "live/credentials.test.ts",
      "src/surfaces.ts",
    ]);
    // credentials compares the whole list, before and after: rl-b only.
    const c = read("tests/redline/live/credentials.test.ts");
    expect(c).toMatch(/getJson\(T\.b, "\/api\/v1\/members"/);
    expect(c).not.toMatch(/getJson\(T\.a, "\/api\/v1\/members"/);
    // surfaces reads the whole list of the side it is given (rl-a included),
    // but only to find its own redline-<who>@ address: members T19 adds
    // (t19-<run>-*) can't change what it finds.
    const sf = read("tests/redline/src/surfaces.ts");
    expect(sf).toMatch(
      /const email = `redline-\$\{who\}@\$\{t\.testDomain\}`;/,
    );
    expect(sf).toMatch(/api\(t, pat, "GET", "\/api\/v1\/members"\)/);
    expect(sf).toMatch(/members\.find\(\(x\) => x\.email === email\)/);
    // And it uses nothing of the list but that one row's id.
    expect(sf).not.toMatch(/members\.(length|map|filter|every|some)\b/);
  });

  it("the hook audit log: T19's rows can't push a red-line case's row out of the newest 200", () => {
    const limit = Number(
      /TEST_AUDIT_LIMIT = (\d+)/.exec(
        read("packages/shared/src/hosted/test-hooks.ts"),
      )?.[1],
    );
    expect(limit).toBe(200);
    // The read is newest first and capped, for the caller's own unique user.
    expect(read("apps/server/src/test-hooks/index.ts")).toMatch(
      /order by at desc, id desc limit \?2/,
    );
    // Before public #3200, T19 paced every hook call to one per HOOK_GAP_MS
    // (hook-pace.ts): in the longest window a case can wait (the wait budget)
    // it adds at most this many rows. From #3200 T19 has no spread, only the
    // ledger's own cap (LEDGER_HOOK_LIMIT a minute). The suite's own rl-a
    // calls are capped at SUITE_HOOK_LIMIT a minute (src/hook-ledger-compat.ts).
    // TODO(public #3200): drop the HOOK_GAP_MS branch with the compat module.
    const windowS = (WAIT_BUDGET_MS + 60_000) / 1000;
    if (T19_HOOK_GAP_MS !== undefined)
      expect(T19_HOOK_GAP_MS).toBeGreaterThanOrEqual(2400);
    const t19Rows =
      T19_HOOK_GAP_MS !== undefined
        ? Math.ceil((windowS * 1000) / T19_HOOK_GAP_MS) + 1
        : Math.ceil(windowS / 60) * LEDGER_HOOK_LIMIT;
    const suiteRows = Math.ceil(windowS / 60) * SUITE_HOOK_LIMIT;
    expect(
      t19Rows + suiteRows,
      `T19 (${t19Rows}) and the suite (${suiteRows}) can write more hook audit rows in a case's window than the newest ${limit} a case reads`,
    ).toBeLessThan(limit);
  });

  it("T19's own hook budget is its runner's: the ledger is per runner (tmpdir), so the suite's ledger never counts T19's calls (the two runners' IPs differing is an assumption: the guard's wrong-key case no longer relies on it)", () => {
    const ledger = read(`${dir}/hook-ledger.ts`);
    expect(ledger).toMatch(/import \{ tmpdir \} from "node:os"/);
    expect(ledger).toMatch(/root: string = tmpdir\(\)/);
    // And rl-a's bucket is the server's, per IP: another runner is another
    // bucket only if its IP differs (assumed, not verified here).
    // Before public #3200 its setup waits the suite's calls out of the window;
    // from #3200 it checks there is room in it. TODO(public #3200): keep the second.
    expect(read(`${dir}/rl-a/guard.setup.ts`)).toMatch(
      /clearT19HookWindow|hookWindowCount\(rlA\(\)\.app\)\)\.toBeLessThan\(HOOK_LIMIT\)/,
    );
  });
});
