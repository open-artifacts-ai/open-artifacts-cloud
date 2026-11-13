import { z } from "zod";
import { hmac16 } from "../audit.js";
import { readJsonBody } from "../body.js";
import type { Env } from "../env.js";
import { ApiError, errorResponse } from "../errors.js";
import { charge, HOUR_MS, ipKeyOf } from "../services/counters.js";
import { ulid } from "../ulid.js";
import { ADDRESS_RE, REPLY_TO, SENDER_NAME } from "./approval-email.js";

// POST /api/v1/contact on the sign-up host (open-artifacts#2404): the Business
// "Contact us" form. No session: Origin (checked by the router), a Turnstile
// token and a per-IP hourly limit stand in for one. Every request is recorded
// first; the operator email is best effort and never fails the request.

export const TEAM_SIZES = ["1-10", "11-50", "51-200", "200+"] as const;
export const NEEDS = [
  "group_sync",
  "sharing_controls",
  "audit_log",
  "custom_domain",
  "other",
] as const;
export const NOTE_MAX = 1000;
/** Requests per client address (IPv6 by /64) per hour. */
export const CONTACT_PER_HOUR = 5;
const EMAIL_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

// Controls, bidi and zero-width characters never belong in a one-line value.
const ODD = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ODD_MULTI = /[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Cc}\n\r\t]/u;
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !ODD.test(s));

export const ContactSchema = z
  .object({
    name: line(100),
    email: z
      .string()
      .trim()
      .max(254)
      .transform((s) => s.toLowerCase())
      .refine((s) => ADDRESS_RE.test(s)),
    company: line(100),
    teamSize: z.enum(TEAM_SIZES),
    needs: z.array(z.enum(NEEDS)).max(NEEDS.length).default([]),
    note: z
      .string()
      .trim()
      .refine((s) => [...s].length <= NOTE_MAX)
      .refine((s) => !ODD_MULTI.test(s))
      .optional(),
    source: z.enum(["landing", "dashboard"]).default("landing"),
    // As the page was given it, unverified.
    instance: z.string().trim().max(253).optional(),
    turnstile: z.string().min(1).max(2048),
  })
  .strict();

export type ContactRequest = {
  id: string;
  name: string;
  email: string;
  company: string;
  teamSize: (typeof TEAM_SIZES)[number];
  needs: (typeof NEEDS)[number][];
  note: string | null;
  source: "landing" | "dashboard";
  instanceHost: string | null;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

/** The address the operator email goes to; unset, the shared reply address. */
export const operatorAddress = (env: Env) =>
  env.BUSINESS_REQUESTS_TO || REPLY_TO;

const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ");

export function operatorEmail(env: Env, r: ContactRequest) {
  const sizeLabel = r.teamSize;
  const text = [
    "A Business request came in.",
    "",
    `Name: ${r.name}`,
    `Email: ${r.email}`,
    `Company: ${r.company}`,
    `People who will publish: ${sizeLabel}`,
    `Needs: ${r.needs.length ? r.needs.join(", ") : "none given"}`,
    `Source: ${r.source}`,
    `Instance (as given, unverified): ${r.instanceHost ?? "none"}`,
    "",
    "Note:",
    r.note ?? "(none)",
    "",
    `Request id: ${r.id}`,
    "Reply to this email to answer them. Mark it contacted on the Business requests page in the admin.",
  ].join("\n");
  return {
    from: { email: env.WELCOME_FROM as string, name: SENDER_NAME },
    to: operatorAddress(env),
    replyTo: r.email,
    subject: `Business request: ${oneLine(r.company).slice(0, 80)}`,
    text,
  };
}

/** Sends the operator email; never throws. Returns the failure category, or null. */
async function notifyOperator(
  env: Env,
  r: ContactRequest,
): Promise<string | null> {
  if (!env.WELCOME_EMAIL || !env.WELCOME_FROM) return "email_not_configured";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      env.WELCOME_EMAIL.send(operatorEmail(env, r)),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(Object.assign(new Error("timeout"), { code: "TIMEOUT" })),
          EMAIL_TIMEOUT_MS,
        );
      }),
    ]);
    return null;
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
      ? code
      : "send_failed";
  } finally {
    clearTimeout(timer);
  }
}

export async function submitContact(
  req: Request,
  env: Env,
  ip: string,
  now: number,
): Promise<Response> {
  try {
    const parsed = ContactSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new ApiError("invalid_input");
    const b = parsed.data;
    const t = await env.PROVISIONER.verifyTurnstile({
      token: b.turnstile,
      remoteIp: ip,
      action: "signup",
      hostname: new URL(req.url).hostname,
      testUser: false,
    });
    if (!t.ok) throw new ApiError("turnstile_failed");
    const key = `contact_ip:${await hmac16(env, ipKeyOf(ip))}`;
    if (!(await charge(env, key, CONTACT_PER_HOUR, HOUR_MS)))
      throw new ApiError("rate_limited");

    const instance =
      b.instance && HOST_RE.test(b.instance.toLowerCase())
        ? b.instance.toLowerCase()
        : null;
    const row: ContactRequest = {
      id: ulid(now),
      name: b.name,
      email: b.email,
      company: b.company,
      teamSize: b.teamSize,
      needs: [...new Set(b.needs)],
      note: b.note ? b.note : null,
      source: b.source,
      instanceHost: instance,
    };
    // The same email, or the same instance, twice in one UTC day stores
    // nothing new. One statement, so two at once cannot both insert.
    const dayStart = now - (now % DAY_MS);
    const res = await env.PLATFORM_DB.prepare(
      `INSERT INTO business_requests
         (id, created_at, name, email, company, team_size, needs, note, source, instance_host)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
       WHERE NOT EXISTS (
         SELECT 1 FROM business_requests
         WHERE created_at >= ?11 AND (email = ?4 OR (?10 IS NOT NULL AND instance_host = ?10)))`,
    )
      .bind(
        row.id,
        now,
        row.name,
        row.email,
        row.company,
        row.teamSize,
        JSON.stringify(row.needs),
        row.note,
        row.source,
        row.instanceHost,
        dayStart,
      )
      .run();
    if ((res.meta.changes ?? 0) !== 1) return json({ duplicate: true });

    const failed = await notifyOperator(env, row);
    if (failed)
      console.error("business request email failed", {
        id: row.id,
        error: failed,
      });
    return json({ duplicate: false });
  } catch (e) {
    if (e instanceof ApiError)
      return errorResponse(e.code, e.message, e.details);
    throw e;
  }
}
