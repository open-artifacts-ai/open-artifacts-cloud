import { HttpResponse, http } from "msw";
import type {
  Allowed,
  ApproveResult,
  BetaMode,
  BetaStats,
  WaitPerson,
} from "../api/beta";
import { BETA_ALLOWED, BETA_WAITLIST } from "./fixtures/beta";

// A stateful mock of /api/v1/beta/* (#2096): approve, decline, add, remove
// work against in-memory lists, with the real API's refusal strings. Fresh
// state per call; the dev mock and the unit tests each make their own.

const PUBLIC: Record<string, string> = {
  "gmail.com": "Gmail",
  "googlemail.com": "Gmail",
  "outlook.com": "Outlook",
  "hotmail.com": "Hotmail",
  "yahoo.com": "Yahoo",
  "icloud.com": "iCloud",
  "proton.me": "Proton",
  "protonmail.com": "Proton",
};
const DOMAIN_RE = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const EMAIL_RE = /^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function createBetaMock(
  o: {
    mode?: BetaMode;
    waitlist?: WaitPerson[];
    allowed?: Allowed[];
    signupsToday?: number;
    cap?: number | null;
    /** Approvals answer "the email didn't send" for these subs. */
    failEmailFor?: string[];
    now?: () => number;
  } = {},
) {
  const now = o.now ?? Date.now;
  let wait = (o.waitlist ?? BETA_WAITLIST(now())).map((w) => ({ ...w }));
  let allowed = (o.allowed ?? BETA_ALLOWED(now())).map((a) => ({ ...a }));
  const mode = o.mode ?? "invite";
  const err = (
    code: string,
    status: number,
    message: string,
    details?: unknown,
  ) => HttpResponse.json({ error: { code, message, details } }, { status });
  const stats = (): BetaStats => ({
    waiting: wait.filter((w) => w.status === "waiting").length,
    declined: wait.filter((w) => w.status === "declined").length,
    allowedEmails: allowed.filter((a) => a.kind === "email").length,
    allowedDomains: allowed.filter((a) => a.kind === "domain").length,
    signupsToday: o.signupsToday ?? 7,
    cap: o.cap === undefined ? 20 : o.cap,
    mode,
  });
  const handlers = [
    http.get("*/api/v1/beta/stats", () => HttpResponse.json(stats())),
    http.get("*/api/v1/beta/waitlist", ({ request }) => {
      const u = new URL(request.url);
      const st = u.searchParams.get("status") ?? "waiting";
      const q = (u.searchParams.get("q") ?? "").toLowerCase();
      const items = wait
        .filter((w) => st === "all" || w.status === st)
        .filter(
          (w) =>
            !q ||
            w.email.toLowerCase().includes(q) ||
            (w.note ?? "").toLowerCase().includes(q),
        )
        .sort((a, b) => a.joinedAt - b.joinedAt);
      return HttpResponse.json({ items });
    }),
    http.get("*/api/v1/beta/allowlist", () =>
      HttpResponse.json({
        items: [...allowed].sort((a, b) => b.addedAt - a.addedAt),
      }),
    ),
    http.post("*/api/v1/beta/waitlist/approve", async ({ request }) => {
      const { subs } = (await request.json()) as { subs: string[] };
      const results: ApproveResult["results"] = [];
      for (const sub of new Set(subs)) {
        const w = wait.find((x) => x.sub === sub);
        if (!w) {
          results.push({ sub, result: "not_found" });
          continue;
        }
        if (w.status === "approved") {
          results.push({ sub, email: w.email, result: "already_approved" });
          continue;
        }
        w.status = "approved";
        w.decidedBy = "admin@example.com";
        w.decidedAt = now();
        if (!allowed.some((a) => a.entry === w.email))
          allowed.unshift({
            entry: w.email,
            kind: "email",
            addedBy: "admin@example.com",
            addedAt: now(),
            fromWaitlist: true,
          });
        const fail = o.failEmailFor?.includes(sub);
        results.push({
          sub,
          email: w.email,
          result: "approved",
          emailSent: !fail,
          ...(fail ? { emailError: "E_SENDER_NOT_VERIFIED" } : {}),
        });
      }
      return HttpResponse.json({
        results,
        approved: results.filter((r) => r.result === "approved").length,
        emailFailed: results.filter((r) => r.emailSent === false).length,
      });
    }),
    http.post("*/api/v1/beta/waitlist/decline", async ({ request }) => {
      const { sub } = (await request.json()) as { sub: string };
      const w = wait.find((x) => x.sub === sub);
      if (!w) return err("not_found", 404, "no such person on the waitlist");
      if (w.status === "approved")
        return err("invalid_state", 409, "already approved");
      w.status = "declined";
      return HttpResponse.json({ sub, email: w.email, status: "declined" });
    }),
    http.post("*/api/v1/beta/allowlist", async ({ request }) => {
      const { entries } = (await request.json()) as { entries: string[] };
      const norm = entries.map((e) => e.trim().toLowerCase());
      const seen = new Set<string>();
      for (const e of norm) {
        const bad = DOMAIN_RE.test(e)
          ? PUBLIC[e.slice(1)]
            ? `${e} would let in anyone with a ${PUBLIC[e.slice(1)]} address. Add emails one at a time instead.`
            : null
          : !EMAIL_RE.test(e)
            ? `"${e}" isn't an email address or a domain like @acme.com.`
            : null;
        const dup =
          allowed.some((a) => a.entry === e) || seen.has(e)
            ? `${e} is already on the list.`
            : null;
        if (bad ?? dup)
          return err("invalid_input", 400, (bad ?? dup) as string);
        seen.add(e);
      }
      for (const e of norm) {
        allowed.unshift({
          entry: e,
          kind: e.startsWith("@") ? "domain" : "email",
          addedBy: "admin@example.com",
          addedAt: now(),
          fromWaitlist: false,
        });
        for (const w of wait)
          if (w.email === e && w.status !== "approved") w.status = "approved";
      }
      return HttpResponse.json({ added: norm });
    }),
    http.delete("*/api/v1/beta/allowlist/:entry", ({ params }) => {
      const entry = decodeURIComponent(String(params.entry)).toLowerCase();
      if (!allowed.some((a) => a.entry === entry))
        return err("not_found", 404, "that entry is not on the list");
      allowed = allowed.filter((a) => a.entry !== entry);
      return HttpResponse.json({ removed: entry });
    }),
  ];
  return {
    handlers,
    /** Test access to the state. */
    state: () => ({ wait, allowed }),
    reset: () => {
      wait = (o.waitlist ?? BETA_WAITLIST(now())).map((w) => ({ ...w }));
      allowed = (o.allowed ?? BETA_ALLOWED(now())).map((a) => ({ ...a }));
    },
  };
}
