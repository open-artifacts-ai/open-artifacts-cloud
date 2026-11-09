import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BARRIERS } from "../src/barrier.ts";
import {
  CLAIMS,
  type Claims,
  conflicts,
  type Lane,
  type LaneResult,
  mergeLanes,
  observe,
  orderedBarriers,
  type Phase,
  PLAN,
  PLAN_SERIAL,
  planProblems,
  selectPlan,
} from "../src/lanes.ts";
import {
  buildReport,
  exitCode,
  parseManifest,
  type Report,
} from "../src/report.ts";
import { MAX_RETRIED_CASES } from "../src/retry.ts";

const pkg = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(pkg, f), "utf8");
const liveFiles = readdirSync(join(pkg, "live"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `live/${f}`)
  .sort();
const planned = PLAN.flat().flatMap((l) => l.files);
const L = (name: string, ...files: string[]): Lane => ({
  name,
  files: files.map((f) => `live/${f}.test.ts`),
});
/** A copy of CLAIMS with one file's claims changed. */
const claimsWith = (
  file: string,
  f: (c: Claims) => Claims,
): Record<string, Claims> => ({
  ...CLAIMS,
  [file]: f(CLAIMS[file] as Claims),
});

describe("the lane plan", () => {
  it("runs every live file exactly once, and only live files", () => {
    expect([...planned].sort()).toEqual(liveFiles);
    expect(new Set(planned).size).toBe(planned.length);
    expect(Object.keys(CLAIMS).sort()).toEqual(liveFiles);
    expect(planProblems(PLAN)).toEqual([]);
    expect(planProblems(PLAN_SERIAL)).toEqual([]);
  });

  it("runs every file the manifest requires, each in exactly one lane", () => {
    const m = parseManifest(read("live/manifest.json"));
    for (const c of m.cases) {
      const lanes = PLAN.flat().filter((l) => l.files.includes(c.file));
      expect(lanes, c.file).toHaveLength(1);
    }
  });

  it("is one phase of six lanes, with signin first in its lane and codes in one lane", () => {
    expect(PLAN).toHaveLength(1);
    expect(PLAN[0]?.map((l) => l.name).sort()).toEqual([
      "creds",
      "front",
      "guard",
      "prov",
      "signup",
      "surfaces",
    ]);
    const front = PLAN[0]?.find((l) => l.name === "front") as Lane;
    expect(front.files).toEqual([
      "live/signin.test.ts",
      "live/edge.test.ts",
      "live/live.test.ts",
    ]);
    const spendCodes = liveFiles.filter(
      (f) => "rl-a/codes" in (CLAIMS[f] as Claims).buckets,
    );
    expect(spendCodes).toEqual(["live/edge.test.ts", "live/signin.test.ts"]);
  });

  it("puts no shared state or rate-limit bucket in two lanes of one phase, in either plan", () => {
    expect(conflicts()).toEqual([]);
    expect(conflicts(PLAN)).toEqual([]);
    expect(conflicts(PLAN_SERIAL)).toEqual([]);
  });

  it("PLAN_SERIAL is the two-phase plan from before #1730, plus #859's provisioner file after provisioning", () => {
    expect(PLAN_SERIAL.map((ph) => ph.map((l) => [...l.files]))).toEqual([
      [["live/signin.test.ts", "live/edge.test.ts"]],
      [
        [
          "live/credentials.test.ts",
          "live/live.test.ts",
          "live/guard.test.ts",
          "live/surfaces.test.ts",
        ],
        ["live/provisioning.test.ts", "live/provisioner.test.ts"],
      ],
    ]);
  });

  it("REDLINE_PLAN picks the plan: serial is the kill switch, anything else unknown throws", () => {
    expect(selectPlan({})).toBe(PLAN);
    expect(selectPlan({ REDLINE_PLAN: "" })).toBe(PLAN);
    expect(selectPlan({ REDLINE_PLAN: "lanes" })).toBe(PLAN);
    expect(selectPlan({ REDLINE_PLAN: "serial" })).toBe(PLAN_SERIAL);
    // The local pair defaults to serial; an explicit choice wins.
    const local = JSON.stringify({ mode: "local" });
    expect(selectPlan({ REDLINE_TARGETS: local })).toBe(PLAN_SERIAL);
    expect(selectPlan({ REDLINE_TARGETS: local, REDLINE_PLAN: "lanes" })).toBe(
      PLAN,
    );
    expect(selectPlan({ REDLINE_TARGETS: "{" })).toBe(PLAN);
    expect(() => selectPlan({ REDLINE_PLAN: "seriel" })).toThrow(
      /REDLINE_PLAN/,
    );
  });

  it("a plan with a repeated lane name or file is refused", () => {
    expect(planProblems([[L("x", "guard"), L("x", "live")]]).join()).toMatch(
      /used twice/,
    );
    expect(planProblems([[L("x", "guard"), L("y", "guard")]]).join()).toMatch(
      /in two lanes/,
    );
    expect(planProblems([[L("x")]]).join()).toMatch(/no file/);
  });

  it("every observe says why, and every ordered bucket names a barrier barrier.ts exports", () => {
    for (const [f, c] of Object.entries(CLAIMS))
      for (const [k, m] of Object.entries(c.state))
        if (typeof m === "object" && "observe" in m)
          expect(m.observe.length, `${f} ${k}`).toBeGreaterThan(10);
    for (const b of orderedBarriers()) expect(BARRIERS).toContain(b);
    expect(orderedBarriers()).toEqual(["broker-done"]);
  });

  it("an observe without a reason is a conflict", () => {
    const c = claimsWith("live/guard.test.ts", (x) => ({
      ...x,
      state: { ...x.state, "rl-x/hook-audit": observe("") },
    }));
    expect(
      conflicts([[L("g", "guard"), L("c", "credentials")]], {
        ...c,
        "live/credentials.test.ts": {
          ...(c["live/credentials.test.ts"] as Claims),
          state: {
            ...(c["live/credentials.test.ts"] as Claims).state,
            "rl-x/hook-audit": "write",
          },
        },
      }).join("\n"),
    ).toMatch(/observe without a reason/);
  });

  // The check above can fail: each plan or claim set below breaks one rule.
  // These are the mutations of #1730's three mechanisms (lock, barrier, pacing).
  it("dropping the members lock brings the conflict back", () => {
    const c = claimsWith("live/credentials.test.ts", (x) => ({
      ...x,
      state: { ...x.state, "rl-b/members+member-user": "write" },
    }));
    expect(conflicts(PLAN, c).join("\n")).toMatch(
      /live\/credentials.test.ts[\s\S]*both hold rl-b\/members\+member-user/,
    );
    const shared = claimsWith("live/surfaces.test.ts", (x) => {
      const { ["rl-b/members+member-user"]: _drop, ...state } = x.state;
      return { ...x, state: { ...state, "rl-b/members+member-user": "write" } };
    });
    expect(conflicts(PLAN, shared).join("\n")).toMatch(
      /both hold rl-b\/members/,
    );
  });

  it("dropping the barrier brings the broker-ip conflict back", () => {
    const c = claimsWith("live/provisioning.test.ts", (x) => ({
      ...x,
      buckets: { ...x.buckets, "broker-ip": "exclusive" },
    }));
    expect(conflicts(PLAN, c).join("\n")).toMatch(
      /live\/provisioning.test.ts and live\/signin.test.ts both spend broker-ip/,
    );
    // A different barrier name is not the same ordering.
    const other = claimsWith("live/provisioning.test.ts", (x) => ({
      ...x,
      buckets: { ...x.buckets, "broker-ip": { ordered: "some-other" } },
    }));
    expect(conflicts(PLAN, other).join("\n")).toMatch(/both spend broker-ip/);
  });

  it("dropping a pacing entry brings the bucket conflict back", () => {
    for (const bucket of ["rl-anon", "rl-a/hooks", "rl-b/hooks"]) {
      const c = claimsWith("live/guard.test.ts", (x) => ({
        ...x,
        buckets: { ...x.buckets, [bucket]: "exclusive" },
      }));
      expect(conflicts(PLAN, c).join("\n"), bucket).toMatch(
        new RegExp(`both spend ${bucket}`),
      );
    }
  });

  it.each<[string, Phase[], RegExp]>([
    [
      "signin and edge in two lanes (both spend the codes bucket)",
      [[L("s", "signin"), L("e", "edge")]],
      /both spend rl-a\/codes/,
    ],
    [
      "two lanes both running surfaces (it writes the world)",
      [[L("a", "surfaces"), L("b", "surfaces")]],
      /both hold rl-x\/world/,
    ],
  ])("finds the conflict: %s", (_, plan, want) => {
    expect(conflicts(plan).join("\n")).toMatch(want);
  });

  it("a file without claims is refused", () => {
    expect(() => conflicts([[L("a", "new"), L("b", "x")]])).toThrow(
      /no claims/,
    );
  });
});

// The claims are written by hand; these read the code for what each file
// does and fail when a claim is missing.
const importsOf = (text: string): string[] =>
  [...text.matchAll(/from "\.\.\/src\/([\w-]+\.ts)"/g)].map(
    (m) => `src/${m[1]}`,
  );

function claimGaps(file: string, c: Claims): string[] {
  const text = read(file);
  const imports = importsOf(text);
  const gaps: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) gaps.push(`${file}: ${what}`);
  };
  const all = [text, ...imports.map(read)].join("\n");
  if (text.includes("loadTargets(")) {
    for (const k of ["rl-x/hook-audit", "rl-x/admin-lists"])
      need(c.state[k] !== undefined, `loadTargets: needs state ${k}`);
    for (const b of ["rl-a/hooks", "rl-b/hooks", "rl-anon"])
      need(
        typeof c.buckets[b] === "object" && "paced" in (c.buckets[b] as object),
        `loadTargets: needs bucket ${b} paced`,
      );
  } else {
    // No install of its own: no hook, session or seeding on rl-a or rl-b.
    for (const s of ["hook(", "prepareSide(", "sessionCred(", "loadTargets("])
      need(!all.includes(s), `calls ${s} without claiming the installs`);
  }
  // Only the files that send codes hold the codes bucket (exclusive: one lane).
  const sendsCodes = imports.includes("src/signin.ts");
  for (const b of ["rl-a/codes", "rl-b/codes"]) {
    need(
      !sendsCodes || c.buckets[b] === "exclusive",
      `sends one-time codes: needs bucket ${b} exclusive`,
    );
    need(
      sendsCodes || c.buckets[b] === undefined,
      `claims ${b} without sending codes`,
    );
  }
  if (/state: "\/api\/v1\/tokens"|"GET", "\/api\/v1\/tokens"/.test(text)) {
    // Snapshots a token list whole: only of a user no other lane touches.
    need(
      /redline-csrf@/.test(text),
      "snapshots the token list: must act as a user of its own (redline-csrf@)",
    );
    need(c.state["rl-x/admin-lists"] === "use", "admin-lists is only used");
  }
  if (
    text.includes("brokerState(") ||
    text.includes("startGoogle(") ||
    text.includes("mustStart(")
  ) {
    need(
      JSON.stringify(c.buckets["broker-ip"]) ===
        JSON.stringify({ ordered: "broker-done" }),
      "reaches the broker: needs broker-ip ordered(broker-done)",
    );
    need(
      text.includes('mark("broker-done")'),
      'reaches the broker: must mark("broker-done")',
    );
  }
  if (imports.includes("src/provisioning.ts")) {
    need(
      JSON.stringify(c.buckets["broker-ip"]) ===
        JSON.stringify({ ordered: "broker-done" }),
      "reaches the broker: needs broker-ip ordered(broker-done)",
    );
    need(
      read("src/provisioning.ts").includes('waitFor("broker-done"'),
      'P34 must waitFor("broker-done")',
    );
    need(
      c.buckets["provisioning-api"] === "exclusive",
      "the Provisioning API: needs provisioning-api",
    );
    need(
      read("src/provisioning.ts").includes("rlAPat") &&
        c.state["rl-a/admin-pat"] !== undefined,
      "P36 uses rl-a's admin PAT: needs rl-a/admin-pat",
    );
    need(
      c.state["staging-inventory"] === "write",
      "creates installs: needs staging-inventory write",
    );
  }
  if (text.includes("staging inventory") || text.includes("inventoryBearer(")) {
    need(
      c.state["staging-inventory"] !== undefined,
      "reads the inventory: needs staging-inventory",
    );
  }
  // The members lock: credentials holds it exclusive around its link cases.
  const exclusive = (text.match(/withLock\(MEMBERS_LOCK, "exclusive"/g) ?? [])
    .length;
  const mine = c.state["rl-b/members+member-user"];
  if (exclusive > 0)
    need(
      typeof mine === "object" && "guarded" in mine && mine.as === "exclusive",
      "takes the members lock exclusive: must claim it exclusive",
    );
  return gaps;
}

