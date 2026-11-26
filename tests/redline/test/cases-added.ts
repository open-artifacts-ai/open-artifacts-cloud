// Cases added to live/manifest.json after #1730's base. test/fixtures/main-cases.json
// and the recording in test/fixtures/run-42402998826.json freeze that base, so a
// new route is declared here, with its port, and never edited into the
// snapshots (a recording gets no invented durations). same-cases.test.ts and
// schedule.test.ts hold the manifest to the snapshot plus exactly this list.
export const CASES_ADDED_SINCE_1730: readonly { file: string; name: string }[] =
  [
    // #1954 (cloud #202): the hosted bus's two cases on rl-busa and rl-busb
    // (their bus is on through STAGING_BUS_SLUGS, not the lift). Both gate
    // like any other case (promoted, cloud #202).
    {
      file: "live/bus.test.ts",
      name: "bus > rl-busa's machine token at rl-busb: /bus/connect is 401 unauthorized, never 101; 101 at rl-busa; rl-busb's machines and roster unchanged; its content host never upgrades it",
    },
    {
      file: "live/bus.test.ts",
      name: "bus > suspend rl-busb: its daemon socket closes within 30 s with 4403, reconnects at 10, 60 and 125 s get dispatch's paused answer and never 101, rl-busa's socket stays open; after the resume the same token connects, the pending mail is there and the hub is intact",
    },
    // #1299 part 4: P51 passes or fails on a real assertion before and after
    // the lift (src/bus-gate.ts); it is not an accepted unproven.
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
    // #1346 role reach, ported with the v0.140.0 pin bump.
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.158.0: the agent-authored comment thread routes (PUT/DELETE).
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.166.0 (#2263): the pick answer's passkey challenge, and the ten
    // passkey routes (browser session only, so deny-only like the bus writes).
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.179.0: the ask decider route (#1794) and the document websocket (DocRoom).
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.184.0: the inbox route (#2525).
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.189.0: the login settings routes (#2545).
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.190.1: the doc ops route (#2542) and the edit_doc MCP tool.
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.195.0: doc versions (#1100), withdraw_ask and edit_comment (#2511).
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.205.0: inbox read (#2512), held requests (#2577) and Install now
    // (#2552), each interactive-only and deny-only (A's session at B).
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.219.0: the agent-requests switch and listens-to list (#2577 S2),
    // deny-only, and the switch read, probed with both credentials.
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.213.0: prefs, mutes, Later and push subscription changes (#2512,
    // #2762), each interactive-only and deny-only (A's session at B).
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.213.0: the reads they pair with (#2512), mention candidates (#2770)
    // and comment pictures (#2577), probed with both credentials.
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.197.0: the onboarding routes (#2632), probed now, no longer dropped.
    ...[].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // #859: the provisioner probes, run last in the prov lane.
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
];
