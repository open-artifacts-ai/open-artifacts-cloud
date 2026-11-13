#!/usr/bin/env bash
# The release gate of deploy-hosted-platform.yml: a tag deploys to an env only
# after every earlier check on it passed. Read-only (`gh api`, GH_TOKEN with
# contents: read and actions: read). Fails closed: exit 1, naming the failed
# check, unless all of these hold:
#   - the tag is a published, non-draft, non-prerelease GitHub release;
#   - the tag's commit is on main;
#   - the release workflow's push run for that commit exists, and in it every
#     job the deploy depends on (REQUIRED below) completed with success;
#   - the release has at least one oa-release-<env>-* asset.
# An API or network error is a failure, never a pass.
#
# Two repos (#1056). GITHUB_REPOSITORY is where this gate runs; PUBLIC_REPO
# (default open-artifacts-ai/open-artifacts) is the public repo.
#   split mode: GITHUB_REPOSITORY holds a release for the tag. The hosted jobs
#     (hosted-release.yml: mirror, hosted-guard, hosted-build, hosted-check,
#     hosted-sign-<env>, hosted-attach-<env>) and the oa-release-<env>-* assets
#     are read there; the public release, its commit on public main and
#     public's release-please run (jobs release-please and verify-release) are
#     read from PUBLIC_REPO. The two are tied: PUBLIC_PIN at the hosted commit
#     must name the public tag and its commit. A dry run of hosted-release.yml
#     (run name "(dry run)") never counts.
#   legacy mode: a tag GITHUB_REPOSITORY has no release for (404), or a gate
#     running in PUBLIC_REPO itself. Before the split the hosted jobs and
#     assets live in the public repo's release-please run, so everything is
#     read there, as before. Any other API error is a failure, never legacy.
# Usage: scripts/ci/tag-passed-checks.sh staging|prod vX.Y.Z
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 staging|prod vX.Y.Z" >&2
  exit 2
fi
env="$1"
tag="$2"
case "$env" in staging | prod) ;; *) echo "env must be staging or prod" >&2; exit 2 ;; esac
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "tag must be a stable vX.Y.Z" >&2; exit 2; }
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
PUBLIC_REPO="${PUBLIC_REPO:-open-artifacts-ai/open-artifacts}"
repo_re='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
[[ "$GITHUB_REPOSITORY" =~ $repo_re ]] || { echo "bad GITHUB_REPOSITORY" >&2; exit 2; }
[[ "$PUBLIC_REPO" =~ $repo_re ]] || { echo "bad PUBLIC_REPO" >&2; exit 2; }
C="repos/$GITHUB_REPOSITORY"
P="repos/$PUBLIC_REPO"

fail() { echo "release gate failed: $1" >&2; exit 1; }
# api <check> <path>: the JSON body, or fail naming the check.
api() {
  local body
  body="$(gh api -X GET "$2" 2> /dev/null)" || fail "$1: GitHub API error"
  jq -e . > /dev/null 2>&1 <<< "$body" || fail "$1: unparsable response"
  printf '%s' "$body"
}
# raw <check> <path>: the raw text of a file, or fail naming the check.
raw() {
  gh api -X GET -H "Accept: application/vnd.github.raw+json" "$2" 2> /dev/null || fail "$1: GitHub API error"
}

# check_release <check-name> <repo-path> <release-json>: the release is
# published; sets `sha`, the tag's commit, once it is on main.
check_release() {
  local name="$1" r="$2" rel="$3" cmp
  [ "$(jq -r '.tag_name' <<< "$rel")" = "$tag" ] || fail "release $tag: not found"
  [ "$(jq -r '.draft' <<< "$rel")" = false ] || fail "release $tag: is a draft"
  [ "$(jq -r '.prerelease' <<< "$rel")" = false ] || fail "release $tag: is a prerelease"
  [ -n "$(jq -r '.published_at // empty' <<< "$rel")" ] || fail "release $tag: not published"

  sha="$(api "$name" "$r/commits/$tag" | jq -r '.sha // empty')"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "$name: not found"

  # The tag's commit is main or behind it: an ancestor of main.
  cmp="$(api "$tag on main" "$r/compare/main...$sha" | jq -r '.status // empty')"
  case "$cmp" in identical | behind) ;; *) fail "$tag on main: $sha is not on main ($cmp)" ;; esac
}

# check_run <workflow-file> <repo-path> <sha> <events-json> <skip-dry-runs>:
# sets `run_id` to the latest push (or listed event) run for the commit.
check_run() {
  local wf="$1" r="$2" s="$3" events="$4" skipdry="$5" run
  local label="${wf%.yml}"
  run="$(api "$label run" "$r/actions/workflows/$wf/runs?branch=main&head_sha=$s&per_page=100" |
    jq -c --arg s "$s" --argjson ev "$events" --arg skip "$skipdry" '[.workflow_runs[] | select(.head_sha == $s and (.event as $e | $ev | index($e))) | select($skip != "yes" or ((.display_title // "") | contains("(dry run)") | not))] | sort_by(.created_at) | last // empty')"
  [ -n "$run" ] || fail "$label run: no push run for $s"
  run_id="$(jq -r '.id' <<< "$run")"
  [[ "$run_id" =~ ^[0-9]+$ ]] || fail "$label run: bad id"
}

