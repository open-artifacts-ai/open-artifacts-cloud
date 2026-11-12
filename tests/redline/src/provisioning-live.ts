import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { STAGING_TEST_DOMAIN } from "@oa/provision/names";
import type { InstallDetail } from "@oa/provisioning-contract";
import {
  claimHookSlot,
  HookBudgetError,
} from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";
import {
  BusError,
  busState,
  connectRequest,
  mintMachine,
  openBusSocket,
  revokeMachines,
} from "./bus.ts";
import { boundFetch, InfraError } from "./fetch-timeout.ts";
import {
  BUS_AGENTS,
  BUS_B,
  BUS_PAIR_SIDES_FILE,
  type BusPair,
  busPairSides,
  type PairSide,
  writeBusPair,
  writeBusPairError,
} from "./hosted-bus.ts";
import { hookReason } from "./http.ts";
import {
  AUDIENCES,
  type AudienceKey,
  jwtSource,
  mask,
  OIDC_FILES,
  writeSecretFile,
} from "./oidc.ts";
import {
  type BusIo,
  bringUpgrade,
  type CredsOut,
  desc,
  mintCreds,
  oidcCreate,
  ownDetail,
  POLL_MS,
  ProbeFail,
  type ProvIo,
  provConfig,
  Run,
  revokeCreds,
  stagedVersion,
} from "./provisioning.ts";
import { gitSchemaOf } from "./schema.ts";
import { newRecipient, openSealed, parseCreds } from "./seal.ts";
import { readSecretFile, secretFileName } from "./targets.ts";
import { holdSocket } from "./ws.ts";

// The live wiring of src/provisioning.ts: real fetch (bounded), the wall
// clock, and the OIDC JWT files in secretsDir. Used by the live suite
// (live/provisioning.test.ts) and the workflow's bring-up and revoke steps
// (scripts/provisioning.ts).

export interface RawTargets {
  secretsDir: string;
  a: { name: string; installId: string; app: string };
  b: { name: string; installId: string; app: string };
}

/**
 * Where a side's R26 cred lives: the suite's own path (targets.ts reads
 * <secretsDir>/REDLINE_<NAME>_<KIND> for the target's name, rl-a not a).
 */
export const credFile = (
  t: RawTargets,
  k: "a" | "b",
  kind: "PAT" | "HOOK_KEY",
): string => join(t.secretsDir, secretFileName(t[k].name, kind));

/** The ids and origins of rl-a and rl-b, and secretsDir, from REDLINE_TARGETS. */
export function rawTargets(json: string | undefined): RawTargets {
  if (!json) throw new Error("REDLINE_TARGETS is not set");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("REDLINE_TARGETS is not JSON");
  }
  const side = (k: "a" | "b") => {
    const v = raw[k] as
      | { name?: unknown; installId?: unknown; app?: unknown }
      | undefined;
    if (
      typeof v?.name !== "string" ||
      v.name === "" ||
      typeof v.installId !== "string" ||
      typeof v.app !== "string"
    )
      throw new Error(
        `REDLINE_TARGETS: ${k}.name, ${k}.installId and ${k}.app are required`,
      );
    return { name: v.name, installId: v.installId, app: new URL(v.app).origin };
  };
  if (typeof raw.secretsDir !== "string" || !raw.secretsDir)
    throw new Error("REDLINE_TARGETS: secretsDir is required");
  return { secretsDir: raw.secretsDir, a: side("a"), b: side("b") };
}

const out = (s: string) => process.stdout.write(s);

export { mask };

const SESSION_COOKIE = "__Host-oa_session";

/**
 * The live bus seam of P51 (src/provisioning.ts BusIo): on rl-l, with the
 * creds R26 sealed for it. The session is the suite's admin test user's
 * (POST /__test/session with rl-l's hook key), the machine the device flow's
 * (approved in the browser form by that session), the socket a real
 * GET /bus/connect held open. No token is ever put in a message.
 */
