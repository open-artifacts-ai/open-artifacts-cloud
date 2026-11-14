// The staging half of the release chain (cloud #264 step 1,
// staging-release-chain.yml): once hosted-publish has published a release to
// staging, deploy-hosted-platform.yml (env staging) starts on its own; once
// that deploy succeeds, redline-staging.yml (the gate) starts on its own, for
// the same tag. prod-release-chain.yml then follows the gate as before.
//
// `plan` decides from one workflow_run event whether to act and what comes
// next; `dispatch` re-checks under the tag's concurrency group and starts the
// next workflow. Both print `key=value` lines for $GITHUB_OUTPUT. A skip is
// `go=false` with a `why` (neutral, green); an API error or a bad input
// throws (exit 1): the chain fails closed.
//
// Guards, each one's own check:
//   - the event's conclusion is success and its run is on main;
//   - after hosted-publish: the run was started by hosted-release (event
//     workflow_run, never a manual dispatch, which also carries prod and
//     floor publishes), and its publish-staging job for a release succeeded;
//     the tag is that job's name;
//   - after deploy-hosted-platform: the run is one this chain dispatched
//     (display title `deploy-hosted-platform staging <tag> [sc<run>-<n>]`,
//     the release App's bot as actor). A manual deploy, a verify_only run, a
//     partial-target run or a prod run has no `sc` chain id and never starts
//     the gate; this chain's deploy takes the workflow's default targets;
//   - the tag is the newest release (releases/latest);
//   - never twice: no run of the target workflow for that tag exists, in any
//     state (a failed one waits for a person), checked in `plan` and again in
//     `dispatch` under the concurrency group keyed on the tag.
// Usage: node --experimental-strip-types scripts/ci/staging-release-chain.ts plan --repo o/n --workflow <name> --conclusion <c> --event <e> --branch <b> --title <t> --actor <a> --run-id <id>
//        node --experimental-strip-types scripts/ci/staging-release-chain.ts dispatch --repo o/n --next deploy|gate --tag vX.Y.Z --chain-id <id>
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { billingConfigured, FULL_BILLING } from "./chain-dispatch.ts";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;
export type Next = "deploy" | "gate";

const TAG_RE = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const CHAIN_RE = /^sc[0-9]{1,20}-[0-9]{1,4}$/;
/** The release App's public login: the actor of a run dispatched with its token. */
export const APP_ACTOR = "open-artifacts-release[bot]";
/** The deploy run-name this chain's dispatch produces (deploy-hosted-platform.yml). */
export const DEPLOY_TITLE_RE =
  /^deploy-hosted-platform staging (v\d{1,6}\.\d{1,6}\.\d{1,6}) \[(sc[0-9]{1,20}-[0-9]{1,4})\]$/;
const PUBLISH_JOB_RE = /^publish-staging release (v\d{1,6}\.\d{1,6}\.\d{1,6})$/;

const TARGET: Record<Next, { file: string; title: (tag: string) => string }> = {
  deploy: {
    file: "deploy-hosted-platform.yml",
    title: (t) => `deploy-hosted-platform staging ${t}`,
  },
  gate: { file: "redline-staging.yml", title: (t) => `redline-staging ${t}` },
};

type Run = { id: number; display_title?: string };

function gh(exec: Exec, args: string[]): string {
  const r = exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}

export function latestRelease(exec: Exec, repo: string): string {
  const tag = (
    JSON.parse(gh(exec, ["api", `repos/${repo}/releases/latest`])) as {
      tag_name?: string;
    }
  ).tag_name;
  if (!tag || !TAG_RE.test(tag))
    throw new Error(`the latest release isn't vX.Y.Z: ${tag}`);
  return tag;
}

/** Runs of `next`'s workflow for `tag`, in any state (this chain's carry ` [id]`). */
export function existingRuns(o: {
  exec: Exec;
  repo: string;
  next: Next;
  tag: string;
}): number[] {
  const t = TARGET[o.next];
  const body = JSON.parse(
    gh(o.exec, [
      "api",
      "-X",
      "GET",
      `repos/${o.repo}/actions/workflows/${t.file}/runs?event=workflow_dispatch&branch=main&per_page=100`,
    ]),
  ) as { workflow_runs?: Run[] };
  if (!Array.isArray(body.workflow_runs))
    throw new Error(`unparsable ${t.file} runs`);
  const title = t.title(o.tag);
  return body.workflow_runs
    .filter((r) => {
      const d = r.display_title ?? "";
      return d === title || d.startsWith(`${title} [`);
    })
    .map((r) => r.id);
}

export type Plan =
  | { go: true; next: Next; tag: string }
  | { go: false; why: string };

export function plan(o: {
  exec: Exec;
  repo: string;
  workflow: string;
  conclusion: string;
  event: string;
  branch: string;
  title: string;
  actor: string;
  runId: string;
}): Plan {
  const skip = (why: string): Plan => ({ go: false, why });
  if (o.conclusion !== "success")
    return skip(`the ${o.workflow} run concluded ${o.conclusion}`);
  if (o.branch !== "main") return skip("the run is not on main");
  let next: Next;
  let tag: string;
  if (o.workflow === "hosted-publish") {
    if (o.event !== "workflow_run")
      return skip("a manual publish does not start the chain");
    if (!/^[1-9][0-9]{0,19}$/.test(o.runId)) throw new Error("bad run id");
    const jobs = JSON.parse(
      gh(o.exec, [
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
    next = "deploy";
    tag = tags[0] as string;
  } else if (o.workflow === "deploy-hosted-platform") {
    if (o.event !== "workflow_dispatch") return skip("not a dispatched deploy");
    if (!SLUG_RE.test(o.appSlug))
      throw new Error("RELEASE_APP_SLUG is not set");
    if (o.actor !== `${o.appSlug}[bot]`)
      return skip("not dispatched by this chain");
    const m = DEPLOY_TITLE_RE.exec(o.title);
    if (!m?.[1])
      return skip("not a staging deploy this chain dispatched (no chain id)");
    next = "gate";
    tag = m[1];
  } else {
    return skip(`unexpected workflow ${o.workflow}`);
  }
  const latest = latestRelease(o.exec, o.repo);
  if (latest !== tag)
    return skip(`${tag} is not the newest release (${latest})`);
  const have = existingRuns({ exec: o.exec, repo: o.repo, next, tag });
  if (have.length > 0)
    return skip(`a ${TARGET[next].file} run for ${tag} already exists`);
  return { go: true, next, tag };
}

/** Starts the next workflow; false (nothing started) if the tag's run exists or the tag went stale. */
export function dispatch(o: {
  exec: Exec;
  repo: string;
  next: Next;
  tag: string;
  chainId: string;
  /** Staging's billing is configured (chain-dispatch.ts billingConfigured): deploy the billing-inclusive list. */
  billing?: boolean;
}): { started: boolean; why?: string } {
  if (!TAG_RE.test(o.tag)) throw new Error(`not a release tag: ${o.tag}`);
  if (!CHAIN_RE.test(o.chainId)) throw new Error("bad chain id");
  if (latestRelease(o.exec, o.repo) !== o.tag)
    return { started: false, why: `${o.tag} is no longer the newest release` };
  if (
    existingRuns({ exec: o.exec, repo: o.repo, next: o.next, tag: o.tag })
      .length > 0
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

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
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
