import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, write } from "../ci/stubs.ts";
import { committedRateLimits, committedVars } from "./wrangler-env.ts";

// deploy-hosted-platform.sh: deploy through the allowlisted wrapper, secrets only
// after the Worker exists (Google secrets every run, state keys only when
// absent), then the deployed settings read back and checked. Secrets reach
// wrangler on stdin and the token reaches curl on stdin, never argv.
const SCRIPT = join(root, "scripts/ops/deploy-hosted-platform.sh");
const ACCT = "26ac346086d4405f7a976d48747a2a75";
const TOKEN = "cf-token-SHOULD-NEVER-APPEAR";
const REG = "126a6ed45b8842ccb42b8c55a9467760";
const DIRREG = "55d5f7d77ef240e5a2255fe43f2c5170";
const HOSTS = "32737a5cd6224418bf14e15fa2732bab";
const DB = "6ca9103e-507e-4541-b3bb-2485e699512b";
const BDB = "7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d";
// Billing's Stripe secrets, marked so a leak shows; test-mode shapes.
const STRIPE_KEY = "rk_test_NEVERAPPEARstripekey0123456789";
const STRIPE_WH = "whsec_NEVERAPPEARwebhooksecret0123456789";
const PRICES = {
  STRIPE_PRICE_TEAM: "price_1TeamAbc",
  STRIPE_PRICE_BUSINESS: "price_1BizXyz",
  STRIPE_PRICE_SOLO_MONTHLY: "price_1SoloMo",
  STRIPE_PRICE_SOLO_YEARLY: "price_1SoloYr",
};
const ZONE = "eb90975c0a329d0c743fa4f33f917934";
const CLIENT =
  "206295999771-ntbp6nlf5ospa45ovc73aur4f05fpp5s.apps.googleusercontent.com";
const DCLIENT =
  "206295999771-6cr3mbfc7g2ejnvdoqhlf2v8v6sdm023.apps.googleusercontent.com";
const SECRET = "google-secret-SHOULD-NEVER-APPEAR";
const DSECRET = "directory-secret-SHOULD-NEVER-APPEAR";
// The admin allowlist (#1007): two entries, marked so a leak shows.
const IDS =
  "never-appear-a@example.com:111111,never-appear-b@example.com:222222";

// pnpm: `exec wrangler deploy` marks the app's Worker deployed (its next
// settings become live); `exec wrangler secret put NAME` records NAME and only
// the value's length (stdin).
const pnpm = `
p=p; case "$*" in *"--env staging"*) p=s ;; esac
w="oa-$p-$(basename "$PWD")"
for ((i = 1; i <= $#; i++)); do [ "\${!i}" = --name ] && { j=$((i + 1)); w="\${!j}"; }; done
case "$*" in
  "exec wrangler deploy"*)
    touch "$STATE/$w.exists"
    [ -f "$STATE/$w.next.json" ] && cp "$STATE/$w.next.json" "$STATE/$w.settings.json"
    ;;
  "exec wrangler secret put"*)
    v="$(cat)"
    echo "stdin-len $5 \${#v}" >> "$STUB_LOG"
    [ -f "$STATE/fail-put-$5" ] && exit 1
    [ -f "$STATE/fail-put-once-$5" ] && { rm "$STATE/fail-put-once-$5"; exit 1; }
    touch "$STATE/$w.secrets"; grep -qx "$5" "$STATE/$w.secrets" || echo "$5" >> "$STATE/$w.secrets"
    ;;
esac`;
// curl: the -K - config must carry the token; answers by path. Writes are
// logged as "WRITE <method> /<path> <body>".
const curl = `
cfg="$(cat)"
case "$cfg" in *"Bearer $EXPECT_TOKEN"*) ;; *) echo '{"success":false,"errors":[{"code":10000}]}'; exit 0 ;; esac
url="\${@: -1}"
m=GET; body=""; wcode=""
for ((i = 1; i <= $#; i++)); do
  case "\${!i}" in
    -X) j=$((i + 1)); m="\${!j}" ;;
    --data-binary) j=$((i + 1)); body="\${!j}" ;;
    -w) wcode=1 ;;
  esac
done
path="$(printf %s "$url" | sed -E 's#^.*/accounts/[0-9a-f]+/##')"
[ "$m" = GET ] || echo "WRITE $m /$path $body" >> "$STUB_LOG"
ok() { echo "{\\"success\\":true,\\"result\\":$1}"; }
bad() { echo '{"success":false,"errors":[{"code":1}]}'; }
case "$path" in
  # queues.json: a whole listing (an envelope) or just its result array; no
  # file is a failed listing.
  challenges/widgets\\?*) ok "$(cat "$STATE/widgets.json" 2>/dev/null || echo '[{"name":"oa-s-turnstile","sitekey":"0x4AAAAAAAdefault"}]')"; exit 0 ;;
  queues\\?*) [ -f "$STATE/fail-queues" ] && { bad; exit 0; }
    if [ ! -f "$STATE/queues.json" ]; then bad
    elif jq -e 'type == "object"' "$STATE/queues.json" > /dev/null 2>&1; then cat "$STATE/queues.json"
    else ok "$(cat "$STATE/queues.json")"; fi
    exit 0 ;;
  queues)
    jq -c --argjson b "$body" 'if type == "object" then .result += [{queue_name: $b.queue_name}] else . + [{queue_name: $b.queue_name}] end' "$STATE/queues.json" 2>/dev/null > "$STATE/q.new" || jq -nc --argjson b "$body" '[{queue_name: $b.queue_name}]' > "$STATE/q.new"
    mv "$STATE/q.new" "$STATE/queues.json"; ok '{}'; exit 0 ;;
  r2/buckets/*) n="\${path#r2/buckets/}"
    if [ -f "$STATE/fail-r2" ]; then bad; elif [ -f "$STATE/r2-$n" ]; then ok '{}'; else echo '{"success":false,"errors":[{"code":10006}]}'; fi; exit 0 ;;
  r2/buckets) touch "$STATE/r2-$(jq -r .name <<< "$body")"; ok '{}'; exit 0 ;;
  storage/kv/namespaces\\?*) [ -f "$STATE/fail-kvns" ] && { bad; exit 0; }; ok "$(cat "$STATE/kvns.json" 2>/dev/null || echo '[]')"; exit 0 ;;
  storage/kv/namespaces)
    jq -c --argjson b "$body" --arg id "$NEW_KV" '. + [{id: $id, title: $b.title}]' "$STATE/kvns.json" 2>/dev/null > "$STATE/k.new" || jq -nc --argjson b "$body" --arg id "$NEW_KV" '[{id: $id, title: $b.title}]' > "$STATE/k.new"
    mv "$STATE/k.new" "$STATE/kvns.json"; ok "{\\"id\\":\\"$NEW_KV\\"}"; exit 0 ;;
  storage/kv/namespaces/*/values/*)
    ns="\${path#storage/kv/namespaces/}"; ns="\${ns%%/*}"; key="\${path##*/values/}"; f="$STATE/kv-$ns-$key"
    if [ "$m" = PUT ]; then printf %s "$body" > "$f"; ok '{}'
    elif [ "$m" = DELETE ]; then rm -f "$f"; ok '{}'
    elif [ -f "$f" ]; then cat "$f"; [ -z "$wcode" ] || printf '\\n200'
    else echo '{"success":false,"errors":[{"code":10009}]}'; [ -z "$wcode" ] || printf '\\n404'; fi
    exit 0 ;;
  secrets_store/stores/*/secrets\\?*) [ -f "$STATE/fail-store" ] && { bad; exit 0; }; ok "$(cat "$STATE/store-secrets.json" 2>/dev/null || echo '[]')"; exit 0 ;;
  workers/scripts/*/secrets/*) w="\${path#workers/scripts/}"; w="\${w%%/*}"; n="\${path##*/}"
    if [ "$m" = DELETE ] && [ ! -f "$STATE/fail-delete" ] && [ -f "$STATE/$w.secrets" ] && grep -qx "$n" "$STATE/$w.secrets"; then
      grep -vx "$n" "$STATE/$w.secrets" > "$STATE/s.new" || true; mv "$STATE/s.new" "$STATE/$w.secrets"
      [ ! -f "$STATE/$w.settings.json" ] || { jq --arg n "$n" '.result.bindings |= map(select(.name != $n))' "$STATE/$w.settings.json" > "$STATE/b.new"; mv "$STATE/b.new" "$STATE/$w.settings.json"; }
      ok 'null'
    else echo '{"success":false,"errors":[{"code":10056}]}'; fi
    exit 0 ;;
  workers/scripts/*/content/v2) w="\${path#workers/scripts/}"; w="\${w%%/*}"
    if [ -f "$STATE/fail-content" ]; then echo '{"success":false,"errors":[{"code":10000}]}'; [ -z "$wcode" ] || printf '\\n403'
    else cat "$STATE/$w.content" 2>/dev/null || echo 'export default {};'; [ -z "$wcode" ] || printf '\\n200'; fi
    exit 0 ;;
esac
w="$(printf %s "$url" | sed -E 's#.*/workers/scripts/([^/]+)/.*#\\1#')"
kind="\${url##*/}"
case "$kind" in
  settings)
    if [ -f "$STATE/$w.exists" ] && [ -f "$STATE/$w.settings.json" ]; then cat "$STATE/$w.settings.json"
    elif [ -f "$STATE/$w.exists" ]; then echo '{"success":true,"result":{"bindings":[]}}'
    else echo '{"success":false,"errors":[{"code":10007,"message":"not found"}]}'; fi ;;
  secrets)
    if [ -f "$STATE/fail-secrets" ]; then echo '{"success":false,"errors":[{"code":1}]}'
    else touch "$STATE/$w.secrets"; jq -nR '{success: true, result: [inputs | select(length > 0) | {name: .}]}' < "$STATE/$w.secrets"; fi ;;
  schedules) cat "$STATE/$w.schedules.json" ;;
esac`;
const openssl = `echo "c3RhdGVrZXlzdGF0ZWtleXN0YXRla2V5c3RhdGVrZXk="`;
// The deploy wrapper has its own tests; here a stub records its argv and the
// values it was given, then marks the app's Worker deployed.
const wrapperStub = (dir: string) => {
  const p = join(dir, "wrapper.sh");
  writeFileSync(
    p,
    `#!/usr/bin/env bash
echo "wrapper $* reg=\${BROKER_REGISTRY_ID:-}\${DIRECTORY_REGISTRY_ID:-} client=\${GOOGLE_CLIENT_ID_PROD:-}\${GOOGLE_DIRECTORY_CLIENT_ID_PROD:-} hosts=\${HOSTS_KV_ID:-} db=\${PLATFORM_DB_ID:-} bdb=\${BILLING_DB_ID:-} tag=\${DEPLOY_TAG:-}" >> "$STUB_LOG"
w="oa-$([ "$2" = staging ] && echo s || echo p)-$1"
n=$(( $(cat "$STATE/wrapper-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STATE/wrapper-count"
# fail-wrapper-from: every call from that number on fails; fail-wrapper-at: just that call.
[ -f "$STATE/fail-wrapper-from" ] && [ "$n" -ge "$(cat "$STATE/fail-wrapper-from")" ] && exit 1
[ -f "$STATE/fail-wrapper-at" ] && [ "$n" -eq "$(cat "$STATE/fail-wrapper-at")" ] && exit 1
touch "$STATE/$w.exists"
[ -f "$STATE/$w.next.json" ] && cp "$STATE/$w.next.json" "$STATE/$w.settings.json"
exit 0
`,
  );
  return p;
};

// The provisioner and provisioning have Workers Logs on (#164); the brokers,
// dispatch and billing stay off (Workers Logs would record their URLs).
const settings = (
  bindings: Record<string, unknown>[],
  obs = true,
  invocation: boolean | null = false,
) =>
  JSON.stringify({
    success: true,
    result: {
      bindings,
      observability: {
        enabled: obs,
        logs: { invocation_logs: invocation ?? undefined },
      },
    },
  });
const settingsOff = (bindings: Record<string, unknown>[]) =>
  settings(bindings, false);
// The scheduler's bindings as Cloudflare reads them back (apps/scheduler
// wrangler.jsonc, per env).
// The alert wiring the deploy fills by default (ENV below holds the same).
const SCHED_ALERTS = {
  ALERT_TO: "ops@example.com",
  ALERT_FROM: "alerts@open-artifacts.app",
  SIGNUP_DAILY_CAP: "20",
  SIGNUPS_ENABLED: "false",
};
// alerts null: the bindings without any alert var or ALERT_EMAIL destination.
function schedulerBindings(
  p: "s" | "p",
  alerts: Record<string, string> | null = SCHED_ALERTS,
): Record<string, unknown>[] {
  const wiring = alerts
    ? Object.entries(alerts).map(([name, text]) => ({
        type: "plain_text",
        name,
        text,
      }))
    : [];
  return [
    ...wiring,
    { type: "d1", name: "PLATFORM_DB", id: DB },
    {
      type: "dispatch_namespace",
      name: "DISPATCHER",
      namespace: p === "s" ? "oa-staging" : "oa-prod",
    },
    {
      type: "plain_text",
      name: "OA_ENV",
      text: p === "s" ? "staging" : "prod",
    },
    { type: "plain_text", name: "EMAIL_QUOTA_ZONES", text: ZONE },
    { type: "plain_text", name: "EMAIL_DAILY_LIMIT", text: "1000" },
    {
      type: "service",
      name: "PROVISIONER",
      service: `oa-${p}-provisioner`,
      entrypoint: "ProvisionerRpc",
    },
    ...(p === "s"
      ? [{ type: "service", name: "BILLING", service: "oa-s-billing" }]
      : []),
    { type: "queue", name: "SIGNUPS", queue_name: `oa-${p}-signups` },
    { type: "workflow", name: "PROVISION_INSTALL" },
    { type: "workflow", name: "MANAGE_INSTALL" },
    alerts
      ? {
          type: "send_email",
          name: "ALERT_EMAIL",
          destination_address: alerts.ALERT_TO,
        }
      : { type: "send_email", name: "ALERT_EMAIL" },
  ];
}
// A queue listing (GET /accounts/{id}/queues) of these names.
const queueList = (names: string[], total = names.length, pages = 1) =>
  JSON.stringify({
    success: true,
    result: names.map((queue_name) => ({ queue_name })),
    result_info: {
      page: 1,
      per_page: 100,
      count: names.length,
      total_count: total,
      total_pages: pages,
    },
  });
const NEXT: Record<string, string> = {
  "oa-p-auth-broker": settingsOff([
    { type: "kv_namespace", name: "BROKER_REGISTRY", namespace_id: REG },
    { type: "plain_text", name: "GOOGLE_CLIENT_ID", text: CLIENT },
    {
      type: "plain_text",
      name: "BROKER_ORIGIN",
      text: "https://auth.open-artifacts.app",
    },
  ]),
  "oa-p-directory-broker": settingsOff([
    { type: "kv_namespace", name: "DIRECTORY_REGISTRY", namespace_id: DIRREG },
    { type: "plain_text", name: "GOOGLE_DIRECTORY_CLIENT_ID", text: DCLIENT },
    {
      type: "plain_text",
      name: "DIRECTORY_ORIGIN",
      text: "https://directory.open-artifacts.app",
    },
  ]),
  "oa-p-dispatch": settingsOff([
    { type: "kv_namespace", name: "HOSTS", namespace_id: HOSTS },
    { type: "dispatch_namespace", name: "DISPATCHER", namespace: "oa-prod" },
    { type: "service", name: "AUTH_BROKER", service: "oa-p-auth-broker" },
    {
      type: "service",
      name: "DIRECTORY_BROKER",
      service: "oa-p-directory-broker",
    },
    { type: "plain_text", name: "OA_ENV", text: "prod" },
  ]),
  "oa-s-dispatch": settingsOff([
    { type: "kv_namespace", name: "HOSTS", namespace_id: HOSTS },
    { type: "dispatch_namespace", name: "DISPATCHER", namespace: "oa-staging" },
    { type: "service", name: "AUTH_BROKER", service: "oa-s-auth-broker" },
    {
      type: "service",
      name: "DIRECTORY_BROKER",
      service: "oa-s-directory-broker",
    },
    { type: "service", name: "BILLING", service: "oa-s-billing" },
    { type: "plain_text", name: "OA_ENV", text: "staging" },
  ]),
  "oa-p-inventory": settings([
    { type: "d1", name: "PLATFORM_DB", id: DB },
    { type: "kv_namespace", name: "HOSTS", namespace_id: HOSTS },
  ]),
  "oa-p-scheduler": settings(schedulerBindings("p"), true),
  "oa-s-scheduler": settings(schedulerBindings("s"), true),
};

// The Provisioning API Workers (design v7 10.2): vars and rate limits as the
// tag commits them, placeholders filled as the deploy fills them.
const STORE = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
const OAUTH = "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a";
const REPO_ID = "1012345678";
const FILLS = {
  SIGNUP_DAILY_CAP: "20",
  SIGNUPS_ENABLED: "false",
  WELCOME_FROM: "welcome@open-artifacts.app",
  ACCOUNT_ID: ACCT,
  GITHUB_REPOSITORY_ID: REPO_ID,
};
const varsOf = (app: string, env: "staging" | "prod") =>
  Object.entries(
    committedVars(
      readFileSync(join(root, "apps", app, "wrangler.jsonc"), "utf8"),
      env,
      FILLS,
    ),
  ).map(([name, text]) => ({ type: "plain_text", name, text }));
const ratelimits = (env: "staging" | "prod") =>
  committedRateLimits(
    readFileSync(join(root, "apps/provisioning/wrangler.jsonc"), "utf8"),
    env,
  ).map((r) => ({
    type: "ratelimit",
    name: r.name,
    namespace_id: r.namespace_id,
    simple: { limit: r.limit, period: r.period },
  }));
const provisionerSettings = (p = "p", env: "staging" | "prod" = "prod") =>
  settings([
    { type: "d1", name: "PLATFORM_DB", id: DB },
    {
      type: "dispatch_namespace",
      name: "DISPATCHER",
      namespace: `oa-${env}`,
    },
    { type: "r2_bucket", name: "RELEASES", bucket_name: `oa-${p}-releases` },
    { type: "send_email", name: "WELCOME_EMAIL" },
    {
      type: "secrets_store_secret",
      name: "PROVISION_TOKEN",
      store_id: STORE,
      secret_name: `oa-${p}-provision-token`,
    },
    {
      type: "workflow",
      name: "PROVISION_INSTALL",
      workflow_name: `oa-${p}-provision-install`,
      class_name: "ProvisionInstall",
    },
    {
      type: "workflow",
      name: "MANAGE_INSTALL",
      workflow_name: `oa-${p}-manage-install`,
      class_name: "ManageInstall",
    },
    ...varsOf("provisioner", env),
  ]);
