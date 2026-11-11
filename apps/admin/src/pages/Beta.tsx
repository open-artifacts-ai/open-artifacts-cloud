import { Checkbox } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  type Allowed,
  addAllowed,
  allowedQuery,
  approvePeople,
  BETA_KEY,
  type BetaMode,
  betaStatsQuery,
  cleanNote,
  declinePerson,
  removeAllowed,
  splitEntries,
  type WaitPerson,
  waitlistQuery,
} from "../api/beta";
import { ApiError } from "../api/client";
import { ActionDialog } from "../components/ActionDialog";
import { fmtDay } from "../components/labels";
import { useAction } from "../hooks/useAction";
import { LoadError } from "../layout/LoadError";

export const SEARCH_DELAY_MS = 300;
const NOTE_CLAMP_CHARS = 150;
const TOAST_MS = 8_000;

const MODE_LABEL: Record<BetaMode, string> = {
  invite: "Invite",
  true: "Open to everyone",
  false: "Closed",
  "test-users": "Test users only",
};
/** The banner for a mode where the list isn't used. */
const MODE_BANNER: Record<Exclude<BetaMode, "invite">, [string, string]> = {
  true: [
    "Sign-ups are open to everyone right now,",
    "so this list isn't being used.",
  ],
  false: ["Sign-ups are closed right now,", "so this list isn't being used."],
  "test-users": [
    "Sign-ups are limited to test users right now,",
    "so this list isn't being used.",
  ],
};

