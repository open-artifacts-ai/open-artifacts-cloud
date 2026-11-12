#!/usr/bin/env bash
# Read-only audit of prod's install Workers (tier-audit.yml, #218): lists every
# script in the Workers-for-Platforms dispatch namespace and prints one line
# per script, "<script> TIER=yes|no", for whether it has a binding NAMED TIER.
# Job logs are public: only script names, yes/no and counts are printed. A
# binding's value, type or any other binding never leaves jq, and no response
# body is echoed. A failed call prints the script name and the HTTP status and
# Cloudflare error codes only.
# GET only: the one request helper (get) takes a path and no method, and the
# curl line carries no -X, --request or body flag.
# The token reaches curl on stdin (-K -), never argv.
# Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, DISPATCH_NAMESPACE.
# Exits 1 when the listing or any script's settings could not be read.
# Usage: scripts/ci/tier-audit.sh
set -euo pipefail

[ "$#" -eq 0 ] || { echo "usage: $0 (no arguments)" >&2; exit 2; }
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${DISPATCH_NAMESPACE:?DISPATCH_NAMESPACE is required}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 hex" >&2; exit 2; }
[[ "$DISPATCH_NAMESPACE" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || { echo "DISPATCH_NAMESPACE has unexpected characters" >&2; exit 2; }
# shellcheck source=scripts/ci/hosted-cf.sh
. "$(dirname "${BASH_SOURCE[0]}")/hosted-cf.sh"
NS="/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/dispatch/namespaces/$DISPATCH_NAMESPACE/scripts"

# get <path>: GET $CF<path>; sets BODY and CODE (the HTTP status). Returns 1 on
# a network error. Never prints BODY.
BODY="" CODE=""
get() {
  local out
  out="$(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS -K - -w '\n%{http_code}' "$CF$1")" || return 1
  CODE="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

# fail_why: "HTTP <status> codes=<error codes>" for the last response; numbers only.
fail_why() {
  local codes
  codes="$(jq -r '[.errors[]?.code | select(type == "number")] | join(",")' <<< "$BODY" 2> /dev/null || true)"
  printf 'HTTP %s codes=%s' "$CODE" "${codes:-none}"
}
ok_body() { [ "$CODE" = 200 ] && [ "$(jq -r '.success' <<< "$BODY" 2> /dev/null || true)" = true ]; }

# The listing: every page's script names (.id), one per line. total_pages is
# trusted when sent; otherwise a short page, or a page with no new name (the
# API ignoring paging), ends it.
per=100 names="" total_pages=""
for ((page = 1; page <= 100; page++)); do
  get "$NS?per_page=$per&page=$page" || { echo "list scripts failed: network error" >&2; exit 1; }
  ok_body || { echo "list scripts failed: $(fail_why)" >&2; exit 1; }
  jq -e '.result | type == "array"' <<< "$BODY" > /dev/null 2>&1 || { echo "list scripts failed: no result list" >&2; exit 1; }
  page_names="$(jq -r '.result[] | .id | select(type == "string")' <<< "$BODY")" || exit 1
  n="$(jq '.result | length' <<< "$BODY")" || exit 1
  total_pages="$(jq -r '.result_info.total_pages | if type == "number" then . else "" end' <<< "$BODY")" || exit 1
  before="$(printf '%s\n' "$names" | sort -u | grep -c . || true)"
  names="$(printf '%s\n%s\n' "$names" "$page_names" | grep . || true)"
  after="$(printf '%s\n' "$names" | sort -u | grep -c . || true)"
  if [ -n "$total_pages" ]; then
    [ "$page" -lt "$total_pages" ] || break
  else
    { [ "$n" -ge "$per" ] && [ "$after" -gt "$before" ]; } || break
  fi
  [ "$page" -lt 100 ] || { echo "list scripts failed: the listing did not end after 100 pages" >&2; exit 1; }
done
names="$(printf '%s\n' "$names" | grep . | sort -u || true)"

total=0 with=0 without=0 errors=0
while IFS= read -r s; do
  [ -n "$s" ] || continue
  total=$((total + 1))
  if ! [[ "$s" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    echo "script #$total ERROR unexpected name"
    errors=$((errors + 1))
    continue
  fi
  if ! get "$NS/$s/settings"; then
    echo "$s ERROR network error"
    errors=$((errors + 1))
    continue
  fi
  if ! ok_body; then
    echo "$s ERROR $(fail_why)"
    errors=$((errors + 1))
    continue
  fi
  # Only a boolean leaves jq: never a binding's value, type or other name.
  has="$(jq -r 'if (.result.bindings | type) == "array"
    then (any(.result.bindings[]; .name == "TIER") | tostring) else "bad" end' <<< "$BODY" 2> /dev/null || echo bad)"
  case "$has" in
    true) echo "$s TIER=yes"; with=$((with + 1)) ;;
    false) echo "$s TIER=no"; without=$((without + 1)) ;;
    *) echo "$s ERROR no bindings list"; errors=$((errors + 1)) ;;
  esac
done <<< "$names"

echo "total=$total with_tier=$with without_tier=$without errors=$errors"
[ "$errors" -eq 0 ] || exit 1
