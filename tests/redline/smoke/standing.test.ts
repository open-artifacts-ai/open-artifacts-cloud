import { createHash, randomBytes } from "node:crypto";
import { TEST_HOOKS, TIER_FEATURES } from "@oa/shared";
import { afterAll, beforeAll, describe, it } from "vitest";
import { describeRes, readBody } from "../src/http.ts";
import { guardProdClean } from "../src/prod.ts";
import { ProbeFail, type Run } from "../src/provisioning.ts";
import { rawTargets, TIER_FIXTURE } from "../src/provisioning-live.ts";
import { label, proof } from "../src/report.ts";
import {
  codeRequestReq,
  expectTurnstileRequired,
  googleUrlOf,
  startGoogle,
  TURNSTILE_DUMMY_TOKEN,
  TURNSTILE_TEST_KEY,
} from "../src/signin.ts";
import {
  bearer,
  checkHealth,
  cookieAuth,
  cookieProblems,
  freshEmail,
  googleProblems,
  HookRefused,
  hookCall,
  hookSession,
  mintPat,
  OTP_BACKOFF_MS,
  okTool,
  parseSetCookie,
  probe,
  refusalProblem,
  req,
  retryWithBackoff,
  SEARCH_BACKOFF_MS,
  SESSION_COOKIE,
  type SetCookie,
  SMOKE_CASES,
  siteOf,
  smokePeoplePrefix,
  smokeRun,
  wsUpgrade,
} from "../src/smoke.ts";
import {
  parseTargets,
  secretsOf,
  type Target,
  type Targets,
} from "../src/targets.ts";

// Track 2 of the smoke (src/smoke.ts): rl-a after the workflow's bring-up
// upgraded it to the release under test, like an existing customer. Each
// case signs in its own fresh test person through the session hook, so no
// case shares a person, an artifact or a rate-limit bucket with another.

const C = SMOKE_CASES["smoke/standing.test.ts"];
const name = (i: number) => (C[i] as string).slice("rl-a > ".length);
const env = process.env;
let T: Targets;
let A: Target;
let run: Run;
let key: string;

beforeAll(async () => {
  T = parseTargets(env, { onlyA: true });
  A = T.a;
  run = smokeRun(env);
  key = secretsOf(A).hookKey;
  // Setup, not a case (the page): the admin PAT the platform issued for rl-a
  // this run (R26) works on rl-a's /api/v1/me.
  await probe(run, "P36");
});

// The people this run signed in, erased at the end: best effort, never a
// verdict (the page: cleanup always runs and never fails the gate). T19's
// sweep of older t19- people catches any left behind.
afterAll(async () => {
  if (!A || !key || !run) return;
  try {
    for (let i = 0; i < 4; i++) {
      const r = (await hookCall(A.app, key, TEST_HOOKS.peoplePurge, {
        prefix: smokePeoplePrefix(run.c.runId),
        before: Date.now(),
        limit: 10,
      })) as { erased?: unknown; left?: unknown } | undefined;
      if (!r?.left || !r?.erased) break;
    }
  } catch {}
});

const person = async (what: string, role: "admin" | "member" | "guest") => {
  const email = freshEmail(run.c.runId, what, A.testDomain);
  return { email, cookie: await hookSession(A.app, key, email, role) };
};

