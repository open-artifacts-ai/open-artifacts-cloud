// The release chain's deploy (#1343): dispatch deploy-hosted-platform.yml on
// main with GITHUB_TOKEN, find the one run that dispatch started, and wait
// for it. It fails closed: a dispatch it cannot match to exactly one run, or
// a run that is not a success, fails the chain.
//
// The same machinery dispatches hosted-publish.yml (workflow "publish",
// #1412): the chain publishes a tag's release to prod's bucket, with env=prod,
// the tag and its chain id, before it deploys. Both are matched and waited for
// the same way.
//
// A reusable-workflow call cannot be used: a secret the caller does not pass
// resolves empty even when the called job's Environment has it, and the
// caller (a `uses:` job) cannot set an Environment (run 42109047045). A
// dispatched run is an ordinary run of the workflow, so every secret comes
// from its own job's Environment.
//
// The run is matched by event workflow_dispatch, actor github-actions[bot],
// branch main, created no earlier than the dispatch (minus a little clock
// skew) and a display title that is exactly
// `deploy-hosted-platform prod <tag> [<chain id>]`, which the workflow's
// run-name builds from its inputs. Zero matches by the
// find deadline, or more than one, fails.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;

export type Which = "deploy" | "publish";
const WORKFLOWS: Record<Which, { file: string; name: string }> = {
  deploy: {
    file: "deploy-hosted-platform.yml",
    name: "deploy-hosted-platform",
  },
  publish: { file: "hosted-publish.yml", name: "hosted-publish" },
};
const BOT = "github-actions[bot]";
const FULL =
  "platform-db,auth-broker,directory-broker,provision-token,provisioner,dispatch,inventory,provisioning,zones,scheduler";
/** The full list with billing (#1568), between the directory broker and provision-token. */
const FULL_BILLING =
  "platform-db,auth-broker,directory-broker,billing,provision-token,provisioner,dispatch,inventory,provisioning,zones,scheduler";
const PRICE_RE = /^price_[A-Za-z0-9]{1,255}$/;
const REQUIRED_PRICES = [
  "stripe_price_team",
  "stripe_price_business",
  "stripe_price_solo_monthly",
  "stripe_price_solo_yearly",
] as const;

/**
 * Whether prod's billing is configured: the four required live price ids are
 * filled in prod.json (each a price id). Empty means not yet, and the chain
 * skips the billing target cleanly instead of failing every prod release.
 * Throws on JSON that cannot be read or a filled value that is not a price id
 * (a broken file fails the chain, never silently skips).
 */
export function billingConfigured(prodJson: string): boolean {
  const j = JSON.parse(prodJson) as Record<string, unknown>;
  let filled = 0;
  for (const k of REQUIRED_PRICES) {
    const v = j[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || !PRICE_RE.test(v))
      throw new Error(`prod.json: ${k} is not a Stripe price id`);
    filled++;
  }
  // Partly filled is a broken state: the billing target would refuse for the
  // missing price, so the chain says so now.
  if (filled !== 0 && filled !== REQUIRED_PRICES.length)
    throw new Error("prod.json: the billing prices are only partly filled");
  return filled === REQUIRED_PRICES.length;
}
const TAG_RE = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const CHAIN_RE = /^[A-Za-z0-9-]{1,40}$/;

type WorkflowRun = {
  id: number;
  status: string;
  conclusion: string | null;
  event?: string;
  display_title?: string;
  head_branch?: string;
  created_at?: string;
  html_url?: string;
  actor?: { login?: string } | null;
};

export type Outcome = { runId: number; url: string; conclusion: string };

export interface Opts {
  exec: Exec;
  repo: string;
  tag: string;
  chainId: string;
  /** Which workflow to dispatch; deploy by default. */
  workflow?: Which;
  /** Deploy with the billing target (prod's billing is configured). */
  billing?: boolean;
  now: () => number;
  sleep: (ms: number) => void;
  /** Called as soon as the run is found, before waiting for it. */
  onFound?: (runId: number, url: string) => void;
  skewMs?: number;
  findTimeoutMs?: number;
  waitTimeoutMs?: number;
  pollMs?: number;
}

const gh = (exec: Exec, args: string[]): string => {
  const r = exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
};

