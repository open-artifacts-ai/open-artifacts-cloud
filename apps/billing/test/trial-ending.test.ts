import { applyD1Migrations } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import billing, { type Env } from "../src/index.js";

// GET /solo/trial-ending: the scheduler's trial-reminder read, binding only.

const db = (testEnv as unknown as { BILLING_DB: D1Database }).BILLING_DB;
const env = { BILLING_DB: db } as Env;

beforeAll(async () => {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
});
beforeEach(async () => {
  await db.prepare("DELETE FROM tiers").run();
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 9, 12, 0);
const id = (n: number) => `i${String(n).padStart(11, "0")}`;

async function row(
  n: number,
  o: {
    tier?: string;
    status?: string;
    ends: number | null;
    soloStatus?: string;
    checkedOut?: boolean;
  },
) {
  await db
    .prepare(
      "INSERT INTO tiers (install_id, tier, status, solo_trial_ends_at, solo_status, solo_checked_out, version, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 0)",
    )
    .bind(
      id(n),
      o.tier ?? "solo",
      o.status ?? "active",
      o.ends,
      o.soloStatus ?? null,
      o.checkedOut ? 1 : null,
    )
    .run();
}

const get = (qs: string, headers: Record<string, string> = {}) =>
  billing.fetch(
    new Request(`https://billing.internal/solo/trial-ending?${qs}`, {
      headers,
    }) as Parameters<typeof billing.fetch>[0],
    env,
  );
const win = (extra = "") =>
  `from=${NOW}&to=${NOW + 7 * DAY}${extra ? `&${extra}` : ""}`;

describe("GET /solo/trial-ending", () => {
  it("lists live Solo trials ending in (from, to] with their end", async () => {
    await row(1, { ends: NOW + 6 * DAY });
    await row(2, { ends: NOW + 7 * DAY }); // upper bound inclusive
    await row(3, { ends: NOW }); // lower bound exclusive
    await row(4, { ends: NOW + 8 * DAY });
    const r = await get(win());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      installs: [
        { installId: id(1), trialEndsAt: NOW + 6 * DAY },
        { installId: id(2), trialEndsAt: NOW + 7 * DAY },
      ],
      next: null,
    });
  });

  it("skips paid (end in the past), no trial, other tiers and lapsed rows", async () => {
    await row(1, { ends: NOW - DAY });
    await row(2, { ends: null });
    await row(3, { tier: "team", ends: NOW + 3 * DAY });
    await row(4, { tier: "trial", ends: NOW + 3 * DAY }); // no live Solo under it
    await row(7, { tier: "trial", soloStatus: "lapsed", ends: NOW + 3 * DAY });
    await row(5, { status: "lapsed", ends: NOW + 3 * DAY });
    await row(6, { status: "suspended", ends: NOW + 3 * DAY });
    expect(await (await get(win())).json()).toEqual({
      installs: [],
      next: null,
    });
  });

  it("lists a Solo trial kept live under the Business trial", async () => {
    await row(1, { tier: "trial", soloStatus: "active", ends: NOW + 3 * DAY });
    expect(await (await get(win())).json()).toEqual({
      installs: [{ installId: id(1), trialEndsAt: NOW + 3 * DAY }],
      next: null,
    });
  });

  it("skips an install that checked out during the trial (a card is on file)", async () => {
    await row(1, { checkedOut: true, ends: NOW + 3 * DAY });
    await row(2, {
      tier: "trial",
      soloStatus: "active",
      checkedOut: true,
      ends: NOW + 3 * DAY,
    });
    await row(3, { ends: NOW + 3 * DAY });
    expect(await (await get(win())).json()).toEqual({
      installs: [{ installId: id(3), trialEndsAt: NOW + 3 * DAY }],
      next: null,
    });
  });

  it("pages by install id with a cursor", async () => {
    for (const n of [1, 2, 3]) await row(n, { ends: NOW + DAY });
    const a = (await (await get(win("limit=2"))).json()) as {
      installs: { installId: string }[];
      next: string | null;
    };
    expect(a.installs.map((i) => i.installId)).toEqual([id(1), id(2)]);
    expect(a.next).toBe(id(2));
    const b = (await (await get(win(`limit=2&after=${a.next}`))).json()) as {
      installs: { installId: string }[];
      next: string | null;
    };
    expect(b.installs.map((i) => i.installId)).toEqual([id(3)]);
    expect(b.next).toBeNull();
  });

  it("rejects a bad query", async () => {
    for (const qs of [
      "",
      "from=x&to=1",
      `from=${NOW}&to=${NOW - 1}`,
      win("after=nope"),
      win("limit=0"),
    ])
      expect((await get(qs)).status, qs).toBe(400);
  });

  it("is a plain 404 for an internet request (cf-connecting-ip)", async () => {
    await row(1, { ends: NOW + DAY });
    const r = await get(win(), { "cf-connecting-ip": "1.2.3.4" });
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("Not found");
  });
});
