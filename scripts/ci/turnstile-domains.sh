#!/usr/bin/env bash
# A read-only check that the env's Turnstile widget covers the sign-up host.
# Finds the one widget named oa-<p>-turnstile (oa-p-turnstile for prod,
# oa-s-turnstile for staging) and prints only
#   name=<name> mode=<mode> domains=<comma list>
# never the secret, the sitekey, the token or the raw body. Fails unless
# exactly one widget has that name and its domains include the env's app
# domain or signup.<app domain>. One GET; the token reaches curl in a config
# on a process substitution, never argv.
# Env: TOKEN (the secret), HOSTED_DIR (holds <env>.json for the account id
# and app_zone).
# Usage: scripts/ci/turnstile-domains.sh <staging|prod>
set -euo pipefail

CF=https://api.cloudflare.com/client/v4

[ "$#" -eq 1 ] || { echo "usage: $0 <staging|prod>" >&2; exit 2; }
case "$1" in
  staging) ENV=staging; NAME=oa-s-turnstile ;;
  prod) ENV=prod; NAME=oa-p-turnstile ;;
  *) echo "unknown env: $1" >&2; exit 2 ;;
esac
: "${TOKEN:?TOKEN is required}"
: "${HOSTED_DIR:?HOSTED_DIR is required}"
[[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || { echo "the token is empty or has unexpected characters" >&2; exit 1; }

f="$HOSTED_DIR/$ENV.json"
[ -f "$f" ] || { echo "http=000" >&2; exit 1; }
account="$(jq -r '.account_id // ""' "$f")"
zone="$(jq -r '.app_zone // ""' "$f")"
[[ "$account" =~ ^[0-9a-f]{32}$ ]] || { echo "bad account id" >&2; exit 1; }
[[ "$zone" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "bad app zone" >&2; exit 1; }

_auth() { printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"; }

if out="$(curl -sS --max-time 30 -K <(_auth) -w $'\n%{http_code}' "$CF/accounts/$account/challenges/widgets?per_page=100" 2> /dev/null)"; then
  HTTP="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
else
  HTTP=000
  BODY='{}'
fi
[[ "$HTTP" =~ ^[0-9]{3}$ ]] || HTTP=000
jq -e . > /dev/null 2>&1 <<< "$BODY" || BODY='{}'
if [ "$HTTP" != 200 ] || [ "$(jq -r '.success' <<< "$BODY")" != true ]; then
  echo "::error::Turnstile widget list failed: http=$HTTP" >&2
  exit 1
fi

# Keep exactly name, mode and domains of the widgets with this name.
picked="$(jq -c --arg n "$NAME" '[.result[]? | select(.name == $n) | {name, mode, domains}]' <<< "$BODY")"
count="$(jq 'length' <<< "$picked")"
if [ "$count" != 1 ]; then
  echo "::error::want exactly one widget named $NAME, found $count" >&2
  exit 1
fi
line="$(jq -r '.[0] | "name=\(.name) mode=\(.mode // "") domains=\((.domains // []) | join(","))"' <<< "$picked")"
[[ "$line" =~ ^name=[a-z0-9-]+\ mode=[a-z-]*\ domains=[A-Za-z0-9.,*-]*$ ]] || { echo "::error::the widget has unexpected characters" >&2; exit 1; }
echo "$line"
if ! jq -e --arg z "$zone" '.[0].domains // [] | any(. == $z or . == "signup." + $z)' <<< "$picked" > /dev/null; then
  echo "::error::$NAME does not cover $zone or signup.$zone" >&2
  exit 1
fi
