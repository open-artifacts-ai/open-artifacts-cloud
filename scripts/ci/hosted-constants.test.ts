// .github/hosted/<env>.json: the committed hosted constants, pinned to their
// sources, and hosted-constants.sh, which loads them into GITHUB_ENV.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, script } from "./stubs.ts";

const KEYS = [
  "account_id",
  "alert_from",
  "app_zone",
  "content_zone",
  "deploy_token_id",
  "dispatch_namespace",
  "email_daily_limit",
  "email_zone",
  "google_client_id",
  "google_directory_client_id",
  "signup_daily_cap",
  "signups_enabled",
  "welcome_from",
];
// Billing's four Stripe price ids (#1568): staging's file only, not secrets.
const STRIPE_KEYS = [
  "stripe_price_business",
  "stripe_price_solo_monthly",
  "stripe_price_solo_yearly",
  "stripe_price_team",
];
// The yearly Team and Business prices (#2136): optional for the loader, held by staging.
const STRIPE_YEARLY_KEYS = [
  "stripe_price_business_yearly",
  "stripe_price_team_yearly",
];
// Read by provapi-spikes.sh and provapi-token-verify.sh only; hosted-constants.sh does not load them.
const SPIKE_KEYS = [
  "app_zone",
  "content_zone",
  "deploy_token_id",
  "dispatch_namespace",
];
const LOADED = KEYS.filter((k) => !SPIKE_KEYS.includes(k));
const read = (env: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, `.github/hosted/${env}.json`), "utf8"));

/** provision's BROKER_GOOGLE_CLIENT_ID[env], through deploy-hosted-platform.sh's own reader. */
const brokerPin = (env: string): string => {
  const sh = readFileSync(
    join(root, "scripts/ops/deploy-hosted-platform.sh"),
    "utf8",
  );
  const m =
    /^broker_pin\(\) \{\n {2}node -e '([\s\S]*?)' "\$BROKER_PIN_FILE" "\$env"\n\}$/m.exec(
      sh,
    );
  if (!m) throw new Error("no broker_pin reader in deploy-hosted-platform.sh");
  const r = spawnSync(
    "node",
    ["-e", m[1] as string, join(root, "packages/provision/src/wfp.ts"), env],
    { encoding: "utf8" },
  );
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};

