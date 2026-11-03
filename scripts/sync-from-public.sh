#!/usr/bin/env bash
# sync-from-public.sh <public-checkout-dir> [<dest-dir>]
#
# Copies the private paths from a public open-artifacts checkout into this
# repo (or <dest-dir>), and records the source commit in SYNCED_FROM. This is
# the copy step of #1056: hosted code is frozen in public from the copy until
# the public delete.
#
# The path list is the public checkout's scripts/ci/private-paths.txt when it
# has one, else this repo's private-paths.txt (the interim copy).
#
# Each listed path is mirrored: its old copy in <dest-dir> is removed, then
# public's tracked files under it are copied. Only tracked files are copied,
# never node_modules or build output.
#
# Refuses: a dirty public checkout, a listed path public doesn't have, a list
# entry that is absolute, has "..", or is a root-level file, and (when
# <dest-dir> is a git checkout) uncommitted changes under a listed path.
#
# Exit 0 on success, 1 on a refusal, 2 on bad usage.
set -uo pipefail

die() { echo "sync: $*" >&2; exit 1; }
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: sync-from-public.sh <public-checkout-dir> [<dest-dir>]" >&2
  exit 2
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd) || die "cannot find the repo root"
PUB=$(cd "$1" 2> /dev/null && pwd) || die "public checkout not found: $1"
DEST=${2:-$ROOT}
mkdir -p "$DEST" || die "cannot create $DEST"
DEST=$(cd "$DEST" && pwd) || die "dest not found: $DEST"
[ "$PUB" != "$DEST" ] || die "public and dest dirs are the same"

src_sha=$(git -C "$PUB" rev-parse --verify -q HEAD) || die "$PUB is not a git checkout"
src_tag=$(git -C "$PUB" describe --tags --exact-match HEAD 2> /dev/null) || src_tag=none
dirty=$(git -C "$PUB" status --porcelain --untracked-files=no) || die "git status failed in $PUB"
[ -z "$dirty" ] || die "public checkout has modified tracked files:
$dirty"

if [ -f "$PUB/scripts/ci/private-paths.txt" ]; then
  LIST="$PUB/scripts/ci/private-paths.txt"
  list_name="public:scripts/ci/private-paths.txt"
else
  LIST="$ROOT/private-paths.txt"
  list_name="private-paths.txt"
fi
[ -f "$LIST" ] || die "no path list: $LIST"
echo "sync: path list $list_name"

paths=()
while IFS= read -r line || [ -n "$line" ]; do
  p=${line%%#*}
  p=$(printf '%s' "$p" | sed 's/[[:space:]]*$//; s/^[[:space:]]*//')
  [ -n "$p" ] || continue
  p=${p%/}
  case "$p" in
    /*) die "absolute path in list: $p" ;;
    .. | ../* | */.. | */../*) die "'..' in list entry: $p" ;;
    */*) ;;
    *) die "root-level entry in list: $p (private ships no root files)" ;;
  esac
  paths+=("$p")
done < "$LIST"
[ "${#paths[@]}" -gt 0 ] || die "path list is empty"

if git -C "$DEST" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  pending=$(git -C "$DEST" status --porcelain -- "${paths[@]}") || die "git status failed in $DEST"
  [ -z "$pending" ] || die "uncommitted changes under listed paths in $DEST:
$pending"
fi

files=$(mktemp) || die "mktemp failed"
trap 'rm -f "$files"' EXIT
for p in "${paths[@]}"; do
  n=$(git -C "$PUB" ls-files -- "$p" | tee -a "$files" | grep -c '')
  [ "$n" -gt 0 ] || die "public has no tracked files at $p ($src_sha)"
done

for p in "${paths[@]}"; do
  rm -rf "${DEST:?}/$p" || die "cannot clear $DEST/$p"
done
tar -C "$PUB" -cf - -T "$files" | tar -C "$DEST" -xf - || die "copy failed"

{
  echo "# Written by scripts/sync-from-public.sh: the public commit the private"
  echo "# paths were last copied from."
  echo "sha=$src_sha"
  echo "tag=$src_tag"
  echo "list=$list_name"
} > "$DEST/SYNCED_FROM" || die "cannot write SYNCED_FROM"

echo "sync: $(grep -c '' "$files") file(s) in ${#paths[@]} path(s) from $src_sha ($src_tag) into $DEST"
