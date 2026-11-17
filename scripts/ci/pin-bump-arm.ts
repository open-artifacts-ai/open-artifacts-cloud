// Self-arm for a pin-only bump (cloud #264): the release bot's pin-bump PR is armed
// once it is provably nothing but a pin move and every required check on its current
// head is green. Anything else is left for a person.
// Usage: node --experimental-strip-types scripts/ci/pin-bump-arm.ts <plan|arm> --repo owner/name [--public owner/name]
// `plan` is read-only and prints `write=true|false` for $GITHUB_OUTPUT; `arm` re-decides
// on a fresh snapshot and enables auto-merge pinned to that head sha (a push in between
// makes GitHub refuse). Needs GH_TOKEN; `arm` runs with the release App's token.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  BRANCH_PREFIX,
  compareTags,
  PUBLIC_REPO,
  pinField,
  rewritePin,
} from "./pin-bump.ts";

export const BOT = "open-artifacts-release[bot]";
/** Files a pin-only bump may touch, each as a plain modification. */
export const PIN_FILES = ["PUBLIC_PIN", "SYNCED_FROM", "pnpm-lock.yaml"];
/** Required check names from GET /repos/{repo}/rules/branches/main; [] when unreadable (fails closed). */
export function requiredChecks(json: string): string[] {
  try {
    const rules = JSON.parse(json) as {
      type?: string;
      parameters?: { required_status_checks?: { context?: string }[] };
    }[];
    const names = rules
      .filter((r) => r.type === "required_status_checks")
      .flatMap((r) => r.parameters?.required_status_checks ?? [])
      .map((c) => String(c.context ?? ""))
      .filter(Boolean);
    return [...new Set(names)];
  } catch {
    return [];
  }
}
/** A bump branch: pin-bump/vX.Y.Z. */
export const BRANCH = /^pin-bump\/(v\d{1,6}\.\d{1,6}\.\d{1,6})$/;
const SHA = /^[0-9a-f]{40}$/;

export type PrFile = {
  filename: string;
  /** GitHub's status: added, removed, modified, renamed, copied, changed (mode), unchanged. */
  status: string;
  previous_filename?: string;
};
/** The committer GitHub records for a commit made through the API with an App token. */
export const WEB_FLOW = "web-flow";
/**
 * Pure: a commit the bot made and GitHub verified. The committer is the bot, or
 * web-flow (what GitHub records for an API-made App commit), but web-flow is
 * accepted only for a verified commit authored by exactly the bot.
 */
export const commitOk = (c: Commit) =>
  c.verified &&
  c.author === BOT &&
  (c.committer === BOT || c.committer === WEB_FLOW);
export type Commit = { author: string; committer: string; verified: boolean };
/** A root tree entry at the PR head. */
export type TreeEntry = { path: string; mode: string; type: string };
/** `app` is the slug of the app that ran the check; only github-actions counts. */
export type Check = {
  name: string;
  status: string;
  conclusion: string | null;
  app?: string;
};
/** A merge-queue (merge_group) CI run for one PR: when it was created and how it ended. */
export type QueueRun = {
  createdAt: string;
  status: string;
  conclusion: string | null;
};
export type Input = {
  author: string;
  headRef: string;
  /** The head repo's full name; a fork never qualifies. */
  headRepo: string;
  repo: string;
  /** The PR's head sha now. */
  headOid: string;
  /** The sha the checks below were read for. */
  checksOid: string;
  files: PrFile[];
  /** PUBLIC_PIN and SYNCED_FROM at the head sha; PUBLIC_PIN on main. */
  pin: string;
  synced: string;
  mainPin: string;
  mainSynced: string;
  /** The commit the public repo's tag in PUBLIC_PIN points to, annotated tags peeled ("" if unresolved). */
  tagSha: string;
  /** The public repo has a published, non-prerelease release for that tag. */
  released: boolean;
  /** Root tree entries at the head sha. */
  tree: TreeEntry[];
  checks: Check[];
  /** Every commit on the PR, with the logins GitHub resolved for author and committer. */
  commits: Commit[];
  /** The required check names; none means unreadable, which fails closed. */
  required: string[];
  /** Auto-merge is enabled or the PR is queued. */
  armed: boolean;
  /** When the PR's head commit was made (ISO 8601); a queue run older than that is another head's. */
  headAt: string;
  /** The merge-queue CI runs for this PR, any head. */
  queueRuns: QueueRun[];
  /** Auto-merge was enabled (not queued), and by whom. */
  autoMergeBy?: string;
};
export type Decision = { arm: boolean; why: string };

