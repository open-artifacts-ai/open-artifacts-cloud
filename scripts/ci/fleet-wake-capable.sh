#!/usr/bin/env bash
# Whether the tag being deployed can take the fleet wake (cloud #264): its
# scheduler config consumes the env's oa-<p>-fleet-wake queue, the same check
# deploy-hosted-platform.sh makes before creating that queue. An older tag
# (one from before the wake, such as a recovery deploy) declares no consumer
# and never writes fleet_done, so deploy-hosted-platform.yml skips "Wake the
# fleet" for it, and the
# 2-minute tick moves the fleet as before. An unreadable config counts as not
# capable (the tick is the backup). Prints one line; writes capable=true or
# capable=false to $GITHUB_OUTPUT when set. Always exits 0 on valid usage.
# Usage: scripts/ci/fleet-wake-capable.sh staging|prod <the tag's apps/scheduler/wrangler.jsonc> <main's scripts/ops/wrangler-env.ts>
set -uo pipefail

[ "$#" -eq 3 ] || { echo "usage: $0 staging|prod <wrangler.jsonc> <wrangler-env.ts>" >&2; exit 2; }
case "$1" in
  staging) P=s ;;
  prod) P=p ;;
  *) echo "env must be staging or prod" >&2; exit 2 ;;
esac
queue="oa-$P-fleet-wake"
list="$(node --experimental-strip-types --no-warnings "$3" "$2" "$1" consumers 2> /dev/null)" || list=""
# jq -e on empty input exits 0 on some versions: an empty answer is a no.
if [ -n "$list" ] && jq -e --arg q "$queue" 'type == "array" and index($q) != null' <<< "$list" > /dev/null 2>&1; then
  capable=true
  echo "the tag's scheduler consumes $queue: wake the fleet and wait for it"
else
  capable=false
  echo "the tag's scheduler does not consume $queue: no wake and no wait; the 2-minute tick moves the fleet"
fi
[ -z "${GITHUB_OUTPUT:-}" ] || echo "capable=$capable" >> "$GITHUB_OUTPUT"
