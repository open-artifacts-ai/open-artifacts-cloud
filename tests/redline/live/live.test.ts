import { afterAll, beforeAll, describe, it } from "vitest";
import {
  apiReq,
  createThrowaway,
  dataPath,
  deleteThrowaways,
  whoami,
} from "../src/fixtures.ts";
import { describeRes, readBody, send } from "../src/http.ts";
import { expectRefused, prepareSide, type Side } from "../src/refused.ts";
import { loadTargets, type Target, type Targets } from "../src/targets.ts";

// P5 Task 5: live sockets and anonymous writes. #1235: the data API cases
// (A's PAT at B on each data and storage route) are retired; src/retired.ts
// names what guards them. Cloud #264 step 2 (red-line page v3): the socket
// and anonymous-write cases moved to PR CI or were deleted
// (src/retired-split.ts); the public-link case stays.

const COL = "c";

interface Live {
  s: Side;
  user: { id: string; email: string };
  /** Private, db + storage: the sockets' artifact. */
  data: string;
  /** Public, db, allowAnonymousWrites. */
  anon: string;
}

let T: Targets;
let A: Live;
let B: Live;
/** Every artifact a side created (marker first), recorded as it is made. */
const made = new Map<Side, string[]>();

const side = (t: Target): Live => (t === T.a ? A : B);

async function setup(t: Target): Promise<Live> {
  const s = await prepareSide(t);
  const ids: string[] = [s.markerId];
  made.set(s, ids);
  const user = await whoami(t, s.pat);
  const mk = async (o: Parameters<typeof createThrowaway>[2]) => {
    const w = await createThrowaway(t, s.pat, o);
    ids.push(w.id);
    return w;
  };
  const data = await mk({ capabilities: { db: true, storage: true } });
  const anon = await mk({
    visibility: "public",
    capabilities: { db: true },
    allowAnonymousWrites: true,
  });
  return { s, user, data: data.id, anon: anon.id };
}

beforeAll(async () => {
  T = await loadTargets();
  A = await setup(T.a);
  B = await setup(T.b);
});

afterAll(async () => {
  let bad = 0;
  let partial = 0;
  for (const [s, ids] of made) {
    // A side whose setup failed part way: still clean up, but fail the run.
    if (s !== A?.s && s !== B?.s) partial++;
    bad += await deleteThrowaways(s.t, s.pat, ids);
  }
  if (bad || partial)
    throw new Error(
      `${bad} throwaway artifacts were not deleted; ${partial} side(s) failed setup`,
    );
});

const _subscribeUrl = (t: Target) =>
  `${t.app}${dataPath(side(t).data, "data-subscribe")}?collection=${COL}`;
const _eventsUrl = (t: Target) => `${t.app}${dataPath(side(t).data, "events")}`;

// Failure model gap 13 (PUBLIC-1): /p/ serves a public artifact to anyone, so
// no tenant credential is involved, and the surface probes drop it. What
// only a live run shows: the deployed content host stops serving it the
// moment it goes private, with no edge cache in between. One try, no poll:
// waiting for a refusal would hide exactly that window.
describe("a public link on B", () => {
  it("serves while public, and is refused as soon as the artifact is private", async () => {
    const w = await createThrowaway(T.b, B.s.pat, { visibility: "public" });
    made.get(B.s)?.push(w.id);
    const url = `${T.b.content}/p/${encodeURIComponent(w.id)}/v1/index.html`;
    const open = await fetch(url, { redirect: "manual" });
    const body = await readBody(open);
    if (open.status !== 200 || !body.includes(w.marker))
      throw new Error(
        `B's public link didn't serve the artifact (${describeRes(open, body)})`,
      );
    const flip = await send(
      apiReq(T.b, B.s.pat, "PATCH", `/api/v1/artifacts/${w.id}`, {
        visibility: "private",
      }),
    );
    const flipped = await readBody(flip);
    if (flip.status !== 200)
      throw new Error(`B's flip to private: ${describeRes(flip, flipped)}`);
    await expectRefused(await fetch(url, { redirect: "manual" }), T.b);
  });
});
