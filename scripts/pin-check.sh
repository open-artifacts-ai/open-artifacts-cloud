#!/usr/bin/env bash
# pin-check.sh <public-checkout-dir> [<private-dir>]
#
# Keeps PUBLIC_PIN tied to SYNCED_FROM while public still holds the hosted
# paths (pre-split). The public checkout needs history: it must contain both
# commits (CI fetches it in full).
#
# With S = SYNCED_FROM's sha and P = PUBLIC_PIN's sha:
#   1. S must be P or an ancestor of P. A pin behind the sync is wrong.
#   2. If P's tree holds none of the listed private paths (public has deleted
#      them), this is strict mode: nothing is left to tie, but the pin may lead
#      S only while public made no add/modify/type change to the listed paths
#      between S and P (a fix made before the delete). Otherwise bump
#      SYNCED_FROM to the last commit before the delete, with the ports.
#   3. Otherwise the pin may lead S only while public did not touch the hosted
#      paths between S and P, and did not change the list. If it did, CLOUD
#      has not taken those changes: hand-port them and bump SYNCED_FROM to the
#      new pin in the same PR (README, "Hand-porting a public fix"). Bumping
#      SYNCED_FROM is the statement that the ports are in this PR.
#   4. This repo's private-paths.txt must list the same paths as public's list
#      at S, so the fallback list never goes stale.
#
#   5. Port check (--prev <sha>, CI passes the SYNCED_FROM of the PR base): when
#      SYNCED_FROM moved from <sha>, every public change to the listed paths
#      between <sha> and SYNCED_FROM must already be in this tree. The public
#      diff, with workflows renamed to hosted-workflows/, must reverse-apply
#      (git apply -R --check). Files named in port-exceptions.txt (one public
#      path per line) are skipped: CLOUD kept its own side. Each line is
#      "<path> <SYNCED_FROM sha> # reason" and counts only for the bump whose
#      new SYNCED_FROM is that sha; an entry for any other sha is stale and
#      fails. That file is a reviewed change like any other.
#      The port check runs before the strict-mode exit. When SYNCED_FROM is
#      itself past the delete, the public diff is taken to the last commit
#      before the first delete, so a fix made before the delete is still seen.
#
# SYNCED_FROM is required: absent, the check skips only if this tree holds none
# of the listed paths (before the first sync); otherwise it fails.
# Exit 0 on a pass or skip, 1 on a failure, 2 on bad usage.
set -uo pipefail

die() { echo "pin-check: $*" >&2; exit 1; }
prev=""
if [ "${1:-}" = "--prev" ]; then
  [ "$#" -ge 2 ] || { echo "usage: pin-check.sh [--prev <sha>] <public-checkout-dir> [<private-dir>]" >&2; exit 2; }
  prev=$2; shift 2
fi
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { echo "usage: pin-check.sh [--prev <sha>] <public-checkout-dir> [<private-dir>]" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd) || exit 2
PRIV=$(cd "${2:-$HERE/..}" 2> /dev/null && pwd) || die "private dir not found: ${2:-$HERE/..}"
if [ ! -e "$PRIV/SYNCED_FROM" ] && [ ! -L "$PRIV/SYNCED_FROM" ]; then
  held=$("$HERE/listed-present.sh" "$1" "$PRIV") || die "cannot list present paths"
  [ -z "$held" ] || die "SYNCED_FROM is missing but this tree holds listed private paths:
$(printf '%s\n' "$held" | sed 's/^/  /')
SYNCED_FROM is required once the paths are synced; restore it."
  echo "pin-check: SKIPPED: no SYNCED_FROM in $PRIV and no listed private paths (no sync yet)"
  exit 0
fi
[ -f "$PRIV/SYNCED_FROM" ] && [ ! -L "$PRIV/SYNCED_FROM" ] && [ -r "$PRIV/SYNCED_FROM" ] \
  || die "SYNCED_FROM exists but is not a readable regular file"
PUB=$(cd "$1" 2> /dev/null && pwd) || die "public checkout not found: $1"

