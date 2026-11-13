import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { cleanNote } from "../api/beta";
import {
  BUSINESS_KEY,
  type BusinessFilter,
  type BusinessRequest,
  type BusinessStatus,
  businessQuery,
  NEED_LABEL,
  setBusinessStatus,
  TEAM_SIZE_LABEL,
} from "../api/business";
import { fmtDayClock } from "../components/labels";
import { useAction } from "../hooks/useAction";
import { LoadError } from "../layout/LoadError";

const FILTERS: [BusinessFilter, string][] = [
  ["new", "New"],
  ["contacted", "Contacted"],
  ["closed", "Closed"],
  ["all", "All"],
];
const STATUS_LABEL: Record<BusinessStatus, string> = {
  new: "New",
  contacted: "Contacted",
  closed: "Closed",
};

function Row({
  r,
  onStatus,
  busy,
}: {
  r: BusinessRequest;
  onStatus: (id: string, s: BusinessStatus) => void;
  busy: boolean;
}) {
  const note = cleanNote(r.note);
  return (
    <tr data-testid="business-row">
      <td className="dt" title={new Date(r.createdAt).toISOString()}>
        {fmtDayClock(r.createdAt)}
      </td>
      <td className="who">
        <div className="nm">{r.name}</div>
        <div className="dt eml">{r.email}</div>
      </td>
      <td className="co">
        <div className="nm">{r.company}</div>
        <div className="dt">{TEAM_SIZE_LABEL[r.teamSize]} publishers</div>
      </td>
      <td className="nd">
        {r.needs.length
          ? r.needs.map((n) => NEED_LABEL[n] ?? n).join(", ")
          : "-"}
      </td>
      <td className="nt">
        {note ? (
          <span className="oa-beta-nt">{note}</span>
        ) : (
          <span className="oa-beta-nt oa-beta-none">No note</span>
        )}
      </td>
      <td className="fr">
        {r.source === "dashboard" ? "Dashboard" : "Landing"}
        {r.instanceHost && (
          <div className="dt" title="Unverified">
            {r.instanceHost.split(".").map((part, i) => (
              // A break may fall after a dot, never inside a label.
              <span key={`${i}-${part}`}>
                {i > 0 && <wbr />}
                {i > 0 ? `.${part}` : part}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="st">
        <select
          className="oa-beta-search"
          aria-label={`Status of ${r.email}`}
          value={r.status}
          disabled={busy}
          onChange={(e) => onStatus(r.id, e.target.value as BusinessStatus)}
        >
          {(Object.keys(STATUS_LABEL) as BusinessStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        {r.statusChangedBy && r.statusChangedAt !== null && (
          <div className="dt">
            {r.statusChangedBy}, {fmtDayClock(r.statusChangedAt)}
          </div>
        )}
      </td>
    </tr>
  );
}

export function Business() {
  const [filter, setFilter] = useState<BusinessFilter>("new");
  const list = useQuery(businessQuery(filter));
  const [failed, setFailed] = useState(false);
  const set = useAction(
    (v: { id: string; status: BusinessStatus }) =>
      setBusinessStatus(v.id, v.status),
    { invalidate: [[...BUSINESS_KEY]], onSuccess: () => setFailed(false) },
  );
  if (list.isError && !list.data)
    return (
      <LoadError
        title="Couldn't load the Business requests"
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  const rows = list.data?.items ?? [];
  return (
    <div className="oa-beta" data-testid="business">
      <div className="oa-head">
        <div>
          <h1>Business requests</h1>
          <p className="oa-sub">
            People who asked to talk about Business, newest first.
          </p>
        </div>
      </div>
      <div className="oa-beta-sec">
        <fieldset className="oa-beta-fs" aria-label="Show requests">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              type="button"
              className={`oa-btn oa-btn-sm ${filter === f ? "oa-btn-pri" : ""}`}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>
      {(failed || set.isError) && (
        <p className="oa-banner oa-banner-warn" role="alert">
          That didn't save. Try again.
        </p>
      )}
      <div className="oa-tablewrap oa-beta-card">
        {rows.length === 0 && !list.isLoading ? (
          <p className="oa-beta-empty">No requests here.</p>
        ) : (
          <table
            className="oa-beta-table oa-biz-table"
            aria-label="Business requests"
          >
            <thead>
              <tr>
                <th>Received</th>
                <th className="who">Who</th>
                <th className="co">Company</th>
                <th className="nd">Needs</th>
                <th className="nt">Note</th>
                <th className="fr">From</th>
                <th className="st">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row
                  key={r.id}
                  r={r}
                  busy={set.isPending}
                  onStatus={(id, status) => {
                    setFailed(false);
                    set.mutate({ id, status });
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
