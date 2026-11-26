import { createHash, randomUUID } from "node:crypto";
import { getDomain } from "tldts";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  apiReq,
  call,
  createThrowaway,
  deleteThrowaways,
} from "../src/fixtures.ts";
import {
  describeRes,
  fromContentApp,
  send as httpSend,
  parseJson,
  readBody,
  sessionCred,
  withCred,
} from "../src/http.ts";
import { allMarkers, prepareSide, type Side } from "../src/refused.ts";
import { noInventoryReason, proof } from "../src/report.ts";
import {
  labelTurnstileTestKey,
  ownCodeRequestReq,
  pendingCode,
} from "../src/signin.ts";
import { inventoryBearer, loadTargets, type Targets } from "../src/targets.ts";
import { rawRequest } from "../src/ws.ts";

// P5 Task 5: the content host, and the dispatch edge. Cases that need the
// dispatch Worker, staging DNS or the platform HOSTS map report staging-only
// in local mode; on staging they run for real (or say why they can't).

let T: Targets;
let A: Side;
let B: Side;

/** Every artifact a side created (marker first), recorded as it is made. */
const made = new Map<Side, string[]>();

beforeAll(async () => {
  T = await loadTargets();
  A = await prepareSide(T.a);
  made.set(A, [A.markerId]);
  B = await prepareSide(T.b);
  made.set(B, [B.markerId]);
});

afterAll(async () => {
  let bad = 0;
  for (const [s, ids] of made) bad += await deleteThrowaways(s.t, s.pat, ids);
  if (bad) throw new Error(`${bad} throwaway artifacts were not deleted`);
});

