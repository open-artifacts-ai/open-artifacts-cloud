#!/usr/bin/env node
// Fails when a Worker's env.prod or env.staging `vars` hold a literal for a
// setting .github/hosted/<env>.json owns (#262). Such a var must be the
// {{NAME_<ENV>}} placeholder the deploy wrapper fills, or the committed value
// never reaches the Worker (prod sign-up stayed closed after v0.173.0 because
// env.prod hardcoded SIGNUPS_ENABLED).
// The key -> var mapping is read from scripts/ci/hosted-constants.sh (the
// `key NAME` lines it loads), plus the key upper-cased, so a new key is
// covered without editing this file.
// Usage: node --experimental-strip-types scripts/ci/check-hosted-owned-vars.ts [repo-root]
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripJsonc } from "../ops/wrangler-env.ts";

const ENVS = ["staging", "prod"] as const;

/** Var names each hosted key may appear as in a wrangler `vars` block. */
export function ownedVarNames(
  keys: string[],
  constantsSh: string,
): Map<string, string> {
  const owned = new Map<string, string>();
  const keySet = new Set(keys);
  for (const k of keys) owned.set(k.toUpperCase(), k);
  for (const line of constantsSh.split("\n")) {
    const m = /^([a-z][a-z0-9_]*) ([A-Z][A-Z0-9_]*)(?: |$)/.exec(line.trim());
    if (m && keySet.has(m[1])) {
      owned.set(m[2], m[1]);
      owned.set(m[2].replace(/^CLOUDFLARE_/, ""), m[1]);
    }
  }
  return owned;
}

export function hardcodedOwnedVars(root: string): string[] {
  const constantsSh = readFileSync(
    join(root, "scripts/ci/hosted-constants.sh"),
    "utf8",
  );
  const problems: string[] = [];
  for (const env of ENVS) {
    const hosted = JSON.parse(
      readFileSync(join(root, ".github/hosted", `${env}.json`), "utf8"),
    );
    const owned = ownedVarNames(Object.keys(hosted), constantsSh);
    const placeholder = new RegExp(
      `^\\{\\{[A-Z0-9_]+_${env.toUpperCase()}\\}\\}$`,
    );
    for (const app of readdirSync(join(root, "apps")).sort()) {
      let src: string;
      try {
        src = readFileSync(join(root, "apps", app, "wrangler.jsonc"), "utf8");
      } catch {
        continue;
      }
      const vars = JSON.parse(stripJsonc(src)).env?.[env]?.vars ?? {};
      for (const [name, value] of Object.entries(vars)) {
        const key = owned.get(name);
        if (key === undefined) continue;
        if (typeof value !== "string" || !placeholder.test(value))
          problems.push(
            `apps/${app}/wrangler.jsonc env.${env}.vars.${name} is a literal, but .github/hosted/${env}.json owns "${key}": use "{{${name}_${env.toUpperCase()}}}"`,
          );
      }
    }
  }
  return problems;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const problems = hardcodedOwnedVars(
    process.argv[2] ?? join(import.meta.dirname, "../.."),
  );
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(problems.length ? 1 : 0);
}
