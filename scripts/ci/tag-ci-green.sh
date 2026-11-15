#!/usr/bin/env bash
# The CI guard of deploy-hosted-platform.yml: the deploy no longer re-runs the
# Workers' package tests, so it refuses unless CI already ran them, green, on
# exactly the tag's commit. Read-only (`gh api`, GH_TOKEN with contents: read
# and actions: read). Fails closed: exit 1, naming the failed check, unless:
#   - the tag resolves to a commit of this repo (GITHUB_REPOSITORY, the cloud
#     repo whose tag is deployed) that is on main;
#   - ci.yml has a push run on main for that exact commit that completes with
#     conclusion success (so no job failed or was cancelled); a run still
#     queued or running is waited for (see the polling below);
#   - in that run each required job (REQUIRED below: the checks branch
#     protection requires) completed with success, exactly once.
# A missing, running, red or unreadable run, or any API error, is a refusal,
# never a pass.
# Usage: scripts/ci/tag-ci-green.sh vX.Y.Z
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: $0 vX.Y.Z" >&2; exit 2; }
tag="$1"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "tag must be a stable vX.Y.Z" >&2; exit 2; }
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "bad GITHUB_REPOSITORY" >&2; exit 2; }
C="repos/$GITHUB_REPOSITORY"

# ci.yml's jobs (every one runs on a push to main; none is path-filtered).
REQUIRED=(scripts overlay overlay-action lint "e2e (provisioning)" "e2e (admin)")

fail() { echo "CI guard failed: $1" >&2; exit 1; }
api() {
  local body
  body="$(gh api -X GET "$2" 2> /dev/null)" || fail "$1: GitHub API error"
  jq -e . > /dev/null 2>&1 <<< "$body" || fail "$1: unparsable response"
  printf '%s' "$body"
}

sha="$(api "commit of $tag" "$C/commits/$tag" | jq -r '.sha // empty')"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "commit of $tag: not found"
cmp="$(api "$tag on main" "$C/compare/main...$sha" | jq -r '.status // empty')"
case "$cmp" in identical | behind) ;; *) fail "$tag on main: $sha is not on main ($cmp)" ;; esac

# The push CI run may still be queued or running (the release chain dispatches
# the deploy while main's CI is going): wait for it. Poll every CI_POLL_SECS
# (60) for up to CI_WAIT_CAP_SECS (1500) while it is queued or in progress;
# refuse at once when it completes non-green; refuse when no run appears within
# CI_APPEAR_SECS (300) or the cap passes. The run's own status and conclusion
# are those of its latest attempt (a re-run counts, not the failed attempt).
POLL="${CI_POLL_SECS:-60}"
CAP="${CI_WAIT_CAP_SECS:-1500}"
APPEAR="${CI_APPEAR_SECS:-300}"
[[ "$POLL" =~ ^[1-9][0-9]*$ && "$CAP" =~ ^[0-9]+$ && "$APPEAR" =~ ^[0-9]+$ ]] || { echo "bad CI_POLL_SECS, CI_WAIT_CAP_SECS or CI_APPEAR_SECS" >&2; exit 2; }
max_polls=$((CAP / POLL))
appear_polls=$((APPEAR / POLL))
polls=0
while :; do
  run="$(api "ci run" "$C/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=$sha&per_page=100" |
    jq -c --arg s "$sha" '[.workflow_runs[] | select(.head_sha == $s and .event == "push")] | sort_by(.created_at) | last // empty')" ||
    fail "ci run: unreadable"
  if [ -z "$run" ]; then
    [ "$polls" -lt "$appear_polls" ] || fail "no CI push run on main for $sha after ${APPEAR}s"
  else
    id="$(jq -r '.id' <<< "$run")"
    [[ "$id" =~ ^[0-9]+$ ]] || fail "ci run: bad id"
    status="$(jq -r '.status' <<< "$run")"
    if [ "$status" = completed ]; then
      [ "$(jq -r '.conclusion' <<< "$run")" = success ] || fail "CI run $id for $sha: $(jq -r '.conclusion' <<< "$run")"
      break
    fi
    case "$status" in queued | in_progress | waiting | pending | requested) ;; *) fail "CI run $id for $sha: unexpected status $status" ;; esac
    [ "$polls" -lt "$max_polls" ] || fail "CI run $id for $sha still $status after ${CAP}s"
    echo "CI run $id for $sha is $status; waiting ${POLL}s"
  fi
  polls=$((polls + 1))
  sleep "$POLL"
done

jobs="$(api "ci jobs" "$C/actions/runs/$id/jobs?filter=latest&per_page=100")"
jq -e '(.total_count // -1) <= (.jobs | length)' > /dev/null <<< "$jobs" || fail "ci jobs: more than one page of jobs"
for j in "${REQUIRED[@]}"; do
  got="$(jq -r --arg n "$j" '[.jobs[] | select(.name == $n)] | if length == 1 then (if .[0].status == "completed" then (.[0].conclusion // "unknown") else "not completed" end) else "missing" end' <<< "$jobs")"
  [ "$got" = success ] || fail "CI job $j: $got"
done

echo "CI guard: $tag ($sha) passed CI on main (run $id)"
