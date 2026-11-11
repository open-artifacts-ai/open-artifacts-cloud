import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { cleanNote, splitEntries } from "../src/api/beta";
import { createBetaMock } from "../src/mocks/beta";
import { fmtJoined } from "../src/pages/Beta";
import { http, json, renderApp, use, writes } from "./harness";

// #2096: the Beta tab. The API is the stateful createBetaMock (the real
// refusal strings); the design is jL29NAp7gLQFqT9U.

const swap = (m: ReturnType<typeof createBetaMock>) => use(...m.handlers);
const waitRows = () =>
  within(screen.getByRole("table", { name: "Waitlist" })).getAllByRole("row");

it("shows the waitlist oldest first, the tiles and the intro; nav badge counts those waiting", async () => {
  renderApp("/beta");
  expect(
    await screen.findByText(
      "Choose who can sign up while sign-ups are by invite.",
    ),
  ).toBeInTheDocument();
  await screen.findByText("maya@acme.com");
  const emails = waitRows()
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[1]?.textContent);
  // oldest first: 6, 4 and 2 days ago, then yesterday
  expect(emails).toEqual([
    "maya@acme.com",
    "sam.rivera@northwind.io",
    "j.okafor@gmail.com",
    "ines@studiolumen.co",
  ]);
  expect(screen.getByTestId("beta-tile-waiting")).toHaveTextContent("4");
  expect(screen.getByTestId("beta-tile-allowed")).toHaveTextContent(
    "2 emails · 1 domain",
  );
  expect(screen.getByTestId("beta-tile-today")).toHaveTextContent("7 of 20");
  expect(screen.getByTestId("beta-tile-mode")).toHaveTextContent("Invite");
  await waitFor(() =>
    expect(screen.getByTestId("beta-count")).toHaveTextContent("4"),
  );
  expect(screen.queryByTestId("beta-banner")).toBeNull();
});

it("a banner shows when the mode isn't invite", async () => {
  swap(createBetaMock({ mode: "true" }));
  renderApp("/beta");
  const b = await screen.findByTestId("beta-banner");
  expect(b).toHaveTextContent(
    "Sign-ups are open to everyone right now, so this list isn't being used. It takes effect when sign-ups are set to invite only.",
  );
});

it("a single Approve needs no confirm; it posts one sub and says we emailed them", async () => {
  renderApp("/beta");
  const row = (await screen.findByText("sam.rivera@northwind.io")).closest(
    "tr",
  ) as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
  expect(await screen.findByTestId("beta-toast")).toHaveTextContent(
    "Approved sam.rivera@northwind.io. We emailed them.",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes().map((w) => [w.path, w.body])).toEqual([
    ["/api/v1/beta/waitlist/approve", { subs: ["sub-sam"] }],
  ]);
  await waitFor(() =>
    expect(
      waitRows()
        .map((r) => r.textContent)
        .join(),
    ).not.toContain("sam.rivera"),
  );
  // now in Allowed, from the waitlist
  // ada (fixture) and now sam
  await waitFor(() =>
    expect(screen.getAllByText(/from the waitlist/)).toHaveLength(2),
  );
});

