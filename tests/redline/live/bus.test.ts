import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type BusSite,
  busState,
  connectRequest,
  HOSTED_BUS_LIFTED,
  mintMachine,
  revokeMachines,
} from "../src/bus.ts";
import { deleteThrowaways } from "../src/fixtures.ts";
import { describeRes, readBody } from "../src/http.ts";
import {
  crossCheck,
  expectRefused,
  NotRefused,
  prepareSide,
  type Side,
} from "../src/refused.ts";
import { loadTargets, type Targets } from "../src/targets.ts";
import { wsHandshake } from "../src/ws.ts";

// #1299 part 4: the hosted bus on the red-line pair. A machine token is the
// bus's own credential (never a PAT, a cookie or an OAuth grant): minted by the
// device flow, approved in the browser form by an install's admin, redeemed
// at GET /bus/connect. The design could break in one way across installs: a
// token minted at A upgrading a socket at B. Install A's and B's machine
// tables are separate D1 rows, so B must find no row for A's token hash.
//
// The bus is off on hosted installs (404) until the HOSTED=1 gate is lifted
// (part 6). Until HOSTED_BUS_LIFTED (src/bus-gate.ts) is set, the case asserts
// that: the ping answers 404 at both sides, and a bus that is on fails it.
// After the lift the full cross-install assertions run, and a bus that is off
// fails.

const LABEL = `redline-bus-${Date.now().toString(36)}`;

let T: Targets;
let A: Side;
let B: Side;
let on = false;
const minted: { s: Side; site: BusSite }[] = [];
const site = (s: Side): BusSite => ({ app: s.t.app, fetch: globalThis.fetch });
const patOf = (s: Side): string => {
  if (s.pat.kind !== "pat")
    throw new Error("the admin credential is not a PAT");
  return s.pat.token;
};
const cookieOf = (s: Side): string => {
  if (s.cookie.kind !== "cookie")
    throw new Error("the admin credential is not a session");
  return `${s.cookie.name}=${s.cookie.value}`;
};

beforeAll(async () => {
  T = await loadTargets();
  A = await prepareSide(T.a);
  B = await prepareSide(T.b);
  const states = [
    await busState(site(A), patOf(A)),
    await busState(site(B), patOf(B)),
  ];
  // One side on and the other off is a broken rollout, not "off".
  if (states[0] !== states[1])
    throw new Error(
      `the bus is ${states[0]} at ${T.a.name} but ${states[1]} at ${T.b.name}`,
    );
  on = states[0] === "on";
});

afterAll(async () => {
  let bad = 0;
  for (const m of minted)
    try {
      await revokeMachines(m.site, patOf(m.s), LABEL);
    } catch {
      bad++;
    }
  for (const s of [A, B])
    if (s) bad += await deleteThrowaways(s.t, s.pat, [s.markerId]);
  if (bad) throw new Error(`${bad} bus fixtures were not cleaned up`);
});

describe("bus", () => {
  it("A's machine token at B: /bus/connect is 401, no 101 (each token upgrades at its own install)", async () => {
    if (!HOSTED_BUS_LIFTED) {
      if (on)
        throw new Error(
          "the bus is on at the red-line pair before the lift: HOSTED=1 should answer 404 (set HOSTED_BUS_LIFTED in src/bus-gate.ts with part 6)",
        );
      return;
    }
    if (!on)
      throw new Error("the bus is off on the red-line pair after the lift");
    const tokens = new Map<string, string>();
    for (const s of [A, B]) {
      minted.push({ s, site: site(s) });
      tokens.set(s.t.name, await mintMachine(site(s), cookieOf(s), LABEL));
    }
    const tok = (t: { name: string }) => tokens.get(t.name) as string;
    await crossCheck((token: string, host) => connectRequest(host.app, token), {
      a: T.a,
      b: T.b,
      credA: tok(T.a),
      credB: tok(T.b),
      ok: (r) => r.status === 101,
      send: wsHandshake,
      // 401 exactly: a 404 would mean the bus is off at B, not that B
      // refused A's token, and that must never pass as a refusal.
      refused: async (res, b) => {
        if (res.status !== 401)
          throw new NotRefused(
            `${b.name} answered A's machine token with ${describeRes(res, await readBody(res.clone()))}, want 401`,
          );
        await expectRefused(res, b);
      },
    });
  });
});