const provisioningBindings = (p = "p", env: "staging" | "prod" = "prod") => [
  { type: "d1", name: "PLATFORM_DB", id: DB },
  // #1176: the platform's own release tag (apps/provisioning/wrangler.jsonc).
  { type: "version_metadata", name: "CF_VERSION_METADATA" },
  { type: "kv_namespace", name: "OAUTH_KV", namespace_id: OAUTH },
  {
    type: "service",
    name: "PROVISIONER",
    service: `oa-${p}-provisioner`,
    entrypoint: "ProvisionerRpc",
  },
  { type: "service", name: "AUTH_BROKER", service: `oa-${p}-auth-broker` },
  // Staging's tag declares billing's operator entrypoint (#66).
  ...(p === "s"
    ? [
        {
          type: "service",
          name: "BILLING",
          service: "oa-s-billing",
          entrypoint: "BillingOperatorRpc",
        },
      ]
    : []),
  { type: "queue", name: "SIGNUPS", queue_name: `oa-${p}-signups` },
  { type: "assets", name: "ASSETS" },
  // The approval email (#2096): the provisioner's sender.
  { type: "send_email", name: "WELCOME_EMAIL" },
  ...[
    "PROVISION_INSTALL:ProvisionInstall:provision",
    "MANAGE_INSTALL:ManageInstall:manage",
  ].map((w) => {
    const [name, cls, n] = w.split(":");
    return {
      type: "workflow",
      name,
      workflow_name: `oa-${p}-${n}-install`,
      class_name: cls,
      script_name: `oa-${p}-provisioner`,
    };
  }),
  ...ratelimits(env),
  ...varsOf("provisioning", env),
  { type: "secret_text", name: "ADMIN_SESSION_KEY" },
  { type: "secret_text", name: "ADMIN_BROKER_KEY" },
  { type: "secret_text", name: "ADMIN_IDENTITIES" },
];
NEXT["oa-s-billing"] = settingsOff([
  { type: "d1", name: "BILLING_DB", id: BDB },
  { type: "kv_namespace", name: "BROKER_REGISTRY", namespace_id: REG },
  ...Object.entries(
    committedVars(
      readFileSync(join(root, "apps/billing/wrangler.jsonc"), "utf8"),
      "staging",
      PRICES,
    ),
  ).map(([name, text]) => ({ type: "plain_text", name, text })),
  { type: "secret_text", name: "STRIPE_SECRET_KEY" },
  { type: "secret_text", name: "STRIPE_WEBHOOK_SECRET" },
]);
NEXT["oa-p-provisioner"] = provisionerSettings();
// Staging's provisioner, with its BILLING binding to billing's RPC entrypoint
// (#1568; the tag declares it).
NEXT["oa-s-provisioner"] = (() => {
  const o = JSON.parse(provisionerSettings("s", "staging"));
  o.result.bindings.push({
    type: "service",
    name: "BILLING",
    service: "oa-s-billing",
    entrypoint: "BillingProvisionerRpc",
  });
  return JSON.stringify(o);
})();
NEXT["oa-p-provisioning"] = settings(provisioningBindings());
NEXT["oa-s-provisioning"] = settings(provisioningBindings("s", "staging"));

const ENV = {
  // The put's retry waits (#55) cost nothing here.
  PUT_RETRY_SLEEP: "0",
  // Not in CI by default (CI sets these, and prod there needs main).
  GITHUB_ACTIONS: "",
  GITHUB_REF: "",
  DEPLOY_ENVIRONMENT: "",
  CLOUDFLARE_API_TOKEN: TOKEN,
  EXPECT_TOKEN: TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCT,
  BROKER_REGISTRY_ID: REG,
  GOOGLE_CLIENT_ID: CLIENT,
  GOOGLE_CLIENT_SECRET: SECRET,
  DIRECTORY_REGISTRY_ID: DIRREG,
  GOOGLE_DIRECTORY_CLIENT_ID: DCLIENT,
  GOOGLE_DIRECTORY_CLIENT_SECRET: DSECRET,
  ADMIN_IDENTITIES: IDS,
  HOSTS_KV_ID: HOSTS,
  PLATFORM_DB_ID: DB,
  MAIN_MIGRATION_LOCK: join(root, "apps/platform-db/migration-lock.json"),
  EMAIL_ZONE_TAGS: ZONE,
  EMAIL_DAILY_LIMIT: "1000",
  ALERT_TO: SCHED_ALERTS.ALERT_TO,
  ALERT_FROM: SCHED_ALERTS.ALERT_FROM,
  GITHUB_REPOSITORY: "o/r",
  SECRETS_STORE_ID: STORE,
  SIGNUP_DAILY_CAP: FILLS.SIGNUP_DAILY_CAP,
  SIGNUPS_ENABLED: FILLS.SIGNUPS_ENABLED,
  WELCOME_FROM: FILLS.WELCOME_FROM,
  GITHUB_REPOSITORY_ID: REPO_ID,
  NEW_KV: OAUTH,
  BILLING_DB_ID: BDB,
  MAIN_BILLING_MIGRATION_LOCK: join(root, "apps/billing/migration-lock.json"),
  STRIPE_SECRET_KEY: STRIPE_KEY,
  STRIPE_WEBHOOK_SECRET: STRIPE_WH,
  ...PRICES,
};

// What the scheduler needs deployed first.
// Staging also needs oa-s-billing: its BILLING binding (#1568).
const SCHED_DEPS = (p: "s" | "p") => [
  `oa-${p}-auth-broker`,
  `oa-${p}-directory-broker`,
  `oa-${p}-provisioner`,
  ...(p === "s" ? ["oa-s-billing"] : []),
];

// The scheduler's config: #915's placeholders (the repo's own once it carries
// them). A config without them refuses (4.8), so every scheduler run below
// uses the repo's deploy script beside this config.
const F915 = readFileSync(
  join(root, "scripts/ops/testdata/scheduler-915.wrangler.jsonc"),
  "utf8",
);
const REAL_SCHED = readFileSync(
  join(root, "apps/scheduler/wrangler.jsonc"),
  "utf8",
);
const pinned = (src: string) => src.includes("{{ALERT_TO_PROD}}");
const SCHED_CONFIG = pinned(REAL_SCHED) ? REAL_SCHED : F915;
/** The repo's deploy script and wrangler-env.ts beside these app configs (app -> wrangler.jsonc). */
const tree = (configs: Record<string, string>) => {
  const t = mkdtempSync(join(tmpdir(), "oa-hosted-tree-"));
  for (const f of [
    "deploy-hosted-platform.sh",
    "wrangler-env.ts",
    // The provisioning target mints its admin broker key with it.
    "broker-key.ts",
  ])
    write(
      join(t, "scripts/ops", f),
      readFileSync(join(root, "scripts/ops", f), "utf8"),
    );
  for (const [app, config] of Object.entries(configs))
    write(join(t, "apps", app, "wrangler.jsonc"), config);
  return join(t, "scripts/ops/deploy-hosted-platform.sh");
};

const setup = (
  opts: {
    /** App configs to deploy from instead of the repo's (app -> wrangler.jsonc). */
    configs?: Record<string, string>;
    exists?: readonly string[];
    secrets?: Record<string, string[]>;
    next?: Record<string, string>;
    failSecrets?: boolean;
    pins?: { staging?: string | null; prod?: string | null };
    /** Extra state files (name -> content). */
    files?: Record<string, string>;
    /** Stub node (logs its argv, exits $NODE_EXIT); "billing": only billing-db.ts is stubbed. */
    node?: boolean | "billing";
    // The account's queue listing; null: the listing fails.
    queues?: string | null;
  } = {},
) => {
  const sb = sandbox({
    pnpm,
    curl,
    openssl,
    ...(opts.node === "billing"
      ? {
          node: `case "$*" in *billing-db.ts*) exit "\${NODE_EXIT:-0}" ;; esac\nexec "$REAL_NODE" "$@"`,
        }
      : opts.node
        ? { node: `exit "\${NODE_EXIT:-0}"` }
        : {}),
  });
  const state = join(sb.dir, "state");
  mkdirSync(state);
  for (const [w, s] of Object.entries({ ...NEXT, ...opts.next }))
    writeFileSync(join(state, `${w}.next.json`), s);
  writeFileSync(
    join(state, "oa-s-billing.schedules.json"),
    JSON.stringify({
      success: true,
      result: { schedules: [{ cron: "17 3 * * *" }] },
    }),
  );
  for (const p of ["s", "p"])
    writeFileSync(
      join(state, `oa-${p}-scheduler.schedules.json`),
      JSON.stringify({
        success: true,
        result: {
          schedules: [{ cron: "17 3 * * *" }, { cron: "*/2 * * * *" }],
        },
      }),
    );
  const queues =
    opts.queues === undefined
      ? queueList(["oa-p-signups", "oa-s-signups", "other"])
      : opts.queues;
  if (queues !== null) writeFileSync(join(state, "queues.json"), queues);
  for (const w of opts.exists ?? []) {
    writeFileSync(join(state, `${w}.exists`), "");
    if (NEXT[w])
      writeFileSync(join(state, `${w}.settings.json`), NEXT[w] as string);
  }
  for (const [w, names] of Object.entries(opts.secrets ?? {}))
    writeFileSync(join(state, `${w}.secrets`), `${names.join("\n")}\n`);
  if (opts.failSecrets) writeFileSync(join(state, "fail-secrets"), "");
  for (const [f, v] of Object.entries(opts.files ?? {}))
    writeFileSync(join(state, f), v);
  // Provision's pin, as main's wfp.ts states it (stubbed: prod's real pin is
  // PR #875's).
  const pinFile = join(sb.dir, "wfp.ts");
  writeFileSync(
    pinFile,
    `export const BROKER_GOOGLE_CLIENT_ID: Readonly<Record<Env, string | null>> =\n  Object.freeze({\n    staging:\n      ${JSON.stringify(opts.pins?.staging === undefined ? CLIENT : opts.pins.staging)},\n    prod: ${JSON.stringify(opts.pins?.prod === undefined ? CLIENT : opts.pins.prod)},\n  });\n`,
  );
  const run = (
    target: string,
    env: Record<string, string> = {},
    envName = "prod",
  ) => {
    const script =
      target === "scheduler" || opts.configs
        ? tree({ scheduler: SCHED_CONFIG, ...opts.configs })
        : SCRIPT;
    const r = sb.run(["bash", script, envName, target], {
      env: {
        ...ENV,
        STATE: state,
        REAL_NODE: process.execPath,
        DEPLOY_WRAPPER: wrapperStub(sb.dir),
        BROKER_PIN_FILE: pinFile,
        ...env,
      },
    });
    const log = sb.log();
    return { ...r, log, writes: log.filter((l) => l.startsWith("WRITE")) };
  };
  return { run, state, sb };
};
// Nothing secret in any argv, stdout or stderr.
const clean = (r: { out: string; err: string; log: string[] }) => {
  const all = [r.out, r.err, ...r.log].join("\n");
  for (const s of [
    TOKEN,
    SECRET,
    DSECRET,
    STRIPE_KEY,
    STRIPE_WH,
    "k".repeat(64),
    "c3RhdGVrZXlz",
  ])
    expect(all).not.toContain(s);
};
// Nothing deployed or set: no wrapper, pnpm or wrangler call.
const noDeploy = (log: string[]) =>
  log.filter((l) => /^(pnpm|wrapper|wrangler) /.test(l));
const puts = (log: string[]) =>
  log.filter((l) => l.startsWith("stdin-len")).map((l) => l.split(" ")[1]);

