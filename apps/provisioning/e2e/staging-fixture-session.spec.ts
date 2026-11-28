import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import {
  approveFixtureBusInBrowser,
  FIXTURE_OWNER_EMAIL,
  fixtureHost,
  fixtureMemberState,
} from "../../../scripts/ops/staging-fixture-session.ts";
import { COOKIE, EMAIL } from "../../../scripts/ops/staging-test-member.ts";

test("writes the verified email-code cookie for only the requested fixture (trial Email me a code UI)", async ({
  browser,
}) => {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const host = fixtureHost("t-new");
  const calls: string[] = [];
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    expect(u.host).toBe(host);
    expect(init?.redirect).toBe("error");
    calls.push(u.pathname);
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(
      u.pathname.startsWith("/__test/"),
    );
    switch (u.pathname) {
      case "/healthz":
        return Response.json({
          ok: true,
          testHooks: true,
          installId: "fixture-id",
        });
      case "/__test/session":
        return Response.json({ cookie: "discard" });
      case "/__test/otp/latest":
        return Response.json({ code: "12345678" });
      case "/api/v1/me":
        expect(headers.get("cookie")).toBe(`${COOKIE}=verified`);
        return Response.json({
          user: { email: EMAIL, role: "member" },
          auth: { expiresAt },
        });
      default:
        throw new Error(u.pathname);
    }
  };
  const launch = async () => ({
    close: async () => {},
    newContext: async (options: Parameters<typeof browser.newContext>[0]) => {
      const ctx = await browser.newContext(options);
      await ctx.route("**/*", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        expect(url.host).toBe(host);
        if (url.pathname === "/sign-in") {
          return route.fulfill({
            contentType: "text/html",
            body: `
            <form><input autocomplete="email"><button>Email me a code</button></form>
            <form hidden><input autocomplete="one-time-code"><button>Verify</button></form>
            <script>
            document.forms[0].onsubmit=async e=>{
              e.preventDefault();
              await fetch('/auth/code/request',{method:'POST',body:document.forms[0].elements[0].value});
              document.forms[1].hidden=false;
            };
            document.forms[1].onsubmit=async e=>{
              e.preventDefault();
              await fetch('/auth/code/verify',{method:'POST',body:document.forms[1].elements[0].value});
            };
            </script>`,
          });
        }
        if (url.pathname === "/auth/code/request") {
          expect(req.postData()).toBe(EMAIL);
          return route.fulfill({ status: 202, body: "" });
        }
        if (url.pathname === "/auth/code/verify") {
          expect(req.postData()).toBe("12345678");
          return route.fulfill({
            status: 200,
            headers: {
              "set-cookie": `${COOKIE}=verified; Secure; HttpOnly; Path=/`,
            },
            body: "",
          });
        }
        return route.abort();
      });
      return ctx;
    },
  });
  const file = await fixtureMemberState(
    "t-new",
    "fixture-id",
    "key",
    mkdtempSync(join(tmpdir(), "fixture-test-")),
    fetcher,
    launch,
  );
  expect(calls).toEqual([
    "/healthz",
    "/__test/session",
    "/__test/otp/latest",
    "/api/v1/me",
  ]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, "utf8")).cookies).toEqual([
    expect.objectContaining({
      name: COOKIE,
      value: "verified",
      domain: host,
      httpOnly: true,
      secure: true,
    }),
  ]);
});

test("approves a bus device code in the browser as the fixture owner via real email-code sign-in", async ({
  browser,
}) => {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const host = fixtureHost("t-bus");
  const calls: string[] = [];
  const submitted: string[] = [];
  const fetcher = async (url: RequestInfo | URL, _init?: RequestInit) => {
    const u = new URL(String(url));
    expect(u.host).toBe(host);
    calls.push(u.pathname);
    switch (u.pathname) {
      case "/healthz":
        return Response.json({
          ok: true,
          testHooks: true,
          installId: "fixture-bus",
        });
      case "/__test/otp/latest":
        return Response.json({ code: "87654321" });
      case "/api/v1/me":
        return Response.json({
          user: { email: FIXTURE_OWNER_EMAIL, role: "owner" },
          auth: { expiresAt },
        });
      default:
        throw new Error(u.pathname);
    }
  };
  const launch = async () => ({
    close: async () => {},
    newContext: async (options: Parameters<typeof browser.newContext>[0]) => {
      const ctx = await browser.newContext(options);
      await ctx.route("**/*", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        expect(url.host).toBe(host);
        if (url.pathname === "/sign-in") {
          return route.fulfill({
            contentType: "text/html",
            body: `
            <form><input autocomplete="email"><button>Send code</button></form>
            <form hidden><input autocomplete="one-time-code"><button>Verify</button></form>
            <script>
            document.forms[0].onsubmit=async e=>{
              e.preventDefault();
              await fetch('/auth/code/request',{method:'POST',body:document.forms[0].elements[0].value});
              document.forms[1].hidden=false;
            };
            document.forms[1].onsubmit=async e=>{
              e.preventDefault();
              await fetch('/auth/code/verify',{method:'POST',body:document.forms[1].elements[0].value});
            };
            </script>`,
          });
        }
        if (url.pathname === "/auth/code/request") {
          expect(req.postData()).toBe(FIXTURE_OWNER_EMAIL);
          return route.fulfill({ status: 202, body: "" });
        }
        if (url.pathname === "/auth/code/verify") {
          expect(req.postData()).toBe("87654321");
          return route.fulfill({
            status: 200,
            headers: {
              "set-cookie": `${COOKIE}=owner-sess; Secure; HttpOnly; Path=/`,
            },
            body: "",
          });
        }
        if (url.pathname === "/bus/approve" && req.method() === "GET") {
          return route.fulfill({
            contentType: "text/html",
            body: `<form method="post" action="/bus/approve">
              <input type="hidden" name="step" value="code">
              <input id="code" name="code" type="text">
              <button type="submit">Continue</button>
            </form>`,
          });
        }
        if (url.pathname === "/bus/approve" && req.method() === "POST") {
          const body = req.postData() ?? "";
          submitted.push(body);
          if (body.includes("step=code")) {
            expect(body).toContain("code=AB12-CD34");
            return route.fulfill({
              contentType: "text/html",
              body: `<form method="post" action="/bus/approve">
                <input type="hidden" name="step" value="decide">
                <button type="submit" name="decision" value="deny">Deny</button>
                <button type="submit" name="decision" value="approve">Approve</button>
              </form>`,
            });
          }
          expect(body).toContain("decision=approve");
          return route.fulfill({
            contentType: "text/html",
            body: "<h1>Machine connected</h1>",
          });
        }
        return route.abort();
      });
      return ctx;
    },
  });
  await approveFixtureBusInBrowser(
    "t-bus",
    "fixture-bus",
    "key",
    "AB12-CD34",
    fetcher,
    launch,
  );
  // Owner signs in directly without calling /__test/session.
  expect(calls).toEqual(["/healthz", "/__test/otp/latest", "/api/v1/me"]);
  expect(submitted).toHaveLength(2);
});
