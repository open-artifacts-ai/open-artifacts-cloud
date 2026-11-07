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
#      them), the rule does not apply: strict mode, nothing to tie.
#   3. Otherwise the pin may lead S only while public did not touch the hosted
#      paths between S and P, and did not change the list. If it did, CLOUD
#      has not taken those changes: hand-port them and bump SYNCED_FROM to the
#      new pin in the same PR (README, "Hand-porting a public fix"). Bumping
#      SYNCED_FROM is the statement that the ports are in this PR.
#   4. This repo's private-paths.txt must list the same paths as public's list
#      at S, so the fallback list never goes stale.
#
# Before the first sync (no SYNCED_FROM) it skips. Exit 0 on a pass or skip,
# 1 on a failure, 2 on bad usage.
set -uo pipefail

die() { echo "pin-check: $*" >&2; exit 1; }
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { echo "usage: pin-check.sh <public-checkout-dir> [<private-dir>]" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd) || exit 2
PRIV=$(cd "${2:-$HERE/..}" 2> /dev/null && pwd) || die "private dir not found: ${2:-$HERE/..}"
if [ ! -e "$PRIV/SYNCED_FROM" ] && [ ! -L "$PRIV/SYNCED_FROM" ]; then
  echo "pin-check: SKIPPED: no SYNCED_FROM in $PRIV (no sync yet)"
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

present=0
while IFS= read -r q; do
  git -C "$PUB" cat-file -e "$p:$q" 2> /dev/null && present=$((present + 1))
done <<< "$list_p"
if [ "$present" -eq 0 ]; then
  echo "pin-check: OK: public at PUBLIC_PIN holds none of the private paths (strict mode); nothing to tie"
  exit 0
fi

list_s=$(list_at "$s")
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
