import { isApiRoute, ROUTE_IDS, ROUTES } from "@oa/provisioning-contract";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { HANDLERS } from "../src/routes/handlers.js";
import { matchRoute } from "../src/routes/table.js";
import { ADMIN, API, ctx, fakeEnv } from "./fakes.js";

const SAMPLE: Record<string, string> = {
  id: "iabc123def45",
  jobId: "01J00000000000000000000000",
  slug: "acme",
};
const fill = (path: string) =>
  path.replace(/:(\w+)\??/g, (_m, k: string) => SAMPLE[k] ?? "x");

describe("route table (3.4)", () => {
  it("has a handler for every api route; browser routes stay out of invokeRoute", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(
      ROUTE_IDS.filter((id) => ROUTES[id].base === "api").sort(),
    );
    expect(ROUTE_IDS.filter((id) => !isApiRoute(id))).toEqual([
      "R22",
      "R23",
      "R24",
    ]);
  });

  for (const id of ROUTE_IDS) {
    const r = ROUTES[id];
    it(`${id} ${r.method} ${r.path} matches only on its base`, () => {
      const path = fill(r.path);
      if (r.base === "api") {
        const api = matchRoute("api", r.method, `/v1${path}`);
        const admin = matchRoute("admin", r.method, `/api/v1${path}`);
        expect(api?.route).toBe(id);
        expect(admin?.route).toBe(id);
        expect(matchRoute("api", r.method, `/api/v1${path}`)).toBeNull();
        expect(matchRoute("admin", r.method, `/v1${path}`)).toBeNull();
        for (const k of Object.keys(api?.params ?? {}))
          expect(api?.params[k]).toBe(SAMPLE[k]);
      } else {
        expect(matchRoute("admin", r.method, path)?.route).toBe(id);
        expect(matchRoute("api", r.method, path)).toBeNull();
        expect(matchRoute("admin", r.method, `/api/v1${path}`)).toBeNull();
      }
    });
  }

  it("R21's id is optional: DELETE /tokens revokes all", () => {
    expect(matchRoute("api", "DELETE", "/v1/tokens")).toEqual({
      route: "R21",
      params: {},
    });
    expect(
      matchRoute("api", "DELETE", "/v1/tokens/01J00000000000000000000000"),
    ).toEqual({
      route: "R21",
      params: { id: "01J00000000000000000000000" },
    });
  });

  it("R2 and R4 share a path; the method picks", () => {
    expect(matchRoute("api", "GET", "/v1/installs")?.route).toBe("R2");
    expect(matchRoute("api", "POST", "/v1/installs")?.route).toBe("R4");
    expect(matchRoute("api", "PUT", "/v1/installs")).toBeNull();
  });

  it("unknown paths, extra segments and encoded slashes do not match", () => {
    expect(matchRoute("api", "GET", "/v1/nope")).toBeNull();
    expect(matchRoute("api", "GET", "/v1/installs/a/b")).toBeNull();
    expect(matchRoute("api", "GET", "/v1/installs/a%2Fb/jobs")).toBeNull();
    expect(matchRoute("api", "GET", "/v1")).toBeNull();
  });

  // Red-line port (provisioning.ts P26 "The admin website has no test
  // sign-in shortcut"): no route serves /auth/test-signin, on either host,
  // for any method, so one being added fails here before merge.
  it("the admin site has no test sign-in route: /auth/test-signin is 404", async () => {
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
    for (const m of methods) {
      expect(matchRoute("admin", m, "/auth/test-signin"), m).toBeNull();
      expect(matchRoute("api", m, "/auth/test-signin"), m).toBeNull();
    }
    // No route in the table is a test sign-in (the real sign-in is /auth/start).
    expect(
      ROUTE_IDS.map((id) => ROUTES[id].path).filter((p) =>
        /^\/auth\/test|test-?sign/i.test(p),
      ),
    ).toEqual([]);
    for (const base of [ADMIN, API])
      for (const method of ["GET", "POST"] as const) {
        const req = new Request(`${base}/auth/test-signin`, {
          method,
          // Past the admin host's Origin check, so only routing answers.
          headers: { "cf-connecting-ip": "192.0.2.9", origin: ADMIN },
        }) as Parameters<typeof worker.fetch>[0];
        const res = await worker.fetch(req, fakeEnv().env, ctx());
        expect(res.status, `${method} ${base}`).toBe(404);
      }
  });
});
