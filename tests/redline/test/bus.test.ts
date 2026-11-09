import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  BusError,
  busState,
  connectRequest,
  HELLO,
  mintMachine,
  openBusSocket,
  revokeMachines,
  within,
} from "../src/bus.ts";
import { liveBusIo } from "../src/provisioning-live.ts";
import { holdSocket, textFrame } from "../src/ws.ts";

// #1299 part 4: the helpers the hosted bus cases stand on, against fakes (no
// network but a loopback socket). A bus case that cannot tell a broken bus
// from an off one, or that leaks a token into a message, proves nothing.

const APP = "https://rl-l.example.test";
const TOKEN = "oa_machine_secretsecretsecret";
const PAT = "oat_secret_pat_value";
const COOKIE = "__Host-oa_session=sesssecret";

type Handler = (req: Request) => Response | Promise<Response>;
const site = (h: Handler) => ({
  app: APP,
  fetch: (async (u: string | URL | Request, i?: RequestInit) =>
    h(new Request(String(u), i))) as typeof fetch,
});

describe("busState", () => {
  const ping = (res: Response) => site(() => res);
  it("200 { ok: true } is on; 404 is off", async () => {
    expect(await busState(ping(Response.json({ ok: true })), PAT)).toBe("on");
    expect(
      await busState(ping(Response.json({ error: "x" }, { status: 404 })), PAT),
    ).toBe("off");
  });
  it("sends the PAT as a bearer to the ping route", async () => {
    let seen: Request | undefined;
    await busState(
      site((r) => {
        seen = r;
        return Response.json({ ok: true });
      }),
      PAT,
    );
    expect(seen?.url).toBe(`${APP}/api/v1/bus/ping`);
    expect(seen?.headers.get("authorization")).toBe(`Bearer ${PAT}`);
  });
  it("anything else is a broken bus, never off: 401, 503, a wrong body", async () => {
    for (const res of [
      new Response("no", { status: 401 }),
      new Response("no", { status: 503 }),
      Response.json({ ok: false }),
      new Response("not json"),
      Response.json({}),
    ])
      await expect(busState(ping(res.clone()), PAT)).rejects.toBeInstanceOf(
        BusError,
      );
  });
  it("a failure message never carries the PAT", async () => {
    const e = await busState(
      site(() => new Response(PAT, { status: 500 })),
      PAT,
    ).catch((x: Error) => x);
    expect((e as Error).message).not.toContain(PAT);
  });
});

/** An in-memory /bus device flow: the entry form, the code step, the decide step, the token poll. */
function deviceFlow(
  o: {
    pendingPolls?: number;
    denyDecide?: boolean;
    noCookieAt?: string;
    badCodeStep?: boolean;
  } = {},
) {
  const seen: string[] = [];
  let polls = 0;
  let approved = false;
  const handler: Handler = async (req) => {
    const u = new URL(req.url);
    seen.push(`${req.method} ${u.pathname}`);
    const needsCookie = u.pathname === "/bus/approve";
    if (needsCookie && req.headers.get("cookie") !== COOKIE)
      return new Response("signed out", { status: 401 });
    if (u.pathname === "/bus/device")
      return Response.json(
        {
          device_code: "dev-secret",
          user_code: "ABCD-EFGH",
          interval: 0,
        },
        { status: 201 },
      );
    if (u.pathname === "/bus/approve" && req.method === "GET")
      return new Response('<input type="hidden" name="csrf" value="c-entry">');
    if (u.pathname === "/bus/approve") {
      const f = new URLSearchParams(await req.text());
      if (f.get("step") === "code")
        return f.get("csrf") === "c-entry" &&
          f.get("code") === "ABCD-EFGH" &&
          !o.badCodeStep
          ? new Response(
              '<input type="hidden" name="csrf" value="c-decide"><input type="hidden" name="step" value="decide">',
            )
          : new Response("wrong", { status: 200 });
      if (f.get("step") === "decide") {
        if (
          f.get("csrf") !== "c-decide" ||
          f.get("code") !== "ABCD-EFGH" ||
          f.get("decision") !== "approve"
        )
          return new Response("expired", { status: 403 });
        approved = !o.denyDecide;
        return new Response("ok");
      }
    }
    if (u.pathname === "/bus/device/token") {
      const b = (await req.json()) as { device_code?: string };
      if (b.device_code !== "dev-secret")
        return new Response("x", { status: 400 });
      if (++polls <= (o.pendingPolls ?? 0))
        return Response.json({ status: "pending" });
      return approved
        ? Response.json({ status: "approved", machine_token: TOKEN })
        : Response.json({ status: "pending" });
    }
    return new Response("?", { status: 404 });
  };
  return { handler, seen };
}

