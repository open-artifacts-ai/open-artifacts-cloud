import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

// tag-ci-green.sh: a deploy that does not re-run the package tests needs CI to
// have run them, green, on the tag's exact commit. Anything missing, red,
// running or unreadable is a refusal.
const SCRIPT = script("tag-ci-green.sh");
const TAG = "v0.200.0";
const SHA = "d".repeat(40);
const REPO = "open-artifacts-ai/open-artifacts-cloud";
const JOBS = [
  "scripts",
  "overlay",
  "overlay-action",
  "lint",
  "e2e (provisioning)",
  "e2e (admin)",
];

const gh = `
p="\${@: -1}"; p="\${p#repos/$REPO/}"
case "$p" in
  commits/*) k=commit ;;
  compare/*) k=compare ;;
  actions/workflows/ci.yml/runs\\?*)
    n=$(( $(cat "$STATE/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE/n"
    k=runs; i=$n
    while [ $i -ge 1 ]; do [ -f "$STATE/runs-$i.json" ] && { k="runs-$i"; break; }; i=$((i-1)); done ;;
  actions/runs/*/jobs\\?*) k=jobs ;;
  *) exit 1 ;;
esac
[ -f "$STATE/$k.json" ] || { echo "HTTP 404" >&2; exit 1; }
cat "$STATE/$k.json"`;

type State = Record<string, unknown>;
const good = (): State => ({
  commit: { sha: SHA },
  compare: { status: "identical" },
  runs: {
    workflow_runs: [
      {
        id: 77,
        head_sha: SHA,
        event: "push",
        status: "completed",
        conclusion: "success",
        created_at: "2026-11-15T00:00:00Z",
      },
    ],
  },
  jobs: {
    total_count: JOBS.length,
    jobs: JOBS.map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
    })),
  },
});

const run = (state: State, tag = TAG) => {
  const sb = sandbox({ gh, sleep: "true" });
  const dir = join(sb.dir, "state");
  mkdirSync(dir);
  for (const [k, v] of Object.entries(state))
    if (v !== undefined)
      writeFileSync(
        join(dir, `${k}.json`),
        typeof v === "string" ? v : JSON.stringify(v),
      );
  const r = sb.run(["bash", SCRIPT, tag], {
    env: {
      CI_POLL_SECS: "60",
      CI_WAIT_CAP_SECS: "180",
      CI_APPEAR_SECS: "120",
      STATE: dir,
      REPO,
      GH_TOKEN: "gh-token-SHOULD-NEVER-APPEAR",
      GITHUB_REPOSITORY: REPO,
    },
  });
  expect(r.out + r.err).not.toContain("SHOULD-NEVER-APPEAR");
  return { ...r, calls: sb.log() };
};
// biome-ignore lint/suspicious/noExplicitAny: test fixtures
const edit = (f: (s: any) => void) => {
  const s = good();
  f(s);
  return s;
};

