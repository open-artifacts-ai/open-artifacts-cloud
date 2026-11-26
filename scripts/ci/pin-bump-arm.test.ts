// The pin-only rule for the self-arm (cloud #264): a pure decision, then the
// snapshot and arm calls against a fake gh.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  BOT,
  type Check,
  commitOk,
  decide,
  didNoWork,
  type Exec,
  GATE_RETRY_SPENT,
  GATE_WORKFLOWS,
  GATING_JOBS,
  gateRefusal,
  gateRejected,
  type Input,
  isChainProdDeploy,
  PRE_GATE_WORKFLOWS,
  parseView,
  pinFate,
  type QueueRun,
  queueFailure,
  queueMarker,
  queueNotice,
  queueVerdict,
  RELEASE_RETRY_SPENT,
  requiredChecks,
  retryDue,
  run,
  STAGE_PAGES,
  type StageRun,
  stageSpent,
} from "./pin-bump-arm.ts";

const REPO = "open-artifacts-ai/open-artifacts-cloud";
const PUB = "open-artifacts-ai/open-artifacts";
const OLD = "b".repeat(40);
const NEW = "a".repeat(40);
const HEAD = "c".repeat(40);
/** The main commit that set PUBLIC_PIN to v0.181.0. */
const PIN_COMMIT = "9".repeat(40);
/** When that commit landed: stage runs are read from then on. */
const PIN_AT = "2026-11-26T15:40:03Z";
/** A stage run as the fake lists it; h (its commit) defaults to PIN_COMMIT. */
type Run = StageRun & { h?: string; e?: string };
const pinText = (tag: string, sha: string) => `# c\ntag=${tag}\nsha=${sha}\n`;
const syncedText = (tag: string, sha: string) =>
  `# c\nsha=${sha}\ntag=${tag}\nlist=x\n`;
const HEAD_AT = "2026-11-17T10:00:00Z";
const qrun = (createdAt: string, conclusion: string | null): QueueRun => ({
  createdAt,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
});
const REQUIRED_CHECKS = [
  "scripts",
  "overlay",
  "lint",
  "e2e (provisioning)",
  "e2e (admin)",
];
const green: Check[] = REQUIRED_CHECKS.map((name) => ({
  name,
  status: "completed",
  conclusion: "success",
  app: "github-actions",
}));
const TREE = ["PUBLIC_PIN", "SYNCED_FROM", "pnpm-lock.yaml", "README.md"].map(
  (path) => ({ path, mode: "100644", type: "blob" }),
);

const base = (o: Partial<Input> = {}): Input => ({
  author: BOT,
  headRef: "pin-bump/v0.182.0",
  headRepo: REPO,
  repo: REPO,
  headOid: HEAD,
  checksOid: HEAD,
  files: ["PUBLIC_PIN", "SYNCED_FROM", "pnpm-lock.yaml"].map((filename) => ({
    filename,
    status: "modified",
  })),
  pin: pinText("v0.182.0", NEW),
  synced: syncedText("v0.182.0", NEW),
  mainPin: pinText("v0.181.0", OLD),
  mainSynced: syncedText("v0.181.0", OLD),
  tagSha: NEW,
  released: true,
  tree: TREE,
  checks: green,
  commits: [{ author: BOT, committer: BOT, verified: true }],
  required: REQUIRED_CHECKS,
  armed: false,
  headAt: HEAD_AT,
  queueRuns: [],
  ...o,
});
const left = (o: Partial<Input>, why: RegExp) => {
  const d = decide(base(o));
  expect(d.arm).toBe(false);
  expect(d.why).toMatch(why);
};

describe("decide", () => {
  it("arms a pin-only bump that is green on its head", () => {
    expect(decide(base()).arm).toBe(true);
  });
  it("arms with only the two pin files and no lockfile change", () => {
    expect(decide(base({ files: base().files.slice(0, 2) })).arm).toBe(true);
  });
  it("leaves a PR with an extra file", () => {
    left(
      {
        files: [...base().files, { filename: "apps/x.ts", status: "modified" }],
      },
      /not pin-only: apps\/x.ts/,
    );
  });
  it("leaves a test change", () => {
    left(
      { files: [...base().files, { filename: "a.test.ts", status: "added" }] },
      /not pin-only/,
    );
  });
  it("leaves a renamed file, even onto a pin file", () => {
    left(
      {
        files: [
          {
            filename: "PUBLIC_PIN",
            status: "renamed",
            previous_filename: "old",
          },
          ...base().files.slice(1),
        ],
      },
      /renamed/,
    );
  });
  it("leaves a mode change", () => {
    left(
      {
        files: [
          { filename: "PUBLIC_PIN", status: "changed" },
          ...base().files.slice(1),
        ],
      },
      /changed/,
    );
  });
  it("leaves a removed or added pin file", () => {
    left(
      {
        files: [
          { filename: "pnpm-lock.yaml", status: "removed" },
          ...base().files.slice(0, 2),
        ],
      },
      /removed/,
    );
    left(
      {
        files: [
          { filename: "SYNCED_FROM", status: "added" },
          base().files[0]!,
          base().files[2]!,
        ],
      },
      /added/,
    );
  });
  it("leaves a PR that does not move both pin files", () => {
    left(
      { files: [base().files[0]!, base().files[2]!] },
      /SYNCED_FROM is not changed/,
    );
  });
  it("leaves a PR with no files", () => left({ files: [] }, /no files/));
  it("leaves a sha that is not what the tag points to", () => {
    left({ tagSha: "d".repeat(40) }, /not what v0.182.0 points to/);
    left({ tagSha: "" }, /unresolved/);
  });
  it("leaves a tag that is not the branch's", () => {
    left(
      { pin: pinText("v0.183.0", NEW), synced: syncedText("v0.183.0", NEW) },
      /not the branch's/,
    );
  });
  it("leaves a SYNCED_FROM that names another sha or tag", () => {
    left({ synced: syncedText("v0.182.0", OLD) }, /SYNCED_FROM/);
    left({ synced: syncedText("v0.181.0", NEW) }, /SYNCED_FROM/);
    left({ synced: "# nothing\n" }, /SYNCED_FROM/);
  });
  it("leaves a pin file without a valid tag and sha", () => {
    left({ pin: "# nothing\n" }, /no valid tag/);
    left({ pin: pinText("v0.182.0", "short") }, /no valid tag/);
  });
  it("leaves another author, including a lookalike", () => {
    left({ author: "leourbina" }, /author/);
    left({ author: "open-artifacts-release" }, /author/);
    left({ author: "Open-Artifacts-Release[bot]" }, /author/);
    left({ author: `x${BOT}` }, /author/);
  });
  it("leaves another branch, or a fork", () => {
    left({ headRef: "feature/pin-bump/v0.182.0" }, /branch/);
    left({ headRef: "pin-bump/v0.182.0-rc1" }, /branch/);
    left({ headRepo: "someone/open-artifacts-cloud" }, /head is in/);
  });
  it("leaves checks read for an older head", () => {
    left({ checksOid: "e".repeat(40) }, /current head/);
  });
  it("leaves a required check that failed, is running, or never ran", () => {
    for (const name of REQUIRED_CHECKS) {
      const others = green.filter((c) => c.name !== name);
      left(
        {
          checks: [
            ...others,
            {
              name,
              status: "completed",
              conclusion: "failure",
              app: "github-actions",
            },
          ],
        },
        /not green/,
      );
      left(
        {
          checks: [
            ...others,
            {
              name,
              status: "completed",
              conclusion: "cancelled",
              app: "github-actions",
            },
          ],
        },
        /not green/,
      );
      left(
        {
          checks: [
            ...others,
            {
              name,
              status: "completed",
              conclusion: "skipped",
              app: "github-actions",
            },
          ],
        },
        /not green/,
      );
      left(
        {
          checks: [
            ...others,
            {
              name,
              status: "in_progress",
              conclusion: null,
              app: "github-actions",
            },
          ],
        },
        /not green/,
      );
      left({ checks: others }, /has not run/);
    }
  });
  it("leaves a PR where any run of a required check is not green", () => {
    left(
      {
        checks: [
          ...green,
          {
            name: "lint",
            status: "completed",
            conclusion: "failure",
            app: "github-actions",
          },
        ],
      },
      /lint is not green/,
    );
  });
  it("ignores a red check that is not required", () => {
    expect(
      decide(
        base({
          checks: [
            ...green,
            {
              name: "other",
              status: "completed",
              conclusion: "failure",
              app: "github-actions",
            },
          ],
        }),
      ).arm,
    ).toBe(true);
  });
  it("leaves a tag that is not newer than main's pin", () => {
    left({ mainPin: pinText("v0.182.0", NEW) }, /not newer/);
    left({ mainPin: pinText("v0.190.0", OLD) }, /not newer/);
    left({ mainPin: "# nothing\n" }, /no tag/);
  });
  it("compares tags as numbers, not text", () => {
    expect(
      decide(
        base({
          headRef: "pin-bump/v0.1000.0",
          pin: pinText("v0.1000.0", NEW),
          synced: syncedText("v0.1000.0", NEW),
          mainPin: pinText("v0.999.0", OLD),
        }),
      ).arm,
    ).toBe(true);
  });
  it("leaves a PR with a human commit", () => {
    left(
      {
        commits: [
          { author: BOT, committer: BOT, verified: true },
          { author: "leourbina", committer: "leourbina", verified: true },
        ],
      },
      /commit is by leourbina/,
    );
  });
  it("leaves a bot-authored commit pushed by a human (committer differs)", () => {
    left(
      { commits: [{ author: BOT, committer: "leourbina", verified: true }] },
      /committed by leourbina/,
    );
  });
  it("accepts web-flow as committer only for a verified commit authored by the bot", () => {
    const wf = (author: string, verified: boolean) => ({
      commits: [{ author, committer: "web-flow", verified }],
    });
    expect(decide(base(wf(BOT, true))).arm).toBe(true);
    left(
      wf("leourbina", true),
      /commit is by leourbina, committed by web-flow/,
    );
    left(wf(BOT, false), /unverified/);
    left(wf("", true), /committed by web-flow/);
    left(wf("web-flow", true), /commit is by web-flow/);
    left(wf(`x${BOT}`, true), /commit is by/);
    // One bad commit among good ones still refuses.
    left(
      {
        commits: [
          { author: BOT, committer: "web-flow", verified: true },
          { author: "leourbina", committer: "web-flow", verified: true },
        ],
      },
      /leourbina/,
    );
    // Other committers stay refused, even for the bot's own commit.
    left(
      { commits: [{ author: BOT, committer: "github", verified: true }] },
      /committed by github/,
    );
    expect(
      commitOk({ author: BOT, committer: "web-flow", verified: true }),
    ).toBe(true);
    expect(commitOk({ author: BOT, committer: BOT, verified: true })).toBe(
      true,
    );
  });
  it("takes back the bot's arming over a human web-flow commit, keeps it for the bot's", () => {
    expect(
      go(
        "arm",
        fake({ armed: true, commitAuthor: "leourbina", committer: "web-flow" }),
      ).disarmed,
    ).toEqual([7]);
    expect(
      go("arm", fake({ armed: true, committer: "web-flow" })).disarmed,
    ).toEqual([]);
    expect(go("arm", fake({ committer: "web-flow" })).armed).toEqual([7]);
  });
  it("leaves a commit GitHub could not attribute, or a PR with no commits", () => {
    left(
      { commits: [{ author: "", committer: "", verified: true }] },
      /unknown/,
    );
    left({ commits: [] }, /no commits/);
  });
  it("fails closed when the required checks are unreadable", () => {
    left({ required: [] }, /could not be read/);
  });
  it("leaves an unverified bot commit", () => {
    left(
      { commits: [{ author: BOT, committer: BOT, verified: false }] },
      /unverified/,
    );
  });
  it("leaves pin files that are not main's content with only tag and sha moved", () => {
    left(
      { pin: `${pinText("v0.182.0", NEW)}list=extra\n` },
      /PUBLIC_PIN is not main's/,
    );
    left(
      { pin: pinText("v0.182.0", NEW).replace("# c", "# changed") },
      /PUBLIC_PIN is not main's/,
    );
    left(
      {
        pin: `${pinText("v0.182.0", NEW)}sha=${NEW}\n`,
        mainPin: `${pinText("v0.181.0", OLD)}sha=${OLD}\n`,
      },
      /PUBLIC_PIN is not main's/,
    );
    left(
      { pin: `${pinText("v0.182.0", NEW)}sha=${OLD}\n` },
      /PUBLIC_PIN is not main's/,
    );
    left(
      { synced: syncedText("v0.182.0", NEW).replace("list=x", "list=y") },
      /SYNCED_FROM is not main's/,
    );
    left(
      { synced: `${syncedText("v0.182.0", NEW)}sha=${NEW}\n` },
      /SYNCED_FROM is not main's/,
    );
    left(
      { synced: `${syncedText("v0.182.0", NEW)}# added\n` },
      /SYNCED_FROM is not main's/,
    );
    left(
      { pin: pinText("v0.182.0", NEW).replace("\n", "\r\n") },
      /PUBLIC_PIN is not main's/,
    );
  });
  it("leaves a tag with no published, non-prerelease release", () => {
    left({ released: false }, /no published/);
  });
  it("counts only checks run by github-actions", () => {
    left(
      { checks: green.map((c) => ({ ...c, app: "other-app" })) },
      /has not run/,
    );
    left(
      { checks: green.map((c) => ({ ...c, app: undefined })) },
      /has not run/,
    );
    const forged = green.filter((c) => c.name !== "lint");
    left(
      {
        checks: [
          ...forged,
          {
            name: "lint",
            status: "completed",
            conclusion: "success",
            app: "evil",
          },
        ],
      },
      /lint has not run/,
    );
  });
  it("leaves a pin file that is not a regular file", () => {
    for (const mode of ["100755", "120000", "160000"])
      left(
        {
          tree: TREE.map((t) => (t.path === "PUBLIC_PIN" ? { ...t, mode } : t)),
        },
        /not a regular file/,
      );
    left(
      {
        tree: TREE.map((t) =>
          t.path === "SYNCED_FROM" ? { ...t, type: "tree" } : t,
        ),
      },
      /not a regular file/,
    );
    left(
      { tree: TREE.filter((t) => t.path !== "pnpm-lock.yaml") },
      /pnpm-lock.yaml is not a regular file \(mode missing\)/,
    );
  });
  it("leaves an armed or queued PR", () =>
    left({ armed: true }, /already armed/));
});

