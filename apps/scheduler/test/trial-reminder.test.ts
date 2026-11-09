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
import {
  REMINDER_ALERT_KEY,
  REMINDER_GATE_KEY,
  REMINDER_MAX_SENDS,
  trialRemindersDue,
  UNSENT_MS,
} from "../src/trial-reminder.js";
import {
  captureLogs,
  db,
  install,
  installId,
  lifecycle,
  migrate,
  reset,
  rows,
  signup,
} from "./provapi/db.js";

// The self-serve trial-ending reminder: billing lists the Solo trials ending
// in the next 7 days; only a self-serve, active, unsuspended install with no
// reminder row is mailed, once.

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 9, 12, 0);

interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

function fakes(
  trials: { installId: string; trialEndsAt: number }[],
  o: { sendFails?: boolean; billing?: "500" | "bad" } = {},
) {
  const queries: URLSearchParams[] = [];
  const mails: Mail[] = [];
  const alerts: { subject: string; text: string; to: string }[] = [];
  const BILLING = {
    fetch: async (input: string) => {
      const u = new URL(input);
      expect(u.pathname).toBe("/solo/trial-ending");
      queries.push(u.searchParams);
      if (o.billing === "500") return new Response("x", { status: 500 });
      if (o.billing === "bad") return Response.json({ nope: true });
      const from = Number(u.searchParams.get("from"));
      const to = Number(u.searchParams.get("to"));
      return Response.json({
        installs: trials.filter(
          (t) => t.trialEndsAt > from && t.trialEndsAt <= to,
        ),
        next: null,
      });
    },
  } as unknown as Fetcher;
  const env = {
    PLATFORM_DB: db,
    OA_ENV: "staging",
    BILLING,
    REMINDER_FROM: "hello@mail.test",
    REMINDER_EMAIL: {
      send: async (m: Mail) => {
        if (o.sendFails)
          throw Object.assign(new Error("secret"), { code: "E_X" });
        mails.push(m);
      },
    },
    ALERT_TO: "ops@ops.test",
    ALERT_FROM: "alerts@ops.test",
    ALERT_EMAIL: {
      send: async (m: { subject: string; text: string; to: string }) => {
        alerts.push(m);
      },
    },
  } as unknown as ProvapiEnv;
  return { env, queries, mails, alerts };
}

/** A ready self-serve install; returns its id. */
async function selfServe(over: Record<string, string | number | null> = {}) {
  const id = installId();
  const row = await install(id, over);
  await signup({
    source: "self-serve",
    owner_sub: `sub-${id}`,
    install_id: id,
    status: "ready",
  });
  return { id, row };
}

const reminders = () =>
  rows("SELECT * FROM trial_reminders ORDER BY install_id");

describe("trial reminder: the due window", () => {
  it("mails a self-serve install whose trial ends in 7 days, with the link and date", async () => {
    const { id, row } = await selfServe();
    const end = NOW + 6 * DAY + 3 * HOUR;
    const f = fakes([{ installId: id, trialEndsAt: end }]);
    await trialRemindersDue(f.env, NOW);
    expect(f.mails).toHaveLength(1);
    const m = f.mails[0] as Mail;
    expect(m.to).toBe(row.owner_email);
    expect(m.from).toBe("hello@mail.test");
    expect(m.subject).toContain("Nov 15");
    expect(m.text).toContain(`https://${row.app_host}/settings/plan`);
    expect(m.html).toContain(`href="https://${row.app_host}/settings/plan"`);
    expect(m.html).toContain("v:roundrect");
    // The copy is true only for a no-card trial: billing's list skips an
    // install that checked out, so every recipient has no card on file.
    expect(m.html).toContain("there is no card on file yet");
    expect(m.text).toContain("there is no card on file yet");
    expect(m.text).not.toMatch(/—/);
    const [r] = await reminders();
    expect(r).toMatchObject({
      install_id: id,
      trial_ends_at: end,
      claimed_at: NOW,
      sent_at: NOW,
    });
  });

  it("asks billing for (now + 1 day, now + 7 days]", async () => {
    const f = fakes([]);
    await trialRemindersDue(f.env, NOW);
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]?.get("from")).toBe(String(NOW + DAY));
    expect(f.queries[0]?.get("to")).toBe(String(NOW + 7 * DAY));
  });

  it("does nothing for a trial more than 7 days out or under a day away", async () => {
    const a = await selfServe();
    const b = await selfServe();
    const f = fakes([
      { installId: a.id, trialEndsAt: NOW + 7 * DAY + HOUR },
      { installId: b.id, trialEndsAt: NOW + HOUR },
    ]);
    await trialRemindersDue(f.env, NOW);
    expect(f.mails).toEqual([]);
    expect(await reminders()).toEqual([]);
  });
});

