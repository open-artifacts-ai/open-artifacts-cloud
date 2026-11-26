import { PROBES, type ProbeId } from "./provisioning.ts";
import type { Retired } from "./retired.ts";
import { type Citation, probeCases } from "./surfaces.ts";

// Cloud #264 step 2 (red-line page vZ2GyzVGZ2DCB7oW v3, adopted by Leo
// 2026-11-26 03:38:28Z): the live cases the page moves to PR CI, each taken
// out only once its PR CI replacement is merged (the ports: public #3146,
// #3150, #3158, cloud #472), and the cases the page deletes. Each names the
// tests that guard it now; retiredGaps (src/retired.ts) resolves every
// citation on every PR, so a replacement that goes away fails CI. The smoke
// cases and the nightly cases stay in the live suite, which runs nightly.

const MATRIX = "apps/server/test/authz.surface-matrix.test.ts";
const PROV = "apps/provisioning/test";
const c = (file: string, describe: string, test?: string): Citation =>
  test === undefined ? { file, describe } : { file, describe, test };

const HOSTED_MATRIX: Citation[] = [
  c(MATRIX, "artifact surfaces (sync stale 8 days)"),
  c(MATRIX, "instance routes"),
  c(MATRIX, "space writes (the service rules behind { user })"),
  // #3158: the same matrix once more with hosted settings (staging's rl-b).
  c(MATRIX, "GET /api/v1/settings/login: editable as the install's setup says"),
  c("apps/server/package.json", "test:authz:hosted"),
];
const FOREIGN = c(
  MATRIX,
  "foreign credentials: another install's, valid there (#1137)",
  "each works at A, the install that issued it, as B's owner id; at B it is no one",
);
const FOREIGN_SIGNED = c(
  MATRIX,
  "foreign credentials: another install's, valid there (#1137)",
  "foreign signed URLs: A's content tokens and upload signature for B's ids are refused at B",
);
const HOSTS = (test: string) =>
  c(
    "apps/server/test/hosts.test.ts",
    "the Worker answers only its own hosts",
    test,
  );
const CONTENT = (test: string) =>
  c("apps/server/test/content-host.test.ts", "content host serving", test);

const PR_CI = "moved to PR CI (red-line page v3)";
const DELETED = "deleted (red-line page v3)";

const one = (
  file: string,
  name: string,
  why: string,
  coveredBy: Citation[],
): Retired => ({ file: `live/${file}`, name, guards: "none", why, coveredBy });

const both = (
  file: string,
  name: (k: "a" | "b") => string,
  why: string,
  coveredBy: Citation[],
): Retired[] =>
  (["a", "b"] as const).map((k) => one(file, name(k), why, coveredBy));