const RULES = JSON.stringify([
  { type: "pull_request", parameters: {} },
  {
    type: "required_status_checks",
    parameters: {
      required_status_checks: REQUIRED_CHECKS.map((context) => ({
        context,
        integration_id: 15368,
      })),
    },
  },
  { type: "merge_queue", parameters: {} },
]);
describe("the merge queue run of a pin-only bump (no re-arm loop)", () => {
  const FAIL = qrun("2026-11-17T10:30:00Z", "failure");
  it("leaves a head whose merge queue run failed, timed out or never started", () => {
    for (const c of ["failure", "timed_out", "startup_failure"])
      left(
        { queueRuns: [qrun(FAIL.createdAt, c)] },
        new RegExp(`merge queue run on this head ended ${c}`),
      );
  });
  it("does not hold a head for one cancelled, skipped or neutral run (no verdict)", () => {
    for (const c of [
      "cancelled",
      "skipped",
      "neutral",
      "action_required",
      null,
    ])
      expect(
        decide(base({ queueRuns: [qrun(FAIL.createdAt, c)] })).arm,
        String(c),
      ).toBe(true);
  });
  it("a cancelled run newer than a failure does not clear the failure; a success does", () => {
    const cancelled = qrun("2026-11-17T11:00:00Z", "cancelled");
    expect(decide(base({ queueRuns: [FAIL, cancelled] })).arm).toBe(false);
    const ok = qrun("2026-11-17T12:00:00Z", "success");
    expect(decide(base({ queueRuns: [FAIL, cancelled, ok] })).arm).toBe(true);
  });
  it("holds a head whose newest three queue runs were all cancelled", () => {
    const c = (at: string) => qrun(at, "cancelled");
    const three = [
      c("2026-11-17T10:10:00Z"),
      c("2026-11-17T10:20:00Z"),
      c("2026-11-17T10:30:00Z"),
    ];
    left({ queueRuns: three }, /last 3 merge queue runs.*all cancelled/);
    left({ queueRuns: [...three].reverse() }, /all cancelled/);
    // Two are not enough, a success or a still-running newest run breaks the streak,
    // and cancels made before the head commit are another head's.
    expect(decide(base({ queueRuns: three.slice(1) })).arm).toBe(true);
    expect(
      decide(
        base({
          queueRuns: [...three, qrun("2026-11-17T10:40:00Z", "success")],
        }),
      ).arm,
    ).toBe(true);
    expect(
      decide(
        base({ queueRuns: [...three, qrun("2026-11-17T10:40:00Z", null)] }),
      ).arm,
    ).toBe(true);
    expect(
      decide(
        base({
          queueRuns: [
            c("2026-11-17T09:00:00Z"),
            c("2026-11-17T09:10:00Z"),
            c("2026-11-17T10:10:00Z"),
          ],
        }),
      ).arm,
    ).toBe(true);
    // The newest three decide: an older failure under three newer cancels holds as cancels.
    expect(
      queueVerdict(HEAD_AT, [
        FAIL,
        ...three.map((r, n) => ({
          ...r,
          createdAt: `2026-11-17T1${n + 1}:00:00Z`,
        })),
      ])?.cancels,
    ).toBe(true);
    expect(
      queueVerdict(HEAD_AT, [
        qrun("2026-11-17T10:05:00Z", "success"),
        ...three.map((r, n) => ({
          ...r,
          createdAt: `2026-11-17T1${n + 1}:00:00Z`,
        })),
      ])?.cancels,
    ).toBe(true);
  });
  it("arms a head whose queue run is still going, or ended green", () => {
    expect(
      decide(base({ queueRuns: [qrun("2026-11-17T10:30:00Z", null)] })).arm,
    ).toBe(true);
    expect(
      decide(base({ queueRuns: [qrun("2026-11-17T10:30:00Z", "success")] }))
        .arm,
    ).toBe(true);
  });
  it("ignores a failed run made before this head commit (an older head)", () => {
    const old = qrun("2026-11-17T09:59:59Z", "failure");
    expect(decide(base({ queueRuns: [old] })).arm).toBe(true);
  });
  it("judges by the newest run after the head, whatever the order", () => {
    const bad = qrun("2026-11-17T10:30:00Z", "failure");
    const good = qrun("2026-11-17T11:00:00Z", "success");
    expect(decide(base({ queueRuns: [bad, good] })).arm).toBe(true);
    expect(decide(base({ queueRuns: [good, bad] })).arm).toBe(true);
    const late = qrun("2026-11-17T12:00:00Z", "failure");
    expect(decide(base({ queueRuns: [good, bad, late] })).arm).toBe(false);
    expect(decide(base({ queueRuns: [late, good, bad] })).arm).toBe(false);
  });
  it("fails closed on an unreadable head date or run date", () => {
    left({ headAt: "" }, /date is unreadable/);
    left({ headAt: "soon" }, /date is unreadable/);
    left({ queueRuns: [qrun("", "success")] }, /no readable date/);
  });
  it("queueFailure says nothing without runs", () => {
    expect(queueFailure(HEAD_AT, [])).toBeUndefined();
  });
  it("run: a failed queue run keeps the PR un-armed on every pass, until a new head", () => {
    // The first pass leaves its one comment (see the next describe); with the
    // marker there, every later pass writes nothing at all.
    const f = fake({
      queue: [FAIL],
      comments: [{ user: { login: BOT }, body: queueMarker(HEAD) }],
    });
    for (let n = 0; n < 3; n++) {
      const r = go("arm", f);
      expect(r.armed).toEqual([]);
      expect(r.write).toBe(false);
      expect(r.merges).toEqual([]);
      expect(r.logs.join("\n")).toMatch(
        /#7: leave: its merge queue run on this head ended failure/,
      );
    }
    // A new head commit made after the failed run is judged afresh.
    expect(
      go("arm", fake({ queue: [FAIL], headAt: "2026-11-17T11:00:00Z" })).armed,
    ).toEqual([7]);
  });
  it("run: a queue run in the API that cannot be read leaves the PR", () => {
    const r = go("arm", fake({ notFound: ["event=merge_group"] }));
    expect(r.armed).toEqual([]);
    expect(r.logs.join("\n")).toMatch(/could not read what it needs/);
    const g = go("arm", fake({ notFound: ["/git/commits/"] }));
    expect(g.armed).toEqual([]);
  });
  it("run: a bot-armed PR with a failed queue run is disarmed", () => {
    const f = fake({ armed: true, queue: [FAIL] });
    const r = go("arm", f);
    expect(r.disarmed).toEqual([7]);
  });
});

