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
    // v0.179.0: the ask decider route (#1794) and the document websocket (DocRoom).
    ...[
      "artifact comments ask decider [session]",
      "artifact comments ask decider [pat]",
      "artifact ws doc [session]",
      "artifact ws doc [pat]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.184.0: the inbox route (#2525).
    ...[
      "org GET /api/v1/me/inbox [session]",
      "org GET /api/v1/me/inbox [pat]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.189.0: the login settings routes (#2545).
    ...[
      "org GET /api/v1/members/reach [session]",
      "org GET /api/v1/members/reach [pat]",
      "org GET /api/v1/settings/login [session]",
      "org GET /api/v1/settings/login [pat]",
      "org POST /api/v1/settings/login/first-invite-seen [session]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.190.1: the doc ops route (#2542) and the edit_doc MCP tool.
    ...[
      "artifact rest doc ops [session]",
      "artifact rest doc ops [pat]",
      "artifact mcp edit_doc [pat]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.195.0: doc versions (#1100), withdraw_ask and edit_comment (#2511).
    ...[
      "artifact comments ask withdraw [session]",
      "artifact comments ask withdraw [pat]",
      "artifact mcp withdraw_ask [pat]",
      "artifact mcp edit_comment [pat]",
      "artifact rest doc save version [session]",
      "artifact rest doc save version [pat]",
      "artifact rest doc restore [session]",
      "artifact rest doc restore [pat]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.205.0: inbox read (#2512), held requests (#2577) and Install now
    // (#2552), each interactive-only and deny-only (A's session at B).
    ...[
      "org POST /api/v1/me/inbox/read [session]",
      "org POST /api/v1/me/inbox/read-all [session]",
      "org GET /api/v1/me/agent-asks/held [session]",
      "org POST /api/v1/me/agent-asks/held/:id/allow [session]",
      "org POST /api/v1/me/agent-asks/held/:id/allow/challenge [session]",
      "org POST /api/v1/me/agent-asks/held/:id/not-now [session]",
      "org POST /api/v1/bus/machines/:id/install-now [session]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.219.0: the agent-requests switch and listens-to list (#2577 S2),
    // deny-only, and the switch read, probed with both credentials.
    ...[
      "org PUT /api/v1/me/agent-requests [session]",
      "org GET /api/v1/me/agent-listens [session]",
      "org PATCH /api/v1/me/agent-listens/:id [session]",
      "org DELETE /api/v1/me/agent-listens/:id [session]",
      "org GET /api/v1/me/agent-requests [pat]",
      "org GET /api/v1/me/agent-requests [session]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.213.0: prefs, mutes, Later and push subscription changes (#2512,
    // #2762), each interactive-only and deny-only (A's session at B).
    ...[
      "org PUT /api/v1/me/notification-prefs [session]",
      "org POST /api/v1/me/inbox/mutes [session]",
      "org DELETE /api/v1/me/inbox/mutes/:kind/:id [session]",
      "org POST /api/v1/me/inbox/:id/later [session]",
      "org POST /api/v1/me/push/subscriptions [session]",
      "org PATCH /api/v1/me/push/subscriptions/:id [session]",
      "org DELETE /api/v1/me/push/subscriptions/:id [session]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.213.0: the reads they pair with (#2512), mention candidates (#2770)
    // and comment pictures (#2577), probed with both credentials.
    ...[
      "org GET /api/v1/me/inbox/mutes [pat]",
      "org GET /api/v1/me/inbox/mutes [session]",
      "org GET /api/v1/me/notification-prefs [pat]",
      "org GET /api/v1/me/notification-prefs [session]",
      "org GET /api/v1/me/push/key [pat]",
      "org GET /api/v1/me/push/key [session]",
      "org GET /api/v1/me/push/subscriptions [pat]",
      "org GET /api/v1/me/push/subscriptions [session]",
      "artifact artifact mention candidates [pat]",
      "artifact artifact mention candidates [session]",
      "artifact comment picture read [pat]",
      "artifact comment picture read [session]",
      "artifact comment picture reserve [pat]",
      "artifact comment picture reserve [session]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // v0.197.0: the onboarding routes (#2632), probed now, no longer dropped.
    ...[
      "org GET /api/v1/onboarding [session]",
      "org GET /api/v1/onboarding [pat]",
      "org PUT /api/v1/onboarding [session]",
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
    // regen:begin (scripts/redline-regen.ts writes this block; do not edit it by hand)
    ...[
      "artifact ask slots [session]",
      "artifact ask slots [pat]",
      "org GET /api/v1/me/teammates [session]",
      "org POST /api/v1/me/onboarding/listens-asked [session]",
      "artifact mcp get_comment_picture [pat]",
      "org POST /api/v1/me/agent-listens [session]",
      "org GET /api/v1/me/agent-asks/history [session]",
    ].map((n) => ({
      file: "live/surfaces.test.ts",
      name: `surface probes (cross-install) > ${n}`,
    })),
    // regen:end
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
