// #1168: a token-actor job rechecks that its token and the admin session it
// was minted under are still live when the Workflow runs (tokenPrincipal's
// rules, minus ADMIN_IDENTITIES). One test per rule, on a manage job and a
// create job; a refusal is terminal invalid_state with a job.token_refused
// audit row naming the reason.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_PUBKEY } from "../../../../packages/provision/test/fixtures/release.js";
import { runManage } from "../../src/manage.js";
import { runCreate } from "../../src/workflow.js";
import {
  event,
  seedCreate,
  seedJob,
  seedToken,
  stepRunner,
  V1,
  V2,
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

let w: World;
beforeEach(async () => {
  w = await world();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

type TokenOpts = NonNullable<Parameters<typeof seedToken>[1]>;

/** An active install, then an upgrade job by a token made with `t`. */
async function upgrade(t: TokenOpts | null) {
  const s = seedCreate(w, { slug: "tokco", version: V1 });
  await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step);
  expect(w.job(s.jobId)?.status).toBe("done");
  const id = seedJob(w, {
    kind: "upgrade",
    installId: s.installId,
    args: { from: V1, to: V2 },
    actor: "token",
    ...(t === null ? { tokenId: null } : { tokenId: seedToken(w, t) }),
  });
  await runManage(w.ctx, event(id), stepRunner(w.clock).step).catch(() => {});
  return { id, installId: s.installId, job: w.job(id) };
}

const refusals = (installId: string) =>
  w
    .all<{ actor: string; detail: string }>(
      "SELECT actor, detail FROM hosted_audit WHERE install_id = ? AND action = 'job.token_refused'",
      installId,
    )
    .map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }));

const STALE: [string, TokenOpts | null, string][] = [
  ["no token row (token_id null)", null, "no_token"],
  ["the token is revoked", { revoked: true }, "revoked"],
  ["the token is past expires_at", { expired: true }, "expired"],
  ["its session is gone", { noSession: true }, "session_ended"],
  ["its session is revoked", { sessionRevoked: true }, "session_ended"],
  ["its session is expired", { sessionExpired: true }, "session_ended"],
  ["its session is not an admin one", { sessionKind: "user" }, "session_ended"],
  [
    "its session is another email's",
    { sessionEmail: "b@example.com" },
    "session_ended",
  ],
];

describe("a token-actor manage job rechecks the grant is live (#1168)", () => {
  it("a live token (oauth or oat, email in any case) runs, with no refusal row", async () => {
    for (const kind of ["oauth", "oat"] as const) {
      w = await world();
      const r = await upgrade({ kind });
      expect(r.job).toMatchObject({ status: "done" });
      expect(refusals(r.installId)).toEqual([]);
    }
  });

  for (const [name, t, reason] of STALE)
    it(`${name}: invalid_state, terminal, audited as ${reason}`, async () => {
      const r = await upgrade(t);
      expect(r.job).toMatchObject({
        status: "failed",
        error_code: "invalid_state",
      });
      expect(refusals(r.installId)).toEqual([
        { actor: `job:${r.id}`, jobId: r.id, kind: "upgrade", reason },
      ]);
      // The recheck stopped the job before it touched the install.
      expect(w.install(r.installId)?.version).toBe(V1);
    });

  it("the audit row holds no token id or email", async () => {
    const r = await upgrade({ revoked: true });
    const dump = JSON.stringify(
      w.all("SELECT * FROM hosted_audit WHERE action = 'job.token_refused'"),
    );
    expect(dump).not.toContain("example.com");
    expect(dump).not.toMatch(/sh-/);
    expect(r.job?.error_message).not.toMatch(/token/i);
  });

  it("a token revoked after the job was accepted, before it ran, is refused", async () => {
    const s = seedCreate(w, { slug: "lateco", version: V1 });
    await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step);
    const tokenId = seedToken(w);
    const id = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      args: { from: V1, to: V2 },
      actor: "token",
      tokenId,
    });
    w.db
      .prepare("UPDATE agent_tokens SET revoked_at = ? WHERE id = ?")
      .run(w.clock.t, tokenId);
    await runManage(w.ctx, event(id), stepRunner(w.clock).step).catch(() => {});
    expect(w.job(id)).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
  });

  it("expiry is checked at the run's clock: a token that lapses while the job waits is refused", async () => {
    const s = seedCreate(w, { slug: "lapseco", version: V1 });
    await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step);
    const id = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      args: { from: V1, to: V2 },
      actor: "token",
    });
    w.clock.t += 2 * 3_600_000;
    await runManage(w.ctx, event(id), stepRunner(w.clock).step).catch(() => {});
    expect(w.job(id)).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
  });

  it("other actors are not asked for a token", async () => {
    for (const actor of ["admin", "system"] as const) {
      w = await world();
      const s = seedCreate(w, { slug: "noco", version: V1 });
      await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step);
      const id = seedJob(w, {
        kind: "upgrade",
        installId: s.installId,
        args: { from: V1, to: V2 },
        actor,
      });
      await runManage(w.ctx, event(id), stepRunner(w.clock).step).catch(
        () => {},
      );
      expect(w.job(id)?.error_code).not.toBe("token_refused");
      expect(refusals(s.installId)).toEqual([]);
    }
  });
});

describe("a token-actor create job rechecks the grant is live (#1168)", () => {
  for (const [name, t, reason] of STALE.slice(0, 4))
    it(`${name}: refused before anything is created`, async () => {
      const s = seedCreate(w, {
        slug: "tokcreate",
        actor: "token",
        tokenId: t === null ? null : seedToken(w, t),
      });
      await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step).catch(
        () => {},
      );
      expect(w.job(s.jobId)).toMatchObject({
        status: "failed",
        error_code: "invalid_state",
      });
      expect(refusals(s.installId)).toMatchObject([{ reason }]);
      expect(w.install(s.installId)).toBeFalsy();
    });
});