describe("trial reminder: at most once", () => {
  it("a second run, even after the gate, sends nothing more", async () => {
    const { id } = await selfServe();
    const f = fakes([{ installId: id, trialEndsAt: NOW + 5 * DAY }]);
    await trialRemindersDue(f.env, NOW);
    await trialRemindersDue(f.env, NOW + 2 * HOUR);
    await trialRemindersDue(f.env, NOW + DAY);
    expect(f.mails).toHaveLength(1);
    expect(await reminders()).toHaveLength(1);
  });

  it("the hourly gate: a tick inside the hour does not ask billing", async () => {
    const f = fakes([]);
    await trialRemindersDue(f.env, NOW);
    await trialRemindersDue(f.env, NOW + 2 * 60_000);
    expect(f.queries).toHaveLength(1);
    await trialRemindersDue(f.env, NOW + HOUR);
    expect(f.queries).toHaveLength(2);
  });

  it("two overlapping runs send once (the claim is the INSERT)", async () => {
    const { id } = await selfServe();
    const f = fakes([{ installId: id, trialEndsAt: NOW + 5 * DAY }]);
    await db.prepare("DELETE FROM platform_state").run();
    // Same instant, gate bypassed for the second by clearing it between: both
    // reach the claim; only one inserts.
    const a = trialRemindersDue(f.env, NOW);
    await a;
    await db
      .prepare("DELETE FROM platform_state WHERE key = ?1")
      .bind(REMINDER_GATE_KEY)
      .run();
    await trialRemindersDue(f.env, NOW);
    expect(f.mails).toHaveLength(1);
  });
});

describe("trial reminder: who is skipped", () => {
  it("not self-serve (an admin create)", async () => {
    const id = installId();
    await install(id);
    await signup({ source: "admin", install_id: id, status: "ready" });
    const f = fakes([{ installId: id, trialEndsAt: NOW + 3 * DAY }]);
    await trialRemindersDue(f.env, NOW);
    expect(f.mails).toEqual([]);
    expect(await reminders()).toEqual([]);
  });

  it("an install with no signup row at all", async () => {
    const id = installId();
    await install(id);
    const f = fakes([{ installId: id, trialEndsAt: NOW + 3 * DAY }]);
    await trialRemindersDue(f.env, NOW);
    expect(f.mails).toEqual([]);
  });

  it("not active (deleting), suspended, or a signup that is not ready", async () => {
    const del = await selfServe({ state: "deleting" });
    const sus = await selfServe();
    await lifecycle(sus.id, { suspended_at: 5 });
    const id = installId();
    await install(id);
    await signup({
      source: "self-serve",
      owner_sub: "s",
      install_id: id,
      status: "creating",
    });
    const f = fakes(
      [del.id, sus.id, id].map((installId) => ({
        installId,
        trialEndsAt: NOW + 3 * DAY,
      })),
    );
    await trialRemindersDue(f.env, NOW);
    expect(f.mails).toEqual([]);
    expect(await reminders()).toEqual([]);
  });

  it("paid (billing no longer lists it) and a purged owner address", async () => {
    const paid = await selfServe();
    const purged = await selfServe({ owner_email: "" });
    const f = fakes([{ installId: purged.id, trialEndsAt: NOW + 3 * DAY }]);
    // `paid` is simply absent from billing's list: its trial end is past.
    void paid;
    await trialRemindersDue(f.env, NOW);
    expect(f.mails).toEqual([]);
    expect(await reminders()).toEqual([]);
  });

  it("an id billing lists that the platform does not know", async () => {
    const f = fakes([{ installId: installId(), trialEndsAt: NOW + 3 * DAY }]);
    await trialRemindersDue(f.env, NOW);
    expect(f.mails).toEqual([]);
  });

  it("does nothing when unwired (no BILLING, REMINDER_EMAIL or REMINDER_FROM)", async () => {
    const { id } = await selfServe();
    for (const drop of ["BILLING", "REMINDER_EMAIL", "REMINDER_FROM"]) {
      const f = fakes([{ installId: id, trialEndsAt: NOW + 3 * DAY }]);
      (f.env as unknown as Record<string, unknown>)[drop] = undefined;
      await trialRemindersDue(f.env, NOW);
      expect(f.mails, drop).toEqual([]);
    }
    expect(await reminders()).toEqual([]);
  });
});

