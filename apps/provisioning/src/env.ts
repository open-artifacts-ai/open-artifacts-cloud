import type {
  ProvisionerRpc,
  ProvisioningEnv,
  Tier,
  WorkflowLike,
} from "@oa/provisioning-contract";

/**
 * Billing's operator entrypoint (BillingOperatorRpc, #66), as this Worker
 * sees it: a structural copy of @oa/billing-core's SetTierResult, which this
 * package does not depend on. Billing never throws for an expected outcome.
 */
export type BillingSetTierResult =
  | {
      ok: true;
      tier: "team" | "business";
      status: "active";
      version: number;
      updatedAt: number;
      previous: {
        tier: string | null;
        status: string | null;
        version: number;
      } | null;
    }
  | {
      ok: false;
      error:
        | "bad_install"
        | "bad_tier"
        | "unknown_install"
        | "subscription_active"
        | "unavailable";
    };
export type BillingTiersOfResult =
  | {
      ok: true;
      tiers: Record<string, { tier: string | null; status: string | null }>;
    }
  | { ok: false; error: "bad_installs" | "unavailable" };
export interface BillingOperatorRpc {
  /** Optional: billing may deploy after provisioning (release-before-use). */
  tiersOf?(installs: string[]): Promise<BillingTiersOfResult>;
  setTier(
    install: string,
    tier: "team" | "business",
  ): Promise<BillingSetTierResult>;
}

/** The bindings of oa-<p>-provisioning (design v7 2.4, wrangler.jsonc). */
export interface Env {
  PLATFORM_DB: D1Database;
  /** This Worker's version; its tag is the release the platform runs. */
  CF_VERSION_METADATA?: { tag?: string };
  /** Workflows on oa-<p>-provisioner (script_name). */
  PROVISION_INSTALL: WorkflowLike;
  MANAGE_INSTALL: WorkflowLike;
  /** Entrypoint ProvisionerRpc: exactly three read-only methods (2.6). */
  PROVISIONER: ProvisionerRpc;
  /**
   * Billing's operator entrypoint (#66). Staging only for now (prod has no
   * billing Worker bound anywhere); unbound, set-tier answers `unavailable`.
   */
  BILLING?: BillingOperatorRpc;
  /** Broker redeem only (4.3). */
  AUTH_BROKER: Fetcher;
  /** Self-serve producer (post-M1). */
  SIGNUPS: Queue;
  /** The admin SPA (single-page-application, Worker first). */
  ASSETS: Fetcher;
  /** Rate limits (4.7, 9A.7); unbound fails closed with 503 unavailable. */
  RL_PV_PRE_IP?: RateLimit;
  RL_PV_SIGNIN_IP?: RateLimit;
  RL_PV_WRITE?: RateLimit;
  RL_PV_READ?: RateLimit;
  RL_PV_SLUG_IP?: RateLimit;
  RL_PV_OAUTH_IP?: RateLimit;
  /** Admin R21/R24 escape and per-token write sub-bucket (limits.ts). */
  RL_PV_ADMIN_ESCAPE?: RateLimit;
  RL_PV_TOKEN_WRITE?: RateLimit;
  /** MCP OAuth clients, grants and tokens; the library's store (9A.3.1). */
  OAUTH_KV: KVNamespace;
  /** Secrets (4.6). */
  ADMIN_SESSION_KEY: string;
  ADMIN_BROKER_KEY: string;
  /**
   * Ed25519 pkcs8 for the `i00000signup` broker entry (the sign-up host's
   * ticket and redeem key). Unset: the sign-up host's sign-in answers 503.
   */
  SIGNUP_BROKER_KEY?: string;
  /**
   * The public Turnstile site key the sign-up page renders (a self-serve
   * create needs a token, 4.2). Unset: the page cannot create and says so.
   */
  TURNSTILE_SITEKEY?: string;
  OA_ENV: ProvisioningEnv;
  /** Staging only (honoured by adminSessionTtlMs); prod ignores it. */
  ADMIN_SESSION_TTL_HOURS?: string;
  /** Committed `email:sub` comma list (4.1), read on every request. */
  ADMIN_IDENTITIES: string;
  APP_DOMAIN: string;
  SIGNUPS_ENABLED: "false" | "true" | "test-users";
  SELF_SERVE_TIER: Tier;
  /**
   * The scheduler's and consumer's daily self-serve cap, so R27 runs the
   * `signup_cap` condition with the same value (9A.5); unset is 0 (off).
   */
  SIGNUP_DAILY_CAP?: string;
  /** Exact redirect URIs besides loopback (9A.3.1), comma list. */
  MCP_REDIRECT_URIS: string;
  /** Staging only (4.4). */
  OIDC_AUDIENCE?: string;
  OIDC_ENVIRONMENT?: string;
  OIDC_JOB_WORKFLOW_REFS?: string;
  OIDC_REPOSITORY?: string;
  OIDC_REPOSITORY_ID?: string;
}
