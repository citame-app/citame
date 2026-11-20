import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { AdminShell } from "./shell";

describe("AdminShell", () => {
  test("reserves room for the mobile bottom bar so toasts never sit on top of it", () => {
    const view = renderApp(
      <AdminShell role="owner" active="calendar">
        <p>content</p>
      </AdminShell>,
    );
    expect(document.documentElement.style.getPropertyValue("--bottom-nav")).toBe("3.5rem");
    view.unmount();
    expect(document.documentElement.style.getPropertyValue("--bottom-nav")).toBe("");
  });

  test("the owner gets the full sidebar, labelled and with the active page marked", () => {
    renderApp(
      <AdminShell role="owner" active="clients">
        <p>content</p>
      </AdminShell>,
    );
    const sidebar = screen.getByRole("navigation", { name: "Dashboard sections" });
    for (const name of ["Calendar", "Clients", "Services", "Team", "Reports", "Settings"]) {
      expect(within(sidebar).getByRole("link", { name })).toBeInTheDocument();
    }
    expect(within(sidebar).getByRole("link", { name: "Clients" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(sidebar).queryByRole("link", { name: "Today" })).toBeNull();
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  test("staff only see their sections, and their schedule is named for them", () => {
    renderApp(
      <AdminShell role="staff" active="calendar">
        <p>content</p>
      </AdminShell>,
    );
    const sidebar = screen.getByRole("navigation", { name: "Dashboard sections" });
    expect(within(sidebar).queryByRole("link", { name: "Services" })).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "Settings" })).toBeNull();
    expect(within(sidebar).getByRole("link", { name: "My schedule" })).toBeInTheDocument();
  });

  test("on phones a bottom bar keeps three sections and moves the rest behind More", async () => {
    renderApp(
      <AdminShell role="owner" active="calendar">
        <p>content</p>
      </AdminShell>,
    );
    const bar = screen.getByRole("navigation", { name: "Dashboard sections (mobile)" });
    expect(within(bar).getAllByRole("link")).toHaveLength(3);
    fireEvent.click(within(bar).getByRole("button", { name: "More" }));
    const dialog = await screen.findByRole("dialog", { name: "More" });
    for (const name of ["Team", "Services", "Settings"]) {
      expect(within(dialog).getByRole("link", { name: new RegExp(name) })).toBeInTheDocument();
    }
  });

  test("a staff bottom bar keeps daily work including checkout and puts secondary tools in More", () => {
    renderApp(
      <AdminShell role="staff" active="calendar">
        <p>content</p>
      </AdminShell>,
    );
    const bar = screen.getByRole("navigation", { name: "Dashboard sections (mobile)" });
    expect(within(bar).getAllByRole("link")).toHaveLength(3);
    expect(within(bar).getByRole("link", { name: "Sales & register" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "More" })).toBeInTheDocument();
  });
});

test("More identifies a current secondary section and exposes whether its navigation dialog is open", async () => {
  renderApp(
    <AdminShell role="owner" active="settings">
      <p>content</p>
    </AdminShell>,
  );
  const bar = screen.getByRole("navigation", { name: "Dashboard sections (mobile)" });
  const more = within(bar).getByRole("button", { name: "More" });
  expect(more).toHaveAttribute("aria-current", "page");
  expect(more).toHaveAttribute("aria-haspopup", "dialog");
  expect(more).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(more);
  await screen.findByRole("dialog", { name: "More" });
  expect(more).toHaveAttribute("aria-expanded", "true");
});