describe("the failed queue run leaves one visible trace per head", () => {
  const RUN_URL = `https://github.com/${REPO}/actions/runs/123456`;
  const FAIL: QueueRun = {
    ...qrun("2026-11-17T10:30:00Z", "failure"),
    url: RUN_URL,
  };
  const posts = (f: ReturnType<typeof fake>) =>
    f.calls.filter((c) => c.join(" ").includes("-X POST"));
  const mine = (head = HEAD) => ({
    user: { login: BOT },
    body: `${queueMarker(head)}\nold`,
  });
  it("plan reports write=true, and posts nothing", () => {
    const f = fake({ queue: [FAIL] });
    const r = go("plan", f);
    expect(r.write).toBe(true);
    expect(posts(f)).toEqual([]);
    expect(r.armed).toEqual([]);
  });
  it("arm posts one comment with the marker and the run link, and never arms", () => {
    const f = fake({ queue: [FAIL] });
    const r = go("arm", f);
    expect(r.noticed).toEqual([7]);
    expect(r.armed).toEqual([]);
    expect(r.merges).toEqual([]);
    expect(posts(f)).toHaveLength(1);
    const call = (posts(f)[0] ?? []).join(" ");
    expect(call).toContain(`repos/${REPO}/issues/7/comments`);
    expect(call).toContain(queueMarker(HEAD));
    expect(call).toContain(RUN_URL);
    expect(call).toMatch(/port or fix is needed/);
    expect(call).toMatch(/new commit/);
    expect(call).toMatch(/by hand/);
    expect(call).not.toContain("\u2014");
  });
  it("posts nothing more once its own marker for this head is there", () => {
    const f = fake({ queue: [FAIL], comments: [mine()] });
    const r = go("arm", f);
    expect(posts(f)).toEqual([]);
    expect(r.noticed).toEqual([]);
    expect(r.write).toBe(false);
    expect(go("plan", fake({ queue: [FAIL], comments: [mine()] })).write).toBe(
      false,
    );
  });
  it("counts only the bot's marker, and only for this head", () => {
    const stranger = { user: { login: "someone" }, body: queueMarker(HEAD) };
    expect(posts(fake({ queue: [FAIL], comments: [stranger] }))).toEqual([]);
    for (const comments of [[stranger], [mine("9".repeat(40))]]) {
      const f = fake({ queue: [FAIL], comments });
      go("arm", f);
      expect(posts(f)).toHaveLength(1);
    }
  });
  it("says nothing when the PR is held back for another reason, or the queue run is fine", () => {
    for (const o of [
      { checks: green.slice(1) },
      { commitAuthor: "leourbina" },
      { released: false },
    ]) {
      const f = fake({ queue: [FAIL], ...o });
      go("arm", f);
      expect(posts(f)).toEqual([]);
    }
    const ok = fake({ queue: [qrun("2026-11-17T10:30:00Z", "success")] });
    go("arm", ok);
    expect(posts(ok)).toEqual([]);
    const g = fake({ queue: [FAIL], armed: true, autoBy: "leourbina" });
    go("arm", g);
    expect(posts(g)).toEqual([]);
  });
  it("a new head after the failure is judged afresh and gets no comment", () => {
    const f = fake({ queue: [FAIL], headAt: "2026-11-17T11:00:00Z" });
    const r = go("arm", f);
    expect(posts(f)).toEqual([]);
    expect(r.armed).toEqual([7]);
  });
  it("takes back the bot's own arming over a failed queue run, and says so once", () => {
    const f = fake({ queue: [FAIL], armed: true });
    const r = go("arm", f);
    expect(r.disarmed).toEqual([7]);
    expect(posts(f)).toHaveLength(1);
  });
  it("turns the run red when the comment cannot be read or posted", () => {
    expect(() => go("arm", fake({ queue: [FAIL], postFails: true }))).toThrow(
      /403/,
    );
    expect(() =>
      go("arm", fake({ queue: [FAIL], notFound: ["/issues/7/comments"] })),
    ).toThrow(/Not Found/);
  });
  it("says so when the hold is three cancels in a row", () => {
    const runs = [1, 2, 3].map((n) => ({
      ...qrun(`2026-11-17T10:${n}0:00Z`, "cancelled"),
      url: `https://github.com/${REPO}/actions/runs/${n}`,
    }));
    const f = fake({ queue: runs });
    const r = go("arm", f);
    expect(r.noticed).toEqual([7]);
    const call = (posts(f)[0] ?? []).join(" ");
    expect(call).toMatch(/cancelled 3 times in a row/);
    expect(call).toContain("/actions/runs/3");
    expect(r.armed).toEqual([]);
  });
  it("a cancelled run alone leaves no comment, and the PR is armed", () => {
    const f = fake({ queue: [qrun("2026-11-17T10:30:00Z", "cancelled")] });
    const r = go("arm", f);
    expect(posts(f)).toEqual([]);
    expect(r.armed).toEqual([7]);
  });
  it("links only this repository's run pages", () => {
    const i = base({ queueRuns: [{ ...FAIL, url: "https://evil.example/x" }] });
    expect(queueNotice(i, REPO)).not.toContain("evil.example");
    expect(queueNotice(i, REPO)).toContain(queueMarker(HEAD));
    expect(queueNotice(base({ queueRuns: [FAIL] }), REPO)).toContain(RUN_URL);
  });
  it("reads the run url in the gh query", () => {
    const f = fake({ queue: [FAIL] });
    go("arm", f);
    const q = f.calls
      .map((c) => c.join(" "))
      .find((c) => c.includes("event=merge_group"));
    expect(q).toContain("url: .html_url");
  });
});

describe("requiredChecks", () => {
  it("reads the contexts of the required_status_checks rule", () => {
    expect(requiredChecks(RULES)).toEqual(REQUIRED_CHECKS);
  });
  it("joins several rules without duplicates", () => {
    const two = JSON.stringify([
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "a" }, { context: "b" }],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "b" }, { context: "c" }],
        },
      },
    ]);
    expect(requiredChecks(two)).toEqual(["a", "b", "c"]);
  });
  it("returns none for no rule, junk, or a non-list", () => {
    expect(requiredChecks("[]")).toEqual([]);
    expect(requiredChecks("not json")).toEqual([]);
    expect(requiredChecks('{"message":"Not Found"}')).toEqual([]);
    expect(requiredChecks('[{"type":"required_status_checks"}]')).toEqual([]);
  });
});