export function liveBusIo(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = boundFetch(globalThis.fetch),
): BusIo {
  const m = mask(env);
  return {
    async open({ app, pat, hookKey }) {
      const site = { app, fetch: fetchImpl };
      if ((await busState(site, pat)) === "off") return "off";
      // Single-shot, on purpose: this call is outside the hook ledger and
      // transportFetch's paced retry, so a retry would spend an RL_ANON slot
      // nothing counts (#155).
      const res = await fetchImpl(`${app}/__test/session`, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${hookKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: `redline-admin@${STAGING_TEST_DOMAIN}`,
          role: "admin",
        }),
      });
      const j = (await res.json().catch(() => null)) as {
        cookie?: unknown;
      } | null;
      if (res.status !== 200 || typeof j?.cookie !== "string")
        throw new ProbeFail(`P51: rl-l's session hook answered ${res.status}`);
      m(j.cookie);
      const label = `redline-p51-${Date.now().toString(36)}`;
      const token = await mintMachine(
        site,
        `${SESSION_COOKIE}=${j.cookie}`,
        label,
      ).catch((e) => {
        throw new ProbeFail(
          e instanceof BusError ? `P51: ${e.message}` : "P51: no machine token",
        );
      });
      m(token);
      const held = await openBusSocket(app, token).catch((e) => {
        throw new ProbeFail(
          e instanceof BusError ? `P51: ${e.message}` : "P51: no bus socket",
        );
      });
      if (held.status !== 101)
        throw new ProbeFail(
          `P51: before the suspend, rl-l's bus upgrade answered ${held.status}, want 101`,
        );
      const extra: { destroy: () => void }[] = [];
      return {
        closed: held.closed,
        async connect() {
          const h = await holdSocket(connectRequest(app, token));
          extra.push(h);
          return h.status;
        },
        async cleanup() {
          held.destroy();
          for (const h of extra) h.destroy();
          // rl-l is deleted by the chain's tail; this only keeps the
          // machine list tidy while it lives. Never fails the case.
          await revokeMachines(site, pat, label).catch(() => 0);
        },
      };
    },
  };
}

export function liveRun(
  env: Record<string, string | undefined>,
  t: RawTargets,
): Run {
  const m = mask(env);
  const src = (k: AudienceKey) =>
    jwtSource(join(t.secretsDir, OIDC_FILES[k]), AUDIENCES[k], {
      env,
      onMint: m,
    });
  const patFile = credFile(t, "a", "PAT");
  const io: ProvIo = {
    mask: m,
    fetch: boundFetch(globalThis.fetch),
    now: Date.now,
    wait: (ms) => delay(ms),
    jwt: src("provisioning"),
    stgInventoryJwt: src("stagingInventory"),
    schemaOf: gitSchemaOf,
    bus: liveBusIo(env),
    rlAPat: existsSync(patFile)
      ? () => readSecretFile(patFile, secretFileName(t.a.name, "PAT"))
      : undefined,
  };
  return new Run(provConfig(env, t), io);
}

/** Mints one JWT per key into secretsDir (0600), masking each. */
export async function mintFiles(
  env: Record<string, string | undefined>,
  dir: string,
  keys: readonly AudienceKey[],
): Promise<void> {
  for (const k of keys) {
    // A fresh mint: jwtSource re-mints because the file is absent.
    const file = join(dir, OIDC_FILES[k]);
    if (existsSync(file)) throw new Error(`${OIDC_FILES[k]} already exists`);
    await jwtSource(file, AUDIENCES[k], { env, onMint: mask(env) })();
  }
}

/** How long a new TEST_HOOK_KEY may take to reach the edge (#bring-up). */
export const HOOK_KEY_WITHIN_MS = 90_000;

/**
 * R26 rotates the install's TEST_HOOK_KEY secret; the edge can serve the old
 * one for a while, and a hook answers 404 on a key mismatch. Polls the
 * install with the new key until it is accepted, within HOOK_KEY_WITHIN_MS;
 * an InfraError otherwise.
 *
 * The call is POST /__test/key_check, a path that names no hook: the server
 * checks the key first, so a right key gets the 404 refusal "bad_route"
 * (apps/server/src/test-hooks: audit row "refused" under hook "unknown", no
 * user, session or state touched), and a wrong key gets the bare 404 (audit
 * "denied", under "unknown", so the guard's session denied-row count is
 * unaffected). Each call takes a slot of the install's hook ledger
 * (`pace`), so the polls count against the same budget as the suite's.
 */