# check_jobs <workflow-file> <repo-path> <run-id> <required-job>...: each
# required job completed with success, and no other job in the run failed
# (NONBLOCKING_JOBS excepted).
check_jobs() {
  local wf="$1" r="$2" id="$3" jobs j got bad
  shift 3
  local label="${wf%.yml}"
  jobs="$(api "$label jobs" "$r/actions/runs/$id/jobs?filter=latest&per_page=100")"
  # One page of 100 must hold every job; otherwise a required job could hide on a later page.
  jq -e '(.total_count // -1) <= (.jobs | length)' > /dev/null <<< "$jobs" || fail "$label jobs: more than one page of jobs"
  for j in "$@"; do
    got="$(jq -r --arg n "$j" '[.jobs[] | select(.name == $n)] | if length == 1 then (if .[0].status == "completed" then (.[0].conclusion // "unknown") else "not completed (" + (.[0].status // "unknown") + ")" end) else "missing" end' <<< "$jobs")"
    [ "$got" = success ] || fail "job $j: $got"
  done
  bad="$(jq -r --argjson npm "$(printf '%s\n' "${NONBLOCKING_JOBS[@]}" | jq -R . | jq -sc .)" '[.jobs[] | select(.name as $n | $npm | index($n) | not) | select(.status != "completed" or (.conclusion != "success" and .conclusion != "skipped")) | .name + ": " + (if .status != "completed" then "not completed (" + (.status // "unknown") + ")" else (.conclusion // "unknown") end)] | first // empty' <<< "$jobs")" || fail "$label jobs: unreadable"
  [ -z "$bad" ] || fail "job $bad"
}

# check_assets <release-json>
check_assets() {
  local n
  n="$(jq --arg p "oa-release-$env-" '[.assets[] | select((.name | startswith($p)) and .state == "uploaded")] | length' <<< "$1")"
  [ "$n" -gt 0 ] || fail "assets: no oa-release-$env-* asset on $tag"
}

# The jobs the deploy depends on. The run's own conclusion is deliberately not
# required: pack-npm and publish-npm (npm packaging, #1455) are not a
# dependency of the hosted deploy, so an npm auth hiccup there must not block
# staging and prod releases (v0.122.0 was blocked that way). Each listed job
# must be present exactly once, completed, and concluded success; missing,
# skipped, cancelled, running or unknown statuses all block. Every other job in
# the run (deploy-prod, a job added later) must be completed with success or
# skipped (deploy-demo is skipped when DEMO_ENABLED is off), so the only jobs
# allowed to fail are NONBLOCKING_JOBS: the npm jobs, and deploy-landing, which
# goes red on purpose while hosted sign-ups are closed (the public repo's
# sign-up probe, #2139) and is not a dependency of the hosted deploy.
NONBLOCKING_JOBS=(pack-npm publish-npm deploy-landing)
LEGACY_REQUIRED=(
  release-please
  verify-release
  hosted-guard
  hosted-build
  hosted-check
  "hosted-sign-$env"
  "hosted-attach-$env"
)
PUBLIC_REQUIRED=(release-please verify-release)
HOSTED_REQUIRED=(
  mirror
  hosted-guard
  hosted-build
  hosted-check
  "hosted-sign-$env"
  "hosted-attach-$env"
)

# Which mode: a release for the tag in this repo means split (crel set). Only a 404 means
# there is none; anything else is an error.
crel=""
if [ "$GITHUB_REPOSITORY" != "$PUBLIC_REPO" ]; then
  # stderr joins stdout: on success the body is JSON, on failure it is the error text.
  if crel="$(gh api -X GET "$C/releases/tags/$tag" 2>&1)"; then
    jq -e . > /dev/null 2>&1 <<< "$crel" || fail "release $tag: unparsable response"
  elif grep -q "HTTP 404" <<< "$crel"; then
    crel=""
  else
    fail "release $tag: GitHub API error"
  fi
fi

if [ -z "$crel" ]; then
  rel="$(api "release $tag" "$P/releases/tags/$tag")"
  check_release "commit of $tag" "$P" "$rel"
  check_run release-please.yml "$P" "$sha" '["push"]' no
  check_jobs release-please.yml "$P" "$run_id" "${LEGACY_REQUIRED[@]}"
  check_assets "$rel"
  echo "release gate: $tag passed every check for $env (commit $sha, run $run_id)"
  exit 0
fi

# split mode: the public half...
prel="$(api "release $tag" "$P/releases/tags/$tag")"
check_release "commit of $tag" "$P" "$prel"
psha="$sha"
check_run release-please.yml "$P" "$psha" '["push"]' no
prun="$run_id"
check_jobs release-please.yml "$P" "$prun" "${PUBLIC_REQUIRED[@]}"
# ...and the hosted half.
check_release "commit of $tag in $GITHUB_REPOSITORY" "$C" "$crel"
csha="$sha"
check_run hosted-release.yml "$C" "$csha" '["push","workflow_dispatch"]' yes
crun="$run_id"
check_jobs hosted-release.yml "$C" "$crun" "${HOSTED_REQUIRED[@]}"
check_assets "$crel"
# The hosted commit must be built on exactly this public release.
pin="$(raw "PUBLIC_PIN at $csha" "$C/contents/PUBLIC_PIN?ref=$csha")"
[ "$(printf '%s\n' "$pin" | sed -n 's/^tag=//p')" = "$tag" ] || fail "PUBLIC_PIN at $csha: not $tag"
[ "$(printf '%s\n' "$pin" | sed -n 's/^sha=//p')" = "$psha" ] || fail "PUBLIC_PIN at $csha: not public commit $psha"

echo "release gate: $tag passed every check for $env (public commit $psha, run $prun; hosted commit $csha, run $crun)"
