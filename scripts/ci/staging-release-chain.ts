// The staging half of the release chain (cloud #264 steps 1 and 4,
// staging-release-chain.yml): once hosted-release has cut a release,
// deploy-hosted-platform.yml (env staging) starts on its own, beside
// hosted-publish's staging copy (both follow the same hosted-release run);
// once the deploy and the staging copy both succeeded for the tag,
// redline-staging.yml (the gate) starts on its own, for the same tag, from
// whichever of the two ended last. prod-release-chain.yml then follows the
// gate as before (prod still copies, then deploys). A failed copy or deploy
// never starts the gate, so nothing reaches prod.
//
// `plan` decides from one workflow_run event whether to act and what comes
// next; `dispatch` re-checks under the tag's concurrency group and starts the
// next workflow. Both print `key=value` lines for $GITHUB_OUTPUT. A skip is
// `go=false` with a `why` (neutral, green); an API error or a bad input
// throws (exit 1): the chain fails closed.
//
// Guards, each one's own check:
//   - the event's conclusion is success and its run is on main;
//   - after hosted-release: a real run (run name exactly `hosted-release`,
//     never a dry run) that built the newest release. The release is the one
//     its `hosted-built <tag> <sha>` job names (cloud #469), and the tag must
//     still be at that commit. A run without that job (before #469) built
//     what its hosted-guard checked: the tag PUBLIC_PIN names at the run's
//     head, at the tag's own commit, which pins the same release. That commit
//     can be older than the head: a dispatch on main's head rebuilds an
//     existing tag (the v0.246.1 recovery, run 45728492094). It starts the
//     deploy;
//   - after hosted-publish: the run was started by hosted-release (event
//     workflow_run, never a manual dispatch, which also carries prod and
//     floor publishes), and its publish-staging job for a release succeeded;
//     the tag is that job's name. It starts the gate once this chain's deploy
//     for the tag succeeded, or the deploy itself if no deploy run exists for
//     the tag yet (the hosted-release event's start never ran);
//   - after deploy-hosted-platform: the run is one this chain dispatched
//     (display title `deploy-hosted-platform staging <tag> [sc<run>-<n>]`,
//     the release App's bot as actor). A manual deploy, a verify_only run, a
//     partial-target run or a prod run has no `sc` chain id and never starts
//     the gate; this chain's deploy takes the workflow's default targets. It
//     starts the gate once the newest hosted-publish run (event
//     workflow_run, on main) that ran `publish-staging release <tag>` ran it
//     successfully: a newer failed copy keeps it shut over an older success;
//   - the tag is the newest release (releases/latest);
//   - never twice: no run of the target workflow for that tag exists, in any
//     state (a failed one waits for a person), checked in `plan` and again in
//     `dispatch` under the concurrency group keyed on the tag.
// Usage: node --experimental-strip-types scripts/ci/staging-release-chain.ts plan --repo o/n --workflow <path> --conclusion <c> --event <e> --branch <b> --title <t> --actor <a> --run-id <id> --head-sha <sha>
//        node --experimental-strip-types scripts/ci/staging-release-chain.ts dispatch --repo o/n --next deploy|gate --tag vX.Y.Z --chain-id <id>
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { billingConfigured, FULL_BILLING, ghRead } from "./chain-dispatch.ts";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;
export type Next = "deploy" | "gate";

const TAG_RE = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const CHAIN_RE = /^sc[0-9]{1,20}-[0-9]{1,4}$/;
/** The release App's public login: the actor of a run dispatched with its token. */
const WORKFLOW_DIR = ".github/workflows/";
export const APP_ACTOR = "open-artifacts-release[bot]";
/** The deploy run-name this chain's dispatch produces (deploy-hosted-platform.yml). */
export const DEPLOY_TITLE_RE =
  /^deploy-hosted-platform staging (v\d{1,6}\.\d{1,6}\.\d{1,6}) \[(sc[0-9]{1,20}-[0-9]{1,4})\]$/;
const PUBLISH_JOB_RE = /^publish-staging release (v\d{1,6}\.\d{1,6}\.\d{1,6})$/;
/** hosted-release.yml's marker job (cloud #469): the tag and commit the run built. */
export const BUILT_JOB_RE =
  /^hosted-built (v\d{1,6}\.\d{1,6}\.\d{1,6}) ([0-9a-f]{40})$/;
const RUN_ID_RE = /^[1-9][0-9]{0,19}$/;

const TARGET: Record<Next, { file: string; title: (tag: string) => string }> = {
  deploy: {
    file: "deploy-hosted-platform.yml",
    title: (t) => `deploy-hosted-platform staging ${t}`,
  },
  gate: { file: "redline-staging.yml", title: (t) => `redline-staging ${t}` },
};

