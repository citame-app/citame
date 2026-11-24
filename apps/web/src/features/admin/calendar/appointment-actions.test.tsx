import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CalendarAppointment, CalendarResponse } from "@sob/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../../test/render";
import { AppointmentActions } from "./appointment-actions";
import { isLocalCalendarWrite } from "./appointment-writes";

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
let responseGate: Promise<void> | undefined;

beforeEach(() => {
  calls = [];
  responseGate = undefined;
  reply = { status: 200, body: { ...appointment, status: "completed", version: 4 } };
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    await responseGate;
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

function ChangingAppointment({
  subscribe,
}: {
  subscribe: (publish: (a: CalendarAppointment) => void) => void;
}) {
  const [current, setCurrent] = useState(appointment);
  subscribe(setCurrent);
  return <AppointmentActions appointment={current} role="staff" ownStaffId={STAFF} now={NOW} />;
}

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

  test("a rejected attendance change preserves the latest calendar rows", async () => {
    const gate = Promise.withResolvers<void>();
    responseGate = gate.promise;
    reply = { status: 409, body: { error: { code: "version_conflict", message: "stale" } } };
    const { queryClient } = setup();
    const key = ["admin", "calendar", "k"];
    const live = {
      ...calendar,
      appointments: [
        { ...appointment, version: 4, status: "cancelled" as const },
        { ...appointment, id: crypto.randomUUID(), clientName: "Added in Desktop" },
      ],
    };
    try {
      fireEvent.click(screen.getByRole("button", { name: "Mark no-show" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      act(() => queryClient.setQueryData(key, live));
      gate.resolve();
      await screen.findByText(/changed by someone else/);
      expect(queryClient.getQueryData(key)).toEqual(live);
    } finally {
      gate.resolve();
    }
  });

  test("cancelling needs a confirmation and a remote cancellation stays observable until success", async () => {
    const saved = { ...appointment, status: "cancelled" as const, version: 4 };
    const gate = Promise.withResolvers<void>();
    reply = { status: 200, body: saved };
    responseGate = gate.promise;
    const { queryClient } = setup();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Cancel appointment" }));
      await screen.findByRole("dialog");
      expect(calls).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
      await waitFor(() => expect(calls[0]?.body).toEqual({ version: 3, status: "cancelled" }));
      expect(isLocalCalendarWrite(queryClient, saved, "cancelled")).toBe(false);
      gate.resolve();
      await screen.findByText("Appointment cancelled");
      expect(isLocalCalendarWrite(queryClient, saved, "cancelled")).toBe(true);
    } finally {
      gate.resolve();
    }
  });

  test("a live revision requires a fresh cancellation review", async () => {
    let publish: ((a: CalendarAppointment) => void) | undefined;
    renderApp(
      <ChangingAppointment
        subscribe={(update) => {
          publish = update;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel appointment" }));
    const confirm = await screen.findByRole("button", { name: "Yes, cancel it" });
    expect(confirm).toBeEnabled();
    act(() => publish?.({ ...appointment, version: 4, startsAt: "2026-03-09T14:30:00.000Z" }));
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(calls).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent(/changed by someone else/);
  });

  test("staff see nothing on another calendar", () => {
    setup({ ownStaffId: "someone-else" });
    expect(screen.queryByRole("button", { name: "Mark completed" })).toBeNull();
  });
});

test("a status change invalidates the linked series and the slots that may have been released", async () => {
  const { queryClient } = setup();
  queryClient.setQueryData(["appointments", "series", "series-id"], {
    appointments: [appointment],
  });
  queryClient.setQueryData(["availability", "slots"], { slots: [] });
  fireEvent.click(screen.getByRole("button", { name: "Mark completed" }));
  await waitFor(() =>
    expect(queryClient.getQueryState(["appointments", "series", "series-id"])?.isInvalidated).toBe(
      true,
    ),
  );
  expect(queryClient.getQueryState(["availability", "slots"])?.isInvalidated).toBe(true);
});