describe(".github/hosted/<env>.json", () => {
  it("prod and staging hold the same keys; both hold billing's six price ids (prod's are the live-mode ids), prod adds signup_deploy", () => {
    expect(Object.keys(read("prod")).sort()).toEqual(
      [...KEYS, ...STRIPE_KEYS, ...STRIPE_YEARLY_KEYS, "signup_deploy"].sort(),
    );
    expect(Object.keys(read("staging")).sort()).toEqual(
      [
        ...KEYS,
        ...STRIPE_KEYS,
        ...STRIPE_YEARLY_KEYS,
        "stripe_portal_config",
      ].sort(),
    );
  });

  // #2208: the staging sandbox's portal configuration (plan changes and
  // quantities off), made by staging-portal-config portal-ensure on 11-13.
  it("staging pins its portal configuration, from the staging sandbox", () => {
    expect(read("staging").stripe_portal_config).toBe(
      "bpc_1UbKyQJuK8jgC2cZNSV0UYXl",
    );
  });

  // From the user's Stripe sandbox page (test mode); a price id is not a secret.
  it("staging's price ids are the sandbox's four, each a price id", () => {
    expect(read("staging")).toMatchObject({
      stripe_price_solo_monthly: "price_1UYx2tJuK8jgC2cZS0mg3Uiz",
      stripe_price_solo_yearly: "price_1UaImwJuK8jgC2cZKiXgN6nX",
      stripe_price_team: "price_1UYx2vJuK8jgC2cZAcUMAQpw",
      stripe_price_business: "price_1UYx2vJuK8jgC2cZr02sKqwQ",
      stripe_price_team_yearly: "price_1UamQGJuK8jgC2cZYOU7jxrn",
      stripe_price_business_yearly: "price_1UamSJJuK8jgC2cZImmC9P8p",
    });
    for (const k of [...STRIPE_KEYS, ...STRIPE_YEARLY_KEYS])
      expect(read("staging")[k], k).toMatch(/^price_[A-Za-z0-9]+$/);
  });

  // Read by provapi-spikes.sh (the staging spikes); pinned to provision's
  // HOSTED_DOMAINS and NAMESPACES so the two never drift.
  it("app_zone, content_zone and dispatch_namespace are provision's, per env", () => {
    const names = readFileSync(
      join(root, "packages/provision/src/names.ts"),
      "utf8",
    );
    const wfp = readFileSync(
      join(root, "packages/provision/src/wfp.ts"),
      "utf8",
    );
    for (const env of ["prod", "staging"]) {
      const d = new RegExp(
        `${env}: Object\\.freeze\\(\\{\\s*app: "([^"]+)",\\s*content: "([^"]+)"`,
      ).exec(names);
      expect(d, env).not.toBeNull();
      expect(read(env).app_zone, env).toBe(d?.[1]);
      expect(read(env).content_zone, env).toBe(d?.[2]);
      const ns = new RegExp(
        `NAMESPACES[^=]*= Object\\.freeze\\(\\{[^}]*${env}: "([^"]+)"`,
      ).exec(wfp);
      expect(read(env).dispatch_namespace, env).toBe(ns?.[1]);
    }
    expect(read("staging").dispatch_namespace).toBe("oa-staging");
  });

  it("google_client_id is provision's broker pin, per env", () => {
    for (const env of ["prod", "staging"]) {
      const pin = brokerPin(env);
      expect(pin).toMatch(/\.apps\.googleusercontent\.com$/);
      expect(read(env).google_client_id, env).toBe(pin);
    }
  });

  it("account_id is the hosted account in the docs", () => {
    const docs = readFileSync(join(root, "docs/ops/staging.md"), "utf8");
    const m = /^\| Account \| \| ([0-9a-f]{32}) \|$/m.exec(docs);
    expect(m).not.toBeNull();
    for (const env of ["prod", "staging"])
      expect(read(env).account_id, env).toBe(m?.[1]);
  });

  it("staging's directory client is the directory broker's staging client", () => {
    const w = readFileSync(
      join(root, "apps/directory-broker/wrangler.jsonc"),
      "utf8",
    );
    const m = /"GOOGLE_DIRECTORY_CLIENT_ID": "([^"{]+)"/.exec(w);
    expect(read("staging").google_directory_client_id).toBe(m?.[1]);
  });

  // The prod Directory client is the one made in project open-artifacts-prod
  // during setup C (2026-10-24); deploy fills it into the broker's
  // {{GOOGLE_DIRECTORY_CLIENT_ID_PROD}}. It is not the staging client.
  it("prod's directory client is the setup C client, distinct from staging's", () => {
    expect(read("prod").google_directory_client_id).toBe(
      "206295999771-6cr3mbfc7g2ejnvdoqhlf2v8v6sdm023.apps.googleusercontent.com",
    );
    expect(read("prod").google_directory_client_id).not.toBe(
      read("staging").google_directory_client_id,
    );
  });

  // Hosted mail is sent as noreply@mail.<app domain> (provision's
  // metadata.ts), so the sending zone is the app zone; its tag is looked up
  // in the run (hosted-resource-ids.sh), never committed.
  it("email_zone is the env's app zone, and no zone tag is committed", () => {
    const wfp = readFileSync(
      join(root, "packages/provision/src/names.ts"),
      "utf8",
    );
    for (const env of ["prod", "staging"]) {
      const m = new RegExp(
        `${env}: Object\\.freeze\\(\\{\\s*app: "([^"]+)"`,
      ).exec(wfp);
      expect(m, env).not.toBeNull();
      expect(read(env).email_zone, env).toBe(m?.[1]);
      expect(Object.keys(read(env))).not.toContain("email_zone_tags");
    }
    expect(read("prod").email_daily_limit).toBe(5000);
    expect(read("staging").email_daily_limit).toBe(500);
  });
  // The Manager's values (2026-10-31), filled into the provisioner's and the
  // scheduler's placeholders.
  // Design 155 and M4: prod stays closed. User decision 2026-11-10 (option
  // A): staging sign-ups are open to anyone, capped at 20 a day, for the M2
  // exit-test walk (it was test-users only, #1012, P29).
  it("prod signups stay closed with a cap of 20, staging is invite-only (beta proof, #2096) with a cap of 20; the caps and alert addresses are the Manager's", () => {
    expect(read("prod").signup_daily_cap).toBe(20);
    expect(read("staging").signup_daily_cap).toBe(20);
    expect(read("prod").signups_enabled).toBe("false");
    expect(read("staging").signups_enabled).toBe("invite");
    // #1084: the alert address is the owner's: never committed, it comes
    // from the OA_OWNER_EMAIL secret (hosted-constants.sh).
    for (const env of ["prod", "staging"])
      expect(read(env), env).not.toHaveProperty("alert_to");
  });
  // Email Sending only sends from an onboarded domain: mail.<app_zone> (#967),
  // never the apex.
  it("every sender (*_from) is on mail.<app_zone>, the env's onboarded sending domain", () => {
    for (const env of ["prod", "staging"]) {
      const c = read(env);
      const senders = Object.keys(c).filter((k) => k.endsWith("_from"));
      expect(senders.sort(), env).toEqual(["alert_from", "welcome_from"]);
      expect(c.app_zone, env).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      for (const k of senders) {
        const v = String(c[k]);
        expect(
          v.endsWith(`@mail.${String(c.app_zone)}`),
          `${env} ${k}: ${v}`,
        ).toBe(true);
        expect(v.split("@")[0], `${env} ${k}`).toMatch(/^[a-z0-9._-]+$/);
      }
    }
  });
});

