// Cases added to live/manifest.json after #1730's base. test/fixtures/main-cases.json
// and the recording in test/fixtures/run-42402998826.json freeze that base, so a
// new route is declared here, with its port, and never edited into the
// snapshots (a recording gets no invented durations). same-cases.test.ts and
// schedule.test.ts hold the manifest to the snapshot plus exactly this list.
export const CASES_ADDED_SINCE_1730: readonly { file: string; name: string }[] =
  [
    // #1299 part 4: the bus's cross-install machine token and P51. Both pass
    // or fail on a real assertion before and after the lift (src/bus-gate.ts);
    // neither is an accepted unproven.
    {
      file: "live/bus.test.ts",
      name: "bus > A's machine token at B: /bus/connect is 401, no 101 (each token upgrades at its own install)",
    },
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
];
