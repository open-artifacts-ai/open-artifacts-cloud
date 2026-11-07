#!/usr/bin/env bash
# Tests for overlay.sh and sync-from-public.sh, on throwaway git repos.
# Run: scripts/overlay.test.sh. Exit 0 only if every case passed.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OVERLAY="$HERE/overlay.sh"
SYNC="$HERE/sync-from-public.sh"
EQUIV="$HERE/equivalence.sh"
PLACE="$HERE/place-workflows.sh"
PINCHK="$HERE/pin-check.sh"
LISTED="$HERE/listed-present.sh"
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
nogrep() { ! grep -q "$@"; }
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
  mkdir -p "$1/.github/actions/overlay"; echo 'action' > "$1/.github/actions/overlay/action.yml"
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
check "this repo's .github/actions never overlay" [ ! -e "$T/p1/.github/actions" ]
check "scripts/ tooling never overlays" [ ! -e "$T/p1/scripts/overlay.sh" ]
check "PUBLIC_PIN never overlays" [ ! -e "$T/p1/PUBLIC_PIN" ]

# The blocker issue template is repo-only GitHub config: it never collides.
mkpub "$T/pb"; mkpriv "$T/vb" "$T/pb"
mkdir -p "$T/pb/.github/ISSUE_TEMPLATE" "$T/vb/.github/ISSUE_TEMPLATE"
echo 'name: Blocker' > "$T/pb/.github/ISSUE_TEMPLATE/blocker.yml"; echo 'name: Blocker' > "$T/vb/.github/ISSUE_TEMPLATE/blocker.yml"
G -C "$T/pb" add -A; G -C "$T/pb" commit -qm tmpl; G -C "$T/pb" tag -f v1 > /dev/null
printf 'tag=v1\nsha=%s\n' "$(git -C "$T/pb" rev-parse HEAD)" > "$T/vb/PUBLIC_PIN"
expect_exit "a cloud blocker.yml does not collide with public's" 0 "$OVERLAY" "$T/pb" "$T/vb"
mkpub "$T/pc"; mkpriv "$T/vc" "$T/pc"
mkdir -p "$T/vc/.github/ISSUE_TEMPLATE"; echo 'name: Other' > "$T/vc/.github/ISSUE_TEMPLATE/other.yml"
mkdir -p "$T/pc/.github/ISSUE_TEMPLATE"; echo 'name: Other' > "$T/pc/.github/ISSUE_TEMPLATE/other.yml"
G -C "$T/pc" add -A; G -C "$T/pc" commit -qm other; G -C "$T/pc" tag -f v1 > /dev/null
printf 'tag=v1\nsha=%s\n' "$(git -C "$T/pc" rev-parse HEAD)" > "$T/vc/PUBLIC_PIN"
expect_exit "any other ISSUE_TEMPLATE file still collides" 1 "$OVERLAY" "$T/pc" "$T/vc"

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
expect_exit "sync refuses a tree that holds listed paths but has no SYNCED_FROM" 1 "$T/d1/scripts/sync-from-public.sh" "$T/s1"
check "that refusal names the missing SYNCED_FROM" grep -q 'SYNCED_FROM is missing' "$T/out"
check "that refusal left the tree alone" [ -e "$T/d1/apps/hosted/stale.ts" ]
rm -rf "$T/d1/apps"
expect_exit "sync succeeds" 0 "$T/d1/scripts/sync-from-public.sh" "$T/s1"
check "sync copies a listed dir" [ "$(cat "$T/d1/apps/hosted/src/index.ts" 2> /dev/null)" = hosted ]
check "sync does not resurrect a file that is not in public" [ ! -e "$T/d1/apps/hosted/stale.ts" ]
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
mkdir -p "$T/d4/scripts" "$T/d4/.github/workflows"
cp "$SYNC" "$T/d4/scripts/"
printf 'apps/hosted\n.github/hosted\n.github/workflows/nightly.yml\n.github/workflows/publish.yml\n' > "$T/d4/private-paths.txt"
echo 'private ci' > "$T/d4/.github/workflows/ci.yml"
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
  mkdir -p "$2/apps/admin/test" "$2/apps/server/test/node" "$2/apps/auth-broker/test/node" "$2/scripts/ci" "$2/scripts/ops/testdata" "$2/scripts/audit"
  echo '{"name":"admin","scripts":{"test":"vitest run","typecheck":"tsc"}}' > "$2/apps/admin/package.json"
  cp "$2/apps/admin/package.json" "$1/apps/admin/package.json"
  echo t > "$2/apps/admin/test/own.test.ts"
  echo t > "$2/apps/server/test/node/mcp-sdk-iserror.test.ts"
  echo t > "$2/apps/auth-broker/test/platform-ticket.test.ts"
  echo t > "$2/apps/auth-broker/test/node/config.test.ts"
  echo t > "$2/scripts/ci/hosted-release.test.ts"
  echo t > "$2/scripts/ops/platform-db.test.ts"
  echo t > "$2/scripts/audit/audit-actions.test.ts"
  G -C "$2" init -q && G -C "$2" add -A && G -C "$2" commit -qm init
}
mkplan "$T/o1" "$T/q1"
expect_exit "ci-plan succeeds" 0 "$PLAN" "$T/o1" "$T/q1" "$T/plan1"
check "plan lists the private package" [ "$(cat "$T/plan1/packages.txt")" = apps/admin ]
check "plan: root tests" [ "$(sort "$T/plan1/root-tests.txt" | tr '\n' ' ')" = "scripts/audit/audit-actions.test.ts scripts/ci/hosted-release.test.ts scripts/ops/platform-db.test.ts " ]
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

# --- --pre-split ------------------------------------------------------------
# A public repo that still holds its hosted paths and lists them.
mkpub_hosted() { # dir
  mkpub "$1"
  mkdir -p "$1/scripts/ci"
  echo 'public-only' > "$1/apps/hosted/src/public-only-file.ts"
  echo 'hosted wf' > "$1/.github/workflows/hosted.yml"
  printf '# hosted\napps/hosted\n.github/workflows/hosted.yml\n' > "$1/scripts/ci/private-paths.txt"
  printf "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      a: 1\n\n  apps/hosted:\n    dependencies:\n      c: 1\n\n  apps/server:\n    dependencies:\n      b: 1\n\npackages:\n  x: {}\n" > "$1/pnpm-lock.yaml"
  echo '#!/bin/sh' > "$1/scripts/ci/run.sh"; chmod 755 "$1/scripts/ci/run.sh"
  G -C "$1" add -A; G -C "$1" commit -qm hosted; G -C "$1" tag -f v1 > /dev/null
}
mkpriv_hosted() { # dir pubdir: a private tree that edits the hosted code
  mkpriv "$1" "$2"
  mkdir -p "$1/apps/hosted/src"; echo 'private edit' > "$1/apps/hosted/src/index.ts"
  rm -f "$1/.github/workflows/hosted.yml"
}
mkpub_hosted "$T/ps1"; mkpriv_hosted "$T/psv1" "$T/ps1"
expect_exit "without --pre-split a hosted path collides" 1 "$OVERLAY" "$T/ps1" "$T/psv1"
expect_exit "--pre-split succeeds" 0 "$OVERLAY" --pre-split "$T/ps1" "$T/psv1"
check "--pre-split overlays private's file" [ "$(cat "$T/ps1/apps/hosted/src/index.ts" 2> /dev/null)" = 'private edit' ]
check "--pre-split strips a listed public-only file" [ ! -e "$T/ps1/apps/hosted/src/public-only-file.ts" ]
check "--pre-split strips a listed workflow" [ ! -e "$T/ps1/.github/workflows/hosted.yml" ]
check "--pre-split keeps unlisted public files" [ "$(cat "$T/ps1/apps/server/index.ts")" = server ]
mkpub_hosted "$T/ps2"; mkpriv_hosted "$T/psv2" "$T/ps2"
printf 'package.json\n' > "$T/ps2/scripts/ci/private-paths.txt"; G -C "$T/ps2" add -A; G -C "$T/ps2" commit -qm badlist; G -C "$T/ps2" tag -f v1 > /dev/null
printf 'tag=v1\nsha=%s\n' "$(git -C "$T/ps2" rev-parse HEAD)" > "$T/psv2/PUBLIC_PIN"
expect_exit "--pre-split refuses a root-level list entry" 1 "$OVERLAY" --pre-split "$T/ps2" "$T/psv2"
expect_exit "unknown flag exits 2" 2 "$OVERLAY" --bogus "$T/ps2" "$T/psv2"

