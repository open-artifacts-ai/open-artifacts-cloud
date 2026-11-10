import { HOSTED_BUS_LIFTED } from "./bus-gate.ts";
import { type Held, holdSocket } from "./ws.ts";

export { HOSTED_BUS_LIFTED };

// The hosted bus's red-line helpers (open-artifacts#1299, part 4). The bus
// answers 404 on a hosted install until part 6 lifts HOSTED=1, so every case
// that needs it asks busState first and reports "off" rather than guessing.
//
// A machine token is minted the way the local client gets one: the device
// flow, approved with a signed-in session in the browser form. Nothing here
// logs or returns a token in an error: a failure names the step and a status.

/** What the helpers need to reach one install. */
export interface BusSite {
  /** The install's app origin, https://host. */
  app: string;
  fetch: typeof fetch;
}

export class BusError extends Error {}

const form = (o: Record<string, string>) => new URLSearchParams(o);
const hidden = (html: string, name: string): string | null =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? null;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * GET /api/v1/bus/ping with a PAT: "on" for 200 { ok: true }, "off" for the
 * 404 of a bus that is off. Anything else (401, 5xx, a wrong body) throws:
 * that is a broken bus or credential, not an off one.
 */
export async function busState(s: BusSite, pat: string): Promise<"on" | "off"> {
  const r = await s.fetch(`${s.app}/api/v1/bus/ping`, {
    headers: bearer(pat),
    redirect: "manual",
  });
  const body = await r.text();
  if (r.status === 404) return "off";
  if (r.status !== 200) throw new BusError(`bus ping: status ${r.status}`);
  let ok: unknown;
  try {
    ok = (JSON.parse(body) as { ok?: unknown } | null)?.ok;
  } catch {
    ok = undefined;
  }
  if (ok !== true) throw new BusError("bus ping: 200 without { ok: true }");
  return "on";
}

/**
 * A new machine token for the member behind `cookie` ("name=value"): the
 * device flow, then the approval form (code entry, then Approve), then the
 * token poll. `label` names the machine so cleanup can find it.
 */
export async function mintMachine(
  s: BusSite,
  cookie: string,
  label: string,
  o: { wait?: (ms: number) => Promise<void>; polls?: number } = {},
): Promise<string> {
  const wait = o.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const dev = await s.fetch(`${s.app}/bus/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machine_label: label }),
    redirect: "manual",
  });
  if (dev.status !== 201)
    throw new BusError(`bus device: status ${dev.status}`);
  const d = (await dev.json()) as {
    device_code?: unknown;
    user_code?: unknown;
    interval?: unknown;
  };
  if (typeof d.device_code !== "string" || typeof d.user_code !== "string")
    throw new BusError("bus device: no codes");
  const page = (path: string, init: RequestInit = {}) =>
    s.fetch(`${s.app}${path}`, {
      ...init,
      redirect: "manual",
      headers: {
        cookie,
        ...(init.method === "POST"
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
      },
    });
  const entry = await page("/bus/approve");
  const entryHtml = await entry.text();
  const c1 = hidden(entryHtml, "csrf");
  if (entry.status !== 200 || !c1)
    throw new BusError(`bus approve page: status ${entry.status}`);
  const code = await page("/bus/approve", {
    method: "POST",
    body: form({ csrf: c1, step: "code", code: d.user_code }),
  });
  const codeHtml = await code.text();
  const c2 = hidden(codeHtml, "csrf");
  if (code.status !== 200 || !c2 || hidden(codeHtml, "step") !== "decide")
    throw new BusError(`bus approve code: status ${code.status}`);
  const decide = await page("/bus/approve", {
    method: "POST",
    body: form({
      csrf: c2,
      step: "decide",
      code: d.user_code,
      decision: "approve",
    }),
  });
  await decide.text();
  if (decide.status !== 200)
    throw new BusError(`bus approve decide: status ${decide.status}`);
  const gap = (typeof d.interval === "number" ? d.interval : 5) * 1000;
  for (let i = 0; i < (o.polls ?? 6); i++) {
    const t = await s.fetch(`${s.app}/bus/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: d.device_code }),
      redirect: "manual",
    });
    if (t.status === 429) {
      await t.text();
      await wait(gap);
      continue;
    }
    if (t.status !== 200) throw new BusError(`bus token: status ${t.status}`);
    const j = (await t.json()) as { status?: unknown; machine_token?: unknown };
    if (j.status === "approved" && typeof j.machine_token === "string")
      return j.machine_token;
    if (j.status !== "pending")
      throw new BusError(`bus token: ${String(j.status)}`);
    await wait(gap);
  }
  throw new BusError("bus token: not approved after the polls");
}

/**
 * Revokes every machine of the PAT's member whose label is `label` (the
 * cleanup of mintMachine). Returns how many it revoked; a 204 or a 404 on
 * the delete counts as gone.
 */
export async function revokeMachines(
  s: BusSite,
  pat: string,
  label: string,
): Promise<number> {
  const list = await s.fetch(`${s.app}/api/v1/bus/machines`, {
    headers: bearer(pat),
    redirect: "manual",
  });
  if (list.status !== 200)
    throw new BusError(`bus machines: status ${list.status}`);
  const rows = (
    (await list.json()) as {
      machines?: { id?: unknown; label?: unknown; revokedAt?: unknown }[];
    }
  ).machines;
  let n = 0;
  for (const m of rows ?? []) {
    if (m.label !== label || m.revokedAt || typeof m.id !== "string") continue;
    const d = await s.fetch(
      `${s.app}/api/v1/bus/machines/${encodeURIComponent(m.id)}`,
      { method: "DELETE", headers: bearer(pat), redirect: "manual" },
    );
    await d.text();
    if (d.status !== 204 && d.status !== 200 && d.status !== 404)
      throw new BusError(`bus machine revoke: status ${d.status}`);
    n++;
  }
  return n;
}

/** The bus socket's upgrade request with a machine token (GET /bus/connect). */
export const connectRequest = (app: string, token: string): Request =>
  new Request(`${app}/bus/connect`, { headers: bearer(token) });

/** The first frame a client sends; the hub answers hello_ok. */
export const HELLO = JSON.stringify({
  v: 1,
  id: "h1",
  type: "hello",
  machine_label: "redline",
  client_version: "0.1.0",
});

/** How long a held socket may take to answer its hello. */
export const HELLO_WAIT_MS = 10_000;

/**
 * Opens a bus socket with `token`, says hello and waits for hello_ok, so a
 * 101 that the hub never accepted can't stand in for a live session. Any
 * other status returns a Held with nothing open. A 101 with no hello_ok is
 * closed and throws. Rejects with no response at all (wsHandshake's rule).
 */
export async function openBusSocket(
  app: string,
  token: string,
  hold: (r: Request) => Promise<Held> = holdSocket,
  helloMs = HELLO_WAIT_MS,
): Promise<Held> {
  const h = await hold(connectRequest(app, token));
  if (h.status !== 101) return h;
  h.send(HELLO);
  if (!(await h.waitText((t) => t.includes('"hello_ok"'), helloMs))) {
    h.destroy();
    throw new BusError("bus connect: 101 but no hello_ok");
  }
  return h;
}

/** Waits for `p` for at most `ms`; true when it settled, false when time ran out. */
export async function within(
  p: Promise<unknown>,
  ms: number,
  setT: typeof setTimeout = setTimeout,
  clearT: typeof clearTimeout = clearTimeout,
): Promise<boolean> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true),
      new Promise<boolean>((r) => {
        t = setT(() => r(false), ms);
      }),
    ]);
  } finally {
    if (t) clearT(t);
  }
}