type Call = string[];
const fake = (
  o: {
    files?: Input["files"];
    checks?: Check[];
    headNow?: string;
    armed?: boolean;
    author?: string;
    commitAuthor?: string;
    committer?: string;
    rulesFail?: boolean;
    unverified?: boolean;
    released?: boolean;
    autoBy?: string;
    mode?: string;
    annotated?: boolean;
    extraRuns?: boolean;
    /** Any call whose args contain one of these answers 404. */
    notFound?: string[];
    busy?: string;
    busyStatus?: string;
    prodDone?: boolean;
    junkCount?: boolean;
    deployTitles?: string[];
    deepDeploy?: boolean;
    /** The completed redline-staging runs, newest first. */
    gateRuns?: { t: string; c: string | null; a: number }[];
    /** Runs of each stage before the gate for main's pin commit, newest first. */
    stageRuns?: Record<string, Run[]>;
    /** compare/<pin>...<sha> status per sha (default ahead: it contains the pin). */
    compare?: Record<string, string>;
    /** A run's jobs by run id (default one job that did work). */
    jobs?: Record<number, { name: string; conclusion: string | null }[]>;
    /** Dispatched deploy runs titled as staging's chain deploy of main's pin. */
    stagingDeploys?: Run[];
    tagSha?: string;
    queue?: QueueRun[];
    headAt?: string;
    comments?: { user: { login: string }; body: string }[];
    postFails?: boolean;
  } = {},
) => {
  const calls: Call[] = [];
  const files = o.files ?? base().files;
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const a = args.join(" ");
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (o.notFound?.some((n) => a.includes(n)))
      return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    if (a.includes("commits?sha=main&path=PUBLIC_PIN&per_page=1"))
      return ok(
        o.junkCount ? "oops" : JSON.stringify({ sha: PIN_COMMIT, at: PIN_AT }),
      );
    const jb = /actions\/runs\/(\d+)\/jobs\?per_page=100/.exec(a);
    if (jb) {
      expect(a).toContain("--jq");
      const js = o.jobs?.[Number(jb[1])] ?? [
        { name: "work", conclusion: "success" },
      ];
      return ok(
        JSON.stringify(js.map((j) => ({ n: j.name, c: j.conclusion }))),
      );
    }
    const cmp = /\/compare\/(\w+)\.\.\.(\w+) /.exec(a);
    if (cmp) {
      expect(cmp[1]).toBe(PIN_COMMIT);
      return ok(`${o.compare?.[cmp[2] as string] ?? "ahead"}\n`);
    }
    const st =
      /actions\/workflows\/([\w.-]+)\/runs\?branch=main(&event=workflow_dispatch)?&created=%3E%3D(\S+)&per_page=100&page=(\d+)/.exec(
        a,
      );
    if (st) {
      expect(st[3]).toBe(PIN_AT);
      expect(a).toContain("--jq");
      const deploy = st[1] === "deploy-hosted-platform.yml";
      const gate = st[1] === "redline-staging.yml";
      expect(Boolean(st[2])).toBe(deploy || gate);
      const all: Run[] = gate
        ? (o.gateRuns ?? []).map((g) => ({
            s: "completed",
            e: "workflow_dispatch",
            ...g,
          }))
        : ((deploy ? o.stagingDeploys : o.stageRuns?.[st[1] as string]) ?? []);
      const page = Number(st[4]);
      const r = all
        .slice((page - 1) * 100, page * 100)
        .map((x) => ({ h: PIN_COMMIT, ...x }));
      return ok(JSON.stringify({ n: r.length, r }));
    }
    const wr = /actions\/workflows\/([\w.-]+)\/runs\?status=(\w+)/.exec(a);
    if (wr) {
      if (wr[1] === "redline-staging.yml" && wr[2] === "completed") {
        expect(a).toMatch(/per_page=20\b/);
        expect(a).toContain("--jq");
        if (o.junkCount) return ok("oops");
        return ok(JSON.stringify(o.gateRuns ?? []));
      }
      if (wr[2] !== "success") {
        expect(a).toMatch(/per_page=1\b/);
        expect(a).toContain("--jq");
      }
      if (wr[1] === "deploy-hosted-platform.yml" && wr[2] === "success") {
        const page = Number(/&page=(\d+)/.exec(a)?.[1]);
        expect(a).toMatch(/per_page=100\b/);
        expect(a).toContain("--jq");
        if (o.junkCount) return ok("oops");
        const t = o.deployTitles ?? [
          "deploy-hosted-platform prod v0.181.0 [c43692402507-1]",
        ];
        if (o.prodDone === false)
          return ok(
            JSON.stringify({
              n: 3,
              t: ["deploy-hosted-platform prod v0.180.0 [c1-1]"],
            }),
          );
        // A long history: the pin's deploy sits on page 3.
        if (o.deepDeploy)
          return ok(
            JSON.stringify(page === 3 ? { n: 100, t } : { n: 100, t: [] }),
          );
        return ok(JSON.stringify({ n: 5, t }));
      }
      if (o.junkCount) return ok("oops");
      return ok(
        o.busy === wr[1] && (o.busyStatus ?? "in_progress") === wr[2]
          ? "1"
          : "0",
      );
    }
    if (a.includes("/git/commits/"))
      return ok(JSON.stringify({ committer: { date: o.headAt ?? HEAD_AT } }));
    if (a.includes("actions/workflows/ci.yml/runs?event=merge_group")) {
      expect(a).toContain("per_page=100");
      expect(a).toContain("gh-readonly-queue/main/pr-7-");
      return ok(JSON.stringify(o.queue ?? []));
    }
    if (a.includes("/pulls?state=open"))
      return ok(
        JSON.stringify([
          [
            {
              number: 7,
              user: { login: o.author ?? BOT },
              head: {
                ref: "pin-bump/v0.182.0",
                sha: HEAD,
                repo: { full_name: REPO },
              },
            },
            {
              number: 8,
              user: { login: "someone" },
              head: {
                ref: "x",
                sha: "f".repeat(40),
                repo: { full_name: REPO },
              },
            },
          ],
        ]),
      );
    if (a.includes("/pulls/7/files")) return ok(JSON.stringify([files]));
    if (a.includes("contents/PUBLIC_PIN?ref=main"))
      return ok(pinText("v0.181.0", OLD));
    if (a.includes("contents/PUBLIC_PIN")) return ok(pinText("v0.182.0", NEW));
    if (a.includes("contents/SYNCED_FROM?ref=main"))
      return ok(syncedText("v0.181.0", OLD));
    if (a.includes("contents/SYNCED_FROM"))
      return ok(syncedText("v0.182.0", NEW));
    if (a.includes("/pulls/7/commits"))
      return ok(
        JSON.stringify([
          [
            {
              author: { login: o.commitAuthor ?? BOT },
              committer: { login: o.committer ?? BOT },
              commit: { verification: { verified: !o.unverified } },
            },
          ],
        ]),
      );
    if (a.includes("/rules/branches/main"))
      return o.rulesFail ? { code: 1, stdout: "", stderr: "403" } : ok(RULES);
    if (a.includes("/check-runs")) {
      const runs = (o.checks ?? green).map((c) => ({
        ...c,
        app: { slug: c.app },
      }));
      return ok(
        JSON.stringify(
          o.extraRuns
            ? [{ check_runs: runs.slice(0, 2) }, { check_runs: runs.slice(2) }]
            : [{ check_runs: runs }],
        ),
      );
    }
    if (a.includes("/git/trees/"))
      return ok(
        JSON.stringify({
          tree: TREE.map((t) =>
            t.path === "PUBLIC_PIN" && o.mode ? { ...t, mode: o.mode } : t,
          ),
        }),
      );
    if (a.includes(`${PUB}/git/ref/tags/v0.182.0`))
      return ok(
        JSON.stringify({
          object: o.annotated
            ? { type: "tag", sha: "1".repeat(40) }
            : { type: "commit", sha: o.tagSha ?? NEW },
        }),
      );
    if (a.includes(`${PUB}/git/tags/${"1".repeat(40)}`))
      return ok(
        JSON.stringify({ object: { type: "commit", sha: o.tagSha ?? NEW } }),
      );
    if (a.includes(`${PUB}/releases/tags/`))
      return ok(
        JSON.stringify({ draft: false, prerelease: o.released === false }),
      );
    if (a.startsWith("api graphql")) {
      expect(a).toContain("pullRequest(number: $n)");
      expect(a).toContain("isInMergeQueue");
      return ok(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                headRefOid: o.headNow ?? HEAD,
                isInMergeQueue: false,
                autoMergeRequest: o.armed
                  ? {
                      enabledBy: {
                        __typename: o.autoBy ? "User" : "Bot",
                        login: o.autoBy ?? "open-artifacts-release",
                      },
                    }
                  : null,
              },
            },
          },
        }),
      );
    }
    if (a.includes("/issues/7/comments")) {
      if (a.includes("-X POST"))
        return o.postFails
          ? { code: 1, stdout: "", stderr: "HTTP 403" }
          : ok("{}");
      return ok(JSON.stringify([o.comments ?? []]));
    }
    if (a.startsWith("pr merge")) return ok("");
    return { code: 1, stdout: "", stderr: `unexpected ${cmd} ${a}` };
  };
  return { exec, calls };
};
const go = (mode: "plan" | "arm", f: ReturnType<typeof fake>) => {
  const logs: string[] = [];
  const r = run({
    mode,
    exec: f.exec,
    repo: REPO,
    publicRepo: PUB,
    log: (l) => logs.push(l),
  });
  return {
    ...r,
    logs,
    merges: f.calls.filter((c) => c[1] === "pr" && c[2] === "merge"),
  };
};

