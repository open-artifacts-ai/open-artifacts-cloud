#!/usr/bin/env bash
# Deploys one hosted platform Worker of one env (staging or prod) from CI
# (deploy-hosted-platform.yml),
# with the same fill-and-verify rules as the runbook (docs/ops/hosted.md):
#   1. deploy through deploy-platform-worker.sh (allowlist, placeholders filled
#      and checked, `--env <env>`, never an entry point or --name);
#   2. secrets only after the Worker exists: Google client secrets from the
#      environment (the auth broker's only when given or absent: rotation is a
#      re-run with it); generated keys on the first run only, never stored
#      anywhere else;
#   3. read the deployed settings back and refuse on any mismatch.
# Secrets go to wrangler on stdin and the API token to curl on stdin (-K -):
# none is ever in argv or printed.
# VERIFY_ONLY=1 deploys and sets nothing: it only reads the live Worker back and
# runs every check (a read-only rehearsal against what is deployed).
# Usage (env as below): scripts/ops/deploy-hosted-platform.sh staging|prod <target>
#   platform-db      PLATFORM_DB_ID MAIN_MIGRATION_LOCK (main's migration-lock.json;
#                    migrations, scripts/ops/platform-db.ts)
#   auth-broker      BROKER_REGISTRY_ID GOOGLE_CLIENT_ID [GOOGLE_CLIENT_SECRET]
#                    BROKER_PIN_FILE (main's packages/provision/src/wfp.ts: the
#                    client must equal its BROKER_GOOGLE_CLIENT_ID[<env>])
#   directory-broker DIRECTORY_REGISTRY_ID GOOGLE_DIRECTORY_CLIENT_ID GOOGLE_DIRECTORY_CLIENT_SECRET
#   provision-token  SECRETS_STORE_ID (reads only: the user pastes the secret)
#   provisioner      PLATFORM_DB_ID SECRETS_STORE_ID SIGNUP_DAILY_CAP SIGNUPS_ENABLED WELCOME_FROM
#   billing          BILLING_DB_ID (D1 oa-<p>-billing, which must exist)
#                    BROKER_REGISTRY_ID MAIN_BILLING_MIGRATION_LOCK (main's
#                    apps/billing/migration-lock.json; migrations,
#                    scripts/ops/billing-db.ts) the four Stripe price ids
#                    (STRIPE_PRICE_TEAM, _BUSINESS, _SOLO_MONTHLY, _SOLO_YEARLY; optional
#                    _TEAM_YEARLY, _BUSINESS_YEARLY until made)
#                    and, unless VERIFY_ONLY, STRIPE_SECRET_KEY and
#                    STRIPE_WEBHOOK_SECRET (the Environment's; a test-mode key
#                    on staging, a restricted rk_live_ key on prod, never
#                    sk_live_; both put on the Worker, a run without them
#                    fails before anything changes)
#   dispatch         HOSTS_KV_ID (both brokers must exist; on staging, when the
#                    tag declares a BILLING binding, oa-<p>-billing too, #1568)
#   scheduler        PLATFORM_DB_ID EMAIL_ZONE_TAGS EMAIL_DAILY_LIMIT ALERT_TO ALERT_FROM
#                    SIGNUP_DAILY_CAP SIGNUPS_ENABLED (both brokers,
#                    oa-<p>-provisioner and the oa-<p>-signups queue must exist)
#                    [FLEET_SMOKE_TOKEN FLEET_SMOKE_SHARE_TO] (#1343, the canary
#                    smoke's secrets: put on this Worker only, when given)
#   inventory        PLATFORM_DB_ID HOSTS_KV_ID GITHUB_REPOSITORY_ID GITHUB_REPOSITORY
#                    (owner/repo: the OIDC principal, design v7 6.3)
#   provisioning     PLATFORM_DB_ID BROKER_REGISTRY_ID DIRECTORY_REGISTRY_ID SIGNUPS_ENABLED
#                    GITHUB_REPOSITORY_ID SIGNUP_DAILY_CAP ADMIN_IDENTITIES (the
#                    Environment secret `email:sub,...`, #1007; the provisioner
#                    and auth broker must exist)
# Always: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID. DEPLOY_TAG (vX.Y.Z) goes to the
# wrapper, which tags each version with it; CI deploys require it.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 staging|prod platform-db|auth-broker|directory-broker|billing|provision-token|provisioner|dispatch|scheduler|inventory|provisioning" >&2
  exit 2
fi
env="$1"
target="$2"
case "$env" in
  staging) P=s; ZONE=open-artifacts-staging.app ;;
  prod) P=p; ZONE=open-artifacts.app ;;
  *) echo "env must be staging or prod" >&2; exit 2 ;;
esac
NS="oa-$env"
# In CI, prod runs only from main, in the prod deploy Environment.
if [ "${GITHUB_ACTIONS:-}" = true ] && [ "$env" = prod ]; then
  [ "${GITHUB_REF:-}" = refs/heads/main ] || { echo "prod deploys run only from main (GITHUB_REF is ${GITHUB_REF:-unset})" >&2; exit 2; }
  [ "${DEPLOY_ENVIRONMENT:-}" = hosted-prod-deploy ] || { echo "prod deploys run only in hosted-prod-deploy" >&2; exit 2; }
