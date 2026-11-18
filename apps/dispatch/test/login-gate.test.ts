import { GATE_MAX_BODY } from "@oa/broker-core/gate";
import { describe, expect, it } from "vitest";
import {
  LOGIN_GATE_PATH,
  LOGIN_ORIGIN,
  type LoginGateEnv,
  type LoginGateProps,
  loginProps,
  passLoginGate,
} from "../src/login-gate.js";

// LoginGate is an install's only path to the platform's login-domain change.
// Each case is one of its refusals, or proof that an allowed call reaches only
// the LOGIN binding, on the fixed route, with the gate's own install header.

const A = "iabc123def45";
const B = "izzz999yyy88";
const props: LoginGateProps = { installId: A };

function world() {
  const got: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }[] = [];
  const env: LoginGateEnv = {
    LOGIN: {
      fetch: async (req: Request) => {
        got.push({
          url: req.url,
          method: req.method,
          headers: Object.fromEntries(req.headers),
          body: await req.text(),
        });
        return Response.json({ ok: true }, { status: 202 });
      },
    } as unknown as Fetcher,
  };
  return { env, got };
}

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(`https://anything.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const err = async (r: Response) => {
  expect(r.headers.get("x-oa-gate")).toBe("1");
  return { status: r.status, ...((await r.json()) as object) };
};

describe("LoginGate", () => {
  it("forwards the fixed route with the gate's install and the assertion headers only", async () => {
    const { env, got } = world();
    const b = { ts: 1, nonce: "n".repeat(16), domains: [], autoJoin: false };
    const r = await passLoginGate(
      post(LOGIN_GATE_PATH, b, {
        "x-oa-kid": "kid1",
        "x-oa-sig": "sig1",
        "x-oa-gate-install": B,
        "x-oa-gate-app-host": "evil.example",
        "cf-connecting-ip": "1.2.3.4",
        authorization: "Bearer x",
        cookie: "a=b",
      }),
      props,
      env,
    );
    expect(r.status).toBe(202);
    expect(got).toHaveLength(1);
    expect(got[0]?.url).toBe(`${LOGIN_ORIGIN}${LOGIN_GATE_PATH}`);
    expect(got[0]?.method).toBe("POST");
    expect(got[0]?.headers).toEqual({
      "content-type": "application/json",
      "x-oa-kid": "kid1",
      "x-oa-sig": "sig1",
      // The gate's own install, never the caller's.
      "x-oa-gate-install": A,
    });
    expect(JSON.parse(got[0]?.body ?? "")).toEqual(b);
  });

  it.each([
    ["another route", () => post("/tier", {})],
    ["a query string", () => post(`${LOGIN_GATE_PATH}?install=${B}`, {})],
    ["GET", () => new Request(`https://x.example${LOGIN_GATE_PATH}`)],
    ["a trailing slash", () => post(`${LOGIN_GATE_PATH}/`, {})],
  ])("404s %s", async (_n, mk) => {
    const { env, got } = world();
    expect(await err(await passLoginGate(mk(), props, env))).toEqual({
      status: 404,
      error: "not_found",
    });
    expect(got).toHaveLength(0);
  });

  it("refuses a body that isn't JSON, is too large, or isn't an object", async () => {
    const { env, got } = world();
    const text = new Request(`https://x.example${LOGIN_GATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    expect((await err(await passLoginGate(text, props, env))).status).toBe(415);
    const big = post(LOGIN_GATE_PATH, "x".repeat(GATE_MAX_BODY + 1));
    expect((await err(await passLoginGate(big, props, env))).status).toBe(413);
    expect(
      (
        await err(
          await passLoginGate(post(LOGIN_GATE_PATH, "nope"), props, env),
        )
      ).status,
    ).toBe(400);
    expect(
      (await err(await passLoginGate(post(LOGIN_GATE_PATH, "[]"), props, env)))
        .status,
    ).toBe(400);
    expect(got).toHaveLength(0);
  });

  it("is a 500 for missing or malformed props", async () => {
    const { env, got } = world();
    for (const p of [undefined, { installId: "nope" }, { installId: 7 }])
      expect(
        (
          await err(
            await passLoginGate(
              post(LOGIN_GATE_PATH, {}),
              p as unknown as LoginGateProps,
              env,
            ),
          )
        ).status,
      ).toBe(500);
    expect(got).toHaveLength(0);
  });

  it("loginProps gives a stub for that install only, and none without LOGIN", () => {
    const made: LoginGateProps[] = [];
    const exports = {
      LoginGate: (o: { props: LoginGateProps }) => {
        made.push(o.props);
        return {} as Fetcher;
      },
    };
    const on = { LOGIN: {} as Fetcher, LOGIN_CHANGE: "1" };
    expect(loginProps(exports, A, "acme", { LOGIN_CHANGE: "1" })).toEqual({});
    expect(made).toHaveLength(0);
    const out = loginProps(exports, A, "acme", on);
    expect(Object.keys(out)).toEqual(["LOGIN"]);
    expect(made).toEqual([{ installId: A }]);
  });

  it("with the switch off, only a listed slug gets the stub (#2520)", () => {
    const made: LoginGateProps[] = [];
    const exports = {
      LoginGate: (o: { props: LoginGateProps }) => {
        made.push(o.props);
        return {} as Fetcher;
      },
    };
    const off = {
      LOGIN: {} as Fetcher,
      LOGIN_CHANGE: "0",
      LOGIN_CHANGE_SLUGS: " leo , other ",
    };
    expect(Object.keys(loginProps(exports, A, "leo", off))).toEqual(["LOGIN"]);
    expect(loginProps(exports, A, "acme", off)).toEqual({});
    expect(loginProps(exports, A, "le", off)).toEqual({});
    expect(loginProps(exports, A, "", off)).toEqual({});
    expect(loginProps(exports, A, "leo", { LOGIN: {} as Fetcher })).toEqual({});
    expect(made).toEqual([{ installId: A }]);
  });
});
