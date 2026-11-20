import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  fireEvent,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { StaffPortraitEditor } from "./staff-portrait";
import { StaffView, validateStaffSearch } from "./staff-view";

const ANA = "0198f5a0-7b1c-7000-8000-000000000201";
const BEA = "0198f5a0-7b1c-7000-8000-000000000202";
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/admin/staff") {
      return json({
        staff: [
          {
            id: ANA,
            displayName: "Ana",
            active: true,
            userId: "u1",
            serviceIds: [],
          },
          {
            id: BEA,
            displayName: "Bea",
            active: true,
            userId: "u2",
            serviceIds: [],
          },
        ],
      });
    }
    if (url.pathname.endsWith("/working-hours"))
      return json({
        staffId: ANA,
        hours: [{ weekday: 1, startTime: "09:00", endTime: "17:00" }],
        conflicts: [],
      });
    if (url.pathname.endsWith("/time-off")) return json({ timeOff: [] });
    return json({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("validateStaffSearch", () => {
  test("keeps a valid member and tab, defaults to hours", () => {
    expect(validateStaffSearch({})).toEqual({ tab: "hours" });
    expect(validateStaffSearch({ member: ANA, tab: "timeoff" })).toEqual({
      member: ANA,
      tab: "timeoff",
    });
    expect(validateStaffSearch({ member: "nope", tab: "x" })).toEqual({
      tab: "hours",
    });
  });
});

describe("StaffView", () => {
  test("removing a portrait only sends a versioned deletion after confirmation", async () => {
    const version = "0198f5a0-7b1c-7000-8000-000000000203";
    const member = {
      id: ANA,
      displayName: "Ana",
      active: true,
      serviceIds: [],
      userId: null,
    };
    const request = mock(async () => json({ version: null }));
    globalThis.fetch = request as unknown as typeof fetch;
    renderApp(<StaffPortraitEditor member={{ ...member, portraitVersion: version }} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    let dialog = await screen.findByRole("dialog", { name: "Remove photo" });
    expect(request).not.toHaveBeenCalled();
    const cancelled = waitForElementToBeRemoved(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await cancelled;
    expect(request).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    dialog = await screen.findByRole("dialog", { name: "Remove photo" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove photo" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining(`/admin/staff/${ANA}/portrait`),
        expect.objectContaining({
          body: JSON.stringify({ version, imageBase64: null }),
        }),
      ),
    );
  });

  test("the owner starts on the team list", async () => {
    renderApp(
      <StaffView
        search={{ tab: "hours" }}
        onSearchChange={() => {}}
        role="owner"
        ownStaffId={null}
      />,
    );
    expect(await screen.findByRole("table", { name: "Team members" })).toBeInTheDocument();
  });

  test("opening a member goes through the URL state", async () => {
    const onSearchChange = mock();
    renderApp(
      <StaffView
        search={{ tab: "hours" }}
        onSearchChange={onSearchChange}
        role="owner"
        ownStaffId={null}
      />,
    );
    const table = await screen.findByRole("table", { name: "Team members" });
    fireEvent.click(within(table).getByRole("button", { name: "Bea" }));
    expect(onSearchChange).toHaveBeenCalledWith({ member: BEA, tab: "hours" });
  });

  test("the owner edits hours and time off of a member", async () => {
    renderApp(
      <StaffView
        search={{ member: ANA, tab: "hours" }}
        onSearchChange={() => {}}
        role="owner"
        ownStaffId={null}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Ana" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Save hours" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All team members" })).toBeInTheDocument();
  });

  test("staff land on their own schedule: hours read-only, time off editable", async () => {
    const onSearchChange = mock();
    const { unmount } = renderApp(
      <StaffView
        search={{ tab: "hours" }}
        onSearchChange={onSearchChange}
        role="staff"
        ownStaffId={ANA}
      />,
    );
    expect(await screen.findByText("Only the owner can change working hours.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save hours" })).toBeNull();
    expect(screen.queryByRole("button", { name: "All team members" })).toBeNull();
    unmount();
    renderApp(
      <StaffView
        search={{ tab: "timeoff" }}
        onSearchChange={() => {}}
        role="staff"
        ownStaffId={ANA}
      />,
    );
    expect(await screen.findByRole("button", { name: "Add time off" })).toBeInTheDocument();
  });

  test("tabs switch through the URL state", async () => {
    const onSearchChange = mock();
    renderApp(
      <StaffView
        search={{ member: ANA, tab: "hours" }}
        onSearchChange={onSearchChange}
        role="owner"
        ownStaffId={null}
      />,
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Time off" }));
    expect(onSearchChange).toHaveBeenCalledWith({
      member: ANA,
      tab: "timeoff",
    });
  });
});
