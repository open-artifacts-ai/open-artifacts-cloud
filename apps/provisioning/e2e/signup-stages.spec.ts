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
  // when set, only these names are free (others read as taken)
  free?: string[];
  // delay (ms) on the slug-check answers
  slugDelay?: number;
  createCode?: string;
  // the beta gate in GET /api/v1/signup (absent: as while sign-ups are open)
  gate?: string;
  // POST /api/v1/signup/waitlist: delay (ms), status and what was sent
  joinDelay?: number;
  joinStatus?: number;
  joined?: unknown[];
  // create answers 403 forbidden with details.reason (the not_invited race)
  createReason?: string;
  path?: string;
  // per-request override of GET /api/v1/signup (n counts calls, from 1)
  signup?: (n: number) => { status: number; body?: unknown };
};

async function mount(page: Page, sc: Sc): Promise<string[]> {
  const violations: string[] = [];
  let signupCalls = 0;
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
        docsUrl: "https://open-artifacts.com",
        githubUrl: "https://github.com/open-artifacts-ai/open-artifacts",
      });
    if (url.pathname === "/api/v1/me")
      return sc.me
        ? json({ principal: "user", email: "ada@acme.com", csrf: "c" })
        : json({ error: { code: "unauthorized" } }, 401);
    if (url.pathname === "/api/v1/signup" && sc.signup) {
      const o = sc.signup(++signupCalls);
      return json(o.body ?? {}, o.status);
    }
    if (url.pathname === "/api/v1/signup/waitlist" && req.method() === "POST") {
      sc.joined?.push(req.postDataJSON());
      if (sc.joinDelay) await new Promise((r) => setTimeout(r, sc.joinDelay));
      return sc.joinStatus && sc.joinStatus !== 200
        ? json({ error: { code: "internal" } }, sc.joinStatus)
        : json({ gate: "waitlisted" });
    }
    if (url.pathname === "/api/v1/signup")
      return json(
        sc.stage
          ? {
              stage: sc.stage,
              slug: sc.slug ?? "acme",
              host: `${sc.slug ?? "acme"}.open-artifacts.app`,
            }
          : { stage: "none", ...(sc.gate ? { gate: sc.gate } : {}) },
      );
    if (url.pathname.startsWith("/api/v1/slugs/")) {
      if (sc.slugDelay) await new Promise((r) => setTimeout(r, sc.slugDelay));
      return json({
        status: sc.free
          ? sc.free.includes(url.pathname.split("/").pop() ?? "")
            ? "ok"
            : "taken"
          : (sc.avail ?? "ok"),
      });
    }
    if (url.pathname === "/api/v1/installs" && req.method() === "POST")
      return json(
        {
          error: {
            code: sc.createCode ?? "forbidden",
            ...(sc.createReason
              ? { details: { reason: sc.createReason } }
              : {}),
          },
        },
        403,
      );
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
    if (stage === "ready" || stage === "failed")
      await expect(panel.locator(".steps li")).toHaveCount(3);
    else await expect(panel.locator(".steps")).toHaveCount(0);
    if (stage === "ready") {
      await expect(panel.locator("> :last-child")).toHaveText(
        "Open your instance",
      );
    }
    if (stage === "failed") {
      await expect(
        page.getByRole("button", { name: "Try again" }),
      ).toBeVisible();
    }
    expect(await page.locator("[style]").count()).toBe(0);
    expect(v).toEqual([]);
  });
}

test("failed: Try again returns to the form", async ({ page }) => {
  await mount(page, { me: true, stage: "failed" });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("h1")).toHaveText("Choose your address");
});

