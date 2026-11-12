import type { Env } from "../env.js";
import type { Principal } from "../principal.js";
import { CLIENT_JS } from "./client.js";
import { gateOf } from "./gate.js";
import { CSS } from "./style.js";

// The sign-up page's own responses on signup.<app>: the static document, its
// two assets, the public config and the signed-in user's sign-up status. The
// contract routes it also calls (R1 me, R18 slug check, R4 create) go through
// the normal route table (SIGNUP_ROUTES). Everything is served from this
// Worker's code: the admin SPA bundle is never read on this host.

/** The sign-up host's CSP (4.5 adds Turnstile; nothing else leaves 'self'). */
export const SIGNUP_CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Create your Open Artifacts</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="app"></div>
<noscript><main class="ns"><h1>Create your Open Artifacts</h1><p>This page needs JavaScript to sign you in and create your instance.</p></main></noscript>
<script src="/app.js"></script>
</body>
</html>
`;

// The product favicon (same file as apps/admin/public/favicon.svg), light and dark.
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" role="img" aria-label="Open Artifacts">
  <title>Open Artifacts</title>
  <style>.f{fill:#15181C}.a{fill:#2350D0}@media (prefers-color-scheme: dark){.f{fill:#E9EBEE}.a{fill:#7F9CFF}}</style>
  <path class="f" d="M10 0H2.5A2.5 2.5 0 0 0 0 2.5V10l3 3V3h10zM6 16h7.5a2.5 2.5 0 0 0 2.5-2.5V6l-3-3v10H3z"/>
  <path class="a" d="M10 0h3.5A2.5 2.5 0 0 1 16 2.5V6zM0 10v3.5A2.5 2.5 0 0 0 2.5 16H6zM6 5h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>
</svg>
`;

const json = (body: unknown, status: number, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const asset = (body: string, type: string, cache: string) =>
  new Response(body, {
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": cache,
    },
  });

/** The static document and assets, or null for any other path. */
export function signupStatic(req: Request, path: string): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  if (path === "/app.css") return asset(CSS, "text/css", "public, max-age=300");
  if (path === "/app.js")
    return asset(CLIENT_JS, "text/javascript", "public, max-age=300");
  if (path === "/favicon.svg")
    return asset(FAVICON, "image/svg+xml", "public, max-age=86400");
  if (path === "/") return asset(HTML, "text/html", "no-store");
  return null;
}

/** `open` is false while SIGNUPS_ENABLED is "false"; "test-users" and "invite" show the form. */
export function signupConfig(env: Env): Response {
  return json(
    {
      open: env.SIGNUPS_ENABLED !== "false",
      appDomain: env.APP_DOMAIN,
      turnstileSiteKey: env.TURNSTILE_SITEKEY ?? null,
      // Billing is configured only where the BILLING binding exists (staging).
      billing: !!env.BILLING,
      docsUrl: "https://open-artifacts.com",
      githubUrl: "https://github.com/open-artifacts-ai/open-artifacts",
    },
    200,
    { "cache-control": "no-store" },
  );
}

type Row = { status: string; slug: string };
const STAGES = new Set([
  "pending",
  "queued",
  "waiting_cap",
  "creating",
  "ready",
  "failed",
]);

/**
 * The caller's newest self-serve sign-up: `stage` is the signups.status
 * (`pending` shows as queued). A failed one frees the address; the page shows
 * it so the person is told, and a new sign-up replaces it. A sign-up whose claim
 * is freed, or whose ready/creating install is deleting or deleted (a purge
 * leaves the row as it was), is not live: the page gets `none` and shows the form.
 */
export async function signupStatus(env: Env, p: Principal): Promise<Response> {
  const row = await env.PLATFORM_DB.prepare(
    `SELECT s.status AS status, s.slug AS slug FROM signups s
     LEFT JOIN signup_accounts a ON a.signup_id = s.signup_id
     LEFT JOIN installs i ON i.id = s.install_id
     WHERE s.signup_id = (SELECT signup_id FROM signups
       WHERE source = 'self-serve' AND owner_sub = ?1
       ORDER BY created_at DESC, signup_id DESC LIMIT 1)
     AND (s.status = 'failed' OR (
       (a.signup_id IS NULL OR a.freed_at IS NULL)
       AND (s.status NOT IN ('ready', 'creating')
         OR i.id IS NULL OR i.state NOT IN ('deleting', 'deleted'))))`,
  )
    .bind(p.sub ?? "")
    .first<Row>();
  const h = { "cache-control": "no-store" };
  // `gate` (#2096): allowed | waitlist | waitlisted, absent while closed.
  const gate = await gateOf(env, p);
  const g = gate === undefined ? {} : { gate };
  if (!row || !STAGES.has(row.status))
    return json({ stage: "none", ...g }, 200, h);
  return json(
    {
      ...g,
      stage: row.status === "pending" ? "queued" : row.status,
      slug: row.slug,
      host: `${row.slug}.${env.APP_DOMAIN}`,
    },
    200,
    h,
  );
}