# --auto-split: pre-split while the pinned tree holds the hosted paths, strict
# once it holds none, a failure when it holds some. Decided from the tree.
pin_to() { # pubdir privdir: commit the pub changes and pin the private tree to them
  G -C "$1" add -A; G -C "$1" commit -qm pin --allow-empty; G -C "$1" tag -f v1 > /dev/null
  printf 'tag=v1\nsha=%s\n' "$(git -C "$1" rev-parse HEAD)" > "$2/PUBLIC_PIN"
}
mkpub_hosted "$T/as1"; mkpriv_hosted "$T/asv1" "$T/as1"
expect_exit "--auto-split pre-splits while public holds every listed path" 0 "$OVERLAY" --auto-split "$T/as1" "$T/asv1"
check "--auto-split said pre-split mode" grep -q 'pre-split mode' "$T/out"
check "--auto-split stripped a listed public-only file" [ ! -e "$T/as1/apps/hosted/src/public-only-file.ts" ]
check "--auto-split overlaid private's file" [ "$(cat "$T/as1/apps/hosted/src/index.ts")" = 'private edit' ]
# After the delete: public holds none of the listed paths (and no list of its own).
mkpub_hosted "$T/as2"; mkpriv_hosted "$T/asv2" "$T/as2"
G -C "$T/as2" rm -rq apps/hosted .github/workflows/hosted.yml scripts/ci/private-paths.txt
printf 'apps/hosted\n.github/workflows/hosted.yml\n' > "$T/asv2/private-paths.txt"; pin_to "$T/as2" "$T/asv2"
expect_exit "--auto-split is strict once public holds none" 0 "$OVERLAY" --auto-split "$T/as2" "$T/asv2"
check "--auto-split said strict mode" grep -q 'strict mode' "$T/out"
check "--auto-split strict still overlays" [ "$(cat "$T/as2/apps/hosted/src/index.ts")" = 'private edit' ]
# Strict means a collision still fails, with the flag on.
mkpub_hosted "$T/as3"; mkpriv_hosted "$T/asv3" "$T/as3"
G -C "$T/as3" rm -rq apps/hosted .github/workflows/hosted.yml scripts/ci/private-paths.txt
printf 'apps/hosted\n.github/workflows/hosted.yml\n' > "$T/asv3/private-paths.txt"; mkdir -p "$T/asv3/apps/server"; echo mine > "$T/asv3/apps/server/index.ts"; pin_to "$T/as3" "$T/asv3"
expect_exit "--auto-split strict mode fails on a collision" 1 "$OVERLAY" --auto-split "$T/as3" "$T/asv3"
check "--auto-split collision is named" grep -q 'collision: apps/server/index.ts' "$T/out"
# Some listed paths present, some not: neither mode, fail.
mkpub_hosted "$T/as4"; mkpriv_hosted "$T/asv4" "$T/as4"
G -C "$T/as4" rm -q .github/workflows/hosted.yml; pin_to "$T/as4" "$T/asv4"
expect_exit "--auto-split refuses a half-deleted pin" 1 "$OVERLAY" --auto-split "$T/as4" "$T/asv4"
check "half-deleted refusal is named" grep -q 'half-deleted' "$T/out"
check "half-deleted refusal removed nothing" [ -e "$T/as4/apps/hosted/src/public-only-file.ts" ]
# No list anywhere: fail closed.
mkpub_hosted "$T/as5"; mkpriv_hosted "$T/asv5" "$T/as5"
G -C "$T/as5" rm -q scripts/ci/private-paths.txt; pin_to "$T/as5" "$T/asv5"
expect_exit "--auto-split fails without a path list" 1 "$OVERLAY" --auto-split "$T/as5" "$T/asv5"

# --pre-split list hygiene: '..', '.', CRLF, symlinked parent.
mkpre() { # name listcontent(printf format)
  mkpub_hosted "$T/$1"; mkpriv_hosted "$T/${1}v" "$T/$1"
  printf '%b' "$2" > "$T/$1/scripts/ci/private-paths.txt"; G -C "$T/$1" add -A; G -C "$T/$1" commit -qm list; G -C "$T/$1" tag -f v1 > /dev/null
  printf 'tag=v1\nsha=%s\n' "$(git -C "$T/$1" rev-parse HEAD)" > "$T/${1}v/PUBLIC_PIN"
}
mkpre pd 'apps/../package.json\n'
expect_exit "--pre-split refuses '..' in the list" 1 "$OVERLAY" --pre-split "$T/pd" "$T/pdv"
check "'..' refusal removed nothing" [ -e "$T/pd/package.json" ]
mkpre pe 'apps/./hosted\n'
expect_exit "--pre-split refuses '.' in the list" 1 "$OVERLAY" --pre-split "$T/pe" "$T/pev"
check "'.' refusal removed nothing" [ -e "$T/pe/apps/hosted/src/index.ts" ]
mkpre pf 'apps/hosted\r\n.github/workflows/hosted.yml\r\n'
expect_exit "--pre-split reads a CRLF list" 0 "$OVERLAY" --pre-split "$T/pf" "$T/pfv"
check "CRLF entries are stripped, then removed" [ "$(cat "$T/pf/apps/hosted/src/index.ts")" = 'private edit' ] && [ ! -e "$T/pf/apps/hosted/src/public-only-file.ts" ]
mkpub_hosted "$T/pg"; mkpriv_hosted "$T/pgv" "$T/pg"
ln -s apps/hosted "$T/pg/lnk"; printf 'lnk/src/index.ts\n' > "$T/pg/scripts/ci/private-paths.txt"
G -C "$T/pg" add -A; G -C "$T/pg" commit -qm link; G -C "$T/pg" tag -f v1 > /dev/null
printf 'tag=v1\nsha=%s\n' "$(git -C "$T/pg" rev-parse HEAD)" > "$T/pgv/PUBLIC_PIN"
expect_exit "--pre-split refuses a symlinked parent" 1 "$OVERLAY" --pre-split "$T/pg" "$T/pgv"
check "symlink refusal is named" grep -q 'lnk is a symlink' "$T/out"
check "nothing removed through the symlink" [ -e "$T/pg/apps/hosted/src/index.ts" ]

