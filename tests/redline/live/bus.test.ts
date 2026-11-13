import { afterAll, describe, it } from "vitest";
import {
  BUS_CASE_TIMEOUT_MS,
  BUS_CLEANUP_TIMEOUT_MS,
  CASE_JOB_WITHIN_MS,
  CROSS_CASE_TIMEOUT_MS,
  crossInstallCase,
  ensureResumed,
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

// open-artifacts#1954 (cloud #202): the hosted bus's two cases, on red-line's
// own staging pair rl-busa and rl-busb (src/hosted-bus.ts), whose bus is on
// through STAGING_BUS_SLUGS whatever HOSTED_BUS_LIFTED says (P51 on rl-l
// keeps that switch). A machine token is the bus's own credential, minted by
// the device flow and approved by the install's admin; it must upgrade a
// socket only at its own install. Suspending an install must close its daemon
// sockets and keep refusing them until the resume, and touch no other
// install's.
//
// Both cases gate like any other: a failure fails the case.

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
/**
 * Runs a case with its own deadline, a minute inside vitest's, so a slow
 * case fails with a reason instead of timing out bare.
 */
async function runCase(
  ctx: Ctx,
  timeoutMs: number,
  body: (l: LivePair) => Promise<string>,
) {
  const p = pair();
  if (!p)
    return proof(
      ctx,
      "not-applicable",
      "no REDLINE_RELEASE: the hosted bus pair is staging's (redline-staging)",
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `no result within ${Math.round((timeoutMs - 60_000) / 1000)} s`,
          ),
        ),
      timeoutMs - 60_000,
    );
  });
  try {
    label(ctx, await Promise.race([p.then(body), late]));
  } finally {
    clearTimeout(timer);
  }
}

// OA Bus M3: a case that ran out of time doesn't stop suspendCase, so rl-busb
// may still be suspended here: resume it (bounded, logged), then revoke this
// run's machines. The revoke step resumes it too if this could not.
afterAll(async () => {
  for (const h of held) h.destroy();
  const l = await live?.catch(() => undefined);
  if (l)
    await ensureResumed(
      l.run,
      l.pair.busb.installId,
      l.pair.busb.name,
      CASE_JOB_WITHIN_MS,
      (s) => process.stdout.write(`bus cleanup: ${s}`),
    );
  await minted.cleanup();
}, BUS_CLEANUP_TIMEOUT_MS);

describe("bus", () => {
  it(
    "rl-busa's machine token at rl-busb: /bus/connect is 401 unauthorized, never 101; 101 at rl-busa; rl-busb's machines and roster unchanged; its content host never upgrades it",
    (ctx) =>
      runCase(ctx, CROSS_CASE_TIMEOUT_MS, async (l) => {
        await crossInstallCase(liveCrossIo(l.busa, l.busb, minted), l.pair);
        return `rl-busa ${l.pair.busa.version}, rl-busb ${l.pair.busb.version}`;
      }),
    CROSS_CASE_TIMEOUT_MS,
  );

  it(
    "suspend rl-busb: its daemon socket closes within 30 s with 4403, reconnects inside the 120 s pause window are closed with 4403 by the install's later pass, after it never 101, rl-busa's socket stays open; after the resume the same token connects, the pending mail is there and the hub is intact",
    (ctx) =>
      runCase(ctx, BUS_CASE_TIMEOUT_MS, async (l) => {
        const r = await suspendCase(
          liveSuspendIo(l.busb, l.busa, minted, l.run, held),
          l.pair,
        );
        const w = r.windowCloseMs
          .map((m) => (m === null ? "never" : `${Math.round(m / 1000)} s`))
          .join(", ");
        return `closed ${Math.round(r.closeMs / 1000)} s after the suspend job; ${r.reconnects} reconnects, ${r.windowOpens} got 101 in the pause window${r.windowOpens ? ` (closed ${w} after the suspend job; frames ${JSON.stringify(r.windowFrames)}${r.windowDelivery ? "; DELIVERY FRAME on a window socket" : ""})` : ""}`;
      }),
    BUS_CASE_TIMEOUT_MS,
  );
});
