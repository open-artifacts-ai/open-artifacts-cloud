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
check() { # name cmd...
  local name=$1; shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}
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
check "private file overlaid" [ "$(cat "$T/p1/apps/admin/src/index.ts" 2> /dev/null)" = admin ]
check "private workflow overlaid" [ "$(cat "$T/p1/.github/workflows/hosted.yml" 2> /dev/null)" = "hosted wf" ]
check "lockfile is the one overwrite" [ "$(cat "$T/p1/pnpm-lock.yaml")" = merged-lock ]
check "root files never overlay" [ "$(cat "$T/p1/README.md")" = "public readme" ]
check "this repo's ci.yml never overlays" [ "$(cat "$T/p1/.github/workflows/ci.yml")" = "public ci" ]
check "scripts/ tooling never overlays" [ ! -e "$T/p1/scripts/overlay.sh" ]
check "PUBLIC_PIN never overlays" [ ! -e "$T/p1/PUBLIC_PIN" ]

# --- overlay: refusals -----------------------------------------------------------
mkpub "$T/p2"; mkpriv "$T/v2" "$T/p2"
mkdir -p "$T/v2/apps/server"; echo 'shadow' > "$T/v2/apps/server/index.ts"
expect_exit "collision fails" 1 "$OVERLAY" "$T/p2" "$T/v2"
check "collision is named" grep -q 'collision: apps/server/index.ts' "$T/out"
check "nothing copied on collision" [ ! -e "$T/p2/apps/admin/src/index.ts" ]
check "public file untouched on collision" [ "$(cat "$T/p2/apps/server/index.ts")" = server ]

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
G -C "$T/p7" tag -f v1 "$(git -C "$T/p7" rev-parse "HEAD@{1}")" > /dev/null 2>&1
expect_exit "moved tag fails" 1 "$OVERLAY" "$T/p7" "$T/v7"

expect_exit "bad usage exits 2" 2 "$OVERLAY" "$T/p1"

# --- sync ------------------------------------------------------------------------
mkpub "$T/s1"
mkdir -p "$T/d1/scripts"; cp "$SYNC" "$T/d1/scripts/"; cp "$T/s1/list.txt" "$T/d1/private-paths.txt"
mkdir -p "$T/d1/apps/hosted"; echo stale > "$T/d1/apps/hosted/stale.ts"
expect_exit "sync succeeds" 0 "$T/d1/scripts/sync-from-public.sh" "$T/s1"
check "sync copies a listed dir" [ "$(cat "$T/d1/apps/hosted/src/index.ts" 2> /dev/null)" = hosted ]
check "sync mirrors (stale file removed)" [ ! -e "$T/d1/apps/hosted/stale.ts" ]
check "sync copies only listed paths" [ ! -e "$T/d1/apps/server/index.ts" ]
check "SYNCED_FROM records the sha" grep -qx "sha=$(git -C "$T/s1" rev-parse HEAD)" "$T/d1/SYNCED_FROM"
check "SYNCED_FROM records the tag" grep -qx "tag=v1" "$T/d1/SYNCED_FROM"

mkdir -p "$T/s1/scripts/ci"; printf 'apps/hosted\n' > "$T/s1/scripts/ci/private-paths.txt"
G -C "$T/s1" add -A; G -C "$T/s1" commit -qm list
expect_exit "sync prefers public's list" 0 "$T/d1/scripts/sync-from-public.sh" "$T/s1" "$T/d1b"
check "public list recorded" grep -qx "list=public:scripts/ci/private-paths.txt" "$T/d1b/SYNCED_FROM"

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
G -C "$T/s2" checkout -q -- .
printf '/abs/path\n' > "$T/d2/private-paths.txt"
expect_exit "sync refuses an absolute-path entry" 1 "$T/d2/scripts/sync-from-public.sh" "$T/s2"
check "absolute entry is named" grep -q 'absolute path in list: /abs/path' "$T/out"
printf '.github/workflows\n' > "$T/d2/private-paths.txt"
expect_exit "sync refuses .github/workflows as a whole" 1 "$T/d2/scripts/sync-from-public.sh" "$T/s2"
printf 'hosted-workflows/x.yml\n' > "$T/d2/private-paths.txt"
expect_exit "sync refuses an entry under hosted-workflows/" 1 "$T/d2/scripts/sync-from-public.sh" "$T/s2"

# sync into a git dest with uncommitted changes under a listed path.
mkpub "$T/s3"
mkdir -p "$T/d3/scripts" "$T/d3/apps/hosted/src"; cp "$SYNC" "$T/d3/scripts/"
printf 'apps/hosted\n' > "$T/d3/private-paths.txt"
echo 'committed' > "$T/d3/apps/hosted/src/index.ts"
G -C "$T/d3" init -q && G -C "$T/d3" add -A && G -C "$T/d3" commit -qm init
echo 'local edit' > "$T/d3/apps/hosted/src/index.ts"
expect_exit "sync refuses uncommitted changes in dest" 1 "$T/d3/scripts/sync-from-public.sh" "$T/s3"
check "uncommitted change is named" grep -q 'apps/hosted/src/index.ts' "$T/out"
check "dest edit survives the refusal" [ "$(cat "$T/d3/apps/hosted/src/index.ts")" = 'local edit' ]