# --- equivalence ---------------------------------------------------------------
# A synced cloud dir for a hosted public repo, built with the real sync.
mkcloud() { # pubdir dest
  mkdir -p "$2/scripts"; cp "$SYNC" "$OVERLAY" "$EQUIV" "$PLACE" "$PINCHK" "$LISTED" "$2/scripts/"
  echo 'cloud readme' > "$2/README.md"
  "$2/scripts/sync-from-public.sh" "$1" > /dev/null 2>&1 || echo "mkcloud: sync failed" >&2
}
mkpub_hosted "$T/e1"; mkdir -p "$T/ec0"; mkdir -p "$T/ec0/scripts"; cp "$OVERLAY" "$EQUIV" "$PLACE" "$LISTED" "$T/ec0/scripts/"
expect_exit "equivalence skips without SYNCED_FROM" 0 "$T/ec0/scripts/equivalence.sh" "$T/e1"
check "skip says why" grep -q 'SKIPPED: no SYNCED_FROM' "$T/out"

mkcloud "$T/e1" "$T/ec1"
echo 'later' > "$T/e1/later.txt"; G -C "$T/e1" add -A; G -C "$T/e1" commit -qm later
expect_exit "equivalence passes after a sync (public HEAD may be ahead of S)" 0 "$T/ec1/scripts/equivalence.sh" "$T/e1" "$T/ec1"
check "pass names the allowlisted count" grep -q 'OK:' "$T/out"

# A real diff through ALLOW: the merged lockfile adds a private importer and
# other packages, and keeps public's importers.
printf "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      a: 1\n\n  apps/server:\n    dependencies:\n      b: 1\n\n  apps/hosted:\n    dependencies:\n      z: 9\n\npackages:\n  x: {}\n  y: {}\n" > "$T/ec1/pnpm-lock.yaml"
expect_exit "an allowlisted lockfile difference passes" 0 "$T/ec1/scripts/equivalence.sh" "$T/e1" "$T/ec1"
check "the lockfile really differed (count shows it)" grep -q '(1 allowlisted difference(s);' "$T/out"
sed -i 's/      b: 1/      b: 2/' "$T/ec1/pnpm-lock.yaml"
expect_exit "a changed public importer in the lockfile fails" 1 "$T/ec1/scripts/equivalence.sh" "$T/e1" "$T/ec1"
check "the importer is named" grep -q 'apps/server' "$T/out"
rm "$T/ec1/pnpm-lock.yaml"

# The blocker issue template: repo-only, must equal public@S byte for byte.
mkpub_hosted "$T/eb"; mkdir -p "$T/eb/.github/ISSUE_TEMPLATE"; echo 'name: Blocker' > "$T/eb/.github/ISSUE_TEMPLATE/blocker.yml"
G -C "$T/eb" add -A; G -C "$T/eb" commit -qm tmpl
mkcloud "$T/eb" "$T/ebc"
mkdir -p "$T/ebc/.github/ISSUE_TEMPLATE"; echo 'name: Blocker' > "$T/ebc/.github/ISSUE_TEMPLATE/blocker.yml"
expect_exit "a blocker.yml identical to public's passes" 0 "$T/ebc/scripts/equivalence.sh" "$T/eb" "$T/ebc"
echo 'name: Edited' > "$T/ebc/.github/ISSUE_TEMPLATE/blocker.yml"
expect_exit "a blocker.yml that differs from public's fails" 1 "$T/ebc/scripts/equivalence.sh" "$T/eb" "$T/ebc"
check "the difference is named" grep -q 'DIFF: .github/ISSUE_TEMPLATE/blocker.yml' "$T/out"
mkcloud "$T/e1" "$T/ebd"
mkdir -p "$T/ebd/.github/ISSUE_TEMPLATE"; echo 'name: Blocker' > "$T/ebd/.github/ISSUE_TEMPLATE/blocker.yml"
expect_exit "a blocker.yml that public lacks fails" 1 "$T/ebd/scripts/equivalence.sh" "$T/e1" "$T/ebd"

# CLOUD owns the private paths: edits, deletions and additions inside them pass.
rm "$T/ec1/apps/hosted/src/index.ts"
expect_exit "a dropped private file passes (CLOUD-owned)" 0 "$T/ec1/scripts/equivalence.sh" "$T/e1" "$T/ec1"
check "owned differences are counted" grep -q '1 CLOUD-owned difference(s)' "$T/out"

mkcloud "$T/e1" "$T/ec2"
echo 'extra' > "$T/ec2/apps/hosted/src/extra.ts"
expect_exit "an extra private file passes (CLOUD-owned)" 0 "$T/ec2/scripts/equivalence.sh" "$T/e1" "$T/ec2"

mkcloud "$T/e1" "$T/ec3"
echo 'renamed repo pin' > "$T/ec3/apps/hosted/src/index.ts"
expect_exit "a changed private file passes (CLOUD-owned)" 0 "$T/ec3/scripts/equivalence.sh" "$T/e1" "$T/ec3"

mkcloud "$T/e1" "$T/ec4"
echo 'edited wf' > "$T/ec4/hosted-workflows/hosted.yml"
expect_exit "a changed hosted workflow passes (CLOUD-owned)" 0 "$T/ec4/scripts/equivalence.sh" "$T/e1" "$T/ec4"

mkcloud "$T/e1" "$T/ec6"
chmod 755 "$T/ec6/apps/hosted/src/index.ts"
expect_exit "a chmod of a private file passes (CLOUD-owned)" 0 "$T/ec6/scripts/equivalence.sh" "$T/e1" "$T/ec6"

# Everything outside the private paths stays strict.
mkcloud "$T/e1" "$T/ec11"
mkdir -p "$T/ec11/apps/server"; echo 'extra' > "$T/ec11/apps/server/extra.ts"
expect_exit "an extra non-private file fails" 1 "$T/ec11/scripts/equivalence.sh" "$T/e1" "$T/ec11"
check "extra non-private file is named" grep -q 'DIFF: apps/server/extra.ts (only in overlay (extra))' "$T/out"
mkcloud "$T/e1" "$T/ec12"
echo 'wf' > "$T/ec12/hosted-workflows/other.yml"
expect_exit "a parked workflow that is not listed fails" 1 "$T/ec12/scripts/equivalence.sh" "$T/e1" "$T/ec12"
check "unlisted workflow is named" grep -q 'DIFF: .github/workflows/other.yml' "$T/out"
mkcloud "$T/e1" "$T/ec13"
mkdir -p "$T/ec13/apps/newapp"; echo x > "$T/ec13/apps/newapp/i.ts"
expect_exit "a new non-private directory fails" 1 "$T/ec13/scripts/equivalence.sh" "$T/e1" "$T/ec13"
check "new directory is named" grep -q 'DIFF: apps/newapp' "$T/out"

mkcloud "$T/e1" "$T/ec7"
echo 'mine' > "$T/ec7/hosted-workflows/ci.yml"
expect_exit "a hosted-workflows file whose target exists fails" 1 "$T/ec7/scripts/equivalence.sh" "$T/e1" "$T/ec7"
check "the overwrite is named" grep -q 'would overwrite .github/workflows/ci.yml' "$T/out"

mkcloud "$T/e1" "$T/ec8"
mv "$T/ec8/SYNCED_FROM" "$T/ec8/SYNCED_FROM.real"; ln -s SYNCED_FROM.real "$T/ec8/SYNCED_FROM"
expect_exit "a symlinked SYNCED_FROM fails, not skips" 1 "$T/ec8/scripts/equivalence.sh" "$T/e1" "$T/ec8"
mkcloud "$T/e1" "$T/ec9"
rm "$T/ec9/SYNCED_FROM"; mkdir "$T/ec9/SYNCED_FROM"
expect_exit "a SYNCED_FROM that is a directory fails, not skips" 1 "$T/ec9/scripts/equivalence.sh" "$T/e1" "$T/ec9"
check "not skipped" nogrep SKIPPED "$T/out"
mkcloud "$T/e1" "$T/ec10"
: > "$T/ec10/SYNCED_FROM"
expect_exit "an empty SYNCED_FROM fails, not skips" 1 "$T/ec10/scripts/equivalence.sh" "$T/e1" "$T/ec10"