type Run = {
  id: number;
  display_title?: string;
  status?: string;
  conclusion?: string | null;
  actor?: { login?: string };
};

type Sleep = (ms: number) => void;
const realSleep: Sleep = (ms) =>
  void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function gh(exec: Exec, args: string[]): string {
  const r = exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}

export function latestRelease(
  exec: Exec,
  repo: string,
  sleep: Sleep = realSleep,
): string {
  const tag = (
    JSON.parse(
      ghRead({ exec, sleep }, ["api", `repos/${repo}/releases/latest`]),
    ) as {
      tag_name?: string;
    }
  ).tag_name;
  if (!tag || !TAG_RE.test(tag))
    throw new Error(`the latest release isn't vX.Y.Z: ${tag}`);
  return tag;
}

/** The commit a tag points at (through an annotated tag). */
export function tagCommit(
  exec: Exec,
  repo: string,
  tag: string,
  sleep: Sleep = realSleep,
): string {
  const sha = (
    JSON.parse(
      ghRead({ exec, sleep }, [
        "api",
        "-X",
        "GET",
        `repos/${repo}/commits/${tag}`,
      ]),
    ) as { sha?: string }
  ).sha;
  if (!sha || !SHA_RE.test(sha)) throw new Error(`no commit for ${tag}`);
  return sha;
}

function runsFor(o: {
  exec: Exec;
  sleep?: Sleep;
  repo: string;
  next: Next;
  tag: string;
}): Run[] {
  const t = TARGET[o.next];
  const body = JSON.parse(
    ghRead({ exec: o.exec, sleep: o.sleep ?? realSleep }, [
      "api",
      "-X",
      "GET",
      "--jq",
      "{workflow_runs: [.workflow_runs[]? | {id, display_title, status, conclusion, event, head_branch, head_sha, created_at, html_url, actor: {login: .actor.login}, head_repository: {full_name: .head_repository.full_name}}]}",
      `repos/${o.repo}/actions/workflows/${t.file}/runs?event=workflow_dispatch&branch=main&per_page=20`,
    ]),
  ) as { workflow_runs?: Run[] };
  if (!Array.isArray(body.workflow_runs))
    throw new Error(`unparsable ${t.file} runs`);
  const title = t.title(o.tag);
  return body.workflow_runs.filter((r) => {
    const d = r.display_title ?? "";
    return d === title || d.startsWith(`${title} [`);
  });
}

/** Runs of `next`'s workflow for `tag`, in any state (this chain's carry ` [id]`). */
export function existingRuns(o: {
  exec: Exec;
  sleep?: Sleep;
  repo: string;
  next: Next;
  tag: string;
}): number[] {
  return runsFor(o).map((r) => r.id);
}

/**
 * This chain's staging deploy of the tag succeeded: a deploy-hosted-platform
 * run titled with the tag and an `sc` chain id, the release App's bot as its
 * actor, completed with success.
 */
export function chainDeployGreen(o: {
  exec: Exec;
  sleep?: Sleep;
  repo: string;
  tag: string;
}): boolean {
  return runsFor({ ...o, next: "deploy" }).some(
    (r) =>
      DEPLOY_TITLE_RE.exec(r.display_title ?? "")?.[1] === o.tag &&
      r.actor?.login === APP_ACTOR &&
      r.status === "completed" &&
      r.conclusion === "success",
  );
}

/**
 * The staging copy of the tag succeeded: the newest hosted-publish run started
 * by hosted-release (event workflow_run, on main) that ran the
 * `publish-staging release <tag>` job decides. Its job succeeded: copied (the
 * run may still be going, stage-prod follows the copy). It failed or was
 * cancelled: not copied, whatever an older run did, so a newer failed copy
 * keeps the gate shut. It has not finished: not yet, since its run's end is
 * the next event. A run that skipped the job, or has none, is passed over.
 */
