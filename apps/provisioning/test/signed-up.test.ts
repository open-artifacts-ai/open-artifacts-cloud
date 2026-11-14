import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeRoute } from "../src/routes/invoke.js";
import { HTTP } from "./call.js";
import { platformDb } from "./db.js";
import { ADMIN_P, fakeEnv, requestId, resetDb, userP } from "./fakes.js";

// #2479: `signed_up` to PostHog, once per self-serve install, off without a key.

beforeEach(async () => {
  await platformDb();
  await resetDb();
});
afterEach(() => vi.unstubAllGlobals());

const pending: Promise<unknown>[] = [];
const ctx = () =>
  ({
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  }) as unknown as ExecutionContext;

const selfServe = () => ({
  requestId: requestId(),
  slug: "acme",
  turnstile: "tok",
});
const adminBody = () => ({
  requestId: requestId(),
  slug: "adm",
  ownerEmail: "o@test.invalid",
  tier: "business",
  auth: { providers: ["google"], domains: ["test.invalid"] },
  sendWelcome: false,
});
const user = { ...userP("u1"), hd: "acme.test" };
const env = (over = {}) =>
  fakeEnv({ SIGNUPS_ENABLED: "true", ...over } as never);
const flush = async () => {
  await Promise.allSettled(pending.splice(0));
};

describe("signed_up", () => {
  it("no key: no call", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await invokeRoute(
      env().env,
      ctx(),
      user,
      "R4",
      { body: selfServe() },
      HTTP,
    );
    await flush();
    expect(r.status).toBe(202);
    expect(f).not.toHaveBeenCalled();
  });

  it("self-serve create: exactly one call with exactly the allowed fields", async () => {
    const f = vi.fn(async (..._a: unknown[]) => new Response("{}"));
    vi.stubGlobal("fetch", f);
    const e = env({ POSTHOG_KEY: "phc_test" });
    const r = await invokeRoute(
      e.env,
      ctx(),
      user,
      "R4",
      { body: selfServe() },
      HTTP,
    );
    await flush();
    expect(r.status).toBe(202);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://us.i.posthog.com/capture/");
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual([
      "api_key",
      "distinct_id",
      "event",
      "properties",
    ]);
    expect(body.api_key).toBe("phc_test");
    expect(body.event).toBe("signed_up");
    expect(body.distinct_id).toMatch(/^i/);
    expect(Object.keys(body.properties).sort()).toEqual([
      "$geoip_disable",
      "instance_id",
      "plan",
      "time",
    ]);
    expect(body.properties).toMatchObject({
      instance_id: body.distinct_id,
      plan: "trial",
      $geoip_disable: true,
    });
    expect(new Date(body.properties.time).toISOString()).toBe(
      body.properties.time,
    );
    const s = JSON.stringify(body);
    for (const x of ["u1", "acme", "@"]) expect(s).not.toContain(x);
  });

  it("POSTHOG_HOST overrides the host", async () => {
    const f = vi.fn(async (..._a: unknown[]) => new Response("{}"));
    vi.stubGlobal("fetch", f);
    const e = env({ POSTHOG_KEY: "k", POSTHOG_HOST: "https://eu.example/" });
    await invokeRoute(e.env, ctx(), user, "R4", { body: selfServe() }, HTTP);
    await flush();
    expect(f.mock.calls[0]?.[0]).toBe("https://eu.example/capture/");
  });

  it("admin create: no call", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const e = env({ POSTHOG_KEY: "k" });
    const r = await invokeRoute(
      e.env,
      ctx(),
      ADMIN_P,
      "R4",
      { body: adminBody() },
      HTTP,
    );
    await flush();
    expect(r.status).toBe(202);
    expect(f).not.toHaveBeenCalled();
  });

  it("a replayed create sends nothing more", async () => {
    const f = vi.fn(async (..._a: unknown[]) => new Response("{}"));
    vi.stubGlobal("fetch", f);
    const e = env({ POSTHOG_KEY: "k" });
    const body = selfServe();
    await invokeRoute(e.env, ctx(), user, "R4", { body }, HTTP);
    await invokeRoute(e.env, ctx(), user, "R4", { body }, HTTP);
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a throwing fetch does not affect the response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom me@x.test");
      }),
    );
    const e = env({ POSTHOG_KEY: "k" });
    const r = await invokeRoute(
      e.env,
      ctx(),
      user,
      "R4",
      { body: selfServe() },
      HTTP,
    );
    await flush();
    expect(r.status).toBe(202);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("me@x.test");
    warn.mockRestore();
  });

  it("a never-resolving fetch does not delay the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const e = env({ POSTHOG_KEY: "k" });
    const r = await invokeRoute(
      e.env,
      ctx(),
      user,
      "R4",
      { body: selfServe() },
      HTTP,
    );
    expect(r.status).toBe(202);
    pending.splice(0);
  });
});
