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

# The one allowlist: paths of the overlay tree that may differ from public@S.
# An entry ending in / is a directory prefix; any other entry is an exact path.
# Everything else this repo owns never reaches the overlay tree (root files,
# tooling, ci.yml and hosted-workflows/ are not overlaid), so it needs no entry.
# pnpm-lock.yaml is the one file that legitimately differs: the private merged
# lockfile carries private importers and their packages. It is not allowed
# blindly: check_lock below still requires every non-private importer to match
# public's byte for byte. The packages/snapshots sections are not compared:
# they follow from the importers and are pnpm's to resolve.
ALLOW=(
  pnpm-lock.yaml
)

die() { echo "equivalence: $*" >&2; exit 1; }
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { echo "usage: equivalence.sh <public-checkout-dir> [<private-dir>]" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd) || exit 2
PRIV=$(cd "${2:-$HERE/..}" 2> /dev/null && pwd) || die "private dir not found: ${2:-$HERE/..}"

if [ ! -e "$PRIV/SYNCED_FROM" ] && [ ! -L "$PRIV/SYNCED_FROM" ]; then
  echo "equivalence: SKIPPED: no SYNCED_FROM in $PRIV, so no sync has happened and this repo holds no private paths yet. The check runs once SYNCED_FROM exists."
  exit 0
fi
# Present but not a readable regular file: fail, never skip.
[ -f "$PRIV/SYNCED_FROM" ] && [ ! -L "$PRIV/SYNCED_FROM" ] && [ -r "$PRIV/SYNCED_FROM" ] \
  || die "SYNCED_FROM exists but is not a readable regular file"
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

# What the cut-over does: parked hosted workflows go live. A file whose
# target already exists (public's ci.yml, say) is a failure, not a difference.
if [ -L "$priv/hosted-workflows" ]; then die "hosted-workflows is a symlink"; fi
if [ -d "$priv/hosted-workflows" ]; then
  mkdir -p "$work/.github/workflows" || exit 2
  while IFS= read -r -d '' f; do
    f=${f#./}
    if [ -e "$work/.github/workflows/$f" ] || [ -L "$work/.github/workflows/$f" ]; then
      die "hosted-workflows/$f would overwrite .github/workflows/$f"
    fi
    mkdir -p "$work/.github/workflows/$(dirname "$f")" || exit 2
    cp -P -p "$priv/hosted-workflows/$f" "$work/.github/workflows/$f" || die "cannot move hosted-workflows/$f"
  done < <(cd "$priv/hosted-workflows" && find . \( -type f -o -type l \) -print0)
fi

# The private path list the overlay used (public's at S, else this repo's).
if [ -f "$ref/scripts/ci/private-paths.txt" ]; then plist="$ref/scripts/ci/private-paths.txt"; else plist="$priv/private-paths.txt"; fi
private=()
while IFS= read -r line || [ -n "$line" ]; do
  q=${line%%#*}
  q=$(printf '%s' "$q" | sed 's/[[:space:]]*$//; s/^[[:space:]]*//')
  [ -n "$q" ] && private+=("${q%/}")
done < "$plist"

is_private() { # importer key
  local q
  for q in "${private[@]}"; do
    [ "$1" = "$q" ] && return 0
    [[ "$1" == "$q"/* ]] && return 0
  done
  return 1
}
# "key<TAB>body" per importer of a pnpm-lock.yaml, private importers dropped.
importers() { # lockfile
  awk '
    /^importers:/ { on = 1; next }
    on && /^[^ #]/ { on = 0 }
    on && /^[ \t]*$/ { next }
    on && /^  [^ #]/ { k = $0; sub(/^  /, "", k); sub(/:[ \t]*$/, "", k); gsub(/"/, "", k); gsub(/\047/, "", k); cur = k; order[++n] = k; next }
    on && cur != "" { body[cur] = body[cur] "\001" $0 }
    END { for (i = 1; i <= n; i++) printf "%s\t%s\n", order[i], body[order[i]] }
  ' "$1" | LC_ALL=C sort | while IFS=$'\t' read -r k b; do
    is_private "$k" || printf '%s\t%s\n' "$k" "$b"
  done
}
check_lock() {
  if [ ! -f "$ref/pnpm-lock.yaml" ] || [ ! -f "$work/pnpm-lock.yaml" ]; then
    echo "equivalence: DIFF: pnpm-lock.yaml (exists on only one side)" >&2
    return 1
  fi
  local d
  d=$(diff <(importers "$ref/pnpm-lock.yaml") <(importers "$work/pnpm-lock.yaml") | cut -f1)
  [ -z "$d" ] && return 0
  echo "equivalence: DIFF: pnpm-lock.yaml: a non-private importer differs from public's:" >&2
  printf '%s\n' "$d" | sed 's/^/  /' >&2
  return 1
}

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
  if allowed "$path"; then
    if [ "$path" = pnpm-lock.yaml ]; then check_lock || bad=$((bad + 1)); fi
    continue
  fi
  echo "equivalence: DIFF: $path ($kind)" >&2
  bad=$((bad + 1))
done <<< "$diffs"

# diff -rq ignores permissions: compare the executable bit.
execs() { (cd "$1" && find . -path ./.git -prune -o -type f -perm /111 -print | sed 's|^\./||' | LC_ALL=C sort); }
while IFS= read -r path; do
  [ -n "$path" ] || continue
  # Only paths in both trees: others are reported above.
  [ -f "$ref/$path" ] && [ -f "$work/$path" ] || continue
  echo "equivalence: DIFF: $path (executable bit differs)" >&2
  bad=$((bad + 1))
done < <(comm -3 <(execs "$ref") <(execs "$work") | sed 's/^[[:space:]]*//')

if [ "$bad" -gt 0 ]; then
  die "$bad difference(s) outside the allowlist between overlay and public $tag ($sha)"
fi
echo "equivalence: OK: overlay(public@$sha minus private paths, this repo) matches public ($seen allowlisted difference(s))"
