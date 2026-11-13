#!/usr/bin/env bash
# equivalence.sh <public-checkout-dir> [<private-dir>]
#
# Proves this repo changes nothing outside its private paths. With S the
# commit in SYNCED_FROM, it builds overlay(PUB@S minus the private paths, this
# repo) in a temp dir and diffs that tree against PUB@S.
#
# Decision (README, "CLOUD owns the private paths"): after the one-time sync
# (B1) this repo owns the private paths and edits them (C1 renames repo pins
# inside them), so they are NOT compared to PUB@S. Every other path stays
# strict: any difference outside the private paths and ALLOW below fails, a
# non-private file the overlay dropped, added or changed. The private paths are
# the list the overlay used (public's at S, else this repo's). The lockfile
# is still checked importer by importer.
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
#
# .github/workflows/hosted-release.yml is this repo's own workflow (#1056 C3):
# public has no such file, so it is an extra in the overlay tree by design. It
# is listed by exact path so that any other new workflow still fails.
# The same holds for the pin-bump opener (cloud #20): a workflow, its script and
# its test that public never had and the private-paths list (public's, at S)
# does not name. So does the hosted-release alert (#1782), named apart from
# public's release-alert.yml so the two never share a path in the overlay.
# And the billing database's migration runner for the staging deploy (#1568):
# a script and its test that public never had (the deploy scripts that call it
# are in the private list, this pair is not). And prod's bring-up guards (the
# TIER check before BILLING binds, the live-mode price check): two more such
# script and test pairs.
# And the staging Solo test-clock workflow with its script and test (M2 step 8):
# new hosted files that public never had.
# And the T19 dry-run workflow (#166): a workflow that public never had.
ALLOW=(
  pnpm-lock.yaml
  .github/workflows/hosted-release.yml
  .github/workflows/pin-bump.yml
  .github/workflows/hosted-release-alert.yml
  scripts/ci/pin-bump.ts
  scripts/ci/pin-bump.test.ts
  scripts/ci/hosted-release-alert.test.ts
  scripts/ops/billing-db.ts
  scripts/ops/billing-db.test.ts
  scripts/ops/billing-tier-check.ts
  scripts/ops/billing-tier-check.test.ts
  scripts/ops/stripe-price-livemode.ts
  scripts/ops/stripe-price-livemode.test.ts
  .github/workflows/staging-solo-clock.yml
  scripts/ops/staging-solo-clock.ts
  scripts/ops/staging-solo-clock.test.ts
  .github/workflows/staging-team-proof.yml
  scripts/ops/staging-team-proof.ts
  scripts/ops/staging-team-proof.test.ts
  .github/workflows/staging-portal-config.yml
  scripts/ops/staging-portal-config.ts
  scripts/ops/staging-portal-config.test.ts
  .github/workflows/staging-stripe-prices.yml
  scripts/ops/stripe-prices.ts
  scripts/ops/stripe-prices.test.ts
  # Real v0.154.0 wrangler configs (#172): fixtures for the tag-aware deploy
  # read-backs, this repo's own. diff -rq reports a wholly extra directory by
  # its own path, so the entry is exact.
  scripts/ops/test-fixtures
  # The read-only Turnstile widget check (#179), this repo's own.
  scripts/ci/turnstile-domains.sh
  scripts/ci/turnstile-domains.test.ts
  .github/workflows/t19-dry-run.yml
)

die() { echo "equivalence: $*" >&2; exit 1; }
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { echo "usage: equivalence.sh <public-checkout-dir> [<private-dir>]" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd) || exit 2
PRIV=$(cd "${2:-$HERE/..}" 2> /dev/null && pwd) || die "private dir not found: ${2:-$HERE/..}"

if [ ! -e "$PRIV/SYNCED_FROM" ] && [ ! -L "$PRIV/SYNCED_FROM" ]; then
  held=$("$HERE/listed-present.sh" "$1" "$PRIV") || die "cannot list present paths"
  [ -z "$held" ] || die "SYNCED_FROM is missing but this tree holds listed private paths:
$(printf '%s\n' "$held" | sed 's/^/  /')
SYNCED_FROM is required once the paths are synced; restore it."
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

# What the cut-over does: parked hosted workflows go live (the shared helper
# CI uses too). A target that already exists is a failure, not a difference.
"$HERE/place-workflows.sh" "$priv" "$work" > /dev/null || die "cannot place hosted workflows (place-workflows.sh)"

