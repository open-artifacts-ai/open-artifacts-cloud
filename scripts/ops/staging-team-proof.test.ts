import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  type Input,
  type Io,
  Refused,
  resolveInstall,
  run,
  STAGING_APP_ZONE,
  stripeClient,
} from "./staging-team-proof.ts";

const KEY = "sk_test_FAKEfakeFAKEfake0123";
const ID = "iabc123def45";
const SLUG = "bill-proof-1";
const PRICE = "price_1UYx2vJuK8jgC2cZAcUMAQpw";
const IN: Input = {
  slug: SLUG,
  action: "create",
  priceTeam: PRICE,
  stagingPriceTeam: PRICE,
};

type Seen = {
  method: string;
  path: string;
  form: Record<string, string>;
  headers: Record<string, string>;
};

function world(
  over: {
    platform?: Record<string, unknown> | null;
    registry?: string | null;
    customer?: string | null;
    subs?: unknown[];
  } = {},
) {
  const seen: Seen[] = [];
  const writes: string[] = [];
  let customer = over.customer === undefined ? "cus_1" : over.customer;
  const sub = (status: string, qty = 1, proof = true) => ({
    id: "sub_1",
    status,
    metadata: proof ? { proof: "2123", tier: "team" } : {},
    items: { data: [{ quantity: qty, price: { id: PRICE } }] },
  });
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = String(init.method);
    const form = Object.fromEntries(
      new URLSearchParams(String(init.body ?? "")),
    );
    seen.push({
      method,
      path: u.pathname + u.search,
      form,
      headers: init.headers as Record<string, string>,
    });
    const j = (o: unknown) => Response.json(o);
    const p = u.pathname;
    if (p === "/v1/customers" && method === "POST") return j({ id: "cus_new" });
    if (p === "/v1/subscriptions" && method === "GET")
      return j({ data: over.subs ?? [sub("active", 3)] });
    if (p === "/v1/subscriptions" && method === "POST") return j(sub("active"));
    if (p === "/v1/subscriptions/sub_1" && method === "DELETE")
      return j({ ...sub("canceled", 3) });
    if (p.endsWith("/attach")) return j({ id: "pm_9" });
    if (p.startsWith("/v1/customers/")) return j({ id: "cus_1" });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const io: Io & { lines: string[] } = {
    lines: [],
    fetch: f,
    log: (s) => io.lines.push(s),
    registryGet: async (key) =>
      key === `install:${ID}`
        ? over.registry === undefined
          ? JSON.stringify({
              installId: ID,
              origin: `https://${SLUG}.${STAGING_APP_ZONE}`,
            })
          : over.registry
        : null,
    platformDb: {
      all: async (sql) => {
        writes.push(sql);
        const r =
          over.platform === undefined
            ? {
                id: ID,
                slug: SLUG,
                app_host: `${SLUG}.${STAGING_APP_ZONE}`,
                state: "active",
              }
            : over.platform;
        return r ? [r] : [];
      },
      exec: async () => {},
    },
    billingDb: {
      all: async (sql, params) => {
        writes.push(params ? `${sql} <- ${JSON.stringify(params)}` : sql);
        if (sql.startsWith("UPDATE")) customer = String(params?.[0]);
        return [{ stripe_customer_id: customer }];
      },
      exec: async () => {},
    },
  };
  return { io, seen, writes, call: stripeClient(KEY, f) };
}

