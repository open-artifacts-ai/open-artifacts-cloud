import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { api } from "./client";

// The private beta's admin API (#2096): /api/v1/beta/*, served on the admin
// host only. Not contract routes, so these are plain calls.

export type BetaMode = "false" | "true" | "test-users" | "invite";
export type BetaStats = {
  waiting: number;
  declined: number;
  /** Approved, but the approval email never went out. */
  unsent: number;
  allowedEmails: number;
  allowedDomains: number;
  signupsToday: number;
  /** null: the daily cap is off. */
  cap: number | null;
  mode: BetaMode;
};
export type WaitStatus = "waiting" | "approved" | "declined" | "unsent";
export type WaitPerson = {
  sub: string;
  email: string;
  note: string | null;
  joinedAt: number;
  status: WaitStatus;
  decidedBy: string | null;
  decidedAt: number | null;
  emailedAt: number | null;
};
export type Allowed = {
  entry: string;
  kind: "email" | "domain";
  addedBy: string;
  addedAt: number;
  fromWaitlist: boolean;
};
export type ApproveResult = {
  results: {
    sub: string;
    email?: string;
    result: "approved" | "already_approved" | "not_found";
    emailSent?: boolean;
    emailError?: string;
    resent?: boolean;
  }[];
  approved: number;
  emailFailed: number;
};

export type AddResult = {
  entry: string;
  approved?: boolean;
  emailSent?: boolean;
  emailError?: string;
  waitingOnDomain?: number;
};

export const BETA_KEY = ["beta"] as const;

export const betaStatsQuery = () =>
  queryOptions({
    queryKey: [...BETA_KEY, "stats"],
    queryFn: () => api.get<BetaStats>("/beta/stats"),
    refetchInterval: 30_000,
  });
export const waitlistQuery = (o: { status: WaitStatus; q: string }) =>
  queryOptions({
    queryKey: [...BETA_KEY, "waitlist", o],
    queryFn: () =>
      api.get<{ items: WaitPerson[] }>(
        `/beta/waitlist?status=${o.status}${o.q ? `&q=${encodeURIComponent(o.q)}` : ""}`,
      ),
    placeholderData: keepPreviousData,
  });
export const allowedQuery = () =>
  queryOptions({
    queryKey: [...BETA_KEY, "allowed"],
    queryFn: () => api.get<{ items: Allowed[] }>("/beta/allowlist"),
  });

export const approvePeople = (subs: string[]) =>
  api.post<ApproveResult>("/beta/waitlist/approve", { subs });
export const declinePerson = (sub: string) =>
  api.post<unknown>("/beta/waitlist/decline", { sub });
export const addAllowed = (entries: string[]) =>
  api.post<{ added: string[]; results: AddResult[] }>("/beta/allowlist", {
    entries,
  });
export const removeAllowed = (entry: string) =>
  api.delete<{ removed: string }>(
    `/beta/allowlist/${encodeURIComponent(entry)}`,
  );

/** The Add box's text as entries: split on commas, spaces and new lines. */
export const splitEntries = (text: string): string[] =>
  text.split(/[\s,]+/).filter(Boolean);

/**
 * A note as plain text to show: the note is stored raw, so control, format
 * (bidi overrides and isolates, zero-width characters, BOM) and line/paragraph
 * separator characters are dropped, and runs of space collapse. React renders
 * the result as text; nothing here is ever HTML.
 */
export const cleanNote = (note: string | null | undefined): string =>
  (note ?? "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/[\p{Cf}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();

/** Every bad entry of a refused Add, one line each (the API's own strings). */
export const addErrorLines = (e: unknown): string[] => {
  const d = (e as { details?: { errors?: { message?: string }[] } }).details;
  const lines = d?.errors?.flatMap((x) => (x.message ? [x.message] : []));
  return lines?.length ? lines : [e instanceof Error ? e.message : ""];
};

/** What the Add toast says: who was allowed, who was emailed, who still waits. */
/** The one sentence for a send that failed, in Product's words. */
export const emailFailedText = (emails: string[], code: string | undefined) =>
  emails.length === 1
    ? `${emails[0]} is allowed, but the email telling them didn't send (${code}). Send it again below, or tell them yourself.`
    : `${emails.join(", ")} are allowed, but the emails telling them didn't send (${code}). Send them again below, or tell them yourself.`;

export function addToast(r: { added: string[]; results: AddResult[] }): {
  text: string;
  bad: boolean;
  domain?: string;
} {
  const sent = r.results.filter((x) => x.emailSent === true);
  const failed = r.results.filter((x) => x.emailSent === false);
  const only = r.added.length === 1;
  let text = `Allowed ${r.added.join(", ")}.`;
  if (sent.length)
    text += only
      ? " We emailed them."
      : ` We emailed ${sent.map((x) => x.entry).join(", ")}.`;
  if (failed.length)
    text = `${sent.length ? `${text} ` : ""}${emailFailedText(
      failed.map((x) => x.entry),
      failed[0]?.emailError,
    )}`;
  const doms = r.results.filter((x) => (x.waitingOnDomain ?? 0) > 0);
  const n = doms.reduce((a, x) => a + (x.waitingOnDomain ?? 0), 0);
  if (n > 0)
    text += ` ${n === 1 ? "1 person on the waitlist has an address" : `${n} people on the waitlist have addresses`} at ${doms.length === 1 ? "this domain" : "these domains"}. Approve them to tell them they're in.`;
  return { text, bad: failed.length > 0, domain: doms[0]?.entry };
}
