#!/usr/bin/env bash
# Staging's Durable Object namespaces whose install Worker is gone (open-
# artifacts#2360), report-only. Does deleting an install delete its Durable
# Object namespaces, and with them the BusHub data? Cloudflare's docs say the
# WfP script DELETE's `force` flag deletes the namespaces a script implements,
# and say nothing of a plain DELETE. This reads the answer off staging, where
# every gate deletes rl-p:
#  1. the account's DO namespaces (GET .../workers/durable_objects/namespaces:
#     id, class, name, script), kept when the script starts with "oa-s-i"
#     (a staging install);
#  2. the scripts in the staging dispatch namespace;
#  3. at least one namespace whose script is live AND whose class is BusHub,
#     or the list does not show namespaced scripts and the run fails;
#  4. an orphan is a namespace whose script is no longer in the dispatch
#     namespace: each prints "orphan <script> <class> <namespace id>", then
#     "live=N orphan=M".
# Exits 0 with orphans (report-only for now); 1 when a list call fails or step
# 3 does. GET only; the token reaches curl on stdin (hosted-cf.sh), never argv.
# Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, DISPATCH_NAMESPACE.
# Usage: scripts/ci/do-orphans.sh
set -euo pipefail

[ "$#" -eq 0 ] || { echo "usage: $0 (no arguments)" >&2; exit 2; }
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${DISPATCH_NAMESPACE:?DISPATCH_NAMESPACE is required}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 hex" >&2; exit 2; }
[[ "$DISPATCH_NAMESPACE" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || { echo "DISPATCH_NAMESPACE has unexpected characters" >&2; exit 2; }
# shellcheck source=scripts/ci/hosted-cf.sh
. "$(dirname "${BASH_SOURCE[0]}")/hosted-cf.sh"
acct="/accounts/$CLOUDFLARE_ACCOUNT_ID"

# pages <path ending in ?> <per_page> <what>: every page's .result as one JSON
# array. total_pages is trusted when sent; otherwise a short page, or a page
# adding nothing new (the API ignoring paging), ends it.
pages() {
  local path="$1" per="$2" what="$3" page body all='[]' prev=0 n now pn
  for ((page = 1; page <= 100; page++)); do
    body="$(cf_ok "${path}per_page=$per&page=$page" "$what")" || exit 1
    jq -e '.result | type == "array"' <<< "$body" > /dev/null || { echo "$what failed: no result list" >&2; exit 1; }
    all="$(jq -c --argjson a "$all" '($a + .result) | unique' <<< "$body")" || exit 1
    n="$(jq '.result | length' <<< "$body")" || exit 1
    pn="$(jq -r '.result_info.total_pages | if type == "number" then . else "" end' <<< "$body")" || exit 1
    now="$(jq 'length' <<< "$all")" || exit 1
    if [ -n "$pn" ]; then
      [ "$page" -lt "$pn" ] || { printf '%s' "$all"; return 0; }
    elif [ "$n" -lt "$per" ] || [ "$now" -le "$prev" ]; then
      printf '%s' "$all"
      return 0
    fi
    prev="$now"
  done
  echo "$what failed: the listing did not end after 100 pages" >&2
  exit 1
}

ns="$(pages "$acct/workers/durable_objects/namespaces?" 1000 "list Durable Object namespaces")" || exit 1
scripts="$(pages "$acct/workers/dispatch/namespaces/$DISPATCH_NAMESPACE/scripts?" 100 "list $DISPATCH_NAMESPACE scripts")" || exit 1

# Staging installs' namespaces, each marked live when its script is listed.
# Only strings leave jq: script, class, namespace id.
rows="$(jq -r --argjson s "$scripts" '
  ($s | map(.id | select(type == "string"))) as $names
  | [.[] | select((.script | type) == "string" and (.script | startswith("oa-s-i")))
      | {script, class: (.class // ""), id: (.id // ""), live: ((.script) as $x | $names | index($x) != null)}]
  | .[] | [(if .live then "live" else "orphan" end), .script, .class, .id] | @tsv' <<< "$ns")" || exit 1

live="$(grep -c '^live	' <<< "$rows" || true)"
orphan="$(grep -c '^orphan	' <<< "$rows" || true)"
if ! grep -q "^live	[^	]*	BusHub	" <<< "$rows"; then
  echo "the namespace list does not show namespaced scripts: no live staging install has a BusHub namespace (live=$live orphan=$orphan)" >&2
  exit 1
fi
{ grep '^orphan	' <<< "$rows" || true; } | sort | while IFS=$'\t' read -r _ script class id; do
  echo "orphan $script $class $id"
done
echo "live=$live orphan=$orphan"
