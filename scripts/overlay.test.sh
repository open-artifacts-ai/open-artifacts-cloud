#!/usr/bin/env bash
# Tests for overlay.sh and sync-from-public.sh, on throwaway git repos.
# Run: scripts/overlay.test.sh. Exit 0 only if every case passed.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OVERLAY="$HERE/overlay.sh"
SYNC="$HERE/sync-from-public.sh"
T=$(mktemp -d) || exit 2
trap 'rm -rf "$T"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
G() { git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }

pass=0 fail=0
ok() { echo "ok   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1" >&2; fail=$((fail + 1)); }
expect_exit() { # name want cmd...
  local name=$1 want=$2; shift 2
  "$@" > "$T/out" 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then ok "$name"; else bad "$name (exit $got, want $want)"; cat "$T/out" >&2; fi
}

# A fake public repo, tagged v1.
mkpub() { # dir
  mkdir -p "$1/apps/server" "$1/.github/workflows" "$1/scripts/ci" "$1/apps/hosted/src"
  echo '{"name":"root"}' > "$1/package.json"
  echo 'public-lock' > "$1/pnpm-lock.yaml"
  echo 'public readme' > "$1/README.md"
  echo 'server' > "$1/apps/server/index.ts"
  echo 'public ci' > "$1/.github/workflows/ci.yml"
  echo 'pub' > "$1/scripts/ci/public.sh"
  echo 'hosted' > "$1/apps/hosted/src/index.ts"
  echo 'file' > "$1/apps/afile"
  printf 'apps/hosted\nscripts/ci/public.sh\n' > "$1/list.txt"
  G -C "$1" init -q && G -C "$1" add -A && G -C "$1" commit -qm init && G -C "$1" tag v1
}
# A fake private tree pinned to public's HEAD.
mkpriv() { # dir pubdir
  mkdir -p "$1/apps/admin/src" "$1/.github/workflows" "$1/scripts"
  printf 'tag=v1\nsha=%s\n' "$(git -C "$2" rev-parse HEAD)" > "$1/PUBLIC_PIN"
  echo 'private readme' > "$1/README.md"
  echo 'private ci' > "$1/.github/workflows/ci.yml"
  echo 'hosted wf' > "$1/.github/workflows/hosted.yml"
  echo 'tool' > "$1/scripts/overlay.sh"
  echo 'admin' > "$1/apps/admin/src/index.ts"
  echo 'merged-lock' > "$1/pnpm-lock.yaml"
}

# --- overlay: the happy path ---------------------------------------------------
mkpub "$T/p1"; mkpriv "$T/v1" "$T/p1"
expect_exit "overlay succeeds on a clean pinned checkout" 0 "$OVERLAY" "$T/p1" "$T/v1"
[ "$(cat "$T/p1/apps/admin/src/index.ts" 2> /dev/null)" = admin ] && ok "private file overlaid" || bad "private file overlaid"
[ "$(cat "$T/p1/.github/workflows/hosted.yml" 2> /dev/null)" = "hosted wf" ] && ok "private workflow overlaid" || bad "private workflow overlaid"
[ "$(cat "$T/p1/pnpm-lock.yaml")" = merged-lock ] && ok "lockfile is the one overwrite" || bad "lockfile is the one overwrite"
[ "$(cat "$T/p1/README.md")" = "public readme" ] && ok "root files never overlay" || bad "root files never overlay"
[ "$(cat "$T/p1/.github/workflows/ci.yml")" = "public ci" ] && ok "this repo's ci.yml never overlays" || bad "this repo's ci.yml never overlays"
[ ! -e "$T/p1/scripts/overlay.sh" ] && ok "scripts/ tooling never overlays" || bad "scripts/ tooling never overlays"
[ ! -e "$T/p1/PUBLIC_PIN" ] && ok "PUBLIC_PIN never overlays" || bad "PUBLIC_PIN never overlays"

# --- overlay: refusals -----------------------------------------------------------
mkpub "$T/p2"; mkpriv "$T/v2" "$T/p2"
mkdir -p "$T/v2/apps/server"; echo 'shadow' > "$T/v2/apps/server/index.ts"
expect_exit "collision fails" 1 "$OVERLAY" "$T/p2" "$T/v2"
grep -q 'collision: apps/server/index.ts' "$T/out" && ok "collision is named" || bad "collision is named"
[ ! -e "$T/p2/apps/admin/src/index.ts" ] && ok "nothing copied on collision" || bad "nothing copied on collision"
[ "$(cat "$T/p2/apps/server/index.ts")" = server ] && ok "public file untouched on collision" || bad "public file untouched on collision"