mkcloud "$T/e1" "$T/ec5"
sed -i 's/^sha=.*/sha=0123456789abcdef0123456789abcdef01234567/' "$T/ec5/SYNCED_FROM"
expect_exit "a SYNCED_FROM sha public lacks fails" 1 "$T/ec5/scripts/equivalence.sh" "$T/e1" "$T/ec5"

# --- overlay: flag and list gaps (cloud #5) --------------------------------------
mkpub_hosted "$T/g1"; mkpriv_hosted "$T/gv1" "$T/g1"
expect_exit "--pre-split with --auto-split exits 2" 2 "$OVERLAY" --pre-split --auto-split "$T/g1" "$T/gv1"
expect_exit "--auto-split with --pre-split exits 2" 2 "$OVERLAY" --auto-split --pre-split "$T/g1" "$T/gv1"
check "the exclusive flags are named" grep -q 'exclusive' "$T/out"
check "nothing was removed on the bad flags" [ -e "$T/g1/apps/hosted/src/public-only-file.ts" ]

# An empty list (comments only) dies, in both modes.
mkpre g2 '# only a comment\n\n'
expect_exit "--pre-split fails on an empty list" 1 "$OVERLAY" --pre-split "$T/g2" "$T/g2v"
check "empty list is named" grep -q 'path list is empty' "$T/out"
mkpre g3 '\n'
expect_exit "--auto-split fails on an empty list" 1 "$OVERLAY" --auto-split "$T/g3" "$T/g3v"
check "auto-split errors carry the --auto-split prefix" grep -q -- '--auto-split: path list is empty' "$T/out"

# A dangling symlink counts as present (the -L half of the check): all listed
# paths present means pre-split, and the link is removed, not left to collide.
mkpub_hosted "$T/g4"; mkpriv_hosted "$T/gv4" "$T/g4"
rm -rf "$T/g4/apps/hosted" "$T/g4/.github/workflows/hosted.yml"
ln -s nowhere "$T/g4/apps/hosted"; ln -s nowhere "$T/g4/.github/workflows/hosted.yml"
pin_to "$T/g4" "$T/gv4"
expect_exit "--auto-split counts dangling symlinks as present" 0 "$OVERLAY" --auto-split "$T/g4" "$T/gv4"
check "dangling symlinks: pre-split mode" grep -q 'all 2 listed path(s) are in public: pre-split mode' "$T/out"
check "the dangling link was replaced by private's file" [ "$(cat "$T/g4/apps/hosted/src/index.ts")" = 'private edit' ]
# One dangling link and one absent path is a half-deleted pin, not strict.
mkpub_hosted "$T/g5"; mkpriv_hosted "$T/gv5" "$T/g5"
G -C "$T/g5" rm -rq apps/hosted; ln -s nowhere "$T/g5/apps/hosted"; G -C "$T/g5" rm -q .github/workflows/hosted.yml
pin_to "$T/g5" "$T/gv5"
expect_exit "--auto-split: one dangling link, one absent path is half-deleted" 1 "$OVERLAY" --auto-split "$T/g5" "$T/gv5"
check "half-deleted is named" grep -q '1 of 2' "$T/out"

# Strict mode while public still ships its own list: the list stays in the
# tree, none of its paths do, so it is strict and a collision still fails.
mkpub_hosted "$T/g6"; mkpriv_hosted "$T/gv6" "$T/g6"
G -C "$T/g6" rm -rq apps/hosted .github/workflows/hosted.yml
pin_to "$T/g6" "$T/gv6"
check "public still ships its list" [ -f "$T/g6/scripts/ci/private-paths.txt" ]
expect_exit "--auto-split is strict when public keeps its list but none of its paths" 0 "$OVERLAY" --auto-split "$T/g6" "$T/gv6"
check "that was strict mode" grep -q 'strict mode' "$T/out"
mkpub_hosted "$T/g7"; mkpriv_hosted "$T/gv7" "$T/g7"
G -C "$T/g7" rm -rq apps/hosted .github/workflows/hosted.yml
mkdir -p "$T/gv7/apps/server"; echo mine > "$T/gv7/apps/server/index.ts"; pin_to "$T/g7" "$T/gv7"
expect_exit "strict mode with public's own list still fails a collision" 1 "$OVERLAY" --auto-split "$T/g7" "$T/gv7"

# --- place-workflows ---------------------------------------------------------------
mkdir -p "$T/pw1/hosted-workflows/sub" "$T/pw1o/.github/workflows"
echo a > "$T/pw1/hosted-workflows/a.yml"; echo b > "$T/pw1/hosted-workflows/sub/b.yml"
printf '#!/bin/sh\n' > "$T/pw1/hosted-workflows/run.sh"; chmod 755 "$T/pw1/hosted-workflows/run.sh"
ln -s a.yml "$T/pw1/hosted-workflows/link.yml"
expect_exit "place copies workflows" 0 "$PLACE" "$T/pw1" "$T/pw1o"
check "place is recursive" [ "$(cat "$T/pw1o/.github/workflows/sub/b.yml" 2> /dev/null)" = b ]
check "place keeps the executable bit" [ -x "$T/pw1o/.github/workflows/run.sh" ]
check "place keeps symlinks as symlinks" [ -L "$T/pw1o/.github/workflows/link.yml" ]
check "place counts them" grep -q 'placed 4 hosted workflow' "$T/out"
expect_exit "place refuses an existing target" 1 "$PLACE" "$T/pw1" "$T/pw1o"
check "existing target is named" grep -q 'would overwrite .github/workflows/' "$T/out"
mkdir -p "$T/pw2/real" "$T/pw2o"; echo a > "$T/pw2/real/a.yml"; ln -s real "$T/pw2/hosted-workflows"
expect_exit "place refuses a symlinked hosted-workflows" 1 "$PLACE" "$T/pw2" "$T/pw2o"
check "symlinked dir is named" grep -q 'is a symlink' "$T/out"
check "nothing placed through the symlink" [ ! -e "$T/pw2o/.github/workflows/a.yml" ]
mkdir -p "$T/pw3" "$T/pw3o"
expect_exit "place with no hosted-workflows places nothing" 0 "$PLACE" "$T/pw3" "$T/pw3o"
mkdir -p "$T/pw4/hosted-workflows" "$T/pw4o/.github/workflows/sub"; echo a > "$T/pw4/hosted-workflows/sub"
expect_exit "place refuses a file where the tree has a directory" 1 "$PLACE" "$T/pw4" "$T/pw4o"
expect_exit "place bad usage exits 2" 2 "$PLACE" "$T/pw4"

