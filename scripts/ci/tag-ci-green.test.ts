import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

// tag-ci-green.sh: a deploy that does not re-run the package tests needs cloud
// CI and public CI to have run them, green, on exactly the code deployed.
// Anything missing, red, running (past the wait) or unreadable is a refusal.
const SCRIPT = script("tag-ci-green.sh");
const TAG = "v0.200.0";
const SHA = "d".repeat(40);
const PSHA = "f".repeat(40);
const REPO = "open-artifacts-ai/open-artifacts-cloud";
const PUB = "open-artifacts-ai/open-artifacts";
const JOBS = [
  "scripts",
  "overlay",
  "overlay-action",
  "lint",
  "e2e (provisioning)",
  "e2e (admin)",
];
const PJOBS = [
  "lint",
  "typecheck",
  "test",
  "authz-matrix",
  "build",
  "no-test-hooks",
  "e2e",
];

// A path under the public repo reads files prefixed "pub-", else the cloud's.
// --jq <expr> is applied like gh does.
const gh = `
full="\${@: -1}"
q=""; prev=""; for a in "$@"; do [ "$prev" = --jq ] && q="$a"; prev="$a"; done
pre=""
case "$full" in repos/${PUB}/*) pre="pub-"; p="\${full#repos/${PUB}/}" ;; *) p="\${full#repos/${REPO}/}" ;; esac
case "$p" in
  actions/workflows/ci.yml/runs\\?event=merge_group*) k=mgruns ;;
  actions/workflows/ci.yml/runs\\?*)
    n=$(( $(cat "$STATE/\${pre}n" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE/\${pre}n"
    k=runs; i=$n
    while [ $i -ge 1 ]; do [ -f "$STATE/\${pre}runs-$i.json" ] && { k="runs-$i"; break; }; i=$((i-1)); done ;;
  git/ref/tags/*) k=ref ;;
  git/tags/*) k=tagobj ;;
  git/commits/*) h="\${p#git/commits/}"; k=gitcommit; [ -f "$STATE/gitcommit-$h.json" ] && k="gitcommit-$h" ;;
  compare/*) k=compare ;;
  contents/PUBLIC_PIN*) printf 'tag=v0.187.0\\nsha=${PSHA}\\n'; exit 0 ;;
  actions/runs/*/jobs\\?*) id="\${p#actions/runs/}"; id="\${id%%/*}"; k=jobs; [ -f "$STATE/\${pre}jobs-$id.json" ] && k="jobs-$id" ;;
  *) exit 1 ;;
esac
f="$STATE/\${pre}$k.json"
[ -f "$f" ] || { echo "HTTP 404" >&2; exit 1; }
if [ -n "$q" ]; then jq -r "$q" "$f"; else cat "$f"; fi`;

