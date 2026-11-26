import { beforeAll, describe, it } from "vitest";
import {
  JOB_WITHIN_MS,
  PROBE_TIMEOUT_MS,
  type Run,
} from "../src/provisioning.ts";
import { rawTargets } from "../src/provisioning-live.ts";
import {
  canary,
  checkContentApp,
  checkFreshMapped,
  checkHealth,
  createFresh,
  type Fresh,
  freshCreds,
  SMOKE_CASES,
  smokeDir,
  smokeRun,
} from "../src/smoke.ts";

// Track 1 of the smoke (src/smoke.ts): a brand-new install at the release
// under test, like a new customer. scripts/smoke.ts purges it afterwards in
// the background; that never holds or fails the gate.

const [CREATE, HEALTH, CANARY] = SMOKE_CASES["smoke/fresh.test.ts"];
const env = process.env;
let run: Run;
let dir: string;
let fresh: Fresh | undefined;

beforeAll(() => {
  run = smokeRun(env);
  dir = smokeDir(env);
});

const made = (): Fresh => {
  if (!fresh) throw new Error("blocked: the create did not finish");
  return fresh;
};

describe("fresh install", () => {
  it(
    CREATE.slice("fresh install > ".length),
    async () => {
      fresh = await createFresh(run, dir);
    },
    JOB_WITHIN_MS + 5 * 60_000,
  );

  it(HEALTH.slice("fresh install > ".length), async () => {
    const f = made();
    await checkHealth(f.app, {
      name: f.slug,
      installId: f.id,
      version: run.c.version,
    });
    await checkContentApp(f.slug, f.app, f.content);
    await checkFreshMapped(run, f);
  });

  it(
    CANARY.slice("fresh install > ".length),
    async () => {
      const f = made();
      const c = await freshCreds(run, f, env);
      await canary(f, c, { app: rawTargets(env.REDLINE_TARGETS).a.app });
    },
    PROBE_TIMEOUT_MS,
  );
});