s=$(sed -n 's/^sha=//p' "$PRIV/SYNCED_FROM")
p=$(sed -n 's/^sha=//p' "$PRIV/PUBLIC_PIN" 2> /dev/null)
printf '%s' "$s" | grep -Eq '^[0-9a-f]{40}$' || die "SYNCED_FROM sha is not a full sha: '$s'"
printf '%s' "$p" | grep -Eq '^[0-9a-f]{40}$' || die "PUBLIC_PIN sha is not a full sha: '$p'"
git -C "$PUB" cat-file -e "$s^{commit}" 2> /dev/null || die "public checkout has no commit $s (SYNCED_FROM); fetch full history"
git -C "$PUB" cat-file -e "$p^{commit}" 2> /dev/null || die "public checkout has no commit $p (PUBLIC_PIN); fetch full history"
git -C "$PUB" merge-base --is-ancestor "$s" "$p" \
  || die "SYNCED_FROM ($s) is not PUBLIC_PIN ($p) or an ancestor of it: the pin must not be behind the sync"

# port-exceptions.txt: "<path> <sha> # reason". An entry applies only to the bump
# whose new SYNCED_FROM is <sha>; any other entry is stale and fails.
exc_paths=()
if [ -f "$PRIV/port-exceptions.txt" ]; then
  while IFS= read -r line; do
    line=$(printf '%s' "$line" | tr -d '\r' | sed 's/#.*//; s/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -n "$line" ] || continue
    read -r e_path e_sha e_rest <<< "$line"
    { [ -n "${e_sha:-}" ] && [ -z "${e_rest:-}" ] && printf '%s' "$e_sha" | grep -Eq '^[0-9a-f]{40}$'; } \
      || die "port-exceptions.txt: bad line '$line' (want: <path> <full SYNCED_FROM sha> # reason)"
    [ "$e_sha" = "$s" ] \
      || die "port-exceptions.txt: stale entry '$e_path' is for $e_sha, not SYNCED_FROM ($s). Remove it, or re-justify it for this bump."
    exc_paths+=("$e_path")
  done < "$PRIV/port-exceptions.txt"
fi

# Normalized entries of a path list on stdin: no comments, blanks, CR, trailing /.
norm() { tr -d '\r' | sed 's/#.*//; s/[[:space:]]*$//; s/^[[:space:]]*//; s|/$||' | grep -v '^$' | LC_ALL=C sort -u; }
list_at() { # commit: public's list at that commit, else this repo's
  if git -C "$PUB" cat-file -e "$1:scripts/ci/private-paths.txt" 2> /dev/null; then
    git -C "$PUB" show "$1:scripts/ci/private-paths.txt" | norm
  else
    norm < "$PRIV/private-paths.txt"
  fi
}
[ -f "$PRIV/private-paths.txt" ] || die "no private-paths.txt in $PRIV"
list_p=$(list_at "$p")
[ -n "$list_p" ] || die "the path list at PUBLIC_PIN is empty"

present_at() { # commit list: how many listed paths the commit's tree holds
  local n=0 q
  while IFS= read -r q; do
    git -C "$PUB" cat-file -e "$1:$q" 2> /dev/null && n=$((n + 1))
  done <<< "$2"
  echo "$n"
}
present=$(present_at "$p" "$list_p")

list_s=$(list_at "$s")
if [ -n "$prev" ] && [ "$prev" != "$s" ]; then
  printf '%s' "$prev" | grep -Eq '^[0-9a-f]{40}$' || die "--prev is not a full sha: '$prev'"
  git -C "$PUB" cat-file -e "$prev^{commit}" 2> /dev/null || die "public checkout has no commit $prev (the base SYNCED_FROM); fetch full history"
  git -C "$PUB" merge-base --is-ancestor "$prev" "$s" || die "the base SYNCED_FROM ($prev) is not an ancestor of SYNCED_FROM ($s)"
  specs=()
  while IFS= read -r q; do specs+=("$q"); done < <({ list_at "$prev"; printf '%s\n' "$list_s"; } | LC_ALL=C sort -u)
  for q in ${exc_paths[@]+"${exc_paths[@]}"}; do specs+=(":(exclude,literal)$q"); done
  # When SYNCED_FROM is past the delete, the net diff only shows the deletion
  # and hides a fix made before it. Port against the last commit before the
  # first delete instead; later add/modify commits are refused.
  sp=$s
  if [ "$(present_at "$s" "$list_s")" -eq 0 ]; then
    d1=$(git -C "$PUB" log --format=%H --reverse --no-renames --diff-filter=D "$prev..$s" -- "${specs[@]}" | head -n 1)
    if [ -n "$d1" ]; then
      sp=$(git -C "$PUB" rev-parse "$d1^1" 2> /dev/null) || die "cannot resolve the parent of the first delete commit $d1"
      late=$(git -C "$PUB" log --format=%H --full-history -m --no-renames --diff-filter=AMRT "$sp..$s" -- "${specs[@]}") || die "git log failed"
      [ -z "$late" ] || die "public changed listed paths between the first delete ($d1) and SYNCED_FROM ($s):
$(printf '%s\n' "$late" | sed 's/^/  /')
Set SYNCED_FROM to the last commit before the delete, with the ports."
      echo "pin-check: SYNCED_FROM ($s) is past the delete; porting against $sp, the last commit before it"
    fi
  fi
  # git apply -R --check cannot validate hunks that the pathspec dropped.
  pdiff=""
  if [ "$sp" != "$prev" ]; then
    pdiff=$(git -C "$PUB" diff --binary --no-renames "$prev" "$sp" -- "${specs[@]}") || die "git diff failed"
  fi
  if [ -n "$pdiff" ]; then
    errf=$(mktemp) || die "mktemp failed"
    if ! printf '%s\n' "$pdiff" \
      | sed -e '/^diff --git /s|\([ab]\)/\.github/workflows/|\1/hosted-workflows/|g' -e '/^\(---\|+++\) [ab]\//s|\([ab]\)/\.github/workflows/|\1/hosted-workflows/|g' \
      | git -C "$PRIV" apply -R --check 2> "$errf"; then
      echo "pin-check: public changes between $prev and SYNCED_FROM ($s) are not all in this tree:" >&2
      sed 's/^/  /' "$errf" >&2; rm -f "$errf"
      die "SYNCED_FROM moved without porting the public fix. Port it (README, \"Hand-porting a public fix\") or, where CLOUD deliberately keeps its own side, name the file in port-exceptions.txt."
    fi
    rm -f "$errf"
    echo "pin-check: port check: every public change to the listed paths from $prev to $sp is in this tree"
  fi
fi
if [ "$present" -eq 0 ]; then
  # Strict mode: public holds none of the paths at the pin. The pin may lead the
  # sync only if public made no non-deletion change to the listed paths since.
  if [ "$s" != "$p" ]; then
    paths=()
    while IFS= read -r q; do paths+=("$q"); done <<< "$list_s"
    late=$(git -C "$PUB" log --format=%H --full-history -m --no-renames --diff-filter=AMRT "$s..$p" -- "${paths[@]}") || die "git log failed"
    if [ -n "$late" ]; then
      echo "pin-check: public changed listed paths between SYNCED_FROM and PUBLIC_PIN before deleting them:" >&2
      printf '%s\n' "$late" | sed 's/^/  /' >&2
      die "PUBLIC_PIN ($p) leads SYNCED_FROM ($s) over hosted changes made before the delete. Hand-port them and bump SYNCED_FROM to the last commit before the delete in the same PR."
    fi
  fi
  echo "pin-check: OK: public at PUBLIC_PIN holds none of the private paths (strict mode); no pre-delete change is unported"
  exit 0
fi
if [ "$s" != "$p" ]; then
  [ "$list_s" = "$list_p" ] || die "public's private-paths list changed between SYNCED_FROM ($s) and PUBLIC_PIN ($p). Hand-port the change and bump SYNCED_FROM to the pin in the same PR."
  paths=()
  while IFS= read -r q; do paths+=("$q"); done <<< "$list_p"
  changed=$(git -C "$PUB" diff --name-only "$s" "$p" -- "${paths[@]}") || die "git diff failed"
  if [ -n "$changed" ]; then
    echo "pin-check: public changed private paths between SYNCED_FROM and PUBLIC_PIN:" >&2
    printf '%s\n' "$changed" | sed 's/^/  /' >&2
    die "PUBLIC_PIN ($p) leads SYNCED_FROM ($s) over changed hosted paths. Hand-port those changes and bump SYNCED_FROM to the pin in the same PR."
  fi
fi
[ "$(norm < "$PRIV/private-paths.txt")" = "$list_s" ] \
  || die "private-paths.txt does not match the list at SYNCED_FROM ($s). Refresh it (sync-from-public.sh does) or hand-port the list change."
echo "pin-check: OK: SYNCED_FROM $s, PUBLIC_PIN $p ($([ "$s" = "$p" ] && echo equal || echo 'pin leads; public did not touch the hosted paths'))"
