#!/usr/bin/env bash
# Pings one Cloudflare API token so its "Last used" time moves on the
# dashboard (token cleanup, #933/#934). Dispatched by token-ping.yml and
# token-ping-prod.yml, one job per secret. Prints only
#   id=<id> status=<status> kind=<user|account>
# never the token. Any failure prints only the HTTP code and exits 1.
# GETs only. The token reaches curl in a config on a process substitution,
# never argv.
# With a second argument "r2" it runs the R2 read probe instead (its own
# workflow step, so the verify signal stays distinct): two GETs on the env's
# releases bucket (oa-s-releases for staging, oa-p-releases for prod), the
# bucket itself and a one-item object list. Prints one line per probe,
#   r2 bucket=<name> op=<get|list> http=<code> cf_code=<first error code|ok|none>
# never object keys, counts, bodies or the token, and exits 1 with an
# ::error:: line if either probe fails (10042 on the prod publish token).
# Env: TOKEN (the secret), HOSTED_DIR (holds <env>.json for the account id).
# Usage: scripts/ci/token-ping.sh <staging|prod> [r2]
set -euo pipefail

CF=https://api.cloudflare.com/client/v4

{ [ "$#" -eq 1 ] || { [ "$#" -eq 2 ] && [ "$2" = r2 ]; }; } || { echo "usage: $0 <staging|prod> [r2]" >&2; exit 2; }
case "$1" in staging | prod) ENV="$1" ;; *) echo "unknown env: $1" >&2; exit 2 ;; esac
: "${TOKEN:?TOKEN is required}"
: "${HOSTED_DIR:?HOSTED_DIR is required}"
# Also keeps the curl config line well-formed (no quote, no newline).
[[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || { echo "the token is empty or has unexpected characters" >&2; exit 1; }

_auth() { printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"; }

# get <path>: sets HTTP (code) and BODY. Never prints either.
get() {
  local out
  if out="$(curl -sS --max-time 30 -K <(_auth) -w $'\n%{http_code}' "$CF$1" 2> /dev/null)"; then
    HTTP="${out##*$'\n'}"
    BODY="${out%$'\n'*}"
  else
    HTTP=000
    BODY='{}'
  fi
  [[ "$HTTP" =~ ^[0-9]{3}$ ]] || HTTP=000
  jq -e . > /dev/null 2>&1 <<< "$BODY" || BODY='{}'
}

# answer <kind>: prints the line when this answer is a good one.
answer() {
  [ "$HTTP" = 200 ] || return 1
  local id status
  [ "$(jq -r '.success' <<< "$BODY")" = true ] || return 1
  id="$(jq -r '.result.id // ""' <<< "$BODY")"
  status="$(jq -r '.result.status // ""' <<< "$BODY")"
  [[ "$id" =~ ^[0-9a-f]{32}$ ]] || return 1
  [[ "$status" =~ ^[a-z_]{1,20}$ ]] || return 1
  echo "id=$id status=$status kind=$1"
}

# r2probe <bucket> <op> <path>: prints the one line; returns 1 when not ok.
r2probe() {
  local code
  get "$3"
  code="$(jq -r '[.errors[]?.code | select(type == "number")] | (.[0] // "none") | tostring' <<< "$BODY" 2> /dev/null)" || code=none
  [[ "$code" =~ ^[0-9]{1,10}$ ]] || code=none
  if [ "$HTTP" = 200 ] && [ "$(jq -r '.success' <<< "$BODY" 2> /dev/null)" = true ]; then
    echo "r2 bucket=$1 op=$2 http=$HTTP cf_code=ok"
    return 0
  fi
  echo "r2 bucket=$1 op=$2 http=$HTTP cf_code=$code"
  echo "::error::R2 $2 on $1 failed: http=$HTTP cf_code=$code"
  return 1
}

if [ "${2:-}" = r2 ]; then
  f="$HOSTED_DIR/$ENV.json"
  [ -f "$f" ] || { echo "http=000" >&2; exit 1; }
  account="$(jq -r '.account_id // ""' "$f")"
  [[ "$account" =~ ^[0-9a-f]{32}$ ]] || { echo "bad account id" >&2; exit 1; }
  if [ "$ENV" = prod ]; then bucket=oa-p-releases; else bucket=oa-s-releases; fi
  rc=0
  r2probe "$bucket" get "/accounts/$account/r2/buckets/$bucket" || rc=1
  r2probe "$bucket" list "/accounts/$account/r2/buckets/$bucket/objects?per_page=1" || rc=1
  exit "$rc"
fi

get /user/tokens/verify
answer user && exit 0
FIRST="$HTTP"

# An auth error suggests an account-owned token: try the account's verify.
case "$FIRST" in
400 | 401 | 403)
  f="$HOSTED_DIR/$ENV.json"
  [ -f "$f" ] || { echo "http=$FIRST" >&2; exit 1; }
  account="$(jq -r '.account_id // ""' "$f")"
  [[ "$account" =~ ^[0-9a-f]{32}$ ]] || { echo "http=$FIRST" >&2; exit 1; }
  get "/accounts/$account/tokens/verify"
  answer account && exit 0
  echo "http=$HTTP" >&2
  exit 1
  ;;
esac
echo "http=$FIRST" >&2
exit 1