describe("tag-ci-green.sh", () => {
  it("proceeds when CI is green on the tag's commit, reading only", () => {
    const r = run(good());
    expect(r.code).toBe(0);
    expect(r.out).toContain("passed CI on main");
    expect(
      r.calls.every(
        (c) => c.startsWith("gh api -X GET") || c.startsWith("sleep"),
      ),
    ).toBe(true);
  });

  it("refuses when there is no CI push run for the commit", () => {
    for (const s of [
      edit((s) => {
        s.runs.workflow_runs = [];
      }),
      edit((s) => {
        s.runs.workflow_runs[0].head_sha = "e".repeat(40);
      }),
      edit((s) => {
        s.runs.workflow_runs[0].event = "pull_request";
      }),
    ]) {
      const r = run(s);
      expect(r.code).toBe(1);
      expect(r.err).toContain("no CI push run");
    }
  });

  it("refuses at once a run that completed red or cancelled, without waiting", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out"]) {
      const r = run(
        edit((s) => {
          s.runs.workflow_runs[0].conclusion = conclusion;
        }),
      );
      expect(r.code, conclusion).toBe(1);
      expect(r.err).toContain(`CI run 77 for ${SHA}: ${conclusion}`);
      expect(r.calls.some((c) => c.startsWith("sleep"))).toBe(false);
    }
  });

  const running = (status: string, conclusion: string | null = null) =>
    // biome-ignore lint/suspicious/noExplicitAny: test fixtures
    edit((s: any) => {
      s.runs.workflow_runs[0] = {
        ...s.runs.workflow_runs[0],
        status,
        conclusion,
      };
    }).runs;

  it("waits while the run is queued or in progress, then proceeds when it completes green", () => {
    const s = good();
    s["runs-1"] = running("queued");
    s["runs-2"] = running("in_progress");
    s["runs-3"] = good().runs;
    const r = run(s);
    expect(r.code).toBe(0);
    expect(r.calls.filter((c) => c === "sleep 60")).toHaveLength(2);
    expect(r.out).toContain("waiting 60s");
  });

  it("waits, then refuses at once when the run completes red", () => {
    const s = good();
    s["runs-1"] = running("in_progress");
    s["runs-2"] = running("completed", "failure");
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.err).toContain("CI run 77");
    expect(r.err).toContain("failure");
    expect(r.calls.filter((c) => c === "sleep 60")).toHaveLength(1);
  });

  it("waits for a run that appears late, and refuses one that never appears", () => {
    const late = good();
    late["runs-1"] = { workflow_runs: [] };
    late["runs-2"] = { workflow_runs: [] };
    late["runs-3"] = good().runs;
    expect(run(late).code).toBe(0);
    const never = good();
    never.runs = { workflow_runs: [] };
    const r = run(never);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no CI push run");
    // The 120 s appear window at a 60 s poll: two sleeps, then refuse.
    expect(r.calls.filter((c) => c === "sleep 60")).toHaveLength(2);
  });

  it("refuses when the run is still going at the cap", () => {
    const s = good();
    s.runs = running("in_progress");
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.err).toContain("still in_progress after 180s");
    expect(r.calls.filter((c) => c === "sleep 60")).toHaveLength(3);
  });

  it("counts a successful re-run: the latest attempt's status and jobs decide", () => {
    const s = good();
    // biome-ignore lint/suspicious/noExplicitAny: test fixtures
    (s.runs as any).workflow_runs[0].run_attempt = 2;
    s["runs-1"] = running("in_progress");
    s["runs-2"] = good().runs;
    expect(run(s).code).toBe(0);
  });

  it("refuses when a required job is red, missing, skipped or duplicated", () => {
    for (const name of JOBS) {
      for (const conclusion of ["failure", "skipped"]) {
        const r = run(
          edit((s) => {
            s.jobs.jobs.find(
              (j: { name: string }) => j.name === name,
            ).conclusion = conclusion;
          }),
        );
        expect(r.code, `${name} ${conclusion}`).toBe(1);
        expect(r.err).toContain(`CI job ${name}: ${conclusion}`);
      }
      const gone = run(
        edit((s) => {
          s.jobs.jobs = s.jobs.jobs.filter(
            (j: { name: string }) => j.name !== name,
          );
          s.jobs.total_count = JOBS.length - 1;
        }),
      );
      expect(gone.code, `${name} missing`).toBe(1);
      expect(gone.err).toContain(`CI job ${name}: missing`);
    }
    const dup = run(
      edit((s) => {
        s.jobs.jobs.push({
          name: "lint",
          status: "completed",
          conclusion: "success",
        });
        s.jobs.total_count = JOBS.length + 1;
      }),
    );
    expect(dup.code).toBe(1);
    expect(dup.err).toContain("CI job lint: missing");
  });

  it("refuses a commit that is not on main", () => {
    const r = run(
      edit((s) => {
        s.compare.status = "diverged";
      }),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not on main");
  });

  it("fails closed on an unreadable or unparsable answer, whichever call it is", () => {
    for (const k of ["commit", "compare", "runs", "jobs"]) {
      const gone = run(
        edit((s) => {
          s[k] = undefined;
        }),
      );
      expect(gone.code, `${k} missing`).toBe(1);
      expect(gone.err).toContain("CI guard failed");
      const junk = run(
        edit((s) => {
          s[k] = "not json";
        }),
      );
      expect(junk.code, `${k} junk`).toBe(1);
    }
    // A job list that runs past one page cannot prove a job's absence.
    const paged = run(
      edit((s) => {
        s.jobs.total_count = 150;
      }),
    );
    expect(paged.code).toBe(1);
    expect(paged.err).toContain("more than one page");
  });

  it("refuses a bad tag before any call", () => {
    const r = run(good(), "main");
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
  });
});