# --- sync: workflows land in the inert dir, never in .github/workflows/ ------
mkpub "$T/s4"
mkdir -p "$T/s4/.github/hosted"
echo 'on: schedule' > "$T/s4/.github/workflows/nightly.yml"
echo 'on: workflow_run' > "$T/s4/.github/workflows/publish.yml"
echo 'const' > "$T/s4/.github/hosted/constants.sh"
G -C "$T/s4" add -A; G -C "$T/s4" commit -qm workflows
mkdir -p "$T/d4/scripts" "$T/d4/.github/workflows" "$T/d4/hosted-workflows"
cp "$SYNC" "$T/d4/scripts/"
printf 'apps/hosted\n.github/hosted\n.github/workflows/nightly.yml\n.github/workflows/publish.yml\n' > "$T/d4/private-paths.txt"
echo 'private ci' > "$T/d4/.github/workflows/ci.yml"
echo 'stale' > "$T/d4/hosted-workflows/nightly.yml"
wf_snapshot() { (cd "$T/d4/.github/workflows" && find . -print0 | sort -z | xargs -0 sha256sum 2> /dev/null; find . | sort); }
wf_before=$(wf_snapshot)
expect_exit "sync with workflow entries succeeds" 0 "$T/d4/scripts/sync-from-public.sh" "$T/s4"
check "sync never writes under .github/workflows/" [ "$(wf_snapshot)" = "$wf_before" ]
check "nightly.yml not in .github/workflows/" [ ! -e "$T/d4/.github/workflows/nightly.yml" ]
check "publish.yml not in .github/workflows/" [ ! -e "$T/d4/.github/workflows/publish.yml" ]
check "workflow lands in hosted-workflows/" [ "$(cat "$T/d4/hosted-workflows/nightly.yml" 2> /dev/null)" = 'on: schedule' ]
check "second workflow lands in hosted-workflows/" [ "$(cat "$T/d4/hosted-workflows/publish.yml" 2> /dev/null)" = 'on: workflow_run' ]
check "other .github paths still copy" [ "$(cat "$T/d4/.github/hosted/constants.sh" 2> /dev/null)" = const ]

# --- overlay: more refusals and rule 5 -------------------------------------------
mkpub "$T/p8"; mkpriv "$T/v8" "$T/p8"
expect_exit "overlay refuses the same dir as public and private" 1 "$OVERLAY" "$T/p8" "$T/p8"
check "same-dir refusal is named" grep -q 'public and private dirs are the same' "$T/out"

mkpub "$T/p9"; mkpriv "$T/v9" "$T/p9"
echo 'stray' > "$T/v9/scripts/stray.sh"
expect_exit "unknown file directly in scripts/ fails" 1 "$OVERLAY" "$T/p9" "$T/v9"
check "stray is named" grep -q 'unknown file directly in scripts/: scripts/stray.sh' "$T/out"
check "nothing copied on a stray" [ ! -e "$T/p9/apps/admin/src/index.ts" ]

mkpub "$T/p10"; mkpriv "$T/v10" "$T/p10"
for t in sync-from-public.sh dev-overlay.sh overlay.test.sh ci-plan.sh ci-public-tests.sh; do echo tool > "$T/v10/scripts/$t"; done
mkdir -p "$T/v10/hosted-workflows"; echo 'on: schedule' > "$T/v10/hosted-workflows/nightly.yml"
expect_exit "overlay skips every listed tool" 0 "$OVERLAY" "$T/p10" "$T/v10"
check "no tooling overlaid" [ "$(find "$T/p10/scripts" -mindepth 1 -maxdepth 1 ! -name ci | wc -l)" -eq 0 ]
check "hosted-workflows/ never overlays" [ ! -e "$T/p10/hosted-workflows" ]

# The tar -k second guard: a copy of overlay.sh with the collision precheck
# removed must still refuse to overwrite a public file.
mkpub "$T/p11"; mkpriv "$T/v11" "$T/p11"
mkdir -p "$T/v11/apps/server"; echo 'shadow' > "$T/v11/apps/server/index.ts"
mkdir -p "$T/nocheck"
# shellcheck disable=SC2016 # a literal $ in the sed pattern
sed 's/^\[ "\$collisions" -eq 0 \] || die .*$/: precheck removed for the test/' "$OVERLAY" > "$T/nocheck/overlay.sh"
chmod +x "$T/nocheck/overlay.sh"
check "precheck bypass applied" grep -q '^: precheck removed for the test' "$T/nocheck/overlay.sh"
expect_exit "tar -k refuses an overwrite without the precheck" 1 "$T/nocheck/overlay.sh" "$T/p11" "$T/v11"
check "tar -k failure is reported" grep -q 'copy failed' "$T/out"
check "public file untouched by tar -k" [ "$(cat "$T/p11/apps/server/index.ts")" = server ]