# --- sync: CLOUD owns the private paths ------------------------------------------
# A synced cloud dir with a PUBLIC_PIN at public's HEAD.
mkc() { # pubdir dest
  mkcloud "$1" "$2"
  printf 'tag=v1\nsha=%s\n' "$(git -C "$1" rev-parse HEAD)" > "$2/PUBLIC_PIN"
}
adv() { # pubdir relpath content: a new public commit
  mkdir -p "$1/$(dirname "$2")"; printf '%s\n' "$3" > "$1/$2"
  G -C "$1" add -A; G -C "$1" commit -qm adv
}
mkpub_hosted "$T/y1"; mkc "$T/y1" "$T/yc1"
check "the first sync writes private-paths.txt from public's list" grep -qx 'apps/hosted' "$T/yc1/private-paths.txt"
adv "$T/y1" apps/hosted/src/index.ts 'public fix'
expect_exit "a re-sync of an untouched cloud tree succeeds" 0 "$T/yc1/scripts/sync-from-public.sh" "$T/y1"
check "the re-sync took public's change" [ "$(cat "$T/yc1/apps/hosted/src/index.ts")" = 'public fix' ]
check "the re-sync advanced SYNCED_FROM" grep -qx "sha=$(git -C "$T/y1" rev-parse HEAD)" "$T/yc1/SYNCED_FROM"
# A file public deletes between syncs, on an untouched cloud tree, is removed by the re-sync.
mkpub_hosted "$T/y1r"; mkc "$T/y1r" "$T/yc1r"
check "the first sync copied the soon-deleted file" [ -e "$T/yc1r/apps/hosted/src/public-only-file.ts" ]
G -C "$T/y1r" rm -q apps/hosted/src/public-only-file.ts; G -C "$T/y1r" commit -qm 'drop file'
expect_exit "a re-sync after public deleted a file succeeds" 0 "$T/yc1r/scripts/sync-from-public.sh" "$T/y1r"
check "sync mirrors (the file public deleted is removed)" [ ! -e "$T/yc1r/apps/hosted/src/public-only-file.ts" ]
check "the re-sync kept the other listed file" [ "$(cat "$T/yc1r/apps/hosted/src/index.ts")" = hosted ]

mkpub_hosted "$T/y2"; mkc "$T/y2" "$T/yc2"
echo 'cloud edit' > "$T/yc2/apps/hosted/src/index.ts"
adv "$T/y2" apps/hosted/src/other.ts 'public change'
expect_exit "sync refuses to overwrite a CLOUD-changed private file" 1 "$T/yc2/scripts/sync-from-public.sh" "$T/y2"
check "the changed path is named" grep -q 'apps/hosted' "$T/out"
check "the refusal points at the hand-port procedure" grep -q 'Hand-port' "$T/out"
check "the CLOUD edit survived" [ "$(cat "$T/yc2/apps/hosted/src/index.ts")" = 'cloud edit' ]
check "SYNCED_FROM did not move" nogrep "sha=$(git -C "$T/y2" rev-parse HEAD)" "$T/yc2/SYNCED_FROM"

mkpub_hosted "$T/y3"; mkc "$T/y3" "$T/yc3"
echo 'new' > "$T/yc3/apps/hosted/src/cloud-only.ts"
adv "$T/y3" README.md 'x'
expect_exit "sync refuses when CLOUD added a file under a private path" 1 "$T/yc3/scripts/sync-from-public.sh" "$T/y3"
check "the CLOUD-owned refusal fired (y3)" grep -q "differ from public's copy at SYNCED_FROM" "$T/out"
check "the cloud-only file survived" [ -e "$T/yc3/apps/hosted/src/cloud-only.ts" ]

mkpub_hosted "$T/y4"; mkc "$T/y4" "$T/yc4"
echo 'cloud wf' > "$T/yc4/hosted-workflows/hosted.yml"
adv "$T/y4" README.md 'x'
expect_exit "sync refuses when CLOUD edited a parked workflow" 1 "$T/yc4/scripts/sync-from-public.sh" "$T/y4"
check "the workflow is named by its parked path" grep -q 'hosted-workflows/hosted.yml' "$T/out"

mkpub_hosted "$T/y5"; mkc "$T/y5" "$T/yc5"
rm "$T/yc5/apps/hosted/src/index.ts"
adv "$T/y5" README.md 'x'
expect_exit "sync refuses when CLOUD deleted a private file" 1 "$T/yc5/scripts/sync-from-public.sh" "$T/y5"
check "the CLOUD-owned refusal fired (y5)" grep -q "differ from public's copy at SYNCED_FROM" "$T/out"

mkpub_hosted "$T/y6"; mkc "$T/y6" "$T/yc6"
chmod 755 "$T/yc6/apps/hosted/src/index.ts"
adv "$T/y6" README.md 'x'
expect_exit "sync refuses when CLOUD changed a mode" 1 "$T/yc6/scripts/sync-from-public.sh" "$T/y6"
check "the CLOUD-owned refusal fired (y6)" grep -q "differ from public's copy at SYNCED_FROM" "$T/out"

# The file-level executable bit: a listed single file whose mode changed.
mkpub_hosted "$T/y9"
printf '# hosted\napps/hosted\n.github/workflows/hosted.yml\nscripts/ci/run.sh\n' > "$T/y9/scripts/ci/private-paths.txt"
G -C "$T/y9" add -A; G -C "$T/y9" commit -qm 'list a file'
mkc "$T/y9" "$T/yc9"
chmod 644 "$T/yc9/scripts/ci/run.sh"
adv "$T/y9" README.md 'x'
expect_exit "sync refuses when CLOUD changed the mode of a listed single file" 1 "$T/yc9/scripts/sync-from-public.sh" "$T/y9"
check "the single file is named" grep -q 'scripts/ci/run.sh' "$T/out"
check "the mode refusal is the CLOUD-owned one" grep -q "differ from public's copy at SYNCED_FROM" "$T/out"

# A path public starts listing that CLOUD lacks is called newly listed.
mkpub_hosted "$T/y10"; mkc "$T/y10" "$T/yc10"
printf '# hosted\napps/hosted\n.github/workflows/hosted.yml\napps/server\n' > "$T/y10/scripts/ci/private-paths.txt"
G -C "$T/y10" add -A; G -C "$T/y10" commit -qm 'list grows'
expect_exit "sync refuses a newly listed path CLOUD lacks" 1 "$T/yc10/scripts/sync-from-public.sh" "$T/y10"
check "the refusal says newly listed" grep -q 'newly listed' "$T/out"

mkpub_hosted "$T/y7"; mkc "$T/y7" "$T/yc7"
printf 'stale/path\n' > "$T/yc7/private-paths.txt"
adv "$T/y7" README.md 'x'
expect_exit "a re-sync refreshes a stale private-paths.txt" 0 "$T/yc7/scripts/sync-from-public.sh" "$T/y7"
check "stale entry gone" nogrep 'stale/path' "$T/yc7/private-paths.txt"
check "public's entries present" grep -qx '.github/workflows/hosted.yml' "$T/yc7/private-paths.txt"

mkpub_hosted "$T/y8"; mkc "$T/y8" "$T/yc8"
G -C "$T/y8" cat-file -e HEAD > /dev/null
mkpub "$T/y8b"
expect_exit "sync refuses when public lacks the old SYNCED_FROM commit" 1 "$T/yc8/scripts/sync-from-public.sh" "$T/y8b"