fi
VERIFY_ONLY="${VERIFY_ONLY:-}"
# The release tag every deployed Worker version carries (the wrapper passes it
# to wrangler as --tag, #1040). In CI a deploy needs it, checked before
# anything changes; verify_only deploys nothing.
if [ "${GITHUB_ACTIONS:-}" = true ] && [ -z "$VERIFY_ONLY" ]; then
  [[ "${DEPLOY_TAG:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "DEPLOY_TAG must be a stable vX.Y.Z release tag in CI" >&2; exit 2; }
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The allowlisted deploy wrapper (tests swap in a stub).
wrapper="${DEPLOY_WRAPPER:-$root/scripts/ops/deploy-platform-worker.sh}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 hex" >&2; exit 2; }
ACCT="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"

# A Cloudflare API GET; the token reaches curl on stdin, never argv.
cf_get() {
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS -K - "$ACCT$1"
}
# cf_send <method> <path> <body>: a write; the body is never a secret.
cf_send() {
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS -K - -X "$1" -H 'content-type: application/json' --data-binary "$3" "$ACCT$2"
}
# The body, only when .success is true; else the errors (never a token) and exit 1.
must() {
  local body
  body="$(cat)"
  if [ "$(jq -r '.success' <<< "$body" 2> /dev/null)" != true ]; then
    echo "$1 failed: $(jq -c '.errors' <<< "$body" 2> /dev/null || echo 'unparsable response')" >&2
    exit 1
  fi
  printf '%s' "$body"
}
worker_exists() { [ "$(cf_get "/workers/scripts/$1/settings" | jq -r '.success' 2> /dev/null)" = true ]; }
need_workers() {
  for w in "$@"; do worker_exists "$w" || { echo "$w does not exist: deploy it first" >&2; exit 1; }; done
}
# need_queue <name>: exactly one queue of that name in the account's listing,
# read whole on one page (a listing that pages refuses rather than guess).
need_queue() {
  local body
  body="$(cf_get "/queues?per_page=100" | must "list queues")"
  jq -e '(.result_info.total_count | type) == "number" and .result_info.total_count <= 100
    and (.result_info.total_pages // 1) <= 1 and .result_info.total_count == (.result | length)' \
    <<< "$body" > /dev/null || { echo "more than one page of queues; refusing" >&2; exit 1; }
  local n
  n="$(jq --arg q "$1" '[.result[] | select(.queue_name == $q)] | length' <<< "$body")"
  [ "$n" = 1 ] || { echo "$1 queue does not exist: create it first ($n listed)" >&2; exit 1; }
}
need() { # name: a required, non-empty env var
  [ -n "${!1:-}" ] || { echo "$1 is required for $target" >&2; exit 2; }
}
secret_names() { cf_get "/workers/scripts/$1/secrets" | must "list $1 secrets" | jq -r '.result[].name'; }
# put_secret <worker> <app dir> <name>: the value comes on stdin. A failed put
# is tried PUT_ATTEMPTS (3) times in all, PUT_RETRY_SLEEP seconds (default 5)
# after the first failure and three times that after the second: Cloudflare
# answers an unknown 10013 now and then (run 42647320740, #55). The value is
# held in a shell variable and fed to each attempt by the printf builtin, so it
# is never in argv, the log or a file.
PUT_ATTEMPTS=3
put_secret() {
  if [ -n "$VERIFY_ONLY" ]; then
    cat > /dev/null
    echo "$1: verify only, not setting $3"
    return
  fi
  local pause="${PUT_RETRY_SLEEP:-5}" v a
  [[ "$pause" =~ ^[0-9]{1,3}$ ]] || { echo "PUT_RETRY_SLEEP must be 0 to 999 seconds" >&2; return 1; }
  # The whole stdin, trailing newlines kept (as the one-shot put read it).
  v="$(cat; printf x)"
  v="${v%x}"
  for ((a = 1; a <= PUT_ATTEMPTS; a++)); do
    # A failure returns 1 (an `if` caller turns set -e off).
    if printf '%s' "$v" | (cd "$root/apps/$2" && pnpm exec wrangler secret put "$3" --env "$env" > /dev/null); then
      v=""
      echo "$1: $3 set"
      return 0
    fi
    if [ "$a" -lt "$PUT_ATTEMPTS" ]; then
      echo "$1: putting $3 failed (attempt $a of $PUT_ATTEMPTS); trying again" >&2
      sleep "$pause"
      pause=$((pause * 3))
    fi
  done
  v=""
  echo "$1: putting $3 failed" >&2
  return 1
}
# A secret put deploys a new, untagged Worker version, and the release tag
# (#1040) must be on the version that serves. A Worker that takes secrets
# deploys again once they are set (deploys keep secrets).
# deploy <app>: through the wrapper, unless VERIFY_ONLY.
deploy() {
  if [ -n "$VERIFY_ONLY" ]; then echo "$target: verify only, not deploying"; return; fi
  DEPLOY_TAG="${DEPLOY_TAG:-}" bash "$wrapper" "$1" "$env"
}
settings() { cf_get "/workers/scripts/$1/settings" | must "read $1 settings"; }
# list_all <path ending in ? or &> <what>: every page's .result as one array; a
# failed page stops the run (never reads as "absent").
list_all() {
  local page body all='[]' pages
  for ((page = 1; page <= 100; page++)); do
    body="$(cf_get "${1}per_page=100&page=$page" | must "$2")" || exit 1
    all="$(jq -c --argjson a "$all" '$a + (.result // [])' <<< "$body")"
    pages="$(jq -r '.result_info.total_pages // 1' <<< "$body")"
    [ "$page" -lt "$pages" ] || { printf '%s' "$all"; return 0; }
  done
  echo "$2: did not end after 100 pages" >&2
  exit 1
}
# cf_raw <path>: a GET whose body is not the API's JSON envelope: the body on
# stdout and "\n<HTTP status>" last.
cf_raw() {
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS -K - -w '\n%{http_code}' "$ACCT$1"
}
# kv_get <namespace id> <key>: the value on stdout, exit 0; 3 when the key is
# absent; 1 on any other answer.
kv_get() {
  local out code
  out="$(cf_raw "/storage/kv/namespaces/$1/values/$2")" || return 1
  code="${out##*$'\n'}"
  case "$code" in
    200) printf '%s' "${out%$'\n'*}" ;;
    404) return 3 ;;
    *) echo "read $2 from KV $1 failed (HTTP $code)" >&2; return 1 ;;
  esac
}
# bundle_get <worker>: the deployed script content on stdout; exit 1 on any
# answer but a 200 with a body that is not JSON (an error envelope is JSON;
# a bundle never is).
bundle_get() {
  local out code body
  out="$(cf_raw "/workers/scripts/$1/content/v2")" || { echo "read $1 content failed" >&2; return 1; }
  code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  [ "$code" = 200 ] || { echo "read $1 content failed (HTTP $code)" >&2; return 1; }
  [ -n "$body" ] || { echo "read $1 content failed: empty" >&2; return 1; }
  if jq -e . > /dev/null 2>&1 <<< "$body"; then echo "read $1 content failed: a JSON answer, not a bundle" >&2; return 1; fi
  printf '%s' "$body"
}
# committed <app> <vars|ratelimits>: the tag's committed values for this env
# (scripts/ops/wrangler-env.ts), placeholders filled from the environment.
committed() { node --experimental-strip-types --no-warnings "$root/scripts/ops/wrangler-env.ts" "$root/apps/$1/wrangler.jsonc" "$env" "$2"; }
# vars_are <settings json> <app>: the deployed plain-text vars equal the
# committed ones exactly (names and values).
vars_are() {
  local want got
  want="$(ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" committed "$2" vars | jq -S -c .)" || want=""
  [ -n "$want" ] || { echo "can't read $2's committed vars" >&2; exit 1; }
  got="$(jq -S -c '[.result.bindings[] | select(.type == "plain_text") | {(.name): .text}] | add // {}' <<< "$1")"
  [ "$got" = "$want" ] || { echo "$2 vars: got $got, want $want" >&2; exit 1; }
}
# The signups gate (design v7 7), on every Worker that reads it (provisioner,
# provisioning, scheduler): false; staging also test-users. true opens
# self-serve, which waits until after M1: it needs ALLOW_SIGNUPS=1 (a change
# the Manager approves), whatever the tag commits or the env asks for.
# signups_ok <value> <what>: refuses (exit 1) any other value.
signups_ok() {
  case "$1" in
    false) return 0 ;;
    test-users) [ "$env" = staging ] || { echo "$2: SIGNUPS_ENABLED=test-users is staging only; refusing" >&2; exit 1; } ;;
    invite) [ "${ALLOW_SIGNUPS:-}" = 1 ] || [ "${ALLOW_INVITE:-}" = 1 ] || { echo "$2: SIGNUPS_ENABLED=invite admits the allow list and needs ALLOW_SIGNUPS=1 or ALLOW_INVITE=1; refusing" >&2; exit 1; } ;;
    true) [ "${ALLOW_SIGNUPS:-}" = 1 ] || { echo "$2: SIGNUPS_ENABLED=true opens self-serve signups and needs ALLOW_SIGNUPS=1; refusing" >&2; exit 1; } ;;
    *) echo "$2: SIGNUPS_ENABLED is '$1', want false or invite (staging also test-users, true); refusing" >&2; exit 1 ;;
  esac
}
# signups_committed <app>: before deploying, the tag's committed value for
# this env (a literal, or the placeholder as SIGNUPS_ENABLED fills it).
signups_committed() {
  local v
  v="$(node --experimental-strip-types --no-warnings "$root/scripts/ops/wrangler-env.ts" "$root/apps/$1/wrangler.jsonc" "$env" signups)" ||
    { echo "can't read $1's committed SIGNUPS_ENABLED" >&2; exit 1; }
  signups_ok "$(jq -r '. // ""' <<< "$v")" "the tag's $env $1 config"
}
# signups_deployed <settings json> <worker>: after deploying (or verify only),
# the live value; exactly one binding.
signups_deployed() {
  signups_ok "$(jq -r '[.result.bindings[] | select(.name == "SIGNUPS_ENABLED") | .text // ""] | join(",")' <<< "$1")" "deployed $2"
}
# names_are <settings json> <want>: the non-var, non-secret binding names, sorted, comma-joined.
names_are() {
  local got
  got="$(jq -r '[.result.bindings[] | select(.type != "plain_text" and .type != "secret_text") | .name] | sort | join(",")' <<< "$1")"
  [ "$got" = "$2" ] || { echo "bindings: got '$got', want '$2'" >&2; exit 1; }
}
no_secret_bindings() {
  local got
  got="$(jq -r '[.result.bindings[] | select(.type == "secret_text") | .name] | join(",")' <<< "$1")"
  [ -z "$got" ] || { echo "$2 has secret bindings ($got); want none" >&2; exit 1; }
}
# expect <settings json> <jq filter> <want> <what>
expect() {
  local got
  got="$(jq -r "$2" <<< "$1")"
  [ "$got" = "$3" ] || { echo "$4: got '$got', want '$3'" >&2; exit 1; }
}
# expect_private: expect, for the owner's address (#1084). A verify_only run can
# hold the old one, which isn't masked: it names the field, never a value.
expect_private() {
  local got
  got="$(jq -r "$2" <<< "$1")"
  [ "$got" = "$3" ] || { echo "$4: not the expected value" >&2; exit 1; }
}

# The BILLING service binding (#1568) is required only when
# the tag being deployed declares it: main's scripts run against the tag's
# Workers, so a staging run of an older tag (whose wrangler has none) must not
# fail for lack of it, and a tag that declares it must not deploy without it.
# billing_pre <app> <entrypoint>, before deploying: reads the tag's committed
# env block (wrangler-env.ts billing). A declared binding must be exactly
# oa-<p>-billing (staging or prod) with this app's
# entrypoint ("" for the default one, BillingProvisionerRpc for the
# provisioner), and the Worker must exist (a binding needs its service
# deployed first); sets BILLING_DECLARED=1. Not declared: BILLING_DECLARED="" and
# nothing is required.
BILLING_DECLARED=""
billing_pre() {
  local c service entry
  BILLING_DECLARED=""
  c="$(node --experimental-strip-types --no-warnings "$root/scripts/ops/wrangler-env.ts" "$root/apps/$1/wrangler.jsonc" "$env" billing)" ||
    { echo "can't read $1's committed BILLING binding" >&2; exit 1; }
  [ "$c" != null ] || return 0
  service="$(jq -r '.service' <<< "$c")"
  entry="$(jq -r '.entrypoint // ""' <<< "$c")"
  [ "$service" = "oa-$P-billing" ] || { echo "the tag's $1 BILLING binding is '$service', want oa-$P-billing; refusing" >&2; exit 1; }
  [ "$entry" = "$2" ] || { echo "the tag's $1 BILLING binding has entrypoint '$entry', want '$2'; refusing" >&2; exit 1; }
  need_workers "oa-$P-billing"
  # Prod only, before anything is bound or deployed: every active install's
  # rendered vars must carry a TIER, or the billing gate would read it as Solo
  # (fail closed; scripts/ops/billing-tier-check.ts names the installs). A verify
  # only run binds nothing.
  if [ "$env" = prod ] && [ -z "$VERIFY_ONLY" ]; then
    need PLATFORM_DB_ID
    PLATFORM_DB_ID="$PLATFORM_DB_ID" node --experimental-strip-types --no-warnings "$root/scripts/ops/billing-tier-check.ts" prod ||
      { echo "refusing to bind BILLING on prod to $1: see the installs above" >&2; exit 1; }
  fi
  BILLING_DECLARED=1
}
# billing_bound <settings json> <app> <entrypoint>, after deploying (or verify
# only): when the tag declared it, the live binding is a service oa-<p>-billing
# with the entrypoint; otherwise (an older tag) there is none.
billing_bound() {
  local want=""
  [ -z "$BILLING_DECLARED" ] || want="service oa-$P-billing $3"
  expect "$1" '[.result.bindings[] | select(.name == "BILLING") | "\(.type) \(.service) \(.entrypoint // "")"] | join(",")' \
    "$want" "$2 BILLING binding"
}

