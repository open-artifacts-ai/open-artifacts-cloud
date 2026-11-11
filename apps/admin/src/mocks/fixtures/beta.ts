import type { Allowed, WaitPerson } from "../../api/beta";

// The Beta tab's fixtures (the design's rows, jL29NAp7gLQFqT9U): four people
// waiting, one declined, three allowed.

const DAY = 86_400_000;
const LONG =
  "We run a six-person agency and every client plan ends up buried in a chat. I'd put each plan on a page the client can comment on, and let our agents keep the status pages up to date so nobody has to ask where things are any more. We'd start with two";

const person = (
  sub: string,
  email: string,
  daysAgo: number,
  note: string | null,
  now: number,
  status: WaitPerson["status"] = "waiting",
): WaitPerson => ({
  sub,
  email,
  note,
  joinedAt: now - daysAgo * DAY,
  status,
  decidedBy: null,
  decidedAt: null,
});

export const BETA_WAITLIST = (now: number): WaitPerson[] => [
  person("sub-maya", "maya@acme.com", 6, LONG, now),
  person(
    "sub-sam",
    "sam.rivera@northwind.io",
    4,
    "Status pages for our platform team, written by our agents.",
    now,
  ),
  person("sub-okafor", "j.okafor@gmail.com", 2, null, now),
  person(
    "sub-ines",
    "ines@studiolumen.co",
    1,
    "Client reports. I want comments on the page, not in email.",
    now,
  ),
  person("sub-tomas", "tomas@example.net", 5, null, now, "declined"),
];

export const BETA_ALLOWED = (now: number): Allowed[] => [
  {
    entry: "@northwind.io",
    kind: "domain",
    addedBy: "Leo Urbina",
    addedAt: now - 8 * DAY,
    fromWaitlist: false,
  },
  {
    entry: "ada@lovelace.dev",
    kind: "email",
    addedBy: "Leo Urbina",
    addedAt: now - 7 * DAY,
    fromWaitlist: true,
  },
  {
    entry: "grace@hopper.org",
    kind: "email",
    addedBy: "Leo Urbina",
    addedAt: now - 3 * DAY,
    fromWaitlist: false,
  },
];
