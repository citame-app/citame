import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CalendarAppointment, CalendarResponse } from "@sob/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../../test/render";
import { CalendarView } from "./calendar-view";
import { isLocalCalendarMove } from "./move-requests";

const ANA = "0198f5a0-7b1c-7000-8000-000000000201";
const BEA = "0198f5a0-7b1c-7000-8000-000000000202";
const realFetch = globalThis.fetch;
const NOW = new Date("2026-03-09T15:20:00.000Z");

const lucia: CalendarAppointment = {
  id: "0198f5a0-7b1c-7000-8000-0000000000a1",
  staffId: ANA,
  clientId: "0198f5a0-7b1c-7000-8000-0000000000c1",
  startsAt: "2026-03-09T13:00:00.000Z",
  endsAt: "2026-03-09T14:00:00.000Z",
  status: "booked",
  notes: null,
  version: 2,
  services: [
    {
      serviceId: "0198f5a0-7b1c-7000-8000-000000000101",
      name: "Haircut",
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: 1000,
      currency: "ARS",
    },
  ],
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  clientName: "Lucia",
  serviceNames: ["Haircut"],
};

let patchReply: { status: number; body: unknown };
let stored: CalendarAppointment;
let additionalAppointments: CalendarAppointment[];
let requests: string[];
let patches: unknown[];
let holdPatch: Promise<void> | undefined;
let holdCalendar: Promise<void> | undefined;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  requests = [];
  patches = [];
  holdPatch = undefined;
  holdCalendar = undefined;
  stored = lucia;
  additionalAppointments = [];
  patchReply = {
    status: 200,
    body: {
      ...lucia,
      version: 3,
      startsAt: "2026-03-09T13:15:00.000Z",
      endsAt: "2026-03-09T14:15:00.000Z",
    },
  };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/appointments/calendar") {
      await holdCalendar;
      return json({
        timezone: "America/Argentina/Buenos_Aires",
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
        staff: [
          { id: ANA, displayName: "Ana" },
          { id: BEA, displayName: "Bea" },
        ],
        appointments: [stored, ...additionalAppointments],
        timeOff: [],
        workingWindows: [
          {
            staffId: ANA,
            startsAt: "2026-03-09T12:00:00.000Z",
            endsAt: "2026-03-09T21:00:00.000Z",
          },
        ],
      });
    }
    if (url.pathname === "/api/salon")
      return json({
        name: "S",
        timezone: "America/Argentina/Buenos_Aires",
        slotGranularityMinutes: 15,
        minNoticeMinutes: 60,
        maxDaysAhead: 60,
      });
    if (url.pathname === "/api/admin/staff")
      return json({
        staff: [
          { id: ANA, displayName: "Ana", active: true, userId: null, serviceIds: [] },
          { id: BEA, displayName: "Bea", active: true, userId: null, serviceIds: [] },
        ],
      });
    if (url.pathname === "/api/services") return json({ services: [] });
    if (url.pathname.startsWith("/api/admin/clients"))
      return json({ clients: [], page: 1, pageSize: 8, total: 0 });
    if (init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      await holdPatch;
      if (patchReply.status === 200) stored = patchReply.body as CalendarAppointment;
      return json(patchReply.body, patchReply.status);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const open = (props: Partial<Parameters<typeof CalendarView>[0]> = {}) => {
  const onSearchChange = mock();
  const view = renderApp(
    <CalendarView
      search={{ view: "day", date: "2026-03-09" }}
      onSearchChange={onSearchChange}
      role="owner"
      ownStaffId={null}
      now={NOW}
      {...props}
    />,
  );
  return { ...view, onSearchChange };
};

function RemountingCalendar() {
  const [key, setKey] = useState(1);
  return (
    <>
      <button type="button" onClick={() => setKey(key + 1)}>
        Remount
      </button>
      <CalendarView
        key={key}
        search={{ view: "day", date: "2026-03-09" }}
        onSearchChange={() => {}}
        role="owner"
        ownStaffId={null}
        now={NOW}
      />
    </>
  );
}

describe("CalendarView", () => {
  test("booked resources with the same name filter by ID and clear independently", async () => {
    const firstRoom = "0198f5a0-7b1c-7000-8000-000000000301";
    const secondRoom = "0198f5a0-7b1c-7000-8000-000000000302";
    stored = {
      ...lucia,
      resources: [{ resourceId: firstRoom, name: "Treatment room", quantity: 1 }],
    };
    additionalAppointments = [
      {
        ...lucia,
        id: "0198f5a0-7b1c-7000-8000-0000000000a2",
        clientName: "Marta",
        resources: [{ resourceId: secondRoom, name: "Treatment room", quantity: 1 }],
      },
      {
        ...lucia,
        id: "0198f5a0-7b1c-7000-8000-0000000000a3",
        clientName: "Nora",
        resources: [{ name: "Treatment room", quantity: 1 }],
      },
    ];
    open({ search: { date: "2026-03-09", view: "list" } });
    const agenda = await screen.findByRole("region", { name: "List" });
    const filter = await screen.findByRole("combobox", { name: "Booked resource" });
    expect(within(filter).getAllByRole("option")).toHaveLength(3);
    fireEvent.change(filter, { target: { value: secondRoom } });
    expect(within(agenda).getByRole("button", { name: /Marta/ })).toBeInTheDocument();
    expect(within(agenda).queryByRole("button", { name: /Lucia|Nora/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(within(agenda).getByRole("button", { name: /Lucia/ })).toBeInTheDocument();
    expect(within(agenda).getByRole("button", { name: /Nora/ })).toBeInTheDocument();
  });

  test("the week shows every professional and drills down to a professional's day", async () => {
    const { onSearchChange } = open({ search: { date: "2026-03-09", view: "week" } });
    const week = await screen.findByRole("region", { name: "Week" });
    expect(within(week).getByText("Ana")).toBeInTheDocument();
    expect(within(week).getByText("Bea")).toBeInTheDocument();
    fireEvent.click(within(week).getByRole("button", { name: "Ana, 2026-03-09: Show all (1)" }));
    expect(onSearchChange).toHaveBeenCalledWith(
      expect.objectContaining({ view: "day", date: "2026-03-09", staff: ANA }),
    );
    expect(requests.find((r) => r.includes("/api/appointments/calendar"))).not.toContain(
      "staffIds=",
    );
  });

  test("month and list views open the original reservation and search filters locally", async () => {
    const { unmount } = open({ search: { date: "2026-03-09", view: "month" } });
    const month = await screen.findByRole("region", { name: "Month" });
    fireEvent.click(within(month).getByRole("button", { name: /Lucia/ }));
    expect(await screen.findByRole("dialog", { name: "Lucia" })).toBeInTheDocument();
    unmount();
    open({ search: { date: "2026-03-09", view: "list" } });
    const agenda = await screen.findByRole("region", { name: "List" });
    expect(within(agenda).getAllByText("Scheduled value")).toHaveLength(7);
    const calls = requests.filter((r) => r.includes("/api/appointments/calendar")).length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search appointments" }), {
      target: { value: "Nobody" },
    });
    expect(within(agenda).queryByRole("button", { name: /Lucia/ })).toBeNull();
    expect(requests.filter((r) => r.includes("/api/appointments/calendar"))).toHaveLength(calls);
  });

  test("working-team filtering hides a member without hours without losing the URL state", async () => {
    open({ search: { date: "2026-03-09", view: "day", working: true } });
    await screen.findByRole("group", { name: /Schedule for Ana/ });
    expect(screen.queryByRole("group", { name: /Schedule for Bea/ })).toBeNull();
  });

  test("owner sees one column per team member and the appointment", async () => {
    open();
    expect(await screen.findByRole("group", { name: /Schedule for Ana/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Schedule for Bea/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Lucia/ })).toBeInTheDocument();
  });

  test("asks the API for the salon-local day, as instants", async () => {
    open();
    await screen.findByRole("group", { name: /Schedule for Ana/ });
    const call = requests.find((r) => r.includes("/api/appointments/calendar")) ?? "";
    expect(call).toContain("from=2026-03-09T03%3A00%3A00.000Z");
    expect(call).toContain("to=2026-03-10T03%3A00%3A00.000Z");
  });

  test("staff do not get a team filter", async () => {
    open({ role: "staff", ownStaffId: ANA });
    await screen.findByRole("group", { name: /Schedule for Ana/ });
    expect(screen.queryByRole("button", { name: "Team members" })).toBeNull();
  });

  test("toolbar navigation and view toggle go through the search state", async () => {
    const { onSearchChange } = open();
    await screen.findByRole("group", { name: /Schedule for Ana/ });
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(onSearchChange).toHaveBeenLastCalledWith({ view: "day", date: "2026-03-10" });
    fireEvent.change(screen.getByRole("combobox", { name: "Calendar view" }), {
      target: { value: "week" },
    });
    expect(onSearchChange).toHaveBeenLastCalledWith(expect.objectContaining({ view: "week" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(onSearchChange).toHaveBeenLastCalledWith({ view: "day", date: "2026-03-09" });
  });

  test("keyboard shortcuts navigate and open the help", async () => {
    const { onSearchChange } = open();
    await screen.findByRole("group", { name: /Schedule for Ana/ });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(onSearchChange).toHaveBeenLastCalledWith({ view: "day", date: "2026-03-10" });
    fireEvent.keyDown(document.body, { key: "w" });
    expect(onSearchChange).toHaveBeenLastCalledWith(expect.objectContaining({ view: "week" }));
    fireEvent.keyDown(document.body, { key: "?" });
    const help = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(help).getByText("Go to today")).toBeInTheDocument();
    expect(within(help).getByText("Alt + arrows")).toBeInTheDocument();
  });

  test("typing in a field never triggers a shortcut", async () => {
    const { onSearchChange } = open();
    await screen.findByRole("group", { name: /Schedule for Ana/ });
    fireEvent.keyDown(document.body, { key: "n" });
    const input = await screen.findByLabelText("Search by name, phone or email");
    onSearchChange.mockClear();
    fireEvent.keyDown(input, { key: "w" });
    expect(onSearchChange).not.toHaveBeenCalled();
  });

  test("clicking an empty spot opens the new-appointment sheet for that column and time", async () => {
    open();
    const column = await screen.findByRole("group", { name: /Schedule for Bea/ });
    fireEvent.click(within(column).getByTestId("slot-surface"), { clientY: 160 });
    expect(await screen.findByRole("dialog", { name: "New appointment" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Team member")).toHaveValue(BEA);
    expect(screen.getByLabelText("Start time")).toHaveValue("09:45");
  });

  test("the New appointment button and the n shortcut open the same sheet", async () => {
    open();
    await screen.findByRole("group", { name: /Schedule for Ana/ });
    fireEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
    fireEvent.click(await screen.findByRole("button", { name: "New appointment" }));
    expect(await screen.findByRole("dialog", { name: "New appointment" })).toBeInTheDocument();
  });

  test("clicking an appointment opens its drawer", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: /Lucia/ }));
    expect(await screen.findByRole("dialog", { name: "Lucia" })).toBeInTheDocument();
  });

  test("Alt+ArrowDown moves the appointment one slot, optimistically", async () => {
    const { queryClient } = open();
    const block = await screen.findByRole("button", { name: /Lucia/ });
    fireEvent.keyDown(block, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      version: 2,
      startsAt: "2026-03-09T13:15:00.000Z",
      override: true,
    });
    await waitFor(() => {
      const cached = queryClient.getQueriesData<{ appointments: CalendarAppointment[] }>({
        queryKey: ["admin", "calendar"],
      })[0]?.[1];
      expect(cached?.appointments[0]?.version).toBe(3);
    });
  });

  test("a slot conflict rolls back and shows a banner with a way to recover", async () => {
    patchReply = { status: 409, body: { error: { code: "slot_taken", message: "taken" } } };
    open();
    const block = await screen.findByRole("button", { name: /Lucia/ });
    fireEvent.keyDown(block, { key: "ArrowDown", altKey: true });
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Someone just took that time. Pick another time to continue.");
    fireEvent.click(within(banner).getByRole("button", { name: "Open appointment" }));
    expect(await screen.findByRole("dialog", { name: "Lucia" })).toBeInTheDocument();
  });

  test("an in-flight move stays visible and locked when the calendar remounts", async () => {
    const response = Promise.withResolvers<void>();
    holdPatch = response.promise;
    const { queryClient } = renderApp(<RemountingCalendar />);
    const original = await screen.findByRole("button", { name: /Lucia/ });
    try {
      fireEvent.keyDown(original, { key: "ArrowDown", altKey: true });
      await waitFor(() => expect(patches).toHaveLength(1));
      expect(
        isLocalCalendarMove(queryClient, {
          ...lucia,
          version: 3,
          startsAt: "2026-03-09T13:15:00Z",
        }),
      ).toBe(true);
      expect(
        isLocalCalendarMove(queryClient, {
          ...lucia,
          version: 4,
          startsAt: "2026-03-09T13:15:00Z",
        }),
      ).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Remount" }));
      const current = await screen.findByRole("button", { name: /Lucia/ });
      expect(current).not.toBe(original);
      expect(current).toHaveTextContent("10:15");
      fireEvent.keyDown(current, { key: "ArrowDown", altKey: true });
      response.resolve();
      expect(await screen.findByText("Appointment moved")).toBeVisible();
      expect(patches).toHaveLength(1);
    } finally {
      response.resolve();
    }
  });

  for (const movedElsewhere of [false, true]) {
    test(`a rejected move preserves live refreshes (same appointment updated: ${movedElsewhere})`, async () => {
      const other = {
        ...lucia,
        id: crypto.randomUUID(),
        clientName: "Synthetic second appointment",
      };
      additionalAppointments = [other];
      const patch = Promise.withResolvers<void>();
      const refresh = Promise.withResolvers<void>();
      holdPatch = patch.promise;
      patchReply = { status: 409, body: { error: { code: "slot_taken", message: "taken" } } };
      const { queryClient } = open();
      const filters = { queryKey: ["admin", "calendar"] };
      const read = () => queryClient.getQueriesData<CalendarResponse>(filters)[0]?.[1];
      try {
        const block = await screen.findByRole("button", { name: /Lucia/ });
        fireEvent.keyDown(block, { key: "ArrowDown", altKey: true });
        await waitFor(() => expect(patches).toHaveLength(1));
        expect(block).toHaveTextContent("10:15");
        expect(read()?.appointments[0]?.startsAt).toBe(lucia.startsAt);
        fireEvent.keyDown(block, { key: "ArrowDown", altKey: true });
        expect(patches).toHaveLength(1);
        fireEvent.click(block);
        const drawer = await screen.findByRole("dialog", { name: "Lucia" });
        expect(within(drawer).getByRole("button", { name: "Reschedule" })).toBeDisabled();
        fireEvent.click(within(drawer).getByRole("button", { name: "Close panel" }));

        if (movedElsewhere)
          stored = {
            ...lucia,
            version: 3,
            startsAt: "2026-03-09T16:00:00.000Z",
            endsAt: "2026-03-09T17:00:00.000Z",
          };
        additionalAppointments = [{ ...other, version: 3, clientName: "Updated in Desktop" }];
        await act(() => queryClient.invalidateQueries(filters));
        await waitFor(() =>
          expect(screen.getByRole("button", { name: /Lucia/ })).toHaveTextContent(
            movedElsewhere ? "1:00" : "10:15",
          ),
        );
        holdCalendar = refresh.promise;
        patch.resolve();
        await screen.findByRole("alert");
        expect(read()?.appointments[0]).toMatchObject({
          version: stored.version,
          startsAt: stored.startsAt,
        });
        expect(read()?.appointments[1]).toMatchObject({
          version: 3,
          clientName: "Updated in Desktop",
        });
      } finally {
        patch.resolve();
        refresh.resolve();
      }
    });
  }
});
test("read-only calendar access hides create and mutation controls including keyboard creation", async () => {
  renderApp(
    <CalendarView
      search={{ view: "day", date: "2026-03-09" }}
      onSearchChange={() => {}}
      role="staff"
      ownStaffId={ANA}
      readOnly
      now={NOW}
    />,
  );
  await screen.findByRole("button", { name: /Lucia/ });
  expect(screen.queryByRole("button", { name: "New appointment" })).toBeNull();
  fireEvent.keyDown(document, { key: "n" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a receptionist's effective all-calendar view does not grant deposit-waiver controls", async () => {
  renderApp(
    <CalendarView
      search={{ date: "2026-03-09", view: "day" }}
      onSearchChange={() => {}}
      role="owner"
      bookingRole="staff"
      accessPreset="receptionist"
      ownStaffId={ANA}
      now={NOW}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Add to calendar" }));
  fireEvent.click(await screen.findByRole("button", { name: "New appointment" }));
  await screen.findByRole("dialog", { name: "New appointment" });
  expect(screen.queryByLabelText("Deposit waiver reason (manager only)")).toBeNull();
  expect(screen.getByLabelText("Team member")).not.toBeDisabled();
});
