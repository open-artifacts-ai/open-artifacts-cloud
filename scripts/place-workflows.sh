#!/usr/bin/env bash
# place-workflows.sh <private-dir> <overlay-tree>
#
# What the cut-over will do, for CI and equivalence.sh: copy the parked hosted
# workflows (<private-dir>/hosted-workflows/, recursively) to
# <overlay-tree>/.github/workflows/, keeping modes and symlinks (cp -P -p).
# GitHub reads workflows only from this repo's own root, so the copies never
# run. A symlinked hosted-workflows, or a target that already exists, fails:
# never an overwrite. No hosted-workflows dir places nothing (exit 0).
#
# One helper, so the CI place step and equivalence.sh cannot drift apart.
# Exit 0 on success, 1 on a refusal, 2 on bad usage.
set -uo pipefail

die() { echo "place-workflows: $*" >&2; exit 1; }
[ "$#" -eq 2 ] || { echo "usage: place-workflows.sh <private-dir> <overlay-tree>" >&2; exit 2; }
PRIV=$(cd "$1" 2> /dev/null && pwd) || die "private dir not found: $1"
TREE=$(cd "$2" 2> /dev/null && pwd) || die "overlay tree not found: $2"

src="$PRIV/hosted-workflows"
if [ -L "$src" ]; then die "hosted-workflows is a symlink"; fi
if [ ! -d "$src" ]; then
  echo "place-workflows: no hosted-workflows/: placed 0 workflow(s)"
  exit 0
fi
wf="$TREE/.github/workflows"
mkdir -p "$wf" || die "cannot create $wf"
n=0
while IFS= read -r -d '' f; do
  f=${f#./}
  if [ -e "$wf/$f" ] || [ -L "$wf/$f" ]; then
    die "hosted-workflows/$f would overwrite .github/workflows/$f"
  fi
  mkdir -p "$wf/$(dirname "$f")" || die "cannot create $wf/$(dirname "$f")"
  cp -P -p "$src/$f" "$wf/$f" || die "cannot move hosted-workflows/$f"
  n=$((n + 1))
done < <(cd "$src" && find . \( -type f -o -type l \) -print0)
echo "place-workflows: placed $n hosted workflow(s)"
