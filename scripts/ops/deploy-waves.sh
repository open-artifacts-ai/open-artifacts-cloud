#!/usr/bin/env bash
# deploy-waves.sh <targets> [build]: what each target of deploy-hosted-platform.yml
# waits for (#264 step 6). The name is from the waves it once planned; the
# workflow now starts each target as soon as everything it needs has succeeded.
# Prints one line per target, in the canonical order: the target, then the
# targets it needs that are in the list, space-separated.
#
# A target outside the list is not waited for: a break-glass run leaves it as
# it is, and the target's own need_workers checks read it live.
# What each target needs (deploy-hosted-platform.sh):
#   platform-db      nothing: its D1 migrations go first, every target reads them
#   auth-broker      platform-db (the migrations-first rule)
#   directory-broker platform-db (the same rule)
#   billing          platform-db (the same rule)
#   provision-token  nothing: a read only (Secrets Store), it never touches the D1
#   inventory        platform-db (binds PLATFORM_DB)
#   provisioner      platform-db (binds it), billing (BILLING binding),
#                    provision-token (the secret it binds)
#   provisioning     provisioner and auth-broker (need_workers), billing
#                    (binding), directory-broker, platform-db
#   dispatch         both brokers and billing (need_workers), provisioning (LOGIN)
#   zones            dispatch, both brokers, provisioning, billing: its routes
#                    send traffic to them, so they change only once those
#                    Workers' new releases passed
#   scheduler        every other target: its tag is the fleet's target (#1343)
#
# With `build` (the workflow passes it when provisioning is in the list and the
# run deploys), a `provisioning-build` line comes first: provisioning's own
# `pnpm --filter "@oa/provisioning..." build`, needing nothing. It writes
# generated files into workspace packages the other Workers bundle, so every
# target that runs wrangler needs it too; only platform-db, provision-token and
# zones (no bundle) run beside it.
# Exit 2 on an unknown or repeated target, or a list out of canonical order.
set -euo pipefail

ORDER=(platform-db auth-broker directory-broker billing provision-token provisioner provisioning dispatch inventory zones scheduler)

needs() {
  case "$1" in
    platform-db | provision-token) echo "" ;;
    auth-broker | directory-broker | billing | inventory) echo "platform-db" ;;
    provisioner) echo "platform-db billing provision-token" ;;
    provisioning) echo "platform-db provisioner auth-broker directory-broker billing" ;;
    dispatch) echo "platform-db auth-broker directory-broker billing provisioning" ;;
    zones) echo "platform-db auth-broker directory-broker billing provisioning dispatch" ;;
    scheduler) echo "platform-db auth-broker directory-broker billing provision-token provisioner provisioning dispatch inventory zones" ;;
    *) return 1 ;;
  esac
}
# bundles <target>: the target runs wrangler, which bundles workspace code.
bundles() {
  case "$1" in platform-db | provision-token | zones) return 1 ;; *) return 0 ;; esac
}

{ [ "$#" -eq 1 ] || { [ "$#" -eq 2 ] && [ "$2" = build ]; }; } ||
  { echo "usage: $0 <comma-separated targets> [build]" >&2; exit 2; }
IFS=, read -ra list <<< "$1"
[ "${#list[@]}" -gt 0 ] || { echo "no targets" >&2; exit 2; }
build="${2:-}"

# The list's own order is the canonical order (the workflow checks it too).
last=-1
for t in "${list[@]}"; do
  pos=-1
  for i in "${!ORDER[@]}"; do [ "${ORDER[$i]}" = "$t" ] && pos=$i; done
  [ "$pos" -ge 0 ] || { echo "unknown target: $t" >&2; exit 2; }
  [ "$pos" -gt "$last" ] || { echo "targets repeated or out of order: $1" >&2; exit 2; }
  last=$pos
done

[ -z "$build" ] || echo provisioning-build
for t in "${list[@]}"; do
  line="$t"
  for n in $(needs "$t"); do
    for u in "${list[@]}"; do [ "$u" = "$n" ] && line="$line $n"; done
  done
  if [ -n "$build" ] && bundles "$t"; then line="$line provisioning-build"; fi
  echo "$line"
done
