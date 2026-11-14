// #2479: the `signed_up` event to PostHog, server-side, once per self-serve
// install. Same payload shape and distinct id (the install id) as the public
// server's activation events, so the funnel joins.
//
// Off until the POSTHOG_KEY secret is bound: no key, no call. The payload is
// fixed: { instance_id, plan, time, $geoip_disable }. Never an email, sub,
// slug or name. Best effort: never awaited by the caller (ctx.waitUntil), a
// 3 s timeout, and only a warning code is logged on failure.

import type { Env } from "../env.js";

/** Default PostHog capture host; POSTHOG_HOST overrides it (EU cloud, a proxy). */
export const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";
const SEND_TIMEOUT_MS = 3000;

/** Sends `signed_up` now; never throws. Exported for the unit tests. */
export async function sendSignedUp(
  env: Env,
  installId: string,
  plan: string,
  now = Date.now(),
): Promise<void> {
  const key = env.POSTHOG_KEY?.trim();
  if (!key) return;
  try {
    const host = env.POSTHOG_HOST?.trim() || POSTHOG_DEFAULT_HOST;
    const res = await fetch(`${host.replace(/\/+$/, "")}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      body: JSON.stringify({
        api_key: key,
        event: "signed_up",
        distinct_id: installId,
        properties: {
          instance_id: installId,
          plan,
          time: new Date(now).toISOString(),
          // No location is derived from this server's IP.
          $geoip_disable: true,
        },
      }),
    });
    if (!res.ok)
      console.warn("analytics_send_failed", { code: `http_${res.status}` });
  } catch (e) {
    console.warn("analytics_send_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}

/** Fires `signed_up` after the response; a no-op with no key. Never throws. */
export function signedUp(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  installId: string,
  plan: string,
): void {
  if (!env.POSTHOG_KEY?.trim()) return;
  ctx.waitUntil(sendSignedUp(env, installId, plan));
}
