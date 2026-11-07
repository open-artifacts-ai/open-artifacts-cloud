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
# Workflows never go live here: a listed .github/workflows/<file> lands in
# hosted-workflows/<file>, an inert directory GitHub does not run. Sync never
# writes anything under .github/workflows/. Some hosted workflows run on a
# schedule or on workflow_run, and must not start in this repo before the
# cut-over; the cut-over PR moves them into .github/workflows/ by hand.
#
# CLOUD owns the private paths after the first sync (README, "CLOUD owns the
# private paths"). So a later sync refuses to overwrite a listed path that
# differs here from public's copy at the SYNCED_FROM commit: that is a CLOUD
# change the sync would destroy. Port public's fix by hand instead (README,
# "Hand-porting a public fix"). The first sync, with no SYNCED_FROM, has
# nothing to protect.
#
# When the path list is public's, the sync also rewrites this repo's
# private-paths.txt from it, so the fallback list cannot go stale.
#
# Refuses: a dirty public checkout, a listed path public doesn't have, a list
# entry that is absolute, has "..", is a root-level file, is
# .github/workflows itself or is under hosted-workflows/, and (when
# <dest-dir> is a git checkout) uncommitted changes under a listed path.
#
# Exit 0 on success, 1 on a refusal, 2 on bad usage.
set -uo pipefail

die() { echo "sync: $*" >&2; exit 1; }
# Where a public path lands in this repo: workflows go to the inert dir.
WF=.github/workflows
INERT=hosted-workflows
dest_path() {
  case "$1" in
    "$WF"/*) printf '%s\n' "$INERT/${1#"$WF"/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}
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

paths=() dpaths=()
while IFS= read -r line || [ -n "$line" ]; do
  p=${line%%#*}
  p=$(printf '%s' "$p" | sed 's/[[:space:]]*$//; s/^[[:space:]]*//')
  [ -n "$p" ] || continue
  p=${p%/}
  case "$p" in
    /*) die "absolute path in list: $p" ;;
    .. | ../* | */.. | */../*) die "'..' in list entry: $p" ;;
    "$WF") die "list entry is $WF itself; list each hosted workflow file" ;;
    "$INERT" | "$INERT"/*) die "list entry under $INERT/ (sync writes that dir): $p" ;;
    */*) ;;
    *) die "root-level entry in list: $p (private ships no root files)" ;;
  esac
  paths+=("$p")
  dpaths+=("$(dest_path "$p")")
done < "$LIST"
[ "${#paths[@]}" -gt 0 ] || die "path list is empty"

if git -C "$DEST" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  pending=$(git -C "$DEST" status --porcelain -- "${dpaths[@]}") || die "git status failed in $DEST"
  [ -z "$pending" ] || die "uncommitted changes under listed paths in $DEST:
$pending"
fi

# --- CLOUD owns the private paths: refuse to destroy its changes ------------
if [ ! -e "$DEST/SYNCED_FROM" ] && [ ! -L "$DEST/SYNCED_FROM" ]; then
  # A first sync has nothing to protect only if no listed path is here yet.
  # Without SYNCED_FROM the clobber guard cannot tell CLOUD edits from a first
  # sync, so a tree that already holds listed paths is refused.
  held=$(for dp in "${dpaths[@]}"; do if [ -e "$DEST/$dp" ] || [ -L "$DEST/$dp" ]; then echo "$dp"; fi; done)
  [ -z "$held" ] || die "SYNCED_FROM is missing from $DEST but it already holds listed paths (a re-sync would destroy CLOUD edits):
