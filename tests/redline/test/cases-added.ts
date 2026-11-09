// Cases added to live/manifest.json after #1730's base. test/fixtures/main-cases.json
// and the recording in test/fixtures/run-42402998826.json freeze that base, so a
// new route is declared here, with its port, and never edited into the
// snapshots (a recording gets no invented durations). same-cases.test.ts and
// schedule.test.ts hold the manifest to the snapshot plus exactly this list.
export const CASES_ADDED_SINCE_1730: readonly { file: string; name: string }[] =
  [
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
  ];