# The approval email (#2096: WELCOME_FROM, the send_email WELCOME_EMAIL binding)
# is required only when the tag being deployed declares it: main's scripts run
# against the tag's Workers, so an older tag (whose wrangler has neither) must
# not fail for lack of it. Either one in the tag's config counts as declared,
# so a half-declared config is never loosened.
# welcome_declared <app>: in the main shell (no subshell to swallow the exit),
# sets WELCOME_DECLARED=1 when the tag's apps/<app>/wrangler.jsonc names
# WELCOME_FROM or WELCOME_EMAIL, else "". Unreadable: exit 1.
WELCOME_DECLARED=""
welcome_declared() {
  local rc=0
  WELCOME_DECLARED=""
  grep -q -E 'WELCOME_FROM|WELCOME_EMAIL' "$root/apps/$1/wrangler.jsonc" || rc=$?
  [ "$rc" -le 1 ] || { echo "can't read $1's committed wrangler.jsonc" >&2; exit 1; }
  [ "$rc" -ne 0 ] || WELCOME_DECLARED=1
}
# welcome_bound <settings json>, after welcome_declared: when declared, the live binding is send_email; otherwise none.
welcome_bound() {
  local want=""
  [ -z "$WELCOME_DECLARED" ] || want=send_email
  expect "$1" '[.result.bindings[] | select(.name == "WELCOME_EMAIL") | .type] | join(",")' "$want" "WELCOME_EMAIL"
}

# Workers Logs (#164) is checked strictly only when the tag being deployed
# turns observability on; an older tag (observability off or unstated) must
# read back off, and nothing is loosened for a tag that declares it.
# observability_is <settings json> <app>
observability_is() {
  local c
  c="$(node --experimental-strip-types --no-warnings "$root/scripts/ops/wrangler-env.ts" "$root/apps/$2/wrangler.jsonc" "$env" observability)" ||
    { echo "can't read $2's committed observability" >&2; exit 1; }
  if [ "$c" = true ]; then
    expect "$1" '.result.observability.enabled // false' true "observability"
    # An explicit false is required (a missing field is "null" and fails;
    # Cloudflare defaults it to on).
    expect "$1" '.result.observability.logs.invocation_logs | tostring' false "observability invocation_logs"
  else
    expect "$1" '.result.observability.enabled // false' false "observability"
  fi
}

# broker_pin: provision's BROKER_GOOGLE_CLIENT_ID[$env] from $BROKER_PIN_FILE
# (main's wfp.ts), or "null". Exit 1 when the pin can't be read.
# shellcheck disable=SC2016 # the JS template literal is single-quoted on purpose
broker_pin() {
  node -e '
    const src = require("node:fs").readFileSync(process.argv[1], "utf8");
    const m = /export const BROKER_GOOGLE_CLIENT_ID\b[^=]*=\s*Object\.freeze\(\{([^}]*)\}\)/.exec(src);
    const v = m && new RegExp(`(?:^|[\\s,])${process.argv[2]}:\\s*("[^"\\n]*"|null)\\s*,?`).exec(m[1]);
    if (!v) process.exit(1);
    console.log(v[1] === "null" ? "null" : JSON.parse(v[1]));
  ' "$BROKER_PIN_FILE" "$env"
}

