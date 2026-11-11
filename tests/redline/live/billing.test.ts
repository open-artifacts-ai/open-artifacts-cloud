import { beforeAll, describe, expect, it } from "vitest";
import { apiReq } from "../src/fixtures.ts";
import {
  type Cred,
  readBody,
  send,
  sendProbe,
  sessionCred,
} from "../src/http.ts";
import { crossCheck } from "../src/refused.ts";
import { loadTargets, type Target, type Targets } from "../src/targets.ts";

// #873: billing isolation between installs, write-free probes only.
//
// The routes are the app's POST /api/v1/billing/{portal,checkout}
// (apps/server/src/routes/billing.ts in the public repo), admin session
// cookie only, header X-OA-Request: 1.
//
// Nothing here may write. Never send /checkout with a body that passes
// BillingCheckoutInputSchema: that creates a Stripe customer and a session.
// Every checkout probe below fails the schema in jsonBody, which runs before
// stripeUrl/billingCall, so billing is never called. The portal probes expect
// an install with no Stripe customer: billing answers 409 no_customer before
// it touches Stripe. An install that does have a customer would answer 200
// with a portal URL (a Stripe portal session): the probe then fails rather
// than pass, and says so.

let T: Targets;
const cookies = new Map<Target, Cred>();

beforeAll(async () => {
  T = await loadTargets();
  for (const t of [T.a, T.b])
    cookies.set(t, await sessionCred(t, undefined, "admin", { setup: true }));
});

const cookie = (t: Target): Cred => {
  const c = cookies.get(t);
  if (!c) throw new Error(`${t.name}: no admin session`);
  return c;
};

const post = (t: Target, c: Cred, path: string, body: unknown) =>
  apiReq(t, c, "POST", `/api/v1/billing/${path}`, body);

async function errorCode(res: Response): Promise<{
  status: number;
  code: string | undefined;
  text: string;
}> {
  const text = await readBody(res);
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
  } catch {}
  return { status: res.status, code, text };
}

const NO_CUSTOMER = { status: 409, code: "no_billing_customer" };

describe("billing: portal with no Stripe customer", () => {
  for (const side of ["a", "b"] as const) {
    it(`${side}: own admin session gets 409 no_billing_customer`, async () => {
      const t = T[side];
      const r = await errorCode(
        await sendProbe(post(t, cookie(t), "portal", {}), send),
      );
      expect({ status: r.status, code: r.code }, r.text).toEqual(NO_CUSTOMER);
    });

    it(`${side}: an extra returnUrl field is ignored, not a 400 (the route reads no body)`, async () => {
      const t = T[side];
      const r = await errorCode(
        await sendProbe(
          post(t, cookie(t), "portal", { returnUrl: "https://evil.example" }),
          send,
        ),
      );
      // The portal route never parses a body, so the field never reaches
      // billing (which would 400 bad_body on it): same answer as without.
      expect({ status: r.status, code: r.code }, r.text).toEqual(NO_CUSTOMER);
      expect(r.text).not.toContain("evil.example");
    });
  }
});

describe("billing: checkout refused before billing is called", () => {
  const BAD_BODIES: [string, unknown][] = [
    [
      "tier team with a successUrl",
      { tier: "team", successUrl: "https://evil.example" },
    ],
    ["plan instead of tier", { plan: "team" }],
    ["team with an interval", { tier: "team", interval: "month" }],
    ["solo without an interval", { tier: "solo" }],
  ];
  for (const side of ["a", "b"] as const)
    for (const [what, body] of BAD_BODIES)
      it(`${side}: ${what} gets 400 bad_request`, async () => {
        const t = T[side];
        const r = await errorCode(
          await sendProbe(post(t, cookie(t), "checkout", body), send),
        );
        expect({ status: r.status, code: r.code }, r.text).toEqual({
          status: 400,
          code: "bad_request",
        });
        expect(r.text).not.toContain("evil.example");
      });
});

describe("billing: A's admin session at B", () => {
  for (const path of ["portal"] as const)
    it(`${path}: B's own and A's own answer, A's cookie at B is refused`, async () => {
      await crossCheck((c, t) => post(t, c, path, {}), {
        a: T.a,
        b: T.b,
        credA: cookie(T.a),
        credB: cookie(T.b),
        ok: (r) => r.status === NO_CUSTOMER.status,
      });
    });

  it("portal answers carry no identifier of the other install", async () => {
    const answers = new Map<Target, string>();
    for (const t of [T.a, T.b])
      answers.set(
        t,
        await readBody(await sendProbe(post(t, cookie(t), "portal", {}), send)),
      );
    for (const [t, other] of [
      [T.a, T.b],
      [T.b, T.a],
    ] as const) {
      const text = answers.get(t) ?? "";
      for (const id of [
        other.installId,
        new URL(other.app).host,
        new URL(other.content).host,
      ])
        expect(text, `${t.name} answer names ${other.name}`).not.toContain(id);
    }
  });

  it("A's cookie at B's checkout is refused, not a 400", async () => {
    const res = await sendProbe(
      post(T.b, cookie(T.a), "checkout", { tier: "team", successUrl: "x" }),
      send,
    );
    const r = await errorCode(res);
    expect([401, 403, 404], r.text).toContain(r.status);
  });
});
