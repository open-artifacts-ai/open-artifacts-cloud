// The owner-intent vars of an install, under one strict schema: signups.vars
// at a create (the provisioner's 2.5 item 3 recheck) and the vars a login
// change would leave (open-artifacts#2520, the provisioning Worker's route and
// the provisioner's recheck). Pure: callers map OwnerVarsRefusal to their own
// error type.

import { TierSchema } from "@oa/provisioning-contract";
import { STAGING_TEST_DOMAIN } from "@oa/provisioning-contract/constants";
import type { Env as DeployEnv } from "./names.js";

/** A refusal: `code` is a job error code, `why` is for redacted logs only. */
export class OwnerVarsRefusal extends Error {
  constructor(
    readonly code: "invalid_state" | "domain_codes_refused",
    readonly why: string,
  ) {
    super(why);
  }
}
const refused = (why: string) => new OwnerVarsRefusal("invalid_state", why);

const PROVIDERS = new Set(["google", "email"]);
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
/** The join rules the instance's server knows (AUTH_DOMAIN_JOIN). */
export const DOMAIN_JOIN_VALUES = ["invite", "member"] as const;
/** The platform-only marker: `member` counts only when the owner's change wrote it. */
export const DOMAIN_JOIN_SOURCE_VAR = "AUTH_DOMAIN_JOIN_SOURCE";

export type OwnerVarsOptions = {
  source: "admin" | "self-serve";
  selfServeTier: string;
  testHooks: boolean;
  env: DeployEnv;
  /**
   * A login change: AUTH_DOMAIN_JOIN (invite or member) and its marker are
   * allowed, `member` needs the marker `owner` and exactly one domain, and
   * the result carries both. A create never allows them.
   */
  login?: boolean;
};

/**
 * The vars under the strict schema (2.5 item 3): exactly AUTH_PROVIDERS,
 * AUTH_DOMAINS, TIER, TEST_DOMAIN (equal to STAGING_TEST_DOMAIN) only on a
 * staging test-hook row, and EMAIL_CODE_DOMAIN=on only on an admin create with
 * email, no google and a domain (#1088). Self-serve also needs TIER = SELF_SERVE_TIER,
 * providers exactly google, or google and email (guest codes), and at most one domain (with google, at most
 * one: a personal Google account has none). Google with no domain is fine for
 * either source (#2520): owner and invites only. Returns the vars create
 * renders: AUTH_DOMAIN_JOIN=invite forced (a login change: its own value and
 * marker), an empty AUTH_DOMAINS dropped.
 */
