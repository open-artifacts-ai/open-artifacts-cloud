import type { z } from "zod";
import type { Env } from "./env.js";
import { ApiError } from "./errors.js";
import { limit } from "./limits.js";
import type { Principal } from "./principal.js";
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

export const HOSTED_TOOLS: readonly HostedTool[] = [
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