# --- pin-check ---------------------------------------------------------------------
pin_at() { # cloud sha
  printf 'tag=v1\nsha=%s\n' "$2" > "$1/PUBLIC_PIN"
}
mkpub_hosted "$T/k1"; mkc "$T/k1" "$T/kc1"
expect_exit "pin-check passes when the pin equals SYNCED_FROM" 0 "$T/kc1/scripts/pin-check.sh" "$T/k1" "$T/kc1"
check "pin-check says equal" grep -q 'equal' "$T/out"
S1=$(git -C "$T/k1" rev-parse HEAD)
adv "$T/k1" apps/server/new.ts 'non-hosted change'
pin_at "$T/kc1" "$(git -C "$T/k1" rev-parse HEAD)"
expect_exit "pin-check lets the pin lead over non-hosted changes" 0 "$T/kc1/scripts/pin-check.sh" "$T/k1" "$T/kc1"
check "pin-check says the pin leads" grep -q 'pin leads' "$T/out"
adv "$T/k1" apps/hosted/src/index.ts 'hosted change upstream'
pin_at "$T/kc1" "$(git -C "$T/k1" rev-parse HEAD)"
expect_exit "pin-check fails when the pin leads over a hosted change" 1 "$T/kc1/scripts/pin-check.sh" "$T/k1" "$T/kc1"
check "the changed hosted file is named" grep -q 'apps/hosted/src/index.ts' "$T/out"
check "the remedy is named" grep -q 'bump SYNCED_FROM' "$T/out"
# The hand-port PR: SYNCED_FROM bumped to the pin, with the port.
sed -i "s/^sha=.*/sha=$(git -C "$T/k1" rev-parse HEAD)/" "$T/kc1/SYNCED_FROM"
echo 'hosted change upstream' > "$T/kc1/apps/hosted/src/index.ts"
expect_exit "pin-check passes once SYNCED_FROM is bumped to the pin (no base known)" 0 "$T/kc1/scripts/pin-check.sh" "$T/k1" "$T/kc1"
check "that pass is the 'equal' one, which proves no port" grep -q 'equal' "$T/out"
expect_exit "port check passes when the bump carries the port" 0 "$T/kc1/scripts/pin-check.sh" --prev "$S1" "$T/k1" "$T/kc1"
check "port check says it ran" grep -q 'port check: every public change' "$T/out"
# The same bump WITHOUT the port must fail (a pin bump that ports nothing).
echo 'hosted' > "$T/kc1/apps/hosted/src/index.ts"
expect_exit "port check fails when SYNCED_FROM moved without the port" 1 "$T/kc1/scripts/pin-check.sh" --prev "$S1" "$T/k1" "$T/kc1"
check "the unported fix is the failure" grep -q 'without porting' "$T/out"
# A reviewed exception for that file: CLOUD kept its own side.
SB1=$(git -C "$T/k1" rev-parse HEAD)
printf 'apps/hosted/src/index.ts %s  # CLOUD keeps its own line\n' "$SB1" > "$T/kc1/port-exceptions.txt"
expect_exit "port-exceptions.txt exempts a named file for this bump" 0 "$T/kc1/scripts/pin-check.sh" --prev "$S1" "$T/k1" "$T/kc1"
# A path-only line (the old format) is refused.
printf 'apps/hosted/src/index.ts  # old format\n' > "$T/kc1/port-exceptions.txt"
expect_exit "an exception line without a sha is refused" 1 "$T/kc1/scripts/pin-check.sh" --prev "$S1" "$T/k1" "$T/kc1"
check "the bad line is named" grep -q 'bad line' "$T/out"
# Bump 2: public fixes the same file; CLOUD moves SYNCED_FROM and ports nothing.
printf 'apps/hosted/src/index.ts %s  # CLOUD keeps its own line\n' "$SB1" > "$T/kc1/port-exceptions.txt"
adv "$T/k1" apps/hosted/src/index.ts 'OIDC audience fix'
SB2=$(git -C "$T/k1" rev-parse HEAD)
sed -i "s/^sha=.*/sha=$SB2/" "$T/kc1/SYNCED_FROM"; pin_at "$T/kc1" "$SB2"
expect_exit "an old exception does not cover a later unported fix" 1 "$T/kc1/scripts/pin-check.sh" --prev "$SB1" "$T/k1" "$T/kc1"
check "the stale entry is named" grep -q 'stale entry' "$T/out"
expect_exit "a stale entry fails even without --prev" 1 "$T/kc1/scripts/pin-check.sh" "$T/k1" "$T/kc1"
# Re-pointing the entry at bump 2 is an explicit, reviewed claim and passes.
printf 'apps/hosted/src/index.ts %s  # still keeping our line\n' "$SB2" > "$T/kc1/port-exceptions.txt"
expect_exit "an exception re-stated for the new bump passes" 0 "$T/kc1/scripts/pin-check.sh" --prev "$SB1" "$T/k1" "$T/kc1"
# Without the entry, the unported bump 2 fails on the port check itself.
rm "$T/kc1/port-exceptions.txt"
expect_exit "bump 2 with no exception and no port fails the port check" 1 "$T/kc1/scripts/pin-check.sh" --prev "$SB1" "$T/k1" "$T/kc1"
check "bump 2 failure is the unported fix" grep -q 'without porting' "$T/out"
# A fix to a hosted workflow must be ported into hosted-workflows/.
mkpub_hosted "$T/k7"; mkc "$T/k7" "$T/kc7"; S7=$(git -C "$T/k7" rev-parse HEAD)
adv "$T/k7" .github/workflows/hosted.yml 'hosted wf fixed'
sed -i "s/^sha=.*/sha=$(git -C "$T/k7" rev-parse HEAD)/" "$T/kc7/SYNCED_FROM"; pin_at "$T/kc7" "$(git -C "$T/k7" rev-parse HEAD)"
expect_exit "port check fails on an unported workflow fix" 1 "$T/kc7/scripts/pin-check.sh" --prev "$S7" "$T/k7" "$T/kc7"
echo 'hosted wf fixed' > "$T/kc7/hosted-workflows/hosted.yml"
expect_exit "port check passes once the workflow fix is in hosted-workflows/" 0 "$T/kc7/scripts/pin-check.sh" --prev "$S7" "$T/k7" "$T/kc7"
# A renamed hosted workflow: the port is a rename into hosted-workflows/.
mkpub_hosted "$T/k9"; mkc "$T/k9" "$T/kc9"; S9=$(git -C "$T/k9" rev-parse HEAD)
G -C "$T/k9" mv .github/workflows/hosted.yml .github/workflows/hosted2.yml
printf '.github/workflows/hosted2.yml\n' >> "$T/k9/scripts/ci/private-paths.txt"; printf '.github/workflows/hosted2.yml\n' >> "$T/kc9/private-paths.txt"
G -C "$T/k9" add -A; G -C "$T/k9" commit -qm rename
sed -i "s/^sha=.*/sha=$(git -C "$T/k9" rev-parse HEAD)/" "$T/kc9/SYNCED_FROM"; pin_at "$T/kc9" "$(git -C "$T/k9" rev-parse HEAD)"
git -C "$T/kc9" mv hosted-workflows/hosted.yml hosted-workflows/hosted2.yml 2> /dev/null || mv "$T/kc9/hosted-workflows/hosted.yml" "$T/kc9/hosted-workflows/hosted2.yml"
expect_exit "port check accepts a correctly ported workflow rename" 0 "$T/kc9/scripts/pin-check.sh" --prev "$S9" "$T/k9" "$T/kc9"
# The SECURITY FIX scenario: pin and SYNCED_FROM both move, CLOUD copy unchanged.
mkpub_hosted "$T/k8"; mkc "$T/k8" "$T/kc8"; S8=$(git -C "$T/k8" rev-parse HEAD)
adv "$T/k8" apps/hosted/src/index.ts 'SECURITY FIX'
sed -i "s/^sha=.*/sha=$(git -C "$T/k8" rev-parse HEAD)/" "$T/kc8/SYNCED_FROM"; pin_at "$T/kc8" "$(git -C "$T/k8" rev-parse HEAD)"
expect_exit "pin-check alone cannot see the bump (no base)" 0 "$T/kc8/scripts/pin-check.sh" "$T/k8" "$T/kc8"
expect_exit "a bump with the CLOUD copy unchanged fails the port check" 1 "$T/kc8/scripts/pin-check.sh" --prev "$S8" "$T/k8" "$T/kc8"
expect_exit "--prev equal to SYNCED_FROM means nothing moved" 0 "$T/kc1/scripts/pin-check.sh" --prev "$(sed -n 's/^sha=//p' "$T/kc1/SYNCED_FROM")" "$T/k1" "$T/kc1"
expect_exit "--prev must be a full sha" 1 "$T/kc8/scripts/pin-check.sh" --prev abc "$T/k8" "$T/kc8"
# A pin behind the sync.
pin_at "$T/kc1" "$S1"
expect_exit "pin-check fails when the pin is behind SYNCED_FROM" 1 "$T/kc1/scripts/pin-check.sh" "$T/k1" "$T/kc1"
check "behind pin is named" grep -q 'not PUBLIC_PIN' "$T/out"

