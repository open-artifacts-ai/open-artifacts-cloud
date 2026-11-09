// The scheduled pin-bump PR opener (cloud #20). When public has a release newer
// than PUBLIC_PIN, one PR bumps the pin (and SYNCED_FROM, with the regenerated
// lockfile); CI's pin-check port check and equivalence check judge it. This
// script never arms or merges anything, and never opens a second PR.
// Usage: node --experimental-strip-types scripts/ci/pin-bump.ts plan --repo owner/name [--public owner/name]
//        node --experimental-strip-types scripts/ci/pin-bump.ts apply --tag vX.Y.Z --sha <40 hex> [--dir .]
//        node --experimental-strip-types scripts/ci/pin-bump.ts open-pr --repo owner/name --tag vX.Y.Z --sha <sha> --branch pin-bump/vX.Y.Z
// `plan` prints `bump=true|false`, `tag`, `sha`, `branch` for $GITHUB_OUTPUT.
// Any API error throws, so the run is red: a bump never fails quietly.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PUBLIC_REPO = "open-artifacts-ai/open-artifacts";
/** Every bump branch starts with this; one open PR from such a branch is the limit. */
export const BRANCH_PREFIX = "pin-bump/";
export const branchOf = (tag: string) => `${BRANCH_PREFIX}${tag}`;

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;
export type Plan = { bump: boolean; tag: string; sha: string; why: string };

const TAG = /^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const SHA = /^[0-9a-f]{40}$/;

function gh(exec: Exec, args: string[]): string {
  const r = exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}