# --- ci-plan ---------------------------------------------------------------------
PLAN="$HERE/ci-plan.sh"
# An overlay with public packages; a private tree with a package and tests.
mkplan() { # ovl priv
  mkdir -p "$1/apps/server" "$1/apps/auth-broker" "$1/apps/admin"
  echo '{"name":"server"}' > "$1/apps/server/package.json"
  echo '{"name":"auth-broker"}' > "$1/apps/auth-broker/package.json"
  mkdir -p "$2/apps/admin/test" "$2/apps/server/test/node" "$2/apps/auth-broker/test/node" "$2/scripts/ci" "$2/scripts/ops/testdata"
  echo '{"name":"admin","scripts":{"test":"vitest run","typecheck":"tsc"}}' > "$2/apps/admin/package.json"
  cp "$2/apps/admin/package.json" "$1/apps/admin/package.json"
  echo t > "$2/apps/admin/test/own.test.ts"
  echo t > "$2/apps/server/test/node/mcp-sdk-iserror.test.ts"
  echo t > "$2/apps/auth-broker/test/platform-ticket.test.ts"
  echo t > "$2/apps/auth-broker/test/node/config.test.ts"
  echo t > "$2/scripts/ci/hosted-release.test.ts"
  echo t > "$2/scripts/ops/platform-db.test.ts"
  G -C "$2" init -q && G -C "$2" add -A && G -C "$2" commit -qm init
}
mkplan "$T/o1" "$T/q1"
expect_exit "ci-plan succeeds" 0 "$PLAN" "$T/o1" "$T/q1" "$T/plan1"
check "plan lists the private package" [ "$(cat "$T/plan1/packages.txt")" = apps/admin ]
check "plan: root tests" [ "$(sort "$T/plan1/root-tests.txt" | tr '\n' ' ')" = "scripts/ci/hosted-release.test.ts scripts/ops/platform-db.test.ts " ]
check "plan: server test runs in its public package" grep -qxP 'apps/server\ttest/node/mcp-sdk-iserror.test.ts' "$T/plan1/public-tests.txt"
check "plan: auth-broker workerd test" grep -qxP 'apps/auth-broker\ttest/platform-ticket.test.ts' "$T/plan1/public-tests.txt"
check "plan: auth-broker node test" grep -qxP 'apps/auth-broker\ttest/node/config.test.ts' "$T/plan1/public-tests.txt"
check "plan: exactly three public-package tests" [ "$(grep -c '' "$T/plan1/public-tests.txt")" -eq 3 ]
check "plan: a private package's own test is not repeated" bash -c "! grep -q own.test.ts '$T/plan1/public-tests.txt'"

mkplan "$T/o2" "$T/q2"
mkdir -p "$T/q2/scripts/ci/sub" "$T/q2/apps/nopkg"
echo t > "$T/q2/scripts/ci/sub/deep.test.ts"; echo t > "$T/q2/apps/nopkg/x.test.ts"
G -C "$T/q2" add -A; G -C "$T/q2" commit -qm orphans
expect_exit "ci-plan fails on tests with no owning package" 1 "$PLAN" "$T/o2" "$T/q2" "$T/plan2"
check "orphan in scripts/ci/sub is named" grep -q 'no owning package for scripts/ci/sub/deep.test.ts' "$T/out"
check "orphan in apps/nopkg is named" grep -q 'no owning package for apps/nopkg/x.test.ts' "$T/out"

mkplan "$T/o3" "$T/q3"
mkdir -p "$T/q3/apps/scheduler"; echo '{"name":"s","scripts":{"test":"vitest run"}}' > "$T/q3/apps/scheduler/package.json"
mkdir -p "$T/q3/apps/dispatch"; echo '{"name":"d","scripts":{"typecheck":"tsc"}}' > "$T/q3/apps/dispatch/package.json"
G -C "$T/q3" add -A; G -C "$T/q3" commit -qm partial
expect_exit "ci-plan fails on packages missing test or typecheck" 1 "$PLAN" "$T/o3" "$T/q3" "$T/plan3"
check "missing typecheck is named" grep -q 'apps/scheduler has no script: typecheck' "$T/out"
check "missing test is named" grep -q 'apps/dispatch has no script: test' "$T/out"

mkdir -p "$T/o4" "$T/q4"; echo x > "$T/q4/README.md"
G -C "$T/q4" init -q && G -C "$T/q4" add -A && G -C "$T/q4" commit -qm empty
expect_exit "ci-plan passes an empty tree before the sync" 0 "$PLAN" "$T/o4" "$T/q4" "$T/plan4"
echo 'sha=x' > "$T/q4/SYNCED_FROM"
expect_exit "ci-plan fails an empty tree after the sync" 1 "$PLAN" "$T/o4" "$T/q4" "$T/plan4"

expect_exit "ci-public-tests with no tests passes" 0 "$HERE/ci-public-tests.sh" "$T/o4" "$T/plan4"
expect_exit "ci-public-tests without a plan fails" 1 "$HERE/ci-public-tests.sh" "$T/o4" "$T/nonexistent-plan"

echo "overlay tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