mkpub "$T/p3"; mkpriv "$T/v3" "$T/p3"
mkdir -p "$T/v3/apps/afile"; echo x > "$T/v3/apps/afile/y.ts"
expect_exit "file-vs-directory collision fails" 1 "$OVERLAY" "$T/p3" "$T/v3"

mkpub "$T/p4"; mkpriv "$T/v4" "$T/p4"
printf 'tag=v1\nsha=%s\n' 0123456789abcdef0123456789abcdef01234567 > "$T/v4/PUBLIC_PIN"
expect_exit "pin mismatch fails" 1 "$OVERLAY" "$T/p4" "$T/v4"

mkpub "$T/p5"; mkpriv "$T/v5" "$T/p5"
echo '{}' > "$T/v5/package.json"
expect_exit "root package.json fails" 1 "$OVERLAY" "$T/p5" "$T/v5"

mkpub "$T/p6"; mkpriv "$T/v6" "$T/p6"
echo 'edited' > "$T/p6/apps/server/index.ts"
expect_exit "modified public checkout fails" 1 "$OVERLAY" "$T/p6" "$T/v6"

mkpub "$T/p7"; mkpriv "$T/v7" "$T/p7"
echo x > "$T/p7/new.txt"; G -C "$T/p7" add -A; G -C "$T/p7" commit -qm more
G -C "$T/p7" checkout -q v1
G -C "$T/p7" tag -f v1 "$(git -C "$T/p7" rev-parse HEAD@{1})" > /dev/null 2>&1
expect_exit "moved tag fails" 1 "$OVERLAY" "$T/p7" "$T/v7"

expect_exit "bad usage exits 2" 2 "$OVERLAY" "$T/p1"

# --- sync ------------------------------------------------------------------------
mkpub "$T/s1"
mkdir -p "$T/d1/scripts"; cp "$SYNC" "$T/d1/scripts/"; cp "$T/s1/list.txt" "$T/d1/private-paths.txt"
mkdir -p "$T/d1/apps/hosted"; echo stale > "$T/d1/apps/hosted/stale.ts"
expect_exit "sync succeeds" 0 "$T/d1/scripts/sync-from-public.sh" "$T/s1"
[ "$(cat "$T/d1/apps/hosted/src/index.ts" 2> /dev/null)" = hosted ] && ok "sync copies a listed dir" || bad "sync copies a listed dir"
[ ! -e "$T/d1/apps/hosted/stale.ts" ] && ok "sync mirrors (stale file removed)" || bad "sync mirrors (stale file removed)"
[ ! -e "$T/d1/apps/server/index.ts" ] && ok "sync copies only listed paths" || bad "sync copies only listed paths"
grep -qx "sha=$(git -C "$T/s1" rev-parse HEAD)" "$T/d1/SYNCED_FROM" && ok "SYNCED_FROM records the sha" || bad "SYNCED_FROM records the sha"
grep -qx "tag=v1" "$T/d1/SYNCED_FROM" && ok "SYNCED_FROM records the tag" || bad "SYNCED_FROM records the tag"

mkdir -p "$T/s1/scripts/ci"; printf 'apps/hosted\n' > "$T/s1/scripts/ci/private-paths.txt"
G -C "$T/s1" add -A; G -C "$T/s1" commit -qm list
expect_exit "sync prefers public's list" 0 "$T/d1/scripts/sync-from-public.sh" "$T/s1" "$T/d1b"
grep -qx "list=public:scripts/ci/private-paths.txt" "$T/d1b/SYNCED_FROM" && ok "public list recorded" || bad "public list recorded"

mkpub "$T/s2"
mkdir -p "$T/d2/scripts"; cp "$SYNC" "$T/d2/scripts/"; printf 'package.json\n' > "$T/d2/private-paths.txt"
expect_exit "sync refuses a root-level entry" 1 "$T/d2/scripts/sync-from-public.sh" "$T/s2"
printf 'apps/missing\n' > "$T/d2/private-paths.txt"
expect_exit "sync refuses a path public lacks" 1 "$T/d2/scripts/sync-from-public.sh" "$T/s2"
printf 'apps/../package.json\n' > "$T/d2/private-paths.txt"
expect_exit "sync refuses '..'" 1 "$T/d2/scripts/sync-from-public.sh" "$T/s2"
printf 'apps/hosted\n' > "$T/d2/private-paths.txt"
echo dirty > "$T/s2/apps/hosted/src/index.ts"
expect_exit "sync refuses a dirty public checkout" 1 "$T/d2/scripts/sync-from-public.sh" "$T/s2"

echo "overlay tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