describe("trial reminder: failures", () => {
  it("a failed send keeps its claim (no second email) and logs a fixed category", async () => {
    const { id } = await selfServe();
    const lines = captureLogs(vi.spyOn);
    const f = fakes([{ installId: id, trialEndsAt: NOW + 3 * DAY }], {
      sendFails: true,
    });
    await trialRemindersDue(f.env, NOW);
    const [r] = await reminders();
    expect(r).toMatchObject({ install_id: id, claimed_at: NOW, sent_at: null });
    expect(lines).toContain(`provapi reminders send_failed ${id} E_X`);
    expect(lines.join("\n")).not.toContain("secret");
    // The next hourly run does not retry it.
    const g = fakes([{ installId: id, trialEndsAt: NOW + 3 * DAY }]);
    await trialRemindersDue(g.env, NOW + HOUR);
    expect(g.mails).toEqual([]);
  });

  it("alerts the operator, once a day, when a claim stays unsent; not before UNSENT_MS", async () => {
    const { id } = await selfServe();
    const f = fakes([{ installId: id, trialEndsAt: NOW + 3 * DAY }], {
      sendFails: true,
    });
    await trialRemindersDue(f.env, NOW);
    await trialRemindersDue(f.env, NOW + UNSENT_MS - 1);
    expect(f.alerts).toEqual([]);
    await trialRemindersDue(f.env, NOW + UNSENT_MS);
    expect(f.alerts).toHaveLength(1);
    const a = f.alerts[0];
    expect(a?.to).toBe("ops@ops.test");
    expect(a?.subject).toBe("Open Artifacts staging: trial reminder unsent");
    expect(a?.text).toContain("1 trial-ending reminder email was claimed");
    // Not again within the day; again after it.
    await trialRemindersDue(f.env, NOW + 2 * HOUR);
    expect(f.alerts).toHaveLength(1);
    await trialRemindersDue(f.env, NOW + UNSENT_MS + DAY);
    expect(f.alerts).toHaveLength(2);
  });

  it("no alert once the row is sent, and a failed alert send is retried next tick", async () => {
    const { id } = await selfServe();
    const f = fakes([{ installId: id, trialEndsAt: NOW + 3 * DAY }]);
    await trialRemindersDue(f.env, NOW);
    await trialRemindersDue(f.env, NOW + DAY);
    expect(f.alerts).toEqual([]);

    await db.prepare("UPDATE trial_reminders SET sent_at = NULL").run();
    let fail = true;
    const sent: unknown[] = [];
    (f.env as unknown as { ALERT_EMAIL: unknown }).ALERT_EMAIL = {
      send: async (m: unknown) => {
        if (fail) throw new Error("down");
        sent.push(m);
      },
    };
    await trialRemindersDue(f.env, NOW + 2 * DAY);
    expect(sent).toEqual([]);
    fail = false;
    await trialRemindersDue(f.env, NOW + 2 * DAY + 2 * 60_000);
    expect(sent).toHaveLength(1);
    const state = await rows(
      "SELECT value FROM platform_state WHERE key = ?1",
      REMINDER_ALERT_KEY,
    );
    expect(state).toHaveLength(1);
  });

  it("billing down or malformed: no sends, the gate is given back, the duty fails with a category", async () => {
    const { id } = await selfServe();
    for (const [mode, cat] of [
      ["500", "rpc_error"],
      ["bad", "parse_error"],
    ] as const) {
      const f = fakes([{ installId: id, trialEndsAt: NOW + 3 * DAY }], {
        billing: mode,
      });
      await expect(trialRemindersDue(f.env, NOW)).rejects.toMatchObject({
        category: cat,
      });
      expect(f.mails).toEqual([]);
      expect(
        await rows(
          "SELECT 1 FROM platform_state WHERE key = ?1",
          REMINDER_GATE_KEY,
        ),
      ).toEqual([]);
    }
  });

  it("stops at the time budget and gives the hour back for the next tick", async () => {
    const { id } = await selfServe();
    const f = fakes([{ installId: id, trialEndsAt: NOW + 3 * DAY }]);
    await trialRemindersDue(f.env, NOW, 0);
    expect(f.mails).toEqual([]);
    await trialRemindersDue(f.env, NOW + 2 * 60_000);
    expect(f.mails).toHaveLength(1);
  });

  it("caps sends per run and finishes on the next tick, not the next hour", async () => {
    const ids: string[] = [];
    for (let i = 0; i < REMINDER_MAX_SENDS + 3; i++)
      ids.push((await selfServe()).id);
    const f = fakes(
      ids.map((installId) => ({ installId, trialEndsAt: NOW + 3 * DAY })),
    );
    await trialRemindersDue(f.env, NOW);
    expect(f.mails).toHaveLength(REMINDER_MAX_SENDS);
    await trialRemindersDue(f.env, NOW + 2 * 60_000);
    expect(f.mails).toHaveLength(REMINDER_MAX_SENDS + 3);
    expect(new Set(f.mails.map((m) => m.to)).size).toBe(REMINDER_MAX_SENDS + 3);
  });
});