describe("run", () => {
  it("plan reports write=true and never merges", () => {
    const r = go("plan", fake());
    expect(r.write).toBe(true);
    expect(r.merges).toEqual([]);
  });
  it("arm squash-merges on auto, pinned to the head it judged", () => {
    const r = go("arm", fake());
    expect(r.armed).toEqual([7]);
    expect(r.merges[0]).toEqual([
      "gh",
      "pr",
      "merge",
      "7",
      "--auto",
      "--squash",
      "--match-head-commit",
      HEAD,
      "--repo",
      REPO,
    ]);
  });
  it("does nothing for a PR by someone else, and never reads its files", () => {
    const f = fake({ author: "someone" });
    const r = go("arm", f);
    expect(r.write).toBe(false);
    expect(r.merges).toEqual([]);
    expect(f.calls.some((c) => c.join(" ").includes("/pulls/8/files"))).toBe(
      false,
    );
  });
  it("does nothing with an extra file, and does not fetch pin contents", () => {
    const f = fake({
      files: [...base().files, { filename: "a.ts", status: "added" }],
    });
    const r = go("arm", f);
    expect(r.write).toBe(false);
    expect(r.logs.join()).toMatch(/not pin-only/);
  });
  it("does nothing when the head moved after the checks were read", () => {
    const r = go("arm", fake({ headNow: "9".repeat(40) }));
    expect(r.armed).toEqual([]);
    expect(r.logs.join()).toMatch(/current head/);
  });
  it("does nothing when a check is red, a sha is wrong, or it is armed", () => {
    expect(go("arm", fake({ checks: green.slice(1) })).armed).toEqual([]);
    expect(go("arm", fake({ tagSha: "d".repeat(40) })).armed).toEqual([]);
    expect(go("arm", fake({ armed: true })).armed).toEqual([]);
  });
  it("does nothing when a human pushed a commit, or the rules cannot be read", () => {
    expect(go("arm", fake({ commitAuthor: "leourbina" })).armed).toEqual([]);
    expect(go("arm", fake({ rulesFail: true })).armed).toEqual([]);
  });
  it("peels an annotated tag, and reads every page of check runs", () => {
    expect(go("arm", fake({ annotated: true, extraRuns: true })).armed).toEqual(
      [7],
    );
    expect(
      go("arm", fake({ annotated: true, tagSha: "d".repeat(40) })).armed,
    ).toEqual([]);
  });
  it("does nothing for an unverified commit, a prerelease, or a non-regular pin file", () => {
    expect(go("arm", fake({ unverified: true })).armed).toEqual([]);
    expect(go("arm", fake({ released: false })).armed).toEqual([]);
    expect(go("arm", fake({ mode: "120000" })).armed).toEqual([]);
  });
  it("takes back the bot's own arming when the PR no longer qualifies", () => {
    const f = fake({ armed: true, commitAuthor: "leourbina" });
    const r = go("arm", f);
    expect(r.disarmed).toEqual([7]);
    expect(
      f.calls.filter((c) =>
        c.join(" ").startsWith("gh pr merge 7 --disable-auto --repo"),
      ),
    ).toHaveLength(1);
    expect(r.logs.join("\n")).toMatch(
      /disabled auto-merge: a commit is not by the bot/,
    );
  });
  it("plan reports write=true for a take-back but changes nothing", () => {
    const f = fake({ armed: true, checks: green.slice(1) });
    const r = go("plan", f);
    expect(r.write).toBe(true);
    expect(r.merges).toEqual([]);
  });
  it("leaves an arming that still qualifies, one by a person, and a queued PR", () => {
    expect(go("arm", fake({ armed: true })).disarmed).toEqual([]);
    expect(
      go(
        "arm",
        fake({ armed: true, autoBy: "leourbina", checks: green.slice(1) }),
      ).disarmed,
    ).toEqual([]);
  });
  it("an armed-by-bot PR whose inputs cannot be read is disarmed, whichever read fails", () => {
    for (const notFound of [
      [`${PUB}/releases/tags/`],
      [`${PUB}/git/ref/tags/`],
      ["contents/PUBLIC_PIN?ref="],
      ["contents/SYNCED_FROM?ref="],
      ["/git/trees/"],
      ["/check-runs"],
      ["/pulls/7/files"],
    ]) {
      const f = fake({ armed: true, notFound });
      const r = go("arm", f);
      expect(r.disarmed, notFound.join()).toEqual([7]);
      expect(r.armed).toEqual([]);
      expect(
        f.calls.filter((c) =>
          c.join(" ").startsWith("gh pr merge 7 --disable-auto --repo"),
        ),
      ).toHaveLength(1);
      expect(r.logs.join("\n")).toMatch(/could not read what it needs/);
    }
  });
  it("an unarmed PR whose inputs cannot be read is left, and the run does not throw", () => {
    const f = fake({ notFound: [`${PUB}/releases/tags/`] });
    const r = go("arm", f);
    expect(r.write).toBe(false);
    expect(r.merges).toEqual([]);
  });
  it("plan reports write=true for a PR it will disarm because a read failed", () => {
    const r = go(
      "plan",
      fake({ armed: true, notFound: [`${PUB}/releases/tags/`] }),
    );
    expect(r.write).toBe(true);
    expect(r.merges).toEqual([]);
  });
  it("for an armed-by-bot PR the commits are checked first: a bad one disarms before other reads", () => {
    const f = fake({ armed: true, commitAuthor: "leourbina" });
    const r = go("arm", f);
    expect(r.disarmed).toEqual([7]);
    const reads = f.calls.map((c) => c.join(" "));
    expect(reads.some((c) => c.includes("/pulls/7/files"))).toBe(false);
    expect(reads.some((c) => c.includes("/releases/tags/"))).toBe(false);
    const g = fake({ armed: true, unverified: true });
    expect(go("arm", g).disarmed).toEqual([7]);
    expect(g.calls.some((c) => c.join(" ").includes("/pulls/7/files"))).toBe(
      false,
    );
  });
  it("a state that cannot be read leaves the PR alone", () => {
    const f = fake({ armed: true, notFound: ["api graphql"] });
    const r = go("arm", f);
    expect(r.disarmed).toEqual([]);
    expect(r.write).toBe(false);
  });
  it("an API error throws, so the run is red", () => {
    const exec: Exec = () => ({ code: 1, stdout: "", stderr: "boom" });
    expect(() =>
      run({ mode: "plan", exec, repo: REPO, publicRepo: PUB, log: () => {} }),
    ).toThrow(/boom/);
  });
});

describe("gateRefusal", () => {
  const idle = { busy: [], prodDeployed: true, mainTag: "v0.181.0" };
  it("lets an idle pipeline with main's pin deployed to prod through", () => {
    expect(gateRefusal(idle)).toBeUndefined();
  });
  it("refuses while a gate workflow runs", () => {
    expect(gateRefusal({ ...idle, busy: ["hosted-publish.yml"] })).toMatch(
      /candidate open: hosted-publish.yml/,
    );
  });
  it("lets the next bump through when main's pin was rejected", () => {
    expect(
      gateRefusal({ ...idle, prodDeployed: false, rejected: true }),
    ).toBeUndefined();
    expect(
      gateRefusal({
        ...idle,
        busy: ["redline-staging.yml"],
        prodDeployed: false,
        rejected: true,
      }),
    ).toMatch(/candidate open: redline-staging.yml/);
  });
  it("refuses while main's pin has no prod deploy", () => {
    expect(gateRefusal({ ...idle, prodDeployed: false })).toMatch(
      /v0.181.0 has no successful prod deploy/,
    );
  });
});

describe("gateRejected", () => {
  const T = "v0.246.0";
  it("is the newest run for the tag failing on a rerun", () => {
    expect(
      gateRejected(
        [
          { t: `redline-staging ${T}`, c: "failure", a: 2 },
          { t: `redline-staging ${T}`, c: "success", a: 1 },
        ],
        T,
      ),
    ).toBe(true);
  });
  it("a newer passing run for the tag wins over an older rejection", () => {
    expect(
      gateRejected(
        [
          { t: `redline-staging ${T}`, c: "success", a: 1 },
          { t: `redline-staging ${T}`, c: "failure", a: 2 },
        ],
        T,
      ),
    ).toBe(false);
  });
  it("a first-attempt failure, no run, or a longer tag is not a rejection", () => {
    expect(
      gateRejected([{ t: `redline-staging ${T}`, c: "failure", a: 1 }], T),
    ).toBe(false);
    expect(gateRejected([], T)).toBe(false);
    expect(
      gateRejected([{ t: `redline-staging ${T}0`, c: "failure", a: 2 }], T),
    ).toBe(false);
  });
});

describe("parseView", () => {
  const gql = (pr: unknown) =>
    JSON.stringify({ data: { repository: { pullRequest: pr } } });
  it("reads an arming by the release bot, whose GraphQL login has no [bot]", () => {
    expect(
      parseView(
        gql({
          headRefOid: HEAD,
          isInMergeQueue: false,
          autoMergeRequest: {
            enabledBy: { __typename: "Bot", login: "open-artifacts-release" },
          },
        }),
      ),
    ).toEqual({ oid: HEAD, armed: true, autoMergeBy: BOT });
  });
  it("reads an arming by a person as theirs, never the bot's", () => {
    const v = parseView(
      gql({
        headRefOid: HEAD,
        isInMergeQueue: false,
        autoMergeRequest: {
          enabledBy: { __typename: "User", login: "leourbina" },
        },
      }),
    );
    expect(v).toEqual({ oid: HEAD, armed: true, autoMergeBy: "leourbina" });
    // A user named like the bot is still not the bot.
    expect(
      parseView(
        gql({
          headRefOid: HEAD,
          isInMergeQueue: false,
          autoMergeRequest: {
            enabledBy: { __typename: "User", login: "open-artifacts-release" },
          },
        }),
      ).autoMergeBy,
    ).not.toBe(BOT);
  });
  it("reads a queued PR as armed with no auto-merge owner", () => {
    expect(
      parseView(
        gql({ headRefOid: HEAD, isInMergeQueue: true, autoMergeRequest: null }),
      ),
    ).toEqual({ oid: HEAD, armed: true, autoMergeBy: undefined });
    expect(
      parseView(
        gql({
          headRefOid: HEAD,
          isInMergeQueue: true,
          autoMergeRequest: {
            enabledBy: { __typename: "Bot", login: "open-artifacts-release" },
          },
        }),
      ).autoMergeBy,
    ).toBeUndefined();
  });
  it("reads an unarmed PR", () => {
    expect(
      parseView(
        gql({
          headRefOid: HEAD,
          isInMergeQueue: false,
          autoMergeRequest: null,
        }),
      ),
    ).toEqual({ oid: HEAD, armed: false, autoMergeBy: undefined });
  });
  it("throws on an error, a missing PR, junk, or a bad head sha (fail closed)", () => {
    expect(() =>
      parseView(JSON.stringify({ errors: [{ message: "x" }] })),
    ).toThrow();
    expect(() => parseView(gql(null))).toThrow();
    expect(() => parseView("not json")).toThrow();
    expect(() =>
      parseView(gql({ headRefOid: "abc", isInMergeQueue: false })),
    ).toThrow();
  });
  it("never asks gh pr view for JSON fields", () => {
    const f = fake();
    go("arm", f);
    expect(f.calls.some((c) => c[1] === "pr" && c[2] === "view")).toBe(false);
  });
});

describe("isChainProdDeploy", () => {
  it("counts the chain's run of exactly that tag", () => {
    expect(
      isChainProdDeploy(
        "deploy-hosted-platform prod v0.183.0 [c43692402507-1]",
        "v0.183.0",
      ),
    ).toBe(true);
  });
  it("never matches a bare prefix of a longer tag", () => {
    expect(
      isChainProdDeploy(
        "deploy-hosted-platform prod v0.184.0 [c43692402507-1]",
        "v0.18.0",
      ),
    ).toBe(false);
    expect(
      isChainProdDeploy(
        "deploy-hosted-platform prod v0.18.0 [c1-1]",
        "v0.18.0",
      ),
    ).toBe(true);
    expect(
      isChainProdDeploy(
        "deploy-hosted-platform prod v0.18.04 [c1-1]",
        "v0.18.0",
      ),
    ).toBe(false);
    expect(
      isChainProdDeploy(
        "deploy-hosted-platform prod v0.1840.0 [c1-1]",
        "v0.184.0",
      ),
    ).toBe(false);
  });
  it("does not count a run without a chain id (manual or partial), or another env", () => {
    expect(
      isChainProdDeploy("deploy-hosted-platform prod v0.183.0", "v0.183.0"),
    ).toBe(false);
    expect(
      isChainProdDeploy(
        "deploy-hosted-platform prod v0.183.0 [manual]",
        "v0.183.0",
      ),
    ).toBe(false);
    expect(
      isChainProdDeploy(
        "deploy-hosted-platform prod v0.183.0 [c1-1] extra",
        "v0.183.0",
      ),
    ).toBe(false);
    expect(
      isChainProdDeploy(
        "deploy-hosted-platform staging v0.183.0 [c1-1]",
        "v0.183.0",
      ),
    ).toBe(false);
    expect(
      isChainProdDeploy(
        "deploy-hosted-platform prod v0.183.0 [c1-1",
        "v0.183.0",
      ),
    ).toBe(false);
  });
});

