#!/usr/bin/env bash
# ci-plan.sh <overlay-dir> <private-dir> <out-dir>
#
# Works out what CI builds and tests, from this repo's tracked files, after
# scripts/overlay.sh has copied them onto public. Writes three lists into
# <out-dir>, which CI then runs:
#
#   packages.txt      private packages: workspace dirs (apps/*, packages/*,
#                     scripts/*, tests/*) whose package.json is in this repo.
#                     CI builds, typechecks and tests each one.
#   root-tests.txt    scripts/(ci|ops|audit)/<name>.test.ts: run by the root vitest.
#   public-tests.txt  every other *.test.ts: private tests that live inside a
#                     public package. One line per file, "<pkg>\t<file>", the
#                     file relative to <pkg>. CI runs each through its owning
#                     package's vitest (scripts/ci-public-tests.sh).
#
# Fails (exit 1), so CI can never pass by running less than it should:
#   - a private package without a "test" or "typecheck" script;
#   - a *.test.ts outside the sets above with no owning public package (a
#     workspace dir with a package.json in the overlay);
#   - SYNCED_FROM exists but there are no private packages: the sync ran and
#     the tree is empty or broken.
#
# Exit 0 on success, 1 on a failure, 2 on bad usage.
set -uo pipefail

die() { echo "ci-plan: $*" >&2; exit 1; }
[ "$#" -eq 3 ] || { echo "usage: ci-plan.sh <overlay-dir> <private-dir> <out-dir>" >&2; exit 2; }

OVL=$(cd "$1" 2> /dev/null && pwd) || die "overlay dir not found: $1"
PRIV=$(cd "$2" 2> /dev/null && pwd) || die "private dir not found: $2"
OUT=$3
mkdir -p "$OUT" || die "cannot create $OUT"
for l in packages root-tests public-tests; do
  : > "$OUT/$l.txt" || die "cannot write $OUT/$l.txt"
done

files=$(git -C "$PRIV" ls-files) || die "git ls-files failed in $PRIV"
WS_PKG='^(apps|packages|scripts|tests)/[^/]+'
ROOT_TEST='^scripts/(ci|ops|audit)/[^/]+\.test\.ts$'

# --- Private packages, each with test and typecheck --------------------------
pkgs=$( (grep -E "$WS_PKG/package\.json$" <<< "$files" || true) | sed 's|/package\.json$||')
errors=0
while IFS= read -r d; do
  [ -n "$d" ] || continue
  missing=$(node -e '
    const s = (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).scripts) || {};
    const m = ["test", "typecheck"].filter((k) => typeof s[k] !== "string" || s[k].trim() === "");
    process.stdout.write(m.join(" "));
  ' "$PRIV/$d/package.json") || die "cannot read $d/package.json"
  if [ -n "$missing" ]; then
    echo "ci-plan: private package $d has no script: $missing" >&2
    errors=$((errors + 1))
  fi
  printf '%s\n' "$d" >> "$OUT/packages.txt"
done <<< "$pkgs"

if [ -f "$PRIV/SYNCED_FROM" ] && [ ! -s "$OUT/packages.txt" ]; then
  die "SYNCED_FROM exists but there are no private packages: the sync left nothing to build"
fi

# --- Tests ------------------------------------------------------------------
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in *.test.ts) ;; *) continue ;; esac
  if grep -Eq "$ROOT_TEST" <<< "$f"; then
    printf '%s\n' "$f" >> "$OUT/root-tests.txt"
    continue
  fi
  owned=no
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    case "$f" in "$d"/*) owned=yes; break ;; esac
  done <<< "$pkgs"
  [ "$owned" = no ] || continue        # a private package's own suite runs it
  pkg=$(grep -Eo "$WS_PKG" <<< "$f" || true)
  if [ -z "$pkg" ] || [ ! -f "$OVL/$pkg/package.json" ]; then
    echo "ci-plan: no owning package for $f (no workspace package.json above it)" >&2
    errors=$((errors + 1))
    continue
  fi
  printf '%s\t%s\n' "$pkg" "${f#"$pkg"/}" >> "$OUT/public-tests.txt"
done <<< "$files"

[ "$errors" -eq 0 ] || die "$errors problem(s); see above"

echo "ci-plan: private packages ($(grep -c '' "$OUT/packages.txt")):"
sed 's/^/  /' "$OUT/packages.txt"
echo "ci-plan: root vitest tests ($(grep -c '' "$OUT/root-tests.txt")):"
sed 's/^/  /' "$OUT/root-tests.txt"
echo "ci-plan: private tests in public packages ($(grep -c '' "$OUT/public-tests.txt")):"
sed 's/^/  /; s/\t/: /' "$OUT/public-tests.txt"