describe("the claims match the code", () => {
  it("every live file claims what it touches", () => {
    expect(liveFiles.flatMap((f) => claimGaps(f, CLAIMS[f] as Claims))).toEqual(
      [],
    );
  });

  it("credentials takes the members lock around both link cases", () => {
    const t = read("live/credentials.test.ts");
    expect((t.match(/withLock\(MEMBERS_LOCK, "exclusive"/g) ?? []).length).toBe(
      2,
    );
  });

  it("signin marks broker-done when its broker describes end, before the rest of the file runs", () => {
    const t = read("live/signin.test.ts");
    const mark = t.indexOf('afterAll(() => mark("broker-done"))');
    expect(mark).toBeGreaterThan(t.indexOf('describe("sign-in: broker"'));
    expect(mark).toBeLessThan(t.indexOf('describe("sign-in: Turnstile"'));
    // Every spender of the broker bucket (startGoogle, brokerState) is in the
    // describes before Turnstile's: the afterAll of the last of them runs
    // after all of them.
    const after = t.slice(t.indexOf('describe("sign-in: Turnstile"'));
    expect(after).not.toMatch(/brokerState\(|mustStart\(|startGoogle\(/);
  });

  it("the other writers of rl-b's members claim the lock shared", () => {
    for (const f of [
      "live/surfaces.test.ts",
      "live/signin.test.ts",
      "live/edge.test.ts",
    ])
      expect((CLAIMS[f] as Claims).state["rl-b/members+member-user"]).toEqual({
        guarded: "rl-b-members",
        as: "shared",
      });
  });

  it.each([
    [
      "live/surfaces.test.ts",
      { state: {}, buckets: {} },
      /needs state rl-x\/hook-audit/,
    ],
    [
      "live/edge.test.ts",
      {
        ...(CLAIMS["live/edge.test.ts"] as Claims),
        buckets: {
          "rl-a/hooks": { paced: "x" },
          "rl-b/hooks": { paced: "x" },
          "rl-anon": { paced: "x" },
        },
      },
      /needs bucket rl-a\/codes exclusive/,
    ],
    [
      "live/signin.test.ts",
      {
        ...(CLAIMS["live/signin.test.ts"] as Claims),
        buckets: {
          ...(CLAIMS["live/signin.test.ts"] as Claims).buckets,
          "broker-ip": "exclusive",
        },
      },
      /needs broker-ip ordered/,
    ],
    [
      "live/provisioning.test.ts",
      { state: {}, buckets: { "broker-ip": { ordered: "broker-done" } } },
      /needs provisioning-api[\s\S]*needs rl-a\/admin-pat/,
    ],
    [
      "live/credentials.test.ts",
      {
        ...(CLAIMS["live/credentials.test.ts"] as Claims),
        state: {
          ...(CLAIMS["live/credentials.test.ts"] as Claims).state,
          "rl-b/members+member-user": { guarded: "rl-b-members", as: "shared" },
        },
      },
      /must claim it exclusive/,
    ],
  ] as [string, Claims, RegExp][])(
    "a missing claim fails: %s",
    (file, c, want) => {
      expect(claimGaps(file, c).join("\n")).toMatch(want);
    },
  );
});

describe("mergeLanes", () => {
  const pass = (file: string, name = "x") => ({
    name,
    file,
    level: "pass" as const,
  });
  const lane = (
    files: string[],
    part: LaneResult["part"],
    exit = 0,
  ): LaneResult => ({
    lane: {
      name: (files[0] ?? "").replace(/^live\/|\.test\.ts$/g, ""),
      files,
    },
    exit,
    part,
  });

  it("keeps every lane's cases and notes, in plan order", () => {
    const m = mergeLanes([
      lane(["live/a.test.ts"], {
        cases: [pass("live/a.test.ts")],
        fileNotes: [{ file: "live/a.test.ts", note: "n" }],
      }),
      lane(["live/b.test.ts"], {
        cases: [pass("live/b.test.ts")],
        fileNotes: [],
      }),
    ]);
    expect(m.cases.map((c) => c.file)).toEqual([
      "live/a.test.ts",
      "live/b.test.ts",
    ]);
    expect(m.fileNotes).toHaveLength(1);
    expect(m.runExit).toBe(0);
  });

  it("a lane that wrote no part is a fail case, and its exit is the run's", () => {
    const m = mergeLanes([lane(["live/a.test.ts"], null, 7)]);
    expect(m.cases).toEqual([
      expect.objectContaining({ name: "lane a: no results", level: "fail" }),
    ]);
    expect(m.runExit).toBe(7);
  });

  it("one case reported twice is a fail case", () => {
    const m = mergeLanes([
      lane(["live/a.test.ts"], {
        cases: [pass("live/a.test.ts", "same")],
        fileNotes: [],
      }),
      lane(["live/a.test.ts", "live/b.test.ts"], {
        cases: [pass("live/a.test.ts", "same"), pass("live/b.test.ts", "same")],
        fileNotes: [],
      }),
    ]);
    const dups = m.cases.filter((c) => /duplicate/.test(c.name));
    expect(dups).toEqual([
      expect.objectContaining({
        name: "lane a: duplicate live/a.test.ts same",
        level: "fail",
      }),
    ]);
    expect(buildReport(m.cases, "staging").gate.passed).toBe(false);
  });

  it("a case from a file outside its lane is a fail case", () => {
    const m = mergeLanes([
      lane(["live/a.test.ts"], {
        cases: [pass("live/b.test.ts")],
        fileNotes: [],
      }),
    ]);
    expect(m.cases[0]).toEqual(
      expect.objectContaining({
        name: "lane a: ran live/b.test.ts",
        level: "fail",
      }),
    );
  });

  // The provisioning lane fails while the install lane passes: the run fails,
  // whether the lane reported its failure or died without a part.
  it.each<[string, LaneResult]>([
    [
      "a failed case",
      lane(
        ["live/provisioning.test.ts"],
        {
          cases: [
            {
              name: "P11",
              file: "live/provisioning.test.ts",
              level: "fail",
              reason: "403 expected",
            },
          ],
          fileNotes: [],
        },
        1,
      ),
    ],
    ["no part at all", lane(["live/provisioning.test.ts"], null, 1)],
  ])("one lane fails, the other passes: the run fails (%s)", (_, bad) => {
    const m = mergeLanes([
      lane(["live/guard.test.ts"], {
        cases: [pass("live/guard.test.ts")],
        fileNotes: [],
      }),
      bad,
    ]);
    const r = buildReport(m.cases, "staging");
    expect(r.counts.fail).toBeGreaterThan(0);
    expect(r.gate.passed).toBe(false);
    expect(exitCode(r, true, m.runExit)).not.toBe(0);
    // Even had the lane's vitest exited 0, its fail case fails the run.
    expect(exitCode(r, false, 0)).not.toBe(0);
  });
});

/** Runs `node --experimental-strip-types <args>` in pkg; bounded, own group. */
function node(
  args: string[],
  env: Record<string, string>,
  ms: number,
): Promise<{ code: number; out: string }> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", ...args],
    { cwd: pkg, detached: true, stdio: ["ignore", "pipe", "pipe"], env },
  );
  let out = "";
  child.stdout?.on("data", (d) => {
    out += String(d);
  });
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const timer = setTimeout(kill, ms);
  return new Promise((res) =>
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ code: code ?? 1, out });
    }),
  );
}

