#!/usr/bin/env bash
# dev-overlay.sh <new-worktree-dir>
#
# Builds the hosted workspace locally, the same way CI does: a new git
# worktree of the public repo, detached at PUBLIC_PIN's sha, with this
# private checkout overlaid by scripts/overlay.sh.
#
#   OA_PUBLIC_REPO   the public clone to add the worktree from
#                    (default: ~/code/open-artifacts). It must already have
#                    the pinned commit; this script never fetches.
#
# The overlay is a build, not a place to keep work: private files in it are
# copies. Edit them in this private checkout and build a fresh overlay, or
# copy changes back before removing the worktree:
#   git -C "$OA_PUBLIC_REPO" worktree remove --force <new-worktree-dir>
#
# Exit 0 on success, 1 on a failure, 2 on bad usage.
set -uo pipefail

die() { echo "dev-overlay: $*" >&2; exit 1; }
[ "$#" -eq 1 ] || { echo "usage: dev-overlay.sh <new-worktree-dir>" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd) || die "cannot find the repo root"
PUBREPO=${OA_PUBLIC_REPO:-$HOME/code/open-artifacts}
DEST=$1
[ ! -e "$DEST" ] || die "$DEST already exists; pick a new directory"

pin_tag=$(sed -n 's/^tag=//p' "$ROOT/PUBLIC_PIN")
pin_sha=$(sed -n 's/^sha=//p' "$ROOT/PUBLIC_PIN")
[ -n "$pin_sha" ] || die "PUBLIC_PIN has no sha= line"
git -C "$PUBREPO" cat-file -e "$pin_sha^{commit}" 2> /dev/null \
  || die "$PUBREPO lacks $pin_sha ($pin_tag); fetch the tag there first: git -C $PUBREPO fetch origin tag $pin_tag"

git -C "$PUBREPO" worktree add --detach "$DEST" "$pin_sha" || die "git worktree add failed"
if ! "$ROOT/scripts/overlay.sh" "$DEST" "$ROOT"; then
  echo "dev-overlay: overlay failed; the worktree is left for inspection." >&2
  echo "dev-overlay: remove it with: git -C $PUBREPO worktree remove --force $DEST" >&2
  exit 1
fi
echo "dev-overlay: ready at $DEST. Next: cd $DEST && pnpm install --frozen-lockfile"
