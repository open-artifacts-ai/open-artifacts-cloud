#!/usr/bin/env bash
# deploy-waves.sh <targets>: the waves deploy-hosted-platform.yml deploys in.
# Prints one line per wave, the targets of a wave space-separated, in the
# canonical order. A wave starts only after every earlier wave succeeded; the
# targets inside a wave do not depend on each other and deploy in parallel.
#
# A target's wave is 1 + the latest wave of the targets it needs that are in
# the list (a target outside the list is not waited for: a break-glass run
# leaves it as it is, and the target's own need_workers checks read it live).
# What each target needs (deploy-hosted-platform.sh):
#   platform-db      nothing: its D1 migrations go first, every target reads them
#   auth-broker      platform-db
#   directory-broker platform-db
#   billing          platform-db
#   provision-token  platform-db (a read only)
#   inventory        platform-db
#   provisioner      billing (BILLING binding), provision-token (the secret it binds)
#   provisioning     provisioner and auth-broker (need_workers), billing (binding)
#   dispatch         both brokers and billing (need_workers), provisioning (LOGIN)
#   zones            dispatch, both brokers, provisioning, billing (routes need them)
#   scheduler        every other target: its tag is the fleet's target (#1343)
# The full list comes out as:
#   1 platform-db
#   2 auth-broker directory-broker billing provision-token inventory
#   3 provisioner
#   4 provisioning
#   5 dispatch
#   6 zones
#   7 scheduler
# The workflow runs zones and the scheduler in steps of their own (each alone in
# its wave), so only waves 1-5 run in parallel there.
# Exit 2 on an unknown or repeated target, or a list out of canonical order.
set -euo pipefail

ORDER=(platform-db auth-broker directory-broker billing provision-token provisioner provisioning dispatch inventory zones scheduler)

needs() {
  case "$1" in
    platform-db) echo "" ;;
    auth-broker | directory-broker | billing | provision-token | inventory) echo "platform-db" ;;
    provisioner) echo "platform-db billing provision-token" ;;
    provisioning) echo "platform-db provisioner auth-broker directory-broker billing" ;;
    dispatch) echo "platform-db auth-broker directory-broker billing provisioning" ;;
    zones) echo "dispatch auth-broker directory-broker provisioning billing platform-db" ;;
    scheduler) echo "platform-db auth-broker directory-broker billing provision-token provisioner provisioning dispatch inventory zones" ;;
    *) return 1 ;;
  esac
}

[ "$#" -eq 1 ] || { echo "usage: $0 <comma-separated targets>" >&2; exit 2; }
IFS=, read -ra list <<< "$1"
[ "${#list[@]}" -gt 0 ] || { echo "no targets" >&2; exit 2; }

# The list's own order is the canonical order (the workflow checks it too), so a
# target's needs are always planned before it.
names=()
waves=()
last=-1
for t in "${list[@]}"; do
  pos=-1
  for i in "${!ORDER[@]}"; do [ "${ORDER[$i]}" = "$t" ] && pos=$i; done
  [ "$pos" -ge 0 ] || { echo "unknown target: $t" >&2; exit 2; }
  [ "$pos" -gt "$last" ] || { echo "targets repeated or out of order: $1" >&2; exit 2; }
  last=$pos
  w=0
  for n in $(needs "$t"); do
    for j in "${!names[@]}"; do
      if [ "${names[$j]}" = "$n" ] && [ $((waves[j] + 1)) -gt "$w" ]; then w=$((waves[j] + 1)); fi
    done
  done
  names+=("$t")
  waves+=("$w")
done

max=0
for w in "${waves[@]}"; do [ "$w" -le "$max" ] || max="$w"; done
for ((k = 0; k <= max; k++)); do
  line=""
  for j in "${!names[@]}"; do
    [ "${waves[$j]}" -eq "$k" ] && line="$line ${names[$j]}"
  done
  echo "${line# }"
done
