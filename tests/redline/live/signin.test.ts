import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { mark } from "../src/barrier.ts";
import { send } from "../src/http.ts";
import { proof } from "../src/report.ts";
import { codeRequestReq, expectTurnstileRequired } from "../src/signin.ts";
import { loadTargets, type Targets } from "../src/targets.ts";

// P5 R6 (plan Task 6): sign-in on the deployed installs. Since cloud #264
// step 2 (red-line page v3) only the Turnstile case stays here: the cases the
// page moves to PR CI or deletes (state and code replays, ID tokens, the
// broker tamper, guests) are in src/retired-split.ts with the tests that
// guard them now.

let T: Targets;

beforeAll(async () => {
  T = await loadTargets();
});

// P34 waits for this mark before it floods the broker (src/lanes.ts
// "broker-ip": ordered("broker-done")).
afterAll(() => {
  mark("broker-done");
});

const rand = () => randomBytes(5).toString("hex");

describe("sign-in: Turnstile", () => {
  it("a code request with no Turnstile token is refused at each install (400 turnstile_required)", async (ctx) => {
    // The server's own check still runs on the red-line installs, whatever
    // token the other code cases send (rl-a and rl-b run the test secret).
    if (T.mode !== "staging")
      return proof(ctx, "staging-only", "local installs run without Turnstile");
    for (const t of [T.a, T.b])
      await expectTurnstileRequired(
        t,
        await send(
          codeRequestReq(t, `rl-noturnstile-${rand()}@${t.testDomain}`),
        ),
      );
  });
});
