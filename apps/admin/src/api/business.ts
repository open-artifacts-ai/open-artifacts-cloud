import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { api } from "./client";

// The Business requests admin API (open-artifacts#2404):
// /api/v1/business-requests, served on the admin host only. Not contract
// routes, so these are plain calls.

export type BusinessStatus = "new" | "contacted" | "closed";
export type BusinessFilter = BusinessStatus | "all";
export type BusinessRequest = {
  id: string;
  createdAt: number;
  name: string;
  email: string;
  company: string;
  teamSize: "1-10" | "11-50" | "51-200" | "200+";
  needs: string[];
  note: string | null;
  source: "landing" | "dashboard";
  /** As the requester's page gave it: unverified. */
  instanceHost: string | null;
  status: BusinessStatus;
  statusChangedAt: number | null;
  statusChangedBy: string | null;
};

export const BUSINESS_KEY = ["business-requests"] as const;

export const businessQuery = (status: BusinessFilter) =>
  queryOptions({
    queryKey: [...BUSINESS_KEY, status],
    queryFn: () =>
      api.get<{ items: BusinessRequest[] }>(
        `/business-requests?status=${status}`,
      ),
    placeholderData: keepPreviousData,
  });

export const setBusinessStatus = (id: string, status: BusinessStatus) =>
  api.patch<BusinessRequest>(`/business-requests/${encodeURIComponent(id)}`, {
    status,
  });

export const TEAM_SIZE_LABEL: Record<BusinessRequest["teamSize"], string> = {
  "1-10": "1 to 10",
  "11-50": "11 to 50",
  "51-200": "51 to 200",
  "200+": "More than 200",
};
export const NEED_LABEL: Record<string, string> = {
  group_sync: "Google group sync",
  sharing_controls: "Outside-sharing controls",
  audit_log: "Audit log",
  custom_domain: "Custom domain",
  other: "Something else",
};