/** The page's rows for the non-surface, non-provisioning files. */
const CASES: Retired[] = [
  // guard.test.ts
  one(
    "guard.test.ts",
    "guard > both targets report ok, testHooks: true and their own installId",
    `${DELETED}: a check of the two-install setup; the smoke's shared health check reads each install's own id`,
    [
      c(
        "apps/dashboard/e2e/staging/rl-a/guard.setup.ts",
        "rl-a reports testHooks and its own installId",
      ),
    ],
  ),
  ...both(
    "guard.test.ts",
    (k) => `hooks > ${k}: a wrong hook key gets the 404`,
    `${PR_CI}: test hooks exist only on staging, and prod-clean proves prod has none`,
    [
      c(
        "apps/server/test/test-hooks.audit.test.ts",
        "POST /__test/audit",
        "every gate is the identical 404",
      ),
    ],
  ),
  ...both(
    "guard.test.ts",
    (k) => `hooks > ${k}: the content host has no hooks`,
    `${PR_CI}: the content app has no API or hook routes, a code fact`,
    [CONTENT("the API and auth routes 404 on the content host")],
  ),
  ...both(
    "guard.test.ts",
    (k) => `hooks > ${k}: a hook call is audited`,
    `${PR_CI}: the harness's own audit trail, no prod surface`,
    [
      c(
        "apps/server/test/test-hooks.audit.test.ts",
        "POST /__test/audit",
        "a hook call shows up, and this call is itself audited",
      ),
    ],
  ),
  one(
    "guard.test.ts",
    "credentials (harness smoke) > A's admin PAT at B: the host's own marker artifact",
    `${DELETED}: the same sign-in refusal (resolveSession) as A's PAT on /api/v1/me, which stays nightly`,
    [FOREIGN],
  ),
  // credentials.test.ts
  one(
    "credentials.test.ts",
    "credentials > A's admin PAT at B: /mcp tools/list",
    `${DELETED}: the same sign-in refusal as A's PAT on /api/v1/me; the route can't change the answer`,
    [FOREIGN],
  ),
  one(
    "credentials.test.ts",
    "credentials > A's session cookie at B: replayed under the alternate cookie name",
    `${PR_CI}: cookie names are code, and another install's key is refused by design`,
    [
      c(
        "apps/server/test/host-session.test.ts",
        "__Host- session cookie",
        "prod ignores a planted plain cookie (validly signed); reads __Host-",
      ),
      FOREIGN,
    ],
  ),
  one(
    "credentials.test.ts",
    "credentials > B's content host ignores cookies, A's included",
    `${PR_CI} (public #3146)`,
    [
      CONTENT("a valid app login cookie does not unlock a private /p/ path"),
      CONTENT("never sets cookies on any route"),
    ],
  ),
  one(
    "credentials.test.ts",
    "credentials > OAuth endpoints > A's OAuth client_id in B's /authorize: no auto-grant",
    `${PR_CI} (public #3146)`,
    [
      c(
        "apps/server/test/authz/foreign-oauth.test.ts",
        "install A's OAuth client at install B's approval page",
        "A's client id gets no consent screen and no grant code at B; at A it gets consent",
      ),
    ],
  ),
  ...(["A", "B"] as const).map((k) =>
    one(
      "credentials.test.ts",
      `credentials > OAuth endpoints > A's OAuth refresh token at B's /token (${k}'s client_id): no token`,
      `${PR_CI} (public #3146)`,
      [
        c(
          "apps/server/test/authz/foreign-oauth.test.ts",
          "install A's OAuth grants at install B's token endpoint",
          "A's refresh token is refused at B with either client id, and still works at A",
        ),
      ],
    ),
  ),
  ...(["A", "B"] as const).map((k) =>
    one(
      "credentials.test.ts",
      `credentials > OAuth endpoints > An unredeemed A authorization code at B's /token (${k}'s client_id): no token`,
      `${PR_CI} (public #3146)`,
      [
        c(
          "apps/server/test/authz/foreign-oauth.test.ts",
          "install A's OAuth grants at install B's token endpoint",
          "A's unused grant code is refused at B with either client id, and A can still redeem it",
        ),
      ],
    ),
  ),
  one(
    "credentials.test.ts",
    "credentials > OAuth endpoints > An OAuth refresh straight after the redeem: a new token, on A and on B (#769)",
    `${PR_CI}: the store logic is tested with a stale cache; the smoke's health check requires oauthStore d1 or dual`,
    [
      c(
        "apps/server/test/oauth-store.test.ts",
        "#769 and revocation",
        "a refresh straight after the exchange works in d1 and dual (stale KV edge cache); kv shows the bug",
      ),
    ],
  ),
  one(
    "credentials.test.ts",
    "credentials > OAuth endpoints > A revoked OAuth refresh token is refused within KV's cache window, on A and on B",
    `${PR_CI}: revocation per store mode is covered locally; the smoke's health check requires d1 or dual`,
    [
      c(
        "apps/server/test/oauth-store.test.ts",
        "#769 and revocation",
        "a revoked token is refused at once in d1 and dual (stale KV edge cache)",
      ),
    ],
  ),
  one(
    "credentials.test.ts",
    "credentials > A's content signature with B's artifact id at B's content host",
    `${PR_CI}: a signature bound to one artifact id is code`,
    [FOREIGN_SIGNED],
  ),
  one(
    "credentials.test.ts",
    "credentials > A's signed upload URL at B",
    `${PR_CI}: the same per-install signing key as content links, whose reuse the nightly content-link check covers`,
    [FOREIGN_SIGNED],
  ),
  one(
    "credentials.test.ts",
    "credentials > B's private artifact id fetched with A's credentials at A: 404",
    `${DELETED}: an unknown id in A's own database`,
    [c(MATRIX, "artifact surfaces (sync stale 8 days)")],
  ),
  one(
    "credentials.test.ts",
    "credentials > links > A's invite link opened at B by a B member: no membership on B",
    `${DELETED}: re-proves isolation, and needed a lock on rl-b's member list`,
    [
      c(
        "apps/server/test/invite-reach.test.ts",
        "invite reachability (review item 11)",
      ),
      FOREIGN,
    ],
  ),
  one(
    "credentials.test.ts",
    "credentials > links > A's share email link opened at B by a B member: no share on B",
    `${DELETED}: re-proves isolation, and needed a lock on rl-b's member list`,
    [
      c(
        "apps/server/test/share-reach.test.ts",
        "share recipient reach (review item 37)",
      ),
      FOREIGN,
    ],
  ),
  // edge.test.ts
  ...both(
    "edge.test.ts",
    (k) =>
      `content host > ${k}: never serves app routes, with the install's own session or PAT`,
    `${PR_CI}: routing is server code; the smoke's view reaches the content address through the real edge`,
    [
      CONTENT("the API and auth routes 404 on the content host"),
      c(
        "apps/dispatch/test/dispatch.test.ts",
        "dispatch",
        "app and content hosts of one install dispatch to the same script",
      ),
    ],
  ),
  ...both(
    "edge.test.ts",
    (k) => `content host > ${k}: ignores cookies`,
    `${PR_CI}: a server code property; the smoke's private view checks no cookie is set`,
    [CONTENT("never sets cookies on any route")],
  ),
  one(
    "edge.test.ts",
    "mapping integrity > X-Forwarded-Host set to the other install is ignored",
    `${PR_CI}: the install is chosen from the real Host, in code`,
    [HOSTS("ignores X-Forwarded-Host in the other direction too")],
  ),
  one(
    "edge.test.ts",
    "mapping integrity > a host that is neither APP_HOST nor CONTENT_HOST gets the server's own 404",
    `${PR_CI}: a foreign Host is refused before any sign-in check, in code`,
    [
      HOSTS("answers a foreign host with a plain 404 before auth"),
      HOSTS("refuses foreign hosts on every pre-auth surface"),
    ],
  ),
  one(
    "edge.test.ts",
    "unmapped host > A's host spelled differently (case, trailing dot, :443) never reaches another install",
    `${PR_CI}: host normalizing is edge router and server code`,
    [
      HOSTS("normalizes case, a trailing dot and an explicit port"),
      c(
        "apps/dispatch/test/dispatch.test.ts",
        "dispatch",
        "uppercase, trailing dot and explicit port map to the same install",
      ),
    ],
  ),
  one(
    "edge.test.ts",
    "cross-site isolation > state-changing app requests without X-OA-Request are refused, and accepted with it",
    `${PR_CI}: pure server middleware`,
    [
      c(
        "apps/server/test/csrf.test.ts",
        "csrf",
        "cookie POST without X-OA-Request → 403 csrf",
      ),
      c(
        "apps/server/test/csrf.test.ts",
        "csrf",
        "cookie POST with the header passes",
      ),
    ],
  ),
  // signin.test.ts
  one(
    "signin.test.ts",
    "sign-in: OIDC state and nonce > A's OIDC state with B's own state cookie at B: no session",
    `${PR_CI}: tying the state to its cookie is code`,
    [
      c(
        "apps/server/test/oidc.test.ts",
        "GET /auth/callback",
        "state mismatch → retry",
      ),
      c(
        "apps/server/test/oidc.test.ts",
        "GET /auth/callback",
        "rejects forged state cookie",
      ),
    ],
  ),
  one(
    "signin.test.ts",
    "sign-in: ID tokens > an ID token with hd of A at B's callback: no session",
    `${PR_CI}: it needed a human capture and was unproven live; the fake-Google PR test runs the real check`,
    [
      c(
        "apps/server/test/xt-google.local.test.ts",
        "login ID-token cases across installs (fake Google)",
        "an ID token with a B email domain but hd of A: no session",
      ),
    ],
  ),
  one(
    "signin.test.ts",
    "sign-in: ID tokens > A's code and broker state at B: no session",
    `${PR_CI}: it needed a human capture and was unproven live; the fake-Google PR test runs the real check`,
    [
      c(
        "apps/server/test/xt-google.local.test.ts",
        "login ID-token cases across installs (fake Google)",
        "an ID token minted for A's client (aud) replayed at B: no session",
      ),
      c(
        "apps/server/test/oidc.test.ts",
        "GET /auth/callback",
        "rejects wrong aud",
      ),
    ],
  ),
  one(
    "signin.test.ts",
    "sign-in: broker > a tampered install id at the broker callback is refused",
    `${PR_CI}: the broker's signature check is code; a broken broker breaks the smoke's Google sign-in start`,
    [
      c(
        "apps/auth-broker/test/broker.test.ts",
        "callback",
        "a broker state with the install swapped (or any tampering) is refused",
      ),
    ],
  ),
  one(
    "signin.test.ts",
    "sign-in: one-time codes > a code requested at B for an address not invited to B: no code sent, generic response",
    `${PR_CI}: who can get a code, and the answer's shape, are server code`,
    [
      c(
        "apps/server/test/code-routes.test.ts",
        "POST AUTH.codeRequest",
        "the 202 is byte-identical for eligible, ineligible and email-off addresses",
      ),
      c(
        "apps/server/test/code-send-outcomes.test.ts",
        "deliverCode: one code_send line per outcome",
        "ineligible",
      ),
    ],
  ),
  one(
    "signin.test.ts",
    "sign-in: guests > a guest of A invited to B reads on B but can't publish via MCP or the data API there",
    `${PR_CI}: the guest limit is login policy in code`,
    [
      c(
        "apps/server/test/guest-readonly.test.ts",
        "guest read cap (direct login)",
        "a guest with an editor share can read, but every write is refused",
      ),
      c(
        "apps/server/test/auth-routes.test.ts",
        "Me login fields",
        "a guest under direct login is read-only with cap guest",
      ),
    ],
  ),
  one(
    "signin.test.ts",
    "sign-in: OIDC state and nonce > A's OIDC state and state cookie (with its nonce) replayed at B: no session",
    `${DELETED}: each install has its own keys; the nightly login-cookie check proves the secrets differ`,
    [
      c(
        "apps/server/test/xt-google.local.test.ts",
        "login ID-token cases across installs (fake Google)",
        "A's OIDC state and state cookie replayed at B: no session, never redeemed",
      ),
    ],
  ),
  ...(["B", "A"] as const).map((k) =>
    one(
      "signin.test.ts",
      `sign-in: one-time codes > a code issued by A, entered at B with ${k}'s pending cookie: refused`,
      `${DELETED}: each install keeps its codes in its own database`,
      [
        c(
          "apps/server/test/codes.test.ts",
          "verifyCode",
          "a code from install A does not verify on install B",
        ),
      ],
    ),
  ),
  one(
    "signin.test.ts",
    "sign-in: guests > the guest's B session is refused at A",
    `${DELETED}: the same as another install's login cookie, refused by its own session secret`,
    [FOREIGN],
  ),
  // live.test.ts
  ...(["data-subscribe", "events"] as const).flatMap((s) =>
    (["app", "content"] as const).map((o) =>
      one(
        "live.test.ts",
        `WebSocket at B with B's own session and A's Origin: refused > ${s} with Origin = A's ${o} origin`,
        `${PR_CI} (public #3146)`,
        [
          c(
            "apps/server/test/socket-origin.test.ts",
            "socket Origin check with hosted neighbouring addresses",
          ),
        ],
      ),
    ),
  ),
  one(
    "live.test.ts",
    "anonymous writes on a B public artifact > the fixture accepts an anonymous write",
    `${PR_CI}: plain app behaviour in the artifact's storage`,
    [c("apps/server/test/anon-id.test.ts", "anonId issuance")],
  ),
  one(
    "live.test.ts",
    "anonymous writes on a B public artifact > A's PAT sent along does not change the actor to A's user",
    `${PR_CI} (public #3146)`,
    [
      c(
        "apps/server/test/anon-id.test.ts",
        "anonId issuance",
        "an unknown bearer on an allowAnonymousWrites PUT is stored as anon",
      ),
    ],
  ),
  ...(["data-subscribe", "events"] as const).flatMap((s) =>
    (["PAT", "session"] as const).map((k) =>
      one(
        "live.test.ts",
        `WebSocket at B with A's credential: no 101 > ${s} with A's ${k}`,
        `${DELETED}: the same refusal as the login-session canary, which the smoke runs`,
        [FOREIGN],
      ),
    ),
  ),
  // provisioner.test.ts
  one(
    "provisioner.test.ts",
    "provisioner > a replayed signup creates nothing new",
    `${PR_CI}: a repeat message handled once is plain code; it was unproven live every run`,
    [
      c(
        "apps/provisioner/test/consumer.test.ts",
        "handleSignup",
        "a settled row is acked and never restarted",
      ),
    ],
  ),
  one(
    "provisioner.test.ts",
    "provisioner > a signup for a taken slug fails cleanly",
    `${DELETED}: duplicates the second-create refusal and a unit test; it was unproven live every run`,
    [
      c(
        `${PROV}/writes.test.ts`,
        "R4 create by an admin session",
        "slug_taken by an installs row or a live signup; a failed signup frees it",
      ),
    ],
  ),
];

