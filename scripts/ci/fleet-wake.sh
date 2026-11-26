#!/usr/bin/env bash
# The fleet wake (cloud #264): deploy-hosted-platform.yml's last deploy step,
# right after "Mark the platform verified", posts one message to the env's
# oa-<p>-fleet-wake queue. The scheduler, its only consumer, then starts the
# fleet rollout on that event (apps/scheduler/src/provapi/wake.ts). The wake
# is the rollout's first event, so a wake that is not sent fails this step
# (exit 1, one ::error:: line), never a quiet success: a failed listing or
# post (the network, a 5xx, a 429, success false) is retried with a backoff,
# WAKE_RETRY_SLEEP seconds (default 1) doubling, WAKE_TRIES times in all
# (default 5); a bad input, or not exactly one such queue, fails at once.
# The body names the env and the release only; the scheduler never reads it
# (its target is its own tag). The token reaches curl on stdin (-K -), never
# argv, and is never printed. Needs CLOUDFLARE_API_TOKEN (Queues Edit, the
# deploy's own) and CLOUDFLARE_ACCOUNT_ID.
# Usage: scripts/ci/fleet-wake.sh staging|prod vX.Y.Z
set -uo pipefail

fail() {
  echo "::error::fleet wake not sent: $1"
  exit 1
}
[ "$#" -eq 2 ] || fail "usage: fleet-wake.sh staging|prod vX.Y.Z"
case "$1" in
  staging) P=s ;;
  prod) P=p ;;
  *) fail "env must be staging or prod" ;;
esac
tag="$2"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "the tag must be vX.Y.Z"
[[ "${CLOUDFLARE_ACCOUNT_ID:-}" =~ ^[0-9a-f]{32}$ ]] || fail "CLOUDFLARE_ACCOUNT_ID must be 32 hex"
# Also keeps the curl config line well-formed (no quote, no newline).
[[ "${CLOUDFLARE_API_TOKEN:-}" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || fail "CLOUDFLARE_API_TOKEN is unset or has unexpected characters"
tries="${WAKE_TRIES:-5}"
[[ "$tries" =~ ^[1-9]$ ]] || fail "WAKE_TRIES must be 1 to 9"
delay="${WAKE_RETRY_SLEEP:-1}"
[[ "$delay" =~ ^[0-9]{1,2}$ ]] || fail "WAKE_RETRY_SLEEP must be 0 to 99 seconds"
queue="oa-$P-fleet-wake"
ACCT="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"

# cf <curl args...>: one bounded call; the token on stdin.
cf() {
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS --max-time 20 -K - "$@"
}

# once: one lookup and post. 0 sent; 2 a failure worth retrying (why says
# which); 1 one that is not (not exactly one queue). A post retried after a
# lost answer may land twice: the scheduler collapses duplicates (wake.ts).
why=""
once() {
  local ids="" list got pages n page out body
  # The queue's id, by exact name, across every page of the listing (at most
  # 20 pages of 100; total_pages is trusted when Cloudflare sends it, else a
  # short page ends the list).
  for ((page = 1; page <= 20; page++)); do
    list="$(cf "$ACCT/queues?per_page=100&page=$page")" || { why="listing the queues failed (network)"; return 2; }
    [ "$(jq -r '.success' <<< "$list" 2> /dev/null)" = true ] ||
      { why="listing the queues failed: $(jq -c '.errors' <<< "$list" 2> /dev/null || echo 'unparsable response')"; return 2; }
    got="$(jq -r --arg q "$queue" '[.result[]? | select(.queue_name == $q) | .queue_id] | join(" ")' <<< "$list" 2> /dev/null)" ||
      { why="the queue listing is unparsable"; return 2; }
    ids="${ids:+$ids${got:+ }}$got"
    pages="$(jq -r '.result_info.total_pages | if type == "number" then . else "" end' <<< "$list" 2> /dev/null)" ||
      { why="the queue listing is unparsable"; return 2; }
    n="$(jq -r '.result | length' <<< "$list" 2> /dev/null)" || { why="the queue listing is unparsable"; return 2; }
    if [ -n "$pages" ]; then
      [ "$page" -lt "$pages" ] || break
    elif [ "$n" -lt 100 ]; then
      break
    fi
    [ "$page" -lt 20 ] || { why="the queue listing did not end after 20 pages"; return 1; }
  done
  [[ "$ids" =~ ^[0-9a-f]{32}$ ]] || { why="want exactly one queue $queue with an id (found '${ids:-none}')"; return 1; }
  body="$(jq -nc --arg env "$1" --arg tag "$tag" '{body: {env: $env, tag: $tag}}')"
  out="$(cf -X POST -H 'content-type: application/json' --data-binary "$body" "$ACCT/queues/$ids/messages")" ||
    { why="posting to $queue failed (network)"; return 2; }
  [ "$(jq -r '.success' <<< "$out" 2> /dev/null)" = true ] ||
    { why="posting to $queue failed: $(jq -c '.errors' <<< "$out" 2> /dev/null || echo 'unparsable response')"; return 2; }
  return 0
}

for ((try = 1; ; try++)); do
  once "$1"
  rc=$?
  [ "$rc" -ne 0 ] || break
  [ "$rc" -eq 2 ] && [ "$try" -lt "$tries" ] || fail "$why (try $try of $tries)"
  echo "fleet wake: $why; try $((try + 1)) of $tries in ${delay}s"
  sleep "$delay"
  delay=$((delay * 2))
done
echo "fleet wake sent to $queue for $tag"
