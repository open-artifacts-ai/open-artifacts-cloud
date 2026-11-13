import { describe, expect, it } from "vitest";
import {
  cfDoLister,
  type DoNamespace,
  type HubRecord,
  judge,
  recordAfter,
  recordBefore,
  show,
  stagingScript,
} from "../src/hub-wipe.ts";
import { PROBES } from "../src/provisioning.ts";
import { P54_NAME } from "../src/report.ts";

const TOKEN = "cfut_TOKEN_never_printed_0123456789";
const ACCT = "26ac346086d4405f7a976d48747a2a75";
const SCRIPT = "oa-s-i0abc";
const ns = (id: string, cls: string, script = SCRIPT): DoNamespace => ({
  id,
  class: cls,
  script,
});

/** A fetch stub over pages; records every call. */
function stub(pages: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; method?: string; auth: string | null }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      method: init?.method,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const page = new URL(u).searchParams.get("page") ?? "1";
    const r = pages[page];
    if (!r) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}
const ok = (result: unknown[], total_pages = 1) => ({
  body: { success: true, errors: [], result, result_info: { total_pages } },
});

describe("cfDoLister", () => {
  it("GETs every page with the bearer, keeps only the script's namespaces, and returns ids and classes", async () => {
    const s = stub({
      "1": ok(
        [
          { id: "a", class: "BusHub", script: SCRIPT, name: "x-BusHub" },
          { id: "b", class: "BusHub", script: "oa-s-other" },
        ],
        2,
      ),
      "2": ok([{ id: "c", class: "Other", script: SCRIPT }], 2),
    });
    const got = await cfDoLister(ACCT, () => TOKEN, s.f)(SCRIPT);
    expect(got.map((n) => `${n.id}:${n.class}`)).toEqual(["a:BusHub", "c:Other"]);
    expect(s.calls).toHaveLength(2);
    for (const c of s.calls) {
      expect(c.method).toBe("GET");
      expect(c.url).toContain(
        `/accounts/${ACCT}/workers/durable_objects/namespaces?`,
      );
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("names the status and the error codes only, never the body or the token", async () => {
    const s = stub({
      "1": {
        status: 403,
        body: {
          success: false,
          errors: [{ code: 10000, message: `denied ${TOKEN} SECRET_BODY` }],
        },
      },
    });
    const err = await cfDoLister(ACCT, () => TOKEN, s.f)(SCRIPT).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toBe(
      "list Durable Object namespaces: HTTP 403 codes=10000",
    );
  });

  it("fails on a success without a result list", async () => {
    const s = stub({ "1": { body: { success: true, result: {} } } });
    await expect(cfDoLister(ACCT, () => TOKEN, s.f)(SCRIPT)).rejects.toThrow(
      /HTTP 200/,
    );
  });
});

describe("the record around a delete", () => {
  const clock = () => {
    let t = 0;
    return {
      now: () => t,
      wait: async (ms: number) => {
        t += ms;
      },
    };
  };

  it("records a failed read instead of throwing", async () => {
    const rec = await recordBefore(async () => {
      throw new Error("list Durable Object namespaces: HTTP 403");
    }, SCRIPT);
    expect(rec).toEqual({
      script: SCRIPT,
      error: "list Durable Object namespaces: HTTP 403",
    });
  });

  it("polls until none is left, within the bound", async () => {
    let reads = 0;
    const rec: HubRecord = { script: SCRIPT, before: [ns("a", "BusHub")] };
    await recordAfter(
      async () => (++reads < 3 ? [ns("a", "BusHub")] : []),
      rec,
      { ...clock(), withinMs: 60_000, pollMs: 5_000 },
    );
    expect(rec.after).toEqual([]);
    expect(reads).toBe(3);
  });

  it("gives up at the bound with what is still there", async () => {
    const rec: HubRecord = { script: SCRIPT, before: [ns("a", "BusHub")] };
    await recordAfter(async () => [ns("a", "BusHub")], rec, {
      ...clock(),
      withinMs: 20_000,
      pollMs: 5_000,
    });
    expect(rec.after).toEqual([ns("a", "BusHub")]);
  });
});

describe("judge", () => {
  const rec = (r: Partial<HubRecord>): HubRecord => ({ script: SCRIPT, ...r });
  it("passes: namespaces with BusHub before, none after", () => {
    const v = judge(
      rec({
        before: [ns("a", "BusHub"), ns("b", "Other")],
        after: [],
      }),
    );
    expect(v).toEqual({
      ok: true,
      note: `${SCRIPT}: 2 Durable Object namespace(s) before the delete (a:BusHub, b:Other), none after`,
    });
  });
  it("fails when none is listed before (the list does not show them)", () => {
    const v = judge(rec({ before: [], after: [] }));
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ reason: /had no Durable Object namespace before/ });
  });
  it("fails when BusHub is not among them", () => {
    const v = judge(rec({ before: [ns("b", "Other")], after: [] }));
    expect(v).toMatchObject({ ok: false, reason: /no BusHub namespace/ });
  });
  it("fails when any survives, naming ids and classes only", () => {
    const v = judge(
      rec({ before: [ns("a", "BusHub")], after: [ns("a", "BusHub")] }),
    );
    expect(v).toMatchObject({
      ok: false,
      reason: /left Durable Object namespaces behind.*a:BusHub \(before: a:BusHub\)/,
    });
  });
  it("fails on a recorded read error and on no record", () => {
    expect(judge(rec({ error: "list x: HTTP 403 codes=10000" }))).toEqual({
      ok: false,
      reason: `${SCRIPT}: list x: HTTP 403 codes=10000`,
    });
    expect(judge(undefined).ok).toBe(false);
  });
  it("shows ids and classes sorted, or none", () => {
    expect(show([ns("b", "Y"), ns("a", "X")])).toBe("a:X, b:Y");
    expect(show([])).toBe("none");
    expect(stagingScript("i0abc")).toBe(SCRIPT);
  });
});

describe("P54", () => {
  it("is named as the accepted-unproven entry and the manifest say", () => {
    const p = PROBES.find((x) => x.id === "P54");
    expect(`provisioning > P54: ${p?.title}`).toBe(P54_NAME);
    expect(p?.needs).toEqual(["P13", "P23"]);
  });
});
