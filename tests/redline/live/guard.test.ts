import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type Cred,
  describeRes,
  fromContentApp,
  readBody,
  withCred,
} from "../src/http.ts";
import { guardProdClean } from "../src/prod.ts";
import { crossCheck, prepareSide, type Side } from "../src/refused.ts";
import { proof } from "../src/report.ts";
import { loadTargets, type Target, type Targets } from "../src/targets.ts";

// The guard and the harness's own live checks (P5 Task 1 and 2). Every case
// here is listed in live/manifest.json. Cloud #264 step 2 took out the cases
// the red-line page moves to PR CI or deletes (src/retired-split.ts).

let T: Targets;
let A: Side;
let B: Side;

beforeAll(async () => {
  T = await loadTargets();
  A = await prepareSide(T.a);
  B = await prepareSide(T.b);
});

afterAll(async () => {
  for (const s of [A, B]) {
    if (!s) continue;
    await fetch(
      `${s.t.app}/api/v1/artifacts/${encodeURIComponent(s.markerId)}`,
      withCred(s.pat, { method: "DELETE" }),
    ).then((r) => r.body?.cancel());
  }
});

const me = (cred: Cred, t: Target) =>
  new Request(`${t.app}/api/v1/me`, withCred(cred));

describe("guard", () => {
  it("prod is clean (no test hooks on any prod install)", async (ctx) => {
    // Also fails a prod install whose script binds DOCS_PREVIEW (staging
    // only, open-artifacts#2641): prodClean reads each install's settings.
    // Staging with no prod probe throws ProdDirty("prod probe not configured");
    // prodClean reads the OIDC inventory JWT from the secrets dir
    // (REDLINE_PROD_INVENTORY_OIDC, minted by the redline job in W12); without
    // it the case fails inventory_unconfigured.
    // Before the prod deploy (#1014) the inventory answers 503
    // schema_missing; that is pre-prod n/a only while the prod admin host
    // does not resolve (report.ts PRE_PROD_GUARD), else the case fails.
    const r = await guardProdClean(T);
    if (r === "not-applicable")
      return proof(ctx, "not-applicable", "local mode");
    if (r.level === "not-applicable")
      return proof(ctx, "not-applicable", r.reason);
  });
});

describe("hooks", () => {
  for (const k of ["a", "b"] as const) {
    it(`${k}: the content host is served by the content app`, async () => {
      const t = T[k];
      const c = await fetch(`${t.content}/robots.txt`, { redirect: "manual" });
      const cb = await readBody(c);
      if (c.status !== 200 || !fromContentApp(c))
        throw new Error(`content /robots.txt: ${describeRes(c, cb)}`);
      // The app host must not look like the content app.
      const a = await fetch(`${t.app}/robots.txt`, { redirect: "manual" });
      const ab = await readBody(a);
      if (a.status !== 200 || fromContentApp(a))
        throw new Error(`app /robots.txt: ${describeRes(a, ab)}`);
    });
  }
});

describe("credentials (harness smoke)", () => {
  it("A's admin PAT at B: /api/v1/me", async () => {
    await crossCheck(me, { a: T.a, b: T.b, credA: A.pat, credB: B.pat });
  });

  it("A's session cookie at B: /api/v1/me", async () => {
    await crossCheck(me, { a: T.a, b: T.b, credA: A.cookie, credB: B.cookie });
  });
});
