import { checkCsrf, checkOrigin } from "../auth/csrf.js";
import { signupPrincipal } from "../auth/signup-session.js";
import { readJsonBody } from "../body.js";
import type { Env } from "../env.js";
import { ApiError, errorResponse } from "../errors.js";
import { limitRoute } from "../limits.js";
import { isRefusal } from "../principal.js";
import { refuse } from "../refuse.js";
import { admission, normEmail } from "./gate.js";
import { sendWaitlistEmail } from "./waitlist-email.js";

// POST /api/v1/signup/waitlist on the sign-up host: "Join the waitlist".
// Session, exact Origin, CSRF and the write rate limit, like /auth/open. The
// email and sub come only from the session, never the body.

export const NOTE_MAX = 280;

/** The optional note: trimmed, at most NOTE_MAX characters, else invalid_input. */
export function parseNote(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== "object" || Array.isArray(body))
    throw new ApiError("invalid_input", "body must be an object");
  const note = (body as { note?: unknown }).note;
  if (note === undefined || note === null) return null;
  if (typeof note !== "string")
    throw new ApiError("invalid_input", "note must be a string");
  const t = note.trim();
  // Characters (code points), not UTF-16 units.
  if ([...t].length > NOTE_MAX)
    throw new ApiError("invalid_input", `note: at most ${NOTE_MAX} characters`);
  return t === "" ? null : t;
}

export async function joinWaitlist(
  req: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const o = checkOrigin(req, env, "signup");
  if (o) return refuse(env, "csrf", o.code, req);
  const p = await signupPrincipal(req, env, now);
  if (isRefusal(p)) return refuse(env, "auth", p.code, req);
  const c = checkCsrf(req, env, p);
  if (c) return refuse(env, "csrf", c.code, req);
  const lim = await limitRoute(env, "write", p, "signup_waitlist");
  if (lim) return refuse(env, "auth", lim.code, req);

  let inserted = false;
  try {
    if (env.SIGNUPS_ENABLED !== "invite")
      throw new ApiError("invalid_state", "invalid_state", {
        reason: "not_invite_mode",
      });
    const note = parseNote(await readJsonBody(req));
    if ((await admission(env, p)) === "admitted")
      throw new ApiError("invalid_state", "invalid_state", {
        reason: "already_allowed",
      });
    // Idempotent: a re-join keeps the first joined_at and note, and never
    // reopens an approved or declined row (a declined person still reads as
    // waitlisted).
    const res = await env.PLATFORM_DB.prepare(
      `INSERT INTO signup_waitlist (sub, email, note, joined_at)
       VALUES (?1, ?2, ?3, ?4) ON CONFLICT (sub) DO NOTHING`,
    )
      .bind(p.sub as string, normEmail(p.email as string), note, now)
      .run();
    inserted = (res.meta.changes ?? 0) === 1;
  } catch (e) {
    if (e instanceof ApiError)
      return errorResponse(e.code, e.message, e.details);
    throw e;
  }
  // Only a new row gets the email; a repeat join sends nothing. Best effort:
  // sendWaitlistEmail never throws.
  if (inserted)
    await sendWaitlistEmail(env, p.email as string, new URL(req.url).host);
  return new Response(JSON.stringify({ gate: "waitlisted" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
