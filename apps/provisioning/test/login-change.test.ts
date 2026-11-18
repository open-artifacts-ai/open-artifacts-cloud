import { keyId, publicFromPkcs8, signRequest } from "@oa/auth-core";
import { clearRegistryCache } from "@oa/broker-core";
import { beforeEach, describe, expect, it } from "vitest";
import type { BillingOperatorRpc } from "../src/env.js";
import {
  domainRefusal,
  LOGIN_CHANGE_ACTION,
  LOGIN_CHANGE_PATH,
  LOGIN_CHANGES_PER_DAY,
  loginChange,
} from "../src/routes/login-change.js";
import { db, fakeEnv, pkcs8, resetDb, seedInstall } from "./fakes.js";

// Open-artifacts#2520 slice 3: an instance's own login-domain change, the
// platform side. Requests are what dispatch's LoginGate forwards: the install
// in x-oa-gate-install, the body signed with an install registry key.

const KEY = pkcs8(31);
const OTHER_KEY = pkcs8(32);
const ORIGIN = "https://login.oa.internal";
const NOW = 1_800_000_000_000;

/** A fake registry: install id -> its Ed25519 public key, as the broker stores it. */
async function registry(keys: Record<string, string>) {
  const entries = new Map<string, unknown>();
  for (const [id, key] of Object.entries(keys)) {
    const x = await publicFromPkcs8(key);
    entries.set(`install:${id}`, {
      installId: id,
      origin: `https://${id}.example.test`,
      keys: [{ kid: await keyId(x), x }],
    });
  }
  return {
    get: async (k: string) => entries.get(k) ?? null,
  } as unknown as KVNamespace;
}

const billing = (
  tier: string | null = "team",
  status = "active",
): BillingOperatorRpc => ({
  setTier: async () => {
    throw new Error("not used");
  },
  tiersOf: async (ids) => ({
    ok: true,
    tiers: Object.fromEntries(ids.map((i) => [i, { tier, status }])),
  }),
});

let n = 0;
const nonce = () => `nonce-${String(++n).padStart(12, "0")}`;
const body = (o: Record<string, unknown> = {}) => ({
  ts: NOW,
  nonce: nonce(),
  ownerUserId: "u_owner1",
  hd: "acme.test",
  domains: ["acme.test"],
  autoJoin: false,
  ...o,
});

type Opts = {
  install: string;
  /** Sign with this key (default: the install's own). */
  key?: string;
  headers?: Record<string, string>;
  /** Replace the signed text (after signing). */
  tamper?: string;
  signPath?: string;
};