describe("hosted-constants.sh", () => {
  const load = (
    files: Record<string, unknown> | null,
    env = "prod",
    raw?: string,
    extra: Record<string, string> = {},
  ) => {
    const sb = sandbox({});
    const dir = join(sb.dir, "hosted");
    mkdirSync(dir);
    if (raw !== undefined) writeFileSync(join(dir, `${env}.json`), raw);
    else if (files)
      writeFileSync(join(dir, `${env}.json`), JSON.stringify(files));
    const ghEnv = join(sb.dir, "github-env");
    writeFileSync(ghEnv, "");
    const r = sb.run(["bash", script("hosted-constants.sh"), env, dir], {
      env: { GITHUB_ENV: ghEnv, ...extra },
    });
    return { ...r, ghEnv: readFileSync(ghEnv, "utf8") };
  };
  const PROD = () => read("prod");
  const PRICE_KEYS = [...STRIPE_KEYS, ...STRIPE_YEARLY_KEYS];
  // The loader's order: the four, then the two yearly (team before business).
  const PROD_PRICE_LINES = () =>
    [
      "stripe_price_team",
      "stripe_price_business",
      "stripe_price_solo_monthly",
      "stripe_price_solo_yearly",
      "stripe_price_team_yearly",
      "stripe_price_business_yearly",
    ].map((k) => `${k.toUpperCase()}=${String(read("prod")[k])}`);
  const BLANK_PRICES = () => ({
    ...PROD(),
    ...Object.fromEntries(PRICE_KEYS.map((k) => [k, ""])),
  });

  it("loads every constant into GITHUB_ENV", () => {
    const r = load(PROD(), "prod", undefined, {
      OA_OWNER_EMAIL: "me@test.invalid",
    });
    expect(r.code, r.err).toBe(0);
    expect(r.ghEnv).toBe(
      [
        "CLOUDFLARE_ACCOUNT_ID=26ac346086d4405f7a976d48747a2a75",
        "ALERT_FROM=alerts@mail.open-artifacts.app",
        "EMAIL_ZONE=open-artifacts.app",
        "EMAIL_DAILY_LIMIT=5000",
        "GOOGLE_CLIENT_ID=206295999771-ntbp6nlf5ospa45ovc73aur4f05fpp5s.apps.googleusercontent.com",
        "GOOGLE_DIRECTORY_CLIENT_ID=206295999771-6cr3mbfc7g2ejnvdoqhlf2v8v6sdm023.apps.googleusercontent.com",
        "SIGNUP_DAILY_CAP=20",
        "SIGNUPS_ENABLED=false",
        "WELCOME_FROM=welcome@mail.open-artifacts.app",
        ...PROD_PRICE_LINES(),
        "PROD_SIGNUP_DEPLOY=off",
        "ALERT_TO=me@test.invalid",
        "",
      ].join("\n"),
    );
    // The owner's address goes to GITHUB_ENV only, never the (public) log.
    expect(r.out).not.toContain("me@test.invalid");
  });

  it("the committed files both load", () => {
    for (const env of ["prod", "staging"]) {
      const sb = sandbox({});
      const ghEnv = join(sb.dir, "github-env");
      writeFileSync(ghEnv, "");
      const r = sb.run(
        [
          "bash",
          script("hosted-constants.sh"),
          env,
          join(root, ".github/hosted"),
        ],
        { env: { GITHUB_ENV: ghEnv } },
      );
      expect(r.code, r.err).toBe(0);
      const lines = readFileSync(ghEnv, "utf8").split("\n");
      expect(lines).toHaveLength(
        LOADED.length +
          STRIPE_KEYS.length +
          STRIPE_YEARLY_KEYS.length +
          (env === "prod" ? 1 : 0) +
          1,
      );
    }
  });

  it("a missing, null, empty or multi-line value fails and writes nothing", () => {
    for (const k of LOADED) {
      const missing = PROD();
      delete missing[k];
      for (const files of [
        missing,
        { ...PROD(), [k]: null },
        { ...PROD(), [k]: "" },
        { ...PROD(), [k]: "a\nGITHUB_TOKEN=x" },
        { ...PROD(), [k]: ["x"] },
      ]) {
        const r = load(files);
        expect(r.code, `${k} ${JSON.stringify(files[k])}`).toBe(1);
        expect(r.err).toContain(k);
        expect(r.ghEnv).toBe("");
      }
    }
  });

  it("refuses a placeholder or malformed value in any key, before writing anything", () => {
    const bad: [string, unknown][] = [
      ["account_id", "UNCONFIRMED-account"],
      ["account_id", "A".repeat(32)],
      ["email_zone", "UNCONFIRMED-set-the-sending-zone"],
      ["email_zone", "{{EMAIL_ZONE_PROD}}"],
      ["email_zone", "open-artifacts.app/x"],
      ["email_daily_limit", "UNCONFIRMED"],
      ["email_daily_limit", 0],
      ["email_daily_limit", "5000;x"],
      ["email_daily_limit", 1234567890],
      ["google_client_id", "{{GOOGLE_CLIENT_ID_PROD}}"],
      ["google_client_id", "UNCONFIRMED.apps.googleusercontent.com"],
      ["google_directory_client_id", "TODO"],
      ["google_directory_client_id", "1-x.apps.googleusercontent.com.evil"],
      ["signup_daily_cap", 0],
      ["signup_daily_cap", 10000],
      ["signup_daily_cap", "20 "],
      ["signups_enabled", "test-users"],
      ["signups_enabled", "TRUE"],
      ["signups_enabled", "true"],
      ["welcome_from", "welcome"],
      ["welcome_from", "W <a@b.com>"],
      ["welcome_from", "a@b.com/x"],
    ];
    for (const [k, v] of bad) {
      const r = load({ ...PROD(), [k]: v });
      expect(r.code, `${k}=${v}`).toBe(1);
      expect(r.err).toContain(`${k} is not a valid value`);
      expect(r.ghEnv, `${k}=${v}`).toBe("");
    }
  });

  it("OA_OWNER_EMAIL: optional here (no ALERT_TO without it; deploy-hosted-platform refuses first when the targets include the scheduler), checked like any other", () => {
    const none = load(PROD());
    expect(none.code, none.err).toBe(0);
    expect(none.ghEnv).not.toContain("ALERT_TO=");
    for (const v of [
      "ops",
      "A <a@b.com>",
      "a@b.com,c@d.com",
      "a@b.com/x",
      "a@b.com\nX=y",
      " a@b.com",
    ]) {
      const bad = load(PROD(), "prod", undefined, { OA_OWNER_EMAIL: v });
      expect(bad.code, JSON.stringify(v)).toBe(1);
      expect(bad.err).toContain("OA_OWNER_EMAIL is not a valid address");
      expect(bad.err).not.toContain(v);
      expect(bad.ghEnv).toBe("");
    }
  });

  it("OA_OWNER_EMAIL: refuses an unnormalized address, without printing it", () => {
    const bad = load(PROD(), "prod", undefined, {
      OA_OWNER_EMAIL: "Me@Test.Invalid",
    });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("OA_OWNER_EMAIL must be lowercase");
    expect(bad.err).not.toContain("Test.Invalid");
    expect(bad.ghEnv).toBe("");
  });

  it("prod commits signup_deploy off; it loads as PROD_SIGNUP_DEPLOY, exactly on or off, prod only (#40)", () => {
    expect(read("prod").signup_deploy).toBe("off");
    const off = load(PROD());
    expect(off.code, off.err).toBe(0);
    expect(off.ghEnv).toContain("PROD_SIGNUP_DEPLOY=off\n");
    const on = load({ ...PROD(), signup_deploy: "on" });
    expect(on.code, on.err).toBe(0);
    expect(on.ghEnv).toContain("PROD_SIGNUP_DEPLOY=on\n");
    for (const v of [
      "ON",
      "On",
      "true",
      "1",
      "yes",
      " on",
      "on ",
      "",
      null,
      true,
      1,
    ]) {
      const r = load({ ...PROD(), signup_deploy: v });
      expect(r.code, JSON.stringify(v)).toBe(1);
      expect(r.err).toContain('signup_deploy must be exactly "on" or "off"');
      expect(r.ghEnv).toBe("");
    }
    const { signup_deploy: _, ...missing } = PROD();
    expect(load(missing).code).toBe(1);
    const st = load({ ...read("staging"), signup_deploy: "on" }, "staging");
    expect(st.code).toBe(1);
    expect(st.err).toContain("staging holds no signup_deploy");
    expect(load(read("staging"), "staging").ghEnv).not.toContain(
      "PROD_SIGNUP_DEPLOY",
    );
  });

  it("SIGNUPS_ENABLED test-users loads for staging only", () => {
    const st = load(
      { ...read("staging"), signups_enabled: "test-users" },
      "staging",
    );
    expect(st.code, st.err).toBe(0);
    expect(st.ghEnv).toContain("SIGNUPS_ENABLED=test-users\n");
    const open = load(
      { ...read("staging"), signups_enabled: "true" },
      "staging",
    );
    expect(open.code, open.err).toBe(0);
    expect(open.ghEnv).toContain("SIGNUPS_ENABLED=true\n");
    expect(
      load({ ...read("staging"), signups_enabled: "TEST-USERS" }, "staging")
        .code,
    ).toBe(1);
  });

  it("the yearly Team and Business prices are optional, validated when present", () => {
    const st = load(read("staging"), "staging");
    expect(st.ghEnv).not.toContain("_YEARLY=price_team");
    const ok = load(
      {
        ...read("staging"),
        stripe_price_team_yearly: "price_1TeamY",
        stripe_price_business_yearly: "price_1BizY",
      },
      "staging",
    );
    expect(ok.code, ok.err).toBe(0);
    expect(ok.ghEnv).toContain("STRIPE_PRICE_TEAM_YEARLY=price_1TeamY\n");
    expect(ok.ghEnv).toContain("STRIPE_PRICE_BUSINESS_YEARLY=price_1BizY\n");
    const bad = load(
      { ...read("staging"), stripe_price_team_yearly: "prod_1" },
      "staging",
    );
    expect(bad.code).toBe(1);
  });

  it("stripe_portal_config is optional, validated when present, in both envs", () => {
    const st = load(read("staging"), "staging");
    expect(st.ghEnv).not.toContain("STRIPE_PORTAL_CONFIG");
    const ok = load(
      { ...read("staging"), stripe_portal_config: "bpc_1Abc" },
      "staging",
    );
    expect(ok.code, ok.err).toBe(0);
    expect(ok.ghEnv).toContain("STRIPE_PORTAL_CONFIG=bpc_1Abc\n");
    for (const v of ["pc_1", "bpc_", "bpc_1 2", "price_1Abc"])
      expect(
        load({ ...read("staging"), stripe_portal_config: v }, "staging").code,
        v,
      ).toBe(1);
    // Prod takes its own (live) portal configuration the same way.
    const prod = load(
      { ...read("prod"), stripe_portal_config: "bpc_1Live" },
      "prod",
    );
    expect(prod.code, prod.err).toBe(0);
    expect(prod.ghEnv).toContain("STRIPE_PORTAL_CONFIG=bpc_1Live\n");
    expect(
      load({ ...read("prod"), stripe_portal_config: "pc_1" }, "prod").code,
    ).toBe(1);
  });

  it("SIGNUPS_ENABLED invite (the private beta, #2096) loads for staging and prod", () => {
    for (const env of ["staging", "prod"] as const) {
      const r = load({ ...read(env), signups_enabled: "invite" }, env);
      expect(r.code, r.err).toBe(0);
      expect(r.ghEnv).toContain("SIGNUPS_ENABLED=invite\n");
      expect(load({ ...read(env), signups_enabled: "INVITE" }, env).code).toBe(
        1,
      );
    }
  });

  it("staging loads the four prices as STRIPE_PRICE_*; a missing or malformed one fails and writes nothing", () => {
    const st = load(read("staging"), "staging");
    expect(st.code, st.err).toBe(0);
    for (const l of [
      "STRIPE_PRICE_TEAM=price_1UYx2vJuK8jgC2cZAcUMAQpw",
      "STRIPE_PRICE_BUSINESS=price_1UYx2vJuK8jgC2cZr02sKqwQ",
      "STRIPE_PRICE_SOLO_MONTHLY=price_1UYx2tJuK8jgC2cZS0mg3Uiz",
      "STRIPE_PRICE_SOLO_YEARLY=price_1UaImwJuK8jgC2cZKiXgN6nX",
      "STRIPE_PRICE_TEAM_YEARLY=price_1UamQGJuK8jgC2cZYOU7jxrn",
      "STRIPE_PRICE_BUSINESS_YEARLY=price_1UamSJJuK8jgC2cZImmC9P8p",
    ])
      expect(st.ghEnv).toContain(`${l}\n`);
    for (const k of STRIPE_KEYS) {
      for (const v of [
        null,
        "",
        "prod_1Abc",
        "price_1 Abc",
        "price_{{X}}",
        ["price_1"],
        "price_1\nX=y",
      ]) {
        const files = { ...read("staging"), [k]: v };
        const r = load(files, "staging");
        expect(r.code, `${k}=${JSON.stringify(v)}`).toBe(1);
        expect(r.err).toContain(k);
        expect(r.ghEnv).toBe("");
      }
      const missing = read("staging");
      delete missing[k];
      expect(load(missing, "staging").code, k).toBe(1);
    }
  }, 30_000);

  it("prod's price ids: committed, six filled well-formed ids each load as STRIPE_PRICE_*; blanked, they load nothing and break no other run; malformed fails; any other stripe_* key is refused", () => {
    // Committed: the six live-mode ids, each well-formed and loaded.
    const committed = load(PROD(), "prod");
    expect(committed.code, committed.err).toBe(0);
    for (const k of PRICE_KEYS) {
      expect(read("prod")[k], k).toMatch(/^price_[A-Za-z0-9]+$/);
      expect(committed.ghEnv, k).toContain(
        `${k.toUpperCase()}=${String(read("prod")[k])}\n`,
      );
    }
    // Blanked (override object): nothing is loaded and no other prod run breaks.
    const ok = load(BLANK_PRICES(), "prod");
    expect(ok.code, ok.err).toBe(0);
    expect(ok.ghEnv).not.toContain("STRIPE");
    // Filled with made-up ids: loaded.
    const filled = {
      ...PROD(),
      stripe_price_team: "price_ProdTeam1",
      stripe_price_business: "price_ProdBusiness1",
      stripe_price_solo_monthly: "price_ProdSoloM1",
      stripe_price_solo_yearly: "price_ProdSoloY1",
      stripe_price_team_yearly: "price_ProdTeamY1",
      stripe_price_business_yearly: "price_ProdBusinessY1",
    };
    const f = load(filled, "prod");
    expect(f.code, f.err).toBe(0);
    for (const l of [
      "STRIPE_PRICE_TEAM=price_ProdTeam1",
      "STRIPE_PRICE_BUSINESS=price_ProdBusiness1",
      "STRIPE_PRICE_SOLO_MONTHLY=price_ProdSoloM1",
      "STRIPE_PRICE_SOLO_YEARLY=price_ProdSoloY1",
      "STRIPE_PRICE_TEAM_YEARLY=price_ProdTeamY1",
      "STRIPE_PRICE_BUSINESS_YEARLY=price_ProdBusinessY1",
    ])
      expect(f.ghEnv).toContain(`${l}\n`);
    for (const k of [...STRIPE_KEYS, ...STRIPE_YEARLY_KEYS]) {
      for (const v of ["prod_1Abc", "price_1 Abc", "price_{{FILL}}"]) {
        const r = load({ ...PROD(), [k]: v }, "prod");
        expect(r.code, `${k}=${v}`).toBe(1);
        expect(r.err).toContain(k);
        expect(r.ghEnv).toBe("");
      }
    }
    // A secret (or any other stripe_* key) in the file is refused.
    for (const k of ["stripe_secret_key", "stripe_webhook_secret"]) {
      const r = load({ ...PROD(), [k]: "x" }, "prod");
      expect(r.code, k).toBe(1);
      expect(r.err).toContain("stripe_* constant");
      expect(r.ghEnv).toBe("");
    }
  });

  it("refuses a bad account id, a missing file, bad JSON and a bad env", () => {
    expect(load({ ...PROD(), account_id: "nope" }).code).toBe(1);
    expect(load(null).code).toBe(1);
    expect(load(null, "prod", "{not json").code).toBe(1);
    expect(load(PROD(), "dev").code).toBe(2);
  });
});
