import { describe, expect, it } from "vitest";
import { welcomeEmail } from "../../src/welcome.js";

const base = {
  from: "welcome@x.test",
  to: "ana@example.com",
  appHost: "acme.open-artifacts.app",
};

describe("welcomeEmail", () => {
  it("subject names the address", () => {
    expect(welcomeEmail(base).subject).toBe("acme.open-artifacts.app is ready");
  });

  it("names the trial end date when given", () => {
    const m = welcomeEmail({ ...base, trialEndsAt: Date.UTC(2026, 11, 9, 23) });
    for (const part of [m.text, m.html.replace(/&#39;/g, "'")])
      expect(part).toContain(
        "You're on Solo: free until Dec 9, then $1/month or $12/year.",
      );
  });

  it("says 'free for your first month', no date, when absent or invalid", () => {
    for (const trialEndsAt of [undefined, new Date("nope")]) {
      const m = welcomeEmail({ ...base, trialEndsAt });
      for (const part of [m.text, m.html]) {
        expect(part).toContain("free for your first month");
        expect(part).not.toMatch(/free until/);
      }
    }
  });

  it("text and html carry the same words", () => {
    const m = welcomeEmail(base);
    const flat = (s: string) =>
      s
        .replace(/<style[\s\S]*?<\/style>/g, "")
        .replace(/<title>[\s\S]*?<\/title>/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
    const html = flat(m.html);
    for (const s of [
      "Your Open Artifacts is ready",
      "acme.open-artifacts.app is set up and you're its owner. Sign in with the Google account you used to create it, ana@example.com.",
      "Open acme.open-artifacts.app",
      "Then connect your agent. Paste this into Claude Code, Cursor or any AI agent:",
      "Set up Open Artifacts for me: follow https://acme.open-artifacts.app/llms.txt",
      "Sign in through the browser. Never ask me to paste a token into this chat.",
      "You got this because you created acme.open-artifacts.app.",
    ]) {
      expect(m.text).toContain(s);
      expect(html).toContain(s);
    }
  });

  it("links only to the instance's own host", () => {
    const m = welcomeEmail(base);
    const urls = [...`${m.text}\n${m.html}`.matchAll(/https?:\/\/[^\s"'<>]+/g)];
    expect(urls.length).toBeGreaterThan(0);
    for (const [u] of urls)
      expect(new URL(u).host, u).toBe("acme.open-artifacts.app");
    expect(m.html).toMatch(/prefers-color-scheme: dark/);
  });

  it("escapes the recipient and rejects a bad host", () => {
    const m = welcomeEmail({ ...base, to: "<b>x</b>@e.com\r\nBcc: a@b.c" });
    expect(m.html).not.toContain("<b>x</b>");
    expect(m.text).not.toMatch(/\r|Bcc: a@b\.c\n/);
    expect(() => welcomeEmail({ ...base, appHost: "evil.com/x@y" })).toThrow();
  });
});
