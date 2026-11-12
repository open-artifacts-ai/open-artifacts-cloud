import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { run } from "./staging-portal-config.ts";
import { Refused, stripeClient } from "./staging-team-proof.ts";

const KEY = "sk_test_FAKEfakeFAKEfake0123";

type Seen = { method: string; path: string; form: Record<string, string> };

const feat = (on: Record<string, boolean>) => ({
  subscription_update: { enabled: on.update ?? true },
  subscription_cancel: { enabled: on.cancel ?? true },
  payment_method_update: { enabled: on.pm ?? true },
  invoice_history: { enabled: on.invoices ?? true },
});

function world(configs: unknown[]) {
  const seen: Seen[] = [];
  const logs: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = String(init.method);
    seen.push({
      method,
      path: u.pathname + u.search,
      form: Object.fromEntries(new URLSearchParams(String(init.body ?? ""))),
    });
    if (method === "GET")
      return Response.json({ data: configs, has_more: false });
    return Response.json({ id: "bpc_Made1", livemode: false });
  }) as unknown as typeof fetch;
  return {
    seen,
    logs,
    call: stripeClient(KEY, f),
    io: { log: (s: string) => logs.push(s) },
  };
}

const ENSURE_FORM = {
  "features[subscription_update][enabled]": "false",
  "features[subscription_cancel][enabled]": "true",
  "features[subscription_cancel][mode]": "at_period_end",
  "features[payment_method_update][enabled]": "true",
  "features[invoice_history][enabled]": "true",
  "metadata[oa]": "billing",
};

describe("portal-read", () => {
  it("prints each configuration's id, default flag and the four features, nothing else", async () => {
    const w = world([
      {
        id: "bpc_Def1",
        is_default: true,
        is_active: true,
        business_profile: {
          headline: "Acme",
          privacy_policy_url: "https://x.example",
        },
        login_page: { url: "https://secret.example" },
        features: {
          ...feat({}),
          customer_update: { enabled: true, allowed_updates: ["email"] },
        },
      },
      {
        id: "bpc_Oa1",
        is_default: false,
        is_active: true,
        features: feat({ update: false }),
      },
    ]);
    await run(w.io, w.call, "portal-read");
    expect(w.seen).toEqual([
      {
        method: "GET",
        path: "/v1/billing_portal/configurations?limit=100",
        form: {},
      },
    ]);
    expect(w.logs).toEqual([
      "bpc_Def1 is_default true subscription_update true subscription_cancel true payment_method_update true invoice_history true",
      "bpc_Oa1 is_default false subscription_update false subscription_cancel true payment_method_update true invoice_history true",
    ]);
    const out = w.logs.join("\n");
    for (const leak of ["Acme", "x.example", "secret", "email", KEY])
      expect(out).not.toContain(leak);
  });

  it("an id that is not a bpc_ id is refused, not printed", async () => {
    const w = world([{ id: "weird id", features: feat({}) }]);
    await expect(run(w.io, w.call, "portal-read")).rejects.toBeInstanceOf(
      Refused,
    );
    expect(w.logs).toEqual([]);
  });
});

describe("portal-ensure", () => {
  it("none with metadata oa=billing: creates one, prints only its id", async () => {
    const w = world([
      { id: "bpc_Def1", is_default: true, metadata: {}, features: feat({}) },
    ]);
    await run(w.io, w.call, "portal-ensure");
    expect(w.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /v1/billing_portal/configurations?limit=100",
      "POST /v1/billing_portal/configurations",
    ]);
    expect(w.seen[1]?.form).toEqual(ENSURE_FORM);
    expect(w.logs).toEqual(["portal configuration bpc_Made1"]);
  });

  it("one with metadata oa=billing: updates it in place, same settings, no business_profile", async () => {
    const w = world([
      { id: "bpc_Def1", is_default: true, metadata: {}, features: feat({}) },
      {
        id: "bpc_Oa1",
        is_default: false,
        is_active: true,
        metadata: { oa: "billing" },
        features: feat({ update: true }),
      },
    ]);
    await run(w.io, w.call, "portal-ensure");
    expect(w.seen[1]).toMatchObject({
      method: "POST",
      path: "/v1/billing_portal/configurations/bpc_Oa1",
    });
    expect(w.seen[1]?.form).toEqual(ENSURE_FORM);
    expect(
      Object.keys(w.seen[1]?.form ?? {}).some((k) =>
        k.startsWith("business_profile"),
      ),
    ).toBe(false);
    expect(w.logs).toEqual(["portal configuration bpc_Made1"]);
  });

  it("two with metadata oa=billing: refused, nothing written", async () => {
    const mk = (id: string) => ({
      id,
      is_default: false,
      is_active: true,
      metadata: { oa: "billing" },
      features: feat({}),
    });
    const w = world([mk("bpc_A1"), mk("bpc_B1")]);
    await expect(run(w.io, w.call, "portal-ensure")).rejects.toBeInstanceOf(
      Refused,
    );
    expect(w.seen.every((s) => s.method === "GET")).toBe(true);
  });
});

describe("guards", () => {
  it("only portal-read and portal-ensure run", async () => {
    const w = world([]);
    await expect(run(w.io, w.call, "create")).rejects.toBeInstanceOf(Refused);
    expect(w.seen).toEqual([]);
  });

  it("a live or malformed key is refused before any call, and never printed", () => {
    for (const k of [
      "sk_live_abcdefgh12345678",
      "rk_live_abcdefgh12345678",
      "nope",
    ]) {
      let msg = "";
      try {
        stripeClient(k, (() => {
          throw new Error("called");
        }) as unknown as typeof fetch);
      } catch (e) {
        msg = String((e as Error).message);
      }
      expect(msg).toContain("test-mode key");
      expect(msg).not.toContain(k);
    }
  });
});

describe("the workflow", () => {
  const src = readFileSync(
    join(
      import.meta.dirname,
      "../../.github/workflows/staging-portal-config.yml",
    ),
    "utf8",
  );
  const wf = parse(src) as {
    on: {
      workflow_dispatch: { inputs: Record<string, { options?: string[] }> };
    };
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        environment: string;
        steps: { run?: string; env?: Record<string, string> }[];
      }
    >;
  };

  it("dispatch only, with the two actions, read-only token, the staging environment", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
    expect(wf.on.workflow_dispatch.inputs.action?.options).toEqual([
      "portal-read",
      "portal-ensure",
    ]);
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(wf.jobs.portal?.environment).toBe("hosted-staging-deploy");
  });

  it("refuses to run off main, before the key is in any step's env", () => {
    const steps = wf.jobs.portal?.steps ?? [];
    const check = steps.find((s) => s.run?.includes("refs/heads/main"));
    expect(check).toBeDefined();
    expect(steps.indexOf(check as object as never)).toBe(0);
    const withKey = steps.filter((s) => s.env?.STRIPE_SECRET_KEY);
    expect(withKey).toHaveLength(1);
    expect(withKey[0]?.run).toContain("staging-portal-config.ts");
    expect(src).not.toMatch(/STRIPE_SECRET_KEY.*(echo|::add-mask)/);
  });
});
