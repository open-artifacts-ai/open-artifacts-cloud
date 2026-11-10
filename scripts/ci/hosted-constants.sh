#!/usr/bin/env bash
# Loads one env's committed hosted constants (<dir>/<env>.json, normally
# .github/hosted) into $GITHUB_ENV: CLOUDFLARE_ACCOUNT_ID, EMAIL_ZONE (the
# sending zone's name; hosted-resource-ids.sh resolves its tag),
# EMAIL_DAILY_LIMIT, GOOGLE_CLIENT_ID, GOOGLE_DIRECTORY_CLIENT_ID, and the
# provisioner's and scheduler's SIGNUP_DAILY_CAP and SIGNUPS_ENABLED, the
# provisioner's WELCOME_FROM, and the scheduler's ALERT_FROM. None is a
# secret. Every value is checked against its consumer's rule
# (deploy-platform-worker.sh) before anything is written: a missing, null,
# empty, multi-line or malformed value (a placeholder included) exits 1 and
# writes nothing. The scheduler's ALERT_TO is the owner's address: never
# committed (#1084), it comes from OA_OWNER_EMAIL (the Actions secret) when
# set, goes to $GITHUB_ENV only and is never printed. Unset, no ALERT_TO is
# written, and a scheduler deploy refuses (deploy-hosted-platform.sh).
# STAGING ONLY (#1568): the billing service's four Stripe test-mode price ids
# (stripe_price_team, _business, _solo_monthly, _solo_yearly: not secrets) load
# as STRIPE_PRICE_TEAM, STRIPE_PRICE_BUSINESS, STRIPE_PRICE_SOLO_MONTHLY and
# STRIPE_PRICE_SOLO_YEARLY, each a price id. Prod's file must hold no stripe_*
# key (prod has no billing Worker, and no Stripe value reaches its run).
# Usage: scripts/ci/hosted-constants.sh staging|prod <dir>
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: $0 staging|prod <dir>" >&2; exit 2; }
case "$1" in staging | prod) ;; *) echo "env must be staging or prod" >&2; exit 2 ;; esac
file="$2/$1.json"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
[ -f "$file" ] || { echo "$file is missing" >&2; exit 1; }

# deploy-platform-worker.sh's hex32, limit and google_id, and a zone name.
hex32='^[0-9a-f]{32}$'
zone='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
limit='^[1-9][0-9]{0,8}$'
google_id='^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$'
# deploy-platform-worker.sh's cap, onoff (staging also test-users, design v7
# 7; staging may commit true, open for the M2 walk (user decision 2026-11-10):
# the deploy workflow sets ALLOW_SIGNUPS=1 for staging only, prod stays false)
# and email.
cap='^[1-9][0-9]{0,3}$'
if [ "$1" = staging ]; then onoff='^(false|test-users|true)$'; else onoff='^false$'; fi
email='^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$'
lines=""
# key ENV_NAME rule, one per line.
while read -r k name rule; do
  v="$(jq -r --arg k "$k" '.[$k] | if type == "string" or type == "number" then tostring else "" end' "$file")" || exit 1
  [ -n "$v" ] || { echo "$file: $k is missing" >&2; exit 1; }
  [[ "$v" != *$'\n'* && "$v" != *$'\r'* ]] || { echo "$file: $k spans lines" >&2; exit 1; }
  [[ "$v" =~ $rule ]] || { echo "$file: $k is not a valid value: $v" >&2; exit 1; }
  lines+="$name=$v"$'\n'
done << EOF
account_id CLOUDFLARE_ACCOUNT_ID $hex32
alert_from ALERT_FROM $email
email_zone EMAIL_ZONE $zone
email_daily_limit EMAIL_DAILY_LIMIT $limit
google_client_id GOOGLE_CLIENT_ID $google_id
google_directory_client_id GOOGLE_DIRECTORY_CLIENT_ID $google_id
signup_daily_cap SIGNUP_DAILY_CAP $cap
signups_enabled SIGNUPS_ENABLED $onoff
welcome_from WELCOME_FROM $email
EOF
# Billing's prices: staging only. Prod refuses any stripe_* key.
if [ "$1" = staging ]; then
  price='^price_[A-Za-z0-9]{1,255}$'
  while read -r k name rule; do
    v="$(jq -r --arg k "$k" '.[$k] | if type == "string" then . else "" end' "$file")" || exit 1
    [ -n "$v" ] || { echo "$file: $k is missing" >&2; exit 1; }
    [[ "$v" =~ $rule ]] || { echo "$file: $k is not a valid value: $v" >&2; exit 1; }
    lines+="$name=$v"$'\n'
  done << LIST
stripe_price_team STRIPE_PRICE_TEAM $price
stripe_price_business STRIPE_PRICE_BUSINESS $price
stripe_price_solo_monthly STRIPE_PRICE_SOLO_MONTHLY $price
stripe_price_solo_yearly STRIPE_PRICE_SOLO_YEARLY $price
LIST
else
  [ "$(jq -r '[keys[] | select(startswith("stripe_"))] | length' "$file")" = 0 ] ||
    { echo "$file: prod holds no stripe_* constant (billing is staging only)" >&2; exit 1; }
fi
owner=""
if [ -n "${OA_OWNER_EMAIL:-}" ]; then
  [[ "$OA_OWNER_EMAIL" != *$'\n'* && "$OA_OWNER_EMAIL" =~ $email ]] || { echo "OA_OWNER_EMAIL is not a valid address" >&2; exit 1; }
  [[ ! "$OA_OWNER_EMAIL" =~ [[:upper:]] ]] || { echo "OA_OWNER_EMAIL must be lowercase" >&2; exit 1; }
  owner="ALERT_TO=$OA_OWNER_EMAIL"$'\n'
fi
printf '%s%s' "$lines" "$owner" >> "$GITHUB_ENV"
printf '%s' "$lines"