# The private path list the overlay used (public's at S, else this repo's).
if [ -f "$ref/scripts/ci/private-paths.txt" ]; then plist="$ref/scripts/ci/private-paths.txt"; else plist="$priv/private-paths.txt"; fi
private=()
while IFS= read -r line || [ -n "$line" ]; do
  q=${line%%#*}
  q=$(printf '%s' "$q" | sed 's/[[:space:]]*$//; s/^[[:space:]]*//')
  [ -n "$q" ] && private+=("${q%/}")
done < "$plist"

# Every listed path must still exist in CLOUD: at its own path or, for a hosted
# workflow, under hosted-workflows/ or .github/workflows/. Deletions inside a
# path stay CLOUD's call. Dropping a whole listed path is not.
missing=0
for q in "${private[@]}"; do
  if [ -e "$PRIV/$q" ] || [ -L "$PRIV/$q" ]; then continue; fi
  if [[ "$q" == .github/workflows/* ]]; then
    wf="hosted-workflows/${q#.github/workflows/}"
    if [ -e "$PRIV/$wf" ] || [ -L "$PRIV/$wf" ]; then continue; fi
  fi
  echo "equivalence: DIFF: listed path $q is gone from this repo (CLOUD must keep every listed path)" >&2
  missing=$((missing + 1))
done
[ "$missing" -eq 0 ] || die "$missing listed private path(s) missing from this repo"

is_private() { # importer key or path
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
bad=0 seen=0 owned=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  side=
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
  if is_private "$path"; then owned=$((owned + 1)); continue; fi   # CLOUD-owned
  # A directory only the overlay has (public deleted its hosted code, so a listed
  # path's parent is gone from public) is CLOUD-owned when every file under it is.
  if [ "${side:-}" = work ] && [ -d "$work/$path" ] && [ ! -L "$work/$path" ]; then
    own=1
    while IFS= read -r f; do
      is_private "$path/$f" || { own=0; break; }
    done < <(cd "$work/$path" && find . \( -type f -o -type l \) -print | sed 's|^\./||')
    if [ "$own" -eq 1 ]; then owned=$((owned + 1)); continue; fi
  fi
  seen=$((seen + 1))
  if allowed "$path"; then
    if [ "$path" = pnpm-lock.yaml ]; then check_lock || bad=$((bad + 1)); fi
    continue
  fi
  echo "equivalence: DIFF: $path ($kind)" >&2
  bad=$((bad + 1))
done <<< "$diffs"

# Repo-only GitHub config: overlay.sh never overlays this file (public holds
# it too), so the diff above cannot see it. It must be byte-identical to
# public@S, and public@S must hold it.
rf=.github/ISSUE_TEMPLATE/blocker.yml
{
  if [ -e "$PRIV/$rf" ] || [ -L "$PRIV/$rf" ]; then
    if [ -L "$PRIV/$rf" ] || [ ! -f "$PRIV/$rf" ] || [ ! -f "$ref/$rf" ] || ! cmp -s "$PRIV/$rf" "$ref/$rf"; then
      echo "equivalence: DIFF: $rf (repo-only config must be a regular file identical to public's at $sha)" >&2
      bad=$((bad + 1))
    fi
  fi
}

# diff -rq ignores permissions: compare the executable bit.
execs() { (cd "$1" && find . -path ./.git -prune -o -type f -perm /111 -print | sed 's|^\./||' | LC_ALL=C sort); }
while IFS= read -r path; do
  [ -n "$path" ] || continue
  is_private "$path" && continue   # CLOUD-owned: its mode is its own
  # Only paths in both trees: others are reported above.
  [ -f "$ref/$path" ] && [ -f "$work/$path" ] || continue
  echo "equivalence: DIFF: $path (executable bit differs)" >&2
  bad=$((bad + 1))
done < <(comm -3 <(execs "$ref") <(execs "$work") | sed 's/^[[:space:]]*//')

if [ "$bad" -gt 0 ]; then
  die "$bad difference(s) outside the allowlist between overlay and public $tag ($sha)"
fi
echo "equivalence: OK: overlay(public@$sha minus private paths, this repo) matches public outside the private paths ($seen allowlisted difference(s); $owned CLOUD-owned difference(s) in the ${#private[@]} private path(s) not compared)"