export async function waitHookKey(
  run: Run,
  app: string,
  key: string,
  pace: (app: string, deadline: number) => Promise<unknown> = (a, deadline) =>
    claimHookSlot(a, { deadline }),
  within: number = HOOK_KEY_WITHIN_MS,
): Promise<void> {
  // One deadline for the whole wait: a ledger claim gives up at it, and each
  // request is cut off at it, so the total never runs past `within`.
  const deadline = run.io.now() + within;
  const fail = () =>
    new InfraError(
      `the new hook key was not accepted within ${Math.round(within / 1000)} s of R26 (hooks answer 404 on a key mismatch)`,
    );
  for (;;) {
    if (deadline - run.io.now() <= 0) throw fail();
    try {
      await pace(app, deadline);
    } catch (e) {
      if (e instanceof HookBudgetError) throw fail();
      throw e;
    }
    const left = deadline - run.io.now();
    if (left <= 0) throw fail();
    try {
      const res = await run.io.fetch(`${app}/__test/key_check`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(left),
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      const text = await res.text();
      if (res.status === 404 && hookReason(text) === "bad_route") return;
    } catch {
      // No answer (or cut off at the deadline): try again until it.
    }
    const rest = deadline - run.io.now();
    if (rest <= 0) throw fail();
    await run.io.wait(Math.min(POLL_MS, rest));
  }
}

/** The red-line billing fixture: rl-a Team (T19), rl-b Business (#2169). */
export const TIER_FIXTURE = { a: "team", b: "business" } as const;

/**
 * Reads the install's tier from its own GET /api/v1/me with its new PAT
 * (instance.tier) and fails as infra unless it is the fixture's. No hook, no
 * new endpoint; a GET, so the run's read retries apply.
 */
export async function checkTier(
  run: Run,
  slug: string,
  app: string,
  pat: string,
  want: string,
): Promise<void> {
  const r = await run.raw(`${app}/api/v1/me`, {
    auth: { bearer: pat },
    read: true,
  });
  if (r.status !== 200)
    throw new InfraError(
      `GET /api/v1/me answered ${r.status || "nothing"}, so the tier of ${slug} is unknown`,
    );
  const tier = (r.json as { instance?: { tier?: unknown } } | null)?.instance
    ?.tier;
  if (tier !== want)
    throw new InfraError(
      `${slug} is on ${typeof tier === "string" ? tier : "an unknown tier"}, want ${want}: the red-line fixture is rl-a Team, rl-b Business (docs/ops/hosted.md). Fix the staging tier, then rerun.`,
    );
}

/** One install of the pair by its exact slug (R2 q, then the slug itself); null when none is live. */
async function findBySlug(
  run: Run,
  slug: string,
): Promise<{ id: string; state: string } | null> {
  const r = await run.v1(`/installs?${new URLSearchParams({ q: slug })}`, {
    read: true,
  });
  if (r.status !== 200) throw new ProbeFail(`R2 q=${slug}: ${desc(r)}`);
  const hit = (
    (r.json as { items?: { id: string; slug: string; state: string }[] })
      .items ?? []
  ).filter(
    (i) => i.slug === slug && !["deleted", "deleting"].includes(i.state),
  );
  if (hit.length > 1)
    throw new ProbeFail(`R2: ${hit.length} live ${slug} rows`);
  return hit[0] ?? null;
}

/** R3 for one install of the pair: active, test hooks on, both hosts set. */
async function pairSide(run: Run, id: string, slug: string): Promise<PairSide> {
  const d = await ownDetail(run, id);
  if (d.status !== 200) throw new ProbeFail(`R3 ${slug}: ${desc(d)}`);
  const i = d.json as InstallDetail;
  if (i.slug !== slug) throw new ProbeFail(`${id} is ${i.slug}, not ${slug}`);
  if (i.state !== "active")
    throw new ProbeFail(`${slug} is ${i.state}, want active`);
  if (i.testHooks !== true)
    throw new ProbeFail(`${slug}: testHooks is not true`);
  if (!i.appHost || !i.contentHost || !i.version)
    throw new ProbeFail(`${slug}: no app host, content host or version`);
  return {
    name: slug,
    installId: id,
    app: `https://${i.appHost}`,
    content: `https://${i.contentHost}`,
    version: i.version,
  };
}

/**
 * The hosted bus pair's bring-up (cloud #202): rl-agents is found by slug and
 * left at its version (it is TEST_MEMBER's install; never upgraded or
 * suspended here); rl-busb is created over OIDC at the release under test
 * when there is none (an rl- slug, testHooks, the STAGING_TEST_DOMAIN owner:
 * oidcCreate, as rl-l), resumed when a cut-off run left it suspended, and
 * upgraded to the release (bringUpgrade). Then R26 on each: the creds go to
 * secretsDir as REDLINE_RL_AGENTS_* and REDLINE_RL_BUSB_*, the new hook keys
 * must be accepted (waitHookKey, paced), and the pair file is written. Every
 * failure names its install.
 */
export async function bringUpBusPair(
  run: Run,
  dir: string,
  recipient: { publicKey: string; open: (sealed: string) => Promise<CredsOut> },
  pace?: (app: string, deadline: number) => Promise<unknown>,
): Promise<BusPair> {
  const agents = await findBySlug(run, BUS_AGENTS);
  if (!agents)
    throw new InfraError(
      `${BUS_AGENTS} is not on staging (TEST_MEMBER's install, docs/ops/hosted.md)`,
    );
  let busb = await findBySlug(run, BUS_B);
  if (!busb) {
    const a = run.accepted(
      await run.v1("/installs", {
        body: oidcCreate(run, BUS_B, run.rid("busb-create"), run.c.version),
      }),
      `${BUS_B} create`,
    );
    await run.done(a.job.id, `${BUS_B} create`);
    busb = { id: a.install.id, state: "active" };
    out(`${BUS_B}: created (${run.c.version})\n`);
  } else {
    if (busb.state === "suspended") {
      const a = run.accepted(
        await run.v1(`/installs/${busb.id}/resume`, {
          body: { requestId: run.rid("busb-left-suspended") },
        }),
        `${BUS_B} resume`,
      );
      await run.done(a.job.id, `${BUS_B} resume`);
      out(`${BUS_B}: resumed (a run left it suspended)\n`);
    }
    out(
      `${BUS_B}: ${await bringUpgrade(run, busb.id, BUS_B)} (${run.c.version})\n`,
    );
  }
  // Recorded before its R26, so the run's revoke finds every install that
  // may hold this run's creds, even when the pair never got ready.
  const sides: PairSide[] = [];
  const one = async (id: string, slug: string): Promise<PairSide> => {
    const side = await pairSide(run, id, slug);
    sides.push(side);
    writeFileSync(join(dir, BUS_PAIR_SIDES_FILE), JSON.stringify(sides), {
      mode: 0o600,
    });
    const c = await mintCreds(run, id, slug, recipient);
    writeSecretFile(join(dir, secretFileName(slug, "PAT")), c.pat);
    writeSecretFile(join(dir, secretFileName(slug, "HOOK_KEY")), c.hookKey);
    out(`${slug}: R26 creds written\n`);
    await waitHookKey(run, side.app, c.hookKey, pace);
    out(`${slug}: the new hook key is accepted\n`);
    return side;
  };
  const named = (slug: string) => (e: unknown) => {
    const msg = errText(e);
    if (e instanceof Error) {
      if (!msg.startsWith(`${slug}:`)) e.message = `${slug}: ${msg}`;
      throw e;
    }
    throw new Error(`${slug}: ${msg}`);
  };
  // Both always awaited to the end, as bringUp's two chains.
  const [a, b] = await Promise.allSettled([
    one(agents.id, BUS_AGENTS).catch(named(BUS_AGENTS)),
    one(busb.id, BUS_B).catch(named(BUS_B)),
  ]);
  if (a.status === "rejected") throw a.reason;
  if (b.status === "rejected") throw b.reason;
  const pair = { agents: a.value, busb: b.value };
  writeBusPair(dir, pair);
  return pair;
}

/**
 * The workflow's bring-up (P24, R26): upgrade rl-a and rl-b, then mint their
 * creds, the two installs at the same time (#1730: the two upgrades are about
 * 2:00 and 1:38 when taken one after the other). Each install is its own
 * chain (upgrade, then R26 mint, then its two files); both are always awaited
 * to the end, so a failing install never leaves the other's job unwatched. Any
 * failure fails the bring-up, and each failure line starts with the install's
 * slug. `run` is a seam for tests (default: the live wiring).
 */
export async function bringUp(
  env: Record<string, string | undefined>,
  t: RawTargets,
  run: Run = liveRun(env, t),
  pace?: (app: string, deadline: number) => Promise<unknown>,
  busPair?: typeof bringUpBusPair,
): Promise<void> {
  const m = mask(env);
  const r = await newRecipient();
  const open = async (sealed: string): Promise<CredsOut> => {
    const c = parseCreds(await openSealed(r, sealed));
    m(c.pat);
    m(c.hookKey);
    return c;
  };
  const one = async (name: "a" | "b", side: RawTargets["a"]): Promise<void> => {
    const slug = `rl-${name}`;
    try {
      const how = await bringUpgrade(run, side.installId, slug);
      out(`${slug}: ${how} (${run.c.version})\n`);
      const c = await mintCreds(run, side.installId, slug, {
        publicKey: r.publicKey,
        open,
      });
      writeSecretFile(credFile(t, name, "PAT"), c.pat);
      writeSecretFile(credFile(t, name, "HOOK_KEY"), c.hookKey);
      out(`${slug}: R26 creds written\n`);
      // Before the suite or the t19 hand-off reads the key.
      await waitHookKey(run, side.app, c.hookKey, pace);
      out(`${slug}: the new hook key is accepted\n`);
      await checkTier(run, slug, side.app, c.pat, TIER_FIXTURE[name]);
      out(`${slug}: tier is ${TIER_FIXTURE[name]}\n`);
    } catch (e) {
      const msg = errText(e);
      if (!(e instanceof Error)) throw new Error(`${slug}: ${msg}`);
      // The error keeps its kind (an InfraError stays one) and gains the slug.
      if (!msg.startsWith(`${slug}:`)) e.message = `${slug}: ${msg}`;
      throw e;
    }
  };
  // The hosted bus pair (cloud #202) beside them. Its failure never fails the
  // bring-up: it is written for the two bus cases, which report it as infra,
  // so the rest of the suite still runs.
  const pair = (busPair ?? bringUpBusPair)(
    run,
    t.secretsDir,
    { publicKey: r.publicKey, open },
    pace,
  ).then(
    () => out("bus pair: ready\n"),
    (e) => {
      const why = errText(e);
      writeBusPairError(t.secretsDir, why);
      out(`bus pair: not ready: ${why}\n`);
    },
  );
  const done = await Promise.allSettled([one("a", t.a), one("b", t.b)]);
  await pair;
  const failed = done.filter(
    (d): d is PromiseRejectedResult => d.status === "rejected",
  );
  if (failed.length === 0) return;
  for (const f of failed.slice(1)) out(`${errText(f.reason)}\n`);
  throw failed[0]?.reason;
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** The workflow's last step: R26 revoke on rl-a and rl-b; both run, any failure fails. */
export async function revokeAll(
  env: Record<string, string | undefined>,
  t: RawTargets,
): Promise<number> {
  const run = liveRun(env, t);
  let failed = 0;
  for (const [name, side] of [
    ["a", t.a],
    ["b", t.b],
  ] as const) {
    const f = credFile(t, name, "PAT");
    const pat = existsSync(f)
      ? readSecretFile(f, secretFileName(side.name, "PAT"))
      : undefined;
    try {
      await revokeCreds(run, side.installId, `rl-${name}`, side.app, pat);
      out(`rl-${name}: R26 revoked\n`);
    } catch (e) {
      failed++;
      out(`rl-${name}: revoke failed: ${(e as Error).message}\n`);
    }
  }
  // The hosted bus pair's installs that bring-up took R26 creds on (cloud #202).
  for (const side of busPairSides(t.secretsDir)) {
    const f = join(t.secretsDir, secretFileName(side.name, "PAT"));
    const pat = existsSync(f)
      ? readSecretFile(f, secretFileName(side.name, "PAT"))
      : undefined;
    try {
      await revokeCreds(run, side.installId, side.name, side.app, pat);
      out(`${side.name}: R26 revoked\n`);
    } catch (e) {
      failed++;
      out(`${side.name}: revoke failed: ${(e as Error).message}\n`);
    }
  }
  return failed ? 1 : 0;
}

/**
 * The staging-first record: once rl-a's and rl-b's /healthz both report
 * REDLINE_RELEASE, writes it (X.Y.Z) to `file` for the
 * redline-staged-version artifact.
 */
export async function writeStagedVersion(
  env: Record<string, string | undefined>,
  t: RawTargets,
  file: string,
): Promise<void> {
  const v = await stagedVersion(liveRun(env, t));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${v}\n`);
  out(`rl-a and rl-b report ${v}\n`);
}
