import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { STAGING_TEST_DOMAIN } from "@oa/provision/names";
import type { InstallDetail } from "@oa/provisioning-contract";
import { getDomain } from "tldts";
import { InfraError } from "./fetch-timeout.ts";
import { describeRes, readBody } from "./http.ts";
import { mask, writeSecretFile } from "./oidc.ts";
import {
  HOSTS_SETTLE_MS,
  mintCreds,
  oidcCreate,
  ownDetail,
  PAGE_WITHIN_MS,
  PROBES,
  ProbeFail,
  type ProbeId,
  type Run,
  removeInstall,
} from "./provisioning.ts";
import { liveRun, rawTargets, waitHookKey } from "./provisioning-live.ts";
import { newRecipient, openSealed, parseCreds } from "./seal.ts";
import { secretFileName } from "./targets.ts";
import { rawRequest } from "./ws.ts";

// The red-line smoke (cloud #264 step 2; red-line page vZ2GyzVGZ2DCB7oW v3):
// the short blocking release check, in two tracks that run side by side.
// Track 1 (smoke/fresh.test.ts) creates a brand-new install at the release
// under test; track 2 (smoke/standing.test.ts) checks rl-a after the
// workflow's bring-up upgraded it. No locks, no pacing ledgers, no ordering
// marks, no lanes: every check signs in its own fresh test person, and a 429
// is an environment problem (infra), never a pass or a fail.

/** One page row the smoke keeps, and where it is checked now. */
export interface SmokeRow {
  /** The check's title on the page's "Every check" table. */
  page: string;
  /** Where it runs: a smoke case, a T19 @gate spec, the public happy path, or setup. */
  where: string;
}

const F = "fresh install > ";
const S = "rl-a > ";

/** The smoke's cases, by file: smoke/manifest.json lists exactly these. */
export const SMOKE_CASES = {
  "smoke/fresh.test.ts": [
    `${F}create: the release under test is listed and installable, then a brand-new install reaches done at it`,
    `${F}health: the shared health check, its content address is the content app's, and the inventory maps both addresses to it`,
    `${F}isolation canary: its PAT and its test login session work there and are refused at rl-a`,
  ],
  "smoke/standing.test.ts": [
    `${S}health: the shared health check`,
    `${S}who am I: a fresh person sees the plan and exactly its features`,
    `${S}prod-clean: the published prod releases are the signed customer build and no prod install shows test hooks`,
    `${S}environments and services are kept apart: robot token audiences, staging on prod, the inventory, the OAuth metadata`,
    `${S}anti-bot: a code request with no Turnstile token is 400 turnstile_required`,
    `${S}code sign-in: a fresh person signs in by code, and every cookie is __Host-, Secure, Path=/, with no Domain`,
    `${S}Google sign-in start: it reaches Google with a client id, the callback address and the broker state for rl-a`,
    `${S}files and pages: an MCP publish is found by search, a signed upload becomes a version, one live-data value reads back`,
    `${S}viewing: a private view on the content address sets no cookie, a live-data socket opens, a public link stops once private`,
  ],
} as const;

const fc = SMOKE_CASES["smoke/fresh.test.ts"];
const sc = SMOKE_CASES["smoke/standing.test.ts"];
const T19 = "T19 @gate (redline-staging.yml t19 job), ";
const HAPPY =
  "public happy-path suite on staging (public deploy-staging.yml), and ";

/**
 * The 27 rows the page keeps in the smoke ("Every check", Smoke), each with
 * where it runs. test/smoke.test.ts holds this list to the page's count and
 * to the manifest.
 */
