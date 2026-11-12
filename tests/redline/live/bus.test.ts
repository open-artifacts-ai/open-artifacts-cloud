import { afterAll, describe, it } from "vitest";
import {
  BUS_CASE_TIMEOUT_MS,
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
import { HOSTED_BUS_NOT_GATING, label, proof } from "../src/report.ts";
import type { Held } from "../src/ws.ts";

// open-artifacts#1954 (cloud #202): the hosted bus's two cases, on red-line's
// own staging pair rl-busa and rl-busb (src/hosted-bus.ts), whose bus is on
// through STAGING_BUS_SLUGS whatever HOSTED_BUS_LIFTED says (P51 on rl-l
// keeps that switch). A machine token is the bus's own credential, minted by
// the device flow and approved by the install's admin; it must upgrade a
// socket only at its own install. Suspending an install must close its daemon
// sockets and keep refusing them until the resume, and touch no other
// install's.
//
// Not gating for one release: a case that fails reports unproven-live with
// HOSTED_BUS_NOT_GATING (an accepted entry in src/report.ts) and puts what
// failed in its label. A pass is a pass.

const env = process.env;
let live: Promise<LivePair> | undefined;
const minted = new Minted(mask(env));
const held: Held[] = [];

/** The pair, signed in once for both cases; null off staging. */
const pair = (): Promise<LivePair> | null => {
  if (!env.REDLINE_RELEASE) return null;
  live ??= livePair(env).then(async (p) => {
    await requireBusOn(p.busa);
    await requireBusOn(p.busb);
    return p;
  });
  return live;
};

type Ctx = Parameters<typeof proof>[0];
/** Runs a case; a failure is reported, not gated (one release, cloud #202). */
async function notGating(ctx: Ctx, body: (l: LivePair) => Promise<string>) {
  const p = pair();
  if (!p)
    return proof(
      ctx,
      "not-applicable",
      "no REDLINE_RELEASE: the hosted bus pair is staging's (redline-staging)",
    );
  try {
    label(ctx, await body(await p));
  } catch (e) {
    label(
      ctx,
      `would fail: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    );
    proof(ctx, "unproven-live", HOSTED_BUS_NOT_GATING);
  }
}

afterAll(async () => {
  for (const h of held) h.destroy();
  await minted.cleanup();
});

describe("bus", () => {
  it(
    "rl-busa's machine token at rl-busb: /bus/connect is 401 unauthorized, never 101; 101 at rl-busa; rl-busb's machines and roster unchanged; its content host never upgrades it",
    (ctx) =>
      notGating(ctx, async (l) => {
        await crossInstallCase(liveCrossIo(l.busa, l.busb, minted), l.pair);
        return `rl-busa ${l.pair.busa.version}, rl-busb ${l.pair.busb.version}`;
      }),
    CROSS_CASE_TIMEOUT_MS,
  );

  it(
    "suspend rl-busb: its daemon socket closes within 30 s with 4403, reconnects at 10, 60 and 125 s get dispatch's paused answer and never 101, rl-busa's socket stays open; after the resume the same token connects, the pending mail is there and the hub is intact",
    (ctx) =>
      notGating(ctx, async (l) => {
        const r = await suspendCase(
          liveSuspendIo(l.busb, l.busa, minted, l.run, held),
          l.pair,
        );
        return `closed ${Math.round(r.closeMs / 1000)} s after the suspend job; ${r.reconnects} reconnects got the paused answer`;
      }),
    BUS_CASE_TIMEOUT_MS,
  );
});
