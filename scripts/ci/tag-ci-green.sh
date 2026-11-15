#!/usr/bin/env bash
# The CI guard of deploy-hosted-platform.yml: the deploy no longer re-runs the
# Workers' package tests, so it refuses unless CI already ran them, green, on
# exactly the code being deployed. Read-only (`gh api`, GH_TOKEN with contents:
# read and actions: read). Fails closed: exit 1, naming the failed check, unless
# BOTH hold:
#   1. cloud CI (this repo, ci.yml) is green on the tag's commit, which is on
#      main: the private Workers (provisioner, provisioning, dispatch,
#      scheduler, inventory, billing, admin) and their scripts. Either
#        - a completed green merge-queue run (event merge_group) whose head
#          commit has the SAME TREE as the tag's commit (same files, same
#          result), accepted at once; or
#        - the ci.yml push run on main for the tag's commit, waited for while
#          it is queued or running, and green;
#   2. public CI (PUBLIC_REPO, ci.yml) is green on the exact commit PUBLIC_PIN
#      names at the tag's commit (push or merge_group run, that head_sha): the
#      public Workers cloud CI never tests (auth-broker, directory-broker) and
#      the public packages the private ones build on.
# "Green" is the latest attempt's: the run completed, and each required job
# (REQUIRED / PUBLIC_REQUIRED below) completed with success exactly once in it.
# A missing, red or unreadable run, or any API error, is a refusal, never a pass.
# The tag resolves through its ref (peeling an annotated tag), never through a
# commit lookup by name.
# Polling: every CI_POLL_SECS (60), up to CI_WAIT_CAP_SECS (1500) in all, while
# a run is queued or in progress; refuse at once when a run completes non-green;
# refuse when a run does not appear within CI_APPEAR_SECS (300).
# Usage: scripts/ci/tag-ci-green.sh vX.Y.Z
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: $0 vX.Y.Z" >&2; exit 2; }
tag="$1"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "tag must be a stable vX.Y.Z" >&2; exit 2; }
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
PUBLIC_REPO="${PUBLIC_REPO:-open-artifacts-ai/open-artifacts}"
repo_re='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
[[ "$GITHUB_REPOSITORY" =~ $repo_re ]] || { echo "bad GITHUB_REPOSITORY" >&2; exit 2; }
[[ "$PUBLIC_REPO" =~ $repo_re ]] || { echo "bad PUBLIC_REPO" >&2; exit 2; }
C="repos/$GITHUB_REPOSITORY"
P="repos/$PUBLIC_REPO"

# This repo's ci.yml jobs (every one runs on a push to main; none is path-filtered).
REQUIRED=(scripts overlay overlay-action lint "e2e (provisioning)" "e2e (admin)")
# Public ci.yml's required checks (its test and e2e jobs aggregate the shards).
PUBLIC_REQUIRED=(lint typecheck test authz-matrix build no-test-hooks e2e)

POLL="${CI_POLL_SECS:-60}"
CAP="${CI_WAIT_CAP_SECS:-1500}"
APPEAR="${CI_APPEAR_SECS:-300}"
[[ "$POLL" =~ ^[1-9][0-9]*$ && "$CAP" =~ ^[0-9]+$ && "$APPEAR" =~ ^[0-9]+$ ]] || { echo "bad CI_POLL_SECS, CI_WAIT_CAP_SECS or CI_APPEAR_SECS" >&2; exit 2; }
max_polls=$((CAP / POLL))
appear_polls=$((APPEAR / POLL))
polls=0 # shared by both repos' waits: the cap is for the whole guard

fail() { echo "CI guard failed: $1" >&2; exit 1; }
api() {
  local body
  body="$(gh api -X GET "$2" 2> /dev/null)" || fail "$1: GitHub API error"
  jq -e . > /dev/null 2>&1 <<< "$body" || fail "$1: unparsable response"
  printf '%s' "$body"
}

# jobs_state <repo-path> <run-id> <required-job>...: prints "ok" or the first
# problem; the latest attempt's jobs only.
jobs_state() {
  local r="$1" id="$2" jobs j got
  shift 2
  jobs="$(gh api -X GET "$r/actions/runs/$id/jobs?filter=latest&per_page=100" 2> /dev/null)" || { echo "jobs: GitHub API error"; return 0; }
  jq -e '(.total_count // -1) <= (.jobs | length)' > /dev/null 2>&1 <<< "$jobs" || { echo "jobs: more than one page, or unreadable"; return 0; }
  for j in "$@"; do
    got="$(jq -r --arg n "$j" '[.jobs[] | select(.name == $n)] | if length == 1 then (if .[0].status == "completed" then (.[0].conclusion // "unknown") else "not completed" end) else "missing" end' <<< "$jobs" 2> /dev/null)" || got=unreadable
    [ "$got" = success ] || { echo "job $j: $got"; return 0; }
  done
  echo ok
}