describe("refusals", () => {
  it("a live key", () => {
    expect(() => stripeClient("sk_live_FAKEfakeFAKE0123", fetch)).toThrow(
      Refused,
    );
    expect(() => stripeClient("", fetch)).toThrow(Refused);
    expect(() =>
      stripeClient("rk_test_FAKEfakeFAKEfake0123", fetch),
    ).not.toThrow();
  });

  it.each([
    "rl-a",
    "rl-b",
    "m2-walk",
    "bill-proof",
    "bill-proofx",
    "xbill-proof-1",
    "Bill-proof-1",
  ])("the slug %s", async (slug) => {
    const w = world();
    await expect(run(w.io, w.call, { ...IN, slug })).rejects.toThrow(
      "bill-proof-",
    );
    expect(w.seen).toEqual([]);
  });

  it("an install whose host is not on the staging app zone (prod)", async () => {
    const w = world({
      platform: {
        id: ID,
        slug: SLUG,
        app_host: `${SLUG}.open-artifacts.app`,
        state: "active",
      },
    });
    await expect(run(w.io, w.call, IN)).rejects.toThrow(/staging app zone/);
    expect(w.seen).toEqual([]);
  });

  it("a registry origin that is not the proof install's, or missing", async () => {
    for (const registry of [
      JSON.stringify({
        installId: ID,
        origin: "https://rl-a.open-artifacts-staging.app",
      }),
      JSON.stringify({
        installId: "iother0000000",
        origin: `https://${SLUG}.${STAGING_APP_ZONE}`,
      }),
      null,
      "not json",
    ]) {
      const w = world({ registry });
      await expect(resolveInstall(w.io, SLUG)).rejects.toThrow(Refused);
    }
  });

  it("an unknown or inactive install", async () => {
    await expect(
      resolveInstall(world({ platform: null }).io, SLUG),
    ).rejects.toThrow(/no such install/);
    await expect(
      resolveInstall(
        world({
          platform: {
            id: ID,
            slug: SLUG,
            app_host: `${SLUG}.${STAGING_APP_ZONE}`,
            state: "deleting",
          },
        }).io,
        SLUG,
      ),
    ).rejects.toThrow(/not active/);
  });

  it("a price that is not staging's Team monthly price", async () => {
    const w = world();
    await expect(
      run(w.io, w.call, { ...IN, priceTeam: "price_other" }),
    ).rejects.toThrow(/Team monthly price/);
    expect(w.seen).toEqual([]);
  });

  it("an unknown action", async () => {
    const w = world();
    await expect(
      run(w.io, w.call, { ...IN, action: "delete" }),
    ).rejects.toThrow(/ACTION/);
  });

  it("create with a live proof subscription already there", async () => {
    const w = world({
      subs: [
        {
          id: "sub_1",
          status: "active",
          metadata: { proof: "2123" },
          items: { data: [] },
        },
      ],
    });
    await expect(run(w.io, w.call, IN)).rejects.toThrow(/cancel it first/);
    expect(w.seen.some((s) => s.method === "POST")).toBe(false);
  });
});

