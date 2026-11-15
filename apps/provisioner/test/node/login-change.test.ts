// open-artifacts#2520 slice 3: the `update` kind's login variant. The
// provisioning Worker has written installs.vars; this job renders and
// redeploys that one install from them. Each install is made by
// ProvisionInstall first.
import { NAMESPACES } from "@oa/provision";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_PUBKEY } from "../../../../packages/provision/test/fixtures/release.js";
import { codeOf } from "../../src/errors.js";
import { runManage } from "../../src/manage.js";
import { strictVars } from "../../src/recheck.js";
import { runCreate } from "../../src/workflow.js";
import {
  ENV,
  event,
  seedCreate,
  seedJob,
  stepRunner,
  type World,
  world,
} from "./world.js";

vi.mock(
  "../../../../packages/provision/src/internal/gates.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../../packages/provision/src/internal/gates.js")
    >()),
    get RELEASE_PUBKEY() {
      return { staging: TEST_PUBKEY, prod: TEST_PUBKEY };
    },
  }),
);

let w: World;
beforeEach(async () => {
  w = await world();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

async function active(source: "admin" | "self-serve" = "admin") {
  const s = seedCreate(w, {
    slug: `l${Math.random().toString(36).slice(2, 8)}`,
    source,
    ...(source === "self-serve"
      ? {
          vars: { AUTH_PROVIDERS: "google", AUTH_DOMAINS: "", TIER: "trial" },
        }
      : {}),
  });
  await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step);
  expect(w.job(s.jobId)?.status).toBe("done");
  return s.installId;
}
const plain = (id: string, name: string) =>
  (
    w.fake
      .script(NAMESPACES[ENV], `oa-s-${id}`)
      ?.metadata.bindings.find((b: { name: string }) => b.name === name) as
      | { text?: string }
      | undefined
  )?.text;
/** What the provisioning Worker's write leaves: installs.vars changed. */
const setVars = (id: string, over: Record<string, string | null>) => {
  const v = JSON.parse(w.install(id)?.vars as string) as Record<string, string>;
  for (const [k, x] of Object.entries(over))
    if (x === null) delete v[k];
    else v[k] = x;
  w.db
    .prepare("UPDATE installs SET vars = ? WHERE id = ?")
    .run(JSON.stringify(v), id);
};
async function run(
  installId: string,
  o: {
    args?: Record<string, unknown>;
    actor?: "admin" | "system" | "token" | "user";
  } = {},
) {
  const id = seedJob(w, {
    kind: "update",
    installId,
    args: o.args ?? { login: true },
    actor: o.actor ?? "system",
  });
  const error = await runManage(
    w.ctx,
    event(id),
    stepRunner(w.clock).step,
  ).then(
    () => null,
    (x: unknown) => x as Error,
  );
  return { id, error, job: w.job(id) as Record<string, unknown> };
}

describe("update: login", () => {
  it("redeploys the install from installs.vars: member with its marker, one domain", async () => {
    const id = await active();
    setVars(id, {
      AUTH_DOMAINS: "acme.test",
      AUTH_DOMAIN_JOIN: "member",
      AUTH_DOMAIN_JOIN_SOURCE: "owner",
    });
    const r = await run(id);
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "done", step: "done" });
    expect(plain(id, "AUTH_DOMAINS")).toBe("acme.test");
    expect(plain(id, "AUTH_DOMAIN_JOIN")).toBe("member");
    expect(plain(id, "AUTH_DOMAIN_JOIN_SOURCE")).toBe("owner");
  });

  it("an invite change renders invite and no marker", async () => {
    const id = await active();
    setVars(id, { AUTH_DOMAINS: "acme.test", AUTH_DOMAIN_JOIN: "invite" });
    const r = await run(id);
    expect(r.job.status).toBe("done");
    expect(plain(id, "AUTH_DOMAIN_JOIN")).toBe("invite");
    expect(plain(id, "AUTH_DOMAIN_JOIN_SOURCE")).toBeUndefined();
  });

  it("touches only this install's row", async () => {
    const id = await active();
    const other = await active();
    const before = w.install(other)?.vars;
    setVars(id, { AUTH_DOMAINS: "acme.test" });
    await run(id);
    expect(w.install(other)?.vars).toBe(before);
    expect(plain(other, "AUTH_DOMAINS")).toBe("finqore.test");
  });

  it.each([
    ["a token actor", { actor: "token" as const }],
    ["an admin actor", { actor: "admin" as const }],
    ["a user actor", { actor: "user" as const }],
  ])("refuses a login job from %s", async (_n, o) => {
    const id = await active();
    setVars(id, { AUTH_DOMAINS: "acme.test" });
    const r = await run(id, o);
    expect(r.job.status).toBe("failed");
    expect(codeOf(r.error)).toBe("invalid_state");
    expect(plain(id, "AUTH_DOMAINS")).toBe("finqore.test");
  });

  it("refuses args beyond { login: true }", async () => {
    const id = await active();
    setVars(id, { AUTH_DOMAINS: "acme.test" });
    const r = await run(id, { args: { login: true, vars: { TIER: "free" } } });
    expect(r.job.status).toBe("failed");
    expect(plain(id, "AUTH_DOMAINS")).toBe("finqore.test");
  });

  it.each([
    ["member without the marker", { AUTH_DOMAIN_JOIN: "member" }],
    [
      "the marker without member",
      { AUTH_DOMAIN_JOIN: "invite", AUTH_DOMAIN_JOIN_SOURCE: "owner" },
    ],
    [
      "member over two domains",
      {
        AUTH_DOMAINS: "a.test,b.test",
        AUTH_DOMAIN_JOIN: "member",
        AUTH_DOMAIN_JOIN_SOURCE: "owner",
      },
    ],
    ["an unknown join value", { AUTH_DOMAIN_JOIN: "everyone" }],
    ["a non-domain", { AUTH_DOMAINS: "not a domain" }],
  ])("refuses vars a create would refuse: %s", async (_n, over) => {
    const id = await active();
    setVars(id, over);
    const r = await run(id);
    expect(r.job.status).toBe("failed");
    expect(codeOf(r.error)).toBe("invalid_state");
    expect(plain(id, "AUTH_DOMAINS")).toBe("finqore.test");
  });

  it("holds a self-serve install to the create schema: at most one domain", async () => {
    const id = await active("self-serve");
    setVars(id, { AUTH_DOMAINS: "a.test,b.test" });
    const r = await run(id);
    expect(r.job.status).toBe("failed");
    expect(codeOf(r.error)).toBe("invalid_state");
  });
});

