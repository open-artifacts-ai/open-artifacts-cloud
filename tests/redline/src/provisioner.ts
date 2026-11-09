// The provisioner probes (live/provisioner.test.ts): a replayed { signupId }
// on oa-s-signups for a standing ready signup, and a create for a taken slug
// through R4, each checked against platform D1. Staging only; the config is
// REDLINE_STG_PROVISIONER (the workflow builds it, tokenFile included).
// The token never reaches a report: errors name the call and its status only.

import { join } from "node:path";
import { boundFetch } from "./fetch-timeout.ts";
import { AUDIENCES, jwtSource, mask, OIDC_FILES } from "./oidc.ts";
import { readSecretFile } from "./targets.ts";

const API = "https://api.cloudflare.com/client/v4";

export interface ProvisionerProbe {
  accountId: string;
  /** Platform D1 (oa-s-platform). */
  platformDbId: string;
  /** The oa-s-signups queue id. */
  signupsQueueId: string;
  /**
   * A 0600 file the workflow writes from the REDLINE_STG_PROVISIONER_TOKEN
   * secret: D1 Edit on the platform DB (the probes only SELECT) and Queues Write on oa-s-signups.
   * The workflow sets this path itself; the variable never names it.
   */
  tokenFile: string;
  /**
   * A standing signup the provisioner already made ready with its welcome
   * sent (made once, per "Red-line provisioner probes" in docs/ops/hosted.md),
   * replayed by every run.
   */
  replaySignupId: string;
}

const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** The probe config, or undefined when REDLINE_STG_PROVISIONER is unset; throws on a bad one. */
export function parseProvisionerProbe(
  env: Record<string, string | undefined> = process.env,
): ProvisionerProbe | undefined {
  const raw = env.REDLINE_STG_PROVISIONER;
  if (raw === undefined || raw === "") return undefined;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("REDLINE_STG_PROVISIONER is not JSON");
  }
  const field = (k: keyof ProvisionerProbe, re?: RegExp): string => {
    const s = v?.[k];
    if (typeof s !== "string" || s === "" || (re && !re.test(s)))
      throw new Error(`REDLINE_STG_PROVISIONER.${k} is missing or malformed`);
    return s;
  };
  return {
    accountId: field("accountId", HEX32),
    platformDbId: field("platformDbId", UUID),
    signupsQueueId: field("signupsQueueId", HEX32),
    tokenFile: field("tokenFile"),
    replaySignupId: field("replaySignupId", ULID_RE),
  };
}

export type Row = Record<string, unknown>;

export interface ProvisionerClient {
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  /** One { signupId } message on oa-s-signups, exactly SS4's shape. */
  enqueue(signupId: string): Promise<void>;
}

export function provisionerClient(
  p: ProvisionerProbe,
  f: typeof fetch = fetch,
): ProvisionerClient {
  const token = readSecretFile(p.tokenFile, "REDLINE_STG_PROVISIONER token");
  const acct = `${API}/accounts/${p.accountId}`;
  const post = async (what: string, url: string, body: unknown) => {
    const res = await f(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      success?: unknown;
      result?: unknown;
    } | null;
    if (!res.ok || json?.success !== true)
      throw new Error(`${what}: Cloudflare answered ${res.status}`);
    return json.result;
  };
  return {
    async query(sql, params = []) {
      const r = (await post(
        "platform D1 query",
        `${acct}/d1/database/${p.platformDbId}/query`,
        { sql, params },
      )) as { results?: Row[] }[] | undefined;
      return r?.[0]?.results ?? [];
    },
    async enqueue(signupId) {
      if (!ULID_RE.test(signupId)) throw new Error("enqueue: not a ULID");
      await post(
        "oa-s-signups send",
        `${acct}/queues/${p.signupsQueueId}/messages`,
        { body: { signupId } },
      );
    },
  };
}

/** The fields of a signup a replay must leave as they were. */
export const SIGNUP_FIELDS =
  "status, install_id, admitted_at, welcome_claimed_at, welcome_sent_at, error, updated_at";

/**
 * Polls `read` every `everyMs` until `done` holds or `ms` runs out; the last
 * value either way. The bound is the caller's, from the provisioner's own
 * limits (its retries and backoff), never a guess at "long enough".
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  ms: number,
  everyMs = 5_000,
  sleep = (n: number) => new Promise<void>((r) => setTimeout(r, n)),
  now = Date.now,
): Promise<{ value: T; met: boolean }> {
  const end = now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return { value, met: true };
    if (now() >= end) return { value, met: false };
    await sleep(everyMs);
  }
}

/**
 * R4 `POST /v1/installs` as the GitHub OIDC principal, for a slug that is
 * taken: the status and error code the Provisioning API answers (409
 * slug_taken by contract; the refusal happens before anything is written).
 * Reads the JWT file in secretsDir (minting it in the job, like the other
 * suites). The api origin is REDLINE_PROV_API, else staging's.
 */
export async function createTaken(
  env: Record<string, string | undefined>,
  body: { requestId: string; slug: string; ownerEmail: string },
  f: typeof fetch = boundFetch(globalThis.fetch),
): Promise<{ status: number; code: string | undefined; text: string }> {
  let secretsDir: unknown;
  try {
    secretsDir = JSON.parse(env.REDLINE_TARGETS ?? "").secretsDir;
  } catch {}
  if (typeof secretsDir !== "string" || !secretsDir)
    throw new Error("REDLINE_TARGETS.secretsDir is required");
  const api = new URL(
    env.REDLINE_PROV_API || "https://api.open-artifacts-staging.app",
  );
  if (api.protocol !== "https:" || api.pathname !== "/" || api.search)
    throw new Error("REDLINE_PROV_API must be a bare https origin");
  const jwt = await jwtSource(
    join(secretsDir, OIDC_FILES.provisioning),
    AUDIENCES.provisioning,
    { env, onMint: mask(env) },
  )();
  const res = await f(`${api.origin}/v1/installs`, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...body,
      tier: "team",
      auth: { providers: ["email"], domains: [] },
      testHooks: true,
    }),
  });
  const text = await res.text().catch(() => "");
  let code: string | undefined;
  try {
    const e = (JSON.parse(text) as { error?: unknown }).error;
    code =
      typeof e === "string"
        ? e
        : typeof (e as { code?: unknown } | null)?.code === "string"
          ? (e as { code: string }).code
          : undefined;
  } catch {}
  return { status: res.status, code, text };
}
