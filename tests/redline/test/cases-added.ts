import {
  DELETE_HUB_NOT_GATING,
  HOSTED_BUS_NOT_GATING,
  P54_NAME,
} from "../src/report.ts";

// Cases added to live/manifest.json after #1730's base. test/fixtures/main-cases.json
// and the recording in test/fixtures/run-42402998826.json freeze that base, so a
// new route is declared here, with its port, and never edited into the
// snapshots (a recording gets no invented durations). same-cases.test.ts and
// schedule.test.ts hold the manifest to the snapshot plus exactly this list.
export const CASES_ADDED_SINCE_1730: readonly { file: string; name: string }[] =
  [
    // #1954 (cloud #202): the hosted bus's two cases on rl-busa and rl-busb
    // (their bus is on through STAGING_BUS_SLUGS, not the lift). Both are
    // accepted unproven for one release (ACCEPTED_UNPROVEN_ADDED_SINCE_1730).
    {
      file: "live/bus.test.ts",
      name: "bus > rl-busa's machine token at rl-busb: /bus/connect is 401 unauthorized, never 101; 101 at rl-busa; rl-busb's machines and roster unchanged; its content host never upgrades it",
    },
    {
      file: "live/bus.test.ts",
      name: "bus > suspend rl-busb: its daemon socket closes within 30 s with 4403, reconnects inside the 120 s pause window are closed with 4403 by the install's later pass, after it never 101, rl-busa's socket stays open; after the resume the same token connects, the pending mail is there and the hub is intact",
    },
    // #1299 part 4: P51 passes or fails on a real assertion before and after
    // the lift (src/bus-gate.ts); it is not an accepted unproven.
    {
      file: "live/provisioning.test.ts",
      name: "provisioning > P51: bus (#1299): suspend closes a long-connected machine socket and refuses a new one; the same token connects again after resume",
    },
    // #1106: a failed upgrade stays on the new version (staging proof of the forward-fix leg).
    {
      file: "live/provisioning.test.ts",
      name: "provisioning > P52: a failed upgrade stays forward (#1106): rl-f's health check is failed after the upload, and it stays on the new version",
    },
    // #1501: a killed upgrade is retried by its own job (staging proof).
    {
      file: "live/provisioning.test.ts",
      name: "provisioning > P53: a killed upgrade is retried by its own job (#1501): rl-f-k's first attempt dies after its version write with the row upgrading, the job's retry takes the lease and finishes active on the new version",
    },
    // open-artifacts#2360: a delete wipes the install's Durable Object
    // namespaces; accepted unproven for one release.
    { file: "live/provisioning.test.ts", name: P54_NAME },
    // #1346 role reach, ported with the v0.140.0 pin bump.
    ...[
      "org GET /api/v1/bus/reach [session]",
      "org GET /api/v1/bus/reach [pat]",
      "org PUT /api/v1/bus/reach [session]",
      "org DELETE /api/v1/bus/reach/:id [session]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.158.0: the agent-authored comment thread routes (PUT/DELETE).
    ...[
      "artifact comments thread agent put [session]",
      "artifact comments thread agent put [pat]",
      "artifact comments thread agent delete [session]",
      "artifact comments thread agent delete [pat]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.166.0 (#2263): the pick answer's passkey challenge, and the ten
    // passkey routes (browser session only, so deny-only like the bus writes).
    ...[
      "artifact comments answer challenge [session]",
      "artifact comments answer challenge [pat]",
      "org GET /api/v1/passkeys [session]",
      "org POST /api/v1/passkeys/register/begin [session]",
      "org POST /api/v1/passkeys/register/challenge [session]",
      "org POST /api/v1/passkeys/register/finish [session]",
      "org POST /api/v1/passkeys/:id/challenge [session]",
      "org DELETE /api/v1/passkeys/:id [session]",
      "org POST /api/v1/passkeys/:id/cancel-removal [session]",
      "org GET /api/v1/passkeys/settings [session]",
      "org PATCH /api/v1/passkeys/settings [session]",
      "org POST /api/v1/passkeys/settings/challenge [session]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // #859: the provisioner probes, run last in the prov lane.
    {
      file: "live/provisioner.test.ts",
      name: "provisioner > a replayed signup creates nothing new",
    },
    {
      file: "live/provisioner.test.ts",
      name: "provisioner > a signup for a taken slug fails cleanly",
    },
  ];

// The accepted-unproven entries added after #1730's base (main-cases.json holds
// the four before it). Declared by exact name, file and reason; never a
// loosening of the gate. Cloud #59 (https://github.com/open-artifacts-ai/open-artifacts-cloud/issues/59)
// removes both, and must close before sign-ups open.
export const ACCEPTED_UNPROVEN_ADDED_SINCE_1730: readonly {
  name: string;
  reason: string;
  file: string;
}[] = [
  {
    name: "provisioner > a replayed signup creates nothing new",
    reason:
      "REDLINE_STG_PROVISIONER is not configured (the provisioner is not deployed)",
    file: "provisioner.test.ts",
  },
  {
    name: "provisioner > a signup for a taken slug fails cleanly",
    reason:
      "REDLINE_STG_PROVISIONER is not configured (the provisioner is not deployed)",
    file: "provisioner.test.ts",
  },
  // Cloud #202: the hosted bus cases, not gating for one release.
  {
    name: "bus > rl-busa's machine token at rl-busb: /bus/connect is 401 unauthorized, never 101; 101 at rl-busa; rl-busb's machines and roster unchanged; its content host never upgrades it",
    reason: HOSTED_BUS_NOT_GATING,
    file: "bus.test.ts",
  },
  {
    name: "bus > suspend rl-busb: its daemon socket closes within 30 s with 4403, reconnects inside the 120 s pause window are closed with 4403 by the install's later pass, after it never 101, rl-busa's socket stays open; after the resume the same token connects, the pending mail is there and the hub is intact",
    reason: HOSTED_BUS_NOT_GATING,
    file: "bus.test.ts",
  },
  {
    name: P54_NAME,
    reason: DELETE_HUB_NOT_GATING,
    file: "provisioning.test.ts",
  },
];