describe("request shapes", () => {
  it("create on the mapped customer: card, default, one Team monthly sub at quantity 1", async () => {
    const w = world({ subs: [] });
    await run(w.io, w.call, IN);
    const posts = w.seen.filter((s) => s.method === "POST");
    expect(posts.map((p) => p.path)).toEqual([
      "/v1/payment_methods/pm_card_visa/attach",
      "/v1/customers/cus_1",
      "/v1/subscriptions",
    ]);
    expect(posts[0]?.form).toEqual({ customer: "cus_1" });
    expect(posts[1]?.form).toEqual({
      "invoice_settings[default_payment_method]": "pm_9",
    });
    expect(posts[2]?.form).toEqual({
      customer: "cus_1",
      "items[0][price]": PRICE,
      "items[0][quantity]": "1",
      default_payment_method: "pm_9",
      "metadata[tier]": "team",
      "metadata[proof]": "2123",
    });
    expect(w.io.lines).toEqual([
      `subscription sub_1 status active quantity 1 price ${PRICE}`,
    ]);
    expect(w.writes.some((q) => q.startsWith("UPDATE"))).toBe(false);
  });

  it("create with no customer makes one as /checkout does and maps it", async () => {
    const w = world({ customer: null, subs: [] });
    await run(w.io, w.call, IN);
    const mk = w.seen.find((s) => s.path === "/v1/customers");
    expect(mk?.form).toEqual({ "metadata[install_id]": ID });
    expect(mk?.headers["idempotency-key"]).toBe(`cust-${ID}`);
    expect(
      w.writes.some(
        (q) =>
          q.startsWith(
            "UPDATE tiers SET stripe_customer_id = ?1 WHERE install_id = ?2 AND stripe_customer_id IS NULL",
          ) && q.includes(`["cus_new","${ID}"]`),
      ),
    ).toBe(true);
    expect(
      w.seen.find((s) => s.path === "/v1/subscriptions" && s.method === "POST")
        ?.form.customer,
    ).toBe("cus_new");
  });

  it("read prints the quantity and writes nothing", async () => {
    const w = world();
    await run(w.io, w.call, { ...IN, action: "read" });
    expect(w.seen.every((s) => s.method === "GET")).toBe(true);
    expect(w.io.lines).toEqual([
      `subscription sub_1 status active quantity 3 price ${PRICE}`,
    ]);
  });

  it("cancel deletes only the proof subscription", async () => {
    const w = world({
      subs: [
        {
          id: "sub_other",
          status: "active",
          metadata: {},
          items: { data: [] },
        },
        {
          id: "sub_1",
          status: "active",
          metadata: { proof: "2123" },
          items: { data: [{ quantity: 3, price: { id: PRICE } }] },
        },
      ],
    });
    await run(w.io, w.call, { ...IN, action: "cancel" });
    expect(
      w.seen
        .filter((s) => s.method !== "GET")
        .map((s) => `${s.method} ${s.path}`),
    ).toEqual(["DELETE /v1/subscriptions/sub_1"]);
    expect(w.io.lines[0]).toContain("status canceled");
  });
});

describe("no secret in output", () => {
  it("a 403 names only the permissions, never the key", async () => {
    const f = (async () =>
      Response.json(
        {
          error: {
            code: "x",
            message: `key ${KEY} needs rak_subscription_write`,
          },
        },
        { status: 403 },
      )) as unknown as typeof fetch;
    const err = await stripeClient(KEY, f)(
      "POST",
      "/v1/subscriptions/sub_abc",
      {},
    ).catch((e: Error) => e);
    expect(String((err as Error).message)).toContain("rak_subscription_write");
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(String((err as Error).message)).not.toContain("sub_abc");
  });

  it("no log line holds the key", async () => {
    for (const action of ["create", "read", "cancel"]) {
      const w = world(action === "create" ? { subs: [] } : {});
      await run(w.io, w.call, { ...IN, action });
      expect(w.io.lines.join("\n")).not.toContain(KEY);
    }
  });
});

describe("staging-team-proof.yml", () => {
  // biome-ignore lint/suspicious/noExplicitAny: untyped workflow YAML
  const w: any = parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../.github/workflows/staging-team-proof.yml",
      ),
      "utf8",
    ),
  );
  const text = readFileSync(
    join(import.meta.dirname, "../../.github/workflows/staging-team-proof.yml"),
    "utf8",
  );
  it("is dispatch only, staging only, main only, bill-proof- slugs only", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual([
      "slug",
      "action",
    ]);
    expect(w.permissions).toEqual({ contents: "read" });
    expect(w.jobs.proof.environment).toBe("hosted-staging-deploy");
    expect(w.jobs.proof.steps[0].run).toContain("refs/heads/main");
    expect(w.jobs.proof.steps[0].run).toContain("bill-proof-");
  });
  it("passes the key by secret env only and never traces or echoes", () => {
    expect(text).not.toMatch(/set -x|set -o xtrace|echo .*STRIPE/);
    const withKey =
      JSON.stringify(w).split("secrets.STRIPE_SECRET_KEY").length - 1;
    expect(withKey).toBe(1);
  });
  it("staging's app zone is the one the script pins", () => {
    const staging = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../.github/hosted/staging.json"),
        "utf8",
      ),
    );
    expect(staging.app_zone).toBe(STAGING_APP_ZONE);
  });
});