const no = (why: string): Decision => ({ arm: false, why });
const field = (text: string, key: "tag" | "sha") => {
  try {
    return pinField(text, key);
  } catch {
    return "";
  }
};

/**
 * Pure: why a PR whose merge-queue run already failed must not be armed again, or
 * undefined. Pin bumps run the whole suite only in the merge queue, so a failure
 * there drops the PR from the queue with every required check still green on the PR
 * head; arming it again would loop on the same head. The newest queue run made after
 * the head commit decides: anything but success (in progress counts as success here,
 * a PR in the queue reads armed first) holds the PR until a new commit or a person
 * acts. An unreadable date or run fails closed.
 */
export function queueFailure(
  headAt: string,
  runs: QueueRun[],
): string | undefined {
  const t = Date.parse(headAt);
  if (Number.isNaN(t)) return "the head commit's date is unreadable";
  let last: QueueRun | undefined;
  for (const r of runs) {
    const at = Date.parse(r.createdAt);
    if (Number.isNaN(at)) return "a merge queue run has no readable date";
    if (at < t) continue;
    if (!last || at > Date.parse(last.createdAt)) last = r;
  }
  if (!last || last.status !== "completed") return undefined;
  if (last.conclusion === "success") return undefined;
  return `its merge queue run on this head ended ${last.conclusion ?? "unknown"}; a new commit or a person must act`;
}

/** Pure: should this PR be armed? Every rule must hold; the first that fails is the reason. */
export function decide(i: Input): Decision {
  if (i.author !== BOT) return no(`author is ${i.author}, not ${BOT}`);
  const m = BRANCH.exec(i.headRef);
  if (!m) return no(`branch ${i.headRef} is not ${BRANCH_PREFIX}vX.Y.Z`);
  if (i.headRepo !== i.repo)
    return no(`head is in ${i.headRepo}, not ${i.repo}`);
  if (i.armed) return no("already armed or queued");
  const failed = queueFailure(i.headAt, i.queueRuns);
  if (failed) return no(failed);

  if (i.commits.length === 0) return no("the PR has no commits to check");
  const human = i.commits.find((c) => !commitOk(c));
  if (human)
    return no(
      `not pin-only: a commit is by ${human.author || "unknown"}, committed by ${human.committer || "unknown"}${human.verified ? "" : ", unverified"}`,
    );
  if (i.required.length === 0)
    return no("the required checks could not be read");

  const names = i.files.map((f) => f.filename);
  const bad = i.files.filter(
    (f) =>
      f.status !== "modified" ||
      f.previous_filename !== undefined ||
      !PIN_FILES.includes(f.filename),
  );
  if (i.files.length === 0) return no("the PR changes no files");
  if (bad.length > 0)
    return no(
      `not pin-only: ${bad.map((f) => `${f.filename} (${f.status})`).join(", ")}`,
    );
  if (new Set(names).size !== names.length) return no("a file is listed twice");
  for (const f of ["PUBLIC_PIN", "SYNCED_FROM"])
    if (!names.includes(f)) return no(`${f} is not changed`);
  for (const f of names) {
    const e = i.tree.find((t) => t.path === f);
    if (!e || e.mode !== "100644" || e.type !== "blob")
      return no(`${f} is not a regular file (mode ${e?.mode ?? "missing"})`);
  }

  const tag = field(i.pin, "tag");
  const sha = field(i.pin, "sha");
  if (!/^v\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(tag) || !SHA.test(sha))
    return no("PUBLIC_PIN has no valid tag= and sha=");
  if (tag !== m[1])
    return no(`PUBLIC_PIN tag ${tag} is not the branch's ${m[1]}`);
  if (!SHA.test(i.tagSha) || i.tagSha !== sha)
    return no(
      `PUBLIC_PIN sha ${sha} is not what ${tag} points to (${i.tagSha || "unresolved"})`,
    );
  if (field(i.synced, "tag") !== tag || field(i.synced, "sha") !== sha)
    return no("SYNCED_FROM does not name the same tag and sha");
  const current = field(i.mainPin, "tag");
  if (!current) return no("main's PUBLIC_PIN has no tag=");
  if (compareTags(tag, current) <= 0)
    return no(`${tag} is not newer than main's ${current}`);
  if (!i.released)
    return no(`${tag} has no published, non-prerelease public release`);
  // Byte for byte what the pin-bump job writes: main's file with only tag= and sha= moved.
  for (const [name, head, main] of [
    ["PUBLIC_PIN", i.pin, i.mainPin],
    ["SYNCED_FROM", i.synced, i.mainSynced],
  ] as const) {
    let want: string;
    try {
      want = rewritePin(main, tag, sha);
    } catch {
      return no(`main's ${name} cannot be rewritten`);
    }
    if (head !== want)
      return no(`${name} is not main's content with only tag and sha moved`);
  }

  if (!SHA.test(i.headOid) || i.checksOid !== i.headOid)
    return no("the checks are not for the PR's current head");
  for (const name of i.required) {
    const runs = i.checks.filter(
      (c) => c.name === name && c.app === "github-actions",
    );
    if (runs.length === 0)
      return no(`required check ${name} has not run on this head`);
    if (
      runs.some((c) => c.status !== "completed" || c.conclusion !== "success")
    )
      return no(`required check ${name} is not green`);
  }
  return {
    arm: true,
    why: `pin-only ${tag}, ${i.required.length} required checks green on ${i.headOid}`,
  };
}