/** Per-request bound: a timeout is a FAIL (an abort error), never a refusal. */
const TIMEOUT_MS = 15_000;
const send = (r: Request) =>
  httpSend(new Request(r, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
const fetchT = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

const _sideOf = (k: "a" | "b") => (k === "a" ? A : B);
const _hashOf = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);
const hostOf = (origin: string) => new URL(origin).host;
const STAGING_ONLY = "needs the dispatch Worker and staging DNS";

/** The dispatch Worker's (and the server's foreign-host) generic 404. */
async function expectGeneric404(r: Response, what: string): Promise<void> {
  const b = await readBody(r);
  const bad = (why: string) => {
    throw new Error(`${what}: ${why} (${describeRes(r, b)})`);
  };
  if (r.status !== 404) bad("not a 404");
  if (r.headers.get("location")) bad("has a Location");
  if (r.headers.getSetCookie().length) bad("sets a cookie");
  r.headers.forEach((_, h) => {
    if (h.startsWith("x-oa")) bad("has an install header");
  });
  if (fromContentApp(r)) bad("answered by a content app");
  if (b.trim() !== "Not found") bad("not the generic body");
  for (const m of allMarkers()) if (b.includes(m)) bad("holds a marker");
}

const healthzId = async (r: Response): Promise<unknown> => {
  const b = await readBody(r);
  if (r.status !== 200) return undefined;
  try {
    return (JSON.parse(b) as { installId?: unknown }).installId;
  } catch {
    return undefined;
  }
};

describe("mapping integrity", () => {
  it("HOSTS maps each install's hosts to its own id, and no host to two", async (ctx) => {
    if (T.mode !== "staging") return proof(ctx, "staging-only", STAGING_ONLY);
    for (const t of [T.a, T.b]) {
      const r = await fetchT(`${t.app}/healthz`, { redirect: "manual" });
      if ((await healthzId(r)) !== t.installId)
        throw new Error(
          `${t.name}: the app host does not report its own installId`,
        );
      const c = await fetchT(`${t.content}/robots.txt`, { redirect: "manual" });
      await readBody(c);
      if (c.status !== 200 || !fromContentApp(c))
        throw new Error(
          `${t.name}: the content host is not served by a content app`,
        );
    }
    if (!T.inventory) return proof(ctx, "unproven-live", noInventoryReason());
    const listing = (await inventory("/hosts")) as {
      hosts?: unknown;
      complete?: unknown;
    };
    if (!Array.isArray(listing.hosts))
      throw new Error("inventory /hosts: no hosts array");
    // A truncated listing can't prove "every host": FAIL, never pass.
    if (listing.complete !== true)
      throw new Error("inventory /hosts: the listing is not complete");
    const hosts = new Map<string, unknown>();
    for (const h of listing.hosts as { host?: unknown; installId?: unknown }[])
      if (typeof h?.host === "string") hosts.set(h.host, h.installId);
    const raw = await inventory("/installs");
    const rows = (
      Array.isArray(raw) ? raw : (raw as { installs?: unknown }).installs
    ) as Record<string, unknown>[] | undefined;
    if (!Array.isArray(rows) || rows.length === 0)
      throw new Error("inventory /installs: missing or empty");
    // No host in /hosts is claimed by two installs (app or content).
    const claims = new Map<string, Set<string>>();
    for (const row of rows)
      for (const h of [row?.appHost, row?.contentHost])
        if (typeof h === "string" && typeof row.id === "string")
          claims.set(h, (claims.get(h) ?? new Set()).add(row.id));
    for (const h of hosts.keys())
      if ((claims.get(h)?.size ?? 0) > 1)
        throw new Error("inventory: a host is claimed by two installs");
    // Every rl host is in /hosts, mapped to its own install.
    for (const t of [T.a, T.b])
      for (const o of [t.app, t.content]) {
        const h = new URL(o).hostname;
        if (!hosts.has(h))
          throw new Error(`inventory: a ${t.name} host is missing from /hosts`);
        if (hosts.get(h) !== t.installId)
          throw new Error(
            `inventory: a ${t.name} host maps to another install id`,
          );
      }
  });
});

/** GET <inventory><path> with its OIDC bearer; status and body hash on failure. */
async function inventory(path: string): Promise<unknown> {
  const inv = T.inventory;
  if (!inv) throw new Error("no inventory configured");
  const res = await fetchT(`${inv.url}${path}`, {
    redirect: "manual",
    headers: { authorization: `Bearer ${await inventoryBearer(inv)}` },
  });
  const text = await readBody(res);
  if (res.status !== 200)
    throw new Error(
      `inventory ${path.split("?")[0]}: ${describeRes(res, text)}`,
    );
  return parseJson(res, text, "inventory");
}

/** The zone of a tenant host: everything after the slug. */
const zoneOf = (origin: string) =>
  new URL(origin).hostname.split(".").slice(1).join(".");
const slugOf = (origin: string) => new URL(origin).hostname.split(".")[0] ?? "";

/** A request through the edge: TLS to `connect`, Host (and SNI) `host`. */
const edge = (
  connect: string,
  host: string,
  extra: Record<string, string> = {},
) =>
  rawRequest({
    url: `https://${connect}/healthz`,
    headers: new Headers(extra),
    host,
    servername: host.replace(/\.$/, "").split(":")[0],
  });

describe("unmapped host", () => {
  it("unmapped names get the generic 404, never an install", async (ctx) => {
    if (T.mode !== "staging") return proof(ctx, "staging-only", STAGING_ONLY);
    for (const origin of [T.a.app, T.a.content]) {
      const zone = zoneOf(origin);
      const slug = slugOf(origin);
      const names = [
        `${slug}x.${zone}`,
        `${slug.slice(0, -1)}.${zone}`,
        zone,
        `www.${zone}`,
        `deadbeef.${zone}`,
      ];
      for (const n of names)
        await expectGeneric404(await edge(n, n), `unmapped ${n}`);
      // X-Forwarded-Host set to B on an unmapped name changes nothing.
      const n = `deadbeef.${zone}`;
      await expectGeneric404(
        await edge(n, n, { "x-forwarded-host": hostOf(T.b.app) }),
        "unmapped with X-Forwarded-Host B",
      );
    }
  });

  it("a deleted install's old host gets the generic 404", async (ctx) => {
    if (T.mode !== "staging") return proof(ctx, "staging-only", STAGING_ONLY);
    if (!T.deletedHosts)
      return proof(
        ctx,
        "unproven-live",
        "REDLINE_DELETED_HOSTS not set (Platform sets it once rl-del is deleted)",
      );
    if (!T.inventory) return proof(ctx, "unproven-live", noInventoryReason());
    for (const n of T.deletedHosts) {
      await expectGeneric404(await edge(n, n), "a deleted install's host");
      const h = (await inventory(`/hosts?host=${encodeURIComponent(n)}`)) as {
        host?: unknown;
        installId?: unknown;
      };
      if (h.host !== n || h.installId !== null)
        throw new Error("a deleted install's host is still mapped in HOSTS");
    }
  });
});

// Cross-site isolation that holds without the PSL listing (the manager's
// ruling on #649): the "rl-a and rl-b are different sites" check waits for the
// PSL entries and runs as scripts/psl-listed.ts, outside the gate.

/** eTLD+1 per the PSL snapshot tldts ships, private section included (as browsers). */
const siteOf = (origin: string) =>
  getDomain(new URL(origin).hostname, { allowPrivateDomains: true });

interface SetCookie {
  name: string;
  attrs: Map<string, string>;
}

function parseSetCookie(line: string): SetCookie {
  const [pair = "", ...rest] = line.split(";");
  const eq = pair.indexOf("=");
  const attrs = new Map<string, string>();
  for (const a of rest) {
    const i = a.indexOf("=");
    const k = (i === -1 ? a : a.slice(0, i)).trim().toLowerCase();
    if (k) attrs.set(k, i === -1 ? "" : a.slice(i + 1).trim());
  }
  return { name: pair.slice(0, eq).trim(), attrs };
}

/** Problems with one app-host Set-Cookie (names only, never values). */
function cookieProblems(c: SetCookie, strict: boolean): string[] {
  const out: string[] = [];
  if (c.attrs.has("domain")) out.push(`${c.name} has a Domain`);
  if (c.attrs.get("path") !== "/") out.push(`${c.name} Path is not /`);
  if (strict) {
    if (!c.name.startsWith("__Host-")) out.push(`${c.name} is not __Host-`);
    if (!c.attrs.has("secure")) out.push(`${c.name} is not Secure`);
  }
  return out;
}

const sameOriginJson = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-oa-request": "1",
  "sec-fetch-site": "same-origin",
  ...extra,
});

