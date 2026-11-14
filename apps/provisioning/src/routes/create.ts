import { STAGING_TEST_DOMAIN } from "@oa/provision/names";
import {
  type CreateInstallSchema,
  canonicalJson,
  checkCreateFields,
  fieldRulesOf,
  slugError,
  type Tier,
} from "@oa/provisioning-contract";
import type { z } from "zod";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";
import { factsOf, isTestUser, type PrincipalFacts } from "../facts.js";
import { newInstallId } from "../ids.js";
import type { Principal } from "../principal.js";
import { signedUp } from "../services/analytics.js";
import { chargeSelfServeCreate } from "../services/counters.js";
import { accept, replay, writeOf } from "../services/jobs.js";
import { admission } from "../signup/gate.js";
import { checkTurnstile } from "../signup/turnstile.js";
import type { HandlerArgs } from "./handlers.js";
import type { RouteResult } from "./invoke.js";
import { releaseDeletedSignupSlug, slugState } from "./reads.js";
import { claimAccount, resolveRelease } from "./writes.js";

// R4 POST /installs (3.3, 3.6, 4.2, 7). One D1 batch writes the job, the
// signup, its secret, the lifecycle row, the account claim (self-serve) and
// the audit row; then admin, token and OIDC creates start ProvisionInstall,
// and self-serve ones go to the SIGNUPS queue, whose consumer admit()s them
// under the daily cap (7).

type Body = z.infer<typeof CreateInstallSchema>;

/** The canonical signups.vars (0007): never an email. */
export function signupVars(
  auth: {
    providers: readonly string[];
    domains: readonly string[];
    domainCodes?: boolean;
  },
  tier: Tier,
  testHooks: boolean,
): string {
  return canonicalJson({
    AUTH_PROVIDERS: auth.providers.join(","),
    AUTH_DOMAINS: auth.domains.join(","),
    ...(auth.domainCodes === true ? { EMAIL_CODE_DOMAIN: "on" } : {}),
    TIER: tier,
    ...(testHooks ? { TEST_DOMAIN: STAGING_TEST_DOMAIN } : {}),
  });
}

export const liveClaim = async (env: Env, sub: string) =>
  (await env.PLATFORM_DB.prepare(
    "SELECT 1 AS x FROM signup_accounts WHERE owner_sub = ? AND freed_at IS NULL",
  )
    .bind(sub)
    .first()) !== null;

function slugRule(slug: string) {
  const e = slugError(slug);
  if (e) throw new ApiError(e);
}

const GMAIL_DOMAINS = ["gmail.com", "googlemail.com"];
const isGmailAddress = (email: string): boolean =>
  GMAIL_DOMAINS.includes(email.slice(email.lastIndexOf("@") + 1).toLowerCase());

/** 4.2 self-serve policy, in order, after the forbidden fields. */
async function selfServePolicy(
  a: HandlerArgs,
  p: Principal & PrincipalFacts,
  body: Body,
): Promise<{ hd: string | null; email: string }> {
  const { env, surface } = a;
  const testUser = isTestUser(p, env);
  const admitted = await admission(env, p);
  if (admitted === "closed") throw new ApiError("signups_closed");
  // `invite` mode (#2096): not on the allow list. The contract's codes are
  // public, so this is a 403 forbidden whose details.reason says why; the
  // sign-up page sends the person to the waitlist.
  if (admitted === "not_invited")
    throw new ApiError(
      "forbidden",
      "Open Artifacts is in private beta. Join the waitlist.",
      { reason: "not_invited" },
    );
  // Self-serve is HTTP only: /mcp answers a user 401 before this (4.2).
  if (surface.kind !== "http") throw new ApiError("forbidden");
  if (body.turnstile === undefined) throw new ApiError("turnstile_failed");
  await checkTurnstile(env, {
    token: body.turnstile,
    remoteIp: surface.client.ip,
    action: "signup",
    hostname: surface.client.host,
    testUser,
  });
  if (!(await chargeSelfServeCreate(env, surface.client.ip)))
    throw new ApiError("rate_limited");
  if (!p.email || !p.sub) throw new ApiError("forbidden");
  // Mirrors the public rule: with no hd (no Workspace domain) only a Gmail
  // address may sign up; any other email without hd is refused.
  if (!p.hd && !isGmailAddress(p.email))
    throw new ApiError(
      "forbidden",
      "Sign up with a Gmail address or a Google Workspace account.",
    );
  if (await liveClaim(env, p.sub)) throw new ApiError("signup_limit");
  return { hd: p.hd ?? null, email: p.email };
}