const p2 = (n: number) => String(n).padStart(2, "0");
/** "Nov 5, 2026, 14:02" (UTC), the hover text of a relative time. */
const fullDate = (ms: number) => {
  const d = new Date(ms);
  return `${fmtDay(ms)}, ${d.getUTCFullYear()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
};
/** "Yesterday", "6 days ago": the waitlist is sorted by it, oldest first. */
export const fmtJoined = (ms: number, now: number) => {
  const d = now - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  const days = Math.floor(d / 86_400_000);
  return days === 1 ? "Yesterday" : `${days} days ago`;
};

type Toast = { text: string; bad?: boolean };

function Note({ note }: { note: string | null }) {
  const [more, setMore] = useState(false);
  const text = cleanNote(note);
  if (!text) return <span className="oa-beta-nt oa-beta-none">No note</span>;
  const long = text.length > NOTE_CLAMP_CHARS;
  return (
    <>
      {/* Text only: React escapes it, and cleanNote dropped the invisible controls. */}
      <div className={`oa-beta-nt ${long && !more ? "clamp" : ""}`}>{text}</div>
      {long && (
        <button
          type="button"
          className="oa-lnk"
          aria-expanded={more}
          onClick={() => setMore((m) => !m)}
        >
          {more ? "less" : "more"}
        </button>
      )}
    </>
  );
}

type Confirm =
  | { k: "decline"; p: WaitPerson }
  | { k: "remove"; a: Allowed }
  | { k: "bulk"; subs: string[] };

export function Beta() {
  const stats = useQuery(betaStatsQuery());
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [showDeclined, setShowDeclined] = useState(false);
  const waiting = useQuery(waitlistQuery({ status: "waiting", q }));
  const declined = useQuery({
    ...waitlistQuery({ status: "declined", q }),
    enabled: showDeclined,
  });
  const allowed = useQuery(allowedQuery());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [addText, setAddText] = useState("");
  const [addError, setAddError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [typed]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const inv = [[...BETA_KEY]];
  const approve = useAction((subs: string[]) => approvePeople(subs), {
    invalidate: inv,
    onSuccess: (r, subs) => {
      setSel((cur) => new Set([...cur].filter((s) => !subs.includes(s))));
      setConfirm(null);
      const done = r.results.filter((x) => x.result === "approved");
      const failed = done.filter((x) => x.emailSent === false);
      const who =
        done.length === 1
          ? (done[0]?.email ?? "them")
          : `${done.length} people`;
      if (failed.length)
        setToast({
          bad: true,
          text:
            done.length === 1
              ? `Approved ${who}, but the email didn't send (${failed[0]?.emailError}). They're on the list; tell them yourself.`
              : `Approved ${who}, but ${failed.length} ${failed.length === 1 ? "email" : "emails"} didn't send. They're on the list; tell them yourself.`,
        });
      else if (done.length === 0) setToast({ text: "Nobody new to approve." });
      else
        setToast({
          text:
            done.length === 1
              ? `Approved ${who}. We emailed them.`
              : `Approved ${done.length} people. We emailed them.`,
        });
    },
  });
  const decline = useAction((sub: string) => declinePerson(sub), {
    invalidate: inv,
    onSuccess: (_r, sub) => {
      const email = confirm?.k === "decline" ? confirm.p.email : "them";
      setSel((cur) => new Set([...cur].filter((s) => s !== sub)));
      setConfirm(null);
      setToast({ text: `Declined ${email}.` });
    },
  });
  const remove = useAction((entry: string) => removeAllowed(entry), {
    invalidate: inv,
    onSuccess: (r) => {
      setConfirm(null);
      setToast({ text: `Removed ${r.removed}.` });
    },
  });
  const add = useAction((entries: string[]) => addAllowed(entries), {
    invalidate: inv,
    onSuccess: (r) => {
      setAddText("");
      setAddError("");
      setToast({ text: `Added ${r.added.join(", ")}.` });
    },
  });
  const submitAdd = () => {
    const entries = splitEntries(addText);
    if (entries.length === 0) {
      setAddError("");
      return;
    }
    add.mutate(entries, {
      onError: (e) =>
        setAddError(
          e instanceof ApiError && e.code === "invalid_input"
            ? e.message
            : "That didn't save. Try again.",
        ),
    });
  };

  if (stats.isError && !stats.data)
    return (
      <LoadError
        title="Couldn't load the beta list"
        error={stats.error}
        onRetry={() => void stats.refetch()}
      />
    );
  const s = stats.data;
  const rows = waiting.data?.items ?? [];
  const now = Date.now();
  const allSelected = rows.length > 0 && rows.every((r) => sel.has(r.sub));
  const toggle = (sub: string, on: boolean) =>
    setSel((cur) => {
      const n = new Set(cur);
      if (on) n.add(sub);
      else n.delete(sub);
      return n;
    });
  const picked = rows.filter((r) => sel.has(r.sub)).map((r) => r.sub);

  return (
    <div className="oa-beta" data-testid="beta">
      <div className="oa-head">
        <div>
          <h1>Beta</h1>
          <p className="oa-sub">
            Choose who can sign up while sign-ups are by invite.
          </p>
        </div>
      </div>
      {s && s.mode !== "invite" && (
        <p
          className="oa-banner oa-banner-warn"
          role="status"
          data-testid="beta-banner"
        >
          <strong>{MODE_BANNER[s.mode][0]}</strong> {MODE_BANNER[s.mode][1]}{" "}
          It takes effect when sign-ups are set to invite only.
        </p>
      )}
      <section className="oa-tiles" aria-label="Overview">
        <div className="oa-tile" data-testid="beta-tile-waiting">
          <div className="k">Waiting</div>
          <div className="v">{s?.waiting ?? "-"}</div>
        </div>
        <div className="oa-tile" data-testid="beta-tile-allowed">
          <div className="k">Allowed</div>
          <div className="v">
            {s?.allowedEmails ?? "-"}{" "}
            <small>
              {s?.allowedEmails === 1 ? "email" : "emails"} ·{" "}
              {s?.allowedDomains ?? "-"}{" "}
              {s?.allowedDomains === 1 ? "domain" : "domains"}
            </small>
          </div>
        </div>
        <div className="oa-tile" data-testid="beta-tile-today">
          <div className="k">Sign-ups today</div>
          <div className="v">
            {s?.signupsToday ?? "-"}
            {s?.cap != null && <small> of {s.cap}</small>}
          </div>
        </div>
        <div className="oa-tile" data-testid="beta-tile-mode">
          <div className="k">Mode</div>
          <div className="v oa-beta-mode">{s ? MODE_LABEL[s.mode] : "-"}</div>
        </div>
      </section>

      <div className="oa-beta-sec">
        <h2>Waitlist</h2>
        <span className="oa-spacer" />
        {(s?.declined ?? 0) > 0 && (
          <button
            type="button"
            className="oa-lnk"
            aria-pressed={showDeclined}
            onClick={() => setShowDeclined((v) => !v)}
          >
            {showDeclined ? "Hide declined" : `Show declined (${s?.declined})`}
          </button>
        )}
        <input
          type="search"
          className="oa-beta-search"
          placeholder="Search email or note"
          aria-label="Search the waitlist"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>
      <div className="oa-tablewrap oa-beta-card">
        {picked.length > 0 && (
          <div className="oa-beta-bulk" data-testid="beta-bulk">
            <span>{picked.length} selected</span>
            <button
              type="button"
              className="oa-btn oa-btn-sm oa-btn-pri"
              onClick={() => setConfirm({ k: "bulk", subs: picked })}
            >
              Approve selected
            </button>
            <button
              type="button"
              className="oa-lnk"
              onClick={() => setSel(new Set())}
            >
              Clear
            </button>
          </div>
        )}
        {waiting.isError && !waiting.data ? (
          <p className="oa-beta-empty">Couldn't load the waitlist.</p>
        ) : rows.length === 0 && !waiting.isLoading ? (
          <p className="oa-beta-empty">
            {q ? "No one matches that search." : "Nobody is waiting."}
          </p>
        ) : (
          <table className="oa-beta-table" aria-label="Waitlist">
            <thead>
              <tr>
                <th className="sel">
                  <Checkbox
                    aria-label="Select everyone"
                    checked={allSelected}
                    onCheckedChange={(on) =>
                      setSel(
                        on === true
                          ? new Set(rows.map((r) => r.sub))
                          : new Set(),
                      )
                    }
                  />
                </th>
                <th>Email</th>
                <th>Joined</th>
                <th>Their note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sub} className="hassel">
                  <td className="sel">
                    <Checkbox
                      aria-label={`Select ${r.email}`}
                      checked={sel.has(r.sub)}
                      onCheckedChange={(on) => toggle(r.sub, on === true)}
                    />
                  </td>
                  <td className="em">{r.email}</td>
                  <td className="dt" title={fullDate(r.joinedAt)}>
                    {fmtJoined(r.joinedAt, now)}
                  </td>
                  <td className="nt-td">
                    <Note note={r.note} />
                  </td>
                  <td className="act">
                    <button
                      type="button"
                      className="oa-btn oa-btn-sm oa-btn-pri"
                      disabled={approve.isPending}
                      onClick={() => approve.mutate([r.sub])}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="oa-btn oa-btn-sm"
                      onClick={() => setConfirm({ k: "decline", p: r })}
                    >
                      Decline
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {showDeclined && (declined.data?.items.length ?? 0) > 0 && (
        <div className="oa-tablewrap oa-beta-card" data-testid="beta-declined">
          <table className="oa-beta-table" aria-label="Declined">
            <tbody>
              {declined.data?.items.map((r) => (
                <tr key={r.sub}>
                  <td className="em">
                    {r.email}
                    <span className="oa-beta-tag">declined</span>
                  </td>
                  <td className="dt" title={fullDate(r.joinedAt)}>
                    {fmtJoined(r.joinedAt, now)}
                  </td>
                  <td className="act">
                    <button
                      type="button"
                      className="oa-btn oa-btn-sm"
                      disabled={approve.isPending}
                      onClick={() => approve.mutate([r.sub])}
                    >
                      Approve
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="oa-beta-sec">
        <h2>Allowed</h2>
      </div>
      <div className="oa-tablewrap oa-beta-card">
        <div className="oa-beta-add">
          <textarea
            className="oa-beta-ta"
            rows={1}
            placeholder="maya@acme.com, @acme.com"
            aria-label="Emails or domains to allow"
            aria-invalid={addError ? true : undefined}
            aria-describedby={addError ? "beta-add-err" : "beta-add-hint"}
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
          />
          <button
            type="button"
            className="oa-btn oa-btn-sm oa-btn-pri"
            disabled={add.isPending}
            onClick={submitAdd}
          >
            Add
          </button>
        </div>
        {addError ? (
          <p className="oa-beta-err" id="beta-add-err" role="alert">
            {addError}
          </p>
        ) : (
          <p className="oa-beta-hint" id="beta-add-hint">
            Emails or @domains, separated by commas, spaces or new lines.
          </p>
        )}
        {(allowed.data?.items.length ?? 0) === 0 && !allowed.isLoading ? (
          <p className="oa-beta-empty">
            Nobody is allowed yet. Add an email or a domain.
          </p>
        ) : (
          <table className="oa-beta-table" aria-label="Allowed">
            <thead>
              <tr>
                <th>Email or domain</th>
                <th>Added by</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {allowed.data?.items.map((a) => (
                <tr key={a.entry}>
                  <td className="em">
                    {a.entry}
                    {a.kind === "domain" && (
                      <span
                        className="oa-beta-tag"
                        title="Google Workspace accounts on this domain"
                      >
                        whole domain
                      </span>
                    )}
                  </td>
                  <td>
                    {a.addedBy}
                    {a.fromWaitlist && (
                      <span className="dt"> · from the waitlist</span>
                    )}
                  </td>
                  <td className="dt" title={fullDate(a.addedAt)}>
                    {fmtDay(a.addedAt)}
                  </td>
                  <td className="act">
                    <button
                      type="button"
                      className="oa-btn oa-btn-sm"
                      onClick={() => setConfirm({ k: "remove", a })}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ActionDialog
        open={confirm?.k === "bulk"}
        onClose={() => setConfirm(null)}
        title={
          confirm?.k === "bulk"
            ? `Approve ${confirm.subs.length} ${confirm.subs.length === 1 ? "person" : "people"}?`
            : ""
        }
        description="We'll email each of them."
        submitLabel="Approve"
        pending={approve.isPending}
        error={approve.error}
        onSubmit={() => confirm?.k === "bulk" && approve.mutate(confirm.subs)}
      />
      <ActionDialog
        open={confirm?.k === "decline"}
        onClose={() => setConfirm(null)}
        title={confirm?.k === "decline" ? `Decline ${confirm.p.email}?` : ""}
        description="They aren't told, and they still see 'You're on the list'."
        submitLabel="Decline"
        destructive
        pending={decline.isPending}
        error={decline.error}
        onSubmit={() =>
          confirm?.k === "decline" && decline.mutate(confirm.p.sub)
        }
      />
      <ActionDialog
        open={confirm?.k === "remove"}
        onClose={() => setConfirm(null)}
        title={confirm?.k === "remove" ? `Remove ${confirm.a.entry}?` : ""}
        description="People who already made an instance keep it."
        submitLabel="Remove"
        destructive
        pending={remove.isPending}
        error={remove.error}
        onSubmit={() =>
          confirm?.k === "remove" && remove.mutate(confirm.a.entry)
        }
      />
      {toast && (
        <div
          className={`oa-beta-toast ${toast.bad ? "bad" : ""}`}
          role={toast.bad ? "alert" : "status"}
          data-testid="beta-toast"
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