$(printf '%s\n' "$held" | sed 's/^/  /')
Restore SYNCED_FROM (it is required once synced); never sync over an existing tree without it."
fi
if [ -e "$DEST/SYNCED_FROM" ] || [ -L "$DEST/SYNCED_FROM" ]; then
  old=$(sed -n 's/^sha=//p' "$DEST/SYNCED_FROM")
  printf '%s' "$old" | grep -Eq '^[0-9a-f]{40}$' || die "SYNCED_FROM in $DEST has no full sha: '$old'"
  git -C "$PUB" cat-file -e "$old^{commit}" 2> /dev/null || die "public checkout has no commit $old (the SYNCED_FROM of $DEST); fetch full history"
  exp=$(mktemp -d) || die "mktemp failed"
  trap 'rm -rf "$exp"' EXIT
  execs() { (cd "$1" && find . -type f -perm /111 -print | LC_ALL=C sort); }
  oldlist=$(git -C "$PUB" show "$old:scripts/ci/private-paths.txt" 2> /dev/null | tr -d '\r' | sed 's/#.*//; s/[[:space:]]*$//; s/^[[:space:]]*//; s|/$||' | grep -v '^$' || true)
  old_listed() { # dest path: was its public path in public's list at SYNCED_FROM?
    local j
    for j in "${!dpaths[@]}"; do
      [ "${dpaths[$j]}" = "$1" ] || continue
      printf '%s\n' "$oldlist" | grep -qxF -- "${paths[$j]}" && return 0
    done
    return 1
  }
  changed=()
  for i in "${!paths[@]}"; do
    p=${paths[$i]} dp=${dpaths[$i]}
    if [ -n "$(git -C "$PUB" ls-tree --name-only "$old" -- "$p")" ]; then
      git -C "$PUB" archive "$old" -- "$p" | tar -C "$exp" -xf - || die "cannot export $p at $old"
      if [ "$dp" != "$p" ]; then
        mkdir -p "$exp/$(dirname "$dp")" || die "cannot map $p"
        mv "$exp/$p" "$exp/$dp" || die "cannot map $p"
      fi
    fi
    if [ ! -e "$exp/$dp" ] && [ ! -L "$exp/$dp" ]; then
      # Public had nothing here at the old sync: anything here is CLOUD's.
      if [ -e "$DEST/$dp" ] || [ -L "$DEST/$dp" ]; then changed+=("$dp"); fi
    elif [ ! -e "$DEST/$dp" ] && [ ! -L "$DEST/$dp" ]; then
      changed+=("$dp")
    elif ! diff -rq --no-dereference -x node_modules -x .git "$exp/$dp" "$DEST/$dp" > /dev/null 2>&1; then
      changed+=("$dp")
    elif [ -d "$exp/$dp" ] && [ -n "$(comm -3 <(execs "$exp/$dp") <(execs "$DEST/$dp"))" ]; then
      changed+=("$dp")
    elif [ -f "$exp/$dp" ] && [ "$([ -x "$exp/$dp" ] && echo x)" != "$([ -x "$DEST/$dp" ] && echo x)" ]; then
      changed+=("$dp")
    fi
  done
  if [ "${#changed[@]}" -gt 0 ]; then
    echo "sync: these listed paths in $DEST differ from public's copy at SYNCED_FROM ($old):" >&2
    for c in "${changed[@]}"; do
      if [ ! -e "$DEST/$c" ] && [ ! -L "$DEST/$c" ] && ! old_listed "$c"; then
        echo "  $c (newly listed since SYNCED_FROM; this tree has none of it. Port it by hand.)" >&2
      else
        echo "  $c" >&2
      fi
    done
    die "refusing to overwrite CLOUD-owned changes. Hand-port the public fix instead (README, \"Hand-porting a public fix\")."
  fi
fi

files=$(mktemp) || die "mktemp failed"
trap 'rm -f "$files"; rm -rf "${exp:-}"' EXIT
for p in "${paths[@]}"; do
  n=$(git -C "$PUB" ls-files -- "$p" | tee -a "$files" | grep -c '')
  [ "$n" -gt 0 ] || die "public has no tracked files at $p ($src_sha)"
done

for p in "${dpaths[@]}"; do
  rm -rf "${DEST:?}/$p" || die "cannot clear $DEST/$p"
done
plain=$(mktemp) || die "mktemp failed"
trap 'rm -f "$files" "$plain"; rm -rf "${exp:-}"' EXIT
grep -v "^\\.github/workflows/" "$files" > "$plain"
if [ -s "$plain" ]; then
  tar -C "$PUB" -cf - -T "$plain" | tar -C "$DEST" -xf - || die "copy failed"
fi
while IFS= read -r f; do
  d=$(dest_path "$f")
  mkdir -p "$DEST/$(dirname "$d")" || die "cannot create $DEST/$(dirname "$d")"
  cp -P "$PUB/$f" "$DEST/$d" || die "copy failed: $f"
  echo "sync: $f -> $d (inert until the cut-over)"
done < <(grep "^\\.github/workflows/" "$files")

# The fallback list follows public's, so it cannot go stale (pin-check.sh
# compares them).
if [ "$list_name" != private-paths.txt ]; then
  {
    echo "# Paths that belong to this repo (#1056). Written by scripts/sync-from-public.sh"
    echo "# from public's scripts/ci/private-paths.txt at $src_sha. The overlay reads"
    echo "# public's list while the pinned tree has one and this file after public's"
    echo "# delete. One path per line, a directory or a file; no root-level files."
    printf '%s\n' "${paths[@]}"
  } > "$DEST/private-paths.txt" || die "cannot write private-paths.txt"
fi

{
  echo "# Written by scripts/sync-from-public.sh: the public commit the private"
  echo "# paths were last copied from."
  echo "sha=$src_sha"
  echo "tag=$src_tag"
  echo "list=$list_name"
} > "$DEST/SYNCED_FROM" || die "cannot write SYNCED_FROM"

echo "sync: $(grep -c '' "$files") file(s) in ${#paths[@]} path(s) from $src_sha ($src_tag) into $DEST"
