import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { livemodeProblems } from "./stripe-price-livemode.ts";

const root = join(import.meta.dirname, "../..");
const KEY = "rk_live_NEVERAPPEAR01234";
const PRICES = {
  STRIPE_PRICE_TEAM: "price_Team1",
  STRIPE_PRICE_BUSINESS: "price_Biz1",
  STRIPE_PRICE_SOLO_MONTHLY: "price_SoloM1",
  STRIPE_PRICE_SOLO_YEARLY: "price_SoloY1",
};
const fake = (answer: (id: string) => Response | Promise<Response>) => {
  const seen: { url: string; auth: string | null }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      auth: new Headers(init.headers).get("authorization"),
    });
    return answer(url.split("/").pop() as string);
  }) as unknown as typeof fetch;
  return { f, seen };
};

describe("livemodeProblems", () => {
  it("passes when every configured price answers livemode true; GETs only, the key as a bearer", async () => {
    const { f, seen } = fake(() => Response.json({ livemode: true }));
    expect(await livemodeProblems(PRICES, KEY, f)).toEqual([]);
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.stripe.com/v1/prices/price_Team1",
      "https://api.stripe.com/v1/prices/price_Biz1",
      "https://api.stripe.com/v1/prices/price_SoloM1",
      "https://api.stripe.com/v1/prices/price_SoloY1",
    ]);
    for (const s of seen) expect(s.auth).toBe(`Bearer ${KEY}`);
  });
  it("skips an unset optional price", async () => {
    const { f, seen } = fake(() => Response.json({ livemode: true }));
    await livemodeProblems({ ...PRICES, STRIPE_PRICE_TEAM_YEARLY: "" }, KEY, f);
    expect(seen).toHaveLength(4);
  });
  it("refuses a price that is livemode false, naming its variable", async () => {
    const { f } = fake((id) =>
      Response.json({ livemode: id !== "price_Biz1" }),
    );
    expect(await livemodeProblems(PRICES, KEY, f)).toEqual([
      "STRIPE_PRICE_BUSINESS: the price is not live mode (livemode is not true)",
    ]);
  });
  it("fails closed: not found, a non-200, a missing or non-boolean livemode, a bad body, a thrown fetch", async () => {
    for (const answer of [
      () => Response.json({ error: {} }, { status: 404 }),
      () => Response.json({}, { status: 500 }),
      () => Response.json({}),
      () => Response.json({ livemode: "true" }),
      () => new Response("not json"),
      () => {
        throw new Error("network");
      },
    ]) {
      const { f } = fake(answer);
      expect(
        await livemodeProblems({ STRIPE_PRICE_TEAM: "price_Team1" }, KEY, f),
      ).toHaveLength(1);
    }
  });
  it("refuses a malformed price id without a call", async () => {
    const { f, seen } = fake(() => Response.json({ livemode: true }));
    expect(
      await livemodeProblems({ STRIPE_PRICE_TEAM: "prod_1" }, KEY, f),
    ).toEqual(["STRIPE_PRICE_TEAM is not a Stripe price id"]);
    expect(seen).toEqual([]);
  });
  it("never prints the key or an answer body", async () => {
    const { f } = fake(() =>
      Response.json({ livemode: false, secret: "NEVERAPPEARbody" }),
    );
    const p = (await livemodeProblems(PRICES, KEY, f)).join("\n");
    expect(p).not.toContain(KEY);
    expect(p).not.toContain("NEVERAPPEARbody");
  });
});

describe("the script", () => {
  it("refuses before any call: not prod, a test key, sk_live_, or no key", () => {
    const exec = (arg: string, key: string) =>
      spawnSync(
        "node",
        [
          "--experimental-strip-types",
          "--no-warnings",
          join(root, "scripts/ops/stripe-price-livemode.ts"),
          arg,
        ],
        {
          env: {
            PATH: process.env.PATH ?? "",
            STRIPE_SECRET_KEY: key,
            ...PRICES,
          },
          encoding: "utf8",
        },
      );
    expect(exec("staging", KEY).status).toBe(2);
    for (const key of [
      "",
      "sk_test_abcdefgh1234",
      "rk_test_abcdefgh1234",
      "sk_live_abcdefgh1234",
    ]) {
      const r = exec("prod", key);
      expect(r.status, key).toBe(2);
      if (key) expect(r.stdout + r.stderr).not.toContain(key);
    }
  });
});
