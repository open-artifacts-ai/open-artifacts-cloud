import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BusError,
  connectRequest,
  mintMachine,
  revokeMachines,
} from "./bus.ts";
import { InfraError } from "./fetch-timeout.ts";
import { paceHook, sendProbe } from "./http.ts";
import { mask } from "./oidc.ts";
import {
  JOB_WITHIN_MS,
  PAGE_WITHIN_MS,
  ProbeFail,
  type Run,
} from "./provisioning.ts";
import { liveRun, rawTargets } from "./provisioning-live.ts";
import type { AnonTarget } from "./rl-anon.ts";
import { readSecretFile, secretFileName, type Target } from "./targets.ts";
import { type Held, holdSocket, wsHandshake } from "./ws.ts";

// The hosted bus cases of open-artifacts#1954 (cloud #202), on two staging
// installs whose bus is on through STAGING_BUS_SLUGS (apps/provisioner
// wrangler.jsonc env.staging), not on the HOSTED_BUS_LIFTED switch:
// - rl-agents: TEST_MEMBER's install (docs/ops/hosted.md). Case 1's A (the
//   token is minted there) and case 2's bystander (its socket must stay up).
// - rl-busb: red-line's own. Case 1's B (it must refuse A's token) and the
//   install case 2 suspends, so the shared agents install is never suspended.
// Bring-up (provisioning-live.ts bringUpBusPair) creates or upgrades rl-busb,
// takes both installs' R26 creds into secretsDir and writes the pair file
// read here. No token, PAT, key or cookie is ever put in a message.

export const BUS_AGENTS = "rl-agents";
export const BUS_B = "rl-busb";
/** The pair's hosts and ids, written by bring-up into secretsDir (not secret). */
export const BUS_PAIR_FILE = "REDLINE_BUS_PAIR";
/** Why bring-up could not make the pair: the cases report it as infra. */
export const BUS_PAIR_ERROR_FILE = "REDLINE_BUS_PAIR_ERROR";

export interface PairSide {
  name: string;
  installId: string;
  /** https://<appHost> */
  app: string;
  /** https://<contentHost> */
  content: string;
  version: string;
}
export interface BusPair {
  agents: PairSide;
  busb: PairSide;
}

/** The pair's installs bring-up reached R26 on, in order (the run's revoke reads it). */
export const BUS_PAIR_SIDES_FILE = "REDLINE_BUS_PAIR_SIDES";

/** The installs to revoke at the run's end: none when bring-up reached none. */
export function busPairSides(
  dir: string,
): { name: string; installId: string; app: string }[] {
  const f = join(dir, BUS_PAIR_SIDES_FILE);
  if (!existsSync(f)) return [];
  const v = JSON.parse(readFileSync(f, "utf8")) as unknown;
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const s = x as Partial<PairSide>;
    return typeof s.name === "string" &&
      [BUS_AGENTS, BUS_B].includes(s.name) &&
      typeof s.installId === "string" &&
      typeof s.app === "string"
      ? [{ name: s.name, installId: s.installId, app: s.app }]
      : [];
  });
}

export function writeBusPair(dir: string, p: BusPair): void {
  writeFileSync(join(dir, BUS_PAIR_FILE), JSON.stringify(p), { mode: 0o600 });
}

export function writeBusPairError(dir: string, why: string): void {
  writeFileSync(join(dir, BUS_PAIR_ERROR_FILE), `${why.slice(0, 500)}\n`, {
    mode: 0o600,
  });
}

const sideOf = (v: unknown, name: string): PairSide => {
  const s = v as Partial<PairSide> | undefined;
  for (const k of ["installId", "app", "content", "version"] as const)
    if (typeof s?.[k] !== "string" || s[k] === "")
      throw new InfraError(`the bus pair file has no ${name}.${k}`);
  if (s?.name !== name)
    throw new InfraError(`the bus pair file names ${name} wrong`);
  return s as PairSide;
};