const creating = (stage: string) => ({
  status: 200,
  body: { stage, slug: "acme", host: "acme.open-artifacts.app" },
});
const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((hd) => {
    Object.defineProperty(document, "hidden", {
      value: hd,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

// one poll interval, then a real pause so the mocked response is handled
const tick = async (page: Page) => {
  await page.clock.runFor(5000);
  await new Promise((r) => setTimeout(r, 250));
};

test("poll: skips while hidden, polls at once when the tab returns", async ({
  page,
}) => {
  await page.clock.install();
  let stage = "queued";
  let calls = 0;
  await mount(page, {
    me: true,
    stage: "queued",
    signup: () => {
      calls++;
      return creating(stage);
    },
  });
  await expect(page.locator(".panel .addr")).toHaveText(
    "Creating acme.open-artifacts.app\u2026",
  );
  await setHidden(page, true);
  const hiddenAt = calls;
  await page.clock.runFor(15000);
  expect(calls).toBe(hiddenAt);
  stage = "waiting_cap";
  await setHidden(page, false);
  await expect(page.locator(".panel .addr")).toHaveText(
    "Lots of people are signing up right now. You're in line, and it starts on its own.",
  );
});

test("poll: notice after 3 failures, cleared on the next success", async ({
  page,
}) => {
  await page.clock.install();
  let fail = false;
  await mount(page, {
    me: true,
    stage: "queued",
    signup: () => (fail ? { status: 503 } : creating("queued")),
  });
  await expect(page.locator(".panel .addr")).toHaveText(
    "Creating acme.open-artifacts.app\u2026",
  );
  fail = true;
  await tick(page);
  await tick(page);
  await expect(page.getByRole("status")).toHaveText("");
  await tick(page);
  await expect(page.getByRole("status")).toHaveText(
    "Can't reach the server. Retrying\u2026",
  );
  fail = false;
  await tick(page);
  await expect(page.getByRole("status")).toHaveText("");
});

test("poll: a 429 counts as a failure and keeps the stage", async ({
  page,
}) => {
  await page.clock.install();
  let bad = false;
  await mount(page, {
    me: true,
    stage: "queued",
    signup: () => (bad ? { status: 429 } : creating("queued")),
  });
  await expect(page.locator("h1")).toHaveText(
    "Setting up acme.open-artifacts.app",
  );
  bad = true;
  await tick(page);
  await tick(page);
  await tick(page);
  await expect(page.getByRole("status")).toHaveText(
    "Can't reach the server. Retrying\u2026",
  );
  await expect(page.locator("h1")).toHaveText(
    "Setting up acme.open-artifacts.app",
  );
});

for (const [name, gonesResp] of [
  ["stage none", { status: 200, body: { stage: "none" } }],
  ["404", { status: 404 }],
] as const)
  test(`poll: ${name} (signup gone) returns to the form`, async ({ page }) => {
    await page.clock.install();
    let gone = false;
    await mount(page, {
      me: true,
      stage: "queued",
      signup: () => (gone ? gonesResp : creating("queued")),
    });
    await expect(page.locator("h1")).toHaveText(
      "Setting up acme.open-artifacts.app",
    );
    gone = true;
    await tick(page);
    await expect(page.locator("h1")).toHaveText("Choose your address");
  });

test("poll: a 401 goes to sign-in", async ({ page }) => {
  await page.clock.install();
  let expired = false;
  await mount(page, {
    me: true,
    stage: "queued",
    signup: () => (expired ? { status: 401 } : creating("queued")),
  });
  await expect(page.locator(".panel .addr")).toHaveText(
    "Creating acme.open-artifacts.app\u2026",
  );
  expired = true;
  await tick(page);
  await expect(page.locator("h1")).toHaveText("Create your Open Artifacts");
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toBeVisible();
});

test("taken: suggestions appear once, as chips", async ({ page }) => {
  await mount(page, { me: true, avail: "taken" });
  await page.locator("#slug").fill("acme");
  await expect(page.locator(".help")).toHaveText(
    "acme.open-artifacts.app is taken.",
  );
  await expect(page.locator(".sugg button")).toHaveCount(2);
});

test("cooling: Product's copy, with suggestions as for taken (cloud #108)", async ({
  page,
}) => {
  await mount(page, { me: true, avail: "cooling" });
  await page.locator("#slug").fill("acme");
  await expect(page.locator(".help")).toHaveText(
    "acme.open-artifacts.app was used recently and isn't available yet. Pick another address.",
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

test("closed view reads exactly, newcomer first", async ({ page }) => {
  await mount(page, { open: false });
  await expect(page.locator("h1")).toHaveText("Sign-ups are closed for now");
  await expect(page.locator(".panel > p").first()).toHaveText(
    "We're not opening new instances yet. You can run Open Artifacts yourself today, free and open source.",
  );
  const run = page.getByRole("link", { name: "Run it yourself" });
  await expect(run).toHaveAttribute(
    "href",
    "https://open-artifacts.com/docs/setup/",
  );
  await expect(run).toHaveClass(/pri/);
  await expect(page.locator(".or")).toHaveText("or");
  await expect(page.getByLabel("Already have an instance?")).toBeVisible();
  const go = page.getByRole("button", { name: "Go to it" });
  await expect(go).not.toHaveClass(/pri/);
  await expect(page.locator(".panel .muted.small")).toHaveText(
    "It runs on your own Cloudflare account.",
  );
  // The Cloudflare line sits right under "Run it yourself", before "or".
  await expect(run.locator("xpath=following-sibling::*[1]")).toHaveText(
    "It runs on your own Cloudflare account.",
  );
  // Focus order follows the visual order: link, field, button.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a,input,button")).map(
      (e) => e.textContent || e.id,
    ),
  );
  expect(order.slice(-3)).toEqual(["Run it yourself", "go", "Go to it"]);
  // Today's behaviour: a bad slug shows the hint and stays put.
  await page.locator("#go").fill("-bad-");
  await go.click();
  await expect(page.locator("#go-help")).toHaveText(
    "Use letters, numbers and hyphens.",
  );
});

test("closed view: the Cloudflare line is centred under the button", async ({
  page,
}) => {
  await mount(page, { open: false });
  const line = page.locator(".panel .muted.small");
  expect(await line.evaluate((e) => getComputedStyle(e).textAlign)).toBe(
    "center",
  );
});

test("footer links: Docs, Hosted and GitHub; no support@ anywhere", async ({
  page,
}) => {
  await mount(page, { me: true, stage: "failed" });
  const links = page.locator(".top .links a");
  await expect(links).toHaveText(["Docs", "Hosted", "GitHub"]);
  await expect(links.nth(1)).toHaveAttribute(
    "href",
    "https://open-artifacts.com/docs/hosted/",
  );
  await expect(page.getByRole("link", { name: "Email support" })).toHaveAttribute(
    "href",
    "mailto:hello@open-artifacts.com",
  );
});

const JOIN_LEAD =
  "We're letting people in a few at a time. Join the waitlist and we'll email you when it's your turn.";

test("beta: waitlist shows the join screen, a note is sent, then on the list", async ({
  page,
}) => {
  const joined: unknown[] = [];
  const v = await mount(page, { me: true, gate: "waitlist", joined });
  await expect(page.locator("h1")).toHaveText(
    "Open Artifacts is in private beta",
  );
  await expect(page.locator(".panel .lead")).toHaveText(JOIN_LEAD);
  await expect(page.locator(".who")).toContainText("ada@acme.com");
  await expect(page.getByRole("button", { name: "Not you?" })).toBeVisible();
  await expect(
    page.getByLabel("What would you use it for? (optional)"),
  ).toHaveAttribute("maxlength", "280");
  await expect(page.locator("#use")).toHaveAttribute("rows", "2");
  await page.locator("#use").fill("Client status pages");
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(page.locator("h1")).toHaveText("You're on the list");
  await expect(page.locator(".panel .lead")).toHaveText(
    "We'll email ada@acme.com when you're in. Nothing else to do for now.",
  );
  expect(joined).toEqual([{ note: "Client status pages" }]);
  expect(await page.locator("[style]").count()).toBe(0);
  expect(v).toEqual([]);
});

test("beta: joining with no note sends none", async ({ page }) => {
  const joined: unknown[] = [];
  await mount(page, { me: true, gate: "waitlist", joined });
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(page.locator("h1")).toHaveText("You're on the list");
  expect(joined).toEqual([{}]);
});

test("beta: sending state disables the field and button", async ({ page }) => {
  await mount(page, { me: true, gate: "waitlist", joinDelay: 1500 });
  await page.locator("#use").fill("x");
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  const btn = page.locator(".btn.cta");
  await expect(btn).toHaveText("Joining\u2026");
  await expect(btn).toBeDisabled();
  await expect(page.locator("#use")).toBeDisabled();
  await expect(page.locator("#use")).toHaveValue("x");
  await expect(page.locator("h1")).toHaveText("You're on the list");
});

test("beta: a failed join shows the error and keeps the note", async ({
  page,
}) => {
  await mount(page, { me: true, gate: "waitlist", joinStatus: 500 });
  await page.locator("#use").fill("keep me");
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "That didn't save. Try again.",
  );
  await expect(page.locator("#use")).toHaveValue("keep me");
  await expect(
    page.getByRole("button", { name: "Join the waitlist" }),
  ).toBeEnabled();
});

test("beta: the counter shows 40 left, warns at 0, and typing stops at 280", async ({
  page,
}) => {
  await mount(page, { me: true, gate: "waitlist" });
  const cnt = page.locator("#use-count");
  await page.locator("#use").fill("a".repeat(239));
  await expect(cnt).toHaveText("");
  await page.locator("#use").fill("a".repeat(240));
  await expect(cnt).toHaveText("40 left");
  await page.locator("#use").fill("a".repeat(280));
  await expect(cnt).toHaveText("0 left");
  await expect(cnt).toHaveClass(/near/);
  await page.locator("#use").pressSequentially("b");
  await expect(page.locator("#use")).toHaveValue("a".repeat(280));
});

test("beta: waitlisted goes straight to on the list", async ({ page }) => {
  await mount(page, { me: true, gate: "waitlisted" });
  await expect(page.locator("h1")).toHaveText("You're on the list");
  await expect(page.locator("textarea")).toHaveCount(0);
});

test("beta: allowed goes to the address step as today", async ({ page }) => {
  await mount(page, { me: true, gate: "allowed", free: ["acme"] });
  await expect(page.locator("h1")).toHaveText("Choose your address");
});

test("beta: create answering 403 not_invited (a race) shows the join screen", async ({
  page,
}) => {
  await mount(page, {
    me: true,
    gate: "allowed",
    free: ["acme"],
    createReason: "not_invited",
  });
  await page.getByRole("button", { name: "Create my instance" }).click();
  await expect(page.locator("h1")).toHaveText(
    "Open Artifacts is in private beta",
  );
});

test("closed view: field and Go to it read as one group (10px)", async ({
  page,
}) => {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await mount(page, { open: false });
    const f = await page.locator(".field .inp").boundingBox();
    const b = await page
      .getByRole("button", { name: "Go to it" })
      .boundingBox();
    if (!f || !b) throw new Error("no boxes");
    expect(Math.round(b.y - (f.y + f.height))).toBe(10);
  }
});

test("form price line reads exactly", async ({ page }) => {
  await mount(page, { me: false });
  await expect(page.locator(".panel .muted.small")).toHaveText(
    "Solo: free for your first month, then $1/month or $10/year. No card needed.",
  );
});

test("first screen: only Google, no address field", async ({ page }) => {
  await mount(page, { me: false });
  await expect(page.locator("h1")).toHaveText("Create your Open Artifacts");
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toBeVisible();
  await expect(page.locator("input")).toHaveCount(0);
});

test("address step: only free suggestions show, the first is prefilled", async ({
  page,
}) => {
  await mount(page, { me: true, free: ["ada", "acme-team"] });
  await expect(page.locator("h1")).toHaveText("Choose your address");
  await expect(page.locator(".chips .chip")).toHaveText(["ada", "acme-team"]);
  await expect(page.locator("#slug")).toHaveValue("ada");
  await expect(page.locator(".help")).toHaveText(
    "ada.open-artifacts.app is available",
  );
  await expect(page.locator(".chip.sel")).toHaveText("ada");
  await page.getByRole("button", { name: "acme-team" }).click();
  await expect(page.locator("#slug")).toHaveValue("acme-team");
});

test("address step: late suggestions never overwrite what you typed or cleared", async ({
  page,
}) => {
  await mount(page, { me: true, free: ["acme", "ada"], slugDelay: 700 });
  await page.locator("#slug").fill("mine");
  await page.locator("#slug").fill("");
  await expect(page.locator(".chips .chip")).toHaveCount(2);
  await expect(page.locator("#slug")).toHaveValue("");
});

test("address step: back keeps you signed in", async ({ page }) => {
  await mount(page, { me: true, free: ["acme"] });
  await expect(page.locator("#slug")).toHaveValue("acme");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("h1")).toHaveText("Create your Open Artifacts");
  await expect(page.locator(".who")).toContainText("ada@acme.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("h1")).toHaveText("Choose your address");
});

test("address step: create starts from here", async ({ page }) => {
  await mount(page, { me: true, free: ["acme"] });
  let posted: unknown = null;
  await page.route(`${ORIGIN}/api/v1/installs`, (r) => {
    posted = r.request().postDataJSON();
    return r.fulfill({
      status: 202,
      contentType: "application/json",
      body: "{}",
    });
  });
  const btn = page.getByRole("button", { name: "Create my instance" });
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(page.locator("h1")).toHaveText(
    /^Setting up acme\.open-artifacts\.app$/,
  );
  expect(posted).toMatchObject({ slug: "acme", turnstile: "tok" });
});

test("loading: status line follows the stage, no step list", async ({
  page,
}) => {
  await page.clock.install();
  let stage = "queued";
  await mount(page, {
    me: true,
    stage: "queued",
    signup: () => creating(stage),
  });
  await expect(page.locator(".panel .addr")).toHaveText(
    "Creating acme.open-artifacts.app\u2026",
  );
  await expect(page.locator(".panel .hint")).toHaveText(
    "This usually takes a minute or two. Keep this tab open, and it tells you when it's ready.",
  );
  await expect(page.locator(".steps")).toHaveCount(0);
  await expect(page.locator(".anim")).toHaveCount(1);
  stage = "waiting_cap";
  await tick(page);
  await expect(page.locator(".panel .addr")).toHaveText(
    "Lots of people are signing up right now. You're in line, and it starts on its own.",
  );
  await expect(page.locator(".panel .hint")).toHaveCount(0);
  // the animation survives a status update (not rebuilt)
  await expect(page.locator(".anim")).toHaveCount(1);
  await expect(page.locator(".verb")).toContainText("Margin-noting");
  await page.clock.runFor(2300);
  await expect(page.locator(".verb")).toContainText("Inking");
  // the wait-time line returns once the signup leaves the line
  stage = "queued";
  await tick(page);
  await expect(page.locator(".panel .hint")).toHaveCount(1);
});

test("loading: reduced motion shows the static mark, no rotation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await mount(page, { me: true, stage: "creating" });
  await expect(page.locator(".slot .a1")).toHaveCount(1);
  await expect(page.locator(".slot")).toHaveClass(/\bin\b/);
  await page.clock.runFor(10000);
  await expect(page.locator(".slot .a1")).toHaveCount(1);
  await expect(page.locator(".verb")).toContainText("Bookbinding");
  const anim = await page
    .locator(".a1 .fr, .a1 .sq, .a1 .cn, .verb .w")
    .evaluateAll((els) => els.map((e) => getComputedStyle(e).animationName));
  expect(anim.every((a) => a === "none")).toBe(true);
});

const SHOTS = process.env.SHOTS_DIR;
const STATES: Record<string, Sc & { act?: (p: Page) => Promise<void> }> = {
  closed: { open: false },
  "form-signed-out": { me: false },
  "form-notice-expired": { me: false, path: "/?error=expired" },
  "form-signed-in-empty": { me: true, free: [] },
  "address-suggestions": { me: true, free: ["acme", "ada", "acme-team"] },
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
  "beta-join": { me: true, gate: "waitlist" },
  "beta-join-near": {
    me: true,
    gate: "waitlist",
    act: (p) => p.locator("#use").fill("a".repeat(262)),
  },
  "beta-listed": { me: true, gate: "waitlisted" },
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