type State = Record<string, unknown>;
const jobsOf = (names: string[], conclusion = "success") => ({
  total_count: names.length,
  jobs: names.map((name) => ({ name, status: "completed", conclusion })),
});
const runOf = (id: number, sha: string, extra: object = {}) => ({
  workflow_runs: [
    {
      id,
      head_sha: sha,
      event: "push",
      status: "completed",
      conclusion: "success",
      created_at: "2026-11-15T00:00:00Z",
      ...extra,
    },
  ],
});
const good = (): State => ({
  ref: { object: { type: "commit", sha: SHA } },
  compare: { status: "identical" },
  runs: runOf(77, SHA),
  jobs: jobsOf(JOBS),
  "pub-runs": runOf(55, PSHA, { event: "merge_group" }),
  "pub-jobs": jobsOf(PJOBS),
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
const sleeps = (r: { calls: string[] }) =>
  r.calls.filter((c) => c === "sleep 60").length;
const running = (sha: string, status: string, conclusion: string | null = null, extra = {}) =>
  runOf(77, sha, { status, conclusion, ...extra });

describe("tag-ci-green.sh", () => {
  it("proceeds when cloud CI and public CI are green, reading only", () => {
    const r = run(good());
    expect(r.code).toBe(0);
    expect(r.out).toContain("passed cloud CI and public CI");
    expect(
      r.calls.every((c) => c.startsWith("gh api -X GET") || c.startsWith("sleep")),
    ).toBe(true);
  });

  it("L1: resolves the tag through its ref, never a commit lookup by name, and peels an annotated tag", () => {
    const r = run(good());
    expect(r.calls.some((c) => c.includes(`git/ref/tags/${TAG}`))).toBe(true);
    expect(r.calls.some((c) => c.includes(`commits/${TAG}`))).toBe(false);
    const annotated = edit((s) => {
      s.ref = { object: { type: "tag", sha: "9".repeat(40) } };
      s.tagobj = { object: { type: "commit", sha: SHA } };
    });
    expect(run(annotated).code).toBe(0);
    const calls = run(annotated).calls;
    expect(calls.some((c) => c.includes(`git/tags/${"9".repeat(40)}`))).toBe(true);
    // A ref that is not a commit (a tag of a tree) or does not resolve: refuse.
    for (const bad of [
      { object: { type: "tree", sha: SHA } },
      { object: { type: "commit", sha: "short" } },
      "not json",
      undefined,
    ]) {
      const r2 = run(edit((s) => { s.ref = bad; }));
      expect(r2.code, JSON.stringify(bad)).toBe(1);
    }
  });

  it("refuses at once a cloud run that completed red or cancelled, without waiting", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out"]) {
      const r = run(edit((s) => { s.runs = running(SHA, "completed", conclusion); }));
      expect(r.code, conclusion).toBe(1);
      expect(r.err).toContain(`cloud CI run 77 for ${SHA}: ${conclusion}`);
      expect(sleeps(r)).toBe(0);
    }
  });

  it("waits while the cloud run is queued or in progress, then proceeds when it completes green", () => {
    const s = good();
    s["runs-1"] = running(SHA, "queued");
    s["runs-2"] = running(SHA, "in_progress");
    s["runs-3"] = runOf(77, SHA);
    const r = run(s);
    expect(r.code).toBe(0);
    expect(sleeps(r)).toBe(2);
    expect(r.out).toContain("waiting 60s");
  });

  it("waits, then refuses at once when the run completes red", () => {
    const s = good();
    s["runs-1"] = running(SHA, "in_progress");
    s["runs-2"] = running(SHA, "completed", "failure");
    const r = run(s);
    expect(r.code).toBe(1);
    expect(r.err).toContain("failure");
    expect(sleeps(r)).toBe(1);
  });

  it("waits for a run that appears late, and refuses one that never appears", () => {
    const late = good();
    late["runs-1"] = { workflow_runs: [] };
    late["runs-2"] = { workflow_runs: [] };
    late["runs-3"] = runOf(77, SHA);
    expect(run(late).code).toBe(0);
    const never = edit((s) => { s.runs = { workflow_runs: [] }; });
    const r = run(never);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no cloud CI push/merge-queue run");
    expect(sleeps(r)).toBe(2);
  });

  it("refuses when the run is still going at the cap", () => {
    const r = run(edit((s) => { s.runs = running(SHA, "in_progress"); }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("still in_progress after 180s");
    expect(sleeps(r)).toBe(3);
  });

  it("counts a successful re-run: the latest attempt's status and jobs decide", () => {
    const s = good();
    s["runs-1"] = running(SHA, "in_progress", null, { run_attempt: 2 });
    s["runs-2"] = runOf(77, SHA, { run_attempt: 2 });
    expect(run(s).code).toBe(0);
  });

  it("refuses when a required job is red, missing, skipped or duplicated", () => {
    for (const name of JOBS) {
      for (const conclusion of ["failure", "skipped"]) {
        const r = run(edit((s) => {
          s.jobs.jobs.find((j: { name: string }) => j.name === name).conclusion = conclusion;
        }));
        expect(r.code, `${name} ${conclusion}`).toBe(1);
        expect(r.err).toContain(`job ${name}: ${conclusion}`);
      }
      const gone = run(edit((s) => {
        s.jobs.jobs = s.jobs.jobs.filter((j: { name: string }) => j.name !== name);
        s.jobs.total_count = JOBS.length - 1;
      }));
      expect(gone.code, `${name} missing`).toBe(1);
      expect(gone.err).toContain(`job ${name}: missing`);
    }
    const dup = run(edit((s) => {
      s.jobs.jobs.push({ name: "lint", status: "completed", conclusion: "success" });
      s.jobs.total_count = JOBS.length + 1;
    }));
    expect(dup.code).toBe(1);
    expect(dup.err).toContain("job lint: missing");
  });

  it("refuses a commit that is not on main", () => {
    const r = run(edit((s) => { s.compare.status = "diverged"; }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not on main");
  });

  it("fails closed on an unreadable or unparsable answer, whichever call it is", () => {
    for (const k of ["ref", "compare", "runs", "jobs", "pub-runs", "pub-jobs"]) {
      const gone = run(edit((s) => { s[k] = undefined; }));
      expect(gone.code, `${k} missing`).toBe(1);
      expect(gone.err).toContain("CI guard failed");
      const junk = run(edit((s) => { s[k] = "not json"; }));
      expect(junk.code, `${k} junk`).toBe(1);
    }
    const paged = run(edit((s) => { s.jobs.total_count = 150; }));
    expect(paged.code).toBe(1);
    expect(paged.err).toContain("more than one page");
  });

  it("refuses a bad tag before any call", () => {
    const r = run(good(), "main");
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
  });

  describe("merge-queue tree match", () => {
    const MG_HEAD = "a".repeat(40);
    const TREE = "b".repeat(40);
    const mg = (over: { tree?: string; conclusion?: string; jobRed?: boolean } = {}) => {
      const s = good();
      s.runs = running(SHA, "in_progress"); // the push run is still going
      s.gitcommit = { tree: { sha: TREE } };
      s[`gitcommit-${MG_HEAD}`] = { tree: { sha: over.tree ?? TREE } };
      s.mgruns = {
        workflow_runs: [
          { id: 88, head_sha: MG_HEAD, event: "merge_group", status: "completed", conclusion: over.conclusion ?? "success" },
        ],
      };
      const j = jobsOf(JOBS);
      if (over.jobRed) j.jobs[3].conclusion = "failure";
      s["jobs-88"] = j;
      return s;
    };

    it("proceeds at once on a green merge-queue run whose head has the tag commit's tree", () => {
      const r = run(mg());
      expect(r.code).toBe(0);
      expect(r.out).toContain("merge-queue CI run 88");
      expect(sleeps(r)).toBe(0);
      expect(r.calls.some((c) => c.includes("branch=main"))).toBe(false);
    });

    it("falls back to the push run when the tree differs", () => {
      const r = run(mg({ tree: "c".repeat(40) }));
      expect(r.code).toBe(1);
      expect(r.err).toContain("still in_progress after 180s");
    });

    it("falls back, never proceeds, on a red merge-queue run or a red required job", () => {
      for (const o of [{ conclusion: "failure" }, { jobRed: true }]) {
        const r = run(mg(o));
        expect(r.code, JSON.stringify(o)).toBe(1);
        expect(r.err).toContain("still in_progress after 180s");
      }
    });

    it("falls back when the merge-queue lookup is unreadable", () => {
      const s = mg();
      s.mgruns = undefined;
      expect(run(s).err).toContain("still in_progress after 180s");
    });

    it("still needs public CI green", () => {
      const s = mg();
      s["pub-runs"] = running(PSHA, "completed", "failure");
      expect(run(s).code).toBe(1);
    });
  });

  describe("M1: public CI on the exact PUBLIC_PIN sha", () => {
    it("reads the pin at the tag's commit and checks that sha in the public repo", () => {
      const r = run(good());
      expect(r.calls.some((c) => c.includes(`contents/PUBLIC_PIN?ref=${SHA}`))).toBe(true);
      expect(r.calls.some((c) => c.includes(`repos/${PUB}/actions/workflows/ci.yml/runs`) && c.includes(`head_sha=${PSHA}`))).toBe(true);
    });

    it("accepts a push or a merge_group run, refuses a run at another sha or another event", () => {
      expect(run(edit((s) => { s["pub-runs"] = runOf(55, PSHA, { event: "push" }); })).code).toBe(0);
      for (const bad of [
        runOf(55, "e".repeat(40), { event: "merge_group" }),
        runOf(55, PSHA, { event: "pull_request" }),
      ]) {
        const r = run(edit((s) => { s["pub-runs"] = bad; }));
        expect(r.code).toBe(1);
        expect(r.err).toContain("no public CI push/merge-queue run");
      }
    });

    it("refuses a red public run, a red or missing public job", () => {
      expect(run(edit((s) => { s["pub-runs"] = running(PSHA, "completed", "failure"); })).err).toContain("public CI run 77");
      for (const name of PJOBS) {
        const red = run(edit((s) => { s["pub-jobs"].jobs.find((j: { name: string }) => j.name === name).conclusion = "failure"; }));
        expect(red.code, name).toBe(1);
        expect(red.err).toContain(`job ${name}: failure`);
        const gone = run(edit((s) => {
          s["pub-jobs"].jobs = s["pub-jobs"].jobs.filter((j: { name: string }) => j.name !== name);
          s["pub-jobs"].total_count = PJOBS.length - 1;
        }));
        expect(gone.err, `${name} missing`).toContain(`job ${name}: missing`);
      }
    });

    it("waits for a running public run, sharing one cap with the cloud wait", () => {
      const s = good();
      s["pub-runs-1"] = running(PSHA, "in_progress", null, { event: "merge_group" });
      s["pub-runs-2"] = runOf(55, PSHA, { event: "merge_group" });
      const r = run(s);
      expect(r.code).toBe(0);
      expect(sleeps(r)).toBe(1);
      // Two cloud polls plus public polls past the 3-poll cap refuse.
      const slow = good();
      slow["runs-1"] = running(SHA, "in_progress");
      slow["runs-2"] = running(SHA, "in_progress");
      slow["runs-3"] = runOf(77, SHA);
      slow["pub-runs"] = running(PSHA, "in_progress", null, { event: "merge_group" });
      const r2 = run(slow);
      expect(r2.code).toBe(1);
      expect(r2.err).toContain("public CI run 77");
      expect(r2.err).toContain("after 180s");
    });
  });
});
