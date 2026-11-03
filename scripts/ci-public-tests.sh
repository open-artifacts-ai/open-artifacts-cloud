#!/usr/bin/env bash
# ci-public-tests.sh <overlay-dir> <plan-dir>
#
# Runs the private tests that live inside public packages (public-tests.txt
# from scripts/ci-plan.sh) through each owning package's own vitest, with the
# configs that package's "test" script uses (e.g. vitest.config.ts for
# workerd, vitest.node.config.ts for test/node/). For each file it asks every
# such config, via `vitest list --filesOnly`, whether the config includes it,
# then runs it under each config that does.
#
# Fails (exit 1) if a file is included by none of its package's test configs
# (it would never run), or if any run fails. Needs the overlay installed.
#
# Exit 0 on success, 1 on a failure, 2 on bad usage.
set -uo pipefail

die() { echo "ci-public-tests: $*" >&2; exit 1; }
[ "$#" -eq 2 ] || { echo "usage: ci-public-tests.sh <overlay-dir> <plan-dir>" >&2; exit 2; }
OVL=$(cd "$1" 2> /dev/null && pwd -P) || die "overlay dir not found: $1"
PLAN=$(cd "$2" 2> /dev/null && pwd) || die "plan dir not found: $2"
[ -f "$PLAN/public-tests.txt" ] || die "no $PLAN/public-tests.txt (run ci-plan.sh first)"
if [ ! -s "$PLAN/public-tests.txt" ]; then
  echo "ci-public-tests: no private tests in public packages"
  exit 0
fi
work=$(mktemp -d) || die "mktemp failed"
trap 'rm -rf "$work"' EXIT

failures=0
mapfile -t owners < <(cut -f1 "$PLAN/public-tests.txt" | sort -u)
for pkg in "${owners[@]}"; do
  mapfile -t want < <(awk -F'\t' -v p="$pkg" '$1 == p { print $2 }' "$PLAN/public-tests.txt")
  # The configs the package's test script runs; "-" is vitest's default.
  mapfile -t cfgs < <(node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).scripts?.test ?? "";
    const out = new Set();
    for (const seg of s.split(/&&|\|\||;/)) {
      if (!/\bvitest\b/.test(seg)) continue;
      const m = seg.match(/(?:\s-c|\s--config)(?:\s+|=)(\S+)/);
      out.add(m ? m[1].replace(/^["\x27]|["\x27]$/g, "") : "-");
    }
    console.log([...out].join("\n"));
  ' "$OVL/$pkg/package.json")
  [ "${#cfgs[@]}" -gt 0 ] && [ -n "${cfgs[0]}" ] || {
    echo "ci-public-tests: $pkg: its test script runs no vitest; cannot run ${want[*]}" >&2
    failures=$((failures + 1)); continue
  }
  : > "$work/covered"
  for cfg in "${cfgs[@]}"; do
    cargs=()
    [ "$cfg" = - ] || cargs=(-c "$cfg")
    json="$work/list.json"; rm -f "$json"
    if ! (cd "$OVL/$pkg" && pnpm exec vitest list --filesOnly --json="$json" "${cargs[@]}" "${want[@]}" > "$work/list.log" 2>&1); then
      # No match under this config is a normal outcome; anything else shows below.
      [ -s "$json" ] || : > "$json"
    fi
    mapfile -t hit < <(node -e '
      const fs = require("fs"), path = require("path");
      let rows = [];
      try { rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "[]"); } catch {}
      const root = fs.realpathSync(process.argv[2]);
      const want = new Set(process.argv.slice(3));
      for (const r of rows) {
        const rel = path.relative(root, fs.realpathSync(r.file));
        if (want.has(rel)) console.log(rel);
      }
    ' "$json" "$OVL/$pkg" "${want[@]}" | sort -u)
    [ "${#hit[@]}" -gt 0 ] && [ -n "${hit[0]}" ] || continue
    printf '%s\n' "${hit[@]}" >> "$work/covered"
    echo "ci-public-tests: $pkg [${cfg/#-/vitest.config (default)}]: ${hit[*]}"
    if ! (cd "$OVL/$pkg" && pnpm exec vitest run "${cargs[@]}" "${hit[@]}"); then
      echo "ci-public-tests: $pkg [$cfg] failed" >&2
      failures=$((failures + 1))
    fi
  done
  for f in "${want[@]}"; do
    if ! grep -qxF "$f" "$work/covered"; then
      echo "ci-public-tests: $pkg/$f is included by none of $pkg's test configs (${cfgs[*]}); it would never run" >&2
      cat "$work/list.log" >&2
      failures=$((failures + 1))
    fi
  done
done
[ "$failures" -eq 0 ] || die "$failures failure(s)"
echo "ci-public-tests: all private tests in public packages passed"
