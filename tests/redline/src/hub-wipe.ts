// Does deleting an install delete its Durable Object namespaces, and with
// them the BusHub data (mail, agents, links)? (open-artifacts#2360.)
// Cloudflare's docs for the WfP script DELETE say its `force` flag deletes the
// namespaces "implemented by the deleted script even if other Workers
// reference them", but not what a plain DELETE does to the script's own
// classes. P54 reads it off staging: the account's Durable Object namespaces
// (GET /accounts/{id}/workers/durable_objects/namespaces: id, class, name,
// script, use_sqlite) filtered on the install's script, before and after the
// delete job of P23. GET only; ids and classes are the only things printed.

export const HUB_CLASS = "BusHub";
/** The staging Worker script name of an install (packages/provision names()). */
export const stagingScript = (installId: string): string => `oa-s-${installId}`;

export interface DoNamespace {
  id: string;
  class: string;
  script: string;
  name?: string;
}

/** The account's namespaces whose script is `script`. */
export type DoLister = (script: string) => Promise<DoNamespace[]>;

const API = "https://api.cloudflare.com/client/v4";
const PER_PAGE = 1000;
const MAX_PAGES = 100;

/** Cloudflare error codes of a response, numbers only: never a message or body. */
function codes(json: unknown): string {
  const errs = (json as { errors?: { code?: unknown }[] } | undefined)?.errors;
  const c = Array.isArray(errs)
    ? errs.map((e) => e?.code).filter((x) => typeof x === "number")
    : [];
  return c.length > 0 ? ` codes=${c.join(",")}` : "";
}

/**
 * The lister over the Cloudflare API, with a token that can read Workers
 * scripts. Every request is a GET; a failure names the status and the error
 * codes only. The token is read when first needed and never printed.
 */
export function cfDoLister(
  accountId: string,
  token: () => string,
  f: typeof fetch = fetch,
): DoLister {
  return async (script) => {
    const out: DoNamespace[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await f(
        `${API}/accounts/${accountId}/workers/durable_objects/namespaces?per_page=${PER_PAGE}&page=${page}`,
        { method: "GET", headers: { authorization: `Bearer ${token()}` } },
      );
      let json: unknown;
      try {
        json = JSON.parse(await res.text());
      } catch {
        json = undefined;
      }
      const j = json as
        | {
            success?: unknown;
            result?: unknown;
            result_info?: { total_pages?: unknown };
          }
        | undefined;
      if (res.status !== 200 || j?.success !== true || !Array.isArray(j.result))
        throw new Error(
          `list Durable Object namespaces: HTTP ${res.status}${codes(json)}`,
        );
      for (const n of j.result as Record<string, unknown>[])
        if (n?.script === script)
          out.push({
            id: String(n.id),
            class: String(n.class),
            script,
            ...(typeof n.name === "string" ? { name: n.name } : {}),
          });
      const pages = j.result_info?.total_pages;
      if (typeof pages !== "number" || page >= pages) return out;
    }
    throw new Error("list Durable Object namespaces: the listing did not end");
  };
}

/** What P23 saw around its delete; P54 judges it. */
export interface HubRecord {
  script: string;
  before?: DoNamespace[];
  after?: DoNamespace[];
  /** A failed read, status and codes only. */
  error?: string;
}

/** ids and classes only, sorted: "id:Class, id:Class". */
export const show = (ns: readonly DoNamespace[]): string =>
  ns.length === 0
    ? "none"
    : ns
        .map((n) => `${n.id}:${n.class}`)
        .sort()
        .join(", ");

const message = (e: unknown): string =>
  e instanceof Error ? e.message : "unknown error";

/** The namespaces before the delete. Never throws: a failed read is recorded. */
export async function recordBefore(
  list: DoLister,
  script: string,
): Promise<HubRecord> {
  try {
    return { script, before: await list(script) };
  } catch (e) {
    return { script, error: message(e) };
  }
}

export interface Settle {
  now: () => number;
  wait: (ms: number) => Promise<void>;
  /** How long the namespaces may take to go. */
  withinMs: number;
  pollMs: number;
}

/**
 * After the delete job is done: reads until none is left for the script or
 * `withinMs` passes, and records the last read in rec.after. Never throws.
 */
export async function recordAfter(
  list: DoLister,
  rec: HubRecord,
  s: Settle,
): Promise<void> {
  if (rec.error !== undefined) return;
  const deadline = s.now() + s.withinMs;
  for (;;) {
    try {
      rec.after = await list(rec.script);
    } catch (e) {
      rec.error = message(e);
      return;
    }
    if (rec.after.length === 0 || s.now() >= deadline) return;
    await s.wait(s.pollMs);
  }
}

export type Verdict = { ok: true; note: string } | { ok: false; reason: string };

/** P54's judgement: some before (BusHub among them), none after. */
export function judge(rec: HubRecord | undefined): Verdict {
  if (!rec) return { ok: false, reason: "P23 recorded no namespaces" };
  if (rec.error !== undefined)
    return { ok: false, reason: `${rec.script}: ${rec.error}` };
  const before = rec.before ?? [];
  if (before.length === 0)
    return {
      ok: false,
      reason: `${rec.script} had no Durable Object namespace before its delete: the list shows none for a namespaced script, or the token cannot see them`,
    };
  if (!before.some((n) => n.class === HUB_CLASS))
    return {
      ok: false,
      reason: `${rec.script} had no ${HUB_CLASS} namespace before its delete (had ${show(before)})`,
    };
  const after = rec.after ?? [];
  if (after.length > 0)
    return {
      ok: false,
      reason: `${rec.script}'s delete left Durable Object namespaces behind, and with them the BusHub data: ${show(after)} (before: ${show(before)})`,
    };
  return {
    ok: true,
    note: `${rec.script}: ${before.length} Durable Object namespace(s) before the delete (${show(before)}), none after`,
  };
}
