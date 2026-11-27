// The prod release chain's dispatch (#1343, cloud #264): start
// deploy-hosted-platform.yml or hosted-publish.yml on main for one tag, and
// end. It never waits: the started run's own completion is the next event
// (prod-release-chain.yml listens for both workflows), so nothing here polls,
// sleeps or times out. The release App's installation token dispatches
// (GH_TOKEN, minted by the calling job in the main-only release-app
// Environment): GitHub raises no workflow_run event for a run the default
// GITHUB_TOKEN started, so a token-started run would end the chain silently.
//
// The deploy gets env=prod, the tag, every target (billing included once
// prod's prices are filled), no reason, verify_only false, require_newer true
// and the chain id; the publish (#1412) gets env=prod, the tag and the chain
// id only. The chain id rides in the run's name
// (`deploy-hosted-platform prod <tag> [c<run>-<n>]`,
// `hosted-publish prod <tag> [p<run>-<n>]`), which is how the next step knows
// the run is the chain's own.
//
// A reusable-workflow call cannot be used: a secret the caller does not pass
// resolves empty even when the called job's Environment has it, and the
// caller (a `uses:` job) cannot set an Environment (run 42109047045). A
// dispatched run is an ordinary run of the workflow, so every secret comes
// from its own job's Environment.
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
export const FULL =
  "platform-db,auth-broker,directory-broker,provision-token,provisioner,provisioning,dispatch,inventory,zones,scheduler";
/** The full list with billing (#1568), between the directory broker and provision-token. */
export const FULL_BILLING =
  "platform-db,auth-broker,directory-broker,billing,provision-token,provisioner,provisioning,dispatch,inventory,zones,scheduler";
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
/** The chain id each workflow's run name carries: p for the publish, c for the deploy. */
export const CHAIN_RE: Record<Which, RegExp> = {
  deploy: /^c[0-9]{1,20}-[0-9]{1,4}$/,
  publish: /^p[0-9]{1,20}-[0-9]{1,4}$/,
};

export interface Opts {
  exec: Exec;
  repo: string;
  tag: string;
  chainId: string;
  /** Which workflow to dispatch; deploy by default. */
  workflow?: Which;
  /** Deploy with the billing target (prod's billing is configured). */
  billing?: boolean;
}

const gh = (exec: Exec, args: string[]): string => {
  const r = exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
};

/** Backoff before retries 2 and 3 of a read-only gh call. */
const READ_BACKOFF_MS = [2_000, 5_000, 10_000];

/**
 * A read-only gh call, tried up to 3 times with backoff so one transient API
 * failure does not fail a chain step. A retry of a failed read, not a wait
 * for anything. Never use this for a write (the dispatch).
 */
export const ghRead = (
  o: { exec: Exec; sleep: (ms: number) => void },
  args: string[],
): string => {
  for (let i = 0; ; i++) {
    try {
      return gh(o.exec, args);
    } catch (e) {
      if (i >= 2) throw e;
      o.sleep(READ_BACKOFF_MS[i] ?? 10_000);
    }
  }
};

/**
 * Dispatches the workflow once and returns the run name it will carry. A bad
 * tag or chain id throws before any call; a refused dispatch throws (never
 * retried: a write). Nothing is waited for.
 */
export function dispatch(o: Opts): { title: string } {
  const which = o.workflow ?? "deploy";
  if (!TAG_RE.test(o.tag)) throw new Error(`not a release tag: ${o.tag}`);
  if (!CHAIN_RE[which].test(o.chainId)) throw new Error("bad chain id");
  gh(o.exec, [
    "workflow",
    "run",
    WORKFLOWS[which].file,
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
  // The run-name each workflow builds from these inputs.
  return { title: `${WORKFLOWS[which].name} prod ${o.tag} [${o.chainId}]` };
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
    const r = dispatch({
      billing,
      exec: realExec,
      repo: flag(argv, "repo"),
      tag: flag(argv, "tag"),
      chainId: flag(argv, "chain-id"),
      workflow: flag(argv, "workflow") === "publish" ? "publish" : "deploy",
    });
    // Its end is the next event: prod-release-chain.yml takes it from there.
    emit("dispatched", r.title);
  } catch (e) {
    const line = outputLine("deploy_note", (e as Error).message);
    console.error(`chain-dispatch: ${line.trim()}`);
    if (out) appendFileSync(out, line);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