case "$target" in
  platform-db)
    # MAIN_MIGRATION_LOCK: main's migration-lock.json; a pin the tag shares with
    # it must match (platform-db.ts refuses an edited, re-pinned migration), and
    # a pin only on main is skipped when newer than the tag's newest.
    need PLATFORM_DB_ID; need MAIN_MIGRATION_LOCK
    node --experimental-strip-types --no-warnings "$root/scripts/ops/platform-db.ts" "$env"
    ;;
  provision-token)
    need SECRETS_STORE_ID
    # Read only: the user pastes the token into Secrets Store (H2b, H4b).
    name="oa-$P-provision-token"
    found="$(list_all "/secrets_store/stores/$SECRETS_STORE_ID/secrets?search=$name&" "list Secrets Store secrets" |
      jq -c --arg n "$name" '[.[] | select(.name == $n)]')"
    case "$(jq length <<< "$found")" in
      1) ;;
      0)
        echo "$name is not in Secrets Store: create the token and paste it there (https://dash.cloudflare.com/?to=/:account/secrets-store), then rerun" >&2
        exit 1 ;;
      *) echo "$name: more than one secret of that name" >&2; exit 1 ;;
    esac
    modified="$(jq -r '.[0].modified // ""' <<< "$found")"
    [ -n "$modified" ] || { echo "$name has no modified time" >&2; exit 1; }
    echo "$name: present in Secrets Store, modified $modified"
    ;;
  provisioner)
    need PLATFORM_DB_ID; need SECRETS_STORE_ID; need SIGNUP_DAILY_CAP; need SIGNUPS_ENABLED
    welcome_declared provisioner
    [ -z "$WELCOME_DECLARED" ] || need WELCOME_FROM
    signups_committed provisioner
    # BILLING (#1568, when the tag declares it): the provisioner
    # starts an install's Solo trial through billing's BillingProvisionerRpc.
    # Unbound it would silently skip the free month, so a tag that declares the
    # binding must not deploy without it (read back below).
    billing_pre provisioner BillingProvisionerRpc
    # Check first, create only when absent; a failed listing stops the run.
    queues="$(list_all "/queues?" "list queues" | jq -r '.[].queue_name')"
    for q in "oa-$P-signups" "oa-$P-signups-dlq"; do
      grep -qx "$q" <<< "$queues" && continue
      [ -z "$VERIFY_ONLY" ] || { echo "queue $q does not exist" >&2; exit 1; }
      cf_send POST /queues "$(jq -nc --arg n "$q" '{queue_name: $n}')" | must "create queue $q" > /dev/null
      echo "queue $q created"
    done
    bucket="oa-$P-releases"
    b="$(cf_get "/r2/buckets/$bucket")"
    if [ "$(jq -r '.success' <<< "$b" 2> /dev/null)" != true ]; then
      [ "$(jq -r '[.errors[]?.code] | index(10006) != null' <<< "$b" 2> /dev/null)" = true ] ||
        { echo "read R2 bucket $bucket failed: $(jq -c '.errors' <<< "$b" 2> /dev/null || echo 'unparsable response')" >&2; exit 1; }
      [ -z "$VERIFY_ONLY" ] || { echo "R2 bucket $bucket does not exist" >&2; exit 1; }
      cf_send POST /r2/buckets "$(jq -nc --arg n "$bucket" '{name: $n}')" | must "create R2 bucket $bucket" > /dev/null
      echo "R2 bucket $bucket created"
    fi
    PLATFORM_DB_ID="$PLATFORM_DB_ID" SECRETS_STORE_ID="$SECRETS_STORE_ID" SIGNUP_DAILY_CAP="$SIGNUP_DAILY_CAP" \
      SIGNUPS_ENABLED="$SIGNUPS_ENABLED" WELCOME_FROM="${WELCOME_FROM:-}" deploy provisioner
    S="$(settings oa-$P-provisioner)"
    expect "$S" '.result.bindings[] | select(.name == "PLATFORM_DB") | .id' "$PLATFORM_DB_ID" "PLATFORM_DB"
    expect "$S" '.result.bindings[] | select(.name == "DISPATCHER") | .namespace' "$NS" "DISPATCHER"
    expect "$S" '.result.bindings[] | select(.name == "RELEASES") | .bucket_name' "$bucket" "RELEASES"
    welcome_bound "$S"
    expect "$S" '.result.bindings[] | select(.name == "PROVISION_TOKEN") | "\(.type) \(.store_id) \(.secret_name)"' \
      "secrets_store_secret $SECRETS_STORE_ID oa-$P-provision-token" "PROVISION_TOKEN"
    expect "$S" '.result.bindings[] | select(.name == "PROVISION_INSTALL") | "\(.workflow_name) \(.class_name)"' \
      "oa-$P-provision-install ProvisionInstall" "PROVISION_INSTALL"
    expect "$S" '.result.bindings[] | select(.name == "MANAGE_INSTALL") | "\(.workflow_name) \(.class_name)"' \
      "oa-$P-manage-install ManageInstall" "MANAGE_INSTALL"
    billing_bound "$S" provisioner BillingProvisionerRpc
    names_are "$S" "${BILLING_DECLARED:+BILLING,}DISPATCHER,MANAGE_INSTALL,PLATFORM_DB,PROVISION_INSTALL,PROVISION_TOKEN,RELEASES${WELCOME_DECLARED:+,WELCOME_EMAIL}"
    signups_deployed "$S" oa-$P-provisioner
    vars_are "$S" provisioner
    # The settings API's key for query-string redaction is not recorded, so it is not read.
    observability_is "$S" provisioner
    no_secret_bindings "$S" oa-$P-provisioner
    names="$(secret_names oa-$P-provisioner | tr '\n' ' ')"
    [ -z "$names" ] || { echo "oa-$P-provisioner has secrets '$names'; want none" >&2; exit 1; }
    ;;
  provisioning)
    need PLATFORM_DB_ID; need BROKER_REGISTRY_ID; need DIRECTORY_REGISTRY_ID; need GITHUB_REPOSITORY_ID; need SIGNUP_DAILY_CAP; need SIGNUPS_ENABLED
    welcome_declared provisioning
    [ -z "$WELCOME_DECLARED" ] || need WELCOME_FROM
    # ADMIN_IDENTITIES (#1007): the `email:sub` list is the Environment's
    # secret, never committed. Fail closed: no list, no deploy; each entry is
    # checked here and the value is never printed.
    need ADMIN_IDENTITIES
    # One line only: `read` stops at a newline, so a second line would go
    # unchecked yet be put.
    [[ "$ADMIN_IDENTITIES" != *[$'\n\r']* ]] || { echo "ADMIN_IDENTITIES has a line break; refusing" >&2; exit 2; }
    IFS=, read -ra ids <<< "$ADMIN_IDENTITIES"
    [ "${#ids[@]}" -gt 0 ] || { echo "ADMIN_IDENTITIES has no entries; refusing" >&2; exit 2; }
    for id in "${ids[@]}"; do
      [[ "$id" =~ ^[^:,[:space:]@]+@[^:,[:space:]@]+:[^:,[:space:]]+$ ]] ||
        { echo "ADMIN_IDENTITIES: an entry is not email:sub; refusing" >&2; exit 2; }
    done
    ids=()
    # A tag from before #1007 commits ADMIN_IDENTITIES as a var, which would go
    # live and then clash with the secret: deploy a tag with #1007.
    committed_ids="$(ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" committed provisioning vars | jq -r 'has("ADMIN_IDENTITIES")')" ||
      { echo "can't read provisioning's committed vars" >&2; exit 1; }
    [ "$committed_ids" = false ] || { echo "this tag commits ADMIN_IDENTITIES as a var; it is a secret since #1007: deploy a later tag" >&2; exit 1; }
    need_workers oa-$P-provisioner oa-$P-auth-broker
    # The sign-up steps (#40): staging always; prod only when main's
    # .github/hosted/prod.json says signup_deploy "on" (hosted-constants.sh
    # loads it as PROD_SIGNUP_DEPLOY, exactly on or off; unset means off).
    SKEY="install:i00000signup"
    SIGNUP_DEPLOY=""
    if [ "$env" = staging ] || { [ "$env" = prod ] && [ "${PROD_SIGNUP_DEPLOY:-}" = on ]; }; then SIGNUP_DEPLOY=1; fi
    # Off after on fails closed, before anything changes (verify_only too):
    # nothing is deleted here. Each leftover is named with its removal.
    if [ -z "$SIGNUP_DEPLOY" ]; then
      PW="oa-$P-provisioning"
      left=""
      if worker_exists "$PW" && grep -qx SIGNUP_BROKER_KEY <<< "$(secret_names "$PW")"; then
        left+="  - the secret SIGNUP_BROKER_KEY on $PW: delete it with: wrangler secret delete SIGNUP_BROKER_KEY --name $PW"$'\n'
      fi
      rc=0
      kv_get "$BROKER_REGISTRY_ID" "$SKEY" > /dev/null || rc=$?
      [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ] || exit 1
      if [ "$rc" -eq 0 ]; then
        left+="  - the registry entry $SKEY in oa-$P-broker-registry: delete it with: wrangler kv key delete $SKEY --namespace-id $BROKER_REGISTRY_ID --remote"$'\n'
      fi
      if [ -n "$left" ]; then
        printf '%s: signup_deploy is off in .github/hosted/%s.json, but sign-up leftovers exist; refusing. Remove them by hand (and the route signup.%s/* if hosted-zones.sh names it), or set signup_deploy to on:\n%s' "$PW" "$env" "$ZONE" "$left" >&2
        exit 1
      fi
    fi
    # BILLING (#66, when the tag declares it): an operator sets
    # an install's tier through billing's BillingOperatorRpc. Unbound, the tool
    # answers unavailable, so a tag that declares it must not deploy without it.
    billing_pre provisioning BillingOperatorRpc
    # Prod, before anything is deployed: the tag's committed vars carry no OIDC
    # principal and no test-users gate (4.4); the read-back checks them again.
    if [ "$env" = prod ]; then
      pre="$(ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" committed provisioning vars)" || pre=""
      [ -n "$pre" ] || { echo "can't read provisioning's committed vars" >&2; exit 1; }
      oidc="$(jq -r '[keys[] | select(startswith("OIDC_"))] | join(",")' <<< "$pre")"
      [ -z "$oidc" ] || { echo "prod provisioning commits $oidc; prod has no OIDC principal; refusing" >&2; exit 1; }
      [ "$(jq -r '.SIGNUPS_ENABLED // ""' <<< "$pre")" != test-users ] ||
        { echo "prod provisioning commits SIGNUPS_ENABLED=test-users (staging only); refusing" >&2; exit 1; }
    fi
    signups_committed provisioning
    # The Worker and what it depends on, the admin SPA among them (@oa/admin
    # is a devDependency). Its vite build writes apps/provisioning/dist-assets
    # (ASSETS) itself, nothing is copied, and the wrapper refuses a deploy
    # without its index.html.
    if [ -z "$VERIFY_ONLY" ]; then (cd "$root" && pnpm --filter "@oa/provisioning..." build); fi
    # The OAuth KV namespace: check first, create only when absent.
    ns="oa-$P-provisioning-oauth"
    kvs="$(list_all "/storage/kv/namespaces?" "list KV namespaces")"
    found="$(jq -r --arg t "$ns" '[.[] | select(.title == $t) | .id] | join(" ")' <<< "$kvs")"
    if [ -z "$found" ]; then
      [ -z "$VERIFY_ONLY" ] || { echo "KV namespace $ns does not exist" >&2; exit 1; }
      found="$(cf_send POST /storage/kv/namespaces "$(jq -nc --arg t "$ns" '{title: $t}')" | must "create KV namespace $ns" | jq -r '.result.id')"
      echo "KV namespace $ns created"
    fi
    [[ "$found" =~ ^[0-9a-f]{32}$ ]] || { echo "KV namespace $ns: want exactly one, with a 32 hex id" >&2; exit 1; }
    OAUTH_KV_ID="$found"
    PLATFORM_DB_ID="$PLATFORM_DB_ID" PROVISIONING_OAUTH_KV_ID="$OAUTH_KV_ID" GITHUB_REPOSITORY_ID="$GITHUB_REPOSITORY_ID" \
      SIGNUP_DAILY_CAP="$SIGNUP_DAILY_CAP" SIGNUPS_ENABLED="$SIGNUPS_ENABLED" WELCOME_FROM="${WELCOME_FROM:-}" deploy provisioning
    W="oa-$P-provisioning"
    have="$(secret_names "$W")"
    if ! grep -qx ADMIN_SESSION_KEY <<< "$have"; then
      openssl rand -base64 32 | put_secret "$W" provisioning ADMIN_SESSION_KEY
    fi
    # The admin's registry entry (4.3) carries the public half of
    # ADMIN_BROKER_KEY: a new key when either is missing, entry first (4.6).
    # A failed secret put deletes the new entry, so the next run makes both
    # again rather than keeping an entry the secret doesn't match.
    KEY="install:i000000admin"
    entry=""
    rc=0
    entry="$(kv_get "$BROKER_REGISTRY_ID" "$KEY")" || rc=$?
    [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ] || exit 1
    if [ -z "$VERIFY_ONLY" ] && { [ "$rc" -eq 3 ] || ! grep -qx ADMIN_BROKER_KEY <<< "$have"; }; then
      key="$(node --experimental-strip-types --no-warnings "$root/scripts/ops/broker-key.ts")"
      entry="$(jq -c --arg o "https://admin.$ZONE" '{installId: "i000000admin", origin: $o, keys: [{kid, x}], domains: []}' <<< "$key")"
      cf_send PUT "/storage/kv/namespaces/$BROKER_REGISTRY_ID/values/$KEY" "$entry" | must "write $KEY" > /dev/null
      echo "$W: registry entry $KEY written"
      if ! jq -r '.pkcs8' <<< "$key" | put_secret "$W" provisioning ADMIN_BROKER_KEY; then
        key=""
        if cf_send DELETE "/storage/kv/namespaces/$BROKER_REGISTRY_ID/values/$KEY" "" | must "delete $KEY" > /dev/null; then
          echo "$W: ADMIN_BROKER_KEY was not set; $KEY deleted, rerun to make both" >&2
        else
          echo "$W: ADMIN_BROKER_KEY was not set and $KEY could not be deleted: delete it by hand, then rerun" >&2
        fi
        exit 1
      fi
      key=""
    fi
    # Every deploy: the list can change, and the deployed value can't be read.
    printf '%s' "$ADMIN_IDENTITIES" | put_secret "$W" provisioning ADMIN_IDENTITIES
    # The sign-up host's broker key (signup.<app>, cloud #35, #40): staging,
    # and prod only with signup_deploy "on" (SIGNUP_DEPLOY, set above). Made like
    # the admin's (entry first, a failed put deletes it). Without it prod gets
    # none: its sign-in stays unavailable (503) and its sign-ups stay closed.
    SIGNUP_KEY_WANTED=""
    if [ -n "$SIGNUP_DEPLOY" ]; then
      SIGNUP_KEY_WANTED=1
      rc=0
      entry="$(kv_get "$BROKER_REGISTRY_ID" "$SKEY")" || rc=$?
      [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ] || exit 1
      if [ -z "$VERIFY_ONLY" ] && { [ "$rc" -eq 3 ] || ! grep -qx SIGNUP_BROKER_KEY <<< "$have"; }; then
        key="$(node --experimental-strip-types --no-warnings "$root/scripts/ops/broker-key.ts")"
        entry="$(jq -c --arg o "https://signup.$ZONE" '{installId: "i00000signup", origin: $o, keys: [{kid, x}], domains: []}' <<< "$key")"
        cf_send PUT "/storage/kv/namespaces/$BROKER_REGISTRY_ID/values/$SKEY" "$entry" | must "write $SKEY" > /dev/null
        echo "$W: registry entry $SKEY written"
        if ! jq -r '.pkcs8' <<< "$key" | put_secret "$W" provisioning SIGNUP_BROKER_KEY; then
          key=""
          if cf_send DELETE "/storage/kv/namespaces/$BROKER_REGISTRY_ID/values/$SKEY" "" | must "delete $SKEY" > /dev/null; then
            echo "$W: SIGNUP_BROKER_KEY was not set; $SKEY deleted, rerun to make both" >&2
          else
            echo "$W: SIGNUP_BROKER_KEY was not set and $SKEY could not be deleted: delete it by hand, then rerun" >&2
          fi
          exit 1
        fi
        key=""
      fi
    else
      echo "$W: no SIGNUP_BROKER_KEY on $env: signup.<app> sign-in stays unavailable (503)"
    fi
    # The Turnstile site key (public): the env's one widget oa-<p>-turnstile
    # (its domain [<app>] covers signup.<app>), found by exact name; under the
    # same switch as the broker key. The widget's secret is never read here. Zero or
    # several widgets, or a failed listing: say so and leave it unset (the page
    # then says sign-ups are unavailable); never fails the deploy.
    if [ -n "$SIGNUP_DEPLOY" ]; then
      widgets="$(list_all "/challenges/widgets?" "list Turnstile widgets")" || widgets=""
      sitekeys="$(jq -r --arg n "oa-$P-turnstile" '[.[]? | select(.name == $n) | .sitekey] | join(" ")' <<< "$widgets" 2> /dev/null)" || sitekeys=""
      if [[ "$sitekeys" =~ ^[0-9A-Za-z_-]{1,64}$ ]]; then
        printf '%s' "$sitekeys" | put_secret "$W" provisioning TURNSTILE_SITEKEY
      else
        echo "$W: TURNSTILE_SITEKEY not set: want exactly one Turnstile widget named oa-$P-turnstile (found: '${sitekeys:-none}', or the listing failed); the sign-up page says sign-ups are unavailable until it is" >&2
      fi
    else
      echo "$W: no TURNSTILE_SITEKEY on $env: the sign-up page says sign-ups are unavailable"
    fi
    # Again after the secrets: the serving version carries the tag.
    PLATFORM_DB_ID="$PLATFORM_DB_ID" PROVISIONING_OAUTH_KV_ID="$OAUTH_KV_ID" GITHUB_REPOSITORY_ID="$GITHUB_REPOSITORY_ID" \
      SIGNUP_DAILY_CAP="$SIGNUP_DAILY_CAP" SIGNUPS_ENABLED="$SIGNUPS_ENABLED" WELCOME_FROM="${WELCOME_FROM:-}" deploy provisioning
    S="$(settings "$W")"
    expect "$S" '.result.bindings[] | select(.name == "PLATFORM_DB") | .id' "$PLATFORM_DB_ID" "PLATFORM_DB"
    expect "$S" '.result.bindings[] | select(.name == "OAUTH_KV") | .namespace_id' "$OAUTH_KV_ID" "OAUTH_KV"
    expect "$S" '.result.bindings[] | select(.name == "PROVISIONER") | "\(.service) \(.entrypoint)"' "oa-$P-provisioner ProvisionerRpc" "PROVISIONER"
    expect "$S" '.result.bindings[] | select(.name == "AUTH_BROKER") | .service' "oa-$P-auth-broker" "AUTH_BROKER"
    expect "$S" '.result.bindings[] | select(.name == "SIGNUPS") | .queue_name' "oa-$P-signups" "SIGNUPS"
    expect "$S" '.result.bindings[] | select(.name == "ASSETS") | .type' assets "ASSETS"
    welcome_bound "$S"
    for wf in "PROVISION_INSTALL oa-$P-provision-install ProvisionInstall" "MANAGE_INSTALL oa-$P-manage-install ManageInstall"; do
      read -r b n c <<< "$wf"
      expect "$S" ".result.bindings[] | select(.name == \"$b\") | \"\\(.workflow_name) \\(.class_name) \\(.script_name)\"" "$n $c oa-$P-provisioner" "$b"
    done
    want="$(committed provisioning ratelimits | jq -c .)" || want=""
    [ -n "$want" ] || { echo "can't read provisioning's committed rate limits" >&2; exit 1; }
    got="$(jq -c '[.result.bindings[] | select(.type == "ratelimit") | {name, namespace_id: (.namespace_id | tostring), limit: .simple.limit, period: .simple.period}] | sort_by(.name)' <<< "$S")"
    [ "$got" = "$want" ] || { echo "rate limits: got $got, want $want" >&2; exit 1; }
    billing_bound "$S" provisioning BillingOperatorRpc
    names_are "$S" "$(jq -r --arg b "${BILLING_DECLARED:+BILLING}" --arg w "${WELCOME_DECLARED:+WELCOME_EMAIL}" '([.[].name, "ASSETS", "AUTH_BROKER", "CF_VERSION_METADATA", "MANAGE_INSTALL", "OAUTH_KV", "PLATFORM_DB", "PROVISIONER", "PROVISION_INSTALL", "SIGNUPS"] + (if $b == "" then [] else [$b] end) + (if $w == "" then [] else [$w] end)) | sort | join(",")' <<< "$want")"
    if [ "$env" = prod ]; then
      oidc="$(jq -r '[.result.bindings[] | select(.name | startswith("OIDC_")) | .name] | join(",")' <<< "$S")"
      [ -z "$oidc" ] || { echo "prod $W binds $oidc; prod has no OIDC principal" >&2; exit 1; }
      expect "$S" '.result.bindings[] | select(.name == "SIGNUPS_ENABLED") | .text | . == "test-users"' false "SIGNUPS_ENABLED (test-users is staging only)"
    fi
    signups_deployed "$S" "$W"
    # MCP_REDIRECT_URIS among them; ADMIN_IDENTITIES is a secret, by name only.
    vars_are "$S" provisioning
    # The settings API's key for query-string redaction is not recorded, so it is not read.
    observability_is "$S" provisioning
    names="$(secret_names "$W" | sort | tr '\n' ' ')"
    # TURNSTILE_SITEKEY may be there or not (set once, kept while empty).
    names="${names/TURNSTILE_SITEKEY /}"
    want_names="ADMIN_BROKER_KEY ADMIN_IDENTITIES ADMIN_SESSION_KEY ${SIGNUP_KEY_WANTED:+SIGNUP_BROKER_KEY }"
    [ "$names" = "$want_names" ] || { echo "$W secrets are '$names'" >&2; exit 1; }
    if [ -n "$SIGNUP_KEY_WANTED" ]; then
      rc=0
      entry="$(kv_get "$BROKER_REGISTRY_ID" "$SKEY")" || rc=$?
      [ "$rc" -eq 0 ] || { [ "$rc" -eq 3 ] && echo "$SKEY is not in oa-$P-broker-registry" >&2; exit 1; }
      ok="$(jq -r --arg o "https://signup.$ZONE" '.installId == "i00000signup" and .origin == $o and .domains == [] and (.keys | length) >= 1
        and all(.keys[]; (.kid | type) == "string" and (.x | type) == "string") and (.disabled // false) == false' <<< "$entry" 2> /dev/null)" || ok=""
      [ "$ok" = true ] || { echo "$SKEY in oa-$P-broker-registry is not the sign-up entry" >&2; exit 1; }
    fi
    rc=0
    entry="$(kv_get "$BROKER_REGISTRY_ID" "$KEY")" || rc=$?
    [ "$rc" -eq 0 ] || { [ "$rc" -eq 3 ] && echo "$KEY is not in oa-$P-broker-registry" >&2; exit 1; }
    ok="$(jq -r --arg o "https://admin.$ZONE" '.installId == "i000000admin" and .origin == $o and .domains == [] and (.keys | length) >= 1
      and all(.keys[]; (.kid | type) == "string" and (.x | type) == "string") and (.disabled // false) == false' <<< "$entry" 2> /dev/null)" || ok=""
    [ "$ok" = true ] || { echo "$KEY in oa-$P-broker-registry is not the admin entry" >&2; exit 1; }
    rc=0
    kv_get "$DIRECTORY_REGISTRY_ID" "$KEY" > /dev/null || rc=$?
    [ "$rc" -eq 3 ] || { [ "$rc" -eq 0 ] && echo "$KEY is in oa-$P-directory-registry; it must never be" >&2; exit 1; }
    # The sign-in stub never reaches a deployed bundle (12.1).
    bundle="$(bundle_get "$W")" || exit 1
    if grep -q 'test-signin' <<< "$bundle"; then echo "$W's bundle contains test-signin" >&2; exit 1; fi
    ;;
  auth-broker)
    need BROKER_REGISTRY_ID; need GOOGLE_CLIENT_ID; need BROKER_PIN_FILE
    # Before anything is deployed: the client must be provision's pin.
    pin="$(broker_pin)" || { echo "can't read BROKER_GOOGLE_CLIENT_ID[$env] from $BROKER_PIN_FILE; refusing" >&2; exit 1; }
    [ "$pin" != null ] || { echo "BROKER_GOOGLE_CLIENT_ID[$env] is null in provision: pin the client first; refusing" >&2; exit 1; }
    [ "$pin" = "$GOOGLE_CLIENT_ID" ] || { echo "GOOGLE_CLIENT_ID differs from provision's BROKER_GOOGLE_CLIENT_ID[$env] ($pin); refusing" >&2; exit 1; }
    # No secret given and none there (a new Worker has none): refuse before
    # deploying, so no broker runs without its client secret.
    if [ -z "${GOOGLE_CLIENT_SECRET:-}" ] && [ -z "$VERIFY_ONLY" ]; then
      if ! { worker_exists oa-$P-auth-broker && grep -qx GOOGLE_CLIENT_SECRET <<< "$(secret_names oa-$P-auth-broker)"; }; then
        echo "oa-$P-auth-broker has no GOOGLE_CLIENT_SECRET: set it in the Environment and rerun" >&2; exit 1
      fi
    fi
    BROKER_REGISTRY_ID="$BROKER_REGISTRY_ID" GOOGLE_CLIENT_ID_PROD="$GOOGLE_CLIENT_ID" \
      deploy auth-broker
    # Read first: a failed listing stops here, never reads as "absent" (which
    # would replace a live key). Secrets survive `wrangler deploy`, so the
    # Google secret is put only when given (rotation) or absent.
    have="$(secret_names oa-$P-auth-broker)"
    if [ -n "${GOOGLE_CLIENT_SECRET:-}" ]; then
      printf '%s' "$GOOGLE_CLIENT_SECRET" | put_secret oa-$P-auth-broker auth-broker GOOGLE_CLIENT_SECRET
    elif ! grep -qx GOOGLE_CLIENT_SECRET <<< "$have" && [ -z "$VERIFY_ONLY" ]; then
      echo "oa-$P-auth-broker has no GOOGLE_CLIENT_SECRET: set it in the Environment and rerun" >&2
      exit 1
    fi
    if ! grep -qx BROKER_STATE_KEY <<< "$have"; then
      openssl rand -base64 32 | put_secret oa-$P-auth-broker auth-broker BROKER_STATE_KEY
    fi
    # Again after the secrets: the serving version carries the tag.
    BROKER_REGISTRY_ID="$BROKER_REGISTRY_ID" GOOGLE_CLIENT_ID_PROD="$GOOGLE_CLIENT_ID" \
      deploy auth-broker
    S="$(settings oa-$P-auth-broker)"
    expect "$S" '.result.bindings[] | select(.name == "BROKER_REGISTRY") | .namespace_id' "$BROKER_REGISTRY_ID" "BROKER_REGISTRY"
    expect "$S" '.result.bindings[] | select(.name == "GOOGLE_CLIENT_ID") | .text' "$GOOGLE_CLIENT_ID" "GOOGLE_CLIENT_ID"
    expect "$S" '.result.bindings[] | select(.name == "BROKER_ORIGIN") | .text' "https://auth.$ZONE" "BROKER_ORIGIN"
    expect "$S" '.result.observability.enabled // false' false "observability"
    names="$(secret_names oa-$P-auth-broker | sort | tr '\n' ' ')"
    [ "$names" = "BROKER_STATE_KEY GOOGLE_CLIENT_SECRET " ] || { echo "oa-$P-auth-broker secrets are '$names'" >&2; exit 1; }
    ;;
  directory-broker)
    need DIRECTORY_REGISTRY_ID; need GOOGLE_DIRECTORY_CLIENT_ID
    # As auth-broker: no secret given and none there (a new Worker has none):
    # refuse before deploying, so no broker runs without its client secret.
    if [ -z "${GOOGLE_DIRECTORY_CLIENT_SECRET:-}" ] && [ -z "$VERIFY_ONLY" ]; then
      if ! { worker_exists oa-$P-directory-broker && grep -qx GOOGLE_DIRECTORY_CLIENT_SECRET <<< "$(secret_names oa-$P-directory-broker)"; }; then
        echo "oa-$P-directory-broker has no GOOGLE_DIRECTORY_CLIENT_SECRET: set it in the Environment and rerun" >&2; exit 1
      fi
    fi
    DIRECTORY_REGISTRY_ID="$DIRECTORY_REGISTRY_ID" GOOGLE_DIRECTORY_CLIENT_ID_PROD="$GOOGLE_DIRECTORY_CLIENT_ID" \
      deploy directory-broker
    # Read first: a failed listing stops here, never reads as "absent" (which
    # would replace a live key). Secrets survive `wrangler deploy`, so the
    # Google secret is put only when given (rotation) or absent.
    have="$(secret_names oa-$P-directory-broker)"
    if [ -n "${GOOGLE_DIRECTORY_CLIENT_SECRET:-}" ]; then
      printf '%s' "$GOOGLE_DIRECTORY_CLIENT_SECRET" | put_secret oa-$P-directory-broker directory-broker GOOGLE_DIRECTORY_CLIENT_SECRET
    elif ! grep -qx GOOGLE_DIRECTORY_CLIENT_SECRET <<< "$have" && [ -z "$VERIFY_ONLY" ]; then
      echo "oa-$P-directory-broker has no GOOGLE_DIRECTORY_CLIENT_SECRET: set it in the Environment and rerun" >&2
      exit 1
    fi
    if ! grep -qx DIRECTORY_STATE_KEY <<< "$have"; then
      openssl rand -base64 32 | put_secret oa-$P-directory-broker directory-broker DIRECTORY_STATE_KEY
    fi
    # Again after the secrets: the serving version carries the tag.
    DIRECTORY_REGISTRY_ID="$DIRECTORY_REGISTRY_ID" GOOGLE_DIRECTORY_CLIENT_ID_PROD="$GOOGLE_DIRECTORY_CLIENT_ID" \
      deploy directory-broker
    S="$(settings oa-$P-directory-broker)"
    expect "$S" '.result.bindings[] | select(.name == "DIRECTORY_REGISTRY") | .namespace_id' "$DIRECTORY_REGISTRY_ID" "DIRECTORY_REGISTRY"
    expect "$S" '.result.bindings[] | select(.name == "GOOGLE_DIRECTORY_CLIENT_ID") | .text' "$GOOGLE_DIRECTORY_CLIENT_ID" "GOOGLE_DIRECTORY_CLIENT_ID"
    expect "$S" '.result.bindings[] | select(.name == "DIRECTORY_ORIGIN") | .text' "https://directory.$ZONE" "DIRECTORY_ORIGIN"
    expect "$S" '.result.observability.enabled // false' false "observability"
    names="$(secret_names oa-$P-directory-broker | sort | tr '\n' ' ')"
    [ "$names" = "DIRECTORY_STATE_KEY GOOGLE_DIRECTORY_CLIENT_SECRET " ] || { echo "oa-$P-directory-broker secrets are '$names'" >&2; exit 1; }
    ;;
  billing)
    # Staging and prod. Everything is checked before anything
    # changes, so a Worker is never left half configured.
    need BILLING_DB_ID; need BROKER_REGISTRY_ID; need MAIN_BILLING_MIGRATION_LOCK
    for k in STRIPE_PRICE_TEAM STRIPE_PRICE_BUSINESS STRIPE_PRICE_SOLO_MONTHLY STRIPE_PRICE_SOLO_YEARLY; do
      need "$k"
      [[ "${!k}" =~ ^price_[A-Za-z0-9]{1,255}$ ]] || { echo "$k is not a Stripe price id" >&2; exit 2; }
    done
    # The yearly Team and Business prices are optional until made.
    for k in STRIPE_PRICE_TEAM_YEARLY STRIPE_PRICE_BUSINESS_YEARLY; do
      [ -z "${!k:-}" ] || [[ "${!k}" =~ ^price_[A-Za-z0-9]{1,255}$ ]] || { echo "$k is not a Stripe price id" >&2; exit 2; }
    done
    # The portal configuration is optional (unset: Stripe's default portal).
    [ -z "${STRIPE_PORTAL_CONFIG:-}" ] || [[ "$STRIPE_PORTAL_CONFIG" =~ ^bpc_[A-Za-z0-9]{1,255}$ ]] ||
      { echo "STRIPE_PORTAL_CONFIG is not a Stripe portal configuration id" >&2; exit 2; }
    if [ -z "$VERIFY_ONLY" ]; then
      need STRIPE_SECRET_KEY; need STRIPE_WEBHOOK_SECRET
      # Test mode on staging, a restricted live key on prod (billing-core
      # refuses the other mode's key and sk_live_ too); never printed.
      if [ "$env" = prod ]; then
        [[ "$STRIPE_SECRET_KEY" =~ ^rk_live_[A-Za-z0-9]{8,255}$ ]] ||
          { echo "STRIPE_SECRET_KEY must be a restricted live key (rk_live_) on prod; a test key or sk_live_ is refused" >&2; exit 2; }
      else
        [[ "$STRIPE_SECRET_KEY" =~ ^(sk|rk)_test_[A-Za-z0-9]{8,255}$ ]] ||
          { echo "STRIPE_SECRET_KEY must be a Stripe test-mode key (sk_test_ or rk_test_) on staging; a live key is refused" >&2; exit 2; }
      fi
      [[ "$STRIPE_WEBHOOK_SECRET" =~ ^whsec_[A-Za-z0-9+/=_-]{8,255}$ ]] ||
        { echo "STRIPE_WEBHOOK_SECRET must be a Stripe signing secret (whsec_...)" >&2; exit 2; }
      # Prod: every configured price must resolve under the live key with
      # livemode true (a test key under the live name, or a test-mode price, stops
      # the deploy here, before anything changes). Fail closed; never prints the key.
      if [ "$env" = prod ]; then
        node --experimental-strip-types --no-warnings "$root/scripts/ops/stripe-price-livemode.ts" prod ||
          { echo "refusing to deploy billing on prod: the Stripe prices are not live mode" >&2; exit 2; }
      fi
    fi
    # The schema first: the Worker never runs on a stale one. billing-db.ts
    # applies each pinned file once (a frozen lock, main's pins kept) and reads
    # it back; VERIFY_ONLY passes through and fails while one is pending.
    BILLING_DB_ID="$BILLING_DB_ID" MAIN_BILLING_MIGRATION_LOCK="$MAIN_BILLING_MIGRATION_LOCK" \
      node --experimental-strip-types --no-warnings "$root/scripts/ops/billing-db.ts" "$env"
    billing_deploy() {
      BILLING_DB_ID="$BILLING_DB_ID" BROKER_REGISTRY_ID="$BROKER_REGISTRY_ID" \
        STRIPE_PRICE_TEAM="$STRIPE_PRICE_TEAM" STRIPE_PRICE_BUSINESS="$STRIPE_PRICE_BUSINESS" \
        STRIPE_PRICE_SOLO_MONTHLY="$STRIPE_PRICE_SOLO_MONTHLY" STRIPE_PRICE_SOLO_YEARLY="$STRIPE_PRICE_SOLO_YEARLY" \
        STRIPE_PRICE_TEAM_YEARLY="${STRIPE_PRICE_TEAM_YEARLY:-}" STRIPE_PRICE_BUSINESS_YEARLY="${STRIPE_PRICE_BUSINESS_YEARLY:-}" \
        STRIPE_PORTAL_CONFIG="${STRIPE_PORTAL_CONFIG:-}" \
        deploy billing
    }
    billing_deploy
    # Both secrets every run (a rotation is a re-run), then deploy again so the
    # serving version carries the tag (#1040). Never in argv or the log.
    if [ -z "$VERIFY_ONLY" ]; then
      printf '%s' "$STRIPE_SECRET_KEY" | put_secret oa-$P-billing billing STRIPE_SECRET_KEY || exit 1
      printf '%s' "$STRIPE_WEBHOOK_SECRET" | put_secret oa-$P-billing billing STRIPE_WEBHOOK_SECRET || exit 1
      billing_deploy
    fi
    S="$(settings oa-$P-billing)"
    expect "$S" '.result.bindings[] | select(.name == "BILLING_DB") | .id' "$BILLING_DB_ID" "BILLING_DB"
    expect "$S" '.result.bindings[] | select(.name == "BROKER_REGISTRY") | .namespace_id' "$BROKER_REGISTRY_ID" "BROKER_REGISTRY"
    names_are "$S" "BILLING_DB,BROKER_REGISTRY"
    # OA_ENV and the four price ids, as the tag commits them (filled from env).
    vars_are "$S" billing
    expect "$S" '.result.observability.enabled // false' false "observability"
    names="$(secret_names oa-$P-billing | sort | tr '\n' ' ')"
    [ "$names" = "STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET " ] || { echo "oa-$P-billing secrets are '$names'" >&2; exit 1; }
    crons="$(cf_get /workers/scripts/oa-$P-billing/schedules | must "read oa-$P-billing schedules" | jq -r '[.result.schedules[].cron] | sort | join(",")')"
    [ "$crons" = "17 3 * * *" ] || { echo "oa-$P-billing schedules are '$crons'" >&2; exit 1; }
    ;;
  dispatch)
    need HOSTS_KV_ID
    need_workers oa-$P-auth-broker oa-$P-directory-broker
    # BILLING (#1568, when the tag declares it).
    billing_pre dispatch ""
    HOSTS_KV_ID="$HOSTS_KV_ID" deploy dispatch
    S="$(settings oa-$P-dispatch)"
    expect "$S" '.result.bindings[] | select(.name == "HOSTS") | .namespace_id' "$HOSTS_KV_ID" "HOSTS"
    expect "$S" '.result.bindings[] | select(.name == "DISPATCHER") | .namespace' "$NS" "DISPATCHER"
    expect "$S" '.result.bindings[] | select(.name == "AUTH_BROKER") | .service' oa-$P-auth-broker "AUTH_BROKER"
    expect "$S" '.result.bindings[] | select(.name == "DIRECTORY_BROKER") | .service' oa-$P-directory-broker "DIRECTORY_BROKER"
    billing_bound "$S" dispatch ""
    expect "$S" '.result.bindings[] | select(.name == "OA_ENV") | .text' "$env" "OA_ENV"
    observability_is "$S" dispatch
    ;;
  scheduler)
    need PLATFORM_DB_ID; need EMAIL_ZONE_TAGS; need EMAIL_DAILY_LIMIT
    # An empty ALERT_TO fails the run (4.8): no alert is ever "sent" nowhere.
    need ALERT_TO; need ALERT_FROM; need SIGNUP_DAILY_CAP; need SIGNUPS_ENABLED
    # Its Workflows, RPC and producer bindings point at these: deploying first
    # would ship a scheduler bound to nothing.
    need_workers oa-$P-auth-broker oa-$P-directory-broker oa-$P-provisioner
    # BILLING (#1568, when the tag declares it).
    billing_pre scheduler ""
    need_queue oa-$P-signups
    # The tag's alert wiring (#915) must be "pinned": every alert var and
    # ALERT_EMAIL's destination is this env's placeholder. "absent" (none of
    # them, a tag before #915) refuses: an alert must have somewhere to go
    # (4.8). A half-pinned config refuses too.
    alerts="$(committed scheduler alert-pins | jq -r .)" || alerts=""
    case "$alerts" in
      pinned) ;;
      absent) echo "the tag's scheduler config doesn't pin the $env alerts (ALERT_TO, ALERT_EMAIL's destination_address: #915); alerts need a destination (4.8); refusing" >&2; exit 1 ;;
      *) echo "the tag's scheduler config half pins the $env alerts; refusing" >&2; exit 1 ;;
    esac
    signups_committed scheduler
    # The canary smoke's secrets (#1343): smoke's PAT and the share target's
    # address, from the Environment, for this Worker only. Checked before any
    # deploy; never echoed (put_secret reads stdin).
    smoke_puts=""
    for k in FLEET_SMOKE_TOKEN FLEET_SMOKE_SHARE_TO; do
      if [ -n "${!k:-}" ]; then smoke_puts="$smoke_puts $k"; fi
    done
    if [ -n "${FLEET_SMOKE_TOKEN:-}" ] && ! [[ "$FLEET_SMOKE_TOKEN" =~ ^[A-Za-z0-9._~+/=-]{16,512}$ ]]; then
      echo "FLEET_SMOKE_TOKEN is malformed; refusing" >&2; exit 1
    fi
    if [ -n "${FLEET_SMOKE_SHARE_TO:-}" ] && ! [[ "$FLEET_SMOKE_SHARE_TO" =~ ^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$ ]]; then
      echo "FLEET_SMOKE_SHARE_TO must be one lowercase address; refusing" >&2; exit 1
    fi
    # The retry wait is checked before any deploy: a bad value must not leave
    # the run half done.
    [[ "${PUT_RETRY_SLEEP:-5}" =~ ^[0-9]{1,3}$ ]] || { echo "PUT_RETRY_SLEEP must be 0 to 999 seconds" >&2; exit 1; }
    sched_deploy() {
      PLATFORM_DB_ID="$PLATFORM_DB_ID" EMAIL_ZONE_TAGS="$EMAIL_ZONE_TAGS" EMAIL_DAILY_LIMIT="$EMAIL_DAILY_LIMIT" \
        ALERT_TO="$ALERT_TO" ALERT_FROM="$ALERT_FROM" SIGNUP_DAILY_CAP="$SIGNUP_DAILY_CAP" SIGNUPS_ENABLED="$SIGNUPS_ENABLED" \
        deploy scheduler
    }
    # The tag order (#1040): a secret put makes an untagged version, so a
    # tagged deploy follows the puts (deploys keep secrets). The scheduler's
    # tag is read by the chain (worker-tag.sh exits on an untagged scheduler),
    # so it must never be left untagged: if a put still fails after its
    # retries, the last tagged deploy runs anyway (an earlier put may already
    # have made an untagged version), and then the run is red (#55). That
    # deploy is retried the same bounded way. The Environment always provides
    # the values and a secret's value can't be read back (only its name is
    # listed), so "only when changed" can't be known: they are put every run.
    sched_deploy
    if [ -n "$smoke_puts" ]; then
      put_failed=""
      for k in $smoke_puts; do
        if ! printf '%s' "${!k}" | put_secret oa-$P-scheduler scheduler "$k"; then
          put_failed="$k"
          break
        fi
      done
      final_pause="${PUT_RETRY_SLEEP:-5}"
      final_ok=""
      for ((a = 1; a <= PUT_ATTEMPTS; a++)); do
        if sched_deploy; then final_ok=1; break; fi
        if [ "$a" -lt "$PUT_ATTEMPTS" ]; then
          echo "oa-$P-scheduler: the tagged deploy after the secrets failed (attempt $a of $PUT_ATTEMPTS); trying again" >&2
          sleep "$final_pause"
          final_pause=$((final_pause * 3))
        fi
      done
      if [ -n "$put_failed" ] && [ -z "$final_ok" ]; then
        echo "oa-$P-scheduler: putting $put_failed failed, and the tagged deploy after it failed too: the scheduler may serve an untagged version" >&2
        exit 1
      elif [ -n "$put_failed" ]; then
        echo "oa-$P-scheduler: putting $put_failed failed; the tagged deploy ran again, so the scheduler serves the tag, and the run stays red" >&2
        exit 1
      elif [ -z "$final_ok" ]; then
        echo "oa-$P-scheduler: the tagged deploy after the secrets failed: the scheduler may serve an untagged version" >&2
        exit 1
      fi
    fi
    S="$(settings oa-$P-scheduler)"
    billing_bound "$S" scheduler ""
    expect "$S" '.result.bindings[] | select(.name == "PROVISIONER") | .type' service "PROVISIONER type"
    expect "$S" '.result.bindings[] | select(.name == "PROVISIONER") | .service' oa-$P-provisioner "PROVISIONER"
    expect "$S" '.result.bindings[] | select(.name == "PROVISIONER") | .entrypoint' ProvisionerRpc "PROVISIONER entrypoint"
    expect "$S" '.result.bindings[] | select(.name == "SIGNUPS") | .type' queue "SIGNUPS type"
    expect "$S" '.result.bindings[] | select(.name == "SIGNUPS") | .queue_name' oa-$P-signups "SIGNUPS"
    # Workflow bindings: the read-back field names for the workflow's name and
    # script are not documented, so only the type is checked.
    expect "$S" '.result.bindings[] | select(.name == "PROVISION_INSTALL") | .type' workflow "PROVISION_INSTALL"
    expect "$S" '.result.bindings[] | select(.name == "MANAGE_INSTALL") | .type' workflow "MANAGE_INSTALL"
    expect "$S" '.result.bindings[] | select(.name == "ALERT_EMAIL") | .type' send_email "ALERT_EMAIL"
    expect "$S" '.result.bindings[] | select(.name == "PLATFORM_DB") | .id' "$PLATFORM_DB_ID" "PLATFORM_DB"
    expect "$S" '.result.bindings[] | select(.name == "DISPATCHER") | .namespace' "$NS" "DISPATCHER"
    expect "$S" '.result.bindings[] | select(.name == "OA_ENV") | .text' "$env" "OA_ENV"
    expect "$S" '.result.bindings[] | select(.name == "EMAIL_QUOTA_ZONES") | .text' "$EMAIL_ZONE_TAGS" "EMAIL_QUOTA_ZONES"
    expect "$S" '.result.bindings[] | select(.name == "EMAIL_DAILY_LIMIT") | .text' "$EMAIL_DAILY_LIMIT" "EMAIL_DAILY_LIMIT"
    signups_deployed "$S" oa-$P-scheduler
    expect_private "$S" '[.result.bindings[] | select(.name == "ALERT_TO") | .text] | join(",")' "$ALERT_TO" "ALERT_TO"
    expect "$S" '[.result.bindings[] | select(.name == "ALERT_FROM") | .text] | join(",")' "$ALERT_FROM" "ALERT_FROM"
    expect "$S" '[.result.bindings[] | select(.name == "SIGNUP_DAILY_CAP") | .text] | join(",")' "$SIGNUP_DAILY_CAP" "SIGNUP_DAILY_CAP"
    expect "$S" '[.result.bindings[] | select(.name == "SIGNUPS_ENABLED") | .text] | join(",")' "$SIGNUPS_ENABLED" "SIGNUPS_ENABLED"
    # The alert mail goes to ALERT_TO and nowhere else: never empty (4.8).
    expect_private "$S" '[.result.bindings[] | select(.name == "ALERT_EMAIL") | .destination_address // ""] | join(",")' \
      "$ALERT_TO" "ALERT_EMAIL destination"
    crons="$(cf_get /workers/scripts/oa-$P-scheduler/schedules | must "read oa-$P-scheduler schedules" | jq -r '[.result.schedules[].cron] | sort | join(",")')"
    [ "$crons" = "*/2 * * * *,17 3 * * *" ] || { echo "oa-$P-scheduler schedules are '$crons'" >&2; exit 1; }
    # Only the secrets it may hold: the email-quota token and the smoke's two.
    # Read first: a failed listing fails the run, never reads as "none".
    names="$(secret_names oa-$P-scheduler)" || exit 1
    for n in $names; do
      case "$n" in
        EMAIL_QUOTA_TOKEN | FLEET_SMOKE_TOKEN | FLEET_SMOKE_SHARE_TO) ;;
        *) echo "oa-$P-scheduler has a secret it shouldn't: $n" >&2; exit 1 ;;
      esac
    done
    ;;
  inventory)
    need PLATFORM_DB_ID; need HOSTS_KV_ID; need GITHUB_REPOSITORY_ID; need GITHUB_REPOSITORY
    [[ "$GITHUB_REPOSITORY_ID" =~ ^[1-9][0-9]{0,19}$ ]] || { echo "GITHUB_REPOSITORY_ID must be digits" >&2; exit 2; }
    [[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "GITHUB_REPOSITORY must be owner/repo" >&2; exit 2; }
    # The refs (design v7 6.3, amended): full refs on main, exactly W8's
    # committed list. Prod's adds the monitor's (POST /prodclean). The tag's
    # committed list must equal it before deploying; the deployed one after.
    base="open-artifacts-ai/open-artifacts-cloud/.github/workflows"
    refs_want="$base/redline-staging.yml@refs/heads/main"
    [ "$env" = staging ] || refs_want="$refs_want,$base/prodclean-monitor.yml@refs/heads/main"
    refs_committed="$(ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" committed inventory vars | jq -r '.OIDC_JOB_WORKFLOW_REFS // empty')" || refs_committed=""
    [ -n "$refs_committed" ] || { echo "the tag commits no OIDC_JOB_WORKFLOW_REFS for $env inventory" >&2; exit 1; }
    [ "$refs_committed" = "$refs_want" ] ||
      { echo "committed OIDC_JOB_WORKFLOW_REFS is '$refs_committed', want '$refs_want'" >&2; exit 1; }
    PLATFORM_DB_ID="$PLATFORM_DB_ID" HOSTS_KV_ID="$HOSTS_KV_ID" GITHUB_REPOSITORY_ID="$GITHUB_REPOSITORY_ID" deploy inventory
    # W8 retired INVENTORY_KEY (OIDC replaced it), but a deploy keeps a Worker's
    # secrets: a staging deploy deletes it, once. Prod's is the user's to delete
    # (#968); prod and verify only still refuse it below.
    if [ -z "$VERIFY_ONLY" ] && [ "$env" = staging ]; then
      names="$(secret_names oa-$P-inventory)" || exit 1
      if grep -qx INVENTORY_KEY <<< "$names"; then
        cf_send DELETE "/workers/scripts/oa-$P-inventory/secrets/INVENTORY_KEY" "" |
          must "delete oa-$P-inventory INVENTORY_KEY" > /dev/null || exit 1
        echo "oa-$P-inventory: retired INVENTORY_KEY deleted"
      fi
    fi
    S="$(settings oa-$P-inventory)"
    expect "$S" '.result.bindings[] | select(.name == "PLATFORM_DB") | .id' "$PLATFORM_DB_ID" "PLATFORM_DB"
    expect "$S" '.result.bindings[] | select(.name == "HOSTS") | .namespace_id' "$HOSTS_KV_ID" "HOSTS"
    # 6.3: exactly these non-secret bindings, each OIDC value pinned, no secret.
    got="$(jq -r '[.result.bindings[] | select(.type != "secret_text") | .name] | sort | join(",")' <<< "$S")"
    want="HOSTS,OIDC_AUDIENCE,OIDC_ENVIRONMENT,OIDC_JOB_WORKFLOW_REFS,OIDC_REPOSITORY,OIDC_REPOSITORY_ID,PLATFORM_DB"
    [ "$got" = "$want" ] || { echo "bindings: got '$got', want '$want'" >&2; exit 1; }
    oidc() { jq -r --arg n "$1" '[.result.bindings[] | select(.name == $n and .type == "plain_text") | .text] | join(",")' <<< "$S"; }
    [ "$(oidc OIDC_AUDIENCE)" = "https://oa-$P-inventory" ] || { echo "OIDC_AUDIENCE: got '$(oidc OIDC_AUDIENCE)', want 'https://oa-$P-inventory'" >&2; exit 1; }
    [ "$(oidc OIDC_REPOSITORY)" = "$GITHUB_REPOSITORY" ] || { echo "OIDC_REPOSITORY: got '$(oidc OIDC_REPOSITORY)', want '$GITHUB_REPOSITORY'" >&2; exit 1; }
    [ "$(oidc OIDC_REPOSITORY_ID)" = "$GITHUB_REPOSITORY_ID" ] || { echo "OIDC_REPOSITORY_ID: got '$(oidc OIDC_REPOSITORY_ID)', want '$GITHUB_REPOSITORY_ID'" >&2; exit 1; }
    [ "$(oidc OIDC_ENVIRONMENT)" = redline-staging ] || { echo "OIDC_ENVIRONMENT: got '$(oidc OIDC_ENVIRONMENT)', want 'redline-staging'" >&2; exit 1; }
    [ "$(oidc OIDC_JOB_WORKFLOW_REFS)" = "$refs_want" ] ||
      { echo "OIDC_JOB_WORKFLOW_REFS: got '$(oidc OIDC_JOB_WORKFLOW_REFS)', want '$refs_want'" >&2; exit 1; }
    vars_are "$S" inventory
    no_secret_bindings "$S" oa-$P-inventory
    names="$(secret_names oa-$P-inventory | tr '\n' ' ')"
    [ -z "$names" ] || { echo "oa-$P-inventory has secrets '$names'; want none" >&2; exit 1; }
    ;;
  *)
    echo "unknown target: $target" >&2
    exit 2
    ;;
esac
if [ -n "$VERIFY_ONLY" ]; then echo "$env $target: verified (verify only)"; else echo "$env $target: deployed and verified"; fi