export const SMOKE_ROWS: readonly SmokeRow[] = [
  { page: "Prod has no test shortcuts anywhere", where: sc[2] },
  {
    page: "The content address is served by the content app, the app address is not",
    where: fc[1],
  },
  {
    page: "Each install's addresses point to its own id, and no address points to two installs",
    where: `${fc[1]} (the full audit is nightly)`,
  },
  {
    page: "Artifact content is served from a different site than every app address",
    where: sc[8],
  },
  {
    page: "Every cookie the app address sets is the locked-down kind",
    where: sc[5],
  },
  {
    page: "A sign-in code request without the anti-bot token is refused",
    where: sc[4],
  },
  {
    page: "Helper: builders for sign-in requests",
    where: `src/signin.ts, for ${sc[4]}, ${sc[5]} and ${sc[6]}`,
  },
  {
    page: "Helper: makes the CI robot's GitHub tokens for the platform services",
    where: `src/oidc.ts, for ${fc[0]} and ${sc[3]}`,
  },
  {
    page: "A public link works while public and stops the moment the artifact goes private",
    where: sc[8],
  },
  {
    page: "Install admin can reserve a file upload and gets a working upload address",
    where: sc[7],
  },
  {
    page: "Creates a brand-new install, and sending the request twice still makes only one",
    where: fc[0],
  },
  {
    page: "The release under test is listed and can be installed",
    where: `${fc[0]} (its first line)`,
  },
  {
    page: "The two standing test installs run the release under test",
    where:
      "setup: the bring-up and staged-version steps, and the shared health check's version",
  },
  {
    page: "The admin token the platform issues for the main test install works there",
    where: "setup: smoke/standing.test.ts beforeAll (R26 PAT on /api/v1/me)",
  },
  {
    page: "The Provisioning API refuses robot tokens with the wrong audience, tampered, or unsigned",
    where: `${sc[3]} (wrong audience)`,
  },
  {
    page: "A staging robot token is refused by prod's Provisioning API",
    where: sc[3],
  },
  {
    page: "A staging robot token is refused by prod's admin MCP",
    where: sc[3],
  },
  {
    page: "The install inventory refuses the wrong tokens and accepts the right one",
    where: sc[3],
  },
  {
    page: "The admin AI connection's sign-in setup documents name the right addresses",
    where: sc[3],
  },
  {
    page: "The main staging test install is up, is the test build, and runs the release under test",
    where: `${sc[0]}, and ${T19}rl-a/guard.setup.ts`,
  },
  {
    page: "The main staging test install reports the right plan and the features that come with it",
    where: `${sc[1]}, and ${T19}rl-a/hosted.spec.ts`,
  },
  {
    page: "An agent's reply appears live on an open page, with no reload",
    where: `${T19}rl-a/comments.spec.ts`,
  },
  {
    page: "An invited person from outside the company domain signs in by email code and lands in the Library",
    where: `${sc[5]}, and ${T19}rl-a/joins.spec.ts`,
  },
  {
    page: "An editor uploads a file into a space; a manager moves it to another space",
    where: `${T19}rl-a/spaces.spec.ts (the upload half)`,
  },
  {
    page: "An agent publishes a page and finds it in the library and in search",
    where: `${HAPPY}${sc[7]}`,
  },
  {
    page: "A signed file upload becomes a new version, and the original can be restored",
    where: `${HAPPY}${sc[7]}`,
  },
  {
    page: "A page's live data can be written, changed, queried and deleted",
    where: `${HAPPY}${sc[7]}`,
  },
];

/**
 * Kept in the smoke beyond the table's 27 (the page's "Where the final
 * reviewer changed a placement" and track 1): the token and login-session
 * parts of the isolation canary, out of nightly. The OAuth part stays nightly.
 */
export const SMOKE_ADDED: readonly SmokeRow[] = [
  {
    page: "Isolation canary, token and login-session parts (was nightly: guard 'who am I' with a token and with a cookie)",
    where: fc[2],
  },
];

// --- configuration ---------------------------------------------------------