mkpub_hosted "$T/k2"; mkc "$T/k2" "$T/kc2"
printf '# hosted\napps/hosted\n.github/workflows/hosted.yml\nscripts/ci/run.sh\n' > "$T/k2/scripts/ci/private-paths.txt"
G -C "$T/k2" add -A; G -C "$T/k2" commit -qm 'list grows'
pin_at "$T/kc2" "$(git -C "$T/k2" rev-parse HEAD)"
expect_exit "pin-check fails when public's list changed under the pin" 1 "$T/kc2/scripts/pin-check.sh" "$T/k2" "$T/kc2"
check "list change is named" grep -q 'list changed' "$T/out"

mkpub_hosted "$T/k3"; mkc "$T/k3" "$T/kc3"
printf 'stale/path\n' > "$T/kc3/private-paths.txt"
expect_exit "pin-check fails on a stale private-paths.txt" 1 "$T/kc3/scripts/pin-check.sh" "$T/k3" "$T/kc3"
check "stale list is named" grep -q 'private-paths.txt does not match' "$T/out"

mkpub_hosted "$T/k4"; mkc "$T/k4" "$T/kc4"
G -C "$T/k4" rm -rq apps/hosted .github/workflows/hosted.yml
G -C "$T/k4" commit -qm delete
pin_at "$T/kc4" "$(git -C "$T/k4" rev-parse HEAD)"
S4=$(sed -n 's/^sha=//p' "$T/kc4/SYNCED_FROM")
expect_exit "strict mode with the pin ahead and no --prev fails (base unknown)" 1 "$T/kc4/scripts/pin-check.sh" "$T/k4" "$T/kc4"
check "that failure says no --prev" grep -q 'no --prev' "$T/out"
expect_exit "pin-check does not apply once public holds none of the paths" 0 "$T/kc4/scripts/pin-check.sh" --prev "$S4" "$T/k4" "$T/kc4"
check "strict mode is named" grep -q 'strict mode' "$T/out"

# Strict mode is not blind: a fix made before the delete must be ported.
strictfix() { # name: public with a pre-delete fix then the delete D; cloud at S. Sets SF_S, SF_F, SF_D
  mkpub_hosted "$T/$1"; mkc "$T/$1" "$T/${1}c"
  SF_S=$(git -C "$T/$1" rev-parse HEAD)
  adv "$T/$1" apps/hosted/src/index.ts 'SECURITY FIX'
  SF_F=$(git -C "$T/$1" rev-parse HEAD)
  G -C "$T/$1" rm -rq apps/hosted .github/workflows/hosted.yml
  G -C "$T/$1" commit -qm delete
  SF_D=$(git -C "$T/$1" rev-parse HEAD)
}
strictfix kf; kf_S=$SF_S; kf_F=$SF_F; kf_D=$SF_D
pin_at "$T/kfc" "$kf_D"
expect_exit "fix then delete: pin at D, SYNCED_FROM unchanged, fails" 1 "$T/kfc/scripts/pin-check.sh" "$T/kf" "$T/kfc"
check "that failure names the pre-delete fix" grep -q 'before the delete' "$T/out"
expect_exit "fix then delete: also fails with --prev" 1 "$T/kfc/scripts/pin-check.sh" --prev "$kf_S" "$T/kf" "$T/kfc"
sed -i "s/^sha=.*/sha=$kf_D/" "$T/kfc/SYNCED_FROM"
expect_exit "fix then delete: SYNCED_FROM and pin at D, no port, fails" 1 "$T/kfc/scripts/pin-check.sh" --prev "$kf_S" "$T/kf" "$T/kfc"
check "that failure is the unported fix" grep -q 'without porting' "$T/out"
echo 'SECURITY FIX' > "$T/kfc/apps/hosted/src/index.ts"
expect_exit "fix then delete: SYNCED_FROM and pin at D with the port passes" 0 "$T/kfc/scripts/pin-check.sh" --prev "$kf_S" "$T/kf" "$T/kfc"
check "that pass ran the port check" grep -q 'port check: every public change' "$T/out"
check "that pass says it is strict mode" grep -q 'strict mode' "$T/out"
# SYNCED_FROM at the last pre-delete commit F with the port, pin at D: passes.
sed -i "s/^sha=.*/sha=$kf_F/" "$T/kfc/SYNCED_FROM"
expect_exit "fix then delete: SYNCED_FROM at the last pre-delete commit with the port passes" 0 "$T/kfc/scripts/pin-check.sh" --prev "$kf_S" "$T/kf" "$T/kfc"
# A delete alone (no fix before it) still lets the pin lead.
strictfix kg
G -C "$T/kg" reset -q --hard "$SF_S"
G -C "$T/kg" rm -rq apps/hosted .github/workflows/hosted.yml; G -C "$T/kg" commit -qm delete
pin_at "$T/kgc" "$(git -C "$T/kg" rev-parse HEAD)"
expect_exit "delete alone: pin at D, SYNCED_FROM unchanged, passes" 0 "$T/kgc/scripts/pin-check.sh" --prev "$SF_S" "$T/kg" "$T/kgc"

