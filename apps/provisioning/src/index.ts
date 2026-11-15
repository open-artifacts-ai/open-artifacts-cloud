// Provisioning API and admin panel (design v7 2.1): admin.<app> (session
// cookie, SPA, sign-in, MCP consent) and api.<app> (bearer: /v1, /mcp,
// OAuth). It holds no Cloudflare token; the provisioner does (2.5).
import { WorkerEntrypoint } from "cloudflare:workers";
import { handle } from "./app.js";
import { sweepOAuthClientsAll } from "./auth/oauth/endpoints.js";
import type { Env } from "./env.js";
import { loginChange } from "./routes/login-change.js";

export type { Env } from "./env.js";

/**
 * An instance's only way to change its own login domains (#2520): dispatch's
 * LoginGate holds a service binding to this entrypoint, never to the default
 * fetch, so no internet request can reach it. See routes/login-change.ts.
 */
export class LoginChangeGate extends WorkerEntrypoint<Env> {
  override fetch(req: Request): Promise<Response> {
    return loginChange(req, this.env);
  }
}

export default {
  fetch: (req, env, ctx) => handle(req, env, ctx),
  // Hourly (wrangler.jsonc triggers): the MCP client sweep (8.3, 9A.7).
  scheduled: (ctl, env, ctx) => {
    ctx.waitUntil(sweepOAuthClientsAll(env, ctl.scheduledTime).then(() => {}));
  },
} satisfies ExportedHandler<Env>;
