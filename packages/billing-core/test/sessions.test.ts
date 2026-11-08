import { describe, expect, it } from "vitest";
import {
  createCheckoutSession,
  createCustomer,
  createPortalSession,
  cancelSubscription,
  createSoloTrialSubscription,
  SOLO_TRIAL_DAYS,
  StripeApiError,
  StripeConfigError,
} from "../src/index.js";

// Checkout and Portal against a fake fetch: no Stripe call leaves the test,
// and no real key exists anywhere (a made-up test-mode key).
const KEY = "sk_test_notarealkey0000";

type Seen = { url: string; init: RequestInit };
const fake = (answer: unknown, status = 200) => {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Response.json(answer, { status });
  }) as unknown as typeof fetch;
  return { seen, f };
};
const form = (s: Seen) =>
  Object.fromEntries(new URLSearchParams(String(s.init.body)));
const header = (s: Seen, h: string) => new Headers(s.init.headers).get(h);

const checkout = {
  customerId: "cus_Test1",
  priceId: "price_Team1",
  successUrl: "https://app.example.com/settings/billing?done=1",
  cancelUrl: "https://app.example.com/settings/billing",
  idempotencyKey: "checkout:iabc123def45:team:1",
  tier: "team" as const,
};

describe("createCheckoutSession", () => {
  it("one form POST with the Idempotency-Key; answers the id and URL", async () => {
    const { seen, f } = fake({
      id: "cs_test_1",
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
    });
    expect(
      await createCheckoutSession(checkout, { secretKey: KEY, fetch: f }),
    ).toEqual({
      id: "cs_test_1",
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
    });
    expect(seen).toHaveLength(1);
    const s = seen[0] as Seen;
    expect(s.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(header(s, "idempotency-key")).toBe(checkout.idempotencyKey);
    expect(header(s, "authorization")).toBe(`Bearer ${KEY}`);
    expect(form(s)).toEqual({
      mode: "subscription",
      customer: "cus_Test1",
      "line_items[0][price]": "price_Team1",
      "line_items[0][quantity]": "1",
      success_url: checkout.successUrl,
      cancel_url: checkout.cancelUrl,
      "metadata[tier]": "team",
      "subscription_data[metadata][tier]": "team",
    });
  });

  it("refuses live keys, bad ids and non-https URLs before any call", async () => {
    const { seen, f } = fake({});
    const bad = [
      [
        { ...checkout },
        { secretKey: "sk_live_abcdefghij", fetch: f },
        "secretKey",
      ],
      [
        { ...checkout },
        { secretKey: "rk_live_abcdefghij", fetch: f },
        "secretKey",
      ],
      [
        { ...checkout, successUrl: "http://app.example.com/" },
        { secretKey: KEY, fetch: f },
        "successUrl",
      ],
      [
        { ...checkout, cancelUrl: "javascript:alert(1)" },
        { secretKey: KEY, fetch: f },
        "cancelUrl",
      ],
      [
        { ...checkout, customerId: "cus_x&mode=payment" },
        { secretKey: KEY, fetch: f },
        "customerId",
      ],
      [
        { ...checkout, idempotencyKey: "short" },
        { secretKey: KEY, fetch: f },
        "idempotencyKey",
      ],
      [{ ...checkout, quantity: 0 }, { secretKey: KEY, fetch: f }, "quantity"],
      [
        { ...checkout, tier: "enterprise" as "team" },
        { secretKey: KEY, fetch: f },
        "tier",
      ],
    ] as const;
    for (const [input, cfg, field] of bad) {
      let e: unknown;
      try {
        await createCheckoutSession(input, cfg);
      } catch (x) {
        e = x;
      }
      expect(e).toBeInstanceOf(StripeConfigError);
      expect((e as StripeConfigError).field).toBe(field);
    }
    expect(seen).toEqual([]);
  });

  it("a Stripe error keeps its status and type only; a non-Stripe URL is refused", async () => {
    const err = fake(
      {
        error: {
          type: "invalid_request_error",
          message: "No such customer: cus_Test1",
        },
      },
      400,
    );
    const e = await createCheckoutSession(checkout, {
      secretKey: KEY,
      fetch: err.f,
    }).catch((x) => x);
    expect(e).toBeInstanceOf(StripeApiError);
    expect([e.status, e.type]).toEqual([400, "invalid_request_error"]);
    expect(String(e.message)).not.toContain("cus_Test1");
    const odd = fake({ id: "cs_test_1", url: "https://evil.example/pay" });
    await expect(
      createCheckoutSession(checkout, { secretKey: KEY, fetch: odd.f }),
    ).rejects.toBeInstanceOf(StripeApiError);
  });
});

describe("createPortalSession", () => {
  it("one form POST with the Idempotency-Key; answers the portal URL", async () => {
    const { seen, f } = fake({
      id: "bps_test_1",
      url: "https://billing.stripe.com/p/session/test_1",
    });
    const out = await createPortalSession(
      {
        customerId: "cus_Test1",
        returnUrl: "https://app.example.com/settings/billing",
        idempotencyKey: "portal:iabc123def45:1",
      },
      { secretKey: KEY, fetch: f },
    );
    expect(out.url).toBe("https://billing.stripe.com/p/session/test_1");
    const s = seen[0] as Seen;
    expect(s.url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    expect(header(s, "idempotency-key")).toBe("portal:iabc123def45:1");
    expect(form(s)).toEqual({
      customer: "cus_Test1",
      return_url: "https://app.example.com/settings/billing",
    });
  });
});

describe("createCustomer", () => {
  const input = {
    installId: "iabc123def45",
    idempotencyKey: "cust-iabc123def45",
  };

  it("one form POST with metadata[install_id] and the Idempotency-Key; answers the cus_ id only", async () => {
    const { seen, f } = fake({
      id: "cus_Test1",
      object: "customer",
      email: null,
      metadata: { install_id: "iabc123def45" },
    });
    expect(await createCustomer(input, { secretKey: KEY, fetch: f })).toEqual({
      id: "cus_Test1",
    });
    expect(seen).toHaveLength(1);
    const s = seen[0] as Seen;
    expect(s.url).toBe("https://api.stripe.com/v1/customers");
    expect(s.init.method).toBe("POST");
    expect(header(s, "idempotency-key")).toBe("cust-iabc123def45");
    expect(header(s, "authorization")).toBe(`Bearer ${KEY}`);
    expect(form(s)).toEqual({ "metadata[install_id]": "iabc123def45" });
  });

  it("refuses a live key, a bad install id or key before any call", async () => {
    const { seen, f } = fake({ id: "cus_Test1" });
    const bad = [
      [input, "sk_live_abcdefghij", "secretKey"],
      [input, "rk_live_abcdefghij", "secretKey"],
      [{ ...input, installId: "Iabc123def45" }, KEY, "installId"],
      [{ ...input, installId: "iabc123def4" }, KEY, "installId"],
      [{ ...input, installId: "iabc123def45&x=1" }, KEY, "installId"],
      [{ ...input, idempotencyKey: "short" }, KEY, "idempotencyKey"],
    ] as const;
    for (const [i, secretKey, field] of bad) {
      const e = await createCustomer(i, { secretKey, fetch: f }).catch(
        (x) => x,
      );
      expect(e).toBeInstanceOf(StripeConfigError);
      expect((e as StripeConfigError).field).toBe(field);
    }
    expect(seen).toEqual([]);
  });

  it("an answer without a cus_ id is bad_answer; a Stripe error keeps status and type only", async () => {
    for (const answer of [{ id: "acct_1" }, {}, { id: 7 }, ["cus_x"]]) {
      const e = await createCustomer(input, {
        secretKey: KEY,
        fetch: fake(answer).f,
      }).catch((x) => x);
      expect(e).toBeInstanceOf(StripeApiError);
      expect([e.status, e.type]).toEqual([200, "bad_answer"]);
    }
    const e = await createCustomer(input, {
      secretKey: KEY,
      fetch: fake(
        {
          error: {
            type: "idempotency_error",
            message: "Keys for idempotent requests ... iabc123def45",
          },
        },
        400,
      ).f,
    }).catch((x) => x);
    expect(e).toBeInstanceOf(StripeApiError);
    expect([e.status, e.type]).toEqual([400, "idempotency_error"]);
    expect(String(e.message)).toBe("stripe 400 idempotency_error");
  });
});

describe("Solo (#1568)", () => {
  it("a Solo Checkout is a plain subscription session tagged tier solo", async () => {
    const { seen, f } = fake({
      id: "cs_test_9",
      url: "https://checkout.stripe.com/c/pay/cs_test_9",
    });
    await createCheckoutSession(
      { ...checkout, tier: "solo", priceId: "price_Solo1" },
      { secretKey: KEY, fetch: f },
    );
    const body = form(seen[0] as Seen);
    expect(body["line_items[0][price]"]).toBe("price_Solo1");
    expect(body["metadata[tier]"]).toBe("solo");
    expect(body["subscription_data[metadata][tier]"]).toBe("solo");
    expect(body["line_items[0][quantity]"]).toBe("1");
    // No trial through Checkout: the no-card trial is made through the API.
    expect(Object.keys(body).filter((k) => /trial/.test(k))).toEqual([]);
  });

  const trial = {
    customerId: "cus_Test1",
    priceId: "price_SoloM1",
    idempotencyKey: "solo-trial-iabc123def45",
  };

  it("the no-card trial: 30 days, canceled if no card is added, keyed, tagged solo", async () => {
    const { seen, f } = fake({ id: "sub_Test1", object: "subscription" });
    expect(
      await createSoloTrialSubscription(trial, { secretKey: KEY, fetch: f }),
    ).toEqual({ id: "sub_Test1" });
    expect(SOLO_TRIAL_DAYS).toBe(30);
    expect(seen).toHaveLength(1);
    const s = seen[0] as Seen;
    expect(s.url).toBe("https://api.stripe.com/v1/subscriptions");
    expect(s.init.method).toBe("POST");
    expect(header(s, "idempotency-key")).toBe(trial.idempotencyKey);
    expect(header(s, "authorization")).toBe(`Bearer ${KEY}`);
    expect(form(s)).toEqual({
      customer: "cus_Test1",
      "items[0][price]": "price_SoloM1",
      trial_period_days: "30",
      "trial_settings[end_behavior][missing_payment_method]": "cancel",
      "metadata[tier]": "solo",
    });
  });

  it("refuses a live key, a bad customer, price or key before any call", async () => {
    const { seen, f } = fake({ id: "sub_Test1" });
    const bad = [
      [trial, "sk_live_abcdefghij", "secretKey"],
      [trial, "rk_live_abcdefghij", "secretKey"],
      [
        { ...trial, customerId: "cus_x&trial_period_days=0" },
        KEY,
        "customerId",
      ],
      [{ ...trial, priceId: "prod_1" }, KEY, "priceId"],
      [{ ...trial, priceId: "price_1&x=1" }, KEY, "priceId"],
      [{ ...trial, idempotencyKey: "short" }, KEY, "idempotencyKey"],
    ] as const;
    for (const [i, secretKey, field] of bad) {
      const e = await createSoloTrialSubscription(i, {
        secretKey,
        fetch: f,
      }).catch((x) => x);
      expect(e).toBeInstanceOf(StripeConfigError);
      expect((e as StripeConfigError).field).toBe(field);
    }
    expect(seen).toEqual([]);
  });

  it("an answer without a sub_ id is bad_answer; a Stripe error keeps status and type only", async () => {
    for (const answer of [{ id: "cus_1" }, {}, { id: 7 }]) {
      const e = await createSoloTrialSubscription(trial, {
        secretKey: KEY,
        fetch: fake(answer).f,
      }).catch((x) => x);
      expect(e).toBeInstanceOf(StripeApiError);
      expect([e.status, e.type]).toEqual([200, "bad_answer"]);
    }
    const e = await createSoloTrialSubscription(trial, {
      secretKey: KEY,
      fetch: fake(
        { error: { type: "invalid_request_error", message: "cus_Test1" } },
        400,
      ).f,
    }).catch((x) => x);
    expect([e.status, e.type, String(e.message)]).toEqual([
      400,
      "invalid_request_error",
      "stripe 400 invalid_request_error",
    ]);
  });
});

describe("cancelSubscription (#1568)", () => {
  const calls: {
    method: string;
    url: string;
    auth: string | null;
    body: unknown;
  }[] = [];
  /** A fetch that answers per method: the subscription's state, then the delete. */
  const stripe = (o: {
    get?: [unknown, number?];
    del?: [unknown, number?];
  }) => {
    calls.length = 0;
    return (async (url: string, init: RequestInit) => {
      const method = String(init.method);
      calls.push({
        method,
        url,
        auth: new Headers(init.headers).get("authorization"),
        body: init.body,
      });
      const [b, st] = (method === "GET" ? o.get : o.del) ?? [{ id: "sub_X1" }];
      return Response.json(b, { status: st ?? 200 });
    }) as unknown as typeof fetch;
  };

  it("reads the subscription, then cancels it when it is not canceled yet", async () => {
    const f = stripe({ get: [{ id: "sub_Old1", status: "active" }] });
    expect(
      await cancelSubscription(
        { subscriptionId: "sub_Old1" },
        { secretKey: KEY, fetch: f },
      ),
    ).toEqual({ id: "sub_Old1" });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "https://api.stripe.com/v1/subscriptions/sub_Old1"],
      ["DELETE", "https://api.stripe.com/v1/subscriptions/sub_Old1"],
    ]);
    for (const c of calls) {
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.body).toBeUndefined();
    }
  });

  it("already canceled, or gone (404 on either call): done, and no second delete", async () => {
    await cancelSubscription(
      { subscriptionId: "sub_Old1" },
      {
        secretKey: KEY,
        fetch: stripe({ get: [{ id: "sub_Old1", status: "canceled" }] }),
      },
    );
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    await cancelSubscription(
      { subscriptionId: "sub_Old1" },
      {
        secretKey: KEY,
        fetch: stripe({
          get: [{ error: { type: "invalid_request_error" } }, 404],
        }),
      },
    );
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    await cancelSubscription(
      { subscriptionId: "sub_Old1" },
      {
        secretKey: KEY,
        fetch: stripe({
          get: [{ id: "sub_Old1", status: "active" }],
          del: [{ error: { type: "invalid_request_error" } }, 404],
        }),
      },
    );
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
  });

  it("another Stripe error keeps status and type only", async () => {
    const e = await cancelSubscription(
      { subscriptionId: "sub_Old1" },
      {
        secretKey: KEY,
        fetch: stripe({
          get: [{ id: "sub_Old1", status: "active" }],
          del: [
            { error: { type: "api_error", message: "sub_Old1 cus_1" } },
            500,
          ],
        }),
      },
    ).catch((x) => x);
    expect([e.status, e.type, String(e.message)]).toEqual([
      500,
      "api_error",
      "stripe 500 api_error",
    ]);
  });

  it("refuses a live key or a bad id before any call", async () => {
    const f = stripe({});
    for (const [id, key, field] of [
      ["sub_Old1", "sk_live_abcdefghij", "secretKey"],
      ["sub_Old1", "rk_live_abcdefghij", "secretKey"],
      ["sub_Old1/../x", KEY, "subscriptionId"],
      ["cus_1", KEY, "subscriptionId"],
    ] as const) {
      const e = await cancelSubscription(
        { subscriptionId: id },
        { secretKey: key, fetch: f },
      ).catch((x) => x);
      expect(e).toBeInstanceOf(StripeConfigError);
      expect((e as StripeConfigError).field).toBe(field);
    }
    expect(calls).toEqual([]);
  });
});