describe("mintMachine", () => {
  const noWait = async () => {};
  it("runs the device flow end to end with the session and returns the token", async () => {
    const f = deviceFlow({ pendingPolls: 2 });
    const t = await mintMachine(site(f.handler), COOKIE, "redline-x", {
      wait: noWait,
    });
    expect(t).toBe(TOKEN);
    expect(f.seen).toEqual([
      "POST /bus/device",
      "GET /bus/approve",
      "POST /bus/approve",
      "POST /bus/approve",
      "POST /bus/device/token",
      "POST /bus/device/token",
      "POST /bus/device/token",
    ]);
  });
  it("a signed-out session fails at the approval page, naming the step and status only", async () => {
    const f = deviceFlow();
    const e = await mintMachine(site(f.handler), "other=1", "l", {
      wait: noWait,
    }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(BusError);
    expect((e as Error).message).toBe("bus approve page: status 401");
  });
  it("a code step that does not show the decide form fails", async () => {
    const f = deviceFlow({ badCodeStep: true });
    await expect(
      mintMachine(site(f.handler), COOKIE, "l", { wait: noWait }),
    ).rejects.toThrow(/bus approve code/);
  });
  it("never approved within the polls: fails, and no message holds the token or the codes", async () => {
    const f = deviceFlow({ denyDecide: true });
    const e = await mintMachine(site(f.handler), COOKIE, "l", {
      wait: noWait,
      polls: 3,
    }).catch((x: Error) => x);
    expect((e as Error).message).toBe(
      "bus token: not approved after the polls",
    );
    for (const secret of [TOKEN, "dev-secret", "ABCD-EFGH", COOKIE])
      expect((e as Error).message).not.toContain(secret);
  });
  it("a 429 on the token poll waits and polls again", async () => {
    let n = 0;
    const f = deviceFlow();
    const h: Handler = async (req) => {
      if (new URL(req.url).pathname === "/bus/device/token" && ++n === 1)
        return new Response("slow", { status: 429 });
      return f.handler(req);
    };
    expect(await mintMachine(site(h), COOKIE, "l", { wait: noWait })).toBe(
      TOKEN,
    );
  });
});

describe("revokeMachines", () => {
  it("revokes the active machines with the label, only those", async () => {
    const calls: string[] = [];
    const h: Handler = (req) => {
      const u = new URL(req.url);
      calls.push(`${req.method} ${u.pathname}`);
      if (req.method === "GET")
        return Response.json({
          machines: [
            { id: "m1", label: "mine", revokedAt: null },
            { id: "m2", label: "other", revokedAt: null },
            { id: "m3", label: "mine", revokedAt: "2026-01-01" },
            { id: "m4", label: "mine", revokedAt: null },
          ],
        });
      return new Response(null, { status: 204 });
    };
    expect(await revokeMachines(site(h), PAT, "mine")).toBe(2);
    expect(calls).toEqual([
      "GET /api/v1/bus/machines",
      "DELETE /api/v1/bus/machines/m1",
      "DELETE /api/v1/bus/machines/m4",
    ]);
  });
  it("a refusal on the delete fails, naming only a status", async () => {
    const h: Handler = (req) =>
      req.method === "GET"
        ? Response.json({
            machines: [{ id: "m1", label: "l", revokedAt: null }],
          })
        : new Response("no", { status: 500 });
    await expect(revokeMachines(site(h), PAT, "l")).rejects.toThrow(
      "bus machine revoke: status 500",
    );
  });
});

describe("within", () => {
  it("true when the promise settles first, false when the time runs out", async () => {
    expect(await within(Promise.resolve(), 1000)).toBe(true);
    expect(await within(new Promise(() => {}), 5)).toBe(false);
  });
});

describe("textFrame", () => {
  it("is one masked, final text frame whose payload unmasks to the text", () => {
    for (const text of ["hi", "x".repeat(200)]) {
      const f = textFrame(text);
      expect(f[0]).toBe(0x81);
      expect((f[1] as number) & 0x80).toBe(0x80);
      const long = ((f[1] as number) & 0x7f) === 126;
      const len = long
        ? (f[2] as number) * 256 + (f[3] as number)
        : (f[1] as number) & 0x7f;
      const at = long ? 4 : 2;
      expect(len).toBe(text.length);
      const mask = f.subarray(at, at + 4);
      const body = Buffer.from(f.subarray(at + 4));
      for (let i = 0; i < body.length; i++)
        body[i] = (body[i] as number) ^ (mask[i % 4] as number);
      expect(body.toString("utf8")).toBe(text);
    }
  });
  it("refuses a payload past the short forms", () => {
    expect(() => textFrame("x".repeat(70_000))).toThrow();
  });
});

describe("holdSocket on a loopback server", () => {
  let server: Server | undefined;
  const sockets: Socket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });
  const start = async (
    on: (s: Socket, headers: Record<string, unknown>) => void,
    status = 101,
  ) => {
    server = createServer((_req, res) => {
      res.statusCode = 401;
      res.end("no");
    });
    server.on("upgrade", (req, socket: Socket) => {
      sockets.push(socket);
      if (status !== 101) {
        socket.end(`HTTP/1.1 ${status} X\r\nconnection: close\r\n\r\n`);
        return;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
      );
      on(socket, req.headers);
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it("keeps the socket after a 101 and reports the server's close", async () => {
    let theirs!: Socket;
    const base = await start((s) => {
      theirs = s;
    });
    const h = await holdSocket(new Request(`${base}/bus/connect`));
    expect(h.status).toBe(101);
    expect(await within(h.closed, 50)).toBe(false);
    theirs.destroy();
    expect(await within(h.closed, 2000)).toBe(true);
  });

  it("sends the token as a bearer, upgrade headers and the hello frame", async () => {
    let headers: Record<string, unknown> = {};
    const frames: Buffer[] = [];
    const base = await start((s, h) => {
      headers = h;
      s.on("data", (b: Buffer) => frames.push(b));
    });
    const h = await openBusSocket(base, TOKEN);
    expect(h.status).toBe(101);
    // Let the frame arrive.
    for (let i = 0; i < 50 && frames.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    h.destroy();
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(String(headers.upgrade).toLowerCase()).toBe("websocket");
    expect(headers["sec-websocket-version"]).toBe("13");
    const f = Buffer.concat(frames);
    const mask = f.subarray(2, 6);
    const body = Buffer.from(f.subarray(6));
    for (let i = 0; i < body.length; i++)
      body[i] = (body[i] as number) ^ (mask[i % 4] as number);
    expect(body.toString("utf8")).toBe(HELLO);
  });

  it("a refusal returns its status and nothing open: closed already settled, destroy a no-op", async () => {
    const base = await start(() => {}, 401);
    const h = await holdSocket(connectRequest(base, TOKEN));
    expect(h.status).toBe(401);
    expect(await within(h.closed, 50)).toBe(true);
    h.send("ignored");
    h.destroy();
  });

  it("destroy ends our side, and a second destroy is safe", async () => {
    const base = await start(() => {});
    const h = await holdSocket(new Request(`${base}/bus/connect`));
    h.destroy();
    expect(await within(h.closed, 2000)).toBe(true);
    h.destroy();
  });
});

describe("liveBusIo (P51's live seam), up to the socket", () => {
  const HOOK = "hook-key-secret";
  const live = (h: Handler) => liveBusIo({}, site(h).fetch);
  const open = (io: ReturnType<typeof liveBusIo>) =>
    io.open({ app: APP, pat: PAT, hookKey: HOOK });

  it("a bus that answers 404 is off: nothing else is called", async () => {
    const seen: string[] = [];
    const io = live((r) => {
      seen.push(new URL(r.url).pathname);
      return new Response("nf", { status: 404 });
    });
    expect(await open(io)).toBe("off");
    expect(seen).toEqual(["/api/v1/bus/ping"]);
  });

  it("the session hook is called with rl-l's hook key as the admin test user", async () => {
    let hook: Request | undefined;
    const io = live((r) => {
      const p = new URL(r.url).pathname;
      if (p === "/api/v1/bus/ping") return Response.json({ ok: true });
      hook = r;
      return new Response("no", { status: 500 });
    });
    await expect(open(io)).rejects.toThrow(
      "P51: rl-l's session hook answered 500",
    );
    expect(hook?.url).toBe(`${APP}/__test/session`);
    expect(hook?.headers.get("authorization")).toBe(`Bearer ${HOOK}`);
    const b = (await hook?.json()) as { email: string; role: string };
    expect(b.role).toBe("admin");
    expect(b.email).toMatch(/^redline-admin@/);
  });

  it("a failed machine mint fails the probe with the step and status, no secret", async () => {
    const f = deviceFlow();
    const io = live((r) => {
      const p = new URL(r.url).pathname;
      if (p === "/api/v1/bus/ping") return Response.json({ ok: true });
      if (p === "/__test/session") return Response.json({ cookie: "other" });
      return f.handler(r);
    });
    const e = await open(io).catch((x: Error) => x);
    expect((e as Error).message).toBe("P51: bus approve page: status 401");
    for (const s of [HOOK, PAT, "other"])
      expect((e as Error).message).not.toContain(s);
  });
});
