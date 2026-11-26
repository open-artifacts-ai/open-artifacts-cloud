import { TEST_MEMBER } from "@oa/provisioning-contract";
import { describe, expect, it } from "vitest";
import { Run } from "../src/provisioning.ts";
import {
  RL_AGENTS_APP,
  RL_AGENTS_SLUG,
  type RlAgentsOutcome,
  rlAgentsLine,
  upgradeRlAgents,
} from "../src/rl-agents.ts";
import { CONFIG, type FakeApi, fakeApi } from "./provisioning-fake.ts";

// Cloud #264, public #3167: each gate run asks once for rl-agents on the
// release under test (R5) and takes the 202 as the answer. It never waits for
// the job, touches no other install, and never throws.

const AGENTS = "iagentsaaaaa";

function setup(o: { version?: string; activeJobId?: string | null } = {}): {
  f: FakeApi;
  bodies: { url: string; body: unknown }[];
  run: Run;
} {
  const f = fakeApi();
  const a = f.installs.get(CONFIG.rlA.id);
  if (!a) throw new Error("no rl-a in the fake");
  f.installs.set(AGENTS, {
    ...a,
    id: AGENTS,
    slug: "rl-agents",
    appHost: "rl-agents.open-artifacts-staging.app",
    contentHost: "rl-agents.open-artifacts-staging.page",
    version: o.version ?? "0.81.0",
    activeJobId: o.activeJobId ?? null,
  });
  const bodies: { url: string; body: unknown }[] = [];
  const run = new Run(CONFIG, {
    ...f.io,
    fetch: async (u, i) => {
      if (i?.body)
        bodies.push({ url: String(u), body: JSON.parse(String(i.body)) });
      return f.io.fetch(u, i);
    },
    // A wait would be a poll: none is allowed.
    wait: () => {
      throw new Error("waited");
    },
  });
  return { f, bodies, run };
}

const writes = (f: FakeApi) => f.log.filter((l) => l.startsWith("POST "));

describe("upgradeRlAgents", () => {
  it("is the test member's install, by its exact slug", () => {
    expect(RL_AGENTS_SLUG).toBe("rl-agents");
    expect(RL_AGENTS_SLUG).toBe(TEST_MEMBER.slug);
    expect(RL_AGENTS_APP).toBe("https://rl-agents.open-artifacts-staging.app");
  });

  it("behind: one R5 on rl-agents only, to the tag under test, and the 202 is the answer", async () => {
    const { f, bodies, run } = setup();
    const before = {
      a: f.installs.get(CONFIG.rlA.id)?.version,
      b: f.installs.get(CONFIG.rlB.id)?.version,
    };
    const o = await upgradeRlAgents(run);
    expect(o).toMatchObject({ kind: "started", from: "0.81.0", to: "0.82.0" });
    expect(o.kind === "started" && o.jobId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(writes(f)).toEqual([
      `POST ${CONFIG.api}/v1/installs/${AGENTS}/upgrade`,
    ]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.body).toEqual({
      requestId: run.rid("up-rl-agents"),
      version: CONFIG.version,
      nonAdditive: true,
    });
    // Never a job read: the job is not awaited.
    expect(f.log.some((l) => /\/jobs\//.test(l))).toBe(false);
    expect(f.installs.get(CONFIG.rlA.id)?.version).toBe(before.a);
    expect(f.installs.get(CONFIG.rlB.id)?.version).toBe(before.b);
  });

  it("current: no write", async () => {
    const { f, run } = setup({ version: CONFIG.version });
    expect(await upgradeRlAgents(run)).toEqual({
      kind: "current",
      to: CONFIG.version,
    });
    expect(writes(f)).toEqual([]);
  });

  it("busy or newer: skipped, no write", async () => {
    const busy = setup({ activeJobId: "jbusy" });
    expect((await upgradeRlAgents(busy.run)).kind).toBe("skipped");
    expect(writes(busy.f)).toEqual([]);
    const newer = setup({ version: "0.90.0" });
    expect(await upgradeRlAgents(newer.run)).toMatchObject({
      kind: "skipped",
      reason: "rl-agents runs 0.90.0, newer",
    });
    expect(writes(newer.f)).toEqual([]);
  });

  it("no rl-agents: skipped, no write", async () => {
    const { f, run } = setup();
    f.installs.delete(AGENTS);
    expect(await upgradeRlAgents(run)).toMatchObject({ kind: "skipped" });
    expect(writes(f)).toEqual([]);
  });

  it("a refused R5 is an outcome, never a throw", async () => {
    const { f } = setup();
    const run = new Run(CONFIG, {
      ...f.io,
      fetch: async (u, i) =>
        String(u).endsWith("/upgrade")
          ? new Response(
              JSON.stringify({ error: { code: "job_in_progress" } }),
              { status: 409 },
            )
          : f.io.fetch(u, i),
    });
    const o = await upgradeRlAgents(run);
    expect(o.kind).toBe("failed");
    expect(o.kind === "failed" && o.reason).toContain("status 409");
  });

  it("a network error is an outcome, never a throw", async () => {
    const { f } = setup();
    const run = new Run(CONFIG, {
      ...f.io,
      fetch: async () => {
        throw new Error("boom");
      },
    });
    expect(await upgradeRlAgents(run)).toMatchObject({ kind: "failed" });
  });

  it("staging only: any other API origin sends nothing", async () => {
    const { f } = setup();
    let sent = 0;
    const run = new Run(
      { ...CONFIG, api: "https://api.open-artifacts.app" },
      {
        ...f.io,
        fetch: async (u, i) => {
          sent++;
          return f.io.fetch(u, i);
        },
      },
    );
    expect(await upgradeRlAgents(run)).toMatchObject({
      kind: "failed",
      reason: "the rl-agents upgrade runs on staging only",
    });
    expect(sent).toBe(0);
  });
});

describe("rlAgentsLine", () => {
  // The report step's check (redline-staging.yml): plain characters only.
  const PLAIN = /^[A-Za-z0-9 .,:;()#_+/=@-]{1,400}$/;
  const all: RlAgentsOutcome[] = [
    { kind: "started", from: "0.145.0", to: "0.250.0", jobId: "j01ABC" },
    { kind: "started", from: null, to: "0.250.0", jobId: "j01ABC" },
    { kind: "current", to: "0.250.0" },
    { kind: "skipped", to: "0.250.0", reason: "rl-agents has a job running" },
    { kind: "failed", to: "0.250.0", reason: "R5: status 409, code x" },
  ];
  it("every outcome is one plain line naming rl-agents' address", () => {
    for (const o of all) {
      const l = rlAgentsLine(o, RL_AGENTS_APP);
      expect(l).toMatch(PLAIN);
      expect(l).toContain(RL_AGENTS_APP);
    }
  });
});