/** Workflows that must be idle before a bump is armed (#309). */
export const GATE_WORKFLOWS = [
  "hosted-publish.yml",
  "staging-release-chain.yml",
  "deploy-hosted-platform.yml",
  "redline-staging.yml",
  "prod-release-chain.yml",
];
export const PROD_DEPLOY_WORKFLOW = "deploy-hosted-platform.yml";
export const PROD_TITLE = "deploy-hosted-platform prod ";
/** Pages of 100 successful dispatched deploy runs to look through for the pin's prod deploy. */
export const DEPLOY_PAGES = 5;
/**
 * A full prod deploy of `tag`: the chain's run (prod-release-chain dispatches the
 * full target list, verify_only false, and puts its id in the run-name):
 * `deploy-hosted-platform prod vX.Y.Z [c<digits>-<n>]`. A title without the chain id
 * (a manual or partial run) never counts, and the tag must match whole: v0.18.0 is
 * not v0.18.0x, and a prefix of a longer tag never matches.
 */
export function isChainProdDeploy(title: string, tag: string): boolean {
  const head = `${PROD_TITLE}${tag} [`;
  return (
    title.startsWith(head) && /^c\d+-\d+\]$/.test(title.slice(head.length))
  );
}
export type Gate = {
  /** Gate workflows with a queued or in_progress run. */
  busy: string[];
  /** A successful full prod deploy (the chain's run) exists for main's current pin tag. */
  prodDeployed: boolean;
  /** main's current PUBLIC_PIN tag. */
  mainTag: string;
};
/** Pure: why a qualifying bump must wait (candidate open), or undefined. */
export function gateRefusal(g: Gate): string | undefined {
  if (g.busy.length > 0)
    return `candidate open: ${g.busy.join(", ")} queued or in progress`;
  if (!g.prodDeployed)
    return `candidate open: main's pin ${g.mainTag} has no successful prod deploy yet`;
  return undefined;
}

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;

function gh(exec: Exec, args: string[]): string {
  const r = exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}
const raw = (exec: Exec, repo: string, path: string, ref: string) =>
  gh(exec, [
    "api",
    "-H",
    "Accept: application/vnd.github.raw",
    `repos/${repo}/contents/${path}?ref=${ref}`,
  ]);