# Paths public adds to the list between S and the delete are still ported.
addlist() { # pubdir path: public adds a hosted path (with a file) to its list
  mkdir -p "$1/$2"; echo 'new hosted svc' > "$1/$2/x.ts"; echo "$2" >> "$1/scripts/ci/private-paths.txt"
  G -C "$1" add -A; G -C "$1" commit -qm "list $2"
}
# A1: new hosted path, then delete everything; pin at D, SYNCED_FROM unchanged.
mkpub_hosted "$T/ka1"; mkc "$T/ka1" "$T/kca1"; A1S=$(git -C "$T/ka1" rev-parse HEAD)
addlist "$T/ka1" apps/hosted2
G -C "$T/ka1" rm -rq apps/hosted apps/hosted2 .github/workflows/hosted.yml; G -C "$T/ka1" commit -qm delete
pin_at "$T/kca1" "$(git -C "$T/ka1" rev-parse HEAD)"
expect_exit "A1: a hosted path added to the list then deleted, pin at D, SYNCED_FROM unchanged, fails" 1 "$T/kca1/scripts/pin-check.sh" --prev "$A1S" "$T/ka1" "$T/kca1"
check "A1 names the pre-delete change" grep -q 'before deleting' "$T/out"
# A1b: public fixes a file under a path it adds to the list in the same commit.
mkpub_hosted "$T/ka1b"; mkc "$T/ka1b" "$T/kca1b"; A1bS=$(git -C "$T/ka1b" rev-parse HEAD)
echo 'SECURITY FIX' > "$T/ka1b/apps/server/x.ts"; echo apps/server >> "$T/ka1b/scripts/ci/private-paths.txt"; G -C "$T/ka1b" add -A; G -C "$T/ka1b" commit -qm 'fix server and list it'
G -C "$T/ka1b" rm -rq apps/hosted apps/server .github/workflows/hosted.yml; G -C "$T/ka1b" commit -qm delete
pin_at "$T/kca1b" "$(git -C "$T/ka1b" rev-parse HEAD)"
expect_exit "A1b: a fix to a file whose path joins the list in the same commit, pin at D, fails" 1 "$T/kca1b/scripts/pin-check.sh" --prev "$A1bS" "$T/ka1b" "$T/kca1b"
# A2: SYNCED_FROM and pin at D; D also deletes the list file; hosted2 never ported.
mkpub_hosted "$T/ka2"; mkc "$T/ka2" "$T/kca2"; A2S=$(git -C "$T/ka2" rev-parse HEAD)
addlist "$T/ka2" apps/hosted2
G -C "$T/ka2" rm -rq apps/hosted apps/hosted2 .github/workflows/hosted.yml scripts/ci/private-paths.txt; G -C "$T/ka2" commit -qm delete
A2D=$(git -C "$T/ka2" rev-parse HEAD)
sed -i "s/^sha=.*/sha=$A2D/" "$T/kca2/SYNCED_FROM"; pin_at "$T/kca2" "$A2D"
expect_exit "A2: SYNCED_FROM and pin at D after a list add, list file deleted, hosted2 unported, fails" 1 "$T/kca2/scripts/pin-check.sh" --prev "$A2S" "$T/ka2" "$T/kca2"
check "A2 is the unported-fix failure" grep -q 'without porting' "$T/out"
# A2b: same, but D keeps the list file and drops hosted2 from it.
mkpub_hosted "$T/ka2b"; mkc "$T/ka2b" "$T/kca2b"; A2bS=$(git -C "$T/ka2b" rev-parse HEAD)
addlist "$T/ka2b" apps/hosted2
G -C "$T/ka2b" rm -rq apps/hosted apps/hosted2 .github/workflows/hosted.yml
printf 'apps/hosted\n.github/workflows/hosted.yml\n' > "$T/ka2b/scripts/ci/private-paths.txt"; G -C "$T/ka2b" add -A; G -C "$T/ka2b" commit -qm delete
A2bD=$(git -C "$T/ka2b" rev-parse HEAD)
sed -i "s/^sha=.*/sha=$A2bD/" "$T/kca2b/SYNCED_FROM"; pin_at "$T/kca2b" "$A2bD"
expect_exit "A2b: SYNCED_FROM and pin at D, D drops hosted2 from the list, hosted2 unported, fails" 1 "$T/kca2b/scripts/pin-check.sh" --prev "$A2bS" "$T/ka2b" "$T/kca2b"
# Legit: hosted2 ported, SYNCED_FROM at the list-add commit, pin at D.
mkpub_hosted "$T/ka3"; mkc "$T/ka3" "$T/kca3"; A3S=$(git -C "$T/ka3" rev-parse HEAD)
addlist "$T/ka3" apps/hosted2; A3N=$(git -C "$T/ka3" rev-parse HEAD)
G -C "$T/ka3" rm -rq apps/hosted apps/hosted2 .github/workflows/hosted.yml; G -C "$T/ka3" commit -qm delete
mkdir -p "$T/kca3/apps/hosted2"; echo 'new hosted svc' > "$T/kca3/apps/hosted2/x.ts"; git -C "$T/ka3" show "$A3N:scripts/ci/private-paths.txt" > "$T/kca3/private-paths.txt"
sed -i "s/^sha=.*/sha=$A3N/" "$T/kca3/SYNCED_FROM"; pin_at "$T/kca3" "$(git -C "$T/ka3" rev-parse HEAD)"
expect_exit "a list add ported, SYNCED_FROM at the last pre-delete commit, pin at D, passes" 0 "$T/kca3/scripts/pin-check.sh" --prev "$A3S" "$T/ka3" "$T/kca3"
# A trailing exceptions line with no newline is still read.
printf 'apps/hosted/src/index.ts %s' "$A3S" > "$T/kca3/port-exceptions.txt"
expect_exit "an exceptions file without a final newline is fully read (stale last line fails)" 1 "$T/kca3/scripts/pin-check.sh" --prev "$A3S" "$T/ka3" "$T/kca3"
rm "$T/kca3/port-exceptions.txt"

mkdir -p "$T/kc5/scripts"; cp "$PINCHK" "$LISTED" "$T/kc5/scripts/"
expect_exit "pin-check skips without SYNCED_FROM" 0 "$T/kc5/scripts/pin-check.sh" "$T/k1" "$T/kc5"
mkpub_hosted "$T/k6"; mkc "$T/k6" "$T/kc6"
sed -i 's/^sha=.*/sha=0123456789abcdef0123456789abcdef01234567/' "$T/kc6/SYNCED_FROM"
expect_exit "pin-check fails on a SYNCED_FROM commit public lacks" 1 "$T/kc6/scripts/pin-check.sh" "$T/k6" "$T/kc6"
expect_exit "pin-check bad usage exits 2" 2 "$PINCHK"
expect_exit "--prev without a value exits 2" 2 "$PINCHK" --prev

# SYNCED_FROM is required once the listed paths are here.
mkpub_hosted "$T/m1"; mkc "$T/m1" "$T/mc1"; rm "$T/mc1/SYNCED_FROM"
expect_exit "pin-check refuses (not skips) when SYNCED_FROM is deleted" 1 "$T/mc1/scripts/pin-check.sh" "$T/m1" "$T/mc1"
check "pin-check names the missing SYNCED_FROM" grep -q 'SYNCED_FROM is missing' "$T/out"
expect_exit "equivalence refuses (not skips) when SYNCED_FROM is deleted" 1 "$T/mc1/scripts/equivalence.sh" "$T/m1" "$T/mc1"
check "equivalence names the missing SYNCED_FROM" grep -q 'SYNCED_FROM is missing' "$T/out"
expect_exit "sync refuses (not first-syncs) when SYNCED_FROM is deleted" 1 "$T/mc1/scripts/sync-from-public.sh" "$T/m1"
check "sync keeps the CLOUD edit tree" [ -e "$T/mc1/apps/hosted/src/index.ts" ]
# A workflow-only tree still counts (parked under hosted-workflows/).
mkpub_hosted "$T/m2"; mkc "$T/m2" "$T/mc2"; rm "$T/mc2/SYNCED_FROM"; rm -rf "$T/mc2/apps"
expect_exit "a tree holding only a parked hosted workflow also refuses" 1 "$T/mc2/scripts/pin-check.sh" "$T/m2" "$T/mc2"
# Equivalence: dropping a whole listed path is a failure.
mkpub_hosted "$T/m3"; mkc "$T/m3" "$T/mc3"
rm -rf "$T/mc3/apps/hosted" "$T/mc3/hosted-workflows"
expect_exit "equivalence fails when whole listed paths are dropped" 1 "$T/mc3/scripts/equivalence.sh" "$T/m3" "$T/mc3"
check "the dropped path is named" grep -q 'listed path apps/hosted is gone' "$T/out"
check "the dropped workflow is named" grep -q 'listed path .github/workflows/hosted.yml is gone' "$T/out"
mkpub_hosted "$T/m4"; mkc "$T/m4" "$T/mc4"
mkdir -p "$T/mc4/.github/workflows"; mv "$T/mc4/hosted-workflows/hosted.yml" "$T/mc4/.github/workflows/hosted.yml"
rm -rf "$T/mc4/hosted-workflows"
expect_exit "a listed workflow already placed under .github/workflows passes the existence guard" 0 "$T/mc4/scripts/equivalence.sh" "$T/m4" "$T/mc4"

echo "overlay tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
