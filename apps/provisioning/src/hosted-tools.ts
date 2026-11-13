import type { z } from "zod";
import type { Env } from "./env.js";
import { ApiError } from "./errors.js";
import { limit } from "./limits.js";
import type { Principal } from "./principal.js";
import {
  AllowInput,
  ApproveInput,
  add,
  approve,
  BETA_TOOLS,
  betaMcp,
  ListWaitlistInput,
  listWaitlist,
  RemoveInput,
  remove,
  StatsInput,
  stats,
} from "./routes/beta.js";
import {
  BUSINESS_TOOL,
  ListBusinessInput,
  listBusinessRequests,
} from "./routes/business.js";
import {
  SET_TIER_TOOL,
  SetTierInputSchema,
  setTier,
} from "./routes/set-tier.js";

// Admin MCP tools of the hosted service that are not contract routes (the
// route, authz and tool tables are public, @oa/provisioning-contract). The
// MCP adapter registers each entry and holds none of its logic; the entry
// charges the write limit itself, as invokeRoute does for the contract tools,
// and authorizes and audits in its own handler.

export type HostedTool = {
  name: string;
  description: string;
  input: z.ZodObject;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  run(
    env: Env,
    principal: Principal,
    args: Record<string, unknown>,
    client: { version: string | null },
  ): Promise<{ body: Record<string, unknown>; text: string }>;
};

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/** A beta tool: the write limit (or read), authz, then the shared function. */
function betaTool(
  name: string,
  description: string,
  input: z.ZodObject,
  write: boolean,
  call: (
    env: Env,
    p: Principal,
    a: Record<string, unknown>,
    via: Record<string, unknown>,
  ) => Promise<{ body: unknown }>,
  text: (b: Record<string, unknown>) => string,
): HostedTool {
  return {
    name,
    description,
    input,
    annotations: write ? WRITE : READ,
    async run(env, principal, args, client) {
      const r = await betaMcp(
        env,
        principal,
        name,
        write,
        client.version,
        async (via) => {
          const rl = await limit(
            env,
            write ? "write" : "read",
            principal.rateKey,
          );
          if (rl) throw new ApiError(rl.code);
          const out = await call(env, principal, args, via);
          return { status: 200, body: out.body };
        },
      );
      const body = r.body as Record<string, unknown>;
      return { body, text: text(body) };
    },
  };
}

const json = (b: Record<string, unknown>) => JSON.stringify(b);

export const HOSTED_TOOLS: readonly HostedTool[] = [
  betaTool(
    BETA_TOOLS.list,
    "List the private beta waitlist, oldest first (status waiting by default; q matches email or note). Read-only.",
    ListWaitlistInput,
    false,
    (env, _p, a) => {
      const u = new URL("https://beta.invalid/");
      if (typeof a.status === "string") u.searchParams.set("status", a.status);
      if (typeof a.q === "string") u.searchParams.set("q", a.q);
      return listWaitlist(env, u);
    },
    json,
  ),
  betaTool(
    BUSINESS_TOOL,
    "List the Business contact requests, newest first (status new, contacted, closed or all; all by default). Read-only.",
    ListBusinessInput,
    false,
    (env, _p, a) => {
      const u = new URL("https://business.invalid/");
      if (typeof a.status === "string") u.searchParams.set("status", a.status);
      return listBusinessRequests(env, u);
    },
    json,
  ),
  betaTool(
    BETA_TOOLS.stats,
    "The private beta's numbers: waiting, declined, allowed emails and domains, signups today, the daily cap and the signup mode. Read-only.",
    StatsInput,
    false,
    (env) => stats(env),
    json,
  ),
  betaTool(
    BETA_TOOLS.approve,
    "Approve waitlist people by sub: adds them to the allow-list and emails them. Returns per person result, emailSent and emailError. Audited.",
    ApproveInput,
    true,
    (env, p, a, via) => approve(env, p, a, undefined, via),
    (b) =>
      `approved ${String(b.approved)}, ${String(b.emailFailed)} email(s) failed\n${json(b)}`,
  ),
  betaTool(
    BETA_TOOLS.allow,
    "Allow people to sign up: emails or @domains (not public mail domains). Same rules as the Beta tab. Audited.",
    AllowInput,
    true,
    (env, p, a, via) => add(env, p, a, undefined, via),
    json,
  ),
  betaTool(
    BETA_TOOLS.remove,
    "Remove one email or @domain from the allow-list. Audited.",
    RemoveInput,
    true,
    (env, p, a, via) =>
      remove(env, p, encodeURIComponent(String(a.entry)), undefined, via),
    (b) => `removed ${String(b.removed)}`,
  ),
  {
    name: SET_TIER_TOOL,
    description:
      "Set an install's billing tier (team or business) as an operator comp, through billing. Refused while the install has a live Stripe subscription. Needs a reason; audited.",
    input: SetTierInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async run(env, principal, { id, ...rest }, client) {
      const rl = await limit(env, "write", principal.rateKey);
      if (rl) throw new ApiError(rl.code);
      const r = await setTier(env, principal, id, rest, {
        kind: "mcp",
        clientVersion: client.version,
      });
      const b = r.body as { tier: string; version: number };
      return {
        body: r.body as Record<string, unknown>,
        text: `${String(id)} is now on ${b.tier} (billing version ${b.version})`,
      };
    },
  },
];