/** The commit a public tag points to: git/ref/tags, peeling annotated tags. "" if unresolved. */
export function peelTag(exec: Exec, publicRepo: string, tag: string): string {
  let obj = JSON.parse(
    gh(exec, ["api", `repos/${publicRepo}/git/ref/tags/${tag}`]),
  ).object as {
    type: string;
    sha: string;
  };
  for (let n = 0; obj.type === "tag" && n < 5; n++)
    obj = JSON.parse(
      gh(exec, ["api", `repos/${publicRepo}/git/tags/${obj.sha}`]),
    ).object;
  return obj.type === "commit" ? obj.sha : "";
}

type Listed = {
  number: number;
  user: { login: string };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
};
type View = { oid: string; armed: boolean; autoMergeBy?: string };

/** Open PRs from the bot on a bump branch. Throws on an API error. */
function listBumpPrs(exec: Exec, repo: string): Listed[] {
  return (
    JSON.parse(
      gh(exec, [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/pulls?state=open&per_page=100`,
      ]),
    ).flat() as Listed[]
  ).filter((p) => p.user.login === BOT && p.head.ref.startsWith(BRANCH_PREFIX));
}

const VIEW_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      headRefOid
      isInMergeQueue
      autoMergeRequest { enabledBy { __typename login } }
    }
  }
}`;

/**
 * Pure: the PR state from the GraphQL answer. Throws on anything unexpected, so the
 * caller fails closed. GraphQL names a bot without "[bot]", so a Bot actor's login
 * gets it back and compares equal to BOT.
 */
export function parseView(json: string): View {
  const pr = JSON.parse(json)?.data?.repository?.pullRequest;
  if (!pr || !SHA.test(String(pr.headRefOid ?? "")))
    throw new Error("unreadable pull request state");
  const queued = pr.isInMergeQueue === true;
  const auto = pr.autoMergeRequest;
  const by = auto?.enabledBy;
  const login = String(by?.login ?? "");
  return {
    oid: pr.headRefOid,
    armed: queued || Boolean(auto),
    autoMergeBy:
      auto && !queued
        ? by?.__typename === "Bot" && !login.endsWith("[bot]")
          ? `${login}[bot]`
          : login
        : undefined,
  };
}

// `gh pr view --json` lacks some fields on older gh (isInMergeQueue), so the
// state is read through GraphQL, which the runner's gh always has.
function readView(exec: Exec, repo: string, n: number): View {
  const [owner, name] = repo.split("/");
  return parseView(
    gh(exec, [
      "api",
      "graphql",
      "-f",
      `query=${VIEW_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `n=${n}`,
    ]),
  );
}

function readCommits(exec: Exec, repo: string, n: number): Commit[] {
  return (
    JSON.parse(
      gh(exec, [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/pulls/${n}/commits?per_page=100`,
      ]),
    ).flat() as {
      author: { login: string } | null;
      committer: { login: string } | null;
      commit?: { verification?: { verified?: boolean } };
    }[]
  ).map((c) => ({
    author: c.author?.login ?? "",
    committer: c.committer?.login ?? "",
    verified: c.commit?.verification?.verified === true,
  }));
}
const botOnly = (cs: Commit[]) => cs.length > 0 && cs.every(commitOk);

/** Everything else decide needs. Throws on any API error (the caller treats that as "does not qualify"). */
function gather(
  exec: Exec,
  repo: string,
  publicRepo: string,
  p: Listed,
  view: View,
  commits: Commit[],
): Input {
  const oid = p.head.sha;
  const files = JSON.parse(
    gh(exec, [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/pulls/${p.number}/files?per_page=100`,
    ]),
  ).flat() as PrFile[];
  // A bump with more than 3 files is not pin-only; its contents are not read.
  const pinOnly = files.length <= PIN_FILES.length;
  const text = (f: string, ref: string) =>
    pinOnly ? raw(exec, repo, f, ref) : "";
  const pin = text("PUBLIC_PIN", oid);
  const synced = text("SYNCED_FROM", oid);
  const tag = field(pin, "tag");
  let tagSha = "";
  let released = false;
  if (/^v\d+\.\d+\.\d+$/.test(tag)) {
    tagSha = peelTag(exec, publicRepo, tag);
    const rel = JSON.parse(
      gh(exec, ["api", `repos/${publicRepo}/releases/tags/${tag}`]),
    );
    released = rel.draft === false && rel.prerelease === false;
  }
  const tree = (
    JSON.parse(gh(exec, ["api", `repos/${repo}/git/trees/${oid}`]))
      .tree as TreeEntry[]
  ).map((t) => ({ path: t.path, mode: t.mode, type: t.type }));
  const checks = (
    JSON.parse(
      gh(exec, [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/commits/${oid}/check-runs?filter=latest&per_page=100`,
      ]),
    ) as { check_runs: (Check & { app?: { slug?: string } | null })[] }[]
  )
    .flatMap((pg) => pg.check_runs)
    .map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      app: String(c.app?.slug ?? ""),
    }));
  const headAt = String(
    JSON.parse(gh(exec, ["api", `repos/${repo}/git/commits/${oid}`])).committer
      ?.date ?? "",
  );
  // Merge-queue runs are named gh-readonly-queue/<base>/pr-<n>-<base sha>; --jq keeps
  // the page small. The newest 100 are enough: arming makes a new run every time.
  const queueRuns = JSON.parse(
    gh(exec, [
      "api",
      `repos/${repo}/actions/workflows/ci.yml/runs?event=merge_group&per_page=100`,
      "--jq",
      `[.workflow_runs[] | select(.head_branch | startswith("gh-readonly-queue/main/pr-${p.number}-")) | {createdAt: .created_at, status: .status, conclusion: .conclusion}]`,
    ]),
  ) as QueueRun[];
  let required: string[] = [];
  try {
    required = requiredChecks(
      gh(exec, ["api", `repos/${repo}/rules/branches/main`]),
    );
  } catch {}
  return {
    author: p.user.login,
    headRef: p.head.ref,
    headRepo: p.head.repo?.full_name ?? "",
    repo,
    headOid: view.oid,
    checksOid: oid,
    files,
    pin,
    synced,
    mainPin: raw(exec, repo, "PUBLIC_PIN", "main"),
    mainSynced: raw(exec, repo, "SYNCED_FROM", "main"),
    tagSha,
    released,
    tree,
    checks,
    commits,
    required,
    armed: view.armed,
    headAt,
    queueRuns,
    autoMergeBy: view.autoMergeBy,
  };
}