export function stagingCopied(o: {
  exec: Exec;
  sleep?: Sleep;
  repo: string;
  tag: string;
}): boolean {
  const read = { exec: o.exec, sleep: o.sleep ?? realSleep };
  const body = JSON.parse(
    ghRead(read, [
      "api",
      "-X",
      "GET",
      "--jq",
      "{workflow_runs: [.workflow_runs[]? | {id, event, head_branch}]}",
      `repos/${o.repo}/actions/workflows/hosted-publish.yml/runs?event=workflow_run&branch=main&per_page=20`,
    ]),
  ) as {
    workflow_runs?: { id?: number; event?: string; head_branch?: string }[];
  };
  if (!Array.isArray(body.workflow_runs))
    throw new Error("unparsable hosted-publish.yml runs");
  const name = `publish-staging release ${o.tag}`;
  for (const r of body.workflow_runs) {
    if (r.event !== "workflow_run" || r.head_branch !== "main") continue;
    if (!Number.isSafeInteger(r.id) || (r.id as number) < 1)
      throw new Error("a bad hosted-publish.yml run id");
    const jobs = JSON.parse(
      ghRead(read, [
        "api",
        "-X",
        "GET",
        `repos/${o.repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`,
      ]),
    ) as { jobs?: { name?: string; conclusion?: string | null }[] };
    if (!Array.isArray(jobs.jobs)) throw new Error("unparsable run jobs");
    const ran = jobs.jobs.filter(
      (j) => j.name === name && j.conclusion !== "skipped",
    );
    if (ran.length === 0) continue;
    // The newest run that ran the copy decides: every attempt there green.
    return ran.every((j) => j.conclusion === "success");
  }
  return false;
}

type Jobs = { name?: string; conclusion?: string | null }[];

