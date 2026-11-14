import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { HoursEditor } from "./hours-editor";

const STAFF = "0198f5a0-7b1c-7000-8000-000000000201";
const CLIENT = "0198f5a0-7b1c-7000-8000-0000000000c1";
const realFetch = globalThis.fetch;

let hours: { weekday: number; startTime: string; endTime: string }[];
let conflicts: unknown[];
let puts: unknown[];
let putReply: { status: number; body?: unknown };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const conflict = {
  appointmentId: "0198f5a0-7b1c-7000-8000-0000000000a1",
  clientId: CLIENT,
  startsAt: "2026-03-16T20:00:00.000Z",
  endsAt: "2026-03-16T21:00:00.000Z",
  reasons: ["outside_working_hours"],
};

beforeEach(() => {
  puts = [];
  conflicts = [];
  putReply = { status: 200 };
  hours = [
    { weekday: 1, startTime: "09:00", endTime: "13:00" },
    { weekday: 1, startTime: "14:00", endTime: "18:00" },
    { weekday: 2, startTime: "09:00", endTime: "18:00" },
  ];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === `/api/admin/staff/${STAFF}/working-hours`) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        if (putReply.status !== 200) return json(putReply.body, putReply.status);
        hours = body.hours;
        return json({ staffId: STAFF, hours, conflicts });
      }
      return json({ staffId: STAFF, hours, conflicts });
    }
    if (url.pathname === `/api/admin/clients/${CLIENT}`) {
      return json({
        client: {
          id: CLIENT,
          name: "Lucia Perez",
          phone: null,
          email: null,
          notes: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          appointmentCount: 1,
          lastVisitAt: null,
        },
        appointments: [],
      });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const open = (editable = true) => renderApp(<HoursEditor staffId={STAFF} editable={editable} />);

describe("HoursEditor", () => {
  test("shows the week from Monday with ranges and days off", async () => {
    open();
    const monday = (await screen.findByRole("group", { name: "Monday" })) as HTMLElement;
    expect(within(monday).getByLabelText("From (Monday, range 1)")).toHaveValue("09:00");
    expect(within(monday).getByLabelText("To (Monday, range 2)")).toHaveValue("18:00");
    expect(
      within(screen.getByRole("group", { name: "Sunday" })).getByText("Day off"),
    ).toBeInTheDocument();
    const names = screen
      .getAllByRole("group")
      .map((g) => g.getAttribute("aria-label") ?? g.querySelector("legend")?.textContent);
    expect(names.slice(0, 2)).toEqual(["Monday", "Tuesday"]);
  });

  test("adding hours to a day off starts at 09:00-18:00 and marks the form unsaved", async () => {
    open();
    const sunday = await screen.findByRole("group", { name: "Sunday" });
    expect(screen.getByRole("button", { name: "Save hours" })).toBeDisabled();
    fireEvent.click(within(sunday).getByRole("button", { name: "Add hours" }));
    expect(within(sunday).getByLabelText("From (Sunday, range 1)")).toHaveValue("09:00");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save hours" })).toBeEnabled();
  });

  test("an end before the start is explained and blocks saving", async () => {
    open();
    const tuesday = await screen.findByRole("group", { name: "Tuesday" });
    fireEvent.change(within(tuesday).getByLabelText("To (Tuesday, range 1)"), {
      target: { value: "08:00" },
    });
    expect(within(tuesday).getByText("The end must be after the start")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save hours" })).toBeDisabled();
  });

  test("an overlapping range is flagged", async () => {
    open();
    const monday = await screen.findByRole("group", { name: "Monday" });
    fireEvent.change(within(monday).getByLabelText("From (Monday, range 2)"), {
      target: { value: "12:00" },
    });
    expect(within(monday).getByText("These hours overlap the previous range")).toBeInTheDocument();
  });

  test("copy to other days replaces them with the source day", async () => {
    open();
    const monday = await screen.findByRole("group", { name: "Monday" });
    fireEvent.click(within(monday).getByRole("button", { name: "Copy to..." }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Wednesday" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Thursday" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const wednesday = screen.getByRole("group", { name: "Wednesday" });
    expect(within(wednesday).getByLabelText("From (Wednesday, range 2)")).toHaveValue("14:00");
    expect(
      within(screen.getByRole("group", { name: "Thursday" })).getByLabelText(
        "To (Thursday, range 1)",
      ),
    ).toHaveValue("13:00");
  });

  test("saving sends the whole week and lists the conflicts the API returns", async () => {
    conflicts = [conflict];
    open();
    const tuesday = await screen.findByRole("group", { name: "Tuesday" });
    fireEvent.change(within(tuesday).getByLabelText("To (Tuesday, range 1)"), {
      target: { value: "16:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect((puts[0] as { hours: unknown[] }).hours).toEqual([
      { weekday: 1, startTime: "09:00", endTime: "13:00" },
      { weekday: 1, startTime: "14:00", endTime: "18:00" },
      { weekday: 2, startTime: "09:00", endTime: "16:00" },
    ]);
    expect(await screen.findByText("Working hours saved")).toBeInTheDocument();
    const warning = await screen.findByRole("region", {
      name: "1 existing appointment no longer fits",
    });
    expect(within(warning).getByText(/outside working hours/)).toBeInTheDocument();
    expect(await within(warning).findByText("Lucia Perez")).toBeInTheDocument();
  });

  test("conflicts that already exist are shown before any edit", async () => {
    conflicts = [conflict];
    open();
    const warning = await screen.findByRole("region", {
      name: "1 existing appointment no longer fits",
    });
    expect(await within(warning).findByText("Lucia Perez")).toBeInTheDocument();
  });

  test("a read-only view cannot edit or save", async () => {
    open(false);
    const monday = await screen.findByRole("group", { name: "Monday" });
    expect(within(monday).getByLabelText("From (Monday, range 1)")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save hours" })).toBeNull();
    expect(screen.getByText("Only the owner can change working hours.")).toBeInTheDocument();
  });
});