/** The provisioning probes the page moves to PR CI or deletes, with their replacements. */
export const RETIRED_PROBES: Readonly<Partial<Record<ProbeId, Citation[]>>> =
  Object.freeze({
    P1: [
      c(
        `${PROV}/session.test.ts`,
        "authenticate on the admin host (4.5)",
        "no cookie, junk, unknown, expired, revoked or a removed identity: unauthenticated",
      ),
    ],
    P2: [
      c(
        `${PROV}/session.test.ts`,
        "authenticate on the admin host (4.5)",
        "no cookie, junk, unknown, expired, revoked or a removed identity: unauthenticated",
      ),
    ],
    P3: [
      c(
        `${PROV}/session.test.ts`,
        "authenticate on the admin host (4.5)",
        "the api host ignores the cookie",
      ),
    ],
    P4: [
      c(
        `${PROV}/authenticate.test.ts`,
        "authenticate: admin host (W5a session)",
      ),
      c(`${PROV}/app.test.ts`, "host policy (2.2)"),
    ],
    P5: [
      c(`${PROV}/session.test.ts`, "Origin and Sec-Fetch-Site (before authn)"),
      c(`${PROV}/refuse.test.ts`, "refuse (4.9)"),
    ],
    P8: [
      c(`${PROV}/test-member.test.ts`, "authz: the test member's allowlist"),
      c(`${PROV}/reads.test.ts`, "R2 list and R3 detail"),
    ],
    P9: [
      c(`${PROV}/test-member.test.ts`, "authz: the test member's allowlist"),
      c(
        `${PROV}/writes.test.ts`,
        "R4 self-serve policy (4.2 order)",
        "forbidden fields first (403), before signups_closed",
      ),
    ],
    P10: [
      c(
        `${PROV}/reads.test.ts`,
        "R2 list and R3 detail",
        "O sees rl- test installs only; U its own only",
      ),
      c(`${PROV}/mcp-oidc.test.ts`, "OIDC on staging /mcp (9A.10)"),
    ],
    P11: [
      c(
        `${PROV}/test-member.test.ts`,
        "authz: the test member's allowlist",
        "staging: exactly R2, R15 and R26, each with own reach; every other route is 403",
      ),
    ],
    P12: [
      c(
        `${PROV}/test-member.test.ts`,
        "authz: the test member's allowlist",
        "through invokeRoute: every API route off the allowlist answers 403 forbidden",
      ),
      c(`${PROV}/writes.test.ts`, "lifecycle writes (R5-R13)"),
    ],
    P14: [
      c(
        `${PROV}/writes.test.ts`,
        "R4 create by an admin session",
        "two concurrent creates of one slug: one 202, one slug_taken",
      ),
    ],
    P16: [
      c(
        `${PROV}/writes.test.ts`,
        "lifecycle writes (R5-R13)",
        "job_in_progress (with details.jobId) is checked before invalid_state",
      ),
    ],
    P17: [
      c(
        `${PROV}/writes.test.ts`,
        "R4 create by an admin session",
        "a version absent from GET /releases is 422 release_not_published",
      ),
    ],
    P18: [
      c(
        `${PROV}/writes.test.ts`,
        "lifecycle writes (R5-R13)",
        "R5 upgrade: default latest installable; at or below current is downgrade_refused",
      ),
    ],
    P19: [
      c(
        `${PROV}/writes.test.ts`,
        "lifecycle writes (R5-R13)",
        "R9 delete: confirmSlug must match (400 confirm_mismatch, no job)",
      ),
    ],
    P26: [
      c(
        `${PROV}/routes.test.ts`,
        "route table (3.4)",
        "the admin site has no test sign-in route: /auth/test-signin is 404",
      ),
    ],
    P30: [
      c(
        `${PROV}/signin.test.ts`,
        "R23 /auth/callback/google",
        "missing, tampered or expired flow cookie, or another state: 303 /sign-in?error=expired, no redeem",
      ),
    ],
    P33: [
      c(
        `${PROV}/audit.test.ts`,
        "audit()",
        "writes the principal's actor, the HMACs and the detail",
      ),
    ],
    P37: [
      c(
        `${PROV}/mcp.test.ts`,
        "transport (9A.2, 9A.6)",
        "no bearer, a forged oat_, an opaque bearer, a cookie: 401 with the challenge",
      ),
    ],
    P39: [
      c(
        `${PROV}/mcp.test.ts`,
        "transport (9A.2, 9A.6)",
        "no bearer, a forged oat_, an opaque bearer, a cookie: 401 with the challenge",
      ),
    ],
    P40: [
      c(
        `${PROV}/mcp.test.ts`,
        "transport (9A.2, 9A.6)",
        "/mcp on the admin host is 404",
      ),
      c(`${PROV}/routes.test.ts`, "route table (3.4)"),
    ],
    P41: [
      c(
        `${PROV}/mcp.test.ts`,
        "transport (9A.2, 9A.6)",
        "a foreign Origin is 403 with any bearer, before authn and the body cap",
      ),
    ],
    P42: [
      c(
        `${PROV}/mcp.test.ts`,
        "transport (9A.2, 9A.6)",
        "over 32 KiB: 413, JSON-RPC -32000, before authn",
      ),
    ],
    P43: [
      c(
        `${PROV}/oauth.test.ts`,
        "GET /oauth/authorize: cookie, bounce, session left",
        "no session, cross-site: 200 bounce page to the same URL plus b=1",
      ),
    ],
    P44: [
      c(
        `${PROV}/oauth.test.ts`,
        "DCR (/oauth/register)",
        "loopback with a port and the exact MCP_REDIRECT_URIS entry are accepted",
      ),
    ],
    P47: [
      c(`${PROV}/authenticate.test.ts`, "authenticate: oat_ bearer (api host)"),
    ],
    P48: [
      c(
        `${PROV}/reads.test.ts`,
        "R2 list and R3 detail",
        "q matches the id and the stored hosts in any case; %, _ and quotes are literal",
      ),
    ],
    P49: [
      c(
        `${PROV}/reads.test.ts`,
        "R2 list and R3 detail",
        "q matches the owner email for admin and installs:pii only; anyone else gets the no-match answer",
      ),
    ],
    // Deleted: the bus file's own pair proves the suspend close (4403).
    P51: [c("tests/redline/live/bus.test.ts", "bus")],
  });