describe("strictVars: a create never allows the login vars", () => {
  const opts = {
    source: "admin",
    selfServeTier: "trial",
    testHooks: false,
    env: "staging",
  } as const;
  const raw = (o: Record<string, string>) =>
    JSON.stringify({
      AUTH_PROVIDERS: "google",
      AUTH_DOMAINS: "acme.test",
      TIER: "team",
      ...o,
    });
  it("refuses AUTH_DOMAIN_JOIN and the marker in signups.vars", () => {
    expect(() =>
      strictVars(raw({ AUTH_DOMAIN_JOIN: "member" }), opts),
    ).toThrow();
    expect(() =>
      strictVars(raw({ AUTH_DOMAIN_JOIN_SOURCE: "owner" }), opts),
    ).toThrow();
  });
  it("a login change allows them, forced consistent", () => {
    expect(
      strictVars(
        raw({ AUTH_DOMAIN_JOIN: "member", AUTH_DOMAIN_JOIN_SOURCE: "owner" }),
        { ...opts, login: true },
      ),
    ).toMatchObject({
      AUTH_DOMAIN_JOIN: "member",
      AUTH_DOMAIN_JOIN_SOURCE: "owner",
    });
    expect(strictVars(raw({}), { ...opts, login: true })).toMatchObject({
      AUTH_DOMAIN_JOIN: "invite",
    });
  });
});
