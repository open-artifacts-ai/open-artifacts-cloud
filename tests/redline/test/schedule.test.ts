import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Lane, type Phase, PLAN, PLAN_SERIAL } from "../src/lanes.ts";
import { parseManifest } from "../src/report.ts";

// An offline replay of run 42402998826 (cloud, v0.135.0; 19m57s end to end):
// its per-case durations and per-file walls (test/fixtures/run-42402998826.json,
// read from the run's log) go through the lane plans of src/lanes.ts, and the
// job's own phases are laid around them. No request leaves this machine: the
// proof that #1730's plan ends under 10 minutes is a calculation, and its
// inputs are a committed recording.

interface Fixture {
  observedEndSec: number;
  phases: {
    preSec: number;
    mintDoneSec: number;
    bringupDoneSec: number;
    postSec: number;
    revokeSec: number;
    t19Sec: number;
    t19JobReadySec: number;
    mergeSec: number;
    t19SealSec: number;
    t19PollSec: number;
    t19TailSec: number;
  };
  fileWallsSec: Record<string, number>;
  cases: { file: string; name: string; ms: number; status: string }[];
}
const fx = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/run-42402998826.json"),
    "utf8",
  ),
) as Fixture;
const P = fx.phases;
const wall = (f: string): number => {
  const w = fx.fileWallsSec[f];
  if (w === undefined) throw new Error(`no recorded wall for ${f}`);
  return w;
};

interface Knobs {
  /** Seconds the pacing ledgers add to each install lane (hooks, RL_ANON). */
  pacing?: number;
  /** Install lanes (everything but provisioning) run this much slower. */
  slow?: number;
  /** Provisioning's lane starts at the OIDC mint, not the end of bring-up (B4). */
  provFromMint?: boolean;
}

/** Whether a lane is the provisioning lane (it never spends the install pacing). */
const isProv = (l: Lane) =>
  l.files.every((f) => f === "live/provisioning.test.ts");

/**
 * One lane's wall: its files run in order (each file's recorded wall includes
 * its setup and teardown), install lanes scaled and paced.
 */
function laneWall(l: Lane, k: Knobs): number {
  const sum = l.files.reduce((n, f) => n + wall(f), 0);
  return isProv(l) ? sum : sum * (1 + (k.slow ?? 0)) + (k.pacing ?? 0);
}

/**
 * The suite step's end in the job's own clock: it starts at preSec; a phase
 * takes its slowest lane; mergeSec follows the last phase. B4 moves only the
 * provisioning lane's start (its chain waits for bring-up where it must).
 */
function suiteEnd(plan: readonly Phase[], k: Knobs = {}): number {
  let t = P.preSec;
  plan.forEach((phase, i) => {
    const ends = phase.map((l) => {
      const start = k.provFromMint && isProv(l) && i === 0 ? P.mintDoneSec : t;
      return start + laneWall(l, k);
    });
    t = Math.max(...ends);
  });
  return t + P.mergeSec;
}

/** The job's end: the suite, the scan and upload, the revoke, and T19 where it runs. */
function jobEnd(
  plan: readonly Phase[],
  o: Knobs & { t19: "after" | "job" } = { t19: "after" },
): { end: number; t19End: number } {
  const suite = suiteEnd(plan, o);
  const tail = P.postSec + P.revokeSec;
  if (o.t19 === "after")
    return { end: suite + P.t19Sec + tail, t19End: suite + P.t19Sec };
  // The t19 job: ready after its own checkout, install and Chromium, it then
  // waits for the sealed key (bring-up done, seal, poll), runs T19 and scans.
  const start = Math.max(
    P.t19JobReadySec,
    P.bringupDoneSec + P.t19SealSec + P.t19PollSec,
  );
  const t19End = start + P.t19Sec + P.t19TailSec;
  return { end: Math.max(suite + tail, t19End), t19End };
}
const near = (got: number, want: number, tol = 3) =>
  expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThanOrEqual(tol);

