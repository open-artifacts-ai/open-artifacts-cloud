import { afterAll, beforeAll, describe, it } from "vitest";
import { slot, slotValue } from "../src/creds.ts";
import { deleteThrowaways } from "../src/fixtures.ts";
import {
  type Cred,
  HttpError,
  hook,
  parseJson,
  readBody,
  withCred,
} from "../src/http.ts";
import { note } from "../src/notes.ts";
import { crossCheck, prepareSide, type Side } from "../src/refused.ts";
import { proof } from "../src/report.ts";
import { loadTargets, type Target, type Targets } from "../src/targets.ts";

// P5 Task 4: A's real credentials don't work at B. Every case goes through
// crossCheck (B's credential succeeds at B, A's at A, then A's is refused at
// B). The credential is the admin test user's (hooks never act on the owner).
// Every case is listed in live/manifest.json.
//
// Since cloud #264 step 2 (red-line page v3) this file holds the nightly
// isolation canary's OAuth part: one install's OAuth access token at the
// other's MCP, and its signed content link at the other's content address.
// A provisioning bug that shared an OAuth store or CONTENT_SIGNING_KEY would
// let one through. The token and login-session parts run in the smoke; the
// cases the page moves to PR CI or deletes are in src/retired-split.ts.

let T: Targets;
let A: Side;
let B: Side;

beforeAll(async () => {
  T = await loadTargets();
  A = await prepareSide(T.a);
  B = await prepareSide(T.b);
});

afterAll(async () => {
  // Per id, one retry, never a throw mid-loop: a failed delete is noted.
  let bad = 0;
  for (const s of [A, B])
    if (s) bad += await deleteThrowaways(s.t, s.pat, [s.markerId]);
  if (bad) note(`cleanup: ${bad} marker artifact(s) not deleted`);
});

const pair = (credA: Cred, credB: Cred) => ({
  a: T.a,
  b: T.b,
  credA,
  credB,
});

const mcpList = (cred: Cred, t: Target) =>
  new Request(
    `${t.app}/mcp`,
    withCred(cred, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );

async function getJson(t: Target, path: string, cred: Cred): Promise<unknown> {
  const res = await fetch(`${t.app}${path}`, withCred(cred));
  const text = await readBody(res);
  if (res.status !== 200) throw new HttpError(`${t.name} ${path}`, res, text);
  return parseJson(res, text, `${t.name} ${path}`);
}

/** The signed path of the marker's file (/c/<token>/<id>/v<n>/README.md) on `t`. */
async function signedPath(t: Target, pat: Cred, id: string): Promise<string> {
  const j = (await getJson(
    t,
    `/api/v1/artifacts/${encodeURIComponent(id)}/content-url`,
    pat,
  )) as { url?: unknown };
  if (typeof j.url !== "string") throw new Error(`${t.name}: no content url`);
  const p = new URL(j.url).pathname;
  if (!p.startsWith("/c/"))
    throw new Error(`${t.name}: the marker's content url is not signed`);
  // The raw file: __view renders through the runtime, absent locally (503).
  return p.replace(/__view$/, "README.md");
}

describe("credentials", () => {
  it("A's MCP OAuth access token at B: /mcp tools/list", async (ctx) => {
    // Local installs serve http, while the provider's /mcp resource is
    // https://<APP_HOST>/mcp: an OAuth bearer at /mcp isn't served over
    // local http (B's own token gets 401), so only staging can prove this.
    if (T.mode === "local")
      return proof(
        ctx,
        "staging-only",
        "OAuth bearer at /mcp needs the https resource; local installs serve http",
      );
    const grant = async (t: Target): Promise<Cred> => {
      const r = (await hook(t, "/__test/oauth-client")) as {
        accessToken?: unknown;
      };
      if (typeof r.accessToken !== "string")
        throw new Error(`${t.name} oauth-client hook: no token`);
      return { kind: "oauth", token: r.accessToken };
    };
    await crossCheck(mcpList, pair(await grant(T.a), await grant(T.b)));
  });

  it("A's signed content URL at B's content host", async () => {
    const pA = await signedPath(T.a, A.pat, A.markerId);
    const pB = await signedPath(T.b, B.pat, B.markerId);
    const req = (c: Cred, t: Target) =>
      new Request(`${t.content}${slotValue<string>(c, t)}`, {
        redirect: "manual",
      });
    await crossCheck(
      req,
      pair(
        slot(() => pA),
        slot(() => pB),
      ),
    );
  });
});