describe("deploy-hosted-platform.sh", () => {
  // Each script run spawns dozens of stub processes (about 0.5 s on an idle
  // machine, several times that under load). So each case below is its own
  // test, bounded by its own one or two runs rather than by the case count
  // (a 26-run test took 13 s idle and hit the 30 s testTimeout under load).
  for (const [pins, msg] of [
    [
      { prod: "other.apps.googleusercontent.com" },
      "differs from provision's BROKER_GOOGLE_CLIENT_ID[prod]",
    ],
    [{ prod: null }, "BROKER_GOOGLE_CLIENT_ID[prod] is null in provision"],
  ] as const) {
    for (const verify of ["", "1"]) {
      it(`auth-broker refuses before any wrangler call (${verify ? "verify only" : "deploy"}): ${msg}`, () => {
        const r = setup({ pins }).run("auth-broker", { VERIFY_ONLY: verify });
        expect(r.code, msg).toBe(1);
        expect(r.err).toContain(msg);
        expect(r.log.filter((l) => /^(pnpm|wrapper|curl) /.test(l))).toEqual(
          [],
        );
      });
    }
  }
  it("auth-broker checks staging's own pin for staging only", () => {
    const r = setup({ pins: { staging: "other" } }).run("auth-broker");
    expect(r.code, r.err).toBe(0);
  });
  it("auth-broker refuses when the pin can't be read", () => {
    for (const BROKER_PIN_FILE of ["/nonexistent/wfp.ts", ""]) {
      const r = setup().run("auth-broker", { BROKER_PIN_FILE });
      expect(r.code).not.toBe(0);
      expect(r.log.filter((l) => /^(pnpm|wrapper) /.test(l))).toEqual([]);
    }
  });
  it("auth-broker, first run: deploys prod, sets the Google secret and a new state key, verifies", () => {
    const s = setup();
    const r = s.run("auth-broker");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const w = r.log.find((l) => l.startsWith("wrapper auth-broker prod "));
    expect(w).toContain(`reg=${REG}`);
    expect(w).toContain(`client=${CLIENT}`);
    expect(puts(r.log)).toEqual(["GOOGLE_CLIENT_SECRET", "BROKER_STATE_KEY"]);
    expect(
      r.log
        .filter((l) => l.startsWith("stdin-len"))
        .every((l) => !l.endsWith(" 0")),
    ).toBe(true);
    expect(r.out).toContain("prod auth-broker: deployed and verified");
    clean(r);
  });
  it("a re-run keeps the state key (sets only the Google secret)", () => {
    const s = setup({
      secrets: {
        "oa-p-auth-broker": ["BROKER_STATE_KEY", "GOOGLE_CLIENT_SECRET"],
      },
    });
    const r = s.run("auth-broker");
    expect(r.code).toBe(0);
    expect(puts(r.log)).toEqual(["GOOGLE_CLIENT_SECRET"]);
  });
  it("a failed secrets listing stops before any state key is made", () => {
    const s = setup({ failSecrets: true });
    const r = s.run("auth-broker");
    expect(r.code).toBe(1);
    expect(puts(r.log)).toEqual([]);
    expect(r.err).toContain("list oa-p-auth-broker secrets failed");
    clean(r);
  });
  it("a deployed binding that doesn't match fails the run", () => {
    const bad = NEXT["oa-p-auth-broker"]?.replace(
      REG,
      "f".repeat(32),
    ) as string;
    const s = setup({ next: { "oa-p-auth-broker": bad } });
    const r = s.run("auth-broker");
    expect(r.code).toBe(1);
    expect(r.err).toContain("BROKER_REGISTRY: got");
  });
  it("directory-broker: its own secret and state key", () => {
    const s = setup();
    const r = s.run("directory-broker");
    expect(r.code).toBe(0);
    expect(puts(r.log)).toEqual([
      "GOOGLE_DIRECTORY_CLIENT_SECRET",
      "DIRECTORY_STATE_KEY",
    ]);
    clean(r);
  });
  for (const t of ["dispatch", "scheduler"]) {
    it(`${t} refuses until both brokers exist, then deploys and verifies`, () => {
      const none = setup().run(t);
      expect(none.code, t).toBe(1);
      expect(none.err).toContain("oa-p-auth-broker does not exist");
      expect(none.log.some((l) => l.startsWith("wrapper"))).toBe(false);
      const ok = setup({ exists: SCHED_DEPS("p") }).run(t);
      expect(ok.err, t).toBe("");
      expect(ok.code, t).toBe(0);
      expect(ok.out).toContain(`prod ${t}: deployed and verified`);
      clean(ok);
    });
  }
  describe("the BILLING binding (#1568): staging only", () => {
    const DEPS_S = ["oa-s-auth-broker", "oa-s-directory-broker"];
    it("staging dispatch and scheduler refuse until oa-s-billing exists, before any deploy", () => {
      for (const t of ["dispatch", "scheduler"]) {
        const exists =
          t === "scheduler"
            ? SCHED_DEPS("s").filter((w) => w !== "oa-s-billing")
            : DEPS_S;
        const r = setup({ exists }).run(t, {}, "staging");
        expect(r.code, t).toBe(1);
        expect(r.err).toContain("oa-s-billing does not exist: deploy it first");
        expect(r.log.some((l) => l.startsWith("wrapper"))).toBe(false);
      }
    });
    it("staging dispatch deploys and verifies its BILLING service binding", () => {
      const ok = setup({ exists: [...DEPS_S, "oa-s-billing"] }).run(
        "dispatch",
        {},
        "staging",
      );
      expect(ok.err).toBe("");
      expect(ok.code).toBe(0);
      expect(ok.out).toContain("staging dispatch: deployed and verified");
      // A missing, wrong or non-service BILLING binding fails the read-back.
      for (const [why, mut] of [
        [
          "missing",
          (b: Record<string, unknown>[]) =>
            b.filter((x) => x.name !== "BILLING"),
        ],
        [
          "the wrong Worker",
          (b: Record<string, unknown>[]) =>
            b.map((x) =>
              x.name === "BILLING" ? { ...x, service: "oa-p-billing" } : x,
            ),
        ],
      ] as const) {
        const next = JSON.parse(NEXT["oa-s-dispatch"] as string);
        next.result.bindings = mut(next.result.bindings);
        const bad = setup({
          exists: [...DEPS_S, "oa-s-billing"],
          next: { "oa-s-dispatch": JSON.stringify(next) },
        }).run("dispatch", {}, "staging");
        expect(bad.code, why).toBe(1);
        expect(bad.err, why).toContain("dispatch BILLING binding: got");
      }
    });
    it("staging scheduler verifies its BILLING binding too", () => {
      const next = JSON.parse(NEXT["oa-s-scheduler"] as string);
      next.result.bindings = next.result.bindings.filter(
        (x: { name: string }) => x.name !== "BILLING",
      );
      const bad = setup({
        exists: SCHED_DEPS("s"),
        next: { "oa-s-scheduler": JSON.stringify(next) },
      }).run("scheduler", {}, "staging");
      expect(bad.code).toBe(1);
      expect(bad.err).toContain("scheduler BILLING binding: got");
    });
    it("prod needs no billing Worker and refuses any BILLING binding on dispatch or the scheduler", () => {
      for (const t of ["dispatch", "scheduler"]) {
        // No oa-p-billing exists, and none is asked for.
        const ok = setup({ exists: SCHED_DEPS("p") }).run(t);
        expect(ok.code, `${t} ${ok.err}`).toBe(0);
        const key = t === "dispatch" ? "oa-p-dispatch" : "oa-p-scheduler";
        const next = JSON.parse(NEXT[key] as string);
        next.result.bindings.push({
          type: "service",
          name: "BILLING",
          service: "oa-p-billing",
        });
        const bad = setup({
          exists: SCHED_DEPS("p"),
          next: { [key]: JSON.stringify(next) },
        }).run(t);
        expect(bad.code, t).toBe(1);
        expect(bad.err, t).toContain(`${t} BILLING binding: got`);
      }
    });
  });

  describe("the BILLING binding follows the tag's own wrangler (#1568): required only when the tag declares it", () => {
    // main's scripts run against the tag's Workers: an older tag whose wrangler
    // has no BILLING must deploy on staging as before, and a tag that declares
    // it must not deploy without it.
    const DEPS = {
      dispatch: ["oa-s-auth-broker", "oa-s-directory-broker"],
      scheduler: SCHED_DEPS("s").filter((w) => w !== "oa-s-billing"),
      provisioner: [] as string[],
      provisioning: ["oa-s-provisioner", "oa-s-auth-broker"],
    } as const;
    const APP_CONFIG = (app: string) =>
      app === "scheduler"
        ? SCHED_CONFIG
        : readFileSync(join(root, "apps", app, "wrangler.jsonc"), "utf8");
    // The same config with its staging BILLING binding taken out (an older tag).
    const withoutBilling = (src: string) =>
      src.replace(/,?\s*\{\s*"binding":\s*"BILLING"[^}]*\}/g, "");
    // The same config with the binding replaced.
    const withBilling = (src: string, binding: string) =>
      src.replace(/\{\s*"binding":\s*"BILLING"[^}]*\}/g, binding);
    const liveWithout = (key: string) => {
      const next = JSON.parse(NEXT[key] as string);
      next.result.bindings = next.result.bindings.filter(
        (x: { name: string }) => x.name !== "BILLING",
      );
      return JSON.stringify(next);
    };
    const ENTRY = {
      dispatch: "",
      scheduler: "",
      provisioner: "BillingProvisionerRpc",
      provisioning: "BillingOperatorRpc",
    } as const;
    const APPS = [
      "dispatch",
      "scheduler",
      "provisioner",
      "provisioning",
    ] as const;
    // The staging provisioner's verify-only run reads an existing bucket.
    const VERIFY_FILES = { "r2-oa-s-releases": "" };

    it("the repo's staging configs declare it: dispatch and scheduler on the default entrypoint, the provisioner on BillingProvisionerRpc; prod's declare none", () => {
      for (const app of APPS) {
        const src = APP_CONFIG(app);
        const staging = src.slice(
          src.indexOf('"staging"'),
          src.indexOf('"prod"'),
        );
        expect(staging, app).toMatch(/"binding": "BILLING"/);
        expect(staging, app).toMatch(/"service": "oa-s-billing"/);
        expect(/BillingProvisionerRpc/.test(staging), app).toBe(
          app === "provisioner",
        );
        expect(/BillingOperatorRpc/.test(staging), app).toBe(
          app === "provisioning",
        );
        expect(src.slice(src.indexOf('"prod"')), app).not.toMatch(/"BILLING"/);
      }
    });

    for (const app of APPS) {
      it(`${app}, a tag that declares it: refuses until oa-s-billing exists (before any deploy), then deploys and verifies`, () => {
        const none = setup({ exists: DEPS[app] }).run(app, {}, "staging");
        expect(none.code, app).toBe(1);
        expect(none.err).toContain(
          "oa-s-billing does not exist: deploy it first",
        );
        expect(none.log.some((l) => l.startsWith("wrapper"))).toBe(false);
        const ok = setup({ exists: [...DEPS[app], "oa-s-billing"] }).run(
          app,
          {},
          "staging",
        );
        expect(ok.err, app).toBe("");
        expect(ok.code, app).toBe(0);
        expect(ok.out).toContain(`staging ${app}: deployed and verified`);
      });

      it(`${app}, a tag that declares it but deploys without the binding fails the read-back`, () => {
        const bad = setup({
          exists: [...DEPS[app], "oa-s-billing"],
          next: { [`oa-s-${app}`]: liveWithout(`oa-s-${app}`) },
        }).run(app, {}, "staging");
        expect(bad.code, app).toBe(1);
        expect(bad.err).toContain(`${app} BILLING binding: got`);
      });

      it(`${app}, an older tag with no BILLING in its wrangler: no oa-s-billing needed, deploys and verifies; a BILLING binding the tag did not declare fails`, () => {
        const configs = { [app]: withoutBilling(APP_CONFIG(app)) };
        // oa-s-billing does not exist, and none is asked for.
        // The provisioning target also needs its OAuth KV namespace id.
        const extra: Record<string, string> =
          app === "provisioning" ? { NEW_KV: OAUTH } : {};
        const ok = setup({
          configs,
          exists: DEPS[app],
          next: { [`oa-s-${app}`]: liveWithout(`oa-s-${app}`) },
        }).run(app, extra, "staging");
        expect(ok.err, app).toBe("");
        expect(ok.code, app).toBe(0);
        expect(ok.log.some((l) => l.startsWith(`wrapper ${app} staging`))).toBe(
          true,
        );
        // A live BILLING the tag never declared is not tolerated either.
        const bound = setup({ configs, exists: DEPS[app] }).run(
          app,
          extra,
          "staging",
        );
        expect(bound.code, app).toBe(1);
        expect(bound.err).toContain(`${app} BILLING binding: got`);
      });

      // The provisioning target's verify-only run also reads its KV namespace,
      // admin key and secrets, which its own describe fixtures; the deploy
      // read-back tests above cover its BILLING binding.
      it.skipIf(app === "provisioning")(
        `${app}, verify only: a tag that declares it needs it live; an older one needs none`,
        () => {
          // Verify only reads the live Worker (its settings file), deploys nothing.
          const base = {
            exists: [...DEPS[app], "oa-s-billing", `oa-s-${app}`],
            queues: queueList(["oa-s-signups", "oa-s-signups-dlq"]),
          };
          const live = setup({ ...base, files: VERIFY_FILES }).run(
            app,
            { VERIFY_ONLY: "1" },
            "staging",
          );
          expect(live.code, `${app} ${live.err}`).toBe(0);
          expect(noDeploy(live.log)).toEqual([]);
          const missing = setup({
            ...base,
            files: {
              ...VERIFY_FILES,
              [`oa-s-${app}.settings.json`]: liveWithout(`oa-s-${app}`),
            },
          }).run(app, { VERIFY_ONLY: "1" }, "staging");
          expect(missing.code, app).toBe(1);
          expect(missing.err).toContain(`${app} BILLING binding: got`);
          // An older tag: no BILLING declared, none live: verified without oa-s-billing.
          const old = setup({
            configs: { [app]: withoutBilling(APP_CONFIG(app)) },
            exists: [...DEPS[app], `oa-s-${app}`],
            queues: base.queues,
            files: {
              ...VERIFY_FILES,
              [`oa-s-${app}.settings.json`]: liveWithout(`oa-s-${app}`),
            },
          }).run(app, { VERIFY_ONLY: "1" }, "staging");
          expect(old.code, `${app} ${old.err}`).toBe(0);
        },
      );

      it(`${app}, a tag that binds the wrong service or entrypoint is refused before any deploy`, () => {
        for (const [why, binding] of [
          [
            "wrong service",
            '{ "binding": "BILLING", "service": "oa-p-billing" }',
          ],
          [
            "wrong entrypoint",
            `{ "binding": "BILLING", "service": "oa-s-billing", "entrypoint": "${app === "provisioner" || app === "provisioning" ? "Other" : "BillingProvisionerRpc"}" }`,
          ],
        ] as const) {
          const configs = { [app]: withBilling(APP_CONFIG(app), binding) };
          const r = setup({
            configs,
            exists: [...DEPS[app], "oa-s-billing"],
          }).run(app, {}, "staging");
          expect(r.code, `${app} ${why}`).toBe(1);
          expect(r.err).toMatch(/BILLING binding (is|has)/);
          expect(noDeploy(r.log)).toEqual([]);
        }
      });

      it(`${app}, prod: a tag whose prod config binds BILLING is refused before any deploy; the live read-back asserts none`, () => {
        // Splice a BILLING binding into the prod block of the tag's config.
        const src = APP_CONFIG(app);
        const at = src.indexOf('"prod"');
        const head = src.slice(0, at);
        const rest = src.slice(at);
        const entry = '{ "binding": "BILLING", "service": "oa-p-billing" }';
        const prod = /"services":\s*\[/.test(rest)
          ? rest.replace(/"services":\s*\[/, `"services": [ ${entry},`)
          : rest.replace(/"prod":\s*\{/, `"prod": { "services": [ ${entry} ],`);
        const configs = { [app]: head + prod };
        const r = setup({ configs, exists: SCHED_DEPS("p") }).run(
          app,
          {},
          "prod",
        );
        expect(r.code, app).toBe(1);
        expect(r.err).toContain("it is staging only");
        expect(noDeploy(r.log)).toEqual([]);
      });
    }

    it("the provisioner's read-back also confirms the entrypoint, and a staging binding to another entrypoint fails", () => {
      const wrongEntry = JSON.parse(NEXT["oa-s-provisioner"] as string);
      for (const b of wrongEntry.result.bindings)
        if (b.name === "BILLING") b.entrypoint = "default";
      const r = setup({
        exists: ["oa-s-billing"],
        next: { "oa-s-provisioner": JSON.stringify(wrongEntry) },
      }).run("provisioner", {}, "staging");
      expect(r.code).toBe(1);
      expect(r.err).toContain(
        "provisioner BILLING binding: got 'service oa-s-billing default', want 'service oa-s-billing BillingProvisionerRpc'",
      );
    });

    it("prod's provisioner needs no billing Worker and asserts no BILLING binding", () => {
      const ok = setup({}).run("provisioner");
      expect(ok.code, ok.err).toBe(0);
      const next = JSON.parse(NEXT["oa-p-provisioner"] as string);
      next.result.bindings.push({
        type: "service",
        name: "BILLING",
        service: "oa-p-billing",
        entrypoint: "BillingProvisionerRpc",
      });
      const bad = setup({
        next: { "oa-p-provisioner": JSON.stringify(next) },
      }).run("provisioner");
      expect(bad.code).toBe(1);
      expect(bad.err).toContain("provisioner BILLING binding: got");
    });
  });

  it("the scheduler also refuses until the provisioner exists", () => {
    const noProv = setup({
      exists: ["oa-p-auth-broker", "oa-p-directory-broker"],
    }).run("scheduler");
    expect(noProv.code).toBe(1);
    expect(noProv.err).toContain("oa-p-provisioner does not exist");
    expect(noProv.log.some((l) => l.startsWith("wrapper"))).toBe(false);
  });
  describe("the approval email follows the tag's own wrangler (#2096): required only when the tag declares it", () => {
    // main's scripts run against the tag's Workers: a tag cut before the
    // approval email (no WELCOME_FROM, no send_email WELCOME_EMAIL) must deploy
    // and verify, and a tag that declares it keeps every strict check.
    const WDEPS = {
      provisioner: [] as string[],
      provisioning: ["oa-p-provisioner", "oa-p-auth-broker"],
    } as const;
    const withoutWelcome = (src: string) =>
      src
        .split("\n")
        .filter((l) => !l.includes("WELCOME_"))
        .join("\n");
    const liveEdit = (
      key: string,
      f: (b: { name: string; type: string }[]) => unknown[],
    ) => {
      const next = JSON.parse(NEXT[key] as string);
      next.result.bindings = f(next.result.bindings);
      return JSON.stringify(next);
    };
    const liveWithoutWelcome = (key: string) =>
      liveEdit(key, (b) => b.filter((x) => !x.name.startsWith("WELCOME_")));
    for (const app of ["provisioner", "provisioning"] as const) {
      const real = readFileSync(
        join(root, "apps", app, "wrangler.jsonc"),
        "utf8",
      );
      const old = withoutWelcome(real);

      it(`${app}, a tag before the approval email: deploys and verifies without WELCOME_FROM or the binding`, () => {
        expect(old).not.toMatch(/WELCOME_/);
        const r = setup({
          configs: { [app]: old },
          exists: WDEPS[app],
          next: { [`oa-p-${app}`]: liveWithoutWelcome(`oa-p-${app}`) },
        }).run(app, { WELCOME_FROM: "" });
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        expect(r.out).toContain(`prod ${app}: deployed and verified`);
        clean(r);
      });

      it(`${app}, a tag before the approval email: a WELCOME_EMAIL binding it never declared still fails`, () => {
        const bad = setup({
          configs: { [app]: old },
          exists: WDEPS[app],
        }).run(app, { WELCOME_FROM: "" });
        expect(bad.code).toBe(1);
        expect(bad.err).toContain("WELCOME_EMAIL: got 'send_email', want ''");
      });

      it(`${app}, a current tag: WELCOME_FROM is required, and the binding must be live as send_email`, () => {
        const need = setup({ exists: WDEPS[app] }).run(app, {
          WELCOME_FROM: "",
        });
        expect(need.code).toBe(2);
        expect(need.log.filter((l) => l.startsWith("wrapper"))).toEqual([]);
        for (const [why, live] of [
          ["missing", liveWithoutWelcome(`oa-p-${app}`)],
          [
            "wrong type",
            liveEdit(`oa-p-${app}`, (b) =>
              b.map((x) =>
                x.name === "WELCOME_EMAIL" ? { ...x, type: "plain_text" } : x,
              ),
            ),
          ],
        ] as const) {
          const bad = setup({
            exists: WDEPS[app],
            next: { [`oa-p-${app}`]: live },
          }).run(app);
          expect(bad.code, why).toBe(1);
          expect(bad.err, why).toContain("WELCOME_EMAIL: got");
        }
      });
    }
  });

  describe("the observability read-back follows the tag's own wrangler (#164): strict only when the tag turns it on", () => {
    const WDEPS = {
      provisioner: [] as string[],
      provisioning: ["oa-p-provisioner", "oa-p-auth-broker"],
    } as const;
    // The same config as a tag cut before #164 had it: observability off.
    const offConfig = (src: string) =>
      src.replace(
        /"observability": \{[\s\S]*?"head_sampling_rate": 1\s*\}\s*\}/g,
        '"observability": { "enabled": false }',
      );
    const bindingsOf = (key: string) =>
      JSON.parse(NEXT[key] as string).result.bindings;
    for (const app of ["provisioner", "provisioning"] as const) {
      const real = readFileSync(
        join(root, "apps", app, "wrangler.jsonc"),
        "utf8",
      );
      const old = offConfig(real);
      const key = `oa-p-${app}`;

      it(`${app}, a tag with observability off: deploys and verifies with it off; a live-on Worker fails`, () => {
        expect(old).not.toContain("invocation_logs");
        const ok = setup({
          configs: { [app]: old },
          exists: WDEPS[app],
          next: { [key]: settingsOff(bindingsOf(key)) },
        }).run(app);
        expect(ok.err).toBe("");
        expect(ok.code).toBe(0);
        const bad = setup({ configs: { [app]: old }, exists: WDEPS[app] }).run(
          app,
        );
        expect(bad.code).toBe(1);
        expect(bad.err).toContain("observability: got 'true', want 'false'");
      });

      it(`${app}, a tag with observability on: off, or invocation logs on or unset, still fails`, () => {
        for (const [why, live, msg] of [
          [
            "off",
            settingsOff(bindingsOf(key)),
            "observability: got 'false', want 'true'",
          ],
          [
            "invocation on",
            settings(bindingsOf(key), true, true),
            "observability invocation_logs",
          ],
          [
            "invocation unset",
            settings(bindingsOf(key), true, null),
            "observability invocation_logs",
          ],
        ] as const) {
          const bad = setup({
            exists: WDEPS[app],
            next: { [key]: live },
          }).run(app);
          expect(bad.code, why).toBe(1);
          expect(bad.err, why).toContain(msg);
        }
      });
    }
  });

  describe("the scheduler's alert wiring (#915's placeholders, or none before it)", () => {
    // #915's config, and the repo's own once it carries the placeholders.
    const PINNED = [
      ["#915's config", F915],
      ...(pinned(REAL_SCHED) ? [["apps/scheduler", REAL_SCHED] as const] : []),
    ] as const;
    const ALERTS = {
      ALERT_TO: "me@test.invalid",
      ALERT_FROM: "alerts@open-artifacts.app",
      SIGNUP_DAILY_CAP: "50",
      SIGNUPS_ENABLED: "false",
    };
    // The deployed scheduler with its alert wiring filled.
    const wired = (
      p: "s" | "p",
      over: Record<string, string | null> = {},
      dest: string | null = ALERTS.ALERT_TO,
    ) =>
      settings(
        [
          ...schedulerBindings(p, null).map((b) =>
            b.name === "ALERT_EMAIL" && dest !== null
              ? { ...b, destination_address: dest }
              : b,
          ),
          ...Object.entries({ ...ALERTS, ...over }).flatMap(([name, text]) =>
            text === null ? [] : [{ type: "plain_text", name, text }],
          ),
        ],
        true,
      );
    const go = (
      config: string,
      env: "staging" | "prod",
      next: string,
      vars: Record<string, string> = {},
    ) => {
      const p = env[0] as "s" | "p";
      // A config that does not declare BILLING is an older tag: its Worker
      // is deployed without the binding (#1568).
      const live = JSON.parse(next);
      if (!/"BILLING"/.test(config))
        live.result.bindings = live.result.bindings.filter(
          (b: { name: string }) => b.name !== "BILLING",
        );
      const s = setup({
        exists: SCHED_DEPS(p),
        next: { [`oa-${p}-scheduler`]: JSON.stringify(live) },
      });
      const r = s.sb.run(
        ["bash", tree({ scheduler: config }), env, "scheduler"],
        {
          env: {
            ...ENV,
            ...ALERTS,
            STATE: s.state,
            DEPLOY_WRAPPER: wrapperStub(s.sb.dir),
            BROKER_PIN_FILE: "/dev/null",
            ...vars,
          },
        },
      );
      const log = s.sb.log();
      return { ...r, log };
    };
    // Before #915 (no placeholders): #915's config with its alert lines cut,
    // and the repo's own until #915.
    const strip = (c: string) =>
      c
        .replace(
          /\n\s*"(ALERT_TO|ALERT_FROM|SIGNUP_DAILY_CAP|SIGNUPS_ENABLED)": "\{\{[A-Z_]+\}\}",/g,
          "",
        )
        .replace(
          /\{ "name": "ALERT_EMAIL", "destination_address": "\{\{ALERT_TO_[A-Z]+\}\}" \}/g,
          '{ "name": "ALERT_EMAIL" }',
        );
    const BARES = [
      ["#915's config, cut", strip(F915)],
      ...(pinned(REAL_SCHED) ? [] : [["apps/scheduler", REAL_SCHED] as const]),
    ] as const;
    for (const [label, BARE] of BARES)
      for (const env of ["prod", "staging"] as const)
        for (const VERIFY_ONLY of ["", "1"])
          it(`before #915 (${label}), ${env}${VERIFY_ONLY ? ", verify only" : ""}: refuses before any deploy (4.8: an alert needs a destination)`, () => {
            expect(BARE).not.toContain("{{ALERT_");
            const p = env[0] as "s" | "p";
            const r = go(
              BARE,
              env,
              settings(schedulerBindings(p, null), true),
              {
                VERIFY_ONLY,
              },
            );
            expect(r.code).toBe(1);
            expect(r.err).toContain(
              `the tag's scheduler config doesn't pin the ${env} alerts`,
            );
            expect(noDeploy(r.log)).toEqual([]);
            expect(r.out).not.toContain("verified");
          });
    for (const [label, config] of PINNED) {
      for (const env of ["prod", "staging"] as const) {
        const p = env[0] as "s" | "p";
        it(`${label}, ${env}: reads back every alert var and ALERT_EMAIL's destination`, () => {
          const ok = go(config, env, wired(p));
          expect(ok.err).toBe("");
          expect(ok.code).toBe(0);
          expect(ok.out).toContain(`${env} scheduler: deployed and verified`);
        });
        for (const [what, over, dest, msg] of [
          [
            "a wrong destination",
            {},
            "x@example.com",
            "ALERT_EMAIL destination",
          ],
          ["no destination", {}, null, "ALERT_EMAIL destination"],
          [
            "a wrong ALERT_TO",
            { ALERT_TO: "x@example.com" },
            ALERTS.ALERT_TO,
            "ALERT_TO",
          ],
          ["no ALERT_TO", { ALERT_TO: null }, ALERTS.ALERT_TO, "ALERT_TO"],
          [
            "a wrong ALERT_FROM",
            { ALERT_FROM: "x@open-artifacts.app" },
            ALERTS.ALERT_TO,
            "ALERT_FROM",
          ],
          [
            "a wrong cap",
            { SIGNUP_DAILY_CAP: "51" },
            ALERTS.ALERT_TO,
            "SIGNUP_DAILY_CAP",
          ],
        ] as const)
          it(`${label}, ${env}: refuses ${what} read back`, () => {
            const r = go(config, env, wired(p, over, dest));
            expect(r.code).toBe(1);
            // #1084: the owner's address is never printed, old or new.
            if (msg === "ALERT_FROM" || msg === "SIGNUP_DAILY_CAP") {
              expect(r.err).toContain(`${msg}: got`);
            } else {
              expect(r.err).toContain(`${msg}: not the expected value`);
              expect(r.err).not.toContain("@");
            }
          });
        // A deployed gate other than the env's (true allowed here, so the
        // signups rule isn't what refuses it).
        it(`${label}, ${env}: refuses a deployed SIGNUPS_ENABLED other than the env's`, () => {
          const gate = go(config, env, wired(p, { SIGNUPS_ENABLED: "true" }), {
            ALLOW_SIGNUPS: "1",
          });
          expect(gate.code).toBe(1);
          expect(gate.err).toContain(
            "SIGNUPS_ENABLED: got 'true', want 'false'",
          );
        });
        for (const k of Object.keys(ALERTS))
          it(`${label}, ${env}: ${k} is required before any deploy`, () => {
            const r = go(config, env, wired(p), { [k]: "" });
            expect(r.code).toBe(2);
            expect(r.err).toContain(`${k} is required for scheduler`);
            expect(r.log.some((l) => l.startsWith("wrapper"))).toBe(false);
          });
      }
      for (const [what, cut] of [
        [
          "no ALERT_FROM",
          (c: string) => c.replace('"ALERT_FROM": "{{ALERT_FROM_PROD}}",', ""),
        ],
        [
          "a fixed destination",
          (c: string) =>
            c.replace(
              '"destination_address": "{{ALERT_TO_PROD}}"',
              '"destination_address": "ops@example.com"',
            ),
        ],
        [
          "a fixed SIGNUPS_ENABLED",
          (c: string) =>
            c.replace(
              '"SIGNUPS_ENABLED": "{{SIGNUPS_ENABLED_PROD}}"',
              '"SIGNUPS_ENABLED": "false"',
            ),
        ],
      ] as const)
        it(`${label}: a half-pinned config (${what}) refuses before any deploy`, () => {
          const half = cut(config);
          expect(half).not.toBe(config);
          const r = go(half, "prod", wired("p"));
          expect(r.code).toBe(1);
          expect(r.err).toContain("half pins the prod alerts; refusing");
          expect(r.log.some((l) => l.startsWith("wrapper"))).toBe(false);
        });
    }
  });
  it("the scheduler refuses before any deploy until the provisioner exists", () => {
    for (const verify of ["", "1"]) {
      const r = setup({
        exists: ["oa-p-auth-broker", "oa-p-directory-broker"],
      }).run("scheduler", { VERIFY_ONLY: verify });
      expect(r.code, verify).toBe(1);
      expect(r.err).toContain(
        "oa-p-provisioner does not exist: deploy it first",
      );
      expect(noDeploy(r.log)).toEqual([]);
    }
  });
  // The scheduler refuses before any deploy unless exactly one oa-<p>-signups
  // queue is listed, on one page.
  const missing = "oa-p-signups queue does not exist: create it first";
  const paged = "more than one page of queues; refusing";
  for (const [label, queues, msg] of [
    ["only another queue", queueList(["other"]), missing],
    ["no queues", queueList([]), missing],
    // Staging's queue is not prod's.
    ["only staging's queue", queueList(["oa-s-signups"]), missing],
    ["two oa-p-signups", queueList(["oa-p-signups", "oa-p-signups"]), missing],
    ["total_count over a page", queueList(["oa-p-signups"], 101), paged],
    ["two pages", queueList(["oa-p-signups"], 1, 2), paged],
    // No result_info: can't tell the listing is whole.
    [
      "no result_info",
      JSON.stringify({
        success: true,
        result: [{ queue_name: "oa-p-signups" }],
      }),
      paged,
    ],
    ["a failed listing", null, "list queues failed"],
  ] as const) {
    for (const verify of ["", "1"]) {
      it(`the scheduler refuses before any deploy (${verify ? "verify only" : "deploy"}): ${label}`, () => {
        const r = setup({ exists: SCHED_DEPS("p"), queues }).run("scheduler", {
          VERIFY_ONLY: verify,
        });
        expect(r.code, `${msg} ${verify}`).toBe(1);
        expect(r.err).toContain(msg);
        expect(noDeploy(r.log)).toEqual([]);
        clean(r);
      });
    }
  }
  it("the scheduler lists queues on one page of 100 and deploys on exactly one oa-p-signups", () => {
    const ok = setup({ exists: SCHED_DEPS("p") }).run("scheduler");
    expect(ok.code, ok.err).toBe(0);
    expect(ok.log).toContain(
      `curl -sS -K - https://api.cloudflare.com/client/v4/accounts/${ACCT}/queues?per_page=100`,
    );
  });
  // The scheduler fails on a readback mismatch in each provisioning binding,
  // deployed or verify only. Its bindings with one changed (null: removed).
  const with_ = (name: string, v: Record<string, unknown> | null) =>
    settings(
      schedulerBindings("p").flatMap((b) =>
        b.name !== name ? [b] : v === null ? [] : [{ ...b, ...v }],
      ),
      true,
    );
  for (const [name, v, msg] of [
    ["PROVISIONER", { service: "oa-s-provisioner" }, "PROVISIONER: got"],
    ["PROVISIONER", { entrypoint: "default" }, "PROVISIONER entrypoint: got"],
    ["PROVISIONER", { type: "plain_text" }, "PROVISIONER type: got"],
    ["PROVISIONER", null, "PROVISIONER type: got ''"],
    ["SIGNUPS", { queue_name: "oa-s-signups" }, "SIGNUPS: got"],
    ["SIGNUPS", { type: "service" }, "SIGNUPS type: got"],
    ["SIGNUPS", null, "SIGNUPS type: got ''"],
    ["PROVISION_INSTALL", { type: "service" }, "PROVISION_INSTALL: got"],
    ["PROVISION_INSTALL", null, "PROVISION_INSTALL: got ''"],
    ["MANAGE_INSTALL", { type: "queue" }, "MANAGE_INSTALL: got"],
    ["MANAGE_INSTALL", null, "MANAGE_INSTALL: got ''"],
    ["ALERT_EMAIL", { type: "plain_text" }, "ALERT_EMAIL: got"],
    ["ALERT_EMAIL", null, "ALERT_EMAIL: got ''"],
  ] as const) {
    it(`the scheduler fails on a readback mismatch, deployed or verify only: ${name} ${v === null ? "removed" : JSON.stringify(v)}`, () => {
      const bad = with_(name, v);
      const r = setup({
        exists: SCHED_DEPS("p"),
        next: { "oa-p-scheduler": bad },
      }).run("scheduler");
      expect(r.code, msg).toBe(1);
      expect(r.err).toContain(msg);
      // Verify only runs the same check against the live Worker.
      const live = setup({ exists: SCHED_DEPS("p") });
      writeFileSync(join(live.state, "oa-p-scheduler.exists"), "");
      writeFileSync(join(live.state, "oa-p-scheduler.settings.json"), bad);
      const vr = live.run("scheduler", { VERIFY_ONLY: "1" });
      expect(vr.code, `verify ${msg}`).toBe(1);
      expect(vr.err).toContain(msg);
      expect(noDeploy(vr.log)).toEqual([]);
    });
  }
  it("the scheduler, verify only: no deploy, every check passes on a matching live Worker", () => {
    const s = setup({ exists: SCHED_DEPS("p") });
    writeFileSync(join(s.state, "oa-p-scheduler.exists"), "");
    writeFileSync(
      join(s.state, "oa-p-scheduler.settings.json"),
      NEXT["oa-p-scheduler"] as string,
    );
    const r = s.run("scheduler", { VERIFY_ONLY: "1" });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(noDeploy(r.log)).toEqual([]);
    expect(r.out).toContain("prod scheduler: verified (verify only)");
  });
  it("the scheduler, staging: the oa-s provisioner, queue and bindings", () => {
    const r = setup({ exists: SCHED_DEPS("s") }).run(
      "scheduler",
      {},
      "staging",
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.log.some((l) => l.startsWith("wrapper scheduler staging "))).toBe(
      true,
    );
    expect(r.out).toContain("staging scheduler: deployed and verified");
    clean(r);
    // Prod's provisioner or queue don't stand in for staging's.
    const noProv = setup({
      exists: [...SCHED_DEPS("p"), "oa-s-auth-broker", "oa-s-directory-broker"],
    }).run("scheduler", {}, "staging");
    expect(noProv.code).toBe(1);
    expect(noProv.err).toContain("oa-s-provisioner does not exist");
    expect(noDeploy(noProv.log)).toEqual([]);
    const noQueue = setup({
      exists: SCHED_DEPS("s"),
      queues: queueList(["oa-p-signups"]),
    }).run("scheduler", {}, "staging");
    expect(noQueue.code).toBe(1);
    expect(noQueue.err).toContain(
      "oa-s-signups queue does not exist: create it first",
    );
    expect(noDeploy(noQueue.log)).toEqual([]);
    // A staging Worker bound to prod's provisioner fails the readback.
    const cross = setup({
      exists: SCHED_DEPS("s"),
      next: {
        "oa-s-scheduler": (NEXT["oa-s-scheduler"] as string).replace(
          '"service":"oa-s-provisioner"',
          '"service":"oa-p-provisioner"',
        ),
      },
    }).run("scheduler", {}, "staging");
    expect(cross.code).toBe(1);
    expect(cross.err).toContain(
      "PROVISIONER: got 'oa-p-provisioner', want 'oa-s-provisioner'",
    );
  });
  it("the scheduler checks its two schedules exactly", () => {
    const s = setup({ exists: SCHED_DEPS("p") });
    writeFileSync(
      join(s.state, "oa-p-scheduler.schedules.json"),
      JSON.stringify({
        success: true,
        result: { schedules: [{ cron: "17 3 * * *" }] },
      }),
    );
    const r = s.run("scheduler");
    expect(r.code).toBe(1);
    expect(r.err).toContain("schedules are '17 3 * * *'");
  });
  it("missing inputs, a bad account id or an unknown target refuse before any call", () => {
    for (const [t, env] of [
      ["auth-broker", { GOOGLE_CLIENT_ID: "" }],
      ["auth-broker", { CLOUDFLARE_ACCOUNT_ID: "nope" }],
      ["platform-db", { PLATFORM_DB_ID: "" }],
      ["platform-db", { MAIN_MIGRATION_LOCK: "" }],
      ["provision-token", { SECRETS_STORE_ID: "" }],
      ["provisioner", { WELCOME_FROM: "" }],
      ["provisioning", { GITHUB_REPOSITORY_ID: "" }],
      ["provisioning", { SIGNUP_DAILY_CAP: "" }],
      ["provisioning", { WELCOME_FROM: "" }],
      ["inventory", { GITHUB_REPOSITORY_ID: "" }],
      ["inventory", { GITHUB_REPOSITORY: "" }],
      ["inventory", { GITHUB_REPOSITORY: "o/r/x" }],
      ["inventory", { GITHUB_REPOSITORY_ID: "01" }],
      ["scheduler", { ALERT_TO: "" }],
      ["dispatch", { HOSTS_KV_ID: "" }],
      ["bogus", {}],
    ] as const) {
      const r = setup().run(t, env);
      expect(r.code, `${t} ${JSON.stringify(env)}`).toBe(2);
      expect(
        r.log.filter((l) => l.startsWith("pnpm") || l.startsWith("curl")),
      ).toEqual([]);
    }
  });
  it("staging: the oa-s names, the staging origin and --env staging", () => {
    const s = setup({
      next: {
        "oa-s-auth-broker": (NEXT["oa-p-auth-broker"] as string).replace(
          "https://auth.open-artifacts.app",
          "https://auth.open-artifacts-staging.app",
        ),
      },
    });
    const r = s.run("auth-broker", {}, "staging");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(
      r.log.some((l) => l.startsWith("wrapper auth-broker staging ")),
    ).toBe(true);
    expect(r.log).toContain(
      "pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env staging",
    );
    expect(r.out).toContain("staging auth-broker: deployed and verified");
    clean(r);
  });
  it("verify only: no deploy and no secret written, every check still runs", () => {
    const s = setup({
      exists: ["oa-p-auth-broker"],
      secrets: {
        "oa-p-auth-broker": ["BROKER_STATE_KEY", "GOOGLE_CLIENT_SECRET"],
      },
    });
    const r = s.run("auth-broker", {
      VERIFY_ONLY: "1",
      GOOGLE_CLIENT_SECRET: "",
    });
    expect(r.code).toBe(0);
    expect(
      r.log.filter((l) => l.startsWith("wrapper") || l.startsWith("pnpm")),
    ).toEqual([]);
    expect(r.out).toContain("prod auth-broker: verified (verify only)");
    const bad = setup({
      exists: ["oa-p-auth-broker"],
      next: {
        "oa-p-auth-broker": (NEXT["oa-p-auth-broker"] as string).replace(
          REG,
          "f".repeat(32),
        ),
      },
      secrets: {
        "oa-p-auth-broker": ["BROKER_STATE_KEY", "GOOGLE_CLIENT_SECRET"],
      },
    });
    writeFileSync(
      join(bad.state, "oa-p-auth-broker.settings.json"),
      (NEXT["oa-p-auth-broker"] as string).replace(REG, "f".repeat(32)),
    );
    expect(bad.run("auth-broker", { VERIFY_ONLY: "1" }).code).toBe(1);
  });
  it("inventory: the repo's config: refused before deploying until it commits the OIDC refs (W8), then deployed with its two ids and 6.3's bindings required", () => {
    const real = readFileSync(
      join(root, "apps/inventory/wrangler.jsonc"),
      "utf8",
    );
    const repo = committedVars(real, "prod", {
      GITHUB_REPOSITORY_ID: REPO_ID,
    }).OIDC_REPOSITORY;
    const r = setup().run("inventory", repo ? { GITHUB_REPOSITORY: repo } : {});
    const w = r.log.find((l) => l.startsWith("wrapper inventory prod "));
    expect(r.code).toBe(1);
    if (!repo) {
      expect(w).toBeUndefined();
      expect(r.err).toContain("commits no OIDC_JOB_WORKFLOW_REFS");
      return;
    }
    expect(w).toContain(`hosts=${HOSTS}`);
    expect(w).toContain(`db=${DB}`);
    expect(r.err).toContain("bindings: got 'HOSTS,PLATFORM_DB'");
  });
  it("in CI, prod runs only from main in hosted-prod-deploy; staging is not held to that", () => {
    const ci = {
      GITHUB_ACTIONS: "true",
      DEPLOY_ENVIRONMENT: "hosted-prod-deploy",
    };
    expect(
      setup().run("auth-broker", { ...ci, GITHUB_REF: "refs/heads/feature" })
        .code,
    ).toBe(2);
    expect(
      setup().run("auth-broker", {
        ...ci,
        GITHUB_REF: "refs/heads/main",
        DEPLOY_ENVIRONMENT: "hosted-staging-deploy",
      }).code,
    ).toBe(2);
    const ok = setup().run("auth-broker", {
      ...ci,
      GITHUB_REF: "refs/heads/main",
      DEPLOY_TAG: "v0.90.3",
    });
    expect(ok.code, ok.err).toBe(0);
    expect(
      ok.log.find((l) => l.startsWith("wrapper auth-broker prod ")),
    ).toContain("tag=v0.90.3");
  });
  it("in CI, a deploy needs a stable DEPLOY_TAG, refused before any change; verify only does not", () => {
    const ci = {
      GITHUB_ACTIONS: "true",
      GITHUB_REF: "refs/heads/main",
      DEPLOY_ENVIRONMENT: "hosted-prod-deploy",
    };
    for (const DEPLOY_TAG of ["", "0.90.3", "v0.90.3-rc.1"]) {
      const r = setup().run("auth-broker", { ...ci, DEPLOY_TAG });
      expect(r.code, DEPLOY_TAG).toBe(2);
      expect(r.err).toContain("DEPLOY_TAG must be a stable vX.Y.Z");
      expect(noDeploy(r.log)).toEqual([]);
      expect(puts(r.log)).toEqual([]);
    }
    const local = setup().run("auth-broker");
    expect(local.code, local.err).toBe(0);
    expect(
      local.log.find((l) => l.startsWith("wrapper auth-broker prod ")),
    ).toMatch(/ tag=$/);
  });
  it("refuses an env other than staging or prod", () => {
    expect(setup().run("auth-broker", {}, "dev").code).toBe(2);
  });
  it("deploys through the allowlisted wrapper by default; the token never in curl's argv", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain(
      'wrapper="${DEPLOY_WRAPPER:-$root/scripts/ops/deploy-platform-worker.sh}"',
    );
    expect(src).not.toMatch(/Bearer \$|-H "Authorization/);
  });

  describe("the signups gate: SIGNUPS_ENABLED true needs ALLOW_SIGNUPS=1, before and after the deploy", () => {
    const cfg = (app: string) =>
      readFileSync(join(root, "apps", app, "wrangler.jsonc"), "utf8");
    /** The prod block's SIGNUPS_ENABLED committed as a literal "true". */
    const literalTrue = (app: string, src: string) => {
      const out =
        app === "provisioning"
          ? src.replace(
              /("prod"[\s\S]*)"SIGNUPS_ENABLED": "false"/,
              '$1"SIGNUPS_ENABLED": "true"',
            )
          : src.replace(
              '"SIGNUPS_ENABLED": "{{SIGNUPS_ENABLED_PROD}}"',
              '"SIGNUPS_ENABLED": "true"',
            );
      expect(out, app).not.toBe(src);
      return out;
    };
    /** These settings with SIGNUPS_ENABLED deployed as `v`. */
    const deployedAs = (json: string, v: string) =>
      settings(
        JSON.parse(json).result.bindings.map((b: { name: string }) =>
          b.name === "SIGNUPS_ENABLED" ? { ...b, text: v } : b,
        ),
        JSON.parse(json).result.observability.enabled,
      );
    const provisioningReady = {
      "kvns.json": JSON.stringify([
        { id: OAUTH, title: "oa-p-provisioning-oauth" },
      ]),
      [`kv-${REG}-install:i000000admin`]: JSON.stringify({
        installId: "i000000admin",
        origin: "https://admin.open-artifacts.app",
        keys: [{ kid: "k".repeat(16), x: "x".repeat(43) }],
        domains: [],
      }),
      "queues.json": JSON.stringify([
        { queue_name: "oa-p-signups" },
        { queue_name: "oa-p-signups-dlq" },
      ]),
      "r2-oa-p-releases": "",
    };
    const TARGETS: [string, string, string[], Record<string, string[]>][] = [
      ["provisioner", cfg("provisioner"), [], {}],
      [
        "provisioning",
        cfg("provisioning"),
        ["oa-p-provisioner", "oa-p-auth-broker"],
        { "oa-p-provisioning": ["ADMIN_BROKER_KEY", "ADMIN_SESSION_KEY"] },
      ],
      ["scheduler", SCHED_CONFIG, SCHED_DEPS("p"), {}],
    ];
    for (const [app, src, exists, secrets] of TARGETS) {
      const W = `oa-p-${app}`;
      const go = (
        config: string,
        deployed: string,
        env: Record<string, string> = {},
      ) =>
        setup({
          exists: [...exists],
          secrets: { ...secrets },
          files: app === "scheduler" ? {} : provisioningReady,
          configs: { [app]: config },
          next: { [W]: deployedAs(NEXT[W] as string, deployed) },
        }).run(app, env);
      it(`${app}: a tag that commits "true" (a literal; the scheduler's as filled) is refused before any deploy, and passes with ALLOW_SIGNUPS=1`, () => {
        // The scheduler pins its gate to {{SIGNUPS_ENABLED_PROD}}: a literal
        // is a half pin, refused before any deploy; its "true" comes from
        // SIGNUPS_ENABLED (the committed value as filled), the same rule.
        if (app === "scheduler") {
          const r = go(literalTrue(app, src), "true", { ALLOW_SIGNUPS: "1" });
          expect(r.code).toBe(1);
          expect(r.err).toContain("half pins the prod alerts; refusing");
          expect(noDeploy(r.log)).toEqual([]);
        }
        const yes = app === "scheduler" ? src : literalTrue(app, src);
        const want: Record<string, string> =
          app === "scheduler" ? { SIGNUPS_ENABLED: "true" } : {};
        for (const VERIFY_ONLY of ["", "1"]) {
          const r = go(yes, "true", { ...want, VERIFY_ONLY });
          expect(r.code, `${app} ${VERIFY_ONLY}`).toBe(1);
          expect(r.err).toContain(
            `the tag's prod ${app} config: SIGNUPS_ENABLED=true opens self-serve signups and needs ALLOW_SIGNUPS=1; refusing`,
          );
          expect(noDeploy(r.log)).toEqual([]);
        }
        const ok = go(yes, "true", { ...want, ALLOW_SIGNUPS: "1" });
        expect(ok.err, app).toBe("");
        expect(ok.code, app).toBe(0);
        expect(ok.out).toContain(`prod ${app}: deployed and verified`);
        // The committed false still deploys as before.
        const closed = go(src, "false");
        expect(closed.code, closed.err).toBe(0);
      });
      it(`${app}: a deployed "invite" (#2096) needs ALLOW_SIGNUPS=1 like "true"`, () => {
        const r = go(src, "invite");
        expect(r.code, app).toBe(1);
        expect(r.err).toContain(
          `deployed ${W}: SIGNUPS_ENABLED=invite admits the allow list and needs ALLOW_SIGNUPS=1; refusing`,
        );
      });
      it(`${app}: a deployed "true" is refused on read-back unless ALLOW_SIGNUPS=1, verify only too`, () => {
        for (const VERIFY_ONLY of ["", "1"]) {
          const s = setup({
            exists: [...exists, W],
            secrets: { ...secrets },
            files: app === "scheduler" ? {} : provisioningReady,
            next: { [W]: deployedAs(NEXT[W] as string, "true") },
          });
          if (VERIFY_ONLY)
            writeFileSync(
              join(s.state, `${W}.settings.json`),
              deployedAs(NEXT[W] as string, "true"),
            );
          const r = s.run(app, { VERIFY_ONLY });
          expect(r.code, `${app} ${VERIFY_ONLY}`).toBe(1);
          expect(r.err).toContain(
            `deployed ${W}: SIGNUPS_ENABLED=true opens self-serve signups and needs ALLOW_SIGNUPS=1; refusing`,
          );
        }
        for (const [v, msg] of [
          ["", "SIGNUPS_ENABLED is '', want false"],
          ["test-users", "test-users is staging only"],
          ["yes", "SIGNUPS_ENABLED is 'yes', want false"],
        ] as const) {
          const r = go(src, v, { ALLOW_SIGNUPS: "1" });
          expect(r.code, `${app} ${v}`).toBe(1);
          expect(r.err, `${app} ${v}`).toContain(msg);
        }
      });
    }
  });

  describe("platform-db", () => {
    it("runs main's platform-db.ts for the env, passing its exit code", () => {
      const r = setup({ node: true }).run("platform-db");
      expect(r.code).toBe(0);
      expect(r.log).toContain(
        `node --experimental-strip-types --no-warnings ${join(root, "scripts/ops/platform-db.ts")} prod`,
      );
      expect(r.out).toContain("prod platform-db: deployed and verified");
      const bad = setup({ node: true }).run("platform-db", { NODE_EXIT: "1" });
      expect(bad.code).toBe(1);
      expect(bad.out).not.toContain("verified");
    });
  });

  describe("billing (staging only)", () => {
    const stg = (opts: Parameters<typeof setup>[0] = {}) =>
      setup({ node: "billing", ...opts });
    const BAD = (r: { log: string[]; err: string }) => {
      // Nothing was deployed, set or migrated.
      expect(noDeploy(r.log)).toEqual([]);
      expect(
        r.log.filter((l) => l.startsWith("node") && l.includes("billing-db")),
      ).toEqual([]);
    };

    it("prod refuses before anything: no Cloudflare call, no wrapper, no secret", () => {
      for (const VERIFY_ONLY of ["", "1"]) {
        const r = setup({ node: "billing" }).run(
          "billing",
          { VERIFY_ONLY },
          "prod",
        );
        expect(r.code, VERIFY_ONLY).toBe(2);
        expect(r.err).toContain("billing target is staging only");
        expect(
          r.log.filter((l) => /^(pnpm|wrapper|curl|node) /.test(l)),
        ).toEqual([]);
        clean(r);
      }
    });

    it("migrates the D1 first, deploys with its ids and the four prices, puts both secrets, deploys again, then verifies", () => {
      const r = stg().run("billing", {}, "staging");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      // The schema before the Worker.
      const order = r.log.filter((l) =>
        /^(node .*billing-db|wrapper|stdin-len)/.test(l),
      );
      expect(order[0]).toBe(
        `node --experimental-strip-types --no-warnings ${join(root, "scripts/ops/billing-db.ts")} staging`,
      );
      expect(order.slice(1).map((l) => l.split(" ")[0])).toEqual([
        "wrapper",
        "stdin-len",
        "stdin-len",
        "wrapper",
      ]);
      const w = r.log.filter((l) => l.startsWith("wrapper billing staging "));
      expect(w).toHaveLength(2);
      expect(w[0]).toContain(`bdb=${BDB}`);
      expect(w[0]).toContain(`reg=${REG}`);
      expect(puts(r.log)).toEqual([
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
      ]);
      expect(r.out).toContain("staging billing: deployed and verified");
      clean(r);
    });

    it("a run without the Stripe key, the webhook secret or a price fails clearly before anything is migrated, deployed or put", () => {
      for (const k of [
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        ...Object.keys(PRICES),
        "BILLING_DB_ID",
        "MAIN_BILLING_MIGRATION_LOCK",
      ])
        for (const v of ["", "unset"]) {
          const env: Record<string, string> = { [k]: "" };
          const r = stg().run("billing", env, "staging");
          expect(r.code, `${k} ${v}`).toBe(2);
          expect(r.err).toContain(`${k} is required for billing`);
          BAD(r);
          expect(puts(r.log)).toEqual([]);
          clean(r);
        }
    });

    it("a live key, a non-test key or a malformed secret or price is refused without printing it", () => {
      for (const [k, v, want] of [
        ["STRIPE_SECRET_KEY", "sk_live_abcdefgh12345678", "test-mode key"],
        ["STRIPE_SECRET_KEY", "rk_live_abcdefgh12345678", "test-mode key"],
        ["STRIPE_SECRET_KEY", "pk_test_abcdefgh12345678", "test-mode key"],
        ["STRIPE_SECRET_KEY", "sk_test_short", "test-mode key"],
        [
          "STRIPE_WEBHOOK_SECRET",
          "NEVERAPPEARnoprefix0123456789",
          "signing secret",
        ],
        ["STRIPE_PRICE_TEAM", "prod_1Abc", "price id"],
        ["STRIPE_PRICE_SOLO_YEARLY", "price_1 Abc", "price id"],
      ] as const) {
        const r = stg().run("billing", { [k]: v }, "staging");
        expect(r.code, `${k}=${v}`).toBe(2);
        expect(r.err).toContain(want);
        BAD(r);
        expect([r.out, r.err, ...r.log].join("\n")).not.toContain(v);
      }
    });

    it("a migration that fails stops the run before the Worker is deployed", () => {
      const r = stg().run("billing", { NODE_EXIT: "1" }, "staging");
      expect(r.code).toBe(1);
      expect(r.log.filter((l) => l.startsWith("wrapper"))).toEqual([]);
      expect(puts(r.log)).toEqual([]);
    });

    it("verify only: migrations are only verified, nothing deployed or put, no secret needed, every check runs", () => {
      const env = {
        VERIFY_ONLY: "1",
        STRIPE_SECRET_KEY: "",
        STRIPE_WEBHOOK_SECRET: "",
      };
      const s = stg({
        exists: ["oa-s-billing"],
        secrets: {
          "oa-s-billing": ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
        },
      });
      const r = s.run("billing", env, "staging");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(noDeploy(r.log)).toEqual([]);
      expect(puts(r.log)).toEqual([]);
      expect(r.log.filter((l) => l.includes("billing-db"))).toHaveLength(1);
      expect(r.out).toContain("staging billing: verified (verify only)");
    });

    it("the read-back refuses a wrong D1, registry, var or price, an extra or missing secret, and a wrong schedule", () => {
      const live = (mut: (b: Record<string, unknown>[]) => void) => {
        const b = JSON.parse(NEXT["oa-s-billing"] as string).result.bindings;
        mut(b);
        return settingsOff(b);
      };
      for (const [why, next, want] of [
        [
          "D1",
          live((b) => {
            (b[0] as { id: string }).id = DB;
          }),
          "BILLING_DB: got",
        ],
        [
          "registry",
          live((b) => {
            (b[1] as { namespace_id: string }).namespace_id = DIRREG;
          }),
          "BROKER_REGISTRY: got",
        ],
        [
          "price",
          live((b) => {
            (
              b.find((x) => x.name === "STRIPE_PRICE_TEAM") as { text: string }
            ).text = "price_1Other";
          }),
          "billing vars: got",
        ],
        [
          "extra binding",
          live((b) => {
            b.push({
              type: "kv_namespace",
              name: "HOSTS",
              namespace_id: HOSTS,
            });
          }),
          "bindings: got",
        ],
      ] as const) {
        const s = stg({ next: { "oa-s-billing": next } });
        const r = s.run("billing", {}, "staging");
        expect(r.code, why).toBe(1);
        expect(r.err, why).toContain(want);
      }
      const extra = stg({ secrets: { "oa-s-billing": ["EXTRA_SECRET"] } }).run(
        "billing",
        {},
        "staging",
      );
      expect(extra.code).toBe(1);
      expect(extra.err).toContain("oa-s-billing secrets are");
      const sched = stg();
      writeFileSync(
        join(sched.state, "oa-s-billing.schedules.json"),
        JSON.stringify({
          success: true,
          result: { schedules: [{ cron: "*/5 * * * *" }] },
        }),
      );
      const bad = sched.run("billing", {}, "staging");
      expect(bad.code).toBe(1);
      expect(bad.err).toContain("oa-s-billing schedules are");
    });
  });

  describe("provision-token", () => {
    const secret = (over: Record<string, unknown> = {}) =>
      JSON.stringify([
        {
          id: "x",
          name: "oa-p-provision-token",
          modified: "2026-10-30T10:00:00Z",
          ...over,
        },
      ]);
    it("reads back the secret's name and modified time, and writes nothing", () => {
      for (const verify of ["", "1"]) {
        const r = setup({ files: { "store-secrets.json": secret() } }).run(
          "provision-token",
          { VERIFY_ONLY: verify },
        );
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        expect(r.out).toContain(
          "oa-p-provision-token: present in Secrets Store, modified 2026-10-30T10:00:00Z",
        );
        expect(r.writes).toEqual([]);
        expect(r.log.filter((l) => /^(pnpm|wrapper) /.test(l))).toEqual([]);
        expect(
          r.log.some((l) =>
            l.includes(
              `/secrets_store/stores/${STORE}/secrets?search=oa-p-provision-token&`,
            ),
          ),
        ).toBe(true);
        clean(r);
      }
    });
    it("a missing secret fails with the Secrets Store link; a failed listing or a twin fails", () => {
      const none = setup().run("provision-token");
      expect(none.code).toBe(1);
      expect(none.err).toContain(
        "oa-p-provision-token is not in Secrets Store",
      );
      expect(none.err).toContain(
        "https://dash.cloudflare.com/?to=/:account/secrets-store",
      );
      // Another env's secret is not this one.
      expect(
        setup({
          files: {
            "store-secrets.json": secret({ name: "oa-s-provision-token" }),
          },
        }).run("provision-token").code,
      ).toBe(1);
      const failed = setup({ files: { "fail-store": "" } }).run(
        "provision-token",
      );
      expect(failed.code).toBe(1);
      expect(failed.err).toContain("list Secrets Store secrets failed");
      const two = JSON.stringify([
        ...JSON.parse(secret()),
        ...JSON.parse(secret()),
      ]);
      expect(
        setup({ files: { "store-secrets.json": two } }).run("provision-token")
          .code,
      ).toBe(1);
    });
  });

  describe("provisioner", () => {
    const ready = {
      "queues.json": JSON.stringify([
        { queue_name: "oa-p-signups" },
        { queue_name: "oa-p-signups-dlq" },
      ]),
      "r2-oa-p-releases": "",
    };
    it("first run: creates the queues and the releases bucket, deploys, reads every binding back", () => {
      const r = setup({ queues: queueList([]) }).run("provisioner");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.writes).toEqual([
        'WRITE POST /queues {"queue_name":"oa-p-signups"}',
        'WRITE POST /queues {"queue_name":"oa-p-signups-dlq"}',
        'WRITE POST /r2/buckets {"name":"oa-p-releases"}',
      ]);
      const w = r.log.find((l) => l.startsWith("wrapper provisioner prod "));
      expect(w).toContain(`db=${DB}`);
      expect(r.out).toContain("prod provisioner: deployed and verified");
      clean(r);
    });
    it("a rerun creates nothing; verify only refuses a missing queue and writes nothing", () => {
      const again = setup({ files: ready }).run("provisioner");
      expect(again.code, again.err).toBe(0);
      expect(again.writes).toEqual([]);
      const v = setup({
        exists: ["oa-p-provisioner"],
        queues: queueList([]),
      }).run("provisioner", {
        VERIFY_ONLY: "1",
      });
      expect(v.code).toBe(1);
      expect(v.err).toContain("queue oa-p-signups does not exist");
      expect(v.writes).toEqual([]);
    });
    it("a failed queue or bucket read stops before any create or deploy", () => {
      for (const f of ["fail-queues", "fail-r2"]) {
        const r = setup({ files: { [f]: "" } }).run("provisioner");
        expect(r.code, f).toBe(1);
        expect(r.writes.filter((w) => w.includes("/r2/buckets "))).toEqual([]);
        expect(r.log.some((l) => l.startsWith("wrapper"))).toBe(false);
      }
    });
    it("refuses a deployed binding, var or secret that isn't the committed one", () => {
      const base = NEXT["oa-p-provisioner"] as string;
      for (const [label, next, msg] of [
        ["store", base.replace(STORE, "f".repeat(32)), "PROVISION_TOKEN: got"],
        [
          "workflow",
          base.replace("oa-p-manage-install", "oa-p-other"),
          "MANAGE_INSTALL: got",
        ],
        [
          "var",
          base.replace('"text":"20"', '"text":"21"'),
          "provisioner vars: got",
        ],
        [
          "extra",
          settings([
            ...JSON.parse(base).result.bindings,
            { type: "kv_namespace", name: "X", namespace_id: "y" },
          ]),
          "bindings: got",
        ],
        [
          "observability",
          settings(JSON.parse(base).result.bindings, false),
          "observability",
        ],
        [
          "invocation logs missing",
          settings(JSON.parse(base).result.bindings, true, null),
          "observability invocation_logs",
        ],
        [
          "invocation logs",
          settings(JSON.parse(base).result.bindings, true, true),
          "observability invocation_logs",
        ],
      ] as const) {
        const r = setup({
          files: ready,
          next: { "oa-p-provisioner": next },
        }).run("provisioner");
        expect(r.code, label).toBe(1);
        expect(r.err, label).toContain(msg);
      }
      const sec = setup({
        files: ready,
        secrets: { "oa-p-provisioner": ["LEAK"] },
      }).run("provisioner");
      expect(sec.code).toBe(1);
      expect(sec.err).toContain("oa-p-provisioner has secrets 'LEAK '");
    });
  });

  describe("provisioning", () => {
    const KEY = "install:i000000admin";
    const brokers = ["oa-p-provisioner", "oa-p-auth-broker"];
    const entry = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        installId: "i000000admin",
        origin: "https://admin.open-artifacts.app",
        keys: [{ kid: "k".repeat(16), x: "x".repeat(43) }],
        domains: [],
        ...over,
      });
    const live = {
      "kvns.json": JSON.stringify([
        { id: OAUTH, title: "oa-p-provisioning-oauth" },
      ]),
      [`kv-${REG}-${KEY}`]: entry(),
    };
    const liveSecrets = {
      "oa-p-provisioning": [
        "ADMIN_BROKER_KEY",
        "ADMIN_IDENTITIES",
        "ADMIN_SESSION_KEY",
      ],
    };
    it("first run: builds the SPA, creates the OAuth KV, deploys, makes both keys and the admin entry, reads back", () => {
      const r = setup({ exists: brokers }).run("provisioning");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      // One build, by the Worker's dependency closure: @oa/admin is its
      // devDependency, so it builds too, straight into dist-assets (no copy).
      const build = r.log.indexOf("pnpm --filter @oa/provisioning... build");
      expect(r.log.filter((l) => l.startsWith("pnpm --filter"))).toEqual([
        "pnpm --filter @oa/provisioning... build",
      ]);
      expect(
        JSON.parse(
          readFileSync(join(root, "apps/provisioning/package.json"), "utf8"),
        ).devDependencies["@oa/admin"],
      ).toBe("workspace:*");
      expect(
        readFileSync(
          join(root, "scripts/ops/deploy-hosted-platform.sh"),
          "utf8",
        ),
      ).not.toMatch(/\bcp\b[^\n]*dist-assets/);
      const wrap = r.log.findIndex((l) =>
        l.startsWith("wrapper provisioning prod "),
      );
      expect(build).toBeGreaterThanOrEqual(0);
      expect(build).toBeLessThan(wrap);
      expect(r.writes[0]).toBe(
        'WRITE POST /storage/kv/namespaces {"title":"oa-p-provisioning-oauth"}',
      );
      // The entry carries only the public half, and is written before the secret.
      const put = r.writes.find((w) =>
        w.startsWith(`WRITE PUT /storage/kv/namespaces/${REG}/values/${KEY} `),
      ) as string;
      const body = JSON.parse(put.slice(put.indexOf("{")));
      expect(Object.keys(body)).toEqual([
        "installId",
        "origin",
        "keys",
        "domains",
      ]);
      expect(body).toMatchObject({
        installId: "i000000admin",
        origin: "https://admin.open-artifacts.app",
        domains: [],
      });
      expect(Object.keys(body.keys[0])).toEqual(["kid", "x"]);
      expect(r.writes).toHaveLength(2);
      expect(puts(r.log)).toEqual([
        "ADMIN_SESSION_KEY",
        "ADMIN_BROKER_KEY",
        "ADMIN_IDENTITIES",
      ]);
      expect(
        r.log.indexOf(put) <
          r.log.findIndex(
            (l) =>
              l === "stdin-len ADMIN_BROKER_KEY" ||
              l.startsWith("stdin-len ADMIN_BROKER_KEY "),
          ),
      ).toBe(true);
      // An Ed25519 pkcs8 (base64url) never shows.
      expect([r.out, r.err, ...r.log].join("\n")).not.toContain(
        "MC4CAQAwBQYDK2Vw",
      );
      expect(r.out).toContain("prod provisioning: deployed and verified");
      clean(r);
    });
    it("prod sign-up steps are off by default: PROD_SIGNUP_DEPLOY unset, empty or anything but exactly on leaves no entry, key or sitekey (#40)", () => {
      for (const extra of [
        {},
        { PROD_SIGNUP_DEPLOY: "" },
        { PROD_SIGNUP_DEPLOY: "off" },
        { PROD_SIGNUP_DEPLOY: "1" },
        { PROD_SIGNUP_DEPLOY: "ON" },
      ] as Record<string, string>[]) {
        const r = setup({ exists: brokers }).run("provisioning", extra);
        expect(r.code, r.err).toBe(0);
        expect(r.writes.some((w) => w.includes("i00000signup"))).toBe(false);
        expect(puts(r.log)).toEqual([
          "ADMIN_SESSION_KEY",
          "ADMIN_BROKER_KEY",
          "ADMIN_IDENTITIES",
        ]);
        expect(r.out).toContain("no SIGNUP_BROKER_KEY on prod");
      }
    });
    it("PROD_SIGNUP_DEPLOY=on: prod does what staging does, with the oa-p-turnstile sitekey (#40)", () => {
      const r = setup({
        exists: brokers,
        files: {
          "widgets.json": JSON.stringify([
            { name: "oa-s-turnstile", sitekey: "0xSTAGING" },
            { name: "oa-p-turnstile", sitekey: "0x4AAAAAAAprod_key-1" },
          ]),
        },
      }).run("provisioning", { PROD_SIGNUP_DEPLOY: "on" });
      expect(r.code, r.err).toBe(0);
      const sp = r.writes.find((w) =>
        w.includes("/values/install:i00000signup "),
      ) as string;
      expect(sp).toContain('"installId":"i00000signup"');
      expect(sp).toContain('"origin":"https://signup.open-artifacts.app"');
      expect(puts(r.log)).toEqual([
        "ADMIN_SESSION_KEY",
        "ADMIN_BROKER_KEY",
        "ADMIN_IDENTITIES",
        "SIGNUP_BROKER_KEY",
        "TURNSTILE_SITEKEY",
      ]);
      expect(r.out).toContain("prod provisioning: deployed and verified");
      clean(r);
    });
    describe("signup_deploy off after on: each leftover fails closed, names its removal, deletes nothing (#40)", () => {
      const SKEY = "install:i00000signup";
      const signupEntry = JSON.stringify({
        installId: "i00000signup",
        origin: "https://signup.open-artifacts.app",
        keys: [{ kid: "k".repeat(16), x: "x".repeat(43) }],
        domains: [],
      });
      const cases: [
        string,
        Record<string, string>,
        string[],
        string,
        string,
      ][] = [
        [
          "the SIGNUP_BROKER_KEY secret",
          live,
          [...liveSecrets["oa-p-provisioning"], "SIGNUP_BROKER_KEY"],
          "wrangler secret delete SIGNUP_BROKER_KEY --name oa-p-provisioning",
          SKEY,
        ],
        [
          "the install:i00000signup registry entry",
          { ...live, [`kv-${REG}-${SKEY}`]: signupEntry },
          liveSecrets["oa-p-provisioning"],
          `wrangler kv key delete ${SKEY} --namespace-id ${REG}`,
          "SIGNUP_BROKER_KEY on",
        ],
      ];
      for (const [name, files, secrets, hint, other] of cases) {
        for (const extra of [{}, { VERIFY_ONLY: "1" }] as Record<
          string,
          string
        >[]) {
          it(`${name}${extra.VERIFY_ONLY ? " (verify only)" : ""}`, () => {
            const r = setup({
              exists: [...brokers, "oa-p-provisioning"],
              files,
              secrets: { "oa-p-provisioning": secrets },
            }).run("provisioning", { PROD_SIGNUP_DEPLOY: "off", ...extra });
            expect(r.code).toBe(1);
            expect(r.err).toContain("signup_deploy is off");
            expect(r.err).toContain(hint);
            expect(r.err).not.toContain(other);
            expect(r.writes).toEqual([]);
            expect(r.log.some((l) => l.startsWith("wrapper "))).toBe(false);
            expect(puts(r.log)).toEqual([]);
          });
        }
      }
      it("both at once are both named", () => {
        const r = setup({
          exists: [...brokers, "oa-p-provisioning"],
          files: { ...live, [`kv-${REG}-${SKEY}`]: signupEntry },
          secrets: {
            "oa-p-provisioning": [
              ...liveSecrets["oa-p-provisioning"],
              "SIGNUP_BROKER_KEY",
            ],
          },
        }).run("provisioning", { PROD_SIGNUP_DEPLOY: "off" });
        expect(r.code).toBe(1);
        expect(r.err).toContain("wrangler secret delete SIGNUP_BROKER_KEY");
        expect(r.err).toContain("wrangler kv key delete");
      });
    });
    it("a rerun writes nothing but the admin list; a missing entry gets a new key, entry first", () => {
      const again = setup({
        exists: brokers,
        files: live,
        secrets: liveSecrets,
      }).run("provisioning");
      expect(again.err).toBe("");
      expect(again.code).toBe(0);
      expect(again.writes).toEqual([]);
      expect(puts(again.log)).toEqual(["ADMIN_IDENTITIES"]);
      const { [`kv-${REG}-${KEY}`]: _, ...noEntry } = live;
      const r = setup({
        exists: brokers,
        files: noEntry,
        secrets: liveSecrets,
      }).run("provisioning");
      expect(r.code, r.err).toBe(0);
      expect(r.writes.map((w) => w.split(" ").slice(0, 3).join(" "))).toEqual([
        `WRITE PUT /storage/kv/namespaces/${REG}/values/${KEY}`,
      ]);
      expect(puts(r.log)).toEqual(["ADMIN_BROKER_KEY", "ADMIN_IDENTITIES"]);
    });
    it("a failed ADMIN_BROKER_KEY put deletes the new entry, so the next run makes both again", () => {
      const { [`kv-${REG}-${KEY}`]: _, ...noEntry } = live;
      const s = setup({
        exists: brokers,
        files: { ...noEntry, "fail-put-ADMIN_BROKER_KEY": "" },
        secrets: liveSecrets,
      });
      const r = s.run("provisioning");
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${KEY} deleted, rerun to make both`);
      expect(r.writes.map((w) => w.split(" ").slice(0, 3).join(" "))).toEqual([
        `WRITE PUT /storage/kv/namespaces/${REG}/values/${KEY}`,
        `WRITE DELETE /storage/kv/namespaces/${REG}/values/${KEY}`,
      ]);
      rmSync(join(s.state, "fail-put-ADMIN_BROKER_KEY"));
      const again = s.run("provisioning");
      expect(again.code, again.err).toBe(0);
      expect(puts(again.log).slice(-2)).toEqual([
        "ADMIN_BROKER_KEY",
        "ADMIN_IDENTITIES",
      ]);
    });
    it("refuses until the provisioner and the auth broker exist", () => {
      const r = setup({ exists: ["oa-p-auth-broker"] }).run("provisioning");
      expect(r.code).toBe(1);
      expect(r.err).toContain("oa-p-provisioner does not exist");
      expect(r.writes).toEqual([]);
      expect(r.log.some((l) => l.startsWith("wrapper"))).toBe(false);
    });
    it("a failed KV listing stops before any create; two namespaces of the name refuse", () => {
      const f = setup({ exists: brokers, files: { "fail-kvns": "" } }).run(
        "provisioning",
      );
      expect(f.code).toBe(1);
      expect(f.err).toContain("list KV namespaces failed");
      expect(f.writes).toEqual([]);
      const two = setup({
        exists: brokers,
        files: {
          "kvns.json": JSON.stringify([
            { id: OAUTH, title: "oa-p-provisioning-oauth" },
            { id: "b".repeat(32), title: "oa-p-provisioning-oauth" },
          ]),
        },
      }).run("provisioning");
      expect(two.code).toBe(1);
      expect(two.err).toContain("want exactly one");
      expect(two.log.some((l) => l.startsWith("wrapper"))).toBe(false);
    });
    it("verify only: builds, creates and sets nothing, and still reads everything back", () => {
      const r = setup({
        exists: [...brokers, "oa-p-provisioning"],
        files: live,
        secrets: liveSecrets,
      }).run("provisioning", { VERIFY_ONLY: "1" });
      expect(r.code, r.err).toBe(0);
      expect(r.writes).toEqual([]);
      expect(r.log.filter((l) => /^(pnpm|wrapper) /.test(l))).toEqual([]);
      const none = setup({ exists: brokers }).run("provisioning", {
        VERIFY_ONLY: "1",
      });
      expect(none.code).toBe(1);
      expect(none.writes).toEqual([]);
    });
    // One test per case: each is a whole provisioning run.
    {
      const b = provisioningBindings();
      const swap = (name: string, over: Record<string, unknown>) =>
        settings(b.map((x) => (x.name === name ? { ...x, ...over } : x)));
      const cases: [string, Record<string, string>, string][] = [
        [
          "oauth kv",
          { next: swap("OAUTH_KV", { namespace_id: "f".repeat(32) }) },
          "OAUTH_KV: got",
        ],
        [
          "rate limit",
          {
            next: swap("RL_PV_OAUTH_IP", {
              simple: { limit: 999, period: 60 },
            }),
          },
          "rate limits: got",
        ],
        [
          "rate limit id",
          { next: swap("RL_PV_OAUTH_IP", { namespace_id: "1146" }) },
          "rate limits: got",
        ],
        [
          "admin-escape id (staging's on prod)",
          { next: swap("RL_PV_ADMIN_ESCAPE", { namespace_id: "1147" }) },
          "rate limits: got",
        ],
        [
          "token-write missing",
          {
            next: settings(b.filter((x) => x.name !== "RL_PV_TOKEN_WRITE")),
          },
          "rate limits: got",
        ],
        [
          "redirects",
          {
            next: swap("MCP_REDIRECT_URIS", {
              text: "https://evil.example/cb",
            }),
          },
          "provisioning vars: got",
        ],
        [
          "identities as a var (#1007: a secret only)",
          {
            next: settings([
              ...b,
              { type: "plain_text", name: "ADMIN_IDENTITIES", text: "a@b.c:1" },
            ]),
          },
          "provisioning vars: got",
        ],
        [
          "entrypoint",
          { next: swap("PROVISIONER", { entrypoint: "Other" }) },
          "PROVISIONER: got",
        ],
        [
          "prod oidc",
          {
            next: settings([
              ...b,
              { type: "plain_text", name: "OIDC_AUDIENCE", text: "x" },
            ]),
          },
          "prod oa-p-provisioning binds OIDC_AUDIENCE",
        ],
        [
          "test-users",
          { next: swap("SIGNUPS_ENABLED", { text: "test-users" }) },
          "SIGNUPS_ENABLED (test-users is staging only)",
        ],
        [
          "bundle",
          { content: "x; fetch('/auth/test-signin')" },
          "bundle contains test-signin",
        ],
        [
          "bundle read 403",
          { "fail-content": "" },
          "read oa-p-provisioning content failed (HTTP 403)",
        ],
        [
          "bundle read JSON",
          { content: '{"success":false,"errors":[]}' },
          "a JSON answer, not a bundle",
        ],
        [
          "directory",
          { [`kv-${DIRREG}-${KEY}`]: entry() },
          "is in oa-p-directory-registry",
        ],
        [
          "entry origin",
          { [`kv-${REG}-${KEY}`]: entry({ origin: "https://evil.example" }) },
          "is not the admin entry",
        ],
        [
          "entry domains",
          { [`kv-${REG}-${KEY}`]: entry({ domains: ["leourbina.com"] }) },
          "is not the admin entry",
        ],
        [
          "entry disabled",
          { [`kv-${REG}-${KEY}`]: entry({ disabled: true }) },
          "is not the admin entry",
        ],
      ];
      for (const [label, over, msg] of cases)
        it(`refuses a read-back that differs: ${label}`, () => {
          const { next, content, ...files } = over;
          const s = setup({
            exists: brokers,
            files: {
              ...live,
              ...files,
              ...(content ? { "oa-p-provisioning.content": content } : {}),
            },
            secrets: liveSecrets,
            ...(next ? { next: { "oa-p-provisioning": next } } : {}),
          });
          const r = s.run("provisioning");
          expect(r.code, label).toBe(1);
          expect(r.err, label).toContain(msg);
        });
    }
    it("prod refuses a tag that commits an OIDC var or test-users, before anything is deployed", () => {
      const PV = readFileSync(
        join(root, "apps/provisioning/wrangler.jsonc"),
        "utf8",
      );
      // Prod's (staging's is test-users since #1012).
      const at = PV.lastIndexOf('"SIGNUPS_ENABLED": "false",');
      expect(at).toBeGreaterThan(PV.indexOf('"prod": {'));
      expect(PV.indexOf('"prod": {')).toBeGreaterThan(0);
      const prodVar = (v: string) =>
        PV.slice(0, at) +
        v +
        PV.slice(at + '"SIGNUPS_ENABLED": "false",'.length);
      for (const [label, config, msg] of [
        [
          "oidc",
          prodVar('"SIGNUPS_ENABLED": "false", "OIDC_AUDIENCE": "x",'),
          "prod provisioning commits OIDC_AUDIENCE",
        ],
        [
          "test-users",
          prodVar('"SIGNUPS_ENABLED": "test-users",'),
          "commits SIGNUPS_ENABLED=test-users",
        ],
      ] as const) {
        const t = mkdtempSync(join(tmpdir(), "oa-hosted-tree-"));
        for (const f of ["deploy-hosted-platform.sh", "wrangler-env.ts"])
          write(
            join(t, "scripts/ops", f),
            readFileSync(join(root, "scripts/ops", f), "utf8"),
          );
        write(join(t, "apps/provisioning/wrangler.jsonc"), config);
        const s = setup({ exists: brokers, files: live, secrets: liveSecrets });
        const r = s.sb.run(
          [
            "bash",
            join(t, "scripts/ops/deploy-hosted-platform.sh"),
            "prod",
            "provisioning",
          ],
          {
            env: {
              ...ENV,
              STATE: s.state,
              DEPLOY_WRAPPER: wrapperStub(s.sb.dir),
              BROKER_PIN_FILE: "/dev/null",
            },
          },
        );
        expect(r.code, label).toBe(1);
        expect(r.err, label).toContain(msg);
        expect(
          s.sb.log().filter((l) => /^(pnpm|wrapper) /.test(l)),
          label,
        ).toEqual([]);
      }
    });
    // #1007: the admin allowlist is the deploy Environment's secret.
    describe("ADMIN_IDENTITIES", () => {
      const leaks = (r: { out: string; err: string; log: string[] }) =>
        [r.out, r.err, ...r.log].join("\n");
      it.each(["staging", "prod"])(
        "%s: refuses without it, before any build, write or deploy",
        (envName) => {
          for (const v of ["", " "]) {
            const r = setup({ exists: brokers }).run(
              "provisioning",
              { ADMIN_IDENTITIES: v },
              envName,
            );
            expect(r.code, JSON.stringify(v)).toBe(2);
            expect(r.err).toMatch(
              /ADMIN_IDENTITIES( is required for provisioning|: an entry is not email:sub)/,
            );
            expect(r.writes).toEqual([]);
            expect(puts(r.log)).toEqual([]);
            expect(r.log.filter((l) => /^(pnpm|wrapper) /.test(l))).toEqual([]);
          }
        },
      );
      it.each([
        ["no sub", "never-appear-a@example.com"],
        ["no email", ":111111"],
        [
          "a space",
          "never-appear-a@example.com:1, never-appear-b@example.com:2",
        ],
        ["an empty entry", "never-appear-a@example.com:1,,"],
        ["two colons", "never-appear-a@example.com:1:2"],
        ["no at", "never-appear-a.example.com:1"],
        ["a second line", "never-appear-a@example.com:1\nnever-appear-b@x.y:2"],
        [
          "a line after a comma",
          "never-appear-a@example.com:1,\nnever-appear-b@x.y:2",
        ],
        ["a carriage return", "never-appear-a@example.com:1\r"],
      ])("refuses a list with %s, never printing it", (_l, v) => {
        const r = setup({ exists: brokers }).run("provisioning", {
          ADMIN_IDENTITIES: v,
        });
        expect(r.code).toBe(2);
        expect(r.err).toContain("ADMIN_IDENTITIES");
        expect(leaks(r)).not.toContain("never-appear");
        expect(r.writes).toEqual([]);
        expect(puts(r.log)).toEqual([]);
      });
      it("is put on stdin on every deploy: never in argv, output or logs", () => {
        const r = setup({
          exists: brokers,
          files: live,
          secrets: liveSecrets,
        }).run("provisioning");
        expect(r.code, r.err).toBe(0);
        expect(r.log).toContain(`stdin-len ADMIN_IDENTITIES ${IDS.length}`);
        expect(leaks(r)).not.toContain("never-appear");
        expect(leaks(r)).not.toContain("111111");
      });
      it("refuses a tag that still commits ADMIN_IDENTITIES as a var, before any deploy", () => {
        const PV = readFileSync(
          join(root, "apps/provisioning/wrangler.jsonc"),
          "utf8",
        );
        const old = PV.replaceAll(
          '"OA_ENV": "',
          '"ADMIN_IDENTITIES": "", "OA_ENV": "',
        );
        expect(old).not.toBe(PV);
        for (const envName of ["staging", "prod"]) {
          const r = setup({
            exists: brokers,
            configs: { provisioning: old },
          }).run("provisioning", {}, envName);
          expect(r.code, envName).toBe(1);
          expect(r.err).toContain("this tag commits ADMIN_IDENTITIES as a var");
          expect(r.writes).toEqual([]);
          expect(r.log.filter((l) => /^(pnpm|wrapper) /.test(l))).toEqual([]);
        }
      });
      it("the read-back checks the secret by name only, and refuses when it is missing", () => {
        const script = readFileSync(SCRIPT, "utf8");
        // No call reads a secret's value; the list is only ever written.
        expect(script).not.toMatch(/secrets\/ADMIN_IDENTITIES/);
        expect(script.match(/\$ADMIN_IDENTITIES/g)).toHaveLength(3);
        const failed = setup({
          exists: brokers,
          files: { ...live, "fail-put-ADMIN_IDENTITIES": "" },
          secrets: {
            "oa-p-provisioning": ["ADMIN_BROKER_KEY", "ADMIN_SESSION_KEY"],
          },
        }).run("provisioning");
        expect(failed.code).toBe(1);
        expect(failed.err).toContain("putting ADMIN_IDENTITIES failed");
        const unset = setup({
          exists: [...brokers, "oa-p-provisioning"],
          files: live,
          secrets: {
            "oa-p-provisioning": ["ADMIN_BROKER_KEY", "ADMIN_SESSION_KEY"],
          },
        }).run("provisioning", { VERIFY_ONLY: "1" });
        expect(unset.code).toBe(1);
        expect(unset.err).toContain(
          "secrets are 'ADMIN_BROKER_KEY ADMIN_SESSION_KEY '",
        );
        expect(leaks(unset)).not.toContain("never-appear");
      });
    });
    it("refuses a secret it doesn't make", () => {
      const extra = setup({
        exists: brokers,
        files: live,
        secrets: {
          "oa-p-provisioning": [...liveSecrets["oa-p-provisioning"], "X"],
        },
      }).run("provisioning");
      expect(extra.code).toBe(1);
      expect(extra.err).toContain(
        "secrets are 'ADMIN_BROKER_KEY ADMIN_IDENTITIES ADMIN_SESSION_KEY X '",
      );
    });
    it("the read-back expects every committed rate limit, W5b's included", () => {
      const ids = (env: "staging" | "prod") =>
        Object.fromEntries(
          ratelimits(env).map((r) => [r.name, r.namespace_id]),
        );
      expect(ids("staging")).toMatchObject({
        RL_PV_ADMIN_ESCAPE: "1147",
        RL_PV_TOKEN_WRITE: "1148",
      });
      expect(ids("prod")).toMatchObject({
        RL_PV_ADMIN_ESCAPE: "1157",
        RL_PV_TOKEN_WRITE: "1158",
      });
    });
    it("staging: the staging names and OIDC vars, the staging admin origin", () => {
      const s = setup({
        // The staging tag declares BILLING (#66), so oa-s-billing must exist.
        exists: ["oa-s-provisioner", "oa-s-auth-broker", "oa-s-billing"],
        files: {
          "widgets.json": JSON.stringify([
            { name: "oa-s-turnstile", sitekey: "0x4AAAAAAAtest_key-1" },
          ]),
        },
        next: {
          "oa-s-provisioning": settings(provisioningBindings("s", "staging")),
        },
      });
      const r = s.run("provisioning", { NEW_KV: OAUTH }, "staging");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const put = r.writes.find((w) => w.includes(`/values/${KEY} `)) as string;
      expect(put).toContain(
        '"origin":"https://admin.open-artifacts-staging.app"',
      );
    });
    it("staging also makes the sign-up host's key and entry and puts the env's one Turnstile widget's sitekey; prod gets neither (#40)", () => {
      const exists = ["oa-s-provisioner", "oa-s-auth-broker", "oa-s-billing"];
      const next = {
        "oa-s-provisioning": settings(provisioningBindings("s", "staging")),
      };
      const widgets = (l: { name: string; sitekey: string }[]) => ({
        files: { "widgets.json": JSON.stringify(l) },
      });
      const r = setup({
        exists,
        next,
        ...widgets([
          { name: "other", sitekey: "0xOTHER" },
          { name: "oa-s-turnstile", sitekey: "0x4AAAAAAAtest_key-1" },
        ]),
      }).run("provisioning", { NEW_KV: OAUTH }, "staging");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const sp = r.writes.find((w) =>
        w.includes("/values/install:i00000signup "),
      ) as string;
      expect(sp).toContain('"installId":"i00000signup"');
      expect(sp).toContain(
        '"origin":"https://signup.open-artifacts-staging.app"',
      );
      expect(sp).toContain('"domains":[]');
      expect(puts(r.log)).toEqual([
        "ADMIN_SESSION_KEY",
        "ADMIN_BROKER_KEY",
        "ADMIN_IDENTITIES",
        "SIGNUP_BROKER_KEY",
        "TURNSTILE_SITEKEY",
      ]);
      // Zero or two widgets of that name: said, left unset, the deploy goes on.
      for (const l of [
        [],
        [
          { name: "oa-s-turnstile", sitekey: "0xA" },
          { name: "oa-s-turnstile", sitekey: "0xB" },
        ],
      ]) {
        const none = setup({ exists, next, ...widgets(l) }).run(
          "provisioning",
          { NEW_KV: OAUTH },
          "staging",
        );
        expect(none.code, none.err).toBe(0);
        expect(puts(none.log)).not.toContain("TURNSTILE_SITEKEY");
        expect(none.err).toContain("TURNSTILE_SITEKEY not set");
      }
    });
  });

  it("auth-broker: the Google secret only when given or absent", () => {
    const keep = setup({
      exists: ["oa-p-auth-broker"],
      secrets: {
        "oa-p-auth-broker": ["BROKER_STATE_KEY", "GOOGLE_CLIENT_SECRET"],
      },
    }).run("auth-broker", { GOOGLE_CLIENT_SECRET: "" });
    expect(keep.err).toBe("");
    expect(keep.code).toBe(0);
    expect(puts(keep.log)).toEqual([]);
    const absent = setup().run("auth-broker", { GOOGLE_CLIENT_SECRET: "" });
    expect(absent.code).toBe(1);
    expect(absent.err).toContain(
      "oa-p-auth-broker has no GOOGLE_CLIENT_SECRET",
    );
    expect(puts(absent.log)).toEqual([]);
    // Refused before the deploy: a new env never gets a broker without it,
    // nor does a live Worker that lost it.
    expect(absent.log.some((l) => l.startsWith("wrapper"))).toBe(false);
    const lost = setup({
      exists: ["oa-p-auth-broker"],
      secrets: { "oa-p-auth-broker": ["BROKER_STATE_KEY"] },
    }).run("auth-broker", { GOOGLE_CLIENT_SECRET: "" });
    expect(lost.code).toBe(1);
    expect(lost.log.some((l) => l.startsWith("wrapper"))).toBe(false);
  });

  it("a Worker that takes secrets deploys again after them, so the serving version is tagged (#1040)", () => {
    for (const [t, exists] of [
      ["auth-broker", []],
      ["directory-broker", []],
      ["provisioning", ["oa-p-provisioner", "oa-p-auth-broker"]],
    ] as const) {
      const r = setup({ exists: [...exists] }).run(t);
      expect(r.err, t).toBe("");
      expect(r.code, t).toBe(0);
      const wrappers = r.log.flatMap((l, i) =>
        l.startsWith("wrapper") ? [i] : [],
      );
      const lastPut = r.log.reduce(
        (m, l, i) => (l.startsWith("stdin-len") ? i : m),
        -1,
      );
      expect(wrappers.length, t).toBe(2);
      expect(lastPut, t).toBeGreaterThan(wrappers[0] as number);
      expect(wrappers[1], t).toBeGreaterThan(lastPut);
    }
  });

  it("directory-broker: the Google secret only when given or absent", () => {
    const keep = setup({
      exists: ["oa-p-directory-broker"],
      secrets: {
        "oa-p-directory-broker": [
          "DIRECTORY_STATE_KEY",
          "GOOGLE_DIRECTORY_CLIENT_SECRET",
        ],
      },
    }).run("directory-broker", { GOOGLE_DIRECTORY_CLIENT_SECRET: "" });
    expect(keep.err).toBe("");
    expect(keep.code).toBe(0);
    expect(puts(keep.log)).toEqual([]);
    const absent = setup().run("directory-broker", {
      GOOGLE_DIRECTORY_CLIENT_SECRET: "",
    });
    expect(absent.code).toBe(1);
    expect(absent.err).toContain(
      "oa-p-directory-broker has no GOOGLE_DIRECTORY_CLIENT_SECRET",
    );
    expect(puts(absent.log)).toEqual([]);
    expect(absent.log.some((l) => l.startsWith("wrapper"))).toBe(false);
    const lost = setup({
      exists: ["oa-p-directory-broker"],
      secrets: { "oa-p-directory-broker": ["DIRECTORY_STATE_KEY"] },
    }).run("directory-broker", { GOOGLE_DIRECTORY_CLIENT_SECRET: "" });
    expect(lost.code).toBe(1);
    expect(lost.log.some((l) => l.startsWith("wrapper"))).toBe(false);
  });

  describe("inventory read-back (6.3, the tag's committed OIDC vars)", () => {
    type Env = "staging" | "prod";
    const W8 = readFileSync(
      join(root, "scripts/ops/testdata/inventory-w8.wrangler.jsonc"),
      "utf8",
    );
    const REAL = readFileSync(
      join(root, "apps/inventory/wrangler.jsonc"),
      "utf8",
    );
    const commits = (src: string, env: Env) =>
      "OIDC_JOB_WORKFLOW_REFS" in
      committedVars(src, env, { GITHUB_REPOSITORY_ID: REPO_ID });
    // W8's config verbatim, and the repo's own once it commits the refs (W8
    // merged): the read-back's expectation comes from the config, never a
    // list of our own.
    const CONFIGS = [
      ["W8's config", W8],
      ...(commits(REAL, "prod") ? [["apps/inventory", REAL] as const] : []),
    ] as const;
    const varsFor = (src: string, env: Env) =>
      committedVars(src, env, { GITHUB_REPOSITORY_ID: REPO_ID });
    /** The repo's deploy script and wrangler-env.ts beside this inventory config. */
    const tree = (config: string) => {
      const t = mkdtempSync(join(tmpdir(), "oa-hosted-tree-"));
      for (const f of ["deploy-hosted-platform.sh", "wrangler-env.ts"])
        write(
          join(t, "scripts/ops", f),
          readFileSync(join(root, "scripts/ops", f), "utf8"),
        );
      write(join(t, "apps/inventory/wrangler.jsonc"), config);
      return join(t, "scripts/ops/deploy-hosted-platform.sh");
    };
    const deployed = (
      vars: Record<string, string>,
      extra: Record<string, unknown>[] = [],
    ) =>
      settings([
        { type: "d1", name: "PLATFORM_DB", id: DB },
        { type: "kv_namespace", name: "HOSTS", namespace_id: HOSTS },
        ...Object.entries(vars).map(([name, text]) => ({
          type: "plain_text",
          name,
          text,
        })),
        ...extra,
      ]);
    const go = (
      config: string,
      env: Env,
      next: string,
      opts: {
        secrets?: Record<string, string[]>;
        verifyOnly?: boolean;
        failDelete?: boolean;
      } = {},
    ) => {
      const w = `oa-${env[0]}-inventory`;
      const s = setup({
        next: { [w]: next },
        secrets: opts.secrets,
        // Verify only reads the live Worker: it already holds `next`.
        exists: opts.verifyOnly ? [w] : [],
        files: {
          ...(opts.verifyOnly ? { [`${w}.settings.json`]: next } : {}),
          ...(opts.failDelete ? { "fail-delete": "" } : {}),
        },
      });
      const r = s.sb.run(["bash", tree(config), env, "inventory"], {
        env: {
          ...ENV,
          VERIFY_ONLY: opts.verifyOnly ? "1" : "",
          GITHUB_REPOSITORY: varsFor(config, env).OIDC_REPOSITORY ?? "o/r",
          STATE: s.state,
          DEPLOY_WRAPPER: wrapperStub(s.sb.dir),
          BROKER_PIN_FILE: "/dev/null",
        },
      });
      return {
        ...r,
        deployedIt: s.sb.log().some((l) => l.startsWith("wrapper inventory")),
        writes: s.sb.log().filter((l) => l.startsWith("WRITE ")),
      };
    };

    for (const [label, config] of CONFIGS)
      for (const env of ["staging", "prod"] as const) {
        const VARS = varsFor(config, env);
        const refs = (VARS.OIDC_JOB_WORKFLOW_REFS as string).split(",");
        const repo = VARS.OIDC_REPOSITORY as string;
        const ref = (f: string, b = "main") =>
          `${repo}/.github/workflows/${f}@refs/heads/${b}`;

        it(`${label}, ${env}: the deployed vars equal the committed ones exactly`, () => {
          const ok = go(config, env, deployed(VARS));
          expect(ok.err).toBe("");
          expect(ok.code).toBe(0);
          // W8's refs as the Manager approved them (6.3 amended).
          const base =
            "open-artifacts-ai/open-artifacts-cloud/.github/workflows";
          expect(VARS.OIDC_JOB_WORKFLOW_REFS).toBe(
            env === "prod"
              ? `${base}/redline-staging.yml@refs/heads/main,${base}/prodclean-monitor.yml@refs/heads/main`
              : `${base}/redline-staging.yml@refs/heads/main`,
          );
          expect(VARS.OIDC_AUDIENCE).toBe(`https://oa-${env[0]}-inventory`);
          // The string the tag commits, exactly, even reordered.
          if (refs.length > 1) {
            const reordered = go(
              config,
              env,
              deployed({
                ...VARS,
                OIDC_JOB_WORKFLOW_REFS: [...refs].reverse().join(","),
              }),
            );
            expect(reordered.code).toBe(1);
            expect(reordered.err).toContain("OIDC_JOB_WORKFLOW_REFS: got");
          }
        });

        it(`${label}, ${env}: refuses a var that differs, a missing one, or any secret`, () => {
          for (const [what, next] of [
            ["repo id", deployed({ ...VARS, OIDC_REPOSITORY_ID: "1" })],
            [
              "missing",
              deployed({
                OIDC_AUDIENCE: VARS.OIDC_AUDIENCE as string,
                OIDC_REPOSITORY_ID: REPO_ID,
              }),
            ],
            [
              "secret",
              deployed(VARS, [{ type: "secret_text", name: "OTHER_KEY" }]),
            ],
            [
              "extra binding",
              deployed(VARS, [
                { type: "r2_bucket", name: "EXTRA", bucket_name: "x" },
              ]),
            ],
          ] as const) {
            const r = go(config, env, next);
            expect(r.code, what).toBe(1);
            expect(r.err, what).toMatch(
              /inventory vars: got|has secret bindings|bindings: got|OIDC_[A-Z_]+: got/,
            );
          }
        });

        it(`${label}, ${env}: refuses an OIDC value that isn't 6.3's or the tag's`, () => {
          // A 6.3 workflow the tag doesn't commit for this env, else any other.
          const other =
            [ref("prodclean-monitor.yml"), ref("redline-staging.yml")].find(
              (r) => !refs.includes(r),
            ) ?? ref("x.yml");
          for (const [what, vars, msg] of [
            [
              "audience",
              {
                OIDC_AUDIENCE: `https://oa-${env === "prod" ? "s" : "p"}-inventory`,
              },
              "OIDC_AUDIENCE",
            ],
            ["repository", { OIDC_REPOSITORY: "o/x" }, "OIDC_REPOSITORY"],
            [
              "environment",
              { OIDC_ENVIRONMENT: "hosted-prod-deploy" },
              "OIDC_ENVIRONMENT",
            ],
            [
              "short ref",
              { OIDC_JOB_WORKFLOW_REFS: "prodclean-monitor.yml" },
              "OIDC_JOB_WORKFLOW_REFS",
            ],
            [
              "branch",
              {
                OIDC_JOB_WORKFLOW_REFS: refs
                  .map((r) => r.replace("@refs/heads/main", "@refs/heads/dev"))
                  .join(","),
              },
              "OIDC_JOB_WORKFLOW_REFS",
            ],
            [
              "a ref the tag doesn't commit",
              { OIDC_JOB_WORKFLOW_REFS: [...refs, other].join(",") },
              "OIDC_JOB_WORKFLOW_REFS",
            ],
            [
              "one ref short",
              {
                OIDC_JOB_WORKFLOW_REFS:
                  refs.length > 1 ? refs.slice(1).join(",") : other,
              },
              "OIDC_JOB_WORKFLOW_REFS",
            ],
          ] as const) {
            const r = go(config, env, deployed({ ...VARS, ...vars }));
            expect(r.code, what).toBe(1);
            expect(r.err, what).toContain(`${msg}: got`);
          }
        });
      }

    it("refuses before deploying a tag whose committed refs aren't exactly W8's", () => {
      const prodRefs = varsFor(W8, "prod").OIDC_JOB_WORKFLOW_REFS as string;
      const stagingRefs = varsFor(W8, "staging")
        .OIDC_JOB_WORKFLOW_REFS as string;
      const repo = varsFor(W8, "prod").OIDC_REPOSITORY as string;
      const ref = (f: string) =>
        `${repo}/.github/workflows/${f}@refs/heads/main`;
      const swap = (from: string, to: string) => W8.replace(from, to);
      const differs = "committed OIDC_JOB_WORKFLOW_REFS is";
      for (const [what, config, env, msg] of [
        [
          "prod without the monitor",
          swap(prodRefs, ref("redline-staging.yml")),
          "prod",
          differs,
        ],
        [
          "prod without red-line",
          swap(prodRefs, ref("prodclean-monitor.yml")),
          "prod",
          differs,
        ],
        [
          "prod reordered",
          swap(prodRefs, prodRefs.split(",").reverse().join(",")),
          "prod",
          differs,
        ],
        [
          "staging with the monitor",
          swap(stagingRefs, `${stagingRefs},${ref("prodclean-monitor.yml")}`),
          "staging",
          differs,
        ],
        [
          "staging, the monitor instead",
          swap(stagingRefs, ref("prodclean-monitor.yml")),
          "staging",
          differs,
        ],
        [
          "another workflow",
          swap(prodRefs, `${prodRefs},${ref("x.yml")}`),
          "prod",
          differs,
        ],
        [
          "a branch ref",
          swap(
            prodRefs,
            prodRefs.replaceAll("refs/heads/main", "refs/heads/dev"),
          ),
          "prod",
          differs,
        ],
        [
          "no refs",
          swap(`"OIDC_JOB_WORKFLOW_REFS": "${prodRefs}",`, ""),
          "prod",
          "commits no OIDC_JOB_WORKFLOW_REFS",
        ],
      ] as const) {
        expect(config, what).not.toBe(W8);
        const r = go(config, env, deployed(varsFor(W8, env)));
        expect(r.code, what).toBe(1);
        expect(r.err, what).toContain(msg);
        expect(r.deployedIt, what).toBe(false);
      }
    });

    it("verify only refuses INVENTORY_KEY like any other secret, as a binding or a listed secret", () => {
      const VARS = varsFor(W8, "prod");
      const asBinding = go(
        W8,
        "prod",
        deployed(VARS, [{ type: "secret_text", name: "INVENTORY_KEY" }]),
        { verifyOnly: true },
      );
      expect(asBinding.code).toBe(1);
      expect(asBinding.err).toContain("has secret bindings (INVENTORY_KEY)");
      const listed = go(W8, "prod", deployed(VARS), {
        secrets: { "oa-p-inventory": ["INVENTORY_KEY"] },
        verifyOnly: true,
      });
      expect(listed.code).toBe(1);
      expect(listed.err).toContain("has secrets 'INVENTORY_KEY '");
      expect(listed.writes).toEqual([]);
    });

    // Run 41267716910: staging's inventory still had the retired key.
    it("staging: a deploy deletes the retired INVENTORY_KEY, then verifies", () => {
      const r = go(
        W8,
        "staging",
        deployed(varsFor(W8, "staging"), [
          { type: "secret_text", name: "INVENTORY_KEY" },
        ]),
        { secrets: { "oa-s-inventory": ["INVENTORY_KEY"] } },
      );
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.writes).toEqual([
        "WRITE DELETE /workers/scripts/oa-s-inventory/secrets/INVENTORY_KEY ",
      ]);
      expect(r.out).toContain("oa-s-inventory: retired INVENTORY_KEY deleted");
      expect(r.out).toContain("staging inventory: deployed and verified");
    });

    it("prod: a deploy never deletes a secret; INVENTORY_KEY still stops it (#968)", () => {
      const r = go(W8, "prod", deployed(varsFor(W8, "prod")), {
        secrets: { "oa-p-inventory": ["INVENTORY_KEY"] },
      });
      expect(r.code).toBe(1);
      expect(r.writes).toEqual([]);
      expect(r.err).toContain("has secrets 'INVENTORY_KEY '");
    });

    it("staging deletes only INVENTORY_KEY: any other secret still stops it", () => {
      const r = go(W8, "staging", deployed(varsFor(W8, "staging")), {
        secrets: { "oa-s-inventory": ["INVENTORY_KEY", "LEAK"] },
      });
      expect(r.code).toBe(1);
      expect(r.writes).toEqual([
        "WRITE DELETE /workers/scripts/oa-s-inventory/secrets/INVENTORY_KEY ",
      ]);
      expect(r.err).toContain("has secrets 'LEAK '");
    });

    it("a failed delete stops the deploy", () => {
      // The listing names it but the delete is refused: no "deleted" line.
      const r = go(W8, "staging", deployed(varsFor(W8, "staging")), {
        secrets: { "oa-s-inventory": ["INVENTORY_KEY"] },
        failDelete: true,
      });
      expect(r.code).toBe(1);
      expect(r.err).toContain("delete oa-s-inventory INVENTORY_KEY failed");
      expect(r.out).not.toContain("retired INVENTORY_KEY deleted");
    });
  });
});