describe("the release gate in run", () => {
  it("finds the pin's deploy on a later page, and fails closed past the cap", () => {
    expect(go("arm", fake({ deepDeploy: true })).armed).toEqual([7]);
    const none = go(
      "arm",
      fake({
        deepDeploy: true,
        deployTitles: [
          "deploy-hosted-platform prod v0.181.0 [c1-1]".replace(
            "v0.181.0",
            "v0.1.0",
          ),
        ],
      }),
    );
    expect(none.armed).toEqual([]);
    expect(none.logs.join("\n")).toMatch(/no successful prod deploy/);
  });
  it("a manual prod deploy of the pin without a chain id does not count", () => {
    const r = go(
      "arm",
      fake({ deployTitles: ["deploy-hosted-platform prod v0.181.0"] }),
    );
    expect(r.armed).toEqual([]);
  });
  it("names the five workflows", () => {
    expect(GATE_WORKFLOWS).toEqual([
      "hosted-publish.yml",
      "staging-release-chain.yml",
      "deploy-hosted-platform.yml",
      "redline-staging.yml",
      "prod-release-chain.yml",
    ]);
  });
  it("refuses while any gate workflow is queued or in progress", () => {
    for (const busy of GATE_WORKFLOWS)
      for (const busyStatus of ["queued", "in_progress"]) {
        const r = go("arm", fake({ busy, busyStatus }));
        expect(r.armed, `${busy} ${busyStatus}`).toEqual([]);
        expect(r.write).toBe(false);
        expect(r.logs.join("\n")).toMatch(
          new RegExp(`candidate open: ${busy.replace(".", "\\.")}`),
        );
      }
  });
  it("refuses while main's pin has no successful prod deploy", () => {
    const r = go("arm", fake({ prodDone: false }));
    expect(r.armed).toEqual([]);
    expect(r.logs.join("\n")).toMatch(/no successful prod deploy/);
  });
  it("arms past main's pin when the gate rejected it after the retry (#448)", () => {
    const rejected = [
      { t: "redline-staging v0.181.0", c: "failure", a: 2 },
      { t: "redline-staging v0.180.0", c: "success", a: 1 },
    ];
    expect(
      go("arm", fake({ prodDone: false, gateRuns: rejected })).armed,
    ).toEqual([7]);
  });
  it("still waits on main's pin while its gate failed only once, or another tag's did", () => {
    for (const gateRuns of [
      [{ t: "redline-staging v0.181.0", c: "failure", a: 1 }],
      [{ t: "redline-staging v0.180.0", c: "failure", a: 2 }],
      [{ t: "redline-staging v0.181.0", c: "cancelled", a: 2 }],
    ]) {
      const r = go("arm", fake({ prodDone: false, gateRuns }));
      expect(r.armed, JSON.stringify(gateRuns)).toEqual([]);
      expect(r.logs.join("\n")).toMatch(/no successful prod deploy/);
    }
  });
  // v0.253.0 (cloud #264): its public npm pack failed, so hosted-release failed
  // on all three attempts and the pin could never reach prod; #505 (v0.253.1)
  // was left with "main's pin v0.253.0 has no successful prod deploy yet".
  const hr = (s: string, c: string | null, a: number, t = "hosted-release") =>
    ({ s, c, a, t }) as StageRun;
  it("v0.253.0: a hosted-release that failed with its retry spent lets the next pin arm", () => {
    const r = go(
      "arm",
      fake({
        prodDone: false,
        stageRuns: { "hosted-release.yml": [hr("completed", "failure", 3)] },
      }),
    );
    expect(r.armed).toEqual([7]);
    expect(r.logs.join("\n")).toContain(
      "main's pin v0.181.0 can't reach prod: hosted-release.yml failed with its retry spent",
    );
  });
  it("a hosted-release still running, or failed with a retry still due, keeps the hold", () => {
    for (const run of [
      hr("in_progress", null, 3),
      hr("queued", null, 1),
      hr("completed", "failure", 2),
      hr("completed", "failure", 1),
      hr("completed", "cancelled", 3),
      // A dry run never counts.
      hr("completed", "failure", 3, "hosted-release (dry run)"),
    ]) {
      const r = go(
        "arm",
        fake({
          prodDone: false,
          stageRuns: { "hosted-release.yml": [run] },
        }),
      );
      expect(r.armed, JSON.stringify(run)).toEqual([]);
      expect(r.logs.join("\n")).toMatch(/no successful prod deploy/);
    }
  });
  it("any other stage before the gate spent releases the hold: hosted-publish, staging-release-chain, staging's deploy", () => {
    for (const wf of ["hosted-publish.yml", "staging-release-chain.yml"])
      expect(
        go(
          "arm",
          fake({
            prodDone: false,
            stageRuns: { [wf]: [hr("completed", "failure", 3, wf)] },
          }),
        ).armed,
        wf,
      ).toEqual([7]);
    const d = go(
      "arm",
      fake({
        prodDone: false,
        stagingDeploys: [
          hr(
            "completed",
            "failure",
            3,
            "deploy-hosted-platform staging v0.181.0 [sc45000000001-1]",
          ),
        ],
      }),
    );
    expect(d.armed).toEqual([7]);
    expect(d.logs.join("\n")).toContain(
      "staging deploy failed with its retry spent",
    );
  });
  it("a stage spent for a pin whose gate then passed keeps the hold: the pin is on its way to prod", () => {
    const r = go(
      "arm",
      fake({
        prodDone: false,
        gateRuns: [{ t: "redline-staging v0.181.0", c: "success", a: 1 }],
        stageRuns: { "hosted-release.yml": [hr("completed", "failure", 3)] },
      }),
    );
    expect(r.armed).toEqual([]);
  });
  it("a newer run of the stage after the spent one decides: a rerun in progress keeps the hold", () => {
    const r = go(
      "arm",
      fake({
        prodDone: false,
        stageRuns: {
          "hosted-release.yml": [
            hr("in_progress", null, 1),
            hr("completed", "failure", 3),
          ],
        },
      }),
    );
    expect(r.armed).toEqual([]);
  });
  // The Prover's replay on #506 (cloud #459's v0.246.1 pattern): a hand dispatch
  // of hosted-release from a later main builds the same tag. Its run, not the pin
  // commit's, is the latest relevant one.
  it("a newer hosted-release building the same tag from a later main commit, still running, keeps the hold", () => {
    const later = "8".repeat(40);
    const r = go(
      "arm",
      fake({
        prodDone: false,
        stageRuns: {
          "hosted-release.yml": [
            { ...hr("in_progress", null, 1), h: later },
            hr("completed", "failure", 3),
          ],
        },
      }),
    );
    expect(r.armed).toEqual([]);
    expect(r.logs.join("\n")).toMatch(/no successful prod deploy/);
    // ... and its own spent failure releases it.
    const spent = go(
      "arm",
      fake({
        prodDone: false,
        stageRuns: {
          "hosted-release.yml": [
            { ...hr("completed", "failure", 3), h: later },
          ],
        },
      }),
    );
    expect(spent.armed).toEqual([7]);
  });
  it("a run at a commit without main's pin (another tag's build) is not relevant", () => {
    const old = "7".repeat(40);
    const r = go(
      "arm",
      fake({
        prodDone: false,
        compare: { [old]: "behind" },
        stageRuns: {
          "hosted-release.yml": [
            { ...hr("in_progress", null, 1), h: old },
            hr("completed", "failure", 3),
          ],
          "hosted-publish.yml": [
            hr("in_progress", null, 1, "hosted-publish staging v0.180.0 [x1]"),
          ],
        },
      }),
    );
    expect(r.armed).toEqual([7]);
  });
  // The Prover's other replay: the spent staging deploy sat at list position 21,
  // behind unrelated dispatches. Every page since the pin landed is read.
  it("a spent staging deploy behind 100 or more unrelated dispatches still releases the hold", () => {
    const other = (i: number) =>
      hr(
        "completed",
        "success",
        1,
        `deploy-hosted-platform prod v0.180.0 [c${i}-1]`,
      );
    for (const before of [19, 20, 100, 150]) {
      const r = go(
        "arm",
        fake({
          prodDone: false,
          stagingDeploys: [
            ...Array.from({ length: before }, (_, i) => other(i)),
            hr(
              "completed",
              "failure",
              3,
              "deploy-hosted-platform staging v0.181.0 [sc45000000001-1]",
            ),
          ],
        }),
      );
      expect(r.armed, String(before)).toEqual([7]);
    }
  });
  it("past STAGE_PAGES pages of runs it fails closed: not arming", () => {
    const r = go(
      "arm",
      fake({
        prodDone: false,
        stageRuns: {
          "hosted-release.yml": Array.from({ length: 100 * STAGE_PAGES }, () =>
            hr("completed", "success", 1),
          ),
        },
      }),
    );
    expect(r.armed).toEqual([]);
    expect(r.logs.join("\n")).toMatch(/cannot read the release pipeline/);
  });
  // The Prover's replays on #506 at b36c98bd.
  it("an active recovery in any stage holds, even over an older spent staging deploy (v0.246.1's recovery)", () => {
    const recovery = "8".repeat(40);
    const spentDeploy = hr(
      "completed",
      "failure",
      3,
      "deploy-hosted-platform staging v0.181.0 [sc45000000001-1]",
    );
    const r = go(
      "arm",
      fake({
        prodDone: false,
        stageRuns: {
          "hosted-release.yml": [
            { ...hr("in_progress", null, 1), h: recovery },
          ],
        },
        stagingDeploys: [spentDeploy],
      }),
    );
    expect(r.armed).toEqual([]);
    expect(r.logs.join("\n")).toMatch(/no successful prod deploy/);
    // With the recovery done and nothing else active, the spent deploy decides.
    const after = go(
      "arm",
      fake({
        prodDone: false,
        stageRuns: {
          "hosted-release.yml": [
            { ...hr("completed", "success", 1), h: recovery },
          ],
        },
        stagingDeploys: [spentDeploy],
      }),
    );
    expect(after.armed).toEqual([7]);
  });
  // Run 45853184538's real jobs: resolve passed, every publish job skipped.
  const NO_WORK = [
    { name: "resolve", conclusion: "success" },
    { name: "publish-staging staging v0.181.0", conclusion: "skipped" },
    { name: "publish-prod staging v0.181.0", conclusion: "skipped" },
    { name: "stage-prod staging v0.181.0", conclusion: "skipped" },
  ];
  it("a later hosted-publish that did no work (every publish job skipped) does not mask a spent one", () => {
    const spent = { ...hr("completed", "failure", 3, "hosted-publish"), i: 2 };
    const r = go(
      "arm",
      fake({
        prodDone: false,
        stageRuns: {
          "hosted-publish.yml": [
            {
              ...hr("completed", "success", 1, "hosted-publish"),
              i: 45853184538,
            },
            spent,
          ],
        },
        jobs: { 45853184538: NO_WORK },
      }),
    );
    expect(r.armed).toEqual([7]);
    expect(r.logs.join("\n")).toContain(
      "hosted-publish.yml failed with its retry spent",
    );
    // A later pass that did publish is a recovery: the hold stays.
    const did = go(
      "arm",
      fake({
        prodDone: false,
        stageRuns: {
          "hosted-publish.yml": [
            { ...hr("completed", "success", 1, "hosted-publish"), i: 3 },
            spent,
          ],
        },
        jobs: {
          3: [
            { name: "resolve", conclusion: "success" },
            { name: "publish-staging staging v0.181.0", conclusion: "success" },
          ],
        },
      }),
    );
    expect(did.armed).toEqual([]);
  });
  it("didNoWork and stageSpent: gating jobs aside, all skipped is no work; a failure is always evidence", () => {
    expect(GATING_JOBS).toEqual(["resolve", "plan"]);
    expect(
      didNoWork(NO_WORK.map((j) => ({ n: j.name, c: j.conclusion }))),
    ).toBe(true);
    expect(
      didNoWork([
        { n: "plan", c: "success" },
        { n: "dispatch", c: "skipped" },
      ]),
    ).toBe(true);
    expect(
      didNoWork([
        { n: "plan", c: "success" },
        { n: "dispatch", c: "success" },
      ]),
    ).toBe(false);
    expect(didNoWork([{ n: "resolve", c: "success" }])).toBe(false);
    const no = () => true;
    const pair = (first: StageRun) => [first, hr("completed", "failure", 3)];
    expect(stageSpent(pair(hr("completed", "success", 1)), no)).toBe(true);
    expect(stageSpent(pair(hr("completed", "success", 1)))).toBe(false);
    expect(stageSpent(pair(hr("completed", "failure", 1)), no)).toBe(false);
    // A cancel is no evidence: the next older run decides.
    expect(stageSpent(pair(hr("completed", "cancelled", 1)))).toBe(true);
  });
  // The Prover's four replays on #506 at 9db6e4e8.
  const spentStagingDeploy = hr(
    "completed",
    "failure",
    3,
    "deploy-hosted-platform staging v0.181.0 [sc45000000001-1]",
  );
  it("a newer publish due its automatic retry holds over an older spent staging deploy (run 45721473041)", () => {
    const publish = (a: number) =>
      ({
        ...hr("completed", "failure", a, "hosted-publish"),
        e: "workflow_run",
      }) as Run;
    const due = go(
      "arm",
      fake({
        prodDone: false,
        stageRuns: { "hosted-publish.yml": [publish(1)] },
        stagingDeploys: [spentStagingDeploy],
      }),
    );
    expect(due.armed).toEqual([]);
    expect(due.logs.join("\n")).toMatch(/no successful prod deploy/);
    // Its retries spent too: dead, at the first spent stage.
    const spent = go(
      "arm",
      fake({
        prodDone: false,
        stageRuns: { "hosted-publish.yml": [publish(3)] },
        stagingDeploys: [spentStagingDeploy],
      }),
    );
    expect(spent.armed).toEqual([7]);
  });
  it("a gate rejected on its rerun does not release the hold while a same-tag recovery is active (run 45740398112)", () => {
    const rejected = [{ t: "redline-staging v0.181.0", c: "failure", a: 2 }];
    const r = go(
      "arm",
      fake({
        prodDone: false,
        gateRuns: rejected,
        stageRuns: {
          "hosted-release.yml": [
            { ...hr("in_progress", null, 1), h: "8".repeat(40) },
          ],
        },
      }),
    );
    expect(r.armed).toEqual([]);
    // With no recovery, the rejection releases it (#448).
    expect(
      go("arm", fake({ prodDone: false, gateRuns: rejected })).armed,
    ).toEqual([7]);
  });
  it("a passed gate behind 20, 100 or 150 other gate runs still holds over an old staging failure (run 45731553873)", () => {
    for (const before of [19, 20, 100, 150]) {
      const r = go(
        "arm",
        fake({
          prodDone: false,
          gateRuns: [
            ...Array.from({ length: before }, (_, i) => ({
              t: `redline-staging v0.170.${i}`,
              c: "success",
              a: 1,
            })),
            { t: "redline-staging v0.181.0", c: "success", a: 1 },
          ],
          stagingDeploys: [spentStagingDeploy],
        }),
      );
      expect(r.armed, String(before)).toEqual([]);
    }
  });
  it("a signed-floor publish (hosted-publish <env> <floor run id>) is no release's evidence", () => {
    const r = go(
      "arm",
      fake({
        prodDone: false,
        stageRuns: {
          "hosted-publish.yml": [
            hr("completed", "failure", 3, "hosted-publish staging 123456"),
          ],
        },
      }),
    );
    expect(r.armed).toEqual([]);
  });
  // The Prover's replay on #506 at 2dce4dca: a cancelled gate dispatch after a
  // green gate hid that success and released the pin on an older staging failure.
  it("a cancelled gate dispatch after a passed gate is no evidence: the passed gate still holds", () => {
    const r = go(
      "arm",
      fake({
        prodDone: false,
        gateRuns: [
          { t: "redline-staging v0.181.0", c: "cancelled", a: 1 },
          { t: "redline-staging v0.181.0", c: "success", a: 1 },
        ],
        stagingDeploys: [spentStagingDeploy],
      }),
    );
    expect(r.armed).toEqual([]);
    expect(r.logs.join("\n")).toMatch(/no successful prod deploy/);
    // A passed gate holds even over a later rejection, until the prod deploy.
    const later = go(
      "arm",
      fake({
        prodDone: false,
        gateRuns: [
          { t: "redline-staging v0.181.0", c: "failure", a: 2 },
          { t: "redline-staging v0.181.0", c: "success", a: 1 },
        ],
        stagingDeploys: [spentStagingDeploy],
      }),
    );
    expect(later.armed).toEqual([]);
    // ... and the prod deploy's success releases it.
    expect(
      go(
        "arm",
        fake({
          gateRuns: [{ t: "redline-staging v0.181.0", c: "success", a: 1 }],
        }),
      ).armed,
    ).toEqual([7]);
    // A cancelled gate after a rejected one: the rejection still decides.
    const rej = go(
      "arm",
      fake({
        prodDone: false,
        gateRuns: [
          { t: "redline-staging v0.181.0", c: "cancelled", a: 1 },
          { t: "redline-staging v0.181.0", c: "failure", a: 2 },
        ],
      }),
    );
    expect(rej.armed).toEqual([7]);
  });
  it("pinFate and retryDue: every stage, the gate included, holds while a run is active or due its retry", () => {
    expect(GATE_RETRY_SPENT).toBe(2);
    const f = (a: number, e = "workflow_run", t = "x") =>
      ({ ...hr("completed", "failure", a, t), e }) as Run;
    expect(retryDue(f(1))).toBe(true);
    expect(retryDue(f(2))).toBe(true);
    expect(retryDue(f(3))).toBe(false);
    // A hand dispatch is never retried; a staging chain dispatch is.
    expect(retryDue(f(1, "workflow_dispatch"))).toBe(false);
    expect(
      retryDue(
        f(
          1,
          "workflow_dispatch",
          "deploy-hosted-platform staging v1.0.0 [sc1-1]",
        ),
      ),
    ).toBe(true);
    expect(retryDue(f(1, "workflow_dispatch"), true)).toBe(true);
    expect(retryDue(f(2, "workflow_dispatch"), true)).toBe(false);
    const spentRun = f(3);
    expect(pinFate([["a", [spentRun]]], [])).toEqual({ dead: "a" });
    expect(
      pinFate(
        [
          ["a", [spentRun]],
          ["b", [f(1)]],
        ],
        [],
      ),
    ).toEqual({
      recovering: true,
    });
    expect(
      pinFate(
        [["a", [spentRun]]],
        [{ ...hr("completed", "success", 1), e: "workflow_dispatch" }],
      ),
    ).toEqual({});
    expect(
      pinFate(
        [],
        [{ ...hr("completed", "failure", 2), e: "workflow_dispatch" }],
      ),
    ).toEqual({ rejected: true });
    expect(pinFate([], [hr("in_progress", null, 2)])).toEqual({
      recovering: true,
    });
  });
  it("an unreadable pin commit means not arming", () => {
    const r = go(
      "arm",
      fake({ prodDone: false, notFound: ["path=PUBLIC_PIN"] }),
    );
    expect(r.armed).toEqual([]);
    expect(r.logs.join("\n")).toMatch(/cannot read the release pipeline/);
  });
  it("stageSpent: only a completed failure on attempt RELEASE_RETRY_SPENT or later, of the newest real run", () => {
    expect(RELEASE_RETRY_SPENT).toBe(3);
    expect(stageSpent([])).toBe(false);
    expect(stageSpent([hr("completed", "failure", 3)])).toBe(true);
    expect(stageSpent([hr("completed", "failure", 4)])).toBe(true);
    expect(
      stageSpent([
        hr("completed", "success", 1),
        hr("completed", "failure", 3),
      ]),
    ).toBe(false);
    expect(PRE_GATE_WORKFLOWS).toEqual([
      "hosted-release.yml",
      "hosted-publish.yml",
      "staging-release-chain.yml",
    ]);
  });
  it("does not read gate runs when main's pin is on prod", () => {
    const f = fake();
    go("arm", f);
    expect(
      f.calls.some((c) =>
        c.join(" ").includes("redline-staging.yml/runs?branch=main"),
      ),
    ).toBe(false);
  });
  it("arms when every gate workflow is idle and prod has the current pin", () => {
    expect(go("arm", fake()).armed).toEqual([7]);
  });
  it("does not arm when a read fails or answers junk", () => {
    for (const nf of [
      "actions/workflows/redline-staging.yml",
      "status=success",
    ]) {
      const r = go("arm", fake({ notFound: [nf] }));
      expect(r.armed, nf).toEqual([]);
      expect(r.logs.join("\n")).toMatch(/cannot read the release pipeline/);
    }
    expect(go("arm", fake({ junkCount: true })).armed).toEqual([]);
  });
  it("a busy pipeline never disarms a PR the bot already armed", () => {
    const r = go("arm", fake({ armed: true, busy: "hosted-publish.yml" }));
    expect(r.disarmed).toEqual([]);
  });
  it("reads the runs lists small: per_page at most 20 and a --jq", () => {
    const f = fake();
    go("arm", f);
    const reads = f.calls
      .map((c) => c.join(" "))
      .filter(
        (c) =>
          c.includes("/actions/workflows/") && !c.includes("workflows/ci.yml/"),
      );
    expect(reads.length).toBe(GATE_WORKFLOWS.length * 2 + 1);
    expect(reads.filter((c) => c.includes("per_page=100")).length).toBe(1);
    for (const c of reads) {
      expect(c).toContain("--jq");
      expect(Number(/per_page=(\d+)/.exec(c)?.[1])).toBeLessThanOrEqual(100);
    }
  });
  it("the real exec has room for 16 MiB of output", () => {
    expect(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "pin-bump-arm.ts"),
        "utf8",
      ),
    ).toContain("maxBuffer: 16 * 1024 * 1024");
  });
});

