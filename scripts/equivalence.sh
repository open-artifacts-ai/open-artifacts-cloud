#!/usr/bin/env bash
# equivalence.sh <public-checkout-dir> [<private-dir>]
#
# Proves the pre-split overlay reproduces public. With S the commit in
# SYNCED_FROM, it builds overlay(PUB@S minus the private paths, this repo)
# in a temp dir and diffs that tree against PUB@S. Any difference outside
# ALLOW below fails: a file the sync dropped, or one this repo added.
#
# Hosted workflows are parked in hosted-workflows/ (inert) until the cut-over;
# the check moves them to .github/workflows/ in the temp tree, as the
# cut-over will, so they are compared too.
#
# Before the first sync SYNCED_FROM is absent, this repo holds no private
# paths, and there is nothing to compare: the check skips (exit 0) and says so.
# The public checkout must contain commit S; its HEAD may be anywhere.
#
# Exit 0 on a pass or a skip, 1 on a difference or failure, 2 on bad usage.
set -uo pipefail

# The one allowlist: paths allowed to differ. An entry ending in / is a
# directory prefix; any other entry is an exact path.
ALLOW=(
  pnpm-lock.yaml              # the private merged lockfile replaces public's
  SYNCED_FROM
  hosted-workflows/
  # Files only this repo has:
  README.md
  PUBLIC_PIN
  private-paths.txt
  scripts/overlay.sh
  scripts/overlay.test.sh
  scripts/sync-from-public.sh
  scripts/equivalence.sh
  scripts/dev-overlay.sh
  scripts/ci-plan.sh
  scripts/ci-public-tests.sh
  .github/workflows/ci.yml    # this repo's CI; public's own ci.yml stays
)

die() { echo "equivalence: $*" >&2; exit 1; }
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { echo "usage: equivalence.sh <public-checkout-dir> [<private-dir>]" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd) || exit 2
PRIV=$(cd "${2:-$HERE/..}" 2> /dev/null && pwd) || die "private dir not found: ${2:-$HERE/..}"

if [ ! -f "$PRIV/SYNCED_FROM" ]; then
  echo "equivalence: SKIPPED: no SYNCED_FROM in $PRIV, so no sync has happened and this repo holds no private paths yet. The check runs once SYNCED_FROM exists."
  exit 0
fi
PUB=$(cd "$1" 2> /dev/null && pwd) || die "public checkout not found: $1"
sha=$(sed -n 's/^sha=//p' "$PRIV/SYNCED_FROM")
tag=$(sed -n 's/^tag=//p' "$PRIV/SYNCED_FROM")
printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$' || die "SYNCED_FROM sha is not a full sha: '$sha'"
[ -n "$tag" ] || tag=none
git -C "$PUB" cat-file -e "$sha^{commit}" 2> /dev/null || die "public checkout has no commit $sha (SYNCED_FROM)"

T=$(mktemp -d) || exit 2
trap 'rm -rf "$T"' EXIT
ref="$T/ref" work="$T/work" priv="$T/priv"
mkdir -p "$ref" "$priv" || exit 2

# ref: PUB@S exactly. work: a checkout of PUB@S to overlay onto.
git -C "$PUB" archive "$sha" | tar -C "$ref" -xf - || die "cannot export $sha"
git clone -q --no-checkout "$PUB" "$work" 2> /dev/null || die "cannot clone $PUB"
git -C "$work" checkout -q --detach "$sha" || die "cannot check out $sha"

# A copy of this repo whose pin is S, so overlay.sh's rule 1 holds for S.
if [ "$(git -C "$PRIV" rev-parse --show-toplevel 2> /dev/null)" = "$PRIV" ]; then
  git -C "$PRIV" ls-files -co --exclude-standard -z | tar -C "$PRIV" --null -T - -cf - | tar -C "$priv" -xf - \
    || die "cannot copy $PRIV"
else
  tar -C "$PRIV" --exclude=.git -cf - . | tar -C "$priv" -xf - || die "cannot copy $PRIV"
fi
printf 'tag=%s\nsha=%s\n' "$tag" "$sha" > "$priv/PUBLIC_PIN"

"$HERE/overlay.sh" --pre-split "$work" "$priv" || die "overlay --pre-split failed"

# What the cut-over does: parked hosted workflows go live.
if [ -d "$priv/hosted-workflows" ]; then
  mkdir -p "$work/.github/workflows" || exit 2
  (cd "$priv/hosted-workflows" && find . -type f -print0 | tar --null -T - -cf -) | tar -C "$work/.github/workflows" -xf - \
    || die "cannot move hosted-workflows"
fi

allowed() { # path
  local a
  for a in "${ALLOW[@]}"; do
    case "$a" in
      */) [[ "$1" == "$a"* ]] && return 0 ;;
      *) [ "$1" = "$a" ] && return 0 ;;
    esac
  done
  return 1
}

# Paths that differ, one per line: "Only in", "differ" and type changes.
diffs=$(cd "$T" && diff -rq --no-dereference -x .git ref work 2>&1)
bad=0 seen=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "$line" in
    "Only in "*)
      rest=${line#Only in }
      path="${rest%%: *}/${rest#*: }"
      side=${path%%/*}; path=${path#*/}; path=${path#/}
      kind="only in $([ "$side" = ref ] && echo 'public (dropped)' || echo 'overlay (extra)')" ;;
    "Files "*" differ")
      rest=${line#Files }; path=${rest%% and *}; path=${path#ref/}; kind="content differs" ;;
    "File "*)
      rest=${line#File }; path=${rest%% is *}; path=${path#ref/}; path=${path#work/}; kind="type differs" ;;
    *) echo "equivalence: unreadable diff line: $line" >&2; bad=$((bad + 1)); continue ;;
  esac
  seen=$((seen + 1))
  if allowed "$path"; then continue; fi
  echo "equivalence: DIFF: $path ($kind)" >&2
  bad=$((bad + 1))
done <<< "$diffs"

if [ "$bad" -gt 0 ]; then
  die "$bad difference(s) outside the allowlist between overlay and public $tag ($sha)"
fi
echo "equivalence: OK: overlay(public@$sha minus private paths, this repo) matches public ($seen allowlisted difference(s))"