// The wrapper runs `pnpm exec wrangler` in apps/<app>, so every app the
// script deploys must have wrangler as its own dependency: run 41262364898
// stopped at inventory on "Command "wrangler" not found".
describe("every deployed app has its own wrangler", () => {
  const script = readFileSync(
    join(root, "scripts/ops/deploy-hosted-platform.sh"),
    "utf8",
  );
  const apps = [
    ...new Set([...script.matchAll(/\bdeploy ([a-z-]+)$/gm)].map((m) => m[1])),
  ];
  it("finds the deployed apps", () => {
    expect(apps).toEqual(
      expect.arrayContaining(["inventory", "provisioner", "scheduler"]),
    );
  });
  for (const app of apps) {
    it(`apps/${app} depends on wrangler`, () => {
      const pkg = JSON.parse(
        readFileSync(join(root, "apps", app as string, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(
        pkg.devDependencies?.wrangler ?? pkg.dependencies?.wrangler,
      ).toBeTruthy();
    });
  }
});

// #1343: the canary smoke's secrets, smoke's PAT and the share target's address,
// reach the scheduler only: put on oa-<p>-scheduler when the Environment has
// them, never printed, never on any other Worker.
describe("the canary smoke's secrets (#1343)", () => {
  const PAT = "oat_smokeA_never_printed_0123456789";
  const TO = "target@example.test";
  const SMOKE = { FLEET_SMOKE_TOKEN: PAT, FLEET_SMOKE_SHARE_TO: TO };
  const hidden = (r: { out: string; err: string; log: string[] }) => {
    const all = [r.out, r.err, ...r.log].join("\n");
    for (const s of [PAT, TO]) expect(all).not.toContain(s);
  };

  it("given: both put on the scheduler, then a second deploy tags the serving version", () => {
    const r = setup({ exists: SCHED_DEPS("p") }).run("scheduler", SMOKE);
    expect(r.code, r.err).toBe(0);
    expect(puts(r.log)).toEqual(["FLEET_SMOKE_TOKEN", "FLEET_SMOKE_SHARE_TO"]);
    expect(r.log).toContain(`stdin-len FLEET_SMOKE_TOKEN ${PAT.length}`);
    expect(r.log).toContain(`stdin-len FLEET_SMOKE_SHARE_TO ${TO.length}`);
    const wrappers = r.log.flatMap((l, i) =>
      l.startsWith("wrapper") ? [i] : [],
    );
    const lastPut = r.log.reduce(
      (m, l, i) => (l.startsWith("stdin-len") ? i : m),
      -1,
    );
    expect(wrappers).toHaveLength(2);
    expect(wrappers[1]).toBeGreaterThan(lastPut);
    hidden(r);
    clean(r);
  });

  // #55: run 42647320740's put failed after the tagged deploy and the run went
  // red. The order stays deploy, puts, deploy (#1040: a put makes an untagged
  // version, and the chain reads the scheduler's tag, so it may never be left
  // untagged): a put that still fails after its retries is followed by the
  // last tagged deploy anyway, and then the run is red.
  describe("the smoke secrets' retry and the last tagged deploy (#55)", () => {
    const wrappers = (log: string[]) =>
      log.flatMap((l, i) => (l.startsWith("wrapper") ? [i] : []));
    const lastPut = (log: string[]) =>
      log.reduce((m, l, i) => (l.startsWith("stdin-len") ? i : m), -1);
    const live = () => ({ exists: SCHED_DEPS("p") });

    it("one transient put failure is retried: the second try succeeds and the run goes on", () => {
      const r = setup({
        ...live(),
        files: { "fail-put-once-FLEET_SMOKE_TOKEN": "" },
      }).run("scheduler", SMOKE);
      expect(r.code, r.err).toBe(0);
      expect(puts(r.log)).toEqual([
        "FLEET_SMOKE_TOKEN",
        "FLEET_SMOKE_TOKEN",
        "FLEET_SMOKE_SHARE_TO",
      ]);
      // Every try carried the whole value.
      expect(
        r.log.filter((l) => l === `stdin-len FLEET_SMOKE_TOKEN ${PAT.length}`),
      ).toHaveLength(2);
      expect(wrappers(r.log)).toHaveLength(2);
      hidden(r);
    });

    it("put 1 ok, put 2 fails every try: the last tagged deploy still runs, then the run is red", () => {
      const r = setup({
        ...live(),
        files: { "fail-put-FLEET_SMOKE_SHARE_TO": "" },
      }).run("scheduler", SMOKE);
      expect(r.code).toBe(1);
      expect(puts(r.log)).toEqual([
        "FLEET_SMOKE_TOKEN",
        "FLEET_SMOKE_SHARE_TO",
        "FLEET_SMOKE_SHARE_TO",
        "FLEET_SMOKE_SHARE_TO",
      ]);
      const w = wrappers(r.log);
      expect(w).toHaveLength(2);
      expect(w[1]).toBeGreaterThan(lastPut(r.log));
      expect(r.err).toContain(
        "putting FLEET_SMOKE_SHARE_TO failed (attempt 1 of 3)",
      );
      expect(r.err).toContain(
        "putting FLEET_SMOKE_SHARE_TO failed; the tagged deploy ran again, so the scheduler serves the tag, and the run stays red",
      );
      hidden(r);
    });

    it("all puts ok, the last deploy fails: three bounded tries, then red, naming it", () => {
      const r = setup({
        ...live(),
        files: { "fail-wrapper-from": "2" },
      }).run("scheduler", SMOKE);
      expect(r.code).toBe(1);
      // The first deploy, then three tries of the last one.
      expect(wrappers(r.log)).toHaveLength(4);
      expect(r.err).toContain(
        "the tagged deploy after the secrets failed (attempt 2 of 3)",
      );
      expect(r.err).toContain(
        "the tagged deploy after the secrets failed: the scheduler may serve an untagged version",
      );
      hidden(r);
    });

    it("a last deploy that fails once is retried and the run is green", () => {
      const r = setup({
        ...live(),
        files: { "fail-wrapper-at": "2" },
      }).run("scheduler", SMOKE);
      expect(r.code, r.err).toBe(0);
      expect(wrappers(r.log)).toHaveLength(3);
    });

    it("a put and the last deploy both fail: both are named, the run is red", () => {
      const r = setup({
        ...live(),
        files: {
          "fail-put-FLEET_SMOKE_TOKEN": "",
          "fail-wrapper-from": "2",
        },
      }).run("scheduler", SMOKE);
      expect(r.code).toBe(1);
      expect(wrappers(r.log)).toHaveLength(4);
      expect(r.err).toContain(
        "oa-p-scheduler: putting FLEET_SMOKE_TOKEN failed\n",
      );
      expect(r.err).toContain(
        "putting FLEET_SMOKE_TOKEN failed, and the tagged deploy after it failed too: the scheduler may serve an untagged version",
      );
      hidden(r);
    });

    it("a bad PUT_RETRY_SLEEP is refused before any deploy or put", () => {
      const r = setup(live()).run("scheduler", {
        ...SMOKE,
        PUT_RETRY_SLEEP: "soon",
      });
      expect(r.code).toBe(1);
      expect(r.err).toContain("PUT_RETRY_SLEEP must be 0 to 999 seconds");
      expect(noDeploy(r.log)).toEqual([]);
    });
  });

  it("absent: nothing put, one deploy (the smoke then reports itself unconfigured)", () => {
    const r = setup({ exists: SCHED_DEPS("p") }).run("scheduler");
    expect(r.code, r.err).toBe(0);
    expect(puts(r.log)).toEqual([]);
    expect(r.log.filter((l) => l.startsWith("wrapper"))).toHaveLength(1);
  });

  it("verify only: nothing put or deployed", () => {
    const sv = setup({ exists: SCHED_DEPS("p") });
    writeFileSync(join(sv.state, "oa-p-scheduler.exists"), "");
    writeFileSync(
      join(sv.state, "oa-p-scheduler.settings.json"),
      NEXT["oa-p-scheduler"] as string,
    );
    const r = sv.run("scheduler", {
      ...SMOKE,
      VERIFY_ONLY: "1",
    });
    expect(r.code, r.err).toBe(0);
    expect(puts(r.log)).toEqual([]);
    expect(noDeploy(r.log)).toEqual([]);
    hidden(r);
  });

  it("malformed: refused before any deploy, without printing the value", () => {
    for (const [k, v] of [
      ["FLEET_SMOKE_TOKEN", "short"],
      ["FLEET_SMOKE_TOKEN", `${PAT} x`],
      ["FLEET_SMOKE_SHARE_TO", "Target@Example.test"],
      ["FLEET_SMOKE_SHARE_TO", `${TO},other@example.test`],
      ["FLEET_SMOKE_SHARE_TO", "not-an-address"],
    ] as const) {
      const r = setup({ exists: SCHED_DEPS("p") }).run("scheduler", {
        ...SMOKE,
        [k]: v,
      });
      expect(r.code, `${k}=${v}`).toBe(1);
      expect(r.err).toContain(k);
      expect(r.err).not.toContain(v);
      expect(noDeploy(r.log)).toEqual([]);
    }
  });

  it("every other target leaves them alone, even with them in its env", () => {
    for (const [t, exists] of [
      ["auth-broker", []],
      ["directory-broker", []],
      ["provisioning", ["oa-p-provisioner", "oa-p-auth-broker"]],
    ] as const) {
      const r = setup({ exists: [...exists] }).run(t, SMOKE);
      expect(r.code, `${t}: ${r.err}`).toBe(0);
      expect(
        puts(r.log).filter((n) => n.startsWith("FLEET_SMOKE")),
        t,
      ).toEqual([]);
      hidden(r);
    }
  });

  it("the read-back fails closed: a failed secrets listing fails the run", () => {
    const r = setup({ exists: SCHED_DEPS("p"), failSecrets: true }).run(
      "scheduler",
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("list oa-p-scheduler secrets");
  });

  it("the read-back refuses a secret the scheduler shouldn't hold", () => {
    const ok = setup({
      exists: SCHED_DEPS("p"),
      secrets: {
        "oa-p-scheduler": [
          "EMAIL_QUOTA_TOKEN",
          "FLEET_SMOKE_TOKEN",
          "FLEET_SMOKE_SHARE_TO",
        ],
      },
    }).run("scheduler");
    expect(ok.code, ok.err).toBe(0);
    const bad = setup({
      exists: SCHED_DEPS("p"),
      secrets: { "oa-p-scheduler": ["FLEET_SMOKE_TOKEN", "ADMIN_IDENTITIES"] },
    }).run("scheduler");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain(
      "oa-p-scheduler has a secret it shouldn't: ADMIN_IDENTITIES",
    );
  });
});
