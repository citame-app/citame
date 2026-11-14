import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CalendarAppointment, CalendarResponse } from "@sob/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { AppointmentActions } from "./appointment-actions";

const STAFF = "0198f5a0-7b1c-7000-8000-000000000201";
const ID = "0198f5a0-7b1c-7000-8000-0000000000a1";
const realFetch = globalThis.fetch;
const NOW = new Date("2026-03-09T15:00:00.000Z");

const appointment: CalendarAppointment = {
  id: ID,
  staffId: STAFF,
  clientId: "0198f5a0-7b1c-7000-8000-0000000000c1",
  startsAt: "2026-03-09T14:00:00.000Z",
  endsAt: "2026-03-09T15:00:00.000Z",
  status: "booked",
  notes: null,
  version: 3,
  services: [],
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  clientName: "Lucia",
  serviceNames: ["Haircut"],
};
const calendar: CalendarResponse = {
  timezone: "America/Argentina/Buenos_Aires",
  from: "2026-03-09T03:00:00.000Z",
  to: "2026-03-10T03:00:00.000Z",
  staff: [{ id: STAFF, displayName: "Ana" }],
  appointments: [appointment],
  timeOff: [],
  workingWindows: [],
};

let calls: { method: string; body: unknown }[];
let reply: { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: { ...appointment, status: "completed", version: 4 } };
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const setup = (props: Partial<Parameters<typeof AppointmentActions>[0]> = {}) => {
  const view = renderApp(
    <AppointmentActions
      appointment={appointment}
      role="staff"
      ownStaffId={STAFF}
      now={NOW}
      {...props}
    />,
  );
  view.queryClient.setQueryData(["admin", "calendar", "k"], calendar);
  return view;
};

describe("AppointmentActions", () => {
  test("a started booked appointment offers complete, no-show and cancel", () => {
    setup();
    expect(screen.getByRole("button", { name: "Mark completed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark no-show" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel appointment" })).toBeInTheDocument();
  });

  test("an appointment that has not started explains why it cannot be completed", () => {
    setup({ appointment: { ...appointment, startsAt: "2026-03-09T18:00:00.000Z" } });
    expect(screen.queryByRole("button", { name: "Mark completed" })).toBeNull();
    expect(
      screen.getByText("Outcomes can be recorded once the appointment starts."),
    ).toBeInTheDocument();
  });

  test("completing patches status with the version and updates the cache at once", async () => {
    const { queryClient } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Mark completed" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ method: "PATCH", body: { version: 3, status: "completed" } });
    await waitFor(() => {
      const cached = queryClient.getQueryData<CalendarResponse>(["admin", "calendar", "k"]);
      expect(cached?.appointments[0]?.status).toBe("completed");
      expect(cached?.appointments[0]?.version).toBe(4);
    });
  });

  test("a 409 rolls the optimistic change back and shows the friendly message", async () => {
    reply = { status: 409, body: { error: { code: "version_conflict", message: "stale" } } };
    const { queryClient } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Mark no-show" }));
    expect(
      await screen.findByText(
        "This appointment was changed by someone else. Reload it to see the latest version.",
      ),
    ).toBeInTheDocument();
    expect(
      queryClient.getQueryData<CalendarResponse>(["admin", "calendar", "k"])?.appointments[0]
        ?.status,
    ).toBe("booked");
  });

  test("cancelling needs a confirmation", async () => {
    reply = { status: 200, body: { ...appointment, status: "cancelled", version: 4 } };
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel appointment" }));
    const dialog = await screen.findByRole("dialog");
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ version: 3, status: "cancelled" }));
    expect(dialog).toBeDefined();
  });

  test("staff see nothing on another calendar", () => {
    setup({ ownStaffId: "someone-else" });
    expect(screen.queryByRole("button", { name: "Mark completed" })).toBeNull();
  });
});
