import { expect, type Page, test } from "@playwright/test";
import { SIGNUP_CSP, signupStatic } from "../src/signup/index.js";

// The sign-up page in a real browser, with the API mocked: every stage renders
// a heading (no empty header), and nothing trips the page's own CSP (no inline
// styles). With SHOTS_DIR set it also writes one screenshot per state, light
// and dark, desktop and phone.

const ORIGIN = "https://signup.test";
type Sc = {
  open?: boolean;
  me?: boolean;
  stage?: string;
  slug?: string;
  avail?: string;
  createCode?: string;
  path?: string;
};

async function mount(page: Page, sc: Sc): Promise<string[]> {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text()))
      violations.push(m.text());
  });
  await page.route("https://challenges.cloudflare.com/**", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `window.turnstile={render:function(_,o){setTimeout(function(){o.callback("tok")},0);return 1},reset:function(){}};window.__oaTsLoaded&&window.__oaTsLoaded();`,
    }),
  );
  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    const s = signupStatic(new Request(req.url()), url.pathname);
    if (s)
      return route.fulfill({
        status: s.status,
        contentType: s.headers.get("content-type") ?? "text/plain",
        headers: { "content-security-policy": SIGNUP_CSP },
        body: await s.text(),
      });
    if (url.pathname === "/api/v1/config")
      return json({
        open: sc.open !== false,
        appDomain: "open-artifacts.app",
        turnstileSiteKey: "1x00000000000000000000AA",
        supportEmail: "support@open-artifacts.app",
        docsUrl: "https://open-artifacts.com",
        githubUrl: "https://github.com/open-artifacts-ai/open-artifacts",
      });
    if (url.pathname === "/api/v1/me")
      return sc.me
        ? json({ principal: "user", email: "ada@acme.com", csrf: "c" })
        : json({ error: { code: "unauthorized" } }, 401);
    if (url.pathname === "/api/v1/signup")
      return json(
        sc.stage
          ? {
              stage: sc.stage,
              slug: sc.slug ?? "acme",
              host: `${sc.slug ?? "acme"}.open-artifacts.app`,
            }
          : { stage: "none" },
      );
    if (url.pathname.startsWith("/api/v1/slugs/"))
      return json({ status: sc.avail ?? "ok" });
    if (url.pathname === "/api/v1/installs" && req.method() === "POST")
      return json({ error: { code: sc.createCode ?? "forbidden" } }, 403);
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`${ORIGIN}${sc.path ?? "/"}`);
  return violations;
}

const STAGE_HEADING: Record<string, RegExp> = {
  queued: /^Setting up acme\.open-artifacts\.app$/,
  waiting_cap: /^Setting up acme\.open-artifacts\.app$/,
  creating: /^Setting up acme\.open-artifacts\.app$/,
  ready: /^acme\.open-artifacts\.app is ready$/,
  failed: /^We couldn't set up acme\.open-artifacts\.app$/,
};

for (const [stage, heading] of Object.entries(STAGE_HEADING)) {
  test(`stage ${stage}: heading first, steps under it, no CSP violations`, async ({
    page,
  }) => {
    const v = await mount(page, { me: true, stage });
    const panel = page.locator(".panel");
    await expect(panel.locator("h1")).toHaveText(heading);
    // the heading is the panel's first child: nothing blank above the divider
    expect(await panel.evaluate((p) => p.firstElementChild?.tagName)).toBe(
      "H1",
    );
    await expect(panel.locator(".steps li")).toHaveCount(3);
    if (stage === "ready") {
      await expect(panel.locator("> :last-child")).toHaveText(
        "Open your instance",
      );
    }
    if (stage === "failed") {
      await expect(
        page.getByRole("button", { name: "Start over" }),
      ).toBeVisible();
    }
    expect(await page.locator("[style]").count()).toBe(0);
    expect(v).toEqual([]);
  });
}

test("failed: Start over returns to the form", async ({ page }) => {
  await mount(page, { me: true, stage: "failed" });
  await page.getByRole("button", { name: "Start over" }).click();
  await expect(page.locator("h1")).toHaveText("Create your Open Artifacts");
});

test("workspace error: banner offers another account and the field is not green", async ({
  page,
}) => {
  const v = await mount(page, {
    me: true,
    avail: "ok",
    createCode: "forbidden",
  });
  await page.locator("#slug").fill("acme");
  await expect(page.locator(".inp.ok")).toHaveCount(1);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(
    page.getByRole("button", { name: "Use another Google account" }),
  ).toBeVisible();
  await expect(page.locator(".inp.ok")).toHaveCount(0);
  await expect(page.locator(".help.ok")).toHaveCount(0);
  expect(await page.locator("[style]").count()).toBe(0);
  expect(v).toEqual([]);
});

test("taken: suggestions appear once, as chips", async ({ page }) => {
  await mount(page, { me: true, avail: "taken" });
  await page.locator("#slug").fill("acme");
  await expect(page.locator(".help")).toHaveText(
    "acme.open-artifacts.app is taken.",
  );
  await expect(page.locator(".sugg button")).toHaveCount(2);
});

test("form and closed pages have no inline styles and no CSP violations", async ({
  page,
}) => {
  for (const sc of [{ open: false }, { me: false }, { me: true }] as Sc[]) {
    const v = await mount(page, sc);
    await expect(page.locator("h1")).toBeVisible();
    expect(await page.locator("[style]").count()).toBe(0);
    expect(v).toEqual([]);
  }
});

const SHOTS = process.env.SHOTS_DIR;
const STATES: Record<string, Sc & { act?: (p: Page) => Promise<void> }> = {
  closed: { open: false },
  "form-signed-out": { me: false },
  "form-notice-expired": { me: false, path: "/?error=expired" },
  "form-signed-in-empty": { me: true },
  "form-invalid": { me: true, act: (p) => p.locator("#slug").fill("-bad-") },
  "form-available": {
    me: true,
    avail: "ok",
    act: (p) => p.locator("#slug").fill("acme"),
  },
  "form-taken": {
    me: true,
    avail: "taken",
    act: (p) => p.locator("#slug").fill("acme"),
  },
  "form-error-workspace": {
    me: true,
    avail: "ok",
    act: async (p) => {
      await p.locator("#slug").fill("acme");
      await expect(p.locator(".inp.ok")).toHaveCount(1);
      await p.getByRole("button", { name: "Create" }).click();
      await expect(
        p.getByRole("button", { name: "Use another Google account" }),
      ).toBeVisible();
    },
  },
  "setup-queued": { me: true, stage: "queued" },
  "setup-waiting-cap": { me: true, stage: "waiting_cap" },
  "setup-creating": { me: true, stage: "creating" },
  "setup-ready": { me: true, stage: "ready" },
  "setup-failed": { me: true, stage: "failed" },
};
test.describe("screenshots", () => {
  test.skip(!SHOTS, "set SHOTS_DIR to write screenshots");
  for (const [name, sc] of Object.entries(STATES))
    for (const scheme of ["light", "dark"] as const)
      for (const [dev, size] of [
        ["desktop", { width: 1280, height: 800 }],
        ["phone", { width: 390, height: 844 }],
      ] as const)
        test(`${name} ${scheme} ${dev}`, async ({ page }) => {
          await page.setViewportSize(size);
          await page.emulateMedia({
            colorScheme: scheme,
            reducedMotion: "reduce",
          });
          await mount(page, sc);
          await page.locator("h1").first().waitFor();
          await sc.act?.(page);
          await page.waitForTimeout(450);
          await page.screenshot({
            path: `${SHOTS}/${name}-${scheme}-${dev}.png`,
            fullPage: true,
          });
        });
});