export function dispatchAndWait(o: Opts): Outcome {
  if (!TAG_RE.test(o.tag)) throw new Error(`not a release tag: ${o.tag}`);
  if (!CHAIN_RE.test(o.chainId)) throw new Error("bad chain id");
  const skew = o.skewMs ?? 60_000;
  const findFor = o.findTimeoutMs ?? 5 * 60_000;
  const waitFor = o.waitTimeoutMs ?? 45 * 60_000;
  const poll = o.pollMs ?? 10_000;

  const which = o.workflow ?? "deploy";
  const WORKFLOW = WORKFLOWS[which].file;
  const t0 = o.now();
  gh(o.exec, [
    "workflow",
    "run",
    WORKFLOW,
    "--repo",
    o.repo,
    "--ref",
    "main",
    "-f",
    "env=prod",
    "-f",
    `tag=${o.tag}`,
    ...(which === "deploy"
      ? [
          "-f",
          `targets=${o.billing ? FULL_BILLING : FULL}`,
          "-f",
          "reason=",
          "-f",
          "verify_only=false",
          "-f",
          "require_newer=true",
        ]
      : []),
    "-f",
    `chain_id=${o.chainId}`,
  ]);

  const since = o.now() - skew;
  // The run-name is exactly this (deploy-hosted-platform.yml): a wrong env or
  // tag in the title is not our run.
  const title = `${WORKFLOWS[which].name} prod ${o.tag} [${o.chainId}]`;
  const matches = (): WorkflowRun[] => {
    const out = JSON.parse(
      gh(o.exec, [
        "api",
        `repos/${o.repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=100`,
      ]),
    ) as { workflow_runs?: WorkflowRun[] };
    return (out.workflow_runs ?? []).filter(
      (r) =>
        r.event === "workflow_dispatch" &&
        r.actor?.login === BOT &&
        r.head_branch === "main" &&
        Date.parse(r.created_at ?? "") >= since &&
        r.display_title === title,
    );
  };

  let found: WorkflowRun | undefined;
  while (!found) {
    const m = matches();
    if (m.length > 1)
      throw new Error(
        `${m.length} runs match chain id ${o.chainId}: refusing to guess`,
      );
    if (m[0]) found = m[0];
    else if (o.now() - t0 >= findFor)
      throw new Error(`no run for chain id ${o.chainId} within ${findFor} ms`);
    else o.sleep(poll);
  }
  const url =
    found.html_url ?? `https://github.com/${o.repo}/actions/runs/${found.id}`;
  o.onFound?.(found.id, url);

  const start = o.now();
  for (;;) {
    const r = JSON.parse(
      gh(o.exec, ["api", `repos/${o.repo}/actions/runs/${found.id}`]),
    ) as WorkflowRun;
    if (r.status === "completed") {
      if (r.conclusion !== "success")
        throw new Error(
          `${which} run ${found.id} concluded ${r.conclusion ?? "none"}: ${url}`,
        );
      return { runId: found.id, url, conclusion: "success" };
    }
    if (o.now() - start >= waitFor) {
      // Never leave a prod deploy running unwatched: cancel it, then look
      // once more. A run that finished green while the cancel was in flight
      // is a success; anything else fails, saying what was done.
      let did: string;
      try {
        gh(o.exec, [
          "api",
          "-X",
          "POST",
          `repos/${o.repo}/actions/runs/${found.id}/cancel`,
        ]);
        did = `cancelled the dispatched run ${url}`;
      } catch (e) {
        did = `could not cancel the dispatched run ${url} (${(e as Error).message})`;
      }
      try {
        const last = JSON.parse(
          gh(o.exec, ["api", `repos/${o.repo}/actions/runs/${found.id}`]),
        ) as WorkflowRun;
        if (last.status === "completed" && last.conclusion === "success")
          return { runId: found.id, url, conclusion: "success" };
      } catch {
        // Fall through: not proven green.
      }
      throw new Error(
        `${which} run ${found.id} did not finish within ${waitFor} ms; ${did}`,
      );
    }
    o.sleep(poll);
  }
}

/**
 * One `key=value` line for $GITHUB_OUTPUT. The value is collapsed to a single
 * line (no newline, carriage return or other control character), so an error
 * message can never add a line of its own such as a forged `deploy_run=`.
 */
export function outputLine(key: string, value: string, max = 300): string {
  const one = [...value]
    .map((c) => (c.charCodeAt(0) < 32 || c === "\x7f" ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return `${key}=${one}\n`;
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

function main(argv: string[]) {
  const out = process.env.GITHUB_OUTPUT;
  const emit = (key: string, value: string) => {
    const line = outputLine(key, value);
    process.stdout.write(line);
    if (out) appendFileSync(out, line);
  };
  try {
    const billing =
      flag(argv, "workflow") !== "publish" &&
      billingConfigured(
        readFileSync(
          flag(argv, "hosted-file") || ".github/hosted/prod.json",
          "utf8",
        ),
      );
    if (flag(argv, "workflow") !== "publish")
      console.log(
        billing
          ? "chain-dispatch: the billing target is included"
          : "chain-dispatch: billing skipped (prod's price ids are not filled in prod.json)",
      );
    const r = dispatchAndWait({
      billing,
      exec: realExec,
      repo: flag(argv, "repo"),
      tag: flag(argv, "tag"),
      chainId: flag(argv, "chain-id"),
      workflow: flag(argv, "workflow") === "publish" ? "publish" : "deploy",
      now: Date.now,
      sleep: (ms) =>
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
      onFound: (id, url) => {
        emit("deploy_run", String(id));
        emit("deploy_url", url);
      },
    });
    emit("deploy_conclusion", r.conclusion);
  } catch (e) {
    const line = outputLine("deploy_note", (e as Error).message);
    console.error(`chain-dispatch: ${line.trim()}`);
    if (out) appendFileSync(out, line);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