/** The pair bring-up wrote; an InfraError naming why when it wrote none. */
export function readBusPair(dir: string): BusPair {
  const err = join(dir, BUS_PAIR_ERROR_FILE);
  if (existsSync(err))
    throw new InfraError(
      `bus pair bring-up: ${readFileSync(err, "utf8").trim()}`,
    );
  const f = join(dir, BUS_PAIR_FILE);
  if (!existsSync(f))
    throw new InfraError("bus pair bring-up wrote no pair file");
  const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
  return { agents: sideOf(j.agents, BUS_AGENTS), busb: sideOf(j.busb, BUS_B) };
}

/**
 * The pair as RL_ANON targets, for live/setup.ts: their device-flow requests
 * spend the same account-wide keys as rl-a's and rl-b's (src/rl-anon.ts), so
 * the guard paces them too and its 429 tripwire covers them. Lenient: none
 * when there is no pair file.
 */
export function busPairTargets(
  env: Record<string, string | undefined> = process.env,
): AnonTarget[] {
  try {
    const dir = (
      JSON.parse(env.REDLINE_TARGETS ?? "null") as {
        secretsDir?: unknown;
      } | null
    )?.secretsDir;
    if (typeof dir !== "string" || !existsSync(join(dir, BUS_PAIR_FILE)))
      return [];
    const p = readBusPair(dir);
    return [p.agents, p.busb].map((s) => ({
      name: s.name,
      installId: s.installId,
      app: s.app,
      content: s.content,
    }));
  } catch {
    return [];
  }
}

// --- Case 1: A's machine token at B --------------------------------------

/** What case 1 needs; the live wiring is liveCrossIo. */
export interface CrossIo {
  /** A real machine token on A (rl-agents), by the device flow. */
  mintA(): Promise<string>;
  /** GET <origin>/bus/connect with Upgrade: websocket and the bearer. */
  connect(
    origin: string,
    token: string,
  ): Promise<{ status: number; body: string }>;
  /** B's (rl-busb's) GET /api/v1/bus/machines and /api/v1/bus/agents, as its admin reads them. */
  snapshotB(): Promise<string>;
}