# wait_green <label> <repo-path> <sha> <runs-query> <events-json> <required-job>...:
# the latest ci.yml run at <sha> of one of the events must complete green with
# every required job green; waits while it is queued or running.
wait_green() {
  local label="$1" r="$2" s="$3" q="$4" events="$5" run id status st appear=0
  shift 5
  while :; do
    run="$(api "$label run" "$r/actions/workflows/ci.yml/runs?$q&head_sha=$s&per_page=100" |
      jq -c --arg s "$s" --argjson ev "$events" '[.workflow_runs[] | select(.head_sha == $s and (.event as $e | $ev | index($e)))] | sort_by(.created_at) | last // empty')" ||
      fail "$label run: unreadable"
    if [ -z "$run" ]; then
      [ "$appear" -lt "$appear_polls" ] || fail "no $label push/merge-queue run for $s after ${APPEAR}s"
      appear=$((appear + 1))
    else
      id="$(jq -r '.id' <<< "$run")"
      [[ "$id" =~ ^[0-9]+$ ]] || fail "$label run: bad id"
      status="$(jq -r '.status' <<< "$run")"
      if [ "$status" = completed ]; then
        [ "$(jq -r '.conclusion' <<< "$run")" = success ] || fail "$label run $id for $s: $(jq -r '.conclusion' <<< "$run")"
        st="$(jobs_state "$r" "$id" "$@")"
        [ "$st" = ok ] || fail "$label run $id for $s: $st"
        echo "CI guard: $label run $id is green on $s"
        return 0
      fi
      case "$status" in queued | in_progress | waiting | pending | requested) ;; *) fail "$label run $id for $s: unexpected status $status" ;; esac
      [ "$polls" -lt "$max_polls" ] || fail "$label run $id for $s still $status after ${CAP}s"
      echo "CI guard: $label run $id for $s is $status; waiting ${POLL}s"
    fi
    polls=$((polls + 1))
    sleep "$POLL"
  done
}

# The tag's commit, through the tag ref; an annotated tag is peeled to its commit.
obj="$(api "ref of $tag" "$C/git/ref/tags/$tag" | jq -c '.object // empty')"
for _ in 1 2 3; do
  [ "$(jq -r '.type // empty' <<< "$obj")" = tag ] || break
  obj="$(api "tag object of $tag" "$C/git/tags/$(jq -r '.sha // empty' <<< "$obj")" | jq -c '.object // empty')"
done
[ "$(jq -r '.type // empty' <<< "$obj")" = commit ] || fail "$tag: does not point at a commit"
sha="$(jq -r '.sha // empty' <<< "$obj")"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "commit of $tag: not found"
cmp="$(api "$tag on main" "$C/compare/main...$sha" | jq -r '.status // empty')"
case "$cmp" in identical | behind) ;; *) fail "$tag on main: $sha is not on main ($cmp)" ;; esac

# Same files, same result: a green merge-queue run whose head commit has the
# SAME TREE as the tag's commit tested exactly the tag's files. Any problem
# reading it, or no match, falls back to the push run; this only adds a pass.
mg_green() {
  local tree runs rid head htree st
  tree="$(gh api -X GET --jq '.tree.sha // empty' "$C/git/commits/$sha" 2> /dev/null)" || return 1
  [[ "$tree" =~ ^[0-9a-f]{40}$ ]] || return 1
  runs="$(gh api -X GET --jq '[.workflow_runs[] | select(.event == "merge_group" and .status == "completed" and .conclusion == "success") | {id, head_sha}] | .[:30][] | "\(.id) \(.head_sha)"' "$C/actions/workflows/ci.yml/runs?event=merge_group&status=success&per_page=30" 2> /dev/null)" || return 1
  while read -r rid head; do
    [[ "$rid" =~ ^[0-9]+$ && "$head" =~ ^[0-9a-f]{40}$ ]] || continue
    htree="$(gh api -X GET --jq '.tree.sha // empty' "$C/git/commits/$head" 2> /dev/null)" || continue
    [ "$htree" = "$tree" ] || continue
    st="$(jobs_state "$C" "$rid" "${REQUIRED[@]}")"
    [ "$st" = ok ] || continue
    echo "CI guard: $tag ($sha) has the tree $tree that merge-queue CI run $rid (head $head) passed"
    return 0
  done <<< "$runs"
  return 1
}
if ! mg_green; then
  wait_green "cloud CI" "$C" "$sha" "branch=main&event=push" '["push"]' "${REQUIRED[@]}"
fi

# Public CI on the exact public commit this tag's code is built on (PUBLIC_PIN
# at the tag's commit). Public has no push to main: its main commits are the
# merge queue's commits, so a merge_group run (or a push run) at that sha counts.
pin="$(gh api -X GET -H "Accept: application/vnd.github.raw+json" "$C/contents/PUBLIC_PIN?ref=$sha" 2> /dev/null)" || fail "PUBLIC_PIN at $sha: GitHub API error"
psha="$(printf '%s\n' "$pin" | sed -n 's/^sha=//p')"
[[ "$psha" =~ ^[0-9a-f]{40}$ ]] || fail "PUBLIC_PIN at $sha: no sha"
wait_green "public CI" "$P" "$psha" "per_page=100" '["push","merge_group"]' "${PUBLIC_REQUIRED[@]}"

echo "CI guard: $tag ($sha) passed cloud CI and public CI ($psha)"
