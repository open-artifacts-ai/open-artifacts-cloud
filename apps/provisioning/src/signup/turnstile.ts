import type { Env } from "../env.js";
import { ApiError } from "../errors.js";

type VerifyInput = Parameters<Env["PROVISIONER"]["verifyTurnstile"]>[0];

/**
 * Verifies a Turnstile token. A failed check is `turnstile_failed`; a lookup
 * that throws (the provisioner's Cloudflare call, e.g. a token without
 * Turnstile Read) is a coded 503 `unavailable`, never a raw 500. The log line
 * carries the error's name, code and message only: no token, IP or email.
 */
export async function checkTurnstile(
  env: Env,
  input: VerifyInput,
): Promise<void> {
  let ok: boolean;
  try {
    ok = (await env.PROVISIONER.verifyTurnstile(input)).ok;
  } catch (e) {
    const err = e as { name?: unknown; code?: unknown; message?: unknown };
    console.warn("turnstile lookup failed", {
      name: typeof err?.name === "string" ? err.name : "Error",
      code: typeof err?.code === "string" ? err.code : undefined,
      message: typeof err?.message === "string" ? err.message : String(e),
    });
    throw new ApiError("unavailable", "sign-up is unavailable; retry");
  }
  if (!ok) throw new ApiError("turnstile_failed");
}
