#!/usr/bin/env bash
# The resolve job of hosted-publish.yml (design v7 6.4): what to publish to
# which env's releases bucket, as GITHUB_OUTPUT lines kind (release, floor or
# none), tag, floor_run_id, staging and prod (true or false).
#   workflow_run (release-please on main, any conclusion but cancelled): the
#     release whose tag's commit is the commit the run built, to staging only: prod
#     waits for staging's red-line (#1412) and is published by
#     prod-release-chain.yml, so this run never fails red on prod;
#     none is kind=none (most pushes cut no release), exit 0. A failed run is
#     not refused here: the publish jobs' tag-passed-checks.sh decides, and
#     fails closed on any required job that did not succeed (v0.122.0: only
#     publish-npm failed, and the run's conclusion must not block the release).
#   workflow_dispatch: exactly one of TAG (vX.Y.Z; DEPLOY_ENV both or unset for both;
#     prod alone needs the tag's staging publish first, see staged) or
#     FLOOR_RUN_ID (a hosted-floor.yml run id; DEPLOY_ENV required).
# Read-only (`gh api`); an API error is exit 1, never "no release".
#     The built release is the one named by the run's "hosted-built <tag> <sha>"
#     job (hosted-release.yml, #459): a dispatch on main's head that rebuilt an
#     older tag's commit has a different head_sha. The tag must be a published
#     release whose commit is still <sha>, or the run refuses. A run without
#     that job (a failed guard, an older run) falls back to the release whose
#     tag is at its head_sha, read across every page of tags and releases.
# Env: EVENT, HEAD_SHA, RUN_ID, HEAD_BRANCH, CONCLUSION (workflow_run); TAG,
# DEPLOY_ENV, FLOOR_RUN_ID (dispatch); GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT.
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
R="repos/$GITHUB_REPOSITORY"
out() {
  { echo "kind=$1"; echo "tag=$2"; echo "floor_run_id=$3"; echo "staging=$4"; echo "prod=$5"; } >> "$GITHUB_OUTPUT"
  echo "publish: kind=$1 tag=${2:-none} floor_run_id=${3:-none} staging=$4 prod=$5"
}
stable='^v[0-9]+\.[0-9]+\.[0-9]+$'
# on_main <sha> <what>: the commit is main's or an ancestor of it. head_branch
# is only a name (a tag called main matches it), so the run's head_sha must be
# on main: compare/main...<sha> is "behind" or "identical". Any other status,
# a missing sha or an API error is exit 1.
on_main() {
  local st
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || { echo "$2 has no head_sha; refusing" >&2; exit 1; }
  st="$(gh api -X GET "$R/compare/main...$1" 2> /dev/null | jq -r '.status // ""' 2> /dev/null)" ||
    { echo "comparing $2's head_sha with main failed; refusing" >&2; exit 1; }
  case "$st" in
    behind | identical) ;;
    *) echo "$2's head_sha $1 is not on main (${st:-no status}); refusing" >&2; exit 1 ;;
  esac
}
# staged <tag>: staging first for a release dispatched to prod alone. The
# tag's staging publish record must exist: a completed hosted-publish.yml run
# on main (its head_sha on main, see on_main), of this repository, whose
# publish-staging job (named "publish-staging release <tag>" by the workflow)
# succeeded. Exit 1 when
# there is none or on any API error.
staged() {
  local runs ids id sha jobs n
  : "${GH_TOKEN:?GH_TOKEN is required}"
  runs="$(gh api -X GET "$R/actions/workflows/hosted-publish.yml/runs?branch=main&status=completed&per_page=100" 2> /dev/null)" ||
    { echo "listing hosted-publish.yml runs failed" >&2; exit 1; }
  ids="$(jq -r --arg repo "$GITHUB_REPOSITORY" '.workflow_runs
    | if type == "array" then . else error("no runs") end
    | .[] | select(.head_branch == "main" and .status == "completed" and (.head_repository.full_name // "") == $repo) | "\(.id):\(.head_sha // "")"' <<< "$runs")" ||
    { echo "listing hosted-publish.yml runs failed: unparsable" >&2; exit 1; }
  for id in $ids; do
    sha="${id#*:}"
    id="${id%%:*}"
    [[ "$id" =~ ^[1-9][0-9]{0,19}$ ]] || { echo "listing hosted-publish.yml runs failed: a bad run id" >&2; exit 1; }
    jobs="$(gh api -X GET "$R/actions/runs/$id/jobs?per_page=100" 2> /dev/null)" ||
      { echo "reading run $id's jobs failed" >&2; exit 1; }
    n="$(jq -r --arg n "publish-staging release $1" '[.jobs[] | select(.name == $n and .conclusion == "success")] | length' <<< "$jobs" 2> /dev/null)" ||
      { echo "reading run $id's jobs failed: unparsable" >&2; exit 1; }
    if [ "$n" -gt 0 ]; then
      # The record counts only from a run of main's own workflow file.
      on_main "$sha" "hosted-publish.yml run $id"
      echo "staging first: $1 was published to staging (run $id)"
      return 0
    fi
  done
  echo "staging first: $1 has no successful staging publish (hosted-publish.yml on main); publish it to staging first, then rerun" >&2
  exit 1
}

case "${EVENT:-}" in
  workflow_run)
    if [ "${CONCLUSION:-}" = cancelled ] || [ "${HEAD_BRANCH:-}" != main ]; then
      echo "release-please was cancelled or not on main; nothing to publish"
      out none "" "" false false
      exit 0
    fi
    [[ "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "HEAD_SHA is not a commit sha" >&2; exit 1; }
    : "${GH_TOKEN:?GH_TOKEN is required}"
    found=""
    if [ -n "${RUN_ID:-}" ]; then
      [[ "$RUN_ID" =~ ^[1-9][0-9]{0,19}$ ]] || { echo "RUN_ID is not a run id" >&2; exit 1; }
      rjobs="$(gh api -X GET "$R/actions/runs/$RUN_ID/jobs?filter=latest&per_page=100" 2> /dev/null)" || { echo "reading run $RUN_ID's jobs failed" >&2; exit 1; }
      names="$(jq -r '.jobs | if type == "array" then . else error("no jobs") end | .[] | select(.conclusion == "success") | .name' <<< "$rjobs" 2> /dev/null)" ||
        { echo "reading run $RUN_ID's jobs failed: unparsable" >&2; exit 1; }
      marker="$(grep -m 1 -E '^hosted-built v[0-9]+\.[0-9]+\.[0-9]+ [0-9a-f]{40}$' <<< "$names" || true)"
    fi
    if [ -n "${marker:-}" ]; then
      # The run names the tag and commit it built: both must hold now, or
      # refuse (never fall back to head_sha, which is main's newer commit).
      read -r _ mtag msha <<< "$marker"
      rel="$(gh api -X GET "$R/releases/tags/$mtag" 2> /dev/null)" || { echo "run $RUN_ID built $mtag, but reading its release failed" >&2; exit 1; }
      [ "$(jq -r '(.draft == false and .prerelease == false and (.published_at // "") != "") | tostring' <<< "$rel" 2> /dev/null)" = true ] ||
        { echo "run $RUN_ID built $mtag, but it is not a published release" >&2; exit 1; }
      sha="$(gh api -X GET "$R/commits/$mtag" 2> /dev/null | jq -r '.sha // ""')" || { echo "reading $mtag's commit failed" >&2; exit 1; }
      [ "$sha" = "$msha" ] || { echo "run $RUN_ID built $mtag at $msha, but $mtag is at ${sha:-nothing}; refusing" >&2; exit 1; }
      found="$mtag"
      built="$msha"
    else
      # No hosted-built job (a failed guard, a run from before #459): the
      # release whose tag is at the run's head. Every tag and release is read,
      # page by page, so an old release is found too.
      built="$HEAD_SHA"
      tags="$(gh api -X GET --paginate "$R/tags?per_page=100" 2> /dev/null)" || { echo "listing tags failed" >&2; exit 1; }
      at="$(jq -r --arg b "$built" '.[] | select(.commit.sha == $b) | .name' <<< "$tags" 2> /dev/null)" || { echo "listing tags failed: unparsable" >&2; exit 1; }
      if [ -n "$at" ]; then
        rels="$(gh api -X GET --paginate "$R/releases?per_page=100" 2> /dev/null)" || { echo "listing releases failed" >&2; exit 1; }
        pub="$(jq -r '.[] | select(.draft == false and .prerelease == false) | .tag_name' <<< "$rels" 2> /dev/null)" ||
          { echo "listing releases failed: unparsable" >&2; exit 1; }
        while IFS= read -r t; do
          [[ "$t" =~ $stable ]] || continue
          if grep -qxF -- "$t" <<< "$pub"; then found="$t"; break; fi
        done <<< "$at"
      fi
    fi
    if [ -z "$found" ]; then
      echo "no release at $built; nothing to publish"
      out none "" "" false false
      exit 0
    fi
    echo "::notice title=Prod publish waits::$found goes to staging now; prod's bucket gets it after staging's red-line passes (prod-release-chain.yml)"
    out release "$found" "" true false
    ;;
  workflow_dispatch)
    tag="${TAG:-}"
    run="${FLOOR_RUN_ID:-}"
    env="${DEPLOY_ENV:-both}"
    case "$env" in both | staging | prod) ;; *) echo "env must be both, staging or prod" >&2; exit 2 ;; esac
    if [ -n "$tag" ] && [ -n "$run" ]; then echo "give a tag or a floor run id, not both" >&2; exit 2; fi
    if [ -n "$tag" ]; then
      [[ "$tag" =~ $stable ]] || { echo "tag must be a stable vX.Y.Z" >&2; exit 2; }
      case "$env" in
        both) out release "$tag" "" true true ;;
        staging) out release "$tag" "" true false ;;
        prod) staged "$tag"; out release "$tag" "" false true ;;
      esac
    elif [ -n "$run" ]; then
      [[ "$run" =~ ^[1-9][0-9]{0,19}$ ]] || { echo "floor_run_id must be a run id" >&2; exit 2; }
      [ "$env" != both ] || { echo "a floor is one env's: give env staging or prod" >&2; exit 2; }
      if [ "$env" = staging ]; then out floor "" "$run" true false; else out floor "" "$run" false true; fi
    else
      echo "give a tag or a floor run id" >&2
      exit 2
    fi
    ;;
  *)
    echo "EVENT must be workflow_run or workflow_dispatch" >&2
    exit 2
    ;;
esac
