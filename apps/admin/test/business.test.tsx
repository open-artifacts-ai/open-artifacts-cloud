import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { createBusinessMock } from "../src/mocks/business";
import { businessMock, renderApp, use } from "./harness";

// open-artifacts#2404: the Business requests page. The API is the stateful
// createBusinessMock.

const rowsText = () =>
  screen.getAllByTestId("business-row").map((r) => r.textContent ?? "");

it("lists the new requests first by default, newest first, with the page copy", async () => {
  renderApp("/business-requests");
  expect(
    await screen.findByRole("heading", { name: "Business requests" }),
  ).toBeInTheDocument();
  await screen.findByText("Priya Nair");
  const rows = rowsText();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("northwind.io");
  expect(rows[0]).toContain("51 to 200");
  expect(rows[0]).toContain("Google group sync, Audit log");
  expect(rows[0]).toContain("northwind.open-artifacts.app");
  expect(screen.getByRole("link", { name: /Business requests/ })).toBeTruthy();
});

it("All shows every request, newest first", async () => {
  renderApp("/business-requests");
  await screen.findByText("Priya Nair");
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  await waitFor(() => expect(rowsText()).toHaveLength(3));
  expect(rowsText().map((t) => t.slice(0, 40))).toEqual([
    expect.stringContaining("Priya Nair"),
    expect.stringContaining("Tom Becker"),
    expect.stringContaining("Ana Lopez"),
  ]);
});

it("changing the status patches the request and it leaves the New list", async () => {
  renderApp("/business-requests");
  const sel = await screen.findByRole("combobox", {
    name: "Status of priya@northwind.io",
  });
  fireEvent.change(sel, { target: { value: "contacted" } });
  await waitFor(() =>
    expect(
      businessMock.state().find((r) => r.email === "priya@northwind.io")
        ?.status,
    ).toBe("contacted"),
  );
  expect(await screen.findByText("No requests here.")).toBeInTheDocument();
});

it("a failed save says so", async () => {
  const bad = createBusinessMock();
  use(...bad.handlers);
  renderApp("/business-requests");
  const sel = await screen.findByRole("combobox", {
    name: "Status of priya@northwind.io",
  });
  bad.state().length = 0;
  fireEvent.change(sel, { target: { value: "closed" } });
  expect(
    await screen.findByText("That didn't save. Try again."),
  ).toBeInTheDocument();
  expect(within(document.body).queryByText("Priya Nair")).not.toBeNull();
});
