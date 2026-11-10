// Staging only: STAGING_TEST_CLOCK_INSTALLS lists exact install ids whose
// Stripe customer is made on a test clock, so the Solo trial can be advanced
// (scripts/ops/staging-solo-clock.ts) instead of waited out. Honoured only
// when OA_ENV is staging AND the Stripe key is a test key; else ignored.

const INSTALL = /^i[a-z0-9]{11}$/;
const TEST_KEY = /^(sk|rk)_test_/;

/**
 * Strict: comma-separated exact install ids, no spaces, no empty or repeated
 * entries. Empty or absent is no list; anything malformed is null (the whole
 * list is ignored, never half-read).
 */
export function parseClockInstalls(raw: string | undefined): string[] | null {
  if (raw === undefined || raw === "") return [];
  const ids = raw.split(",");
  if (!ids.every((i) => INSTALL.test(i)) || new Set(ids).size !== ids.length)
    return null;
  return ids;
}

/** Whether `install` is on the staging test-clock list under this env and key. */
export function isClockInstall(
  env: { OA_ENV: string; STRIPE_SECRET_KEY?: string },
  raw: string | undefined,
  install: string,
): boolean {
  if (raw === undefined || raw === "") return false;
  if (env.OA_ENV !== "staging" || !TEST_KEY.test(env.STRIPE_SECRET_KEY ?? "")) {
    console.error("billing test_clock ignored", env.OA_ENV);
    return false;
  }
  const ids = parseClockInstalls(raw);
  if (ids === null) {
    console.error("billing test_clock list_invalid");
    return false;
  }
  return ids.includes(install);
}
