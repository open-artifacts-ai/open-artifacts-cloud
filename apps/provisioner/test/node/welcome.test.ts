import { describe, expect, it } from "vitest";
import { welcomeEmail } from "../../src/welcome.js";

const base = {
  from: "welcome@x.test",
  to: "ana@example.com",
  appHost: "acme.open-artifacts.app",
  selfServe: true,
  billing: true,
};

describe("welcomeEmail", () => {
  it("subject names the address", () => {
    expect(welcomeEmail(base).subject).toBe("acme.open-artifacts.app is ready");
  });

  it("names the trial end date when given", () => {
    const m = welcomeEmail({ ...base, trialEndsAt: Date.UTC(2026, 11, 9, 23) });
    for (const part of [m.text, m.html.replace(/&#39;/g, "'")])
      expect(part).toContain(
        "You're on Solo: free until Dec 9, then $10 a year or $1 a month.",
      );
  });

  it("says 'free for 30 days', no date, when absent or invalid", () => {
    for (const trialEndsAt of [undefined, new Date("nope")]) {
      const m = welcomeEmail({ ...base, trialEndsAt });
      for (const part of [m.text, m.html]) {
        expect(part).toContain("free for 30 days");
        expect(part).not.toMatch(/free until/);
      }
    }
  });

  it("billing unbound: beta copy, no trial or price, in text and html", () => {
    for (const trialEndsAt of [undefined, Date.UTC(2026, 11, 9, 23)]) {
      const m = welcomeEmail({ ...base, billing: false, trialEndsAt });
      for (const part of [m.text, m.html.replace(/&#39;/g, "'")]) {
        expect(part).toContain(
          "You're in the private beta: free, no card needed. We'll email you before paid plans start.",
        );
        expect(part).not.toMatch(/Solo|30 days|\$10|free until/);
      }
    }
  });

  it("text and html carry the same words", () => {
    const m = welcomeEmail(base);
    const flat = (s: string) =>
      s
        .replace(/<style[\s\S]*?<\/style>/g, "")
        .replace(/<title>[\s\S]*?<\/title>/g, "")
        .replace(/<\/?(?:span|wbr)\b[^>]*>/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#39;/g, "'")
        .replace(/\u2011/g, "-")
        .replace(/\s+/g, " ")
        .trim();
    const html = flat(m.html);
    for (const s of [
      "Your Open Artifacts is ready",
      "acme.open-artifacts.app is set up and you're its owner. Sign in with the Google account you used to create it, ana@example.com.",
      "Open acme.open-artifacts.app",
      "Then connect your agent. Paste this into Claude Code, Cursor or any AI agent:",
      "Set up Open Artifacts for me: follow https://acme.open-artifacts.app/llms.txt",
      "You got this because you signed up and created acme.open-artifacts.app.",
    ]) {
      expect(m.text).toContain(s);
      expect(html).toContain(s);
    }
  });

  it("the setup prompt is one line", () => {
    const m = welcomeEmail(base);
    expect(m.text).not.toContain("paste a token");
    expect(m.html).not.toContain("paste a token");
    expect(m.text).toContain(
      "\n  Set up Open Artifacts for me: follow https://acme.open-artifacts.app/llms.txt\n\n",
    );
    expect(m.html).not.toMatch(/llms\.txt<\/td>.*<br>/);
  });

  it("button label never breaks the host at a hyphen", () => {
    const m = welcomeEmail({
      ...base,
      appHost: "acme-design-studio.open-artifacts.app",
    });
    expect(m.html).toContain(
      "Open acme\u2011design\u2011studio.<wbr>open\u2011artifacts.<wbr>app</a>",
    );
    expect(m.html).toContain(
      "Open acme\u2011design\u2011studio.open\u2011artifacts.app</center>",
    );
    expect(m.text).toContain("Open acme-design-studio.open-artifacts.app");
  });

  it("links only to the instance's own host", () => {
    const m = welcomeEmail(base);
    // xmlns attributes are namespace names, not links.
    const html = m.html.replace(/\sxmlns(:\w+)?="[^"]*"/g, "");
    const urls = [...`${m.text}\n${html}`.matchAll(/https?:\/\/[^\s"'<>]+/g)];
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

  it("logo is the 156x44 wordmark with no duplicate text label", () => {
    const m = welcomeEmail(base);
    expect(m.html).toContain(
      'src="https://acme.open-artifacts.app/email/logo@2x.png" width="156" height="44" alt="Open Artifacts"',
    );
    expect(m.html).not.toMatch(/width="18"/);
    expect(m.html).not.toMatch(/<\/img>|>\s*Open Artifacts\s*<\/p>/);
  });

  it("self-serve html is the Outlook-safe table template, with the trial reminder promise", () => {
    const m = welcomeEmail(base);
    expect(m.html).toContain('<table role="presentation"');
    expect(m.html).toContain("<!--[if mso]>");
    expect(m.html).toContain("<v:roundrect");
    expect(m.html).toContain("[data-ogsc]");
    expect(m.html).toContain("max-width:560px");
    expect(m.html).not.toMatch(
      /<div class="card"|<pre|<h1 style="font-size:19px/,
    );
    expect(m.html).toContain(
      'href="https://acme.open-artifacts.app/" target="_blank"',
    );
    for (const part of [m.text, m.html]) {
      expect(part).toContain(
        "No card on file; we&#39;ll remind you a week before.".replace(
          "&#39;",
          part === m.html ? "&#39;" : "'",
        ),
      );
      expect(part).not.toMatch(/invited|added you/i);
    }
    expect(m.text).toContain(
      "No card on file; we'll remind you a week before.",
    );
  });

  it("keeps the hostname in the setup prompt unbreakable", () => {
    const m = welcomeEmail(base);
    expect(m.html).toContain(
      'https://<wbr><span style="white-space:nowrap;">acme.open-artifacts.app</span><wbr>/llms.txt',
    );
  });

  it("neutral copy unless self-serve: no Google, Solo, price or 'you created'", () => {
    const m = welcomeEmail({
      ...base,
      selfServe: undefined,
      trialEndsAt: Date.UTC(2026, 11, 9),
    });
    for (const part of [m.text, m.html])
      expect(part).not.toMatch(/Google|Solo|\$1|\$12|free|trial|you created/i);
    expect(m.text).toContain("Sign in with the account you signed up with");
    expect(m.text).toContain("Open acme.open-artifacts.app");
    expect(m.text).toContain("/llms.txt");
  });
});
