#!/usr/bin/env bash
# The fleet wake (cloud #264): deploy-hosted-platform.yml's last deploy step,
# right after "Mark the platform verified", posts one message to the env's
# oa-<p>-fleet-wake queue. The scheduler, its only consumer, then runs the
# fleet rollout at once (apps/scheduler/src/provapi/wake.ts). The wake is the
# fleet's only start (the 2-minute tick no longer runs the fleet), and still
# nothing here fails the deploy: no queue yet (a tag from before the wake), a
# failed lookup or post, or a bad input is one warning and exit 0. The body names the env and the
# release only; the scheduler never reads it (its target is its own tag).
# The token reaches curl on stdin (-K -), never argv, and is never printed.
# Needs CLOUDFLARE_API_TOKEN (Queues Edit, the deploy's own) and
# CLOUDFLARE_ACCOUNT_ID.
# Usage: scripts/ci/fleet-wake.sh staging|prod vX.Y.Z
set -uo pipefail

warn() {
  echo "::warning::fleet wake not sent: $1; the fleet does not move until a later wake reaches the scheduler"
  exit 0
}
[ "$#" -eq 2 ] || warn "usage: fleet-wake.sh staging|prod vX.Y.Z"
case "$1" in
  staging) P=s ;;
  prod) P=p ;;
  *) warn "env must be staging or prod" ;;
esac
tag="$2"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || warn "the tag must be vX.Y.Z"
[[ "${CLOUDFLARE_ACCOUNT_ID:-}" =~ ^[0-9a-f]{32}$ ]] || warn "CLOUDFLARE_ACCOUNT_ID must be 32 hex"
# Also keeps the curl config line well-formed (no quote, no newline).
[[ "${CLOUDFLARE_API_TOKEN:-}" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || warn "CLOUDFLARE_API_TOKEN is unset or has unexpected characters"
queue="oa-$P-fleet-wake"
ACCT="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"

# cf <curl args...>: one bounded call; the token on stdin.
cf() {
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS --max-time 20 -K - "$@"
}

# The queue's id, by exact name, across every page of the listing (at most
# 20 pages of 100; total_pages is trusted when Cloudflare sends it, else a
# short page ends the list).
ids=""
for ((page = 1; page <= 20; page++)); do
  list="$(cf "$ACCT/queues?per_page=100&page=$page")" || warn "listing the queues failed (network)"
  [ "$(jq -r '.success' <<< "$list" 2> /dev/null)" = true ] ||
    warn "listing the queues failed: $(jq -c '.errors' <<< "$list" 2> /dev/null || echo 'unparsable response')"
  got="$(jq -r --arg q "$queue" '[.result[]? | select(.queue_name == $q) | .queue_id] | join(" ")' <<< "$list" 2> /dev/null)" ||
    warn "the queue listing is unparsable"
  ids="${ids:+$ids${got:+ }}$got"
  pages="$(jq -r '.result_info.total_pages | if type == "number" then . else "" end' <<< "$list" 2> /dev/null)" ||
    warn "the queue listing is unparsable"
  n="$(jq -r '.result | length' <<< "$list" 2> /dev/null)" || warn "the queue listing is unparsable"
  if [ -n "$pages" ]; then
    [ "$page" -lt "$pages" ] || break
  elif [ "$n" -lt 100 ]; then
    break
  fi
  [ "$page" -lt 20 ] || warn "the queue listing did not end after 20 pages"
done
[[ "$ids" =~ ^[0-9a-f]{32}$ ]] || warn "want exactly one queue $queue with an id (found '${ids:-none}')"

body="$(jq -nc --arg env "$1" --arg tag "$tag" '{body: {env: $env, tag: $tag}}')"
out="$(cf -X POST -H 'content-type: application/json' --data-binary "$body" "$ACCT/queues/$ids/messages")" ||
  warn "posting to $queue failed (network)"
[ "$(jq -r '.success' <<< "$out" 2> /dev/null)" = true ] ||
  warn "posting to $queue failed: $(jq -c '.errors' <<< "$out" 2> /dev/null || echo 'unparsable response')"
echo "fleet wake sent to $queue for $tag"