/** Small reads only: one count per workflow and status, one short title list. Throws on any error. */
export function readGate(exec: Exec, repo: string, mainPin: string): Gate {
  const mainTag = field(mainPin, "tag");
  if (!/^v\d+\.\d+\.\d+$/.test(mainTag))
    throw new Error("main's PUBLIC_PIN has no valid tag=");
  const busy: string[] = [];
  for (const wf of GATE_WORKFLOWS)
    for (const status of ["queued", "in_progress"]) {
      const n = Number(
        gh(exec, [
          "api",
          `repos/${repo}/actions/workflows/${wf}/runs?status=${status}&per_page=1`,
          "--jq",
          ".total_count",
        ]).trim(),
      );
      if (!Number.isInteger(n)) throw new Error(`no count for ${wf} ${status}`);
      if (n > 0 && !busy.includes(wf)) busy.push(wf);
    }
  // The API cannot filter by title, so page through the successful dispatched runs
  // (--jq keeps each page small) until main's pin tag shows up, up to a cap. Not
  // found within the cap means not deployed (fail closed).
  let prodDeployed = false;
  for (let page = 1; page <= DEPLOY_PAGES && !prodDeployed; page++) {
    const r = JSON.parse(
      gh(exec, [
        "api",
        `repos/${repo}/actions/workflows/${PROD_DEPLOY_WORKFLOW}/runs?status=success&event=workflow_dispatch&per_page=100&page=${page}`,
        "--jq",
        `{n: (.workflow_runs | length), t: [.workflow_runs[].display_title | select(startswith("${PROD_TITLE}"))]}`,
      ]),
    ) as { n: number; t: string[] };
    if (!Array.isArray(r.t) || !Number.isInteger(r.n))
      throw new Error("unreadable deploy runs");
    prodDeployed = r.t.some((t) => isChainProdDeploy(t, mainTag));
    if (r.n < 100) break;
  }
  return {
    busy,
    mainTag,
    prodDeployed,
  };
}