export async function createInstall(a: HandlerArgs): Promise<RouteResult> {
  const { env } = a;
  const p = factsOf(a.principal);
  const body = a.input.body as Body;
  const rules = fieldRulesOf(p.kind);
  if (!rules) throw new ApiError("forbidden");
  const f = checkCreateFields(body, rules, env.OA_ENV, STAGING_TEST_DOMAIN);
  if (f) throw new ApiError(f.code, `${f.field}: ${f.code}`);
  // Public #1825 lets the contract accept google with no auth.domains (owner
  // and invites only), but the hosted pipeline does not: the provisioner
  // refuses it (apps/provisioner/src/recheck.ts, packages/provision/src/wfp.ts),
  // so it would be accepted here and fail later. Refuse it now, until Gmail
  // owners (#864/#865).
  if (body.auth?.providers?.includes("google") && !body.auth.domains?.length)
    throw new ApiError("invalid_input", "auth.domains: google needs a domain");

  const w = await writeOf(env, p, a.surface, "R4", null, body);
  const prior = await replay(w);
  if (prior) return prior;

  const user = p.kind === "user";
  const ss = user ? await selfServePolicy(a, p, body) : null;
  slugRule(body.slug);
  const testHooks = body.testHooks === true;
  // Pinned here, so the provisioner never picks the newest by itself.
  const version = await resolveRelease(
    env,
    body.version,
    testHooks ? "redline" : "release",
  );
  const held = await slugState(env, body.slug, ss ? (p.sub as string) : null);
  // "cooling" is a purged address inside its 30 days (cloud #108); the
  // code stays slug_taken (the contract is public) and the message says why.
  if (held === "cooling") throw new ApiError("slug_taken", "slug_cooling");
  if (held === "taken") throw new ApiError("slug_taken");

  // checkCreateFields required these for every principal but U.
  const tier: Tier = ss ? env.SELF_SERVE_TIER : (body.tier as Tier);
  const auth = ss
    ? { providers: ["google", "email"], domains: ss.hd ? [ss.hd] : [] }
    : (body.auth as NonNullable<Body["auth"]>);
  const ownerEmail = ss ? ss.email : (body.ownerEmail as string);
  const sendWelcome = ss ? true : body.sendWelcome === true;
  const ownerSub = ss ? (p.sub as string) : null;

  const now = Date.now();
  const installId = newInstallId();
  const db = env.PLATFORM_DB;
  // The signup's id is its first create job's id (0007).
  const after = (jobId: string): D1PreparedStatement[] => [
    releaseDeletedSignupSlug(env, body.slug, now),
    db
      .prepare(
        `INSERT INTO signups (signup_id, source, owner_sub, slug, job_id, vars, version, test_hooks, send_welcome, status, admitted_at, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?1, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
      )
      .bind(
        jobId,
        ss ? "self-serve" : "admin",
        ownerSub,
        body.slug,
        signupVars(auth, tier, testHooks),
        version ?? null,
        testHooks ? 1 : 0,
        sendWelcome ? 1 : 0,
        // Admin, token and OIDC creates are admitted here; self-serve ones
        // by the consumer's admit() (5.2 step 1).
        ss ? "pending" : "queued",
        ss ? null : now,
        now,
      ),
    db
      .prepare(
        "INSERT INTO signup_secret (signup_id, owner_email) VALUES (?1, ?2)",
      )
      .bind(jobId, ownerEmail),
    db
      .prepare(
        "INSERT INTO install_lifecycle (install_id, source, owner_sub, tier, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
      )
      .bind(installId, ss ? "self-serve" : "admin", ownerSub, tier, now),
    // One live install per account (7): claim, or reclaim a freed row.
    ...(ownerSub ? claimAccount(env, ownerSub, jobId, now) : []),
  ];
  return accept(w, {
    job: {
      kind: "create",
      installId,
      signupId: "self",
      args: version ? { version } : {},
    },
    after,
    onConflict: async () => {
      if (ownerSub && (await liveClaim(env, ownerSub)))
        throw new ApiError("signup_limit");
      throw new ApiError("slug_taken");
    },
    start: ss
      ? async (jobId) => {
          // #2479: the batch has committed (the install id, signup and claim
          // exist), and a replay or lost race never reaches start, so this
          // fires once per self-serve install. Off the response path.
          signedUp(env, a.ctx, installId, tier);
          // W1's parseSignup takes exactly { signupId }; the signup id is the
          // job id (0007).
          await env.SIGNUPS.send({ signupId: jobId });
        }
      : undefined,
  });
}
