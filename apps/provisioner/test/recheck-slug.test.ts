import { describe, expect, it } from "vitest";
import { StepRefusal } from "../src/errors.js";
import { checkSlug } from "../src/recheck.js";

// Issue #1011: the provisioner recheck refuses a stored slug that is now
// reserved. Needs a public release carrying the names (PUBLIC_PIN bump).
describe("checkSlug reserved names", () => {
  it.each([
    "admins",
    "administrator",
    "root",
    "superuser",
    "sysadmin",
    "owner",
    "team",
    "staff",
    "official",
    "support",
    "help",
    "helpdesk",
    "contact",
    "security",
    "abuse",
    "trust",
    "safety",
    "legal",
    "privacy",
    "compliance",
    "postmaster",
    "hostmaster",
    "webmaster",
    "noreply",
    "no-reply",
    "info",
    "smtp",
    "imap",
    "pop",
    "mx",
    "account",
    "accounts",
    "signin",
    "sign-in",
    "register",
    "password",
    "verify",
    "oauth",
    "id",
    "identity",
    "open-artifacts",
    "openartifacts",
    "artifacts",
    "dashboard",
    "console",
    "cdn",
    "assets",
    "static",
    "files",
    "health",
    "test",
    "dev",
    "demo",
    "internal",
    "ns1",
    "ns2",
    "signup",
    "status",
    "admin",
  ])("%s is refused", (slug) => {
    expect(() => checkSlug(slug)).toThrow(StepRefusal);
  });

  it.each(["leo", "rl-a", "rl-b"])("%s stays valid", (slug) => {
    expect(checkSlug(slug)).toBe(slug);
  });
});