const api = async (
  method: string,
  path: string,
  pat: string,
  body?: unknown,
): Promise<{ res: Response; json: unknown; text: string }> => {
  const res = await req(`${A.app}${path}`, {
    method,
    headers: {
      ...bearer(pat),
      "x-oa-request": "1",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await readBody(res);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { res, json, text };
};

const newPage = async (
  pat: string,
  o: { visibility?: "private" | "public"; db?: boolean } = {},
) => {
  const marker = `SMOKE-${randomBytes(6).toString("hex")}`;
  const r = await api("POST", "/api/v1/artifacts", pat, {
    title: marker,
    format: "html",
    content: `<!doctype html><title>${marker}</title><p>${marker}</p>`,
    visibility: o.visibility ?? "private",
    ...(o.db ? { capabilities: { db: true } } : {}),
  });
  const id = (r.json as { id?: unknown } | undefined)?.id;
  if (r.res.status !== 201 || typeof id !== "string")
    throw new Error(`publish: ${describeRes(r.res, r.text)}`);
  return { id, marker };
};

/** Best effort: a smoke page left behind is inert and private. */
const drop = async (pat: string, ids: readonly string[]) => {
  for (const id of ids)
    await api(
      "DELETE",
      `/api/v1/artifacts/${encodeURIComponent(id)}`,
      pat,
    ).catch(() => undefined);
};

const memberPat = async (what: string) => {
  const p = await person(what, "member");
  return { ...p, pat: await mintPat(A.app, p.cookie) };
};

describe("rl-a", () => {
  it(name(0), async () => {
    await checkHealth(A.app, {
      name: A.name,
      installId: A.installId,
      version: run.c.version,
    });
  });

  it(name(1), async () => {
    const p = await person("me", "member");
    const r = await req(`${A.app}/api/v1/me`, {
      headers: cookieAuth(p.cookie),
    });
    const text = await readBody(r);
    if (r.status !== 200)
      throw new Error(`/api/v1/me: ${describeRes(r, text)}`);
    const me = JSON.parse(text) as {
      instance?: { tier?: unknown; features?: unknown };
    };
    const tier = TIER_FIXTURE.a;
    if (me.instance?.tier !== tier)
      throw new Error(`rl-a's plan is not ${tier}`);
    const want = [
      ...TIER_FEATURES[tier],
      "usage_off",
      "guests_read_only",
    ].sort();
    const got = Array.isArray(me.instance?.features)
      ? [...(me.instance.features as string[])].sort()
      : [];
    if (JSON.stringify(got) !== JSON.stringify(want))
      throw new Error(
        `rl-a's features are not exactly the ${tier} plan's plus usage_off and guests_read_only`,
      );
  });

  it(name(2), async (ctx) => {
    // prodClean (src/prod.ts): every published prod release file is the
    // signed customer build, and no prod install's health page shows test
    // hooks, a hook key or DOCS_PREVIEW.
    const r = await guardProdClean(T);
    if (r === "not-applicable")
      return proof(ctx, "not-applicable", "local mode");
    if (r.level === "not-applicable")
      return proof(ctx, "not-applicable", r.reason);
  });

  it(name(3), async () => {
    // P6's wrong-audience leg (tampered and unsigned moved to PR CI), P7,
    // P46, P27 and P38: each environment and service checks its own tokens.
    if (!run.io.stgInventoryJwt)
      throw new ProbeFail("no inventory-audience token to send");
    const wrong = await run.v1("/me", {
      auth: { bearer: await run.io.stgInventoryJwt() },
    });
    if (wrong.status !== 401)
      throw new ProbeFail(
        `a token for the inventory at the Provisioning API: ${wrong.status}, want 401`,
      );
    for (const id of ["P7", "P46", "P27", "P38"] as const) await probe(run, id);
  });

  it(name(4), async () => {
    const email = freshEmail(run.c.runId, "bot", A.testDomain);
    await expectTurnstileRequired(A, await req(codeRequestReq(A, email)));
  });

  it(name(5), async (ctx) => {
    const token = secretsOf(A).turnstile;
    if (!token) throw new Error("rl-a has no Turnstile token configured");
    if (token === TURNSTILE_DUMMY_TOKEN) label(ctx, TURNSTILE_TEST_KEY);
    // A fresh guest: outside AUTH_DOMAINS only guests get emailed codes.
    const p = await person("code", "guest");
    const seen: SetCookie[] = [];
    const take = (r: Response) => {
      for (const l of r.headers.getSetCookie()) seen.push(parseSetCookie(l));
      return r;
    };
    const r = take(await req(codeRequestReq(A, p.email, token)));
    await readBody(r);
    const pending = r.headers
      .getSetCookie()
      .map((l) => l.split(";")[0] ?? "")
      .filter((x) => x.includes("="));
    if (r.status !== 202 || pending.length === 0)
      throw new Error(
        `code request: status ${r.status}, ${pending.length} pending cookie(s)`,
      );
    // Delivery runs after the response: the otp hook answers no_code until
    // the code is there. Retried with backoff (the one wait allowed), until
    // the hook can hold its answer until the code exists (see the PR).
    const code = await retryWithBackoff(
      async () => {
        try {
          const out = (await hookCall(A.app, key, "/__test/otp/latest", {
            email: p.email,
          })) as { code?: unknown };
          return typeof out?.code === "string" && out.code
            ? out.code
            : undefined;
        } catch (e) {
          if (!(e instanceof HookRefused) || e.reason !== "no_code") throw e;
          return undefined;
        }
      },
      {
        backoffMs: OTP_BACKOFF_MS,
        wait: run.io.wait,
        notReady: "no code was sent",
      },
    );
    const headers = new Headers(codeRequestReq(A, p.email).headers);
    headers.set("cookie", pending.join("; "));
    const v = take(
      await req(`${A.app}/auth/code/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({ code }),
      }),
    );
    await readBody(v);
    if (v.status !== 200 || !seen.some((c) => c.name === SESSION_COOKIE))
      throw new Error(`code verify: status ${v.status}, no session cookie`);
    const bad = seen.flatMap(cookieProblems);
    if (bad.length) throw new Error(bad.join("; "));
  });

  it(name(6), async () => {
    const s = await startGoogle(A);
    if (!s) throw new Error("Google sign-in is off on rl-a (404)");
    const broker =
      s.location.pathname === "/google/authorize"
        ? s.location.origin
        : undefined;
    const google = broker ? await googleUrlOf(s) : s.location;
    const bad = googleProblems(google, {
      broker,
      app: A.app,
      installId: A.installId,
    });
    if (bad.length) throw new Error(`Google sign-in start: ${bad.join("; ")}`);
  });

  it(name(7), async () => {
    const p = await memberPat("files");
    const ids: string[] = [];
    try {
      // An MCP publish, found by search (indexing can lag the publish).
      const marker = `SMOKE-${randomBytes(6).toString("hex")}`;
      const content = `<!doctype html><title>${marker}</title><p>${marker}</p>`;
      const pub = await okTool(A.app, p.pat, "publish_artifact", {
        title: marker,
        format: "html",
        content,
      });
      const id = pub.id;
      const version = pub.version;
      if (typeof id !== "string" || typeof version !== "number")
        throw new Error("MCP publish_artifact: no id or version");
      ids.push(id);
      // Indexing can lag the publish: retried with backoff (the one wait
      // allowed) until search lists the page, until a hook can hold its
      // answer until the index has it (see the PR).
      await retryWithBackoff(
        async () => {
          const s = await okTool(A.app, p.pat, "search_artifacts", {
            q: marker,
          });
          const items = (s.items as { id?: unknown }[] | undefined) ?? [];
          return items.some((x) => x.id === id) ? true : undefined;
        },
        {
          backoffMs: SEARCH_BACKOFF_MS,
          wait: run.io.wait,
          notReady: "search did not list the MCP publish",
        },
      );
      // A signed upload from the app address, published as the next version.
      const path = "upload.md";
      const bytes = new TextEncoder().encode(`# ${marker}\n`);
      const reserved = await okTool(A.app, p.pat, "create_upload", {
        artifactId: id,
        path,
        size: bytes.byteLength,
        contentType: "text/markdown",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const { uploadId, url } = reserved as {
        uploadId?: unknown;
        url?: unknown;
      };
      if (typeof uploadId !== "string" || typeof url !== "string")
        throw new Error("create_upload: no upload id or address");
      if (new URL(url).origin !== A.app)
        throw new Error("the signed upload address is not rl-a's app address");
      const put = await req(url, {
        method: "PUT",
        body: bytes,
        headers: { "content-type": "text/markdown" },
      });
      const pb = await readBody(put);
      if (put.status < 200 || put.status > 299)
        throw new Error(`signed upload PUT: ${describeRes(put, pb)}`);
      const next = await okTool(A.app, p.pat, "publish_artifact", {
        id,
        expectedVersion: version,
        entry: path,
        files: { [path]: { uploadId } },
      });
      if (next.version !== version + 1)
        throw new Error("the upload did not become the next version");
      // One live-data value, written and read back.
      await okTool(A.app, p.pat, "publish_artifact", {
        id,
        capabilities: { db: true },
      });
      const doc = { id, collection: "smoke", docId: "one" };
      await okTool(A.app, p.pat, "artifact_data_set", {
        ...doc,
        data: { n: 1 },
      });
      const got = await okTool(A.app, p.pat, "artifact_data_get", doc);
      if ((got.doc as { data?: { n?: unknown } } | undefined)?.data?.n !== 1)
        throw new Error("the live-data value did not read back");
    } finally {
      await drop(p.pat, ids);
    }
  });

  it(name(8), async () => {
    const p = await memberPat("view");
    const ids: string[] = [];
    try {
      // A private view through the content address: the link the install
      // issues is on its content host, on another site than every app
      // address, and the view sets no cookie.
      const priv = await newPage(p.pat, { db: true });
      ids.push(priv.id);
      const cu = await api(
        "GET",
        `/api/v1/artifacts/${encodeURIComponent(priv.id)}/content-url`,
        p.pat,
      );
      const url = (cu.json as { url?: unknown } | undefined)?.url;
      if (cu.res.status !== 200 || typeof url !== "string")
        throw new Error(`content-url: ${describeRes(cu.res, cu.text)}`);
      if (new URL(url).hostname !== new URL(A.content).hostname)
        throw new Error("the content link is not on rl-a's content address");
      const site = siteOf(url);
      if (!site)
        throw new Error("the content address has no registrable domain");
      for (const app of [A.app, rawTargets(env.REDLINE_TARGETS).b.app])
        if (siteOf(app) === site)
          throw new Error(
            "the content address is same-site with an app address",
          );
      // The view itself, and the raw file under the same signed path.
      const raw = new URL(url);
      raw.pathname = raw.pathname.replace(/__view$/, "index.html");
      for (const [what, u, marker] of [
        ["private view", url, false],
        ["private file", raw.href, true],
      ] as const) {
        const view = await req(u);
        const vb = await readBody(view);
        if (view.status !== 200 || (marker && !vb.includes(priv.marker)))
          throw new Error(`${what}: ${describeRes(view, vb)}`);
        if (view.headers.getSetCookie().length)
          throw new Error(`the ${what} on the content address set a cookie`);
      }
      // One live-data subscription with a login, through the real edge.
      const ws = await wsUpgrade(
        `${A.app}/api/v1/artifacts/${encodeURIComponent(priv.id)}/data-subscribe?collection=c`,
        { ...cookieAuth(p.cookie), origin: A.app },
      );
      if (ws.status !== 101)
        throw new Error(`live-data subscription: ${ws.status}, want 101`);
      // A public link serves, and the very next request after private is refused.
      const pub = await newPage(p.pat, { visibility: "public" });
      ids.push(pub.id);
      const link = `${A.content}/p/${encodeURIComponent(pub.id)}/v1/index.html`;
      const open = await req(link);
      const ob = await readBody(open);
      if (open.status !== 200 || !ob.includes(pub.marker))
        throw new Error(`public link: ${describeRes(open, ob)}`);
      const flip = await api(
        "PATCH",
        `/api/v1/artifacts/${encodeURIComponent(pub.id)}`,
        p.pat,
        {
          visibility: "private",
        },
      );
      if (flip.res.status !== 200)
        throw new Error(`make private: ${describeRes(flip.res, flip.text)}`);
      const after = await req(link);
      const ab = await readBody(after);
      const bad = ab.includes(pub.marker)
        ? "still serves the page"
        : [301, 302, 303, 307, 308].includes(after.status)
          ? null
          : refusalProblem(after.status, after.headers.getSetCookie());
      if (bad)
        throw new Error(
          `the public link once private ${bad} (${describeRes(after, ab)})`,
        );
    } finally {
      await drop(p.pat, ids);
    }
  });
});
