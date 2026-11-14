import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { AdminShell } from "./shell";

describe("AdminShell", () => {
  test("reserves room for the mobile bottom bar so toasts never sit on top of it", () => {
    const view = renderApp(
      <AdminShell role="owner" active="today">
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
    for (const name of [
      "Today",
      "Calendar",
      "Clients",
      "Services",
      "Team",
      "Reports",
      "Settings",
    ]) {
      expect(within(sidebar).getByRole("link", { name })).toBeInTheDocument();
    }
    expect(within(sidebar).getByRole("link", { name: "Clients" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(sidebar).getByRole("link", { name: "Today" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  test("staff only see their sections, and their schedule is named for them", () => {
    renderApp(
      <AdminShell role="staff" active="today">
        <p>content</p>
      </AdminShell>,
    );
    const sidebar = screen.getByRole("navigation", { name: "Dashboard sections" });
    expect(within(sidebar).queryByRole("link", { name: "Services" })).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "Settings" })).toBeNull();
    expect(within(sidebar).getByRole("link", { name: "My schedule" })).toBeInTheDocument();
  });

  test("on phones a bottom bar keeps four sections and moves the rest behind More", async () => {
    renderApp(
      <AdminShell role="owner" active="today">
        <p>content</p>
      </AdminShell>,
    );
    const bar = screen.getByRole("navigation", { name: "Dashboard sections (mobile)" });
    expect(within(bar).getAllByRole("link")).toHaveLength(4);
    fireEvent.click(within(bar).getByRole("button", { name: "More" }));
    const dialog = await screen.findByRole("dialog", { name: "More" });
    for (const name of ["Team", "Services", "Settings"]) {
      expect(within(dialog).getByRole("link", { name: new RegExp(name) })).toBeInTheDocument();
    }
  });

  test("a staff bottom bar fits without More", () => {
    renderApp(
      <AdminShell role="staff" active="today">
        <p>content</p>
      </AdminShell>,
    );
    const bar = screen.getByRole("navigation", { name: "Dashboard sections (mobile)" });
    expect(within(bar).getAllByRole("link")).toHaveLength(5);
    expect(within(bar).queryByRole("button", { name: "More" })).toBeNull();
  });
});
