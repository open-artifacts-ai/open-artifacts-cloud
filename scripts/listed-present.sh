#!/usr/bin/env bash
# listed-present.sh <public-checkout-dir> <private-dir>
#
# Prints (one per line) every listed private path that the private dir holds,
# at its own path or, for a hosted workflow, under hosted-workflows/ or
# .github/workflows/. The list is the private dir's private-paths.txt plus the
# public checkout's scripts/ci/private-paths.txt (working tree), when present.
# Used to refuse, rather than skip, when SYNCED_FROM is missing from a tree
# that already holds hosted code. Exit 0 always (unless usage), 2 on bad usage.
set -uo pipefail
[ "$#" -eq 2 ] || { echo "usage: listed-present.sh <public-checkout-dir> <private-dir>" >&2; exit 2; }
PUB=$1 PRIV=$2
norm() { tr -d '\r' | sed 's/#.*//; s/[[:space:]]*$//; s/^[[:space:]]*//; s|/$||' | grep -v '^$' || true; }
{
  if [ -f "$PRIV/private-paths.txt" ]; then norm < "$PRIV/private-paths.txt"; fi
  if [ -f "$PUB/scripts/ci/private-paths.txt" ]; then norm < "$PUB/scripts/ci/private-paths.txt"; fi
} | LC_ALL=C sort -u | while IFS= read -r q; do
  [ -n "$q" ] || continue
  hit=0
  for c in "$q" "hosted-workflows/${q#.github/workflows/}"; do
    case "$c" in hosted-workflows/*) [[ "$q" == .github/workflows/* ]] || continue ;; esac
    if [ -e "$PRIV/$c" ] || [ -L "$PRIV/$c" ]; then hit=1; fi
  done
  if [ "$hit" -eq 1 ]; then echo "$q"; fi
done
exit 0
