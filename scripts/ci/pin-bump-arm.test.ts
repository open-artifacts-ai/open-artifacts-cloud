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
  type Exec,
  GATE_WORKFLOWS,
  gateRefusal,
  type Input,
  isChainProdDeploy,
  parseView,
  type QueueRun,
  queueFailure,
  queueMarker,
  queueNotice,
  queueVerdict,
  requiredChecks,
  run,
} from "./pin-bump-arm.ts";

const REPO = "open-artifacts-ai/open-artifacts-cloud";
const PUB = "open-artifacts-ai/open-artifacts";
const OLD = "b".repeat(40);
const NEW = "a".repeat(40);
const HEAD = "c".repeat(40);
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
    const wr = /actions\/workflows\/([\w.-]+)\/runs\?status=(\w+)/.exec(a);
    if (wr) {
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
  it("refuses while main's pin has no prod deploy", () => {
    expect(gateRefusal({ ...idle, prodDeployed: false })).toMatch(
      /v0.181.0 has no successful prod deploy/,
    );
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
  it("triggers on CI completion, bump PRs and a schedule, and never cancels a run", () => {
    expect(Object.keys(wf.on).sort()).toEqual([
      "pull_request_target",
      "push",
      "schedule",
      "workflow_dispatch",
      "workflow_run",
    ]);
    // A push to main and a manual run re-evaluate open bumps; neither takes inputs.
    expect(wf.on.push).toEqual({ branches: ["main"] });
    expect(wf.on.workflow_dispatch ?? null).toBeNull();
    // The event filter lives on the plan job; arm only follows a plan that says write.
    expect(wf.jobs.arm.needs).toBe("plan");
    const cond = String(wf.jobs.plan.if);
    for (const ev of ["schedule", "push", "workflow_dispatch"])
      expect(cond).toContain(`github.event_name == '${ev}'`);
    expect(wf.on.workflow_run).toEqual({
      workflows: ["CI"],
      types: ["completed"],
    });
    expect(wf.concurrency["cancel-in-progress"]).toBe(false);
    expect(wf.permissions).toEqual({});
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