export function ownerVars(
  raw: string,
  o: OwnerVarsOptions,
): Record<string, string> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw refused("vars are not JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw refused("vars are not an object");
  const vars = v as Record<string, unknown>;
  const allowed = ["AUTH_PROVIDERS", "AUTH_DOMAINS", "TIER"];
  if (o.testHooks) allowed.push("TEST_DOMAIN");
  const optional = ["EMAIL_CODE_DOMAIN"];
  if (o.login) optional.push("AUTH_DOMAIN_JOIN", DOMAIN_JOIN_SOURCE_VAR);
  for (const k of Object.keys(vars))
    if (!allowed.includes(k) && !optional.includes(k))
      throw refused(`var ${k.slice(0, 40)} is not allowed`);
  for (const k of allowed)
    if (typeof vars[k] !== "string") throw refused(`var ${k} is missing`);
  const providers = (vars.AUTH_PROVIDERS as string).split(",");
  if (
    providers.length === 0 ||
    providers.length > 2 ||
    new Set(providers).size !== providers.length ||
    !providers.every((p) => PROVIDERS.has(p))
  )
    throw refused("AUTH_PROVIDERS is not a provider list");
  const domains =
    vars.AUTH_DOMAINS === "" ? [] : (vars.AUTH_DOMAINS as string).split(",");
  if (domains.length > 50 || !domains.every((d) => DOMAIN.test(d)))
    throw refused("AUTH_DOMAINS is not a domain list");
  const codes = vars.EMAIL_CODE_DOMAIN;
  if (codes !== undefined && (codes !== "on" || o.source !== "admin"))
    throw refused("EMAIL_CODE_DOMAIN is not allowed here");
  if (
    codes !== undefined &&
    (!providers.includes("email") ||
      providers.includes("google") ||
      domains.length === 0)
  )
    throw new OwnerVarsRefusal(
      "domain_codes_refused",
      "EMAIL_CODE_DOMAIN=on needs email, no google and a domain",
    );
  const tier = TierSchema.safeParse(vars.TIER);
  if (!tier.success) throw refused("TIER is not a tier");
  if (o.testHooks) {
    if (o.env !== "staging") throw refused("test hooks are staging only");
    if (vars.TEST_DOMAIN !== STAGING_TEST_DOMAIN)
      throw refused("TEST_DOMAIN is not the staging test domain");
  }
  if (o.source === "self-serve") {
    if (tier.data !== o.selfServeTier)
      throw refused("a self-serve TIER must be SELF_SERVE_TIER");
    // google only (rows queued before guest codes) or google and email.
    const set = [...providers].sort().join(",");
    if (set !== "google" && set !== "email,google")
      throw refused("self-serve providers must be google, or google and email");
    if (domains.length > 1) throw refused("self-serve has at most one domain");
  }
  let join = "invite";
  let marker: string | null = null;
  if (o.login) {
    const j = vars.AUTH_DOMAIN_JOIN ?? "invite";
    if (!(DOMAIN_JOIN_VALUES as readonly unknown[]).includes(j))
      throw refused("AUTH_DOMAIN_JOIN is not invite or member");
    join = j as string;
    const m = vars[DOMAIN_JOIN_SOURCE_VAR];
    if (m !== undefined && m !== "owner")
      throw refused(`${DOMAIN_JOIN_SOURCE_VAR} is not owner`);
    // member only with the marker, and the marker only with member: an
    // operator-typed domain never auto-joins.
    if ((join === "member") !== (m === "owner"))
      throw refused("member and its owner marker go together");
    if (join === "member" && domains.length !== 1)
      throw refused("member needs exactly one domain");
    if (join === "member" && !providers.includes("google"))
      throw refused("member needs google");
    marker = m === "owner" ? "owner" : null;
  }
  return {
    AUTH_PROVIDERS: providers.join(","),
    ...(domains.length > 0 ? { AUTH_DOMAINS: domains.join(",") } : {}),
    AUTH_DOMAIN_JOIN: join,
    ...(marker === null ? {} : { [DOMAIN_JOIN_SOURCE_VAR]: marker }),
    TIER: tier.data,
    ...(codes === undefined ? {} : { EMAIL_CODE_DOMAIN: "on" }),
    ...(o.testHooks ? { TEST_DOMAIN: STAGING_TEST_DOMAIN } : {}),
  };
}

/** The owner-intent keys ownerVars reads from an install's stored vars. */
const OWNER_KEYS = [
  "AUTH_PROVIDERS",
  "TIER",
  "EMAIL_CODE_DOMAIN",
  "TEST_DOMAIN",
  "AUTH_DOMAIN_JOIN",
  DOMAIN_JOIN_SOURCE_VAR,
] as const;

/**
 * R29's AUTH_PROVIDERS (open-artifacts-cloud#435): email codes on or off for
 * an install that signs in with Google. `value` is "google" or
 * "google,email" (the contract's AUTH_PROVIDERS_VALUES). Only email is added
 * or removed: the stored list must already hold google and the new one keeps
 * it, so Google never toggles and no broker key changes hands. Never with
 * EMAIL_CODE_DOMAIN (domain codes need Google off). Returns the stored vars
 * with AUTH_PROVIDERS replaced, after the owner part passes ownerVars as a
 * login change would leave it; every other var stays as stored.
 */
export function withAuthProviders(
  stored: Record<string, string>,
  value: string,
  o: Omit<OwnerVarsOptions, "login">,
): Record<string, string> {
  if (value !== "google" && value !== "google,email")
    throw refused("AUTH_PROVIDERS must be google, or google,email");
  if (!(stored.AUTH_PROVIDERS ?? "").split(",").includes("google"))
    throw refused("AUTH_PROVIDERS changes only on a Google install");
  if (stored.EMAIL_CODE_DOMAIN !== undefined)
    throw refused("AUTH_PROVIDERS can't change with EMAIL_CODE_DOMAIN set");
  const after: Record<string, string> = { ...stored, AUTH_PROVIDERS: value };
  const owner: Record<string, string> = {};
  for (const k of OWNER_KEYS)
    if (after[k] !== undefined) owner[k] = after[k] as string;
  owner.AUTH_DOMAINS = after.AUTH_DOMAINS ?? "";
  ownerVars(JSON.stringify(owner), { ...o, login: true });
  return after;
}