describe("the retry cap across processes", () => {
  it("lanes taking retries at once never take more than the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-lanes-retry-"));
    try {
      const file = join(dir, "report.json.retries");
      const script = `import { runBudget } from "./src/retry.ts";
let n = 0;
for (let i = 0; i < ${MAX_RETRIED_CASES}; i++) if (runBudget(${JSON.stringify(file)}).take()) n++;
console.log("took " + n);`;
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
      };
      const runs = await Promise.all(
        Array.from({ length: 4 }, () =>
          node(["--input-type=module", "-e", script], env, 60_000),
        ),
      );
      const took = runs.map((r) =>
        Number(/took (\d+)/.exec(r.out)?.[1] ?? NaN),
      );
      expect(took.every(Number.isFinite)).toBe(true);
      expect(took.reduce((a, b) => a + b, 0)).toBe(MAX_RETRIED_CASES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

// The runner end to end with NO targets: every file fails its setup before
// any request (parseTargets throws; provisioning is not-applicable without
// REDLINE_RELEASE), so nothing leaves this machine. It proves the phases run,
// every lane writes its part, the report holds every manifest case, and the
// run fails.
describe("scripts/redline.ts with no targets", () => {
  it("an unknown REDLINE_PLAN fails closed with a clear error, before any lane starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-lanes-badplan-"));
    try {
      const r = await node(
        ["scripts/redline.ts", "--gate"],
        {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          REDLINE_REPORT: join(dir, "report.json"),
          REDLINE_PLAN: "seriel",
        },
        30_000,
      );
      expect(r.code).toBe(1);
      expect(r.out).toContain(
        'redline: REDLINE_PLAN must be "lanes" or "serial", not "seriel"',
      );
      expect(r.out).not.toContain("redline: phase 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it.each([
    ["the lanes plan", "", PLAN],
    ["REDLINE_PLAN=serial", "serial", PLAN_SERIAL],
  ] as const)(
    "runs every lane, builds one report, and fails the run: %s",
    async (_, plan, expected) => {
      const dir = mkdtempSync(join(tmpdir(), "rl-lanes-run-"));
      try {
        const report = join(dir, "report.json");
        const r = await node(
          ["scripts/redline.ts", "--gate"],
          {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            REDLINE_REPORT: report,
            REDLINE_PLAN: plan,
          },
          170_000,
        );
        expect(r.code).not.toBe(0);
        for (let i = 1; i <= expected.length; i++)
          expect(r.out).toContain(`redline: phase ${i} of ${expected.length}`);
        // A phase with several lanes ran them beside each other: prefixed output.
        for (const ph of expected)
          if (ph.length > 1)
            for (const l of ph) expect(r.out).toContain(`[${l.name}] `);
        const parts = readdirSync(join(dir, "report.lanes")).sort();
        expect(parts).toEqual(
          expected
            .flat()
            .map((l) => `${l.name}.json`)
            .sort(),
        );
        // Every lane's exit left a lane-exit mark, and the lock and barrier
        // directories were made for the run.
        expect(readdirSync(join(dir, "report.json.barriers")).sort()).toEqual(
          expected
            .flat()
            .map((l) => `lane-exit.${l.name}`)
            .sort()
            // mark.broker-done: the signin file's afterAll marks even with no targets
            .concat(
              readdirSync(join(dir, "report.json.barriers")).filter((f) =>
                f.startsWith("mark."),
              ),
            )
            .sort(),
        );
        expect(existsSync(join(dir, "report.json.locks"))).toBe(true);
        const rep = JSON.parse(readFileSync(report, "utf8")) as Report;
        expect(existsSync(join(dir, "report.txt"))).toBe(true);
        const m = parseManifest(read("live/manifest.json"));
        const names = new Set(rep.cases.map((c) => `${c.file} ${c.name}`));
        for (const c of m.cases) expect(names).toContain(`${c.file} ${c.name}`);
        expect(rep.gate.passed).toBe(false);
        expect(rep.cases.some((c) => c.level === "pass")).toBe(false);
        expect(rep.cases.some((c) => /^lane /.test(c.name))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