/** A run's jobs, latest attempt only (a re-run's jobs replace the first's). */
function runJobs(
  read: { exec: Exec; sleep: Sleep },
  repo: string,
  runId: string,
): Jobs {
  if (!RUN_ID_RE.test(runId)) throw new Error("bad run id");
  const body = JSON.parse(
    ghRead(read, [
      "api",
      "-X",
      "GET",
      `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    ]),
  ) as { jobs?: Jobs };
  if (!Array.isArray(body.jobs)) throw new Error("unparsable run jobs");
  return body.jobs;
}

/** PUBLIC_PIN at a commit: the public tag and commit it pins. */
function pinAt(
  read: { exec: Exec; sleep: Sleep },
  repo: string,
  sha: string,
): { tag: string; sha: string } {
  const text = ghRead(read, [
    "api",
    "-X",
    "GET",
    "-H",
    "Accept: application/vnd.github.raw+json",
    `repos/${repo}/contents/PUBLIC_PIN?ref=${sha}`,
  ]);
  const field = (k: string) =>
    new RegExp(`^${k}=(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  const pin = { tag: field("tag"), sha: field("sha") };
  if (!TAG_RE.test(pin.tag) || !SHA_RE.test(pin.sha))
    throw new Error(`unparsable PUBLIC_PIN at ${sha}`);
  return pin;
}

/**
 * The release a successful real hosted-release run built, or null if it built
 * none (its guard did not pass). Its hosted-built job names it (cloud #469);
 * else its hosted-guard's rule: the tag PUBLIC_PIN names at the run's head,
 * at that tag's own commit, whose PUBLIC_PIN pins the same release. Anything
 * that doesn't hold throws: the chain fails closed.
 */
export function builtRelease(o: {
  exec: Exec;
  sleep?: Sleep;
  repo: string;
  runId: string;
  headSha: string;
}): { tag: string; sha: string } | null {
  const read = { exec: o.exec, sleep: o.sleep ?? realSleep };
  const jobs = runJobs(read, o.repo, o.runId).filter(
    (j) => j.conclusion === "success",
  );
  const marks = [
    ...new Set(
      jobs.map((j) => j.name ?? "").filter((n) => BUILT_JOB_RE.test(n)),
    ),
  ];
  if (marks.length > 1) throw new Error("the run names several built releases");
  if (marks[0]) {
    const [, tag = "", sha = ""] = BUILT_JOB_RE.exec(marks[0]) ?? [];
    const at = tagCommit(o.exec, o.repo, tag, o.sleep);
    if (at !== sha)
      throw new Error(`the run built ${tag} at ${sha}, but ${tag} is at ${at}`);
    return { tag, sha };
  }
  // Before #469: what the guard checked.
  if (!jobs.some((j) => j.name === "hosted-guard")) return null;
  const pin = pinAt(read, o.repo, o.headSha);
  const sha = tagCommit(o.exec, o.repo, pin.tag, o.sleep);
  if (sha !== o.headSha) {
    const there = pinAt(read, o.repo, sha);
    if (there.tag !== pin.tag || there.sha !== pin.sha)
      throw new Error(
        `${pin.tag} is at ${sha}, which does not pin ${pin.tag} at ${pin.sha}`,
      );
  }
  return { tag: pin.tag, sha };
}

export type Plan =
  | { go: true; next: Next; tag: string }
  | { go: false; why: string };

export function plan(o: {
  exec: Exec;
  sleep?: Sleep;
  repo: string;
  /** The event run's workflow file (workflow_run.path), not its name: a run-name replaces the name. */
  workflow: string;
  conclusion: string;
  event: string;
  branch: string;
  title: string;
  actor: string;
  runId: string;
  /** The event run's commit (workflow_run.head_sha); read after hosted-release only (its guard's PUBLIC_PIN). */
  headSha?: string;
}): Plan {
  const skip = (why: string): Plan => ({ go: false, why });
  if (o.conclusion !== "success")
    return skip(`the ${o.workflow} run concluded ${o.conclusion}`);
  if (o.branch !== "main") return skip("the run is not on main");
  let next: Next;
  let tag: string;
  const ctx = { exec: o.exec, sleep: o.sleep, repo: o.repo };
  const file = o.workflow.replace(/@.*$/, "");
  if (file === WORKFLOW_DIR + "hosted-release.yml") {
    // Step 4: the deploy starts beside hosted-publish's staging copy, which
    // the same hosted-release run starts.
    if (o.title !== "hosted-release")
      return skip("a hosted-release dry run does not start the chain");
    if (o.event !== "push" && o.event !== "workflow_dispatch")
      return skip(`a hosted-release ${o.event} run does not start the chain`);
    if (!SHA_RE.test(o.headSha ?? "")) throw new Error("bad head sha");
    // The release the run built, which can be an older commit than its head
    // (a rebuild of an existing tag): the tag hosted-publish's staging copy
    // resolves from the same run.
    const built = builtRelease({
      ...ctx,
      runId: o.runId,
      headSha: o.headSha as string,
    });
    if (!built) return skip("the run built no release: no release cut");
    const latest = latestRelease(o.exec, o.repo, o.sleep);
    if (built.tag !== latest)
      return skip(
        `the run built ${built.tag}, not the newest release ${latest}`,
      );
    next = "deploy";
    tag = latest;
  } else if (file === WORKFLOW_DIR + "hosted-publish.yml") {
    if (o.event !== "workflow_run")
      return skip("a manual publish does not start the chain");
    if (!RUN_ID_RE.test(o.runId)) throw new Error("bad run id");
    const jobs = JSON.parse(
      ghRead({ exec: o.exec, sleep: o.sleep ?? realSleep }, [
        "api",
        "-X",
        "GET",
        `repos/${o.repo}/actions/runs/${o.runId}/jobs?per_page=100`,
      ]),
    ) as { jobs?: { name?: string; conclusion?: string | null }[] };
    if (!Array.isArray(jobs.jobs)) throw new Error("unparsable run jobs");
    const tags = jobs.jobs
      .filter((j) => j.conclusion === "success")
      .map((j) => PUBLISH_JOB_RE.exec(j.name ?? "")?.[1])
      .filter((t): t is string => !!t);
    if (tags.length === 0) return skip("the run published no release");
    if (tags.length > 1) throw new Error("the run published several releases");
    tag = tags[0] as string;
    const latest = latestRelease(o.exec, o.repo, o.sleep);
    if (latest !== tag)
      return skip(`${tag} is not the newest release (${latest})`);
    // The deploy normally started beside the copy (after hosted-release); if
    // no deploy run exists for the tag, start it now, as before step 4.
    if (existingRuns({ ...ctx, next: "deploy", tag }).length === 0)
      next = "deploy";
    else if (chainDeployGreen({ ...ctx, tag })) next = "gate";
    else
      return skip(
        `the staging deploy of ${tag} has not succeeded: its end starts the gate`,
      );
  } else if (file === WORKFLOW_DIR + "deploy-hosted-platform.yml") {
    if (o.event !== "workflow_dispatch") return skip("not a dispatched deploy");
    if (o.actor !== APP_ACTOR) return skip("not dispatched by this chain");
    const m = DEPLOY_TITLE_RE.exec(o.title);
    if (!m?.[1])
      return skip("not a staging deploy this chain dispatched (no chain id)");
    tag = m[1];
    const latest = latestRelease(o.exec, o.repo, o.sleep);
    if (latest !== tag)
      return skip(`${tag} is not the newest release (${latest})`);
    // The gate needs the staging copy too: a failed copy never starts it.
    if (!stagingCopied({ ...ctx, tag }))
      return skip(
        `the staging copy of ${tag} has not succeeded: its end starts the gate`,
      );
    next = "gate";
  } else {
    return skip(`unexpected workflow ${o.workflow}`);
  }
  const have = existingRuns({ ...ctx, next, tag });
  if (have.length > 0)
    return skip(`a ${TARGET[next].file} run for ${tag} already exists`);
  return { go: true, next, tag };
}

/** Starts the next workflow; false (nothing started) if the tag's run exists or the tag went stale. */
export function dispatch(o: {
  exec: Exec;
  sleep?: Sleep;
  repo: string;
  next: Next;
  tag: string;
  chainId: string;
  /** Staging's billing is configured (chain-dispatch.ts billingConfigured): deploy the billing-inclusive list. */
  billing?: boolean;
}): { started: boolean; why?: string } {
  if (!TAG_RE.test(o.tag)) throw new Error(`not a release tag: ${o.tag}`);
  if (!CHAIN_RE.test(o.chainId)) throw new Error("bad chain id");
  if (latestRelease(o.exec, o.repo, o.sleep) !== o.tag)
    return { started: false, why: `${o.tag} is no longer the newest release` };
  if (
    existingRuns({
      exec: o.exec,
      sleep: o.sleep,
      repo: o.repo,
      next: o.next,
      tag: o.tag,
    }).length > 0
  )
    return { started: false, why: `a run for ${o.tag} already exists` };
  // Deploy: env, tag and the chain id, so every other input keeps the
  // workflow's default (no reason, not verify_only); the targets too, unless
  // billing is configured: then the full list with billing, the one-version
  // list prod-release-chain deploys (chain-dispatch.ts).
  const args =
    o.next === "deploy"
      ? [
          "-f",
          "env=staging",
          "-f",
          `tag=${o.tag}`,
          "-f",
          `chain_id=${o.chainId}`,
          ...(o.billing ? ["-f", `targets=${FULL_BILLING}`] : []),
        ]
      : ["-f", `tag=${o.tag}`];
  gh(o.exec, [
    "workflow",
    "run",
    TARGET[o.next].file,
    "--repo",
    o.repo,
    "--ref",
    "main",
    ...args,
  ]);
  return { started: true };
}

const MAX_BUFFER = 16 * 1024 * 1024;
const realExec: Exec = (cmd, args) => {
  // A runs list can pass spawnSync's 1 MiB default; the reads also ask gh for
  // a small --jq body, this is the backstop.
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: MAX_BUFFER });
  const code = r.status ?? 1;
  return {
    code,
    stdout: r.stdout ?? "",
    stderr:
      (r.stderr ?? "") +
      (r.status === null
        ? ` [${(r.error as NodeJS.ErrnoException | undefined)?.code ?? "killed"}: gh output over ${MAX_BUFFER} bytes or killed]`
        : ""),
  };
};
const flag = (argv: string[], name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? "" : (argv[i + 1] ?? "");
};
const oneLine = (s: string) =>
  [...s]
    .map((c) => (c.charCodeAt(0) < 32 || c === "\x7f" ? " " : c))
    .join("")
    .trim()
    .slice(0, 300);

function main(argv: string[]) {
  const out = process.env.GITHUB_OUTPUT;
  const emit = (k: string, v: string) => {
    const line = `${k}=${oneLine(v)}\n`;
    process.stdout.write(line);
    if (out) appendFileSync(out, line);
  };
  const cmd = argv[0];
  const repo = flag(argv, "repo");
  if (cmd === "plan") {
    const p = plan({
      exec: realExec,
      repo,
      workflow: flag(argv, "workflow"),
      conclusion: flag(argv, "conclusion"),
      event: flag(argv, "event"),
      branch: flag(argv, "branch"),
      title: flag(argv, "title"),
      actor: flag(argv, "actor"),
      runId: flag(argv, "run-id"),
      headSha: flag(argv, "head-sha"),
    });
    emit("go", String(p.go));
    if (p.go) {
      emit("next", p.next);
      emit("tag", p.tag);
    } else {
      emit("why", p.why);
      console.log(`::notice title=Staging chain skipped::${oneLine(p.why)}`);
    }
  } else if (cmd === "dispatch") {
    const next = flag(argv, "next");
    if (next !== "deploy" && next !== "gate") throw new Error("bad --next");
    const billing =
      next === "deploy" &&
      billingConfigured(
        readFileSync(
          flag(argv, "hosted-file") || ".github/hosted/staging.json",
          "utf8",
        ),
      );
    const r = dispatch({
      exec: realExec,
      repo,
      billing,
      next,
      tag: flag(argv, "tag"),
      chainId: flag(argv, "chain-id"),
    });
    emit("started", String(r.started));
    if (!r.started)
      console.log(
        `::notice title=Staging chain skipped::${oneLine(r.why ?? "")}`,
      );
  } else {
    throw new Error("usage: plan | dispatch");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`staging-release-chain: ${(e as Error).message}`);
    process.exit(1);
  }
}
