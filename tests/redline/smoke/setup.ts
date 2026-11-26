import { getCurrentTest } from "vitest/suite";
import { boundFetch } from "../src/fetch-timeout.ts";
import { setCurrentTest } from "../src/notes.ts";

// The smoke's only fetch rule: every request is bounded
// (src/fetch-timeout.ts), so a stalled one fails its case instead of holding
// the gate. No pacing ledger, members lock or ordering mark: the smoke makes
// few enough requests per person, and a 429 is infra (src/smoke.ts req).
setCurrentTest(() => getCurrentTest());
globalThis.fetch = boundFetch(globalThis.fetch);
