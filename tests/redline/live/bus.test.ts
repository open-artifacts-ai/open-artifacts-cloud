import { afterAll, describe, it } from "vitest";
import {
  BUS_CASE_TIMEOUT_MS,
  CLOSE_SOON_MS,
  CROSS_CASE_TIMEOUT_MS,
  crossInstallCase,
  type LivePair,
  liveCrossIo,
  livePair,
  liveSuspendIo,
  Minted,
  mask,
  requireBusOn,
  suspendCase,
} from "../src/hosted-bus.ts";
import { label, proof } from "../src/report.ts";
import type { Held } from "../src/ws.ts";

// open-artifacts#1954 (cloud #202): the hosted bus's two cases, on the staging
// pair rl-agents and rl-busb (src/hosted-bus.ts), whose bus is on through
// STAGING_BUS_SLUGS whatever HOSTED_BUS_LIFTED says (P51 on rl-l keeps that
// switch). A machine token is the bus's own credential, minted by the device
// flow and approved by the install's admin; it must upgrade a socket only at
// its own install. Suspending an install must close its daemon sockets and
// keep refusing them until the resume, and touch no other install's.
//
// Case 2 is long (a 6 min paused window, the suspend and resume jobs): this
// file has a lane of its own (src/lanes.ts "busb"), so the window runs beside
// the provisioning chains instead of after them.

const env = process.env;
let live: Promise<LivePair> | undefined;
const minted = new Minted(mask(env));
const held: Held[] = [];

/** The pair, signed in once for both cases; null off staging. */
const pair = (): Promise<LivePair> | null => {
  if (!env.REDLINE_RELEASE) return null;
  live ??= livePair(env).then(async (p) => {
    await requireBusOn(p.agents);
    await requireBusOn(p.busb);
    return p;
  });
  return live;
};

afterAll(async () => {
  for (const h of held) h.destroy();
  await minted.cleanup();
});

describe("bus", () => {
  it(
    "rl-agents' machine token at rl-busb: /bus/connect is 401 unauthorized, never 101; 101 at rl-agents; rl-busb's machines and roster unchanged; its content host never upgrades it",
    async (ctx) => {
      const p = pair();
      if (!p)
        return proof(
          ctx,
          "not-applicable",
          "no REDLINE_RELEASE: the hosted bus pair is staging's (redline-staging)",
        );
      const l = await p;
      await crossInstallCase(liveCrossIo(l.agents, l.busb, minted), l.pair);
      label(
        ctx,
        `rl-agents ${l.pair.agents.version}, rl-busb ${l.pair.busb.version}`,
      );
    },
    CROSS_CASE_TIMEOUT_MS,
  );

  it(
    "suspend rl-busb: its daemon socket closes with 4403, reconnects get dispatch's paused answer and never 101 for 6 min, rl-agents' socket stays open; after the resume the same token connects, the pending mail is there and the hub is intact",
    async (ctx) => {
      const p = pair();
      if (!p)
        return proof(
          ctx,
          "not-applicable",
          "no REDLINE_RELEASE: the hosted bus pair is staging's (redline-staging)",
        );
      const l = await p;
      const r = await suspendCase(
        liveSuspendIo(l.busb, l.agents, minted, l.run, held),
        l.pair,
      );
      label(
        ctx,
        `closed ${Math.round(r.closeMs / 1000)} s after the suspend${r.closeMs > CLOSE_SOON_MS ? ` (target ${CLOSE_SOON_MS / 1000} s)` : ""}; ${r.reconnects} reconnects refused, paused for ${Math.round(r.pausedMs / 1000)} s`,
      );
    },
    BUS_CASE_TIMEOUT_MS,
  );
});