const msg = (e: unknown) => String(e instanceof Error ? e.message : e);

/**
 * Fail-safe per PR: any read error means "does not qualify". A PR this bot armed
 * then gets its auto-merge disabled; an unarmed one is left. A person's own arming
 * is never touched. The commits are read first for an armed PR, so the cheapest
 * fact disarms before anything else is read.
 */
export function run(o: {
  mode: "plan" | "arm";
  exec: Exec;
  repo: string;
  publicRepo: string;
  log: (line: string) => void;
}): { write: boolean; armed: number[]; disarmed: number[] } {
  const armed: number[] = [];
  const disarmed: number[] = [];
  let write = false;
  for (const p of listBumpPrs(o.exec, o.repo)) {
    let view: View;
    try {
      view = readView(o.exec, o.repo, p.number);
    } catch (e) {
      o.log(`#${p.number}: leave: cannot read its state: ${msg(e)}`);
      continue;
    }
    const ours = view.armed && view.autoMergeBy === BOT;
    let input: Input | undefined;
    let d: Decision;
    try {
      const commits = readCommits(o.exec, o.repo, p.number);
      if (ours && !botOnly(commits))
        d = no("a commit is not by the bot and verified");
      else {
        input = gather(o.exec, o.repo, o.publicRepo, p, view, commits);
        d = decide(input);
      }
    } catch (e) {
      d = no(`could not read what it needs: ${msg(e)}`);
    }
    o.log(`#${p.number}: ${d.arm ? "arm" : "leave"}: ${d.why}`);
    if (d.arm && input) {
      let wait: string | undefined;
      try {
        wait = gateRefusal(readGate(o.exec, o.repo, input.mainPin));
      } catch (e) {
        wait = `cannot read the release pipeline, not arming: ${msg(e)}`;
      }
      if (wait) {
        o.log(`#${p.number}: leave: ${wait}`);
        continue;
      }
      write = true;
      if (o.mode === "arm") {
        gh(o.exec, [
          "pr",
          "merge",
          String(p.number),
          "--auto",
          "--squash",
          "--match-head-commit",
          input.headOid,
          "--repo",
          o.repo,
        ]);
        armed.push(p.number);
      }
      continue;
    }
    if (!ours) continue;
    // A busy pipeline never lands here: an already-armed bump is not disarmed
    // when the pipeline turns busy (arming queues it at once; the gate only
    // holds back arming).
    // Armed by this bot but not provably pin-only and green (an armed PR reads
    // "already armed" in decide, so judge it as if unarmed).
    const again = input ? decide({ ...input, armed: false }) : d;
    if (again.arm) continue;
    write = true;
    if (o.mode === "arm") {
      gh(o.exec, [
        "pr",
        "merge",
        String(p.number),
        "--disable-auto",
        "--repo",
        o.repo,
      ]);
      disarmed.push(p.number);
      o.log(`#${p.number}: disabled auto-merge: ${again.why}`);
    }
  }
  return { write, armed, disarmed };
}

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

function main(argv: string[]) {
  const [mode] = argv;
  const i = argv.indexOf("--repo");
  const repo = i >= 0 ? argv[i + 1] : "";
  const j = argv.indexOf("--public");
  const publicRepo = (j >= 0 && argv[j + 1]) || PUBLIC_REPO;
  if ((mode !== "plan" && mode !== "arm") || !repo) {
    console.error(
      "usage: pin-bump-arm.ts <plan|arm> --repo owner/name [--public owner/name]",
    );
    return 2;
  }
  const r = run({
    mode,
    exec: realExec,
    repo,
    publicRepo,
    log: (s) => console.error(`pin-bump-arm: ${s}`),
  });
  if (mode === "plan") console.log(`write=${r.write}`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