/** Where the smoke keeps its fresh install's slug and the purge's files. */
export function smokeDir(env: Record<string, string | undefined>): string {
  const d =
    env.REDLINE_SMOKE_DIR || mkdtempSync(join(tmpdir(), "oa-redline-smoke-"));
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export const FRESH_FILE = "fresh.json";
export const PURGE_LOG = "purge.log";
export const PURGE_DONE = "purge.done";

/** The fresh install's letter: rl-n-<run> (p, q, l, f, u, v and s are the long suite's). */
export const FRESH_LETTER = "n";

/** The prov Run for the smoke: the live wiring, rl-a and rl-b from REDLINE_TARGETS. */
export const smokeRun = (env: Record<string, string | undefined>): Run =>
  liveRun(env, rawTargets(env.REDLINE_TARGETS));

// --- HTTP ------------------------------------------------------------------

/**
 * A fetch whose 429 is infra: a rate limit says nothing about the release.
 * The body is read for the message (status and hash only) and dropped.
 */
export async function req(
  input: string | URL | Request,
  init: RequestInit = {},
  f: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const res = await f(input, { redirect: "manual", ...init });
  if (res.status === 429) {
    const body = await readBody(res);
    const u = new URL(input instanceof Request ? input.url : input);
    throw new InfraError(
      `rate limited at ${u.host}${u.pathname.split("/").slice(0, 4).join("/")} (${describeRes(res, body)}): an environment problem, not a verdict`,
    );
  }
  return res;
}

/** A GET whose body is read and parsed as JSON (or undefined). */
export async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ res: Response; text: string; json: unknown }> {
  const res = await req(url, { headers });
  const text = await readBody(res);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { res, text, json };
}

// --- the shared health check -----------------------------------------------

export interface HealthWant {
  name: string;
  installId: string;
  version: string;
}

const OAUTH_MODES = ["d1", "dual"];

/**
 * The page's one health check, for both tracks: /healthz is 200 with ok,
 * the install's own id, the release under test, test hooks on, and the
 * OAuth store in d1 or dual. Returns the problems (empty: healthy).
 */
export function healthProblems(
  status: number,
  body: unknown,
  want: HealthWant,
): string[] {
  if (status !== 200) return [`${want.name} /healthz is ${status}, want 200`];
  const h = (body ?? {}) as {
    ok?: unknown;
    installId?: unknown;
    version?: unknown;
    testHooks?: unknown;
    oauthStore?: { mode?: unknown } | null;
  };
  const out: string[] = [];
  if (h.ok !== true) out.push("ok is not true");
  if (h.installId !== want.installId)
    out.push(`installId is not ${want.installId}`);
  if (h.version !== want.version)
    out.push(
      `version is ${typeof h.version === "string" ? h.version.slice(0, 20) : "missing"}, want ${want.version}`,
    );
  if (h.testHooks !== true)
    out.push("testHooks is not true (not the test build)");
  const mode = h.oauthStore?.mode;
  if (typeof mode !== "string" || !OAUTH_MODES.includes(mode))
    out.push(
      `oauthStore.mode is ${typeof mode === "string" ? mode.slice(0, 10) : "missing"}, want d1 or dual`,
    );
  return out.map((p) => (p.startsWith(want.name) ? p : `${want.name}: ${p}`));
}

export async function checkHealth(
  app: string,
  want: HealthWant,
): Promise<void> {
  const { res, json } = await getJson(`${app}/healthz`);
  const bad = healthProblems(res.status, json, want);
  if (bad.length) throw new Error(bad.join("; "));
}

/**
 * True when a response came from the content app: it alone sets
 * Cross-Origin-Resource-Policy: cross-origin with Access-Control-Allow-Origin: *
 * (src/http.ts fromContentApp).
 */
export const fromContentApp = (res: Response): boolean =>
  res.headers.get("cross-origin-resource-policy") === "cross-origin" &&
  res.headers.get("access-control-allow-origin") === "*";

/** /robots.txt: the content address answers from the content app, the app address does not. */
export async function checkContentApp(
  name: string,
  app: string,
  content: string,
): Promise<void> {
  const c = await req(`${content}/robots.txt`);
  const cb = await readBody(c);
  if (c.status !== 200 || !fromContentApp(c))
    throw new Error(`${name} content /robots.txt: ${describeRes(c, cb)}`);
  const a = await req(`${app}/robots.txt`);
  const ab = await readBody(a);
  if (a.status !== 200 || fromContentApp(a))
    throw new Error(`${name} app /robots.txt: ${describeRes(a, ab)}`);
}

// --- sign-in helpers (no pacing ledger) -------------------------------------

/** A POST to a /__test/* hook with `key`; the parsed body, or HookRefused. */
export class HookRefused extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(path: string, status: number, reason: string) {
    super(`hook ${path}: ${status} (${reason})`);
    this.status = status;
    this.reason = reason;
  }
}

