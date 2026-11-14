import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brokerKey } from "./broker-key.ts";
import {
  alertPinProblems,
  committedBilling,
  committedRateLimits,
  committedSignups,
  committedVars,
  stripJsonc,
} from "./wrangler-env.ts";

// The read-backs compare to the committed config through wrangler-env.ts;
// the provisioning target's admin broker key comes from broker-key.ts.
const root = join(import.meta.dirname, "../..");
const cfg = (app: string) =>
  readFileSync(join(root, "apps", app, "wrangler.jsonc"), "utf8");

describe("wrangler-env.ts", () => {
  it("the provisioning vars: committed values, the repository id filled", () => {
    const v = committedVars(cfg("provisioning"), "staging", {
      GITHUB_REPOSITORY_ID: "123456",
      SIGNUP_DAILY_CAP: "20",
      SIGNUPS_ENABLED: "true",
      WELCOME_FROM: "welcome@mail.example.app",
    });
    expect(v.SIGNUP_DAILY_CAP).toBe("20");
    // The approval email's sender (#2096), the provisioner's value.
    expect(v.WELCOME_FROM).toBe("welcome@mail.example.app");
    // Staging's gate is the constant, not a literal (open for the M2 walk).
    expect(v.SIGNUPS_ENABLED).toBe("true");
    expect(v.OA_ENV).toBe("staging");
    expect(v.OIDC_REPOSITORY_ID).toBe("123456");
    expect(v.MCP_REDIRECT_URIS).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(JSON.stringify(v)).not.toContain("{{");
    // Prod has no OIDC_* and needs only the cap.
    const p = committedVars(cfg("provisioning"), "prod", {
      SIGNUP_DAILY_CAP: "50",
      SIGNUPS_ENABLED: "invite",
      WELCOME_FROM: "welcome@mail.example.app",
    });
    expect(Object.keys(p).filter((k) => k.startsWith("OIDC_"))).toEqual([]);
    // Prod's gate is the constant too, not a literal (it was a literal false).
    expect(p.SIGNUPS_ENABLED).toBe("invite");
    expect(() =>
      committedVars(cfg("provisioning"), "prod", {
        SIGNUP_DAILY_CAP: "50",
        WELCOME_FROM: "welcome@mail.example.app",
      }),
    ).toThrow(/SIGNUPS_ENABLED/);
  });
  it("signups: the committed SIGNUPS_ENABLED, a literal or as filled; null when absent", () => {
    expect(
      committedSignups(cfg("provisioning"), "prod", {
        SIGNUPS_ENABLED: "invite",
      }),
    ).toBe("invite");
    expect(() => committedSignups(cfg("provisioning"), "prod", {})).toThrow(
      "has no value",
    );
    expect(
      committedSignups(cfg("provisioning"), "staging", {
        SIGNUPS_ENABLED: "true",
      }),
    ).toBe("true");
    expect(
      committedSignups(cfg("provisioner"), "prod", { SIGNUPS_ENABLED: "true" }),
    ).toBe("true");
    expect(() => committedSignups(cfg("provisioner"), "prod", {})).toThrow(
      "has no value",
    );
    expect(committedSignups(cfg("dispatch"), "prod", {})).toBeNull();
  });
  it("refuses a placeholder with no value, or another env's", () => {
    expect(() =>
      committedVars(cfg("provisioning"), "staging", {
        SIGNUP_DAILY_CAP: "20",
        SIGNUPS_ENABLED: "false",
        WELCOME_FROM: "welcome@mail.example.app",
      }),
    ).toThrow(
      /OIDC_REPOSITORY_ID: \{\{GITHUB_REPOSITORY_ID_STAGING\}\} has no value/,
    );
    const src = `{"env":{"prod":{"vars":{"A":"{{X_STAGING}}"}}}}`;
    expect(() => committedVars(src, "prod", { X: "1" })).toThrow(/no value/);
  });
  it("the rate limits, sorted by name, ids as strings", () => {
    // The expected list comes from the committed config, read here without
    // wrangler-env.ts, so a new binding needs no edit to this test.
    const raw = (env: "staging" | "prod") =>
      (
        JSON.parse(stripJsonc(cfg("provisioning"))).env[env].ratelimits as {
          name: string;
          namespace_id: string | number;
          simple: { limit: number; period: number };
        }[]
      )
        .map((x) => ({
          name: x.name,
          namespace_id: `${x.namespace_id}`,
          limit: x.simple.limit,
          period: x.simple.period,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const env of ["staging", "prod"] as const) {
      const want = raw(env);
      expect(want.length).toBeGreaterThan(0);
      expect(committedRateLimits(cfg("provisioning"), env)).toEqual(want);
    }
    expect(committedRateLimits(cfg("provisioning"), "prod")).toContainEqual({
      name: "RL_PV_OAUTH_IP",
      namespace_id: "1156",
      limit: 20,
      period: 60,
    });
    // Numeric ids and unsorted input come out as strings, sorted by name.
    const src = `{"env":{"prod":{"ratelimits":[
      {"name":"B","namespace_id":2,"simple":{"limit":1,"period":10}},
      {"name":"A","namespace_id":"1","simple":{"limit":3,"period":60}}]}}}`;
    expect(committedRateLimits(src, "prod")).toEqual([
      { name: "A", namespace_id: "1", limit: 3, period: 60 },
      { name: "B", namespace_id: "2", limit: 1, period: 10 },
    ]);
  });
  it("strips comments outside strings only, and trailing commas", () => {
    const src = `{
      // a comment
      "env": { "prod": { "vars": { "U": "https://x/y", /* b */ "V": "a//b", }, }, },
    }`;
    expect(committedVars(src, "prod", {})).toEqual({
      U: "https://x/y",
      V: "a//b",
    });
  });
});

describe("broker-key.ts", () => {
  it("kid derives from x as provision's brokerKid; pkcs8 is the matching private key", async () => {
    const k = brokerKey();
    // packages/provision/src/wfp.ts brokerKid.
    const kid = createHash("sha256")
      .update(Buffer.from(k.x, "base64url"))
      .digest("base64url")
      .slice(0, 16);
    expect(k.kid).toBe(kid);
    expect(k.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const priv = await crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(k.pkcs8, "base64url"),
      { name: "Ed25519" },
      true,
      ["sign"],
    );
    const jwk = (await crypto.subtle.exportKey("jwk", priv)) as JsonWebKey;
    expect(jwk.x).toBe(k.x);
    expect(brokerKey().kid).not.toBe(k.kid);
  });
  it("alert pins: each var and ALERT_EMAIL's destination must be this env's placeholder", () => {
    const conf = (prod: Record<string, unknown>) =>
      JSON.stringify({ env: { prod } });
    const vars = {
      ALERT_TO: "{{ALERT_TO_PROD}}",
      ALERT_FROM: "{{ALERT_FROM_PROD}}",
      SIGNUP_DAILY_CAP: "{{SIGNUP_DAILY_CAP_PROD}}",
      SIGNUPS_ENABLED: "{{SIGNUPS_ENABLED_PROD}}",
    };
    const mail = [
      { name: "ALERT_EMAIL", destination_address: "{{ALERT_TO_PROD}}" },
    ];
    expect(alertPinProblems(conf({ vars, send_email: mail }), "prod")).toEqual(
      [],
    );
    expect(
      alertPinProblems(
        conf({ vars: { ...vars, ALERT_TO: "a@b.com" }, send_email: mail }),
        "prod",
      ),
    ).toEqual(["vars.ALERT_TO is not {{ALERT_TO_PROD}}"]);
    for (const send_email of [
      undefined,
      [{ name: "ALERT_EMAIL" }],
      [{ name: "ALERT_EMAIL", destination_address: "{{ALERT_TO_STAGING}}" }],
      [...mail, ...mail],
    ])
      expect(alertPinProblems(conf({ vars, send_email }), "prod")).toEqual([
        "send_email ALERT_EMAIL needs destination_address {{ALERT_TO_PROD}}",
      ]);
  });
});

describe("committedBilling", () => {
  const conf = (staging: unknown[] | undefined, prod?: unknown[]) =>
    JSON.stringify({
      env: { staging: { services: staging }, prod: { services: prod } },
    });
  it("reads the service and entrypoint of the env block's BILLING binding", () => {
    const src = conf([
      { binding: "OTHER", service: "oa-s-x" },
      { binding: "BILLING", service: "oa-s-billing", entrypoint: "E" },
    ]);
    expect(committedBilling(src, "staging")).toEqual({
      service: "oa-s-billing",
      entrypoint: "E",
    });
    expect(
      committedBilling(
        conf([{ binding: "BILLING", service: "oa-s-billing" }]),
        "staging",
      ),
    ).toEqual({ service: "oa-s-billing", entrypoint: null });
  });
  it("is null when the block declares none, per env", () => {
    expect(committedBilling(conf(undefined), "staging")).toBeNull();
    expect(
      committedBilling(
        conf([{ binding: "BILLING", service: "oa-s-billing" }]),
        "prod",
      ),
    ).toBeNull();
  });
  it("refuses two BILLING bindings", () => {
    const b = { binding: "BILLING", service: "oa-s-billing" };
    expect(() => committedBilling(conf([b, b]), "staging")).toThrow(
      /more than one/,
    );
  });
  it("the real apps: staging and prod both bind BILLING, each to its own Worker, with the same entrypoints", () => {
    const entry: Record<string, string | null> = {
      dispatch: null,
      scheduler: null,
      provisioner: "BillingProvisionerRpc",
      provisioning: "BillingOperatorRpc",
    };
    for (const app of Object.keys(entry)) {
      expect(committedBilling(cfg(app), "staging")?.service, app).toBe(
        "oa-s-billing",
      );
      expect(committedBilling(cfg(app), "prod")?.service, app).toBe(
        "oa-p-billing",
      );
      for (const env of ["staging", "prod"] as const)
        expect(
          committedBilling(cfg(app), env)?.entrypoint,
          `${app} ${env}`,
        ).toBe(entry[app]);
    }
  });
});
