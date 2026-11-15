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
const BRANCH = /^pin-bump\/(v\d{1,6}\.\d{1,6}\.\d{1,6})$/;
const SHA = /^[0-9a-f]{40}$/;

export type PrFile = {
  filename: string;
  /** GitHub's status: added, removed, modified, renamed, copied, changed (mode), unchanged. */
  status: string;
  previous_filename?: string;
};
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

/** Pure: should this PR be armed? Every rule must hold; the first that fails is the reason. */
export function decide(i: Input): Decision {
  if (i.author !== BOT) return no(`author is ${i.author}, not ${BOT}`);
  const m = BRANCH.exec(i.headRef);
  if (!m) return no(`branch ${i.headRef} is not ${BRANCH_PREFIX}vX.Y.Z`);
  if (i.headRepo !== i.repo)
    return no(`head is in ${i.headRepo}, not ${i.repo}`);
  if (i.armed) return no("already armed or queued");

  if (i.commits.length === 0) return no("the PR has no commits to check");
  const human = i.commits.find(
    (c) => c.author !== BOT || c.committer !== BOT || !c.verified,
  );
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

function readView(exec: Exec, repo: string, n: number): View {
  const v = JSON.parse(
    gh(exec, [
      "pr",
      "view",
      String(n),
      "--repo",
      repo,
      "--json",
      "headRefOid,autoMergeRequest,isInMergeQueue",
    ]),
  );
  return {
    oid: String(v.headRefOid),
    armed: Boolean(v.autoMergeRequest) || Boolean(v.isInMergeQueue),
    autoMergeBy:
      v.autoMergeRequest && !v.isInMergeQueue
        ? String(v.autoMergeRequest.enabledBy?.login ?? "")
        : undefined,
  };
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
const botOnly = (cs: Commit[]) =>
  cs.length > 0 &&
  cs.every((c) => c.author === BOT && c.committer === BOT && c.verified);

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
    autoMergeBy: view.autoMergeBy,
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
  const r = spawnSync(cmd, args, { encoding: "utf8" });
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
