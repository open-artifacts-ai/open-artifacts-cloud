// Provisioning API and admin panel (design v7 2.1): admin.<app> (session
// cookie, SPA, sign-in, MCP consent) and api.<app> (bearer: /v1, /mcp,
// OAuth). It holds no Cloudflare token; the provisioner does (2.5).
import { WorkerEntrypoint } from "cloudflare:workers";
import { handle } from "./app.js";
import { sweepOAuthClientsAll } from "./auth/oauth/endpoints.js";
import type { Env } from "./env.js";
import {
  ACK_PATH,
  consumeEmailEvents,
  emailEventsGate,
  PULL_PATH,
  pruneEmailEvents,
} from "./routes/email-events.js";
import { loginChange } from "./routes/login-change.js";

export type { Env } from "./env.js";

/**
 * An instance's only way to change its own login domains (#2520) and to pull
 * its bounce and complaint events (#2650): dispatch's LoginGate holds a
 * service binding to this entrypoint, never to the default fetch, so no
 * internet request can reach it. See routes/login-change.ts and
 * routes/email-events.ts.
 */
export class LoginChangeGate extends WorkerEntrypoint<Env> {
  override fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === PULL_PATH || path === ACK_PATH)
      return emailEventsGate(req, this.env);
    return loginChange(req, this.env);
  }
}

export default {
  fetch: (req, env, ctx) => handle(req, env, ctx),
  // Hourly (wrangler.jsonc triggers): the MCP client sweep (8.3, 9A.7).
  scheduled: (ctl, env, ctx) => {
    ctx.waitUntil(sweepOAuthClientsAll(env, ctl.scheduledTime).then(() => {}));
    if (env.EMAIL_EVENTS === "1")
      ctx.waitUntil(pruneEmailEvents(env, ctl.scheduledTime).catch(() => {}));
  },
  // The Email Service event queue (#2650); staging only until prod's switch-on.
  queue: async (batch, env) => {
    await consumeEmailEvents(
      batch as unknown as Parameters<typeof consumeEmailEvents>[0],
      env,
    );
  },
} satisfies ExportedHandler<Env, unknown>;