export async function hookCall(
  app: string,
  key: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const res = await req(`${app}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await readBody(res);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (res.status < 200 || res.status > 299) {
    const reason = (json as { error?: { details?: { reason?: unknown } } })
      ?.error?.details?.reason;
    throw new HookRefused(
      path,
      res.status,
      typeof reason === "string" && /^[a-z_]{1,40}$/.test(reason)
        ? reason
        : "no_reason",
    );
  }
  return json;
}

/** A test login session for a TEST_DOMAIN person (POST /__test/session): the cookie value. */
export async function hookSession(
  app: string,
  key: string,
  email: string,
  role: "admin" | "member" | "guest",
): Promise<string> {
  const out = (await hookCall(app, key, "/__test/session", {
    email,
    role,
  })) as { cookie?: unknown } | undefined;
  if (typeof out?.cookie !== "string" || !out.cookie)
    throw new Error("session hook: no cookie");
  return out.cookie;
}

/**
 * A fresh person's address in the install's test domain, unique to this run:
 * t19-s<run>-<what>-<hex>. The t19- prefix is the only one the people-purge
 * hook erases (TEST_PURGE_PREFIX), so the smoke erases its own people at its
 * end and T19's sweep of older runs catches any left behind. The `s` keeps it
 * apart from T19's own t19-<hex>- runs.
 */
export const freshEmail = (runId: string, what: string, domain: string) =>
  `${smokePeoplePrefix(runId)}${what}-${randomBytes(3).toString("hex")}@${domain}`;

/** The prefix of this run's smoke people (TEST_PURGE_PREFIX-shaped). */
export const smokePeoplePrefix = (runId: string) =>
  `t19-s${runId.toLowerCase().replace(/[^a-z0-9-]/g, "")}-`;

export const SESSION_COOKIE = "__Host-oa_session";

export const cookieAuth = (value: string) => ({
  cookie: `${SESSION_COOKIE}=${value}`,
});
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** POST /api/v1/tokens with a session: the new PAT. */
export async function mintPat(app: string, cookie: string): Promise<string> {
  const res = await req(`${app}/api/v1/tokens`, {
    method: "POST",
    headers: {
      ...cookieAuth(cookie),
      "content-type": "application/json",
      "x-oa-request": "1",
    },
    body: JSON.stringify({ label: "redline-smoke" }),
  });
  const text = await readBody(res);
  const token = (() => {
    try {
      return (JSON.parse(text) as { token?: unknown }).token;
    } catch {
      return undefined;
    }
  })();
  if (res.status !== 201 || typeof token !== "string" || !token)
    throw new Error(`mint PAT: ${describeRes(res, text)}`);
  return token;
}

/** A refusal of a foreign credential: 401, 403 or 404, no session cookie set. */
export function refusalProblem(
  status: number,
  setCookies: readonly string[],
): string | null {
  if (![401, 403, 404].includes(status)) return `answered ${status}`;
  if (setCookies.some((c) => /oa_session=/.test(c.split(";")[0] ?? "")))
    return "set a session cookie";
  return null;
}

// --- cookies ----------------------------------------------------------------

export interface SetCookie {
  name: string;
  attrs: Map<string, string>;
}

export function parseSetCookie(line: string): SetCookie {
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

/** Problems with one app-address Set-Cookie (names only, never values). */
export function cookieProblems(c: SetCookie): string[] {
  const out: string[] = [];
  if (!c.name.startsWith("__Host-")) out.push(`${c.name} is not __Host-`);
  if (!c.attrs.has("secure")) out.push(`${c.name} is not Secure`);
  if (c.attrs.get("path") !== "/") out.push(`${c.name} Path is not /`);
  if (c.attrs.has("domain")) out.push(`${c.name} has a Domain`);
  return out;
}

// --- Google sign-in start ----------------------------------------------------

export const GOOGLE_AUTH = "https://accounts.google.com";

/**
 * What Google's authorize URL must carry for `installId`: a client id, the
 * broker's (or the install's) callback address, and a state; with the broker,
 * its signed state names the install. Returns the problems.
 */
export function googleProblems(
  google: URL,
  o: { broker?: string; app: string; installId: string },
): string[] {
  const out: string[] = [];
  if (google.origin !== GOOGLE_AUTH) out.push("not on accounts.google.com");
  const client = google.searchParams.get("client_id") ?? "";
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(client))
    out.push("no Google OAuth client id");
  const cb = o.broker
    ? `${o.broker}/google/callback`
    : `${o.app}/auth/callback/google`;
  if (google.searchParams.get("redirect_uri") !== cb)
    out.push(
      `redirect_uri is not ${o.broker ? "the broker's" : "the install's"} callback`,
    );
  const state = google.searchParams.get("state") ?? "";
  if (!state) out.push("no state");
  else if (o.broker) {
    try {
      const p = JSON.parse(
        Buffer.from(state.split(".")[0] ?? "", "base64url").toString("utf8"),
      ) as { i?: unknown };
      if (p.i !== o.installId)
        out.push("the broker state names another install");
    } catch {
      out.push("the broker state is not readable");
    }
  }
  return out;
}

// --- MCP on an install --------------------------------------------------------

export interface ToolOut {
  isError: boolean;
  data: Record<string, unknown>;
}

/** tools/call on `${app}/mcp` with a PAT: the structured result. */
export async function tool(
  app: string,
  pat: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOut> {
  const res = await req(`${app}/mcp`, {
    method: "POST",
    headers: {
      ...bearer(pat),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await readBody(res);
  let rpc: unknown;
  try {
    rpc = JSON.parse(text);
  } catch {
    for (const line of text.split(/\r?\n/))
      if (line.startsWith("data:"))
        try {
          rpc = JSON.parse(line.slice(5).trim());
        } catch {}
  }
  const result = (rpc as { result?: unknown } | undefined)?.result as
    | { isError?: boolean; structuredContent?: Record<string, unknown> }
    | undefined;
  if (res.status !== 200 || !result)
    throw new Error(`MCP ${name}: ${describeRes(res, text)}`);
  return {
    isError: result.isError === true,
    data: result.structuredContent ?? {},
  };
}

/** A tool call that must succeed. */
export async function okTool(
  app: string,
  pat: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await tool(app, pat, name, args);
  if (r.isError) {
    const code = (r.data.error as { code?: unknown } | undefined)?.code;
    throw new Error(
      `MCP ${name}: error ${typeof code === "string" ? code.slice(0, 40) : "without a code"}`,
    );
  }
  return r.data;
}

// --- WebSocket -----------------------------------------------------------------

/** The WebSocket handshake for `url` with `headers`: the response (101 when upgraded). */
export function wsUpgrade(
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  const h = new Headers(headers);
  h.set("connection", "Upgrade");
  h.set("upgrade", "websocket");
  h.set("sec-websocket-version", "13");
  h.set("sec-websocket-key", randomBytes(16).toString("base64"));
  return rawRequest({ url, headers: h });
}

// --- sites -------------------------------------------------------------------

/** eTLD+1 by the public suffix list tldts ships, private section included (as browsers do). */
export const siteOf = (origin: string) =>
  getDomain(new URL(origin).hostname, { allowPrivateDomains: true });

// --- track 1: the fresh install -------------------------------------------------

export interface Fresh {
  id: string;
  slug: string;
  app: string;
  content: string;
}

const origin = (host: string) => `https://${host.replace(/\.$/, "")}`;

/** Runs one long-suite probe by id (the smoke reuses its exact checks). */
export async function probe(run: Run, id: ProbeId): Promise<void> {
  const p = PROBES.find((x) => x.id === id);
  if (!p) throw new Error(`${id} is not a probe`);
  const o = await p.run(run);
  if (o.level !== "pass")
    throw new ProbeFail(
      `${id}: ${o.level}${"reason" in o && o.reason ? ` (${o.reason})` : ""}`,
    );
}

/**
 * Track 1's create: first that the release under test is listed and
 * installable (P28's check), so a missing release fails with that message;
 * then a new rl-n-<run> at that release, to done, with test hooks, and its
 * /healthz answering on the new app address. The slug is written to `dir`
 * before the create, so the purge finds it even when the create fails.
 */
export async function createFresh(run: Run, dir: string): Promise<Fresh> {
  try {
    await probe(run, "P28");
  } catch (e) {
    throw new ProbeFail(
      `release ${run.c.version} is not installable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const slug = run.slug(FRESH_LETTER);
  writeFileSync(join(dir, FRESH_FILE), `${JSON.stringify({ slug })}\n`, {
    mode: 0o600,
  });
  const a = run.accepted(
    await run.v1("/installs", {
      body: oidcCreate(run, slug, run.rid("smoke-create"), run.c.version),
    }),
    "smoke create",
  );
  await run.done(a.job.id, "smoke create");
  const d = await ownDetail(run, a.install.id);
  if (d.status !== 200) throw new ProbeFail(`smoke create R3: ${d.status}`);
  const i = d.json as InstallDetail;
  if (i.testHooks !== true)
    throw new ProbeFail("smoke create: testHooks is not true");
  if (i.version !== run.c.version)
    throw new ProbeFail(
      `smoke create: runs ${i.version}, want ${run.c.version}`,
    );
  if (!i.appHost || !i.contentHost)
    throw new ProbeFail("smoke create: no app or content host");
  const fresh: Fresh = {
    id: a.install.id,
    slug,
    app: origin(i.appHost),
    content: origin(i.contentHost),
  };
  writeFileSync(
    join(dir, FRESH_FILE),
    `${JSON.stringify({ slug, id: fresh.id })}\n`,
    { mode: 0o600 },
  );
  // Dispatch's HOSTS cache (60 s) can still miss the new host: poll.
  await run.within(PAGE_WITHIN_MS, "smoke create /healthz", async () => {
    const h = await run.page(i.appHost);
    return h.status === 200;
  });
  return fresh;
}

/** The inventory maps both of the fresh install's addresses to its id (it settles within HOSTS_SETTLE_MS). */
export async function checkFreshMapped(run: Run, f: Fresh): Promise<void> {
  for (const o of [f.app, f.content]) {
    const host = new URL(o).hostname;
    let got: string | null = null;
    try {
      await run.within(HOSTS_SETTLE_MS, `inventory ${host}`, async () => {
        got = (await run.hostMode(host)).installId;
        return got === f.id;
      });
    } catch (e) {
      if (!(e instanceof ProbeFail)) throw e;
      throw new ProbeFail(
        `the inventory maps a ${f.slug} address to ${got === null ? "nothing" : "another install"}`,
      );
    }
  }
}

export interface FreshCreds {
  pat: string;
  hookKey: string;
}

/**
 * R26 on the fresh install: its admin PAT and hook key, sealed to this run,
 * masked and written to secretsDir (so the report scans cover them), then
 * the hook key proven live. No pacing ledger: the R26 job already proves the
 * key live before it seals it, so this is one or two key checks.
 */
export async function freshCreds(
  run: Run,
  f: Fresh,
  env: Record<string, string | undefined>,
): Promise<FreshCreds> {
  const m = mask(env);
  const r = await newRecipient();
  const c = await mintCreds(run, f.id, f.slug, {
    publicKey: r.publicKey,
    open: async (sealed) => {
      const p = parseCreds(await openSealed(r, sealed));
      m(p.pat);
      m(p.hookKey);
      return p;
    },
  });
  const dir = rawTargets(env.REDLINE_TARGETS).secretsDir;
  writeSecretFile(join(dir, secretFileName(f.slug, "PAT")), c.pat);
  writeSecretFile(join(dir, secretFileName(f.slug, "HOOK_KEY")), c.hookKey);
  await waitHookKey(run, f.app, c.hookKey, async () => {});
  return c;
}

/** The fresh install's test domain: every staging test install's. */
export const FRESH_TEST_DOMAIN = STAGING_TEST_DOMAIN;

/**
 * The isolation canary: the fresh install's PAT and a test login session made
 * there both work there (200) and are refused at rl-a. A provisioning bug
 * that reused another install's database or SESSION_SECRET would let one in.
 */
export async function canary(
  f: Fresh,
  c: FreshCreds,
  rlA: { app: string },
): Promise<void> {
  const cookie = await hookSession(
    f.app,
    c.hookKey,
    `redline-admin@${FRESH_TEST_DOMAIN}`,
    "admin",
  );
  for (const [what, h] of [
    ["PAT", bearer(c.pat)],
    ["test login session", cookieAuth(cookie)],
  ] as const) {
    const own = await req(`${f.app}/api/v1/me`, { headers: h });
    const ob = await readBody(own);
    if (own.status !== 200)
      throw new Error(
        `the fresh install's ${what} at itself: ${describeRes(own, ob)}`,
      );
    const at = await req(`${rlA.app}/api/v1/me`, { headers: h });
    const ab = await readBody(at);
    const bad = refusalProblem(at.status, at.headers.getSetCookie());
    if (bad)
      throw new Error(
        `BREACH: the fresh install's ${what} at rl-a ${bad} (${describeRes(at, ab)})`,
      );
  }
}

// --- the background purge ---------------------------------------------------------

/** How long the workflow's purge step waits for the purge to end. */
export const PURGE_WAIT_MS = 10 * 60_000;

/**
 * Starts the fresh install's delete and purge in a detached process, and
 * returns at once: the purge never holds or fails the gate. Its log and its
 * done file go to `dir`; scripts/smoke.ts purge-wait reads them later.
 */
export function spawnPurge(
  dir: string,
  script: string,
  go: typeof spawn = spawn,
): boolean {
  if (!existsSync(join(dir, FRESH_FILE))) return false;
  const fd = openSync(join(dir, PURGE_LOG), "a", 0o600);
  const child = go(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", script, "purge"],
    { detached: true, stdio: ["ignore", fd, fd], env: process.env },
  );
  child.unref();
  return true;
}

/** The detached purge's body: delete and purge rl-n-<run>, then the done file. */
export async function purgeFresh(
  run: Run,
  dir: string,
  write: (s: string) => unknown = (s) => process.stdout.write(s),
): Promise<boolean> {
  let ok = false;
  let slug = "";
  try {
    slug = (
      JSON.parse(readFileSync(join(dir, FRESH_FILE), "utf8")) as {
        slug?: unknown;
      }
    ).slug as string;
    if (typeof slug !== "string" || !/^rl-n-[a-z0-9-]{1,40}$/.test(slug))
      throw new Error("no fresh slug recorded");
    await removeInstall(run, slug, `smoke purge ${slug}`);
    write(`${slug}: deleted and purged\n`);
    ok = true;
  } catch (e) {
    write(
      `${slug || "the fresh install"}: purge failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  writeFileSync(join(dir, PURGE_DONE), ok ? "ok\n" : "failed\n", {
    mode: 0o600,
  });
  return ok;
}

/**
 * Waits for the done file up to `within`, prints the purge's log (without
 * workflow command lines) and returns whether the purge succeeded. True when
 * no fresh install was ever recorded (nothing to purge).
 */
export async function purgeWait(
  dir: string,
  o: {
    within?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<unknown>;
    write?: (s: string) => void;
  } = {},
): Promise<boolean> {
  const write = o.write ?? ((s: string) => process.stdout.write(s));
  if (!existsSync(join(dir, FRESH_FILE))) {
    write("no fresh install was created: nothing to purge\n");
    return true;
  }
  const now = o.now ?? Date.now;
  const wait = o.wait ?? ((ms: number) => delay(ms));
  const end = now() + (o.within ?? PURGE_WAIT_MS);
  while (!existsSync(join(dir, PURGE_DONE)) && now() < end) await wait(2_000);
  const log = existsSync(join(dir, PURGE_LOG))
    ? readFileSync(join(dir, PURGE_LOG), "utf8")
    : "";
  for (const line of log.split("\n"))
    if (line && !line.startsWith("::")) write(`${line}\n`);
  if (!existsSync(join(dir, PURGE_DONE))) {
    write(
      "the purge has not ended: the next run's cleanup or a person must remove the install\n",
    );
    return false;
  }
  return readFileSync(join(dir, PURGE_DONE), "utf8").trim() === "ok";
}

/** The path of this module's directory's sibling scripts/smoke.ts. */
export const SMOKE_SCRIPT = join(
  dirname(import.meta.dirname),
  "scripts",
  "smoke.ts",
);
