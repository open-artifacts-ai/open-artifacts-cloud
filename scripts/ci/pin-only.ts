// Is this pull request a pin-only bot bump (cloud, run-once decision)? Prints one
// word on stdout, "pin-only" or "full", and always exits 0. Anything but "pin-only"
// means the job runs in full; every error, missing variable or surprise is "full".
//
// "pin-only" needs ALL of: the event is pull_request; the head branch is
// pin-bump/vX.Y.Z in this repo; the PR author is the release App's bot (the same
// BOT pin-bump-arm.ts uses); and `git diff base...head` shows only plain
// modifications of the pin files (PUBLIC_PIN and SYNCED_FROM, plus the lockfile,
// the same set pin-bump-arm.ts allows). merge_group, push and workflow_dispatch
// are never pin-only, so the merge queue always runs the whole suite.
//
// Usage (in the repo checkout, with the full history):
//   BASE_SHA=... HEAD_SHA=... EVENT_NAME=... AUTHOR=... HEAD_REF=... HEAD_REPO=... \
//   REPO=... node --experimental-strip-types --no-warnings pin-only.ts
// ci.yml runs the copy of this file (and its two imports) from the BASE commit,
// never the code under test.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { BOT, BRANCH, PIN_FILES } from "./pin-bump-arm.ts";

export type Verdict = { pinOnly: boolean; why: string };
export type Git = (args: string[]) => { code: number; stdout: string };
export type Env = Record<string, string | undefined>;

const SHA = /^[0-9a-f]{40}$/;
/** The two files every bump moves; the lockfile is optional, as in pin-bump-arm.ts. */
const REQUIRED = ["PUBLIC_PIN", "SYNCED_FROM"];
const full = (why: string): Verdict => ({ pinOnly: false, why });

/**
 * Pure apart from `git`: the changed files of base...head as [path, status, old
 * mode, new mode], or throws. Renames are off, so a rename reads as a delete and
 * an add, and a mode or type change shows up in the modes and status.
 */
export function changedFiles(git: Git, base: string, head: string) {
  const r = git([
    "diff",
    "--raw",
    "-z",
    "--no-renames",
    "--no-abbrev",
    `${base}...${head}`,
  ]);
  if (r.code !== 0) throw new Error(`git diff exited ${r.code}`);
  const t = r.stdout.split("\0");
  if (t.pop() !== "") throw new Error("unterminated git diff output");
  const out: { path: string; status: string; old: string; now: string }[] = [];
  for (let i = 0; i < t.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([A-Z])$/.exec(
      t[i] ?? "",
    );
    const path = t[i + 1];
    if (!m || !path) throw new Error("unreadable git diff entry");
    out.push({ path, old: m[1] ?? "", now: m[2] ?? "", status: m[3] ?? "" });
  }
  return out;
}

export function decide(env: Env, git: Git): Verdict {
  try {
    if (env.EVENT_NAME !== "pull_request")
      return full(`event is ${env.EVENT_NAME || "unknown"}, not pull_request`);
    if (!env.AUTHOR || env.AUTHOR !== BOT)
      return full(`author is ${env.AUTHOR || "unknown"}, not ${BOT}`);
    if (!env.HEAD_REF || !BRANCH.test(env.HEAD_REF))
      return full(`branch ${env.HEAD_REF || "unknown"} is not pin-bump/vX.Y.Z`);
    if (!env.REPO || env.HEAD_REPO !== env.REPO)
      return full("the head is not in this repository");
    const { BASE_SHA: base, HEAD_SHA: head } = env;
    if (!base || !head || !SHA.test(base) || !SHA.test(head))
      return full("base or head sha missing or not a full sha");
    const files = changedFiles(git, base, head);
    if (files.length === 0) return full("the diff is empty");
    const paths = files.map((f) => f.path);
    if (new Set(paths).size !== paths.length)
      return full("a file is listed twice");
    const bad = files.filter(
      (f) =>
        !PIN_FILES.includes(f.path) ||
        f.status !== "M" ||
        f.old !== "100644" ||
        f.now !== "100644",
    );
    if (bad.length > 0)
      return full(
        `not pin-only: ${bad.map((f) => `${f.path} (${f.status})`).join(", ")}`,
      );
    for (const f of REQUIRED)
      if (!paths.includes(f)) return full(`${f} is not changed`);
    return { pinOnly: true, why: `only ${paths.join(", ")} changed` };
  } catch (e) {
    return full(`error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const realGit: Git = (args) => {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "" };
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const v = decide(process.env, realGit);
  console.error(`pin-only: ${v.pinOnly ? "yes" : "no"}: ${v.why}`);
  console.log(v.pinOnly ? "pin-only" : "full");
}
