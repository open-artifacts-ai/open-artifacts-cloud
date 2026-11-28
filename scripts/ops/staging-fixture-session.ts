// Real email-code sign-in and /bus/approve browser flows for disposable t-*
// staging test installs.
import { launchFixtureBrowser } from "../../apps/provisioning/scripts/staging-fixture-browser.ts";
import { COOKIE, EMAIL, writeState } from "./staging-test-member.ts";

export const FIXTURE_TEST_DOMAIN = "oa-redline-a.fyi";
export const FIXTURE_OWNER_EMAIL = `fixture-owner@${FIXTURE_TEST_DOMAIN}`;
const FIXTURE_SLUG_RE = /^t-[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const BUS_PIN_RE =
  /p\.version==="((?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}(?:-[A-Za-z0-9.-]+)?)"&&p\.integrity==="(sha512-[A-Za-z0-9+/=]+)"/;
const SEND_CODE_BUTTON_RE = /^(Send code|Email me a code)$/;
const OTP_HOLD_MS = 8_000;
const OTP_MAX_ATTEMPTS = 4;

export type FixtureBrowser = Pick<
  Awaited<ReturnType<typeof launchFixtureBrowser>>,
  "close" | "newContext"
>;

export type FixtureBrowserPage = Awaited<
  ReturnType<Awaited<ReturnType<FixtureBrowser["newContext"]>>["newPage"]>
>;

export function fixtureHost(slug: string): string {
  if (!FIXTURE_SLUG_RE.test(slug))
    throw new Error("expected a t- staging fixture slug");
  return `${slug}.open-artifacts-staging.app`;
}

export function parseBusPinFromLlms(llmsText: string): {
  version: string;
  integrity: string;
} {
  const m = BUS_PIN_RE.exec(llmsText);
  if (!m?.[1] || !m[2])
    throw new Error(
      "fixture /llms.txt has no verified @open-artifacts/bus pin",
    );
  return { version: m[1], integrity: m[2] };
}

export async function verifyFixtureHealth(
  host: string,
  installId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const health = await fetcher(`https://${host}/healthz`, {
    redirect: "error",
  });
  if (!health.ok) throw new Error("fixture health check failed");
  const target = (await health.json()) as {
    ok?: unknown;
    testHooks?: unknown;
    installId?: unknown;
  } | null;
  if (
    !installId ||
    target?.ok !== true ||
    target.testHooks !== true ||
    target.installId !== installId
  )
    throw new Error("fixture identity mismatch");
}

async function postJson(
  fetcher: typeof fetch,
  origin: string,
  path: string,
  body: object,
  headers: Record<string, string>,
): Promise<Response> {
  return fetcher(origin + path, {
    method: "POST",
    redirect: "error",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function fetchLatestOtp(
  fetcher: typeof fetch,
  origin: string,
  email: string,
  hookKey: string,
): Promise<string> {
  const hook = { authorization: `Bearer ${hookKey}` };
  for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt++) {
    const res = await postJson(
      fetcher,
      origin,
      "/__test/otp/latest",
      { email, wait: OTP_HOLD_MS },
      hook,
    );
    if (res.status === 200) {
      const { code } = (await res.json()) as { code?: unknown };
      if (typeof code === "string" && /^\d{8}$/.test(code)) return code;
      throw new Error("staging fixture code unavailable");
    }
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as {
        error?: { details?: { reason?: unknown; outcome?: unknown } };
      } | null;
      if (
        body?.error?.details?.reason === "no_code" &&
        body.error.details.outcome === "pending"
      )
        continue;
    }
    throw new Error(`/__test/otp/latest: HTTP ${res.status}`);
  }
  throw new Error("staging fixture code remained pending");
}

async function signInWithEmailCode(
  page: FixtureBrowserPage,
  context: Awaited<ReturnType<FixtureBrowser["newContext"]>>,
  opts: {
    host: string;
    origin: string;
    email: string;
    expectedRole: "member" | "owner";
    hookKey: string;
    fetcher: typeof fetch;
  },
) {
  const { host, origin, email, expectedRole, hookKey, fetcher } = opts;
  // Keep top-level form submissions and navigations on the bound fixture.
  await page.route("**/*", (route) => {
    const req = route.request();
    if (
      req.isNavigationRequest() &&
      req.frame() === page.mainFrame() &&
      new URL(req.url()).origin !== origin
    )
      return route.abort();
    return route.fallback();
  });
  await page.goto(`${origin}/sign-in?method=code`);
  await page.locator('input[autocomplete="email"]').fill(email);
  // Hosted test-hooks installs render Cloudflare's always-pass Turnstile test
  // widget; wait for its hidden token input before submitting when present.
  const turnstileSlot = page.locator('[data-testid="turnstile"]');
  if ((await turnstileSlot.count()) > 0) {
    await page.waitForFunction(
      () => {
        const input = document.querySelector<HTMLInputElement>(
          '[data-testid="turnstile"] input[name="cf-turnstile-response"]',
        );
        return typeof input?.value === "string" && input.value.length > 0;
      },
      undefined,
      { timeout: 15_000 },
    );
  }
  const [sent] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url() === `${origin}/auth/code/request` &&
        r.request().method() === "POST",
    ),
    page.getByRole("button", { name: SEND_CODE_BUTTON_RE }).click(),
  ]);
  if (sent.status() !== 202)
    throw new Error(`fixture code request: HTTP ${sent.status()}`);
  const code = await fetchLatestOtp(fetcher, origin, email, hookKey);
  await page.locator('input[autocomplete="one-time-code"]').fill(code);
  const [verified] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url() === `${origin}/auth/code/verify` &&
        r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Verify", exact: true }).click(),
  ]);
  if (!verified.ok())
    throw new Error(`fixture verification: HTTP ${verified.status()}`);
  const { cookies } = await context.storageState();
  const session = cookies.find(
    (c) =>
      c.name === COOKIE &&
      c.domain === host &&
      c.path === "/" &&
      c.secure &&
      c.httpOnly,
  );
  if (!session) throw new Error("fixture session cookie missing");
  const me = await fetcher(`${origin}/api/v1/me`, {
    redirect: "error",
    headers: { cookie: `${COOKIE}=${session.value}` },
  });
  if (!me.ok) throw new Error(`fixture readback: HTTP ${me.status}`);
  const { user, auth } = (await me.json()) as {
    user?: { email?: unknown; role?: unknown };
    auth?: { expiresAt?: unknown };
  };
  if (user?.email !== email || user.role !== expectedRole)
    throw new Error(`staging ${expectedRole} identity mismatch`);
  if (
    typeof auth?.expiresAt !== "string" ||
    !(Date.parse(auth.expiresAt) > Date.now())
  )
    throw new Error("fixture session expired");
  return session;
}