/** The probe ids out of the live run. */
export const RETIRED_PROBE_IDS: ReadonlySet<ProbeId> = new Set(
  Object.keys(RETIRED_PROBES) as ProbeId[],
);

const PROBE_CASES: Retired[] = PROBES.filter((p) =>
  RETIRED_PROBE_IDS.has(p.id),
).map((p) =>
  one(
    "provisioning.test.ts",
    `provisioning > ${p.id}: ${p.title}`,
    p.id === "P51"
      ? `${DELETED}: repeats the bus file's suspend case; the bus is off on rl-l (HOSTED_BUS_LIFTED false)`
      : `${PR_CI}: a rule in code`,
    RETIRED_PROBES[p.id] ?? [],
  ),
);

/**
 * The surface probes that stay live (nightly): one session and one PAT
 * cross-install refusal (the page's "one install's real login and token"),
 * the OAuth token at the other install's MCP, the OAuth grant edit and
 * revoke on the real KV, and the upload reservation the smoke also runs.
 */
export const KEPT_SURFACES: ReadonlySet<string> = new Set([
  "artifact rest uploads [session]",
  "artifact rest uploads [pat]",
  "artifact mcp create_upload [pat]",
  "artifact mcp get_artifact [oauth]",
  "org PATCH /api/v1/oauth-clients/:grantId [session]",
  "org DELETE /api/v1/oauth-clients/:grantId [session]",
]);

const SURFACE = "surface probes (cross-install) > ";
export const SURFACE_COVERAGE =
  "every ROUTE_POLICY route, MCP tool and content route has a case";

const SURFACE_CASES: Retired[] = [
  one(
    "surfaces.test.ts",
    `${SURFACE}${SURFACE_COVERAGE}`,
    `${PR_CI}: a static check with no request, which already runs on every PR`,
    [
      c(
        "tests/redline/test/surfaces.test.ts",
        "probe cases (derived from Backend's surfaces)",
        "cover every ROUTE_POLICY route, MCP tool and content route",
      ),
      c(MATRIX, "coverage (derived from the router and the registries)"),
    ],
  ),
  ...probeCases()
    .filter((p) => !KEPT_SURFACES.has(p.name))
    .map((p) =>
      one(
        "surfaces.test.ts",
        `${SURFACE}${p.name}`,
        `${PR_CI} (public #3158): the allow/deny table on every route runs on every PR, once with hosted settings; another install's login with no allowed leg is deleted`,
        HOSTED_MATRIX,
      ),
    ),
];

export const SPLIT_RETIRED: readonly Retired[] = [
  ...CASES,
  ...PROBE_CASES,
  ...SURFACE_CASES,
];
