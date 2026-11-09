import { STAGING_TEST_DOMAIN } from "@oa/provision/names";
import { beforeAll, describe, expect, it } from "vitest";
import { BARRIER_DEADLINE_MS, waitFor } from "../src/barrier.ts";
import {
  createTaken,
  type ProvisionerClient,
  type ProvisionerProbe,
  parseProvisionerProbe,
  pollUntil,
  provisionerClient,
  SIGNUP_FIELDS,
} from "../src/provisioner.ts";
import { proof } from "../src/report.ts";
import { loadTargets, type Targets, verifyTarget } from "../src/targets.ts";

// SS3 red-line cases for the hosted provisioner (staging only; #859 and its
// leftovers). Both are listed in live/manifest.json and run in the
// `provisioner` lane (src/lanes.ts). Without REDLINE_STG_PROVISIONER (the workflow builds it
// from the Environment's variable of that name and the REDLINE_STG_PROVISIONER_TOKEN
// secret) each is unproven-live, which the gate does not accept; local mode
// has no provisioner and each is staging-only.

let T: Targets;
let P: ProvisionerProbe | undefined;
let C: ProvisionerClient;

const NOT_CONFIGURED =
  "REDLINE_STG_PROVISIONER is not configured (the provisioner is not deployed)";

/**
 * How long a replay is watched. A ready row is acked on its first delivery
 * (max_batch_size 1, the default 5 s batch timeout); twice that, plus a
 * create start that a bug would make, is well inside a minute.
 */
const REPLAY_WATCH_MS = 60_000;

beforeAll(async () => {
  T = await loadTargets();
  if (T.mode !== "staging") return;
  P = parseProvisionerProbe();
  if (P) C = provisionerClient(P);
});

describe("provisioner", () => {
  it(
    "a replayed signup creates nothing new",
    async (ctx) => {
      if (T.mode !== "staging")
        return proof(ctx, "staging-only", "needs the staging provisioner");
      if (!P) return proof(ctx, "unproven-live", NOT_CONFIGURED);
      const id = P.replaySignupId;
      const snap = async () => {
        const [s] = await C.query(
          `SELECT ${SIGNUP_FIELDS}, slug FROM signups WHERE signup_id = ?1`,
          [id],
        );
        const installs = s
          ? await C.query(
              "SELECT id, state, updated_at FROM installs WHERE slug = ?1 OR id = ?2 ORDER BY id",
              [s.slug, s.install_id],
            )
          : [];
        return JSON.stringify({ s, installs });
      };
      const before = await snap();
      const b = JSON.parse(before);
      if (b.s?.status !== "ready" || !b.s?.welcome_sent_at || !b.s?.admitted_at)
        return proof(
          ctx,
          "unproven-live",
          `the fixture signup is ${b.s ? b.s.status : "missing"}, not admitted and ready with its welcome sent`,
        );
      expect(b.installs).toHaveLength(1);
      // The same message twice, as a redelivery and a client retry would.
      await C.enqueue(id);
      await C.enqueue(id);
      // Every read in the window must match: a change that a later write
      // undoes is still a replay that did something.
      const seen = await pollUntil(snap, (v) => v !== before, REPLAY_WATCH_MS);
      expect(seen.met, "the replay changed the signup or its install").toBe(
        false,
      );
      expect(seen.value).toBe(before);
    },
    REPLAY_WATCH_MS + 60_000,
  );

  it(
    "a signup for a taken slug fails cleanly",
    async (ctx) => {
      if (T.mode !== "staging")
        return proof(ctx, "staging-only", "needs the staging provisioner");
      if (!P) return proof(ctx, "unproven-live", NOT_CONFIGURED);
      // First, so the snapshots below are not read before a long wait.
      // createTaken spends RL_PV_WRITE / RL_PV_PRE_IP, which the prov lane's
      // probes also spend: wait for that lane to end (src/barrier.ts). Off
      // unless the lanes' runner set it; an overrun is an InfraError.
      await waitFor("prov-done", { orLaneExit: "prov" });
      // The contract is the Provisioning API's (R4 createInstall: slugHeld,
      // then onConflict, both slug_taken), not the provisioner's: a taken
      // name is refused before anything is written.
      const [owner] = await C.query(
        "SELECT slug, state, updated_at FROM installs WHERE id = ?1",
        [T.a.installId],
      );
      expect(owner?.state, `${T.a.name} is active`).toBe("active");
      const slug = String(owner?.slug);
      const requestId = `rl${process.env.REDLINE_RUN_ID ?? "x"}-taken`
        .replace(/[^A-Za-z0-9_-]/g, "-")
        .slice(0, 64)
        .padEnd(16, "0");
      const snap = async () =>
        JSON.stringify({
          installs: await C.query(
            "SELECT id, state, updated_at FROM installs WHERE slug = ?1 ORDER BY id",
            [slug],
          ),
          signups: await C.query(
            "SELECT signup_id, status, install_id, updated_at FROM signups WHERE slug = ?1 ORDER BY signup_id",
            [slug],
          ),
        });
      const before = await snap();
      const res = await createTaken(process.env, {
        requestId,
        slug,
        ownerEmail: `redline-signup@${STAGING_TEST_DOMAIN}`,
      });
      expect(
        { status: res.status, code: res.code },
        `R4 for ${T.a.name}'s slug: ${res.status} ${res.code ?? "no code"}`,
      ).toEqual({ status: 409, code: "slug_taken" });
      // Nothing written for it. The job, the signup, its secret and the
      // lifecycle row go in one D1 batch (create.ts, accept), so no jobs row
      // for this request id means none of the others either; the slug's
      // installs and signups are what they were; no message was sent.
      expect(
        await C.query("SELECT id FROM jobs WHERE request_id = ?1", [requestId]),
        "a jobs row for the refused request",
      ).toEqual([]);
      expect(await snap(), "installs or signups for the slug changed").toBe(
        before,
      );
      expect(JSON.parse(before).installs).toEqual([
        { id: T.a.installId, state: "active", updated_at: owner?.updated_at },
      ]);
      // A still serves as itself.
      await verifyTarget(T.a);
    },
    BARRIER_DEADLINE_MS + 90_000,
  );
});