/**
 * Seeds the fixture member via /__test/session, discards that hook cookie,
 * signs in through the real email-code browser UI (reading the 8-digit code
 * from /__test/otp/latest), verifies /api/v1/me, and writes a 0600 Playwright
 * storage state file.
 */
export async function fixtureMemberState(
  slug: string,
  installId: string,
  hookKey: string,
  dir: string,
  fetcher: typeof fetch = fetch,
  launch: () => Promise<FixtureBrowser> = launchFixtureBrowser,
): Promise<string> {
  const host = fixtureHost(slug);
  const origin = `https://${host}`;
  await verifyFixtureHealth(host, installId, fetcher);
  const seed = await postJson(
    fetcher,
    origin,
    "/__test/session",
    { email: EMAIL, role: "member" },
    { authorization: `Bearer ${hookKey}` },
  );
  if (seed.status !== 200)
    throw new Error(`/__test/session: HTTP ${seed.status}`);
  await seed.body?.cancel();
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const session = await signInWithEmailCode(page, context, {
      host,
      origin,
      email: EMAIL,
      expectedRole: "member",
      hookKey,
      fetcher,
    });
    return writeState({ cookies: [session], origins: [] }, dir);
  } finally {
    await browser.close();
  }
}

/**
 * Signs in as the fixture's test owner through the real email-code browser UI
 * and approves a pending `oa-bus login` device code at `/bus/approve`.
 */
export async function approveFixtureBusInBrowser(
  slug: string,
  installId: string,
  hookKey: string,
  userCode: string,
  fetcher: typeof fetch = fetch,
  launch: () => Promise<FixtureBrowser> = launchFixtureBrowser,
): Promise<void> {
  if (!USER_CODE_RE.test(userCode))
    throw new Error("expected an XXXX-XXXX bus approval code");
  const host = fixtureHost(slug);
  const origin = `https://${host}`;
  await verifyFixtureHealth(host, installId, fetcher);
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await signInWithEmailCode(page, context, {
      host,
      origin,
      email: FIXTURE_OWNER_EMAIL,
      expectedRole: "owner",
      hookKey,
      fetcher,
    });
    await page.goto(`${origin}/bus/approve`);
    await page.locator("#code").fill(userCode);
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page.getByRole("button", { name: "Continue", exact: true }).click(),
    ]);
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      page
        .locator('button[type="submit"][name="decision"][value="approve"]')
        .click(),
    ]);
    await page
      .getByRole("heading", { level: 1, name: "Machine connected" })
      .waitFor({ state: "visible", timeout: 15_000 });
  } finally {
    await browser.close();
  }
}