it("Approve selected confirms: 'Approve 1 person?' for one, 'Approve 3 people?' for more", async () => {
  renderApp("/beta");
  await screen.findByText("maya@acme.com");
  const pick = (email: string) =>
    fireEvent.click(screen.getByLabelText(`Select ${email}`));
  pick("maya@acme.com");
  fireEvent.click(screen.getByRole("button", { name: "Approve selected" }));
  expect(
    await screen.findByRole("heading", { name: "Approve 1 person?" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(writes()).toEqual([]);
  pick("sam.rivera@northwind.io");
  pick("ines@studiolumen.co");
  fireEvent.click(screen.getByRole("button", { name: "Approve selected" }));
  const dlg = await screen.findByRole("dialog");
  expect(
    within(dlg).getByRole("heading", { name: "Approve 3 people?" }),
  ).toBeInTheDocument();
  expect(
    within(dlg).getByText("We'll email each of them."),
  ).toBeInTheDocument();
  fireEvent.click(within(dlg).getByRole("button", { name: "Approve" }));
  expect(await screen.findByTestId("beta-toast")).toHaveTextContent(
    "Approved 3 people. We emailed them.",
  );
  expect(writes()).toHaveLength(1);
  const body = writes()[0]?.body as { subs: string[] };
  expect([...body.subs].sort()).toEqual(["sub-ines", "sub-maya", "sub-sam"]);
});

it("an email that didn't send is shown, and the person stays approved", async () => {
  swap(createBetaMock({ failEmailFor: ["sub-sam"] }));
  renderApp("/beta");
  const row = (await screen.findByText("sam.rivera@northwind.io")).closest(
    "tr",
  ) as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
  const t = await screen.findByTestId("beta-toast");
  expect(t).toHaveTextContent(
    "sam.rivera@northwind.io is allowed, but the email telling them didn't send (E_SENDER_NOT_VERIFIED). Send it again below, or tell them yourself.",
  );
  expect(t).toHaveAttribute("role", "alert");
});

it("Decline confirms, then is quiet; Show declined lists them and Approve still works", async () => {
  renderApp("/beta");
  const row = (await screen.findByText("maya@acme.com")).closest(
    "tr",
  ) as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Decline" }));
  const dlg = await screen.findByRole("dialog");
  expect(
    within(dlg).getByRole("heading", { name: "Decline maya@acme.com?" }),
  ).toBeInTheDocument();
  expect(
    within(dlg).getByText(
      "They aren't told, and they still see 'You're on the list'.",
    ),
  ).toBeInTheDocument();
  expect(writes()).toEqual([]);
  fireEvent.click(within(dlg).getByRole("button", { name: "Decline" }));
  expect(await screen.findByTestId("beta-toast")).toHaveTextContent(
    "Declined maya@acme.com.",
  );
  expect(writes().map((w) => w.path)).toEqual([
    "/api/v1/beta/waitlist/decline",
  ]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Show declined (2)" }),
  );
  const declined = await screen.findByTestId("beta-declined");
  expect(within(declined).getByText("maya@acme.com")).toBeInTheDocument();
  expect(within(declined).getByText("tomas@example.net")).toBeInTheDocument();
  fireEvent.click(
    within(
      within(declined)
        .getByText("tomas@example.net")
        .closest("tr") as HTMLElement,
    ).getByRole("button", { name: "Approve" }),
  );
  expect(await screen.findByTestId("beta-toast")).toHaveTextContent(
    "Approved tomas@example.net.",
  );
});

it("Remove confirms and says installs are kept", async () => {
  renderApp("/beta");
  const row = (await screen.findByText("@northwind.io")).closest(
    "tr",
  ) as HTMLElement;
  expect(within(row).getByText("whole domain")).toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
  const dlg = await screen.findByRole("dialog");
  expect(
    within(dlg).getByRole("heading", { name: "Remove @northwind.io?" }),
  ).toBeInTheDocument();
  expect(
    within(dlg).getByText("People who already made an instance keep it."),
  ).toBeInTheDocument();
  fireEvent.click(within(dlg).getByRole("button", { name: "Remove" }));
  expect(await screen.findByTestId("beta-toast")).toHaveTextContent(
    "Removed @northwind.io.",
  );
  expect(writes().map((w) => w.path)).toEqual([
    "/api/v1/beta/allowlist/%40northwind.io",
  ]);
});

it("the Add box takes several entries and names the first bad one, keeping the text", async () => {
  renderApp("/beta");
  const box = await screen.findByLabelText("Emails or domains to allow");
  expect(
    screen.getByText(
      "Emails or @domains, separated by commas, spaces or new lines.",
    ),
  ).toBeInTheDocument();
  fireEvent.change(box, {
    target: { value: "lee@initech.com, acme, @gmail.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  // every bad entry, one line each
  const alert = await screen.findByRole("alert");
  expect(
    Array.from(alert.querySelectorAll("p")).map((x) => x.textContent),
  ).toEqual([
    `"acme" isn't an email address or a domain like @acme.com.`,
    "@gmail.com would let in anyone with a Gmail address. Add emails one at a time instead.",
  ]);
  expect(writes()).toHaveLength(1);
  expect(box).toHaveAttribute("aria-invalid", "true");
  expect(box).toHaveValue("lee@initech.com, acme, @gmail.com");
  fireEvent.change(box, { target: { value: "@gmail.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(
    await screen.findByText(
      "@gmail.com would let in anyone with a Gmail address. Add emails one at a time instead.",
    ),
  ).toBeInTheDocument();
  fireEvent.change(box, { target: { value: "ada@lovelace.dev" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(
    await screen.findByText("ada@lovelace.dev is already on the list."),
  ).toBeInTheDocument();
  fireEvent.change(box, {
    target: { value: "lee@initech.com, @acme.com\nzed@x.io" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const toast = await screen.findByTestId("beta-toast");
  expect(toast).toHaveTextContent(
    "Allowed lee@initech.com, @acme.com, zed@x.io. 1 person on the waitlist has an address at this domain. Approve them to tell them they're in.",
  );
  expect(box).toHaveValue("");
  // it asks for an action: it stays, and a click searches the domain
  await new Promise((r) => setTimeout(r, 300));
  fireEvent.click(
    within(toast).getByRole("button", { name: /1 person on the waitlist/ }),
  );
  expect(screen.getByLabelText("Search the waitlist")).toHaveValue("@acme.com");
  await waitFor(() =>
    expect(screen.queryByText("sam.rivera@northwind.io")).toBeNull(),
  );
  expect(screen.getAllByText("maya@acme.com").length).toBeGreaterThan(0);
  fireEvent.click(
    within(screen.getByTestId("beta-toast")).getByRole("button", {
      name: "Dismiss",
    }),
  );
  expect(screen.queryByTestId("beta-toast")).toBeNull();
  expect(writes().at(-1)?.body).toEqual({
    entries: ["lee@initech.com", "@acme.com", "zed@x.io"],
  });
});

it("adding an exact email on the waitlist approves and emails them; a failed email says so", async () => {
  renderApp("/beta");
  const box = await screen.findByLabelText("Emails or domains to allow");
  await screen.findByText("sam.rivera@northwind.io");
  fireEvent.change(box, { target: { value: "sam.rivera@northwind.io" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(await screen.findByTestId("beta-toast")).toHaveTextContent(
    "Allowed sam.rivera@northwind.io. We emailed them.",
  );
});

it("adding an exact email whose approval email fails keeps them approved and says so", async () => {
  swap(createBetaMock({ failEmailFor: ["sub-sam"] }));
  renderApp("/beta");
  const box = await screen.findByLabelText("Emails or domains to allow");
  fireEvent.change(box, { target: { value: "sam.rivera@northwind.io" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const t = await screen.findByTestId("beta-toast");
  expect(t).toHaveTextContent(
    "sam.rivera@northwind.io is allowed, but the email telling them didn't send (E_SENDER_NOT_VERIFIED). Send it again below, or tell them yourself.",
  );
  expect(t).toHaveAttribute("role", "alert");
});

it("an approved row whose email didn't send shows 'Send email again', which sends it", async () => {
  const failEmailFor = ["sub-sam"];
  swap(createBetaMock({ failEmailFor }));
  renderApp("/beta");
  const row = (await screen.findByText("sam.rivera@northwind.io")).closest(
    "tr",
  ) as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
  expect(await screen.findByTestId("beta-toast")).toHaveTextContent(
    "is allowed, but the email telling them didn't send",
  );
  const unsent = await screen.findByTestId("beta-unsent");
  expect(
    within(unsent).getByText("sam.rivera@northwind.io"),
  ).toBeInTheDocument();
  failEmailFor.length = 0;
  fireEvent.click(
    within(unsent).getByRole("button", { name: "Send email again" }),
  );
  expect(
    await screen.findByText("Emailed sam.rivera@northwind.io."),
  ).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByTestId("beta-unsent")).toBeNull());
  expect(writes().map((w) => w.body)).toEqual([
    { subs: ["sub-sam"] },
    { subs: ["sub-sam"] },
  ]);
});

it("search filters the waitlist by email or note; no match and empty states say so", async () => {
  renderApp("/beta");
  await screen.findByText("maya@acme.com");
  fireEvent.change(screen.getByLabelText("Search the waitlist"), {
    target: { value: "client reports" },
  });
  await waitFor(() => expect(screen.queryByText("maya@acme.com")).toBeNull(), {
    timeout: 3000,
  });
  expect(screen.getByText("ines@studiolumen.co")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Search the waitlist"), {
    target: { value: "zzz" },
  });
  expect(
    await screen.findByText(
      "No one matches that search.",
      {},
      { timeout: 3000 },
    ),
  ).toBeInTheDocument();
});

it("both empty states", async () => {
  swap(createBetaMock({ waitlist: [], allowed: [] }));
  renderApp("/beta");
  expect(await screen.findByText("Nobody is waiting.")).toBeInTheDocument();
  expect(
    screen.getByText("Nobody is allowed yet. Add an email or a domain."),
  ).toBeInTheDocument();
});

it("a note is shown as text only, with control, bidi and zero-width characters stripped", async () => {
  const evil = "<img src=x onerror=alert(1)>‮hidden​‍﻿⁦x⁩\u0007 ok";
  expect(cleanNote(evil)).toBe("<img src=x onerror=alert(1)>hiddenx ok");
  expect(cleanNote(null)).toBe("");
  expect(cleanNote("a\r\nb\tc d")).toBe("a b c d");
  swap(
    createBetaMock({
      waitlist: [
        {
          sub: "s1",
          email: "e@x.io",
          note: evil,
          joinedAt: Date.now() - 1000,
          status: "waiting",
          decidedBy: null,
          decidedAt: null,
          emailedAt: null,
        },
      ],
    }),
  );
  const { container } = renderApp("/beta");
  await screen.findByText("e@x.io");
  expect(container.querySelector("img")).toBeNull();
  const cell = container.querySelector(".oa-beta-nt");
  expect(cell?.textContent).toBe("<img src=x onerror=alert(1)>hiddenx ok");
});

it("a long note is clamped with more/less", async () => {
  renderApp("/beta");
  const row = (await screen.findByText("maya@acme.com")).closest(
    "tr",
  ) as HTMLElement;
  expect(row.querySelector(".oa-beta-nt")?.className).toContain("clamp");
  fireEvent.click(within(row).getByRole("button", { name: "more" }));
  expect(row.querySelector(".oa-beta-nt")?.className).not.toContain("clamp");
});

it("helpers: entries split on commas, spaces and new lines; joined reads relative", () => {
  expect(splitEntries(" a@b.co,c@d.io\n@e.com  f@g.org,, ")).toEqual([
    "a@b.co",
    "c@d.io",
    "@e.com",
    "f@g.org",
  ]);
  const n = 1_790_000_000_000;
  expect(fmtJoined(n - 5000, n)).toBe("just now");
  expect(fmtJoined(n - 86_400_000 * 1.2, n)).toBe("Yesterday");
  expect(fmtJoined(n - 86_400_000 * 6.5, n)).toBe("6 days ago");
});

it("the API's refusal for a non-admin shows the load error, not a crash", async () => {
  use(
    http.get("*/api/v1/beta/stats", () =>
      json({ error: { code: "forbidden", message: "No." } }, 403),
    ),
  );
  renderApp("/beta");
  expect(
    await screen.findByText("Couldn't load the beta list"),
  ).toBeInTheDocument();
});
