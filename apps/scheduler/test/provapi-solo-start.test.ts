import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ProvapiEnv } from "../src/provapi/env.js";
import { alertsTick } from "../src/provapi/index.js";
import {
  SOLO_ALERT_KEY,
  SOLO_ALERT_MS,
  SOLO_START_MS,
  soloStartMissingAlert,
} from "../src/provapi/solo-start.js";
import {
  captureLogs,
  db,
  installId,
  migrate,
  reset,
  signup,
} from "./provapi/db.js";

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 10, 9, 12, 0);
const OLD = NOW - SOLO_START_MS - 1;

function fakes() {
  const sent: { subject: string; text: string }[] = [];
  const env = {
    PLATFORM_DB: db,
    OA_ENV: "staging",
    ALERT_TO: "ops@example.test",
    ALERT_FROM: "alerts@example.test",
    ALERT_EMAIL: {
      send: async (m: { subject: string; text: string }) => {
        sent.push(m);
        return { messageId: "m" };
      },
    },
  } as unknown as ProvapiEnv;
  return { env, sent };
}

/** A ready self-serve signup; the defaults match the alert. */
const ready = (over: Record<string, string | number | null> = {}) => {
  const install_id = installId();
  return signup({
    source: "self-serve",
    owner_sub: "sub",
    status: "ready",
    install_id,
    updated_at: OLD,
    ...over,
  }).then(() => install_id);
};

describe("solo_start_missing", () => {
  it("fires for a ready self-serve row older than 30 minutes with no solo_start record", async () => {
    const id = await ready();
    const f = fakes();
    captureLogs(vi.spyOn);
    await soloStartMissingAlert(f.env, NOW);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.text).toContain(id);
    expect(f.sent[0]?.text).toContain("solo_start_missing");
  });

  it("is silent where the step recorded started or skipped (prod has no billing)", async () => {
    await ready({ solo_started_at: OLD });
    await ready({ solo_skipped_at: OLD });
    const f = fakes();
    await soloStartMissingAlert(f.env, NOW);
    expect(f.sent).toEqual([]);
  });

  it("is silent with zero signups", async () => {
    const f = fakes();
    await soloStartMissingAlert(f.env, NOW);
    await alertsTick(f.env, NOW).catch(() => {});
    expect(f.sent.filter((m) => m.text.includes("solo_start_missing"))).toEqual(
      [],
    );
  });

  it("is scoped: not admin, not recent, not unready, not test-hooks, not the operator's slugs", async () => {
    await ready({ source: "admin", owner_sub: null });
    await ready({ updated_at: NOW - SOLO_START_MS + 1000 });
    await ready({ status: "creating" });
    await ready({ status: "failed" });
    await ready({ test_hooks: 1 });
    for (const slug of ["leo", "rl-a", "rl-b"]) await ready({ slug });
    const f = fakes();
    await soloStartMissingAlert(f.env, NOW);
    expect(f.sent).toEqual([]);
    // one in scope among them
    const id = await ready({ slug: "customer" });
    await soloStartMissingAlert(f.env, NOW);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.text).toContain(id);
    expect(f.sent[0]?.text).toContain("1 self-serve install is");
  });

  it("emails at most once a day and gives the claim back on a failed send", async () => {
    await ready();
    const f = fakes();
    await soloStartMissingAlert(f.env, NOW);
    await soloStartMissingAlert(f.env, NOW + 60_000);
    expect(f.sent).toHaveLength(1);
    await soloStartMissingAlert(f.env, NOW + SOLO_ALERT_MS + 1);
    expect(f.sent).toHaveLength(2);

    const bad = fakes();
    (bad.env as { ALERT_EMAIL: unknown }).ALERT_EMAIL = {
      send: async () => {
        throw new Error("down");
      },
    };
    await db
      .prepare("DELETE FROM platform_state WHERE key = ?")
      .bind(SOLO_ALERT_KEY)
      .run();
    captureLogs(vi.spyOn);
    await soloStartMissingAlert(bad.env, NOW);
    const r = await db
      .prepare("SELECT value FROM platform_state WHERE key = ?")
      .bind(SOLO_ALERT_KEY)
      .first();
    expect(r).toBeNull();
  });

  it("alertsTick runs it", async () => {
    await ready();
    const f = fakes();
    captureLogs(vi.spyOn);
    await alertsTick(f.env, NOW);
    expect(f.sent.some((m) => m.text.includes("solo_start_missing"))).toBe(
      true,
    );
  });
});