describe("workflow", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(
    join(dir, "../../.github/workflows/pin-bump-arm.yml"),
    "utf8",
  );
  const wf = parse(text);
  it("is event-only: CI, the release pipeline gate, bump PRs, a push to main and dispatch; never a schedule, never cancels a run", () => {
    // cloud #264: no schedule, no timer of any kind
    expect(Object.keys(wf.on).sort()).toEqual([
      "pull_request_target",
      "push",
      "workflow_dispatch",
      "workflow_run",
    ]);
    expect(wf.on.schedule).toBeUndefined();
    expect(text).not.toMatch(/\bcron:/);
    // A push to main and a manual run re-evaluate open bumps; neither takes inputs.
    expect(wf.on.push).toEqual({ branches: ["main"] });
    expect(wf.on.workflow_dispatch ?? null).toBeNull();
    // The event filter lives on the plan job; arm only follows a plan that says write.
    expect(wf.jobs.arm.needs).toBe("plan");
    // The gate opens only when one of its workflows ends, or main's pin is spent
    // (hosted-release, the first stage, ends), so each one's end re-plans.
    expect(wf.on.workflow_run).toEqual({
      workflows: [
        "CI",
        "hosted-release",
        ...GATE_WORKFLOWS.map((f) => f.replace(/\.yml$/, "")),
      ],
      types: ["completed"],
    });
    // Every stage before the gate ends with a planning event.
    for (const f of PRE_GATE_WORKFLOWS)
      expect(wf.on.workflow_run.workflows).toContain(f.replace(/\.yml$/, ""));
    for (const f of [...GATE_WORKFLOWS, ...PRE_GATE_WORKFLOWS]) {
      const g = parse(
        readFileSync(join(dir, "../../.github/workflows", f), "utf8"),
      ) as { name: string };
      expect(g.name).toBe(f.replace(/\.yml$/, ""));
    }
    // One plan or arm at a time, on the jobs: a run whose plan is skipped never
    // takes the group, so it cannot replace a pending run with work to do.
    expect(wf.concurrency).toBeUndefined();
    for (const j of ["plan", "arm"])
      expect(wf.jobs[j].concurrency).toEqual({
        group: "pin-bump-arm",
        "cancel-in-progress": false,
      });
    expect(wf.permissions).toEqual({});
  });

  describe("which events plan (cloud #264)", () => {
    type Ev = {
      event: string;
      headRef?: string;
      wf?: string;
      branch?: string;
      conclusion?: string;
    };
    const plans = (o: Ev): boolean =>
      Boolean(
        new Function(
          "github",
          "startsWith",
          `return ${String(wf.jobs.plan.if)};`,
        )(
          {
            event_name: o.event,
            head_ref: o.headRef ?? "",
            event: {
              workflow_run: {
                name: o.wf ?? "",
                head_branch: o.branch ?? "",
                conclusion: o.conclusion ?? "success",
              },
            },
          },
          (a: string, b: string) => a.startsWith(b),
        ),
      );
    const wr = (wf: string, branch: string, conclusion = "success"): Ev => ({
      event: "workflow_run",
      wf,
      branch,
      conclusion,
    });

    it("a push to main and a manual run always plan", () => {
      expect(plans({ event: "push" })).toBe(true);
      expect(plans({ event: "workflow_dispatch" })).toBe(true);
    });

    it("a bump PR opened or pushed plans; another PR does not", () => {
      expect(
        plans({ event: "pull_request_target", headRef: "pin-bump/v1.2.3" }),
      ).toBe(true);
      expect(plans({ event: "pull_request_target", headRef: "feature" })).toBe(
        false,
      );
    });

    it("CI plans on a bump branch, and in the merge queue only when it did not pass", () => {
      expect(plans(wr("CI", "pin-bump/v1.2.3"))).toBe(true);
      expect(plans(wr("CI", "pin-bump/v1.2.3", "failure"))).toBe(true);
      const q = "gh-readonly-queue/main/pr-12-0123abcd";
      for (const c of ["failure", "timed_out", "startup_failure", "cancelled"])
        expect(plans(wr("CI", q, c))).toBe(true);
      // a pass merges, and that push to main plans
      expect(plans(wr("CI", q))).toBe(false);
      expect(plans(wr("CI", "main"))).toBe(false);
      expect(plans(wr("CI", "feature", "failure"))).toBe(false);
    });

    it("hosted-release ending plans: a spent one releases the hold on the next bump (v0.253.0)", () => {
      for (const c of ["success", "failure"])
        expect(plans(wr("hosted-release", "main", c))).toBe(true);
      expect(wf.on.workflow_run.workflows).toContain("hosted-release");
    });

    it("the prod deploy's success plans, so it releases the hold on its own event", () => {
      expect(plans(wr("deploy-hosted-platform", "main", "success"))).toBe(true);
      expect(wf.on.workflow_run.workflows).toContain("deploy-hosted-platform");
      // ... and that plan arms once the pin's prod deploy is there.
      expect(go("arm", fake()).armed).toEqual([7]);
    });

    it("any gate workflow ending plans, green or red: the gate may be open now", () => {
      for (const f of GATE_WORKFLOWS)
        for (const c of ["success", "failure", "cancelled"])
          expect(plans(wr(f.replace(/\.yml$/, ""), "main", c))).toBe(true);
    });
  });

  it("plans read-only with no environment, then mints the App token only in the arm job, and never runs the PR's code", () => {
    type Step = {
      id?: string;
      name?: string;
      if?: string;
      uses?: string;
      with?: Record<string, string>;
    };
    const planJob = wf.jobs.plan;
    const armJob = wf.jobs.arm;
    expect(planJob.environment).toBeUndefined();
    expect(planJob.outputs.write).toBe("${{ steps.plan.outputs.write }}");
    expect(JSON.stringify(planJob)).not.toMatch(
      /create-github-app-token|RELEASE_APP/,
    );
    expect(armJob.needs).toBe("plan");
    expect(armJob.if).toContain("needs.plan.outputs.write == 'true'");
    expect(armJob.environment).toBe("release-app");
    const steps = armJob.steps as Step[];
    const ids = steps.map((s) => s.id ?? s.name);
    expect(ids.indexOf("app")).toBeLessThan(ids.indexOf("Arm"));
    const app = steps.find((s) => s.id === "app")!;
    expect(app.uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}$/);
    expect(app.with?.["permission-pull-requests"]).toBe("write");
    expect(text).not.toMatch(/github\.head_ref\s*\}\}|head_sha/);
    // pull_request_target runs with secrets: it may only ever check out main.
    expect(wf.on.pull_request).toBeUndefined();
    expect(wf.on.pull_request_target.types).toEqual([
      "opened",
      "reopened",
      "synchronize",
    ]);
    for (const job of [planJob, armJob]) {
      const js = job.steps as Step[];
      const checkouts = js.filter((s) =>
        s.uses?.startsWith("actions/checkout@"),
      );
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with).toMatchObject({
        ref: "${{ github.event.repository.default_branch }}",
        "persist-credentials": false,
      });
      expect(js[0]?.with).toMatchObject({
        ref: "${{ github.event.repository.default_branch }}",
      });
      const runs = JSON.stringify(js);
      expect(runs).not.toMatch(
        /pull_request\.head|head_ref\}|github\.event\.pull_request|merge_commit/,
      );
      expect(runs).not.toMatch(/pnpm|npm (ci|install)/);
      expect(js.some((s) => /pnpm|install/.test(s.uses ?? ""))).toBe(false);
    }
    expect(planJob.permissions["pull-requests"]).toBe("read");
  });
});
