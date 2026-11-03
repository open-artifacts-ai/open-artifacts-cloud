#!/usr/bin/env bash
# overlay.sh <public-checkout-dir> <private-dir>
#
# Builds the hosted workspace: copies this private tree onto a public
# open-artifacts checkout, so both sides form one pnpm workspace and every
# relative path private code reads (server template, migrations, authz
# tables) holds.
#
# Rules (README.md, "Overlay rules"):
#   1. The public checkout's HEAD is exactly PUBLIC_PIN's sha, and its tracked
#      files are unmodified.
#   2. Nothing overwrites a public file. Any path collision fails the run
#      before a single file is copied.
#   3. The one allowed overwrite is pnpm-lock.yaml: the private merged
#      lockfile replaces public's, because public's has no private importers.
#   4. Private ships no root package.json, so VERSION and COMMIT stay the
#      public tag's.
#   5. This repo's own files never overlay: root-level files (README.md,
#      PUBLIC_PIN, SYNCED_FROM, private-paths.txt, ...), the tooling listed in
#      TOOLING below, .github/workflows/ci.yml (this repo's CI) and
#      hosted-workflows/ (inert copies of the hosted workflows, until the
#      cut-over). Any other file directly in scripts/ fails the run: it is
#      neither tooling nor a path public could hold.
#
# Exit 0 on success, 1 on a rule failure, 2 on bad usage.
set -uo pipefail

die() { echo "overlay: $*" >&2; exit 1; }
# This repo's tooling, directly in scripts/. Rule 5: it never overlays.
TOOLING=" overlay.sh sync-from-public.sh dev-overlay.sh overlay.test.sh ci-plan.sh ci-public-tests.sh "
[ "$#" -eq 2 ] || { echo "usage: overlay.sh <public-checkout-dir> <private-dir>" >&2; exit 2; }

PUB=$(cd "$1" 2> /dev/null && pwd) || die "public checkout not found: $1"
PRIV=$(cd "$2" 2> /dev/null && pwd) || die "private dir not found: $2"
[ "$PUB" != "$PRIV" ] || die "public and private dirs are the same"

# --- Rule 1: the pin --------------------------------------------------------
PIN_FILE="$PRIV/PUBLIC_PIN"
[ -f "$PIN_FILE" ] || die "missing $PIN_FILE"
pin_tag=$(sed -n 's/^tag=//p' "$PIN_FILE")
pin_sha=$(sed -n 's/^sha=//p' "$PIN_FILE")
[ -n "$pin_tag" ] || die "PUBLIC_PIN has no tag= line"
printf '%s' "$pin_sha" | grep -Eq '^[0-9a-f]{40}$' || die "PUBLIC_PIN sha is not a full 40-char sha: '$pin_sha'"

head_sha=$(git -C "$PUB" rev-parse --verify -q HEAD) || die "$PUB is not a git checkout"
[ "$head_sha" = "$pin_sha" ] || die "public HEAD is $head_sha, PUBLIC_PIN says $pin_sha ($pin_tag)"

# If the checkout knows the tag, it must point at the same commit.
if tag_sha=$(git -C "$PUB" rev-parse --verify -q "refs/tags/$pin_tag^{commit}"); then
  [ "$tag_sha" = "$pin_sha" ] || die "tag $pin_tag is $tag_sha in the public checkout, PUBLIC_PIN says $pin_sha"
fi

dirty=$(git -C "$PUB" status --porcelain --untracked-files=no) || die "git status failed in $PUB"
[ -z "$dirty" ] || die "public checkout has modified tracked files:
$dirty"

# --- Rule 4: no root package.json --------------------------------------------
[ ! -e "$PRIV/package.json" ] || die "private ships a root package.json; it must not (VERSION and COMMIT come from public's)"

# --- The private file list ---------------------------------------------------
list=$(mktemp) || die "mktemp failed"
trap 'rm -f "$list"' EXIT

if git -C "$PRIV" rev-parse --is-inside-work-tree > /dev/null 2>&1 \
  && [ "$(git -C "$PRIV" rev-parse --show-toplevel)" = "$PRIV" ]; then
  # Tracked plus untracked-but-not-ignored, so a dev overlay sees new files.
  git -C "$PRIV" ls-files -co --exclude-standard > "$list" || die "git ls-files failed in $PRIV"
else
  (cd "$PRIV" && find . -path ./.git -prune -o \( -type f -o -type l \) -print | sed 's|^\./||') > "$list" \
    || die "listing $PRIV failed"
fi

overlay=$(mktemp) || die "mktemp failed"
trap 'rm -f "$list" "$overlay"' EXIT
lock=no
strays=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  # git ls-files -co can list a tracked file deleted in the work tree.
  [ -e "$PRIV/$f" ] || [ -L "$PRIV/$f" ] || continue
  case "$f" in
    pnpm-lock.yaml) lock=yes; continue ;;   # Rule 3, handled below
    */*) ;;                                 # in a directory: a candidate
    *) continue ;;                          # Rule 5: root-level repo file
  esac
  case "$f" in
    .git/* | */.git/* | node_modules/* | */node_modules/*) continue ;;
    .github/workflows/ci.yml) continue ;;   # Rule 5: this repo's CI
    hosted-workflows/*) continue ;;         # Rule 5: inert until the cut-over
    scripts/*/*) ;;
    scripts/*)
      case "$TOOLING" in
        *" ${f#scripts/} "*) continue ;;    # Rule 5: this repo's tooling
      esac
      echo "overlay: unknown file directly in scripts/: $f (not in TOOLING)" >&2
      strays=$((strays + 1))
      continue
      ;;
  esac
  printf '%s\n' "$f" >> "$overlay"
done < "$list"
[ "$strays" -eq 0 ] || die "$strays unknown file(s) directly in scripts/; nothing was copied"

# --- Rule 2: collisions, all reported, before any copy -----------------------
collisions=0
while IFS= read -r f; do
  if [ -e "$PUB/$f" ] || [ -L "$PUB/$f" ]; then
    echo "overlay: collision: $f" >&2
    collisions=$((collisions + 1))
    continue
  fi
  # A public file where private needs a directory is also a collision.
  d=$(dirname "$f")
  while [ "$d" != "." ]; do
    if { [ -e "$PUB/$d" ] || [ -L "$PUB/$d" ]; } && [ ! -d "$PUB/$d" ]; then
      echo "overlay: collision: $d (a public file, private needs a directory for $f)" >&2
      collisions=$((collisions + 1))
      break
    fi
    d=$(dirname "$d")
  done
done < "$overlay"
[ "$collisions" -eq 0 ] || die "$collisions path collision(s); nothing was copied"

# --- Copy ---------------------------------------------------------------------
count=$(grep -c '' "$overlay")
if [ "$count" -gt 0 ]; then
  # -k (keep old files): tar itself refuses to overwrite, a second guard.
  tar -C "$PRIV" -cf - -T "$overlay" | tar -C "$PUB" -xkf - \
    || die "copy failed (partial overlay in $PUB: discard that checkout)"
fi

if [ "$lock" = yes ]; then
  cp "$PRIV/pnpm-lock.yaml" "$PUB/pnpm-lock.yaml" || die "copying pnpm-lock.yaml failed"
  echo "overlay: pnpm-lock.yaml: private merged lockfile replaced public's (the one allowed overwrite)"
else
  echo "overlay: no private pnpm-lock.yaml; public's stays"
fi
echo "overlay: $count private file(s) onto public $pin_tag ($pin_sha)"
