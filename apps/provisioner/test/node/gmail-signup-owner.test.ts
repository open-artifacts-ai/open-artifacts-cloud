// A personal Gmail sign-up end to end on fake-cf: the vars the sign-up page
// stores (create.ts signupVars, AUTH_DOMAINS empty), the provisioner's
// recheck and create, the config the install is uploaded with, then the
// server's own auth config and admission over its real schema. The owner
// must be able to sign in; nobody else may.
//
// Needs a public checkout that includes selfserve/google-no-domains (Google
// sign-in with no AUTH_DOMAINS): the server refuses an empty AUTH_DOMAINS
// before it.
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HOSTED_DOMAINS, NAMESPACES } from "@oa/provision";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nodeD1 } from "../../../../packages/provision/test/d1-node.js";
import { TEST_PUBKEY } from "../../../../packages/provision/test/fixtures/release.js";
import { signupVars } from "../../../provisioning/src/routes/create.js";
import { authConfig } from "../../../server/src/auth/config.js";
import type { Env as ServerEnv } from "../../../server/src/env.js";
import { admit } from "../../../server/src/services/identity.js";
import { runCreate } from "../../src/workflow.js";
import {
  ENV,
  event,
  FIX,
  seedCreate,
  stepRunner,
  type World,
  world,
} from "./world.js";

vi.mock(
  "../../../../packages/provision/src/internal/gates.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../../packages/provision/src/internal/gates.js")
    >()),
    get RELEASE_PUBKEY() {
      return { staging: TEST_PUBKEY, prod: TEST_PUBKEY };
    },
  }),
);

// admit never calls these on a sign-in; they only drag in the whole MCP
// server and its generated version file.
vi.mock("../../../server/src/mcp/oauth-api.js", () => ({
  revokeAllGrants: async () => {},
}));
vi.mock("../../../server/src/runtime/revoke.js", () => ({
  revokeUserLive: async () => {},
}));

const OWNER = "someone.personal@gmail.com";
const STRANGER = "stranger@gmail.com";
const identity = (email: string, subject: string) => ({
  provider: "google" as const,
  subject,
  email,
  name: null,
  // A Gmail account carries no hd; the server must not need one.
  tenant: null,
  authTime: null,
});

let w: World;
beforeEach(async () => {
  w = await world();
});

describe("Gmail sign-up: the owner can sign in", () => {
  it("create succeeds with no AUTH_DOMAINS and the uploaded config admits only the owner", async () => {
    // What create.ts stores for a personal Gmail account (ss.hd is null).
    const vars = JSON.parse(
      signupVars(
        { providers: ["google", "email"], domains: [] },
        "trial",
        false,
      ),
    ) as Record<string, string>;
    expect(vars).toMatchObject({
      AUTH_PROVIDERS: "google,email",
      AUTH_DOMAINS: "",
    });

    const s = seedCreate(w, {
      slug: "gmailowner",
      source: "self-serve",
      tier: "trial",
      vars,
      email: OWNER,
    });
    const r = stepRunner(w.clock);
    await runCreate(w.ctx, event(s.jobId), r.step);
    expect(w.job(s.jobId)).toMatchObject({ status: "done" });

    // The install as uploaded: its plain bindings are the server's env.
    const script = w.fake.script(NAMESPACES[ENV], `oa-s-${s.installId}`);
    const bindings = script?.metadata.bindings as {
      name: string;
      type: string;
      text?: string;
    }[];
    const plain = Object.fromEntries(
      bindings
        .filter((b) => b.type === "plain_text")
        .map((b) => [b.name, b.text as string]),
    );
    expect(plain).toMatchObject({
      AUTH_PROVIDERS: "google,email",
      AUTH_DOMAIN_JOIN: "invite",
      OWNER_EMAIL: OWNER,
      AUTH_BROKER_URL: `https://auth.${HOSTED_DOMAINS[ENV].app}`,
    });
    expect(plain.AUTH_DOMAINS ?? "").toBe("");

    // The server's real schema on node:sqlite, the config as uploaded plus
    // the one secret the platform adds.
    const sqlite = new DatabaseSync(":memory:");
    for (const m of FIX.MIGRATION_FILES)
      sqlite.exec(new TextDecoder().decode(m.bytes));
    // The install's send_email binding (EMAIL) and the Turnstile secret are
    // not plain text; stand in for both.
    const env = {
      ...plain,
      EMAIL: { send: async () => {} },
      TURNSTILE_SECRET: "turnstile-secret",
      BROKER_SIGNING_KEY: generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "der" })
        .toString("base64url"),
      DB: nodeD1(sqlite),
    } as unknown as ServerEnv;
    const cfg = authConfig(env);
    expect(cfg.problems).toEqual([]);
    expect(cfg.google).not.toBeNull();
    // Owner email codes, not domain codes.
    expect(cfg.emailCodes).toBe(true);
    expect(cfg.domainCodes).toBe(false);
    expect(cfg.domains).toEqual([]);
    expect(cfg.domainJoin).toBe("invite");

    const owner = await admit(env, cfg, identity(OWNER, "sub-owner"));
    expect(owner).toMatchObject({ ok: true, user: { role: "owner" } });
    const other = await admit(env, cfg, identity(STRANGER, "sub-stranger"));
    expect(other).toEqual({ ok: false, reason: "no_access" });
  });
});