async function req(
  b: Record<string, unknown> | string,
  o: Opts,
): Promise<Request> {
  const text = typeof b === "string" ? b : JSON.stringify(b);
  const key = o.key ?? KEY;
  const kid = await keyId(await publicFromPkcs8(key));
  return new Request(`${ORIGIN}${LOGIN_CHANGE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oa-gate-install": o.install,
      "x-oa-kid": kid,
      "x-oa-sig": await signRequest(
        key,
        o.signPath ?? LOGIN_CHANGE_PATH,
        kid,
        text,
      ),
      ...o.headers,
    },
    body: o.tamper ?? text,
  });
}

const vars = (id: string) =>
  db
    .prepare("SELECT vars, row_version FROM installs WHERE id = ?1")
    .bind(id)
    .first<{ vars: string; row_version: number }>()
    .then((r) => ({
      vars: JSON.parse(r?.vars ?? "{}") as Record<string, string>,
      version: r?.row_version ?? -1,
    }));
const jobsOf = (id: string) =>
  db
    .prepare("SELECT * FROM jobs WHERE install_id = ?1")
    .bind(id)
    .all<Record<string, unknown>>()
    .then((r) => r.results);
const auditOf = (id: string) =>
  db
    .prepare("SELECT * FROM hosted_audit WHERE install_id = ?1 AND action = ?2")
    .bind(id, LOGIN_CHANGE_ACTION)
    .all<{ actor: string; detail: string }>()
    .then((r) => r.results);

const BASE = {
  AUTH_PROVIDERS: "google",
  AUTH_DOMAINS: "",
  TIER: "team",
  AUTH_DOMAIN_JOIN: "invite",
  OAUTH_STORE: "d1",
};

let id: string;
let otherId: string;
async function world(
  o: {
    vars?: Record<string, string>;
    lifecycle?: Record<string, unknown>;
    state?: "active" | "deleting";
    on?: boolean;
    slugs?: string;
    bill?: BillingOperatorRpc | undefined;
    unbound?: boolean;
  } = {},
) {
  const seeded = await seedInstall({
    vars: o.vars ?? BASE,
    lifecycle: o.lifecycle,
    state: o.state,
  });
  id = seeded.id;
  const other = await seedInstall({ vars: BASE });
  otherId = other.id;
  const f = fakeEnv({
    LOGIN_CHANGE: o.on === false ? "0" : "1",
    ...(o.slugs === undefined ? {} : { LOGIN_CHANGE_SLUGS: o.slugs }),
    BROKER_REGISTRY: o.unbound
      ? undefined
      : await registry({ [id]: KEY, [otherId]: OTHER_KEY }),
    BILLING: "bill" in o ? o.bill : billing(),
  });
  return f;
}
const call = (r: Request, e: ReturnType<typeof fakeEnv>["env"], now = NOW) =>
  loginChange(r, e, now);
const err = async (r: Response) => ({
  status: r.status,
  ...((await r.json().catch(() => ({}))) as object),
});

beforeEach(async () => {
  await resetDb();
  clearRegistryCache();
});

describe("the route is off or not for the internet", () => {
  it("is the plain 404 when LOGIN_CHANGE is not 1", async () => {
    const { env } = await world({ on: false });
    const r = await call(await req(body(), { install: id }), env);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("Not found");
    expect((await vars(id)).vars.AUTH_DOMAINS).toBe("");
    expect(await jobsOf(id)).toHaveLength(0);
  });

  it("is the plain 404 for an internet request (cf-connecting-ip)", async () => {
    const { env } = await world();
    const r = await call(
      await req(body(), {
        install: id,
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
      env,
    );
    expect(r.status).toBe(404);
    expect(await jobsOf(id)).toHaveLength(0);
  });

  it("404s without the gate's install header, on another path or method", async () => {
    const { env } = await world();
    const noInstall = await req(body(), { install: id });
    noInstall.headers.delete("x-oa-gate-install");
    expect((await call(noInstall, env)).status).toBe(404);
    const get = new Request(`${ORIGIN}${LOGIN_CHANGE_PATH}`, {
      headers: { "x-oa-gate-install": id },
    });
    expect((await call(get, env)).status).toBe(404);
    const other = new Request(`${ORIGIN}/elsewhere`, {
      method: "POST",
      headers: { "x-oa-gate-install": id },
    });
    expect((await call(other, env)).status).toBe(404);
  });
});

describe("LOGIN_CHANGE_SLUGS: on for the listed installs only (#2520 rollout)", () => {
  const slugOf = (x: string) =>
    db
      .prepare("SELECT slug FROM installs WHERE id = ?1")
      .bind(x)
      .first<{ slug: string }>()
      .then((r) => r?.slug ?? "");
  const nonces = (x: string) =>
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM login_change_nonces WHERE install_id = ?1",
      )
      .bind(x)
      .first<{ n: number }>()
      .then((r) => r?.n ?? 0);

  it("with LOGIN_CHANGE off, a listed install's change is accepted", async () => {
    const { env } = await world({ on: false });
    env.LOGIN_CHANGE_SLUGS = ` nobody , ${await slugOf(id)} `;
    const r = await call(await req(body(), { install: id }), env);
    expect(await err(r)).toEqual({ status: 202, ok: true, applying: true });
    expect((await vars(id)).vars.AUTH_DOMAINS).toBe("acme.test");
    expect(await jobsOf(id)).toHaveLength(1);
  });

  it("an install not listed is the plain 404, before any nonce is kept", async () => {
    const { env } = await world({ on: false });
    env.LOGIN_CHANGE_SLUGS = await slugOf(otherId);
    const r = await call(await req(body(), { install: id }), env);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("Not found");
    expect(await nonces(id)).toBe(0);
    expect((await vars(id)).vars.AUTH_DOMAINS).toBe("");
    expect(await jobsOf(id)).toHaveLength(0);
  });

  it("an empty or blank list is off; a slug is matched exactly, never as a prefix", async () => {
    for (const slugs of ["", " , ", "x"]) {
      const { env } = await world({ on: false, slugs });
      if (slugs === "x")
        env.LOGIN_CHANGE_SLUGS = (await slugOf(id)).slice(0, -1);
      const r = await call(await req(body(), { install: id }), env);
      expect(r.status, JSON.stringify(slugs)).toBe(404);
      expect(await jobsOf(id)).toHaveLength(0);
      await resetDb();
      clearRegistryCache();
    }
  });

  it("with LOGIN_CHANGE on, the list doesn't narrow it", async () => {
    const { env } = await world({ slugs: "nobody" });
    const r = await call(await req(body(), { install: id }), env);
    expect(r.status).toBe(202);
  });
});

describe("signature", () => {
  it("refuses another install's key (kid not in the gate install's entry)", async () => {
    const { env } = await world();
    const r = await call(
      await req(body(), { install: id, key: OTHER_KEY }),
      env,
    );
    expect(await err(r)).toEqual({ status: 401, error: "bad_signature" });
    expect(await jobsOf(id)).toHaveLength(0);
    expect((await vars(id)).vars.AUTH_DOMAINS).toBe("");
  });

  it("refuses a signature over another path, a tampered body, or no signature", async () => {
    const { env } = await world();
    expect(
      (await call(await req(body(), { install: id, signPath: "/tier" }), env))
        .status,
    ).toBe(401);
    expect(
      (
        await call(
          await req(body(), {
            install: id,
            tamper: JSON.stringify(
              body({ domains: ["evil.test"], hd: "evil.test" }),
            ),
          }),
          env,
        )
      ).status,
    ).toBe(401);
    const unsigned = await req(body(), { install: id });
    unsigned.headers.delete("x-oa-sig");
    expect((await call(unsigned, env)).status).toBe(401);
    expect(await jobsOf(id)).toHaveLength(0);
  });

  it("refuses an install the registry doesn't know, and a stale ts", async () => {
    const { env } = await world();
    const ghost = await seedInstall({ vars: BASE });
    expect(
      (await call(await req(body(), { install: ghost.id }), env)).status,
    ).toBe(401);
    expect(
      (await call(await req(body({ ts: NOW - 61_000 }), { install: id }), env))
        .status,
    ).toBe(401);
    expect(
      (await call(await req(body({ ts: NOW + 61_000 }), { install: id }), env))
        .status,
    ).toBe(401);
  });

  it("answers 503 when the registry is not bound", async () => {
    const { env } = await world({ unbound: true });
    const r = await call(await req(body(), { install: id }), env);
    expect(await err(r)).toEqual({ status: 503, error: "unavailable" });
  });
});

describe("body", () => {
  it.each([
    ["an extra field", { extra: 1 }],
    ["an install field", { install: "iabc123def45" }],
  ])("refuses %s", async (_n, extra) => {
    const { env } = await world();
    const r = await call(await req(body(extra), { install: id }), env);
    expect(await err(r)).toEqual({ status: 400, error: "bad_body" });
    expect(await jobsOf(id)).toHaveLength(0);
  });

  it.each([
    ["a missing hd", (b: Record<string, unknown>) => delete b.hd],
    ["a missing nonce", (b: Record<string, unknown>) => delete b.nonce],
    [
      "a non-boolean autoJoin",
      (b: Record<string, unknown>) => (b.autoJoin = "yes"),
    ],
    ["non-string domains", (b: Record<string, unknown>) => (b.domains = [1])],
    [
      "an hd that is not a hostname",
      (b: Record<string, unknown>) => (b.hd = "Acme.TEST; DROP"),
    ],
    [
      "an ownerUserId with odd characters",
      (b: Record<string, unknown>) => (b.ownerUserId = "u 1<script>"),
    ],
    [
      "an empty ownerUserId",
      (b: Record<string, unknown>) => (b.ownerUserId = ""),
    ],
    [
      "an ownerUserId over 64 characters",
      (b: Record<string, unknown>) => (b.ownerUserId = "u".repeat(65)),
    ],
    ["a short nonce", (b: Record<string, unknown>) => (b.nonce = "abc")],
  ])("refuses %s", async (_n, mutate) => {
    const { env } = await world();
    const b = body();
    mutate(b);
    expect((await call(await req(b, { install: id }), env)).status).toBe(400);
    expect(await jobsOf(id)).toHaveLength(0);
  });

  it("refuses a body that is not JSON or not an object", async () => {
    const { env } = await world();
    expect((await call(await req("nope", { install: id }), env)).status).toBe(
      400,
    );
    expect((await call(await req("[]", { install: id }), env)).status).toBe(
      400,
    );
  });
});

describe("hd", () => {
  it("an empty hd (a Gmail owner) clears the list but proves no domain", async () => {
    const { env } = await world({
      vars: { ...BASE, AUTH_DOMAINS: "ops.test" },
    });
    const clear = await call(
      await req(body({ hd: "", domains: [] }), { install: id }),
      env,
    );
    expect(clear.status).toBe(202);
    // An empty list with autoJoin false clears operator-set domains.
    expect((await vars(id)).vars.AUTH_DOMAINS).toBeUndefined();
  });

  it("an empty hd cannot prove a domain", async () => {
    const { env } = await world();
    const r = await call(
      await req(body({ hd: "", domains: ["acme.test"] }), { install: id }),
      env,
    );
    expect(await err(r)).toEqual({ status: 403, error: "domain_unproven" });
  });
});

describe("accepted change", () => {
  it("writes the vars, one queued update job, its workflow and the audit row", async () => {
    const { env, manageInstall } = await world();
    const before = await vars(id);
    const r = await call(await req(body(), { install: id }), env);
    expect(await err(r)).toEqual({ status: 202, ok: true, applying: true });
    const after = await vars(id);
    // Exactly the two vars (and no marker) change; the rest stays.
    expect(after.vars).toEqual({
      ...BASE,
      AUTH_DOMAINS: "acme.test",
      AUTH_DOMAIN_JOIN: "invite",
    });
    expect(after.vars.OAUTH_STORE).toBe("d1");
    expect(after.version).toBe(before.version + 1);
    const jobs = await jobsOf(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "update",
      workflow: "manage_install",
      actor_kind: "system",
      status: "queued",
      args: '{"login":true}',
    });
    expect(manageInstall.created).toEqual([
      { id: jobs[0]?.id, params: { jobId: jobs[0]?.id } },
    ]);
    const audit = await auditOf(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe("system:login-change");
    const d = JSON.parse(audit[0]?.detail ?? "{}");
    expect(d).toMatchObject({
      before: { domains: [], join: "invite" },
      after: { domains: ["acme.test"], join: "invite" },
      ownerUserId: "u_owner1",
      hd: "acme.test",
      jobId: jobs[0]?.id,
    });
    expect(d.kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
    // Another install is untouched.
    expect((await vars(otherId)).vars.AUTH_DOMAINS).toBe("");
    expect(await jobsOf(otherId)).toHaveLength(0);
  });

  it("leaves the job queued when the workflow won't start", async () => {
    const { env, manageInstall } = await world();
    manageInstall.failNextCreate(new Error("down"));
    const r = await call(await req(body(), { install: id }), env);
    expect(r.status).toBe(202);
    expect(await jobsOf(id)).toHaveLength(1);
  });

  it("replaces the list: sorted, unique, and an empty list clears it", async () => {
    const { env } = await world({
      vars: { ...BASE, AUTH_DOMAINS: "old.test" },
    });
    const b = body({ hd: "b.test", domains: ["b.test", "b.test"] });
    expect((await call(await req(b, { install: id }), env)).status).toBe(202);
    expect((await vars(id)).vars.AUTH_DOMAINS).toBe("b.test");
  });

  it("clears the domains with an empty list", async () => {
    const { env } = await world({
      vars: { ...BASE, AUTH_DOMAINS: "acme.test" },
    });
    const r = await call(
      await req(body({ domains: [] }), { install: id }),
      env,
    );
    expect(r.status).toBe(202);
    expect((await vars(id)).vars.AUTH_DOMAINS).toBeUndefined();
  });
});

describe("marker semantics", () => {
  it("autoJoin writes member and the owner marker", async () => {
    const { env } = await world();
    const r = await call(
      await req(body({ autoJoin: true }), { install: id }),
      env,
    );
    expect(r.status).toBe(202);
    const v = (await vars(id)).vars;
    expect(v.AUTH_DOMAIN_JOIN).toBe("member");
    expect(v.AUTH_DOMAIN_JOIN_SOURCE).toBe("owner");
    expect(v.AUTH_DOMAINS).toBe("acme.test");
    const d = JSON.parse((await auditOf(id))[0]?.detail ?? "{}");
    expect(d.after).toEqual({ domains: ["acme.test"], join: "member" });
  });

  it("turning autoJoin off writes invite and drops the marker", async () => {
    const { env } = await world({
      vars: {
        ...BASE,
        AUTH_DOMAINS: "acme.test",
        AUTH_DOMAIN_JOIN: "member",
        AUTH_DOMAIN_JOIN_SOURCE: "owner",
      },
    });
    const r = await call(await req(body(), { install: id }), env);
    expect(r.status).toBe(202);
    const v = (await vars(id)).vars;
    expect(v.AUTH_DOMAIN_JOIN).toBe("invite");
    expect(v.AUTH_DOMAIN_JOIN_SOURCE).toBeUndefined();
  });

  it("an operator-typed domain has no marker and stays invite", async () => {
    // Seeded as an operator's create would leave it.
    const { env } = await world({
      vars: { ...BASE, AUTH_DOMAINS: "ops.test" },
    });
    const r = await call(
      await req(body({ hd: "acme.test", domains: ["acme.test"] }), {
        install: id,
      }),
      env,
    );
    expect(r.status).toBe(202);
    const v = (await vars(id)).vars;
    expect(v.AUTH_DOMAIN_JOIN).toBe("invite");
    expect(v.AUTH_DOMAIN_JOIN_SOURCE).toBeUndefined();
  });

  it("autoJoin needs exactly one domain: none or two is refused", async () => {
    const { env } = await world();
    const none = await call(
      await req(body({ autoJoin: true, domains: [] }), { install: id }),
      env,
    );
    expect(await err(none)).toEqual({
      status: 422,
      error: "auto_join_needs_one_domain",
    });
    const two = await call(
      await req(body({ autoJoin: true, domains: ["acme.test", "b.test"] }), {
        install: id,
      }),
      env,
    );
    // hd is one domain, so two is unproven first; either way nothing is written.
    expect(two.status).toBeGreaterThanOrEqual(400);
    expect(await jobsOf(id)).toHaveLength(0);
  });
});

describe("refusals", () => {
  const expectRefused = async (
    o: Parameters<typeof world>[0],
    b: Record<string, unknown>,
    want: { status: number; error: string },
  ) => {
    const { env } = await world(o);
    const before = await vars(id);
    const r = await call(await req(b, { install: id }), env);
    expect(await err(r)).toEqual(want);
    expect(await vars(id)).toEqual(before);
    expect(await jobsOf(id)).toHaveLength(0);
    expect(await auditOf(id)).toHaveLength(0);
  };

  it("needs Google in AUTH_PROVIDERS", async () => {
    await expectRefused(
      { vars: { ...BASE, AUTH_PROVIDERS: "email" } },
      body(),
      { status: 403, error: "google_required" },
    );
  });

  it("is refused while EMAIL_CODE_DOMAIN is on", async () => {
    await expectRefused(
      { vars: { ...BASE, EMAIL_CODE_DOMAIN: "on" } },
      body(),
      { status: 403, error: "email_codes_on" },
    );
  });

  it.each(["solo", "trial", "free"])(
    "needs Team or Business, not %s",
    async (t) => {
      await expectRefused({ bill: billing(t) }, body(), {
        status: 403,
        error: "plan_required",
      });
    },
  );

  it("needs a live subscription", async () => {
    await expectRefused({ bill: billing("team", "lapsed") }, body(), {
      status: 403,
      error: "plan_required",
    });
  });

  it("an install created Team with no billing row passes as Team", async () => {
    const noRow: BillingOperatorRpc = {
      setTier: async () => {
        throw new Error("not used");
      },
      tiersOf: async (ids) => ({
        ok: true,
        tiers: Object.fromEntries(
          ids.map((i) => [i, { tier: "solo", status: "active", noRow: true }]),
        ),
      }),
    };
    const { env } = await world({ bill: noRow });
    const r = await call(await req(body(), { install: id }), env);
    expect(r.status).toBe(202);
  });

  it("a real Solo row on an install created Team is still refused", async () => {
    // billing("solo") has no noRow: the owner's own Solo, not the default.
    await expectRefused({ bill: billing("solo") }, body(), {
      status: 403,
      error: "plan_required",
    });
  });

  it("answers 503 when billing can't say", async () => {
    await expectRefused({ bill: undefined }, body(), {
      status: 503,
      error: "unavailable",
    });
  });

  it("needs the install active and serving", async () => {
    await expectRefused({ lifecycle: { serving_mode: "paused" } }, body(), {
      status: 403,
      error: "install_not_serving",
    });
    await expectRefused({ lifecycle: { suspended_at: 5 } }, body(), {
      status: 403,
      error: "install_not_serving",
    });
    await expectRefused({ state: "deleting" }, body(), {
      status: 403,
      error: "install_not_serving",
    });
  });

  it.each([
    ["an uppercase name", "ACME.test"],
    ["a single label", "localhost"],
    ["a public mail provider", "gmail.com"],
    ["another public mail provider", "outlook.com"],
    ["a public suffix", "co.uk"],
    ["a hosted suffix", "github.io"],
    ["the platform's own domain", "hosted.test"],
    ["a name with a path", "acme.test/x"],
    ["a trailing dot", "acme.test."],
  ])("refuses %s", async (_n, d) => {
    await expectRefused({}, body({ domains: [d] }), {
      status: 422,
      error: "bad_domain",
    });
  });

  it("refuses more than 5 domains", async () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((x) => `${x}.test`);
    await expectRefused({}, body({ domains: six, hd: "a.test" }), {
      status: 422,
      error: "too_many_domains",
    });
  });

  it("refuses a domain that isn't the owner's hd", async () => {
    await expectRefused(
      {},
      body({ domains: ["other.test"], hd: "acme.test" }),
      {
        status: 403,
        error: "domain_unproven",
      },
    );
  });

  it("refuses what a create would: a self-serve install has at most one domain", async () => {
    const { env } = await world({ lifecycle: { source: "self-serve" } });
    // TIER team != SELF_SERVE_TIER trial: a self-serve create would refuse it.
    const r = await call(await req(body(), { install: id }), env);
    expect(await err(r)).toEqual({ status: 422, error: "vars_refused" });
    expect(await jobsOf(id)).toHaveLength(0);
  });

  it("answers 409 no_vars for an install created before stored vars", async () => {
    const { env } = await world();
    await db
      .prepare("UPDATE installs SET vars = NULL WHERE id = ?1")
      .bind(id)
      .run();
    const r = await call(await req(body(), { install: id }), env);
    expect(await err(r)).toEqual({ status: 409, error: "no_vars" });
  });
});

describe("replay, concurrency, rate", () => {
  it("a replayed nonce is 409 and never applies again", async () => {
    const { env, manageInstall } = await world();
    const b = body();
    const first = await call(await req(b, { install: id }), env);
    expect(first.status).toBe(202);
    // The change finished (the job is done), then the same signed body returns.
    await db
      .prepare("UPDATE jobs SET status = 'done' WHERE install_id = ?1")
      .bind(id)
      .run();
    await db
      .prepare("UPDATE installs SET vars = ?2 WHERE id = ?1")
      .bind(id, JSON.stringify({ ...BASE, AUTH_DOMAINS: "later.test" }))
      .run();
    const again = await call(await req(b, { install: id }), env);
    expect(await err(again)).toEqual({ status: 409, error: "replay" });
    expect((await vars(id)).vars.AUTH_DOMAINS).toBe("later.test");
    expect(await jobsOf(id)).toHaveLength(1);
    expect(await auditOf(id)).toHaveLength(1);
    expect(manageInstall.created).toHaveLength(1);
  });

  it("nonces are per install", async () => {
    const { env } = await world();
    const b = body();
    expect((await call(await req(b, { install: id }), env)).status).toBe(202);
    // The same nonce from the other install is its own.
    const o = await call(
      await req(b, { install: otherId, key: OTHER_KEY }),
      env,
    );
    expect(o.status).toBe(202);
  });

  it("one change in flight: apply_pending", async () => {
    const { env } = await world();
    expect((await call(await req(body(), { install: id }), env)).status).toBe(
      202,
    );
    const second = await call(
      await req(body({ domains: [], autoJoin: false }), { install: id }),
      env,
    );
    expect(await err(second)).toEqual({ status: 409, error: "apply_pending" });
    expect(await jobsOf(id)).toHaveLength(1);
    expect((await vars(id)).vars.AUTH_DOMAINS).toBe("acme.test");
  });

  it("any open job on the install is apply_pending", async () => {
    const { env } = await world();
    await db
      .prepare(
        "INSERT INTO jobs (id, kind, workflow, install_id, actor_kind, actor_key, actor_label, request_id, body_hash, args, status, created_at, updated_at) VALUES ('01JEOPENJOB0000000000000A', 'upgrade', 'manage_install', ?1, 'admin', 'admin:x', 'admin', 'r1', 'h', '{}', 'running', 1, 1)",
      )
      .bind(id)
      .run();
    const r = await call(await req(body(), { install: id }), env);
    expect(await err(r)).toEqual({ status: 409, error: "apply_pending" });
  });

  it("loses a compare-and-set race: 409 apply_pending, nothing written", async () => {
    const { env } = await world();
    let batches = 0;
    const racing = {
      prepare: (s: string) => db.prepare(s),
      batch: async (s: D1PreparedStatement[]) => {
        // The nonce batch is the first; the write is the second. The install's
        // row changes between the read and the write.
        if (++batches === 2)
          await db
            .prepare(
              "UPDATE installs SET updated_at = updated_at + 1 WHERE id = ?1",
            )
            .bind(id)
            .run();
        return db.batch(s);
      },
    } as unknown as D1Database;
    const r = await call(await req(body(), { install: id }), {
      ...env,
      PLATFORM_DB: racing,
    });
    expect(await err(r)).toEqual({ status: 409, error: "apply_pending" });
    expect((await vars(id)).vars.AUTH_DOMAINS).toBe("");
    expect(await jobsOf(id)).toHaveLength(0);
    expect(await auditOf(id)).toHaveLength(0);
  });

  it(`accepts at most ${LOGIN_CHANGES_PER_DAY} changes per install per day`, async () => {
    const { env } = await world();
    for (let i = 0; i < LOGIN_CHANGES_PER_DAY; i++)
      await db
        .prepare(
          "INSERT INTO hosted_audit (at, actor, install_id, action, detail) VALUES (?1, 'system:login-change', ?2, ?3, '{}')",
        )
        .bind(NOW - 1000 * (i + 1), id, LOGIN_CHANGE_ACTION)
        .run();
    const r = await call(await req(body(), { install: id }), env);
    expect(await err(r)).toEqual({ status: 429, error: "rate_limited" });
    expect(await jobsOf(id)).toHaveLength(0);
    // A day later the window is clear.
    const later = await call(
      await req(body({ ts: NOW + 86_400_000 + 5000 }), { install: id }),
      env,
      NOW + 86_400_000 + 5000,
    );
    expect(later.status).toBe(202);
  });
});

describe("domainRefusal", () => {
  it("accepts a company domain and refuses the rest", () => {
    expect(domainRefusal("acme.test")).toBeNull();
    expect(domainRefusal("eng.acme.co.uk")).toBeNull();
    expect(domainRefusal("co.uk")).not.toBeNull();
    expect(domainRefusal("yahoo.com")).not.toBeNull();
    expect(domainRefusal("a.hosted.test", "hosted.test")).not.toBeNull();
  });
});