const codeOf = (body: string): string | undefined => {
  try {
    const c = (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code;
    return typeof c === "string" ? c.slice(0, 40) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Case 1, OA Bus's assertions in order: a real machine token minted on A;
 * at B's /bus/connect it is 401 "unauthorized", never 101; the control, the
 * same token at A, is 101; B's machines and roster are what they were; and
 * B's content host does not upgrade it either.
 */
export async function crossInstallCase(io: CrossIo, p: BusPair): Promise<void> {
  const token = await io.mintA();
  const before = await io.snapshotB();
  const atB = await io.connect(p.busb.app, token);
  if (atB.status === 101)
    throw new ProbeFail(
      `${p.busb.name} upgraded ${p.agents.name}'s machine token (101)`,
    );
  if (atB.status !== 401 || codeOf(atB.body) !== "unauthorized")
    throw new ProbeFail(
      `${p.busb.name} /bus/connect with ${p.agents.name}'s machine token answered ${atB.status} ${codeOf(atB.body) ?? "no code"}, want 401 unauthorized`,
    );
  const control = await io.connect(p.agents.app, token);
  if (control.status !== 101)
    throw new ProbeFail(
      `control: ${p.agents.name} answered its own machine token with ${control.status}, want 101`,
    );
  const content = await io.connect(p.busb.content, token);
  if (content.status === 101)
    throw new ProbeFail(
      `${p.busb.name}'s content host upgraded ${p.agents.name}'s machine token (101)`,
    );
  if ((await io.snapshotB()) !== before)
    throw new ProbeFail(
      `${p.busb.name}'s /api/v1/bus/machines or roster changed after ${p.agents.name}'s token was tried there`,
    );
}

// --- Case 2: suspend -----------------------------------------------------

/** OA Bus's target for the close; the case notes a slower one. */
export const CLOSE_SOON_MS = 30_000;
/** The install index's second close pass (apps/server runtime/presence.ts SECOND_PASS_MS). */
export const SECOND_PASS_MS = 120_000;
/** The ceiling: that pass, and slack for the poll. */
export const CLOSE_CEILING_MS = SECOND_PASS_MS + 15_000;
/** The close code the hub closes a suspended member's daemon sockets with. */
export const SUSPEND_CLOSE_CODE = 4403;
/** How long reconnects must be refused after the close: past the 300 s last pass. */
export const PAUSED_WINDOW_MS = 6 * 60_000;
/** One reconnect per this, through the window. */
export const PAUSED_POLL_MS = 30_000;
/** Dispatch reads HOSTS (KV, up to 60 s to show): two periods for the first paused answer. */
export const PAUSED_SETTLE_MS = 120_000;
/** A redelivery after the resume, and every frame wait. */
export const FRAME_WAIT_MS = 30_000;
const CLOSE_POLL_MS = 1_000;
/** Case 2's vitest bound: two jobs at their bound, the close, the window and slack. */
export const BUS_CASE_TIMEOUT_MS =
  2 * JOB_WITHIN_MS + CLOSE_CEILING_MS + PAUSED_WINDOW_MS + 10 * 60_000;
/** Case 1's: the pair's sign-in, a device flow (polls 5 s apart) and pacing waits. */
export const CROSS_CASE_TIMEOUT_MS = 5 * 60_000;

export { mask };

/** One socket the case holds. */
export interface HeldSock {
  closed: Promise<void>;
  isOpen(): boolean;
  closeCode(): number | null;
}

export interface Daemon extends HeldSock {
  /** The mail delivered to the receiving agent and never acked. */
  msgId: string;
}

/** What case 2 needs; the live wiring is liveSuspendIo. */
export interface SuspendIo {
  now(): number;
  wait(ms: number): Promise<void>;
  /** On B (rl-agents' side of case 2): a bus socket with hello_ok. */
  openBystander(): Promise<HeldSock>;
  /** On the suspended install: a daemon socket, two agents up, one message delivered, not acked. */
  openDaemon(): Promise<Daemon>;
  /** R7 on the suspended install, to done. */
  suspend(): Promise<void>;
  /** R8, to done, then its /healthz 200. */
  resume(): Promise<void>;
  /** One upgrade with the daemon's token: its status, and whether it is dispatch's paused 503. */
  reconnect(): Promise<{ status: number; paused: boolean }>;
  /** After the resume: the same token's upgrade, hello, the receiver up again, and whether msgId came again. */
  reopen(msgId: string): Promise<{ status: number; redelivered: boolean }>;
  /** The machine still listed and the receiving agent still on the roster: null, or what is missing. */
  hubProblem(): Promise<string | null>;
}

export interface SuspendResult {
  closeMs: number;
  reconnects: number;
  pausedMs: number;
}

/**
 * Case 2, OA Bus's assertions in order: with a daemon socket (an agent up and
 * one message pending) on the install and a socket on the other, suspend;
 * the daemon socket closes within CLOSE_CEILING_MS (target CLOSE_SOON_MS)
 * with 4403; for PAUSED_WINDOW_MS after the close every reconnect with the
 * same token is refused, never 101, and is dispatch's paused answer from the
 * first one that is (within PAUSED_SETTLE_MS) to the end; the other socket
 * stays open throughout; after the resume the same token gets 101, the
 * pending mail comes again and the hub still lists the machine and agent.
 * The resume is sent whatever failed after the suspend was sent; the first
 * failure is the one thrown.
 */
export async function suspendCase(
  io: SuspendIo,
  p: BusPair,
): Promise<SuspendResult> {
  const X = p.busb.name;
  const Y = p.agents.name;
  const bystander = await io.openBystander();
  const d = await io.openDaemon();
  const out: SuspendResult = { closeMs: 0, reconnects: 0, pausedMs: 0 };
  const stillUp = (when: string) => {
    if (!bystander.isOpen())
      throw new ProbeFail(`${Y}'s bus socket closed ${when}`);
  };
  let failure: unknown;
  let resumeFailure: unknown;
  // Marked before the request: a suspend whose answer was lost is still resumed.
  let suspended = false;
  try {
    suspended = true;
    await io.suspend();
    const t0 = io.now();
    let closed = false;
    void d.closed.then(() => {
      closed = true;
    });
    while (!closed && io.now() - t0 < CLOSE_CEILING_MS)
      await io.wait(CLOSE_POLL_MS);
    if (!closed)
      throw new ProbeFail(
        `${X}'s daemon socket was still open ${CLOSE_CEILING_MS / 1000} s after the suspend`,
      );
    out.closeMs = io.now() - t0;
    const code = d.closeCode();
    if (code !== SUSPEND_CLOSE_CODE)
      throw new ProbeFail(
        `${X}'s daemon socket closed with ${code ?? "no code"}, want ${SUSPEND_CLOSE_CODE}`,
      );
    const start = io.now();
    let pausedAt: number | null = null;
    for (;;) {
      stillUp("while the other install was suspended");
      const r = await io.reconnect();
      out.reconnects++;
      const at = io.now() - start;
      if (r.status === 101)
        throw new ProbeFail(
          `${X} upgraded the daemon's token ${Math.round(at / 1000)} s into the suspend`,
        );
      if (r.paused) pausedAt ??= at;
      else if (pausedAt !== null)
        throw new ProbeFail(
          `${X} answered a reconnect ${Math.round(at / 1000)} s into the suspend with ${r.status}, after dispatch's paused answer`,
        );
      else if (at >= PAUSED_SETTLE_MS)
        throw new ProbeFail(
          `${X}: no paused answer from dispatch ${PAUSED_SETTLE_MS / 1000} s after the close (last ${r.status})`,
        );
      if (pausedAt !== null && at >= PAUSED_WINDOW_MS) {
        out.pausedMs = at - pausedAt;
        break;
      }
      await io.wait(PAUSED_POLL_MS);
    }
  } catch (e) {
    failure = e;
  }
  if (suspended)
    try {
      await io.resume();
    } catch (e) {
      resumeFailure = e;
    }
  if (failure) throw failure;
  if (resumeFailure) throw resumeFailure;
  stillUp("by the resume");
  const r = await io.reopen(d.msgId);
  if (r.status !== 101)
    throw new ProbeFail(
      `after the resume ${X} answered the same machine token with ${r.status}, want 101`,
    );
  if (!r.redelivered)
    throw new ProbeFail(
      `after the resume the pending mail did not come again on ${X} within ${FRAME_WAIT_MS / 1000} s`,
    );
  const hub = await io.hubProblem();
  if (hub) throw new ProbeFail(`after the resume ${X}'s hub: ${hub}`);
  stillUp("at the end");
  return out;
}

// --- The live wiring -------------------------------------------------------

const SESSION_COOKIE = "__Host-oa_session";
/** The hello the daemon sends: mailbox for lasting mail (#1295), ids for replies. */
const helloFrame = (id: string) =>
  JSON.stringify({
    v: 1,
    id,
    type: "hello",
    machine_label: "redline",
    client_version: "0.1.0",
    caps: ["ids", "mailbox"],
  });

/** One install of the pair, signed in: its admin PAT and session cookie. */
export interface Signed {
  side: PairSide;
  pat: string;
  cookie: string;
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/**
 * The pair's R26 creds from secretsDir, and an admin session on each: the
 * PAT's own user (GET /api/v1/me), through POST /__test/session with the
 * install's hook key, paced in the install's hook ledger (paceHook). One
 * session per install per run.
 */
export async function signIn(
  dir: string,
  s: PairSide,
  m: (v: string) => void,
): Promise<Signed> {
  const file = (k: "PAT" | "HOOK_KEY") =>
    readSecretFile(
      join(dir, secretFileName(s.name, k)),
      secretFileName(s.name, k),
    );
  const pat = file("PAT");
  const key = file("HOOK_KEY");
  m(pat);
  m(key);
  const me = await fetch(`${s.app}/api/v1/me`, {
    headers: bearer(pat),
    redirect: "manual",
  });
  const mj = (await me.json().catch(() => null)) as {
    user?: { email?: unknown };
  } | null;
  const email = mj?.user?.email;
  if (me.status !== 200 || typeof email !== "string")
    throw new InfraError(
      `${s.name}: the R26 PAT's /api/v1/me answered ${me.status}`,
    );
  await paceHook({ app: s.app } as Target);
  const res = await fetch(`${s.app}/__test/session`, {
    method: "POST",
    redirect: "manual",
    headers: { ...bearer(key), "content-type": "application/json" },
    body: JSON.stringify({ email, role: "admin" }),
  });
  const j = (await res.json().catch(() => null)) as { cookie?: unknown } | null;
  if (res.status !== 200 || typeof j?.cookie !== "string")
    throw new InfraError(
      `${s.name}: the session test route answered ${res.status}`,
    );
  m(j.cookie);
  return { side: s, pat, cookie: `${SESSION_COOKIE}=${j.cookie}` };
}

/** GET /api/v1/bus/ping with the PAT: the bus must be on at both installs. */
export async function requireBusOn(s: Signed): Promise<void> {
  const r = await fetch(`${s.side.app}/api/v1/bus/ping`, {
    headers: bearer(s.pat),
    redirect: "manual",
  });
  await r.text();
  if (r.status === 404)
    throw new ProbeFail(
      `${s.side.name}'s bus is off (404): STAGING_BUS_SLUGS must list it and it must have been rendered since`,
    );
  if (r.status !== 200)
    throw new ProbeFail(`${s.side.name} bus ping answered ${r.status}`);
}

/** One upgrade request, the socket closed at once: status and body. */
async function upgradeOnce(
  origin: string,
  token: string,
): Promise<{ status: number; body: string }> {
  const res = await sendProbe(connectRequest(origin, token), wsHandshake);
  return { status: res.status, body: await res.text().catch(() => "") };
}

async function getText(
  s: Signed,
  path: string,
): Promise<{ status: number; text: string }> {
  const r = await fetch(`${s.side.app}${path}`, {
    headers: bearer(s.pat),
    redirect: "manual",
  });
  return { status: r.status, text: await r.text() };
}

/** The machines a run mints, by label, for the cleanup. */
export class Minted {
  readonly label = `redline-busb-${Date.now().toString(36)}`;
  private readonly tokens = new Map<string, Promise<string>>();
  private readonly sides = new Map<string, Signed>();
  private readonly m: (v: string) => void;
  constructor(m: (v: string) => void) {
    this.m = m;
  }
  /** One machine token per install per run, minted on first use. */
  token(s: Signed): Promise<string> {
    let t = this.tokens.get(s.side.name);
    if (!t) {
      this.sides.set(s.side.name, s);
      t = mintMachine(
        { app: s.side.app, fetch: globalThis.fetch },
        s.cookie,
        this.label,
      )
        .then((v) => {
          this.m(v);
          return v;
        })
        .catch((e) => {
          throw new ProbeFail(
            `${s.side.name}: ${e instanceof BusError ? e.message : "no machine token"}`,
          );
        });
      this.tokens.set(s.side.name, t);
    }
    return t;
  }
  /** Best effort: revokes this run's machines. Never throws. */
  async cleanup(): Promise<void> {
    for (const s of this.sides.values())
      await revokeMachines(
        { app: s.side.app, fetch: globalThis.fetch },
        s.pat,
        this.label,
      ).catch(() => 0);
  }
}

export function liveCrossIo(a: Signed, b: Signed, minted: Minted): CrossIo {
  return {
    mintA: () => minted.token(a),
    connect: upgradeOnce,
    async snapshotB() {
      const ms = await getText(b, "/api/v1/bus/machines");
      const ag = await getText(b, "/api/v1/bus/agents");
      if (ms.status !== 200 || ag.status !== 200)
        throw new ProbeFail(
          `${b.side.name}: /api/v1/bus/machines ${ms.status}, /api/v1/bus/agents ${ag.status}, want 200 and 200`,
        );
      return JSON.stringify([ms.text, ag.text]);
    },
  };
}

type Frame = Record<string, unknown>;
const frames = (h: Held): Frame[] =>
  h.texts.flatMap((t) => {
    try {
      const f = JSON.parse(t) as unknown;
      return f && typeof f === "object" ? [f as Frame] : [];
    } catch {
      return [];
    }
  });
const waitFrame = async (
  h: Held,
  pred: (f: Frame) => boolean,
  what: string,
  ms = FRAME_WAIT_MS,
): Promise<Frame> => {
  const ok = await h.waitText((t) => {
    try {
      return pred(JSON.parse(t) as Frame);
    } catch {
      return false;
    }
  }, ms);
  const f = frames(h).find(pred);
  if (!ok || !f) {
    const err = frames(h).find((x) => x.type === "error");
    throw new ProbeFail(
      `${what}: not within ${ms / 1000} s${err ? ` (hub error ${String(err.code).slice(0, 30)})` : ""}`,
    );
  }
  return f;
};

/** Says hello and waits for hello_ok; a socket that never gets it fails. */
async function hello(h: Held, where: string): Promise<void> {
  h.send(helloFrame("h1"));
  await waitFrame(h, (f) => f.type === "hello_ok", `${where} hello_ok`);
}

async function agentUp(
  h: Held,
  ref: string,
  name: string,
  where: string,
): Promise<string> {
  const id = `u${randomBytes(4).toString("hex")}`;
  h.send(
    JSON.stringify({
      v: 1,
      id,
      type: "agent_up",
      agent_ref: ref,
      kind: "claude-code",
      proposed_name: name,
      namespace: "redline",
      global: false,
    }),
  );
  const ok = await waitFrame(
    h,
    (f) => f.type === "agent_ok" && f.agent_ref === ref,
    `${where} agent_ok for ${name}`,
  );
  if (typeof ok.bus_name !== "string")
    throw new ProbeFail(`${where}: agent_ok without a bus_name`);
  return ok.bus_name;
}

const asSock = (h: Held): HeldSock => {
  let open = true;
  void h.closed.then(() => {
    open = false;
  });
  return {
    closed: h.closed,
    isOpen: () => open,
    closeCode: () => h.closeCode(),
  };
};

/** The suspended install's agents, refs fixed per run (a reopen takes the same one). */
const RECV_REF = "redline-recv";
const SEND_REF = "redline-send";

export function liveSuspendIo(
  x: Signed,
  y: Signed,
  minted: Minted,
  run: Run,
  held: Held[],
): SuspendIo {
  const nonce = randomBytes(9).toString("base64url");
  let recvName = "";
  const xHost = new URL(x.side.app).host;
  return {
    now: () => run.io.now(),
    wait: (ms) => run.io.wait(ms),
    async openBystander() {
      const t = await minted.token(y);
      const h = await holdSocket(connectRequest(y.side.app, t));
      held.push(h);
      if (h.status !== 101)
        throw new ProbeFail(
          `${y.side.name} answered its own machine token with ${h.status}, want 101`,
        );
      await hello(h, y.side.name);
      return asSock(h);
    },
    async openDaemon() {
      const t = await minted.token(x);
      const h = await holdSocket(connectRequest(x.side.app, t));
      held.push(h);
      if (h.status !== 101)
        throw new ProbeFail(
          `${x.side.name} answered its own machine token with ${h.status}, want 101`,
        );
      await hello(h, x.side.name);
      recvName = await agentUp(h, RECV_REF, "redline-recv", x.side.name);
      await agentUp(h, SEND_REF, "redline-send", x.side.name);
      h.send(
        JSON.stringify({
          v: 1,
          id: "s1",
          type: "send",
          from_ref: SEND_REF,
          to_name: recvName,
          body: `redline pending ${nonce}`,
        }),
      );
      const rc = await waitFrame(
        h,
        (f) => f.type === "receipt" && f.id === "s1",
        `${x.side.name} send receipt`,
      );
      if (rc.state !== "pending")
        throw new ProbeFail(
          `${x.side.name}: the send was ${String(rc.state).slice(0, 20)} (${String(rc.reason ?? "no reason").slice(0, 30)}), want pending`,
        );
      const dv = await waitFrame(
        h,
        (f) =>
          f.type === "deliver" &&
          f.to_ref === RECV_REF &&
          f.body === `redline pending ${nonce}`,
        `${x.side.name} deliver to the receiver`,
      );
      // Never acked: it stays pending through the suspend.
      return { ...asSock(h), msgId: String(dv.msg_id) };
    },
    async suspend() {
      const a = run.accepted(
        await run.v1(`/installs/${x.side.installId}/suspend`, {
          body: {
            requestId: run.rid("busb-suspend"),
            reason: "red-line hosted bus (#1954)",
          },
        }),
        `${x.side.name} suspend`,
      );
      await run.done(a.job.id, `${x.side.name} suspend`);
    },
    async resume() {
      const a = run.accepted(
        await run.v1(`/installs/${x.side.installId}/resume`, {
          body: { requestId: run.rid("busb-resume") },
        }),
        `${x.side.name} resume`,
      );
      await run.done(a.job.id, `${x.side.name} resume`);
      await run.within(
        PAGE_WITHIN_MS,
        `${x.side.name} /healthz 200 after the resume`,
        async () => (await run.page(xHost)).status === 200,
      );
    },
    async reconnect() {
      const r = await upgradeOnce(x.side.app, await minted.token(x));
      // Dispatch's own 503 (apps/dispatch/src/unavailable.ts): text for a
      // client that does not ask for HTML.
      return {
        status: r.status,
        paused:
          r.status === 503 && r.body.startsWith("This workspace is paused"),
      };
    },
    async reopen(msgId) {
      const h = await holdSocket(
        connectRequest(x.side.app, await minted.token(x)),
      );
      held.push(h);
      if (h.status !== 101) return { status: h.status, redelivered: false };
      await hello(h, `${x.side.name} after the resume`);
      await agentUp(
        h,
        RECV_REF,
        "redline-recv",
        `${x.side.name} after the resume`,
      );
      const again = await h.waitText(
        (t) => t.includes(`"${msgId}"`) && t.includes('"deliver"'),
        FRAME_WAIT_MS,
      );
      if (again)
        h.send(JSON.stringify({ v: 1, id: "a1", type: "ack", msg_id: msgId }));
      return { status: 101, redelivered: again };
    },
    async hubProblem() {
      const ms = await getText(x, "/api/v1/bus/machines");
      const ag = await getText(x, "/api/v1/bus/agents");
      if (ms.status !== 200)
        return `/api/v1/bus/machines answered ${ms.status}`;
      if (ag.status !== 200) return `/api/v1/bus/agents answered ${ag.status}`;
      const rows =
        (
          JSON.parse(ms.text) as {
            machines?: { label?: unknown; revokedAt?: unknown }[];
          }
        ).machines ?? [];
      if (!rows.some((r) => r.label === minted.label && !r.revokedAt))
        return "the machine is not listed, or is revoked";
      if (!listsName(JSON.parse(ag.text), recvName))
        return "the receiving agent is not on the roster";
      return null;
    },
  };
}

/** True when some object in `v` (any depth) has `name` === name. */
export function listsName(v: unknown, name: string, depth = 0): boolean {
  if (depth > 6 || v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some((x) => listsName(x, name, depth + 1));
  const o = v as Record<string, unknown>;
  if (o.name === name) return true;
  return Object.values(o).some((x) => listsName(x, name, depth + 1));
}

/** The live case's wiring: the pair, both signed in, the Run for R7 and R8. */
export interface LivePair {
  pair: BusPair;
  agents: Signed;
  busb: Signed;
  run: Run;
}

export async function livePair(
  env: Record<string, string | undefined> = process.env,
): Promise<LivePair> {
  const t = rawTargets(env.REDLINE_TARGETS);
  const pair = readBusPair(t.secretsDir);
  const m = mask(env);
  const agents = await signIn(t.secretsDir, pair.agents, m);
  const busb = await signIn(t.secretsDir, pair.busb, m);
  return { pair, agents, busb, run: liveRun(env, t) };
}