describe("the recording (run 42402998826)", () => {
  it("holds every case of the manifest once, with a duration", () => {
    const m = parseManifest(
      readFileSync(join(import.meta.dirname, "../live/manifest.json"), "utf8"),
    );
    expect(fx.cases).toHaveLength(329);
    expect(new Set(fx.cases.map((c) => `${c.file} ${c.name}`)).size).toBe(329);
    expect(new Set(fx.cases.map((c) => `${c.file} ${c.name}`))).toEqual(
      new Set(m.cases.map((c) => `${c.file} ${c.name}`)),
    );
    expect(fx.cases.every((c) => Number.isFinite(c.ms) && c.ms >= 0)).toBe(
      true,
    );
  });

  it("per file, the cases' time fits inside the file's recorded wall", () => {
    for (const [f, w] of Object.entries(fx.fileWallsSec)) {
      const cases = fx.cases.filter((c) => c.file === f);
      const sum = cases.reduce((n, c) => n + c.ms, 0) / 1000;
      expect(cases.length, f).toBeGreaterThan(0);
      expect(sum, `${f}: ${sum} s of cases in ${w} s`).toBeLessThanOrEqual(
        w + 1,
      );
    }
  });

  it("the slow cases the issue names are there (the guard prodClean, the KV waits)", () => {
    const slow = [...fx.cases].sort((a, b) => b.ms - a.ms).slice(0, 5);
    expect(slow.some((c) => c.name.includes("prod is clean"))).toBe(true);
    expect(slow.some((c) => /KV's cache window/.test(c.name))).toBe(true);
  });
});

describe("the schedule simulation", () => {
  it("today's plan reproduces the observed run: 1197 s (19m57s)", () => {
    const { end } = jobEnd(PLAN_SERIAL, { t19: "after" });
    near(end, 1197, 1);
    expect(fx.observedEndSec).toBe(1197);
    // The suite alone: signin+edge, then credentials' chain (the critical path).
    near(suiteEnd(PLAN_SERIAL), 102 + 132.5 + 745.2 + 2, 0.5);
  });

  it("the new plan: 102 + 337.7 + 2 + 28 = 470 s (7.8 min), with T19 in its own job", () => {
    const r = jobEnd(PLAN, { t19: "job" });
    near(r.end, 470, 1);
    expect(r.end).toBeLessThan(600);
    // The t19 job ends at about 298 s, before the redline job does.
    near(r.t19End, 298, 1);
    expect(r.t19End).toBeLessThan(r.end);
  });

  it("the critical path is provisioning; every install lane ends before it", () => {
    const lanes = (PLAN[0] ?? []).map(
      (l) => [l.name, P.preSec + laneWall(l, {})] as const,
    );
    const byEnd = [...lanes].sort((a, b) => b[1] - a[1]);
    expect(byEnd[0]?.[0]).toBe("prov");
    // Next: surfaces, within 3 s of provisioning, which is why sharding is the trigger.
    expect(byEnd[1]?.[0]).toBe("surfaces");
    near(byEnd[0]?.[1] ?? 0, 102 + 337.7);
    near(byEnd[1]?.[1] ?? 0, 102 + 335.0);
    near(
      P.preSec + laneWall(PLAN[0]?.find((l) => l.name === "front") as Lane, {}),
      102 + 177.1,
    );
  });

  it("with T19 still after the suite (the suite change alone): 657 s, over 10 minutes", () => {
    const { end } = jobEnd(PLAN, { t19: "after" });
    near(end, 470 + 187, 1);
    expect(end).toBeGreaterThan(600);
  });

  it.each<[string, Knobs, number]>([
    ["surfaces +60 s pacing", { pacing: 60 }, 527],
    ["install lanes +20%", { slow: 0.2 }, 532],
    ["+60 s pacing and +20% together", { pacing: 60, slow: 0.2 }, 594],
  ])("%s ends at about %i s, under 600", (_, knobs, want) => {
    const { end } = jobEnd(PLAN, { ...knobs, t19: "job" });
    near(end, want, 3);
    expect(end).toBeLessThan(600);
  });

  it("+60 s pacing and +20% leaves under 10 s of headroom: the reason for the sharding trigger", () => {
    const { end } = jobEnd(PLAN, { pacing: 60, slow: 0.2, t19: "job" });
    expect(600 - end).toBeLessThan(10);
    // One more 20 s of anything (a slow candidate) would cross 10 minutes.
    expect(end + 20).toBeGreaterThan(600 - 10);
  });

  it("B4 (provisioning from the mint) saves only what surfaces allows", () => {
    const base = jobEnd(PLAN, { t19: "job" }).end;
    const b4 = jobEnd(PLAN, { provFromMint: true, t19: "job" }).end;
    expect(b4).toBeLessThan(base);
    // Provisioning would end at 64 + 337.7 + 30 = 431.7 s (the spec's "about
    // 432 s"), but surfaces (102 + 335) still ends the run at 467 s until it is
    // sharded: B4 alone saves 3 s, and 432 s needs surfaces split in two.
    near(b4, 467, 1);
    const prov =
      P.mintDoneSec +
      wall("live/provisioning.test.ts") +
      P.mergeSec +
      P.postSec +
      P.revokeSec;
    near(prov, 432, 1);
  });

  it("the plan's lanes are the ones the simulation ran", () => {
    expect(PLAN).toHaveLength(1);
    const names = (PLAN[0] ?? []).map((l) => l.name).sort();
    expect(names).toEqual(["creds", "front", "guard", "prov", "surfaces"]);
    // Every recorded file is in a lane, so no recorded second is left out.
    expect((PLAN[0] ?? []).flatMap((l) => l.files).sort()).toEqual(
      Object.keys(fx.fileWallsSec).sort(),
    );
  });

  it("each lane's cases, replayed one after another, fit its wall", () => {
    for (const l of PLAN[0] ?? []) {
      const caseSec =
        fx.cases
          .filter((c) => l.files.includes(c.file))
          .reduce((n, c) => n + c.ms, 0) / 1000;
      expect(caseSec, l.name).toBeLessThanOrEqual(laneWall(l, {}) + 1);
    }
  });
});

// The model above has no upgrade in it: PRE 102 s is the bring-up of an
// install that already runs the tag (preSec 102, bringupDoneSec 97). A real
// candidate upgrades rl-a and rl-b first. These are the numbers the lead
// reported for run 42436122165 (live, not committed as a fixture), and the
// arithmetic for what #1730 PR 2 changes: the two upgrades at the same time,
// and T19 in its own job. It does NOT reach 10 minutes with that suite wall.
describe("a real upgrade (run 42436122165, reported figures)", () => {
  const live = {
    bringupSec: 232, // rl-a upgraded in ~120 s, then rl-b in ~98 s, serially
    upgradeASec: 120,
    upgradeBSec: 98,
    suiteSec: 437,
    t19Sec: 215,
    revokeSec: 27,
    totalSec: 996, // 16.6 min
  };
  // Everything else the job does (checkout, install, builds, secrets, mint,
  // staged check, uploads, prod mint, scan).
  const otherSec =
    live.totalSec -
    (live.bringupSec + live.suiteSec + live.t19Sec + live.revokeSec);

  it("the reported pieces add up to the reported total", () => {
    expect(otherSec).toBe(85);
  });

  it("serial upgrades with T19 after the suite reproduce the run: 996 s", () => {
    expect(
      otherSec + live.bringupSec + live.suiteSec + live.t19Sec + live.revokeSec,
    ).toBe(996);
  });

  it("concurrent upgrades with T19 beside the suite: 683 s (11.4 min), over 10 minutes", () => {
    // Both upgrades at once cost the longer one: at best the shorter one's
    // time (98 s) comes off the bring-up.
    const bringup =
      live.bringupSec - Math.min(live.upgradeASec, live.upgradeBSec);
    expect(bringup).toBe(134);
    const end = otherSec + bringup + live.suiteSec + live.revokeSec;
    expect(end).toBe(683);
    expect(end).toBeGreaterThan(600);
    // The t19 job starts once the key is sealed (about the end of bring-up)
    // and ends well before the redline job, so the revoke waits for nothing.
    const t19Start = P.mintDoneSec + bringup + 5;
    const t19End = t19Start + live.t19Sec + P.t19TailSec + P.t19PollSec;
    expect(t19End).toBeLessThan(otherSec + bringup + live.suiteSec);
    // What would be needed: a suite wall of at most this.
    expect(600 - (otherSec + bringup + live.revokeSec)).toBe(354);
  });
});