describe("cross-site isolation", () => {
  it("artifact content is served on a registrable domain cross-site to every app host", async () => {
    const apps = [T.a.app, T.b.app];
    for (const s of [A, B]) {
      const c = siteOf(s.t.content);
      if (!c)
        throw new Error(
          `${s.t.name}: the content host has no registrable domain`,
        );
      for (const app of apps) {
        const a = siteOf(app);
        if (!a) throw new Error("an app host has no registrable domain");
        if (a === c)
          throw new Error(
            `${s.t.name}'s content host is same-site with an app host`,
          );
      }
      // Direct check: the content URL the install issues is on that host.
      const w = await createThrowaway(s.t, s.pat);
      made.set(s, [...(made.get(s) ?? []), w.id]);
      const { res, text } = await call(
        apiReq(
          s.t,
          s.pat,
          "GET",
          `/api/v1/artifacts/${encodeURIComponent(w.id)}/content-url`,
        ),
        `${s.t.name} content-url`,
      );
      const url = (parseJson(res, text, "content-url") as { url?: unknown })
        .url;
      if (
        typeof url !== "string" ||
        new URL(url).hostname !== new URL(s.t.content).hostname
      )
        throw new Error(`${s.t.name}: content-url is not on its content host`);
      if (siteOf(url) !== c)
        throw new Error(`${s.t.name}: content-url site differs`);
    }
  });

  it("every app-host Set-Cookie is __Host- (Secure, Path=/, no Domain), on hook and code sign-in", async (ctx) => {
    labelTurnstileTestKey(ctx, [T.a, T.b]);
    const strict = T.mode === "staging";
    const notes: string[] = [];
    for (const t of [T.a, T.b]) {
      // A fresh guest: outside AUTH_DOMAINS only guests get emailed codes,
      // and an earlier run's row would keep its role.
      const email = `redline-cookies-${randomUUID().slice(0, 8)}@${t.testDomain}`;
      const seen: SetCookie[] = [];
      const take = async (r: Response) => {
        await readBody(r);
        for (const l of r.headers.getSetCookie()) seen.push(parseSetCookie(l));
        return r;
      };
      // Session hook sign-in, then app routes and sign-out with that cookie.
      const cookie = await sessionCred(t, email, "guest");
      for (const path of ["/", "/sign-in", "/api/v1/me", "/auth/providers"])
        await take(
          await send(new Request(`${t.app}${path}`, withCred(cookie))),
        );
      const out = await take(
        await send(
          new Request(
            `${t.app}/auth/logout`,
            withCred(cookie, {
              method: "POST",
              headers: { "x-oa-request": "1" },
            }),
          ),
        ),
      );
      if (!out.headers.getSetCookie().length)
        throw new Error(
          `${t.name} sign-out: no Set-Cookie (status ${out.status})`,
        );
      // Code sign-in: request (with the target's Turnstile token), the code
      // from the hook, verify.
      const req = await take(await send(ownCodeRequestReq(t, email)));
      const pending = req.headers
        .getSetCookie()
        .map((l) => l.split(";")[0] ?? "")
        .filter((p) => p.includes("="));
      // Delivery runs after the response: latestOtp polls the hook (404
      // only) for 5 s; any other hook answer throws and fails the case.
      const got = await pendingCode(t, email, {
        status: req.status,
        pending,
      });
      if ("unproven" in got) notes.push(got.unproven);
      else {
        const { code } = got;
        const v = await take(
          await send(
            new Request(`${t.app}/auth/code/verify`, {
              method: "POST",
              redirect: "manual",
              headers: sameOriginJson({ cookie: pending.join("; ") }),
              body: JSON.stringify({ code }),
            }),
          ),
        );
        const names = v.headers
          .getSetCookie()
          .map((l) => parseSetCookie(l).name);
        if (v.status !== 200 || !names.includes(t.cookieName))
          throw new Error(
            `${t.name} code verify: no session cookie (status ${v.status})`,
          );
      }
      const bad = seen.flatMap((c) => cookieProblems(c, strict));
      if (bad.length) throw new Error(`${t.name}: ${bad.join("; ")}`);
    }
    if (!strict)
      return proof(
        ctx,
        "staging-only",
        `ENVIRONMENT=dev sets unprefixed, non-Secure cookies; Path and Domain checked${notes.length ? `; ${notes.join("; ")}` : ""}`,
      );
    if (notes.length) return proof(ctx, "unproven-live", notes.join("; "));
  });
});