const parts = (tag: string) => {
  const m = TAG.exec(tag);
  if (!m) throw new Error(`${tag} isn't vX.Y.Z`);
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
};
/** Negative when a is older than b. */
export function compareTags(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The value of a `key=value` line, or throws: a pin file without it is broken. */
export function pinField(text: string, key: "tag" | "sha"): string {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  if (!m) throw new Error(`no ${key}= line`);
  return (m[1] ?? "").trim();
}

/** Sets the tag= and sha= lines and keeps every other line (comments, list=). */
export function rewritePin(text: string, tag: string, sha: string): string {
  parts(tag);
  if (!SHA.test(sha)) throw new Error(`${sha} isn't a full sha`);
  pinField(text, "tag");
  pinField(text, "sha");
  return text
    .replace(/^tag=.*$/m, `tag=${tag}`)
    .replace(/^sha=.*$/m, `sha=${sha}`);
}

/** Writes the new pin into PUBLIC_PIN and SYNCED_FROM under dir. */
export function applyPin(dir: string, tag: string, sha: string) {
  for (const f of ["PUBLIC_PIN", "SYNCED_FROM"]) {
    const p = join(dir, f);
    writeFileSync(p, rewritePin(readFileSync(p, "utf8"), tag, sha));
  }
}

type Release = { tag_name: string; draft: boolean; prerelease: boolean };
type Pr = { number: number; headRefName: string; url: string };

/** What tonight does: nothing, or one bump to the newest public release. */
export function plan(o: {
  exec: Exec;
  repo: string;
  publicRepo: string;
  pin: string; // PUBLIC_PIN's text
}): Plan {
  const current = pinField(o.pin, "tag");
  parts(current);
  const none = (why: string, tag = "", sha = ""): Plan => ({
    bump: false,
    tag,
    sha,
    why,
  });

  const releases = JSON.parse(
    gh(o.exec, ["api", `repos/${o.publicRepo}/releases?per_page=30`]),
  ) as Release[];
  const tags = releases
    .filter((r) => !r.draft && !r.prerelease && TAG.test(r.tag_name))
    .map((r) => r.tag_name);
  if (tags.length === 0) throw new Error("no stable vX.Y.Z public release");
  const newest = tags.reduce((a, b) => (compareTags(a, b) >= 0 ? a : b));
  if (compareTags(newest, current) <= 0)
    return none(`PUBLIC_PIN ${current} is the newest release (${newest})`);

  const open = (
    JSON.parse(
      gh(o.exec, [
        "pr",
        "list",
        "--repo",
        o.repo,
        "--state",
        "open",
        "--json",
        "number,headRefName,url",
        "--limit",
        "100",
      ]),
    ) as Pr[]
  ).find((p) => p.headRefName.startsWith(BRANCH_PREFIX));
  if (open)
    return none(
      `${open.url} (${open.headRefName}) is open; ${newest} waits for it`,
      newest,
    );

  const seen = JSON.parse(
    gh(o.exec, [
      "pr",
      "list",
      "--repo",
      o.repo,
      "--state",
      "all",
      "--head",
      branchOf(newest),
      "--json",
      "number,state",
    ]),
  ) as { number: number; state: string }[];
  if (seen.length > 0)
    return none(
      `PR ${seen[0]?.number} (${seen[0]?.state}) already took ${newest}`,
      newest,
    );

  const sha = gh(o.exec, [
    "api",
    `repos/${o.publicRepo}/commits/${newest}`,
    "-q",
    ".sha",
  ]).trim();
  if (!SHA.test(sha))
    throw new Error(`${newest} resolved to '${sha}', not a full sha`);
  return { bump: true, tag: newest, sha, why: `${current} -> ${newest}` };
}

/** Opens the PR. Re-checks for an open bump PR first: a race never makes two. */
export function openPr(o: {
  exec: Exec;
  repo: string;
  publicRepo: string;
  tag: string;
  sha: string;
  branch: string;
}): { action: "opened"; url: string } | { action: "left"; url: string } {
  const open = (
    JSON.parse(
      gh(o.exec, [
        "pr",
        "list",
        "--repo",
        o.repo,
        "--state",
        "open",
        "--json",
        "number,headRefName,url",
        "--limit",
        "100",
      ]),
    ) as Pr[]
  ).find((p) => p.headRefName.startsWith(BRANCH_PREFIX));
  if (open) return { action: "left", url: open.url };
  const body = [
    `Bumps PUBLIC_PIN and SYNCED_FROM to the public release ${o.tag} (${o.sha}), with the lockfile regenerated in the overlay (\`pnpm install --lockfile-only\`).`,
    "",
    `Release: https://github.com/${o.publicRepo}/releases/tag/${o.tag}`,
    "",
    'Opened by the pin-bump workflow. It never arms or merges. CI decides: pin-check (the port check against the base\'s SYNCED_FROM) and equivalence must pass. If public touched a hosted path, port it in this branch (README, "Hand-porting a public fix") before merging.',
  ].join("\n");
  const url = gh(o.exec, [
    "pr",
    "create",
    "--repo",
    o.repo,
    "--base",
    "main",
    "--head",
    o.branch,
    "--title",
    `chore(pin): bump PUBLIC_PIN to ${o.tag}`,
    "--body",
    body,
  ]).trim();
  return { action: "opened", url };
}

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

const flag = (argv: string[], name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : fallback;
  if (!v) throw new Error(`missing --${name}`);
  return v;
};

function main(argv: string[]) {
  const [mode] = argv;
  if (mode === "plan") {
    const p = plan({
      exec: realExec,
      repo: flag(argv, "repo"),
      publicRepo: flag(argv, "public", PUBLIC_REPO),
      pin: readFileSync("PUBLIC_PIN", "utf8"),
    });
    console.error(`pin-bump: bump=${p.bump} ${p.why}`);
    console.log(
      `bump=${p.bump}\ntag=${p.tag}\nsha=${p.sha}\nbranch=${p.tag ? branchOf(p.tag) : ""}`,
    );
    return;
  }
  if (mode === "apply") {
    applyPin(flag(argv, "dir", "."), flag(argv, "tag"), flag(argv, "sha"));
    return;
  }
  if (mode === "open-pr") {
    const r = openPr({
      exec: realExec,
      repo: flag(argv, "repo"),
      publicRepo: flag(argv, "public", PUBLIC_REPO),
      tag: flag(argv, "tag"),
      sha: flag(argv, "sha"),
      branch: flag(argv, "branch"),
    });
    console.error(`pin-bump: ${r.action} ${r.url}`);
    return;
  }
  throw new Error("usage: pin-bump.ts <plan|apply|open-pr> ...");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
