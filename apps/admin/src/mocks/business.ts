import { HttpResponse, http } from "msw";
import type { BusinessRequest, BusinessStatus } from "../api/business";

// A stateful mock of /api/v1/business-requests (open-artifacts#2404). Fresh
// state per call; the dev mock and the unit tests each make their own.

export const BUSINESS_REQUESTS = (now: number): BusinessRequest[] => [
  {
    id: "01JZ0000000000000000000003",
    createdAt: now - 2 * 3_600_000,
    name: "Priya Nair",
    email: "priya@northwind.io",
    company: "Northwind",
    teamSize: "51-200",
    needs: ["group_sync", "audit_log"],
    note: "We want everyone in our Google groups to read, a few to publish.",
    source: "dashboard",
    instanceHost: "northwind.open-artifacts.app",
    status: "new",
    statusChangedAt: null,
    statusChangedBy: null,
  },
  {
    id: "01JZ0000000000000000000002",
    createdAt: now - 26 * 3_600_000,
    name: "Tom Becker",
    email: "tom@studiolumen.co",
    company: "Studio Lumen",
    teamSize: "11-50",
    needs: [],
    note: null,
    source: "landing",
    instanceHost: null,
    status: "contacted",
    statusChangedAt: now - 20 * 3_600_000,
    statusChangedBy: "admin@example.com",
  },
  {
    id: "01JZ0000000000000000000001",
    createdAt: now - 5 * 86_400_000,
    name: "Ana Lopez",
    email: "ana@acme.test",
    company: "Acme",
    teamSize: "1-10",
    needs: ["custom_domain", "other"],
    note: null,
    source: "landing",
    instanceHost: null,
    status: "closed",
    statusChangedAt: now - 4 * 86_400_000,
    statusChangedBy: "admin@example.com",
  },
];

export function createBusinessMock(
  o: { requests?: BusinessRequest[]; now?: () => number } = {},
) {
  const now = o.now ?? Date.now;
  let rows = (o.requests ?? BUSINESS_REQUESTS(now())).map((r) => ({ ...r }));
  const handlers = [
    http.get("*/api/v1/business-requests", ({ request }) => {
      const st = new URL(request.url).searchParams.get("status") ?? "all";
      const items = rows
        .filter((r) => st === "all" || r.status === st)
        .sort((a, b) => b.createdAt - a.createdAt);
      return HttpResponse.json({ items });
    }),
    http.patch(
      "*/api/v1/business-requests/:id",
      async ({ params, request }) => {
        const { status } = (await request.json()) as { status: BusinessStatus };
        const r = rows.find((x) => x.id === params.id);
        if (!r)
          return HttpResponse.json(
            { error: { code: "not_found", message: "no such request" } },
            { status: 404 },
          );
        r.status = status;
        r.statusChangedAt = now();
        r.statusChangedBy = "admin@example.com";
        return HttpResponse.json(r);
      },
    ),
  ];
  return {
    handlers,
    state: () => rows,
    reset: () => {
      rows = (o.requests ?? BUSINESS_REQUESTS(now())).map((r) => ({ ...r }));
    },
  };
}
