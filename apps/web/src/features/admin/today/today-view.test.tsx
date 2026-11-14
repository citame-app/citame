import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CalendarAppointment } from "@sob/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { TodayView } from "./today-view";

const STAFF = "0198f5a0-7b1c-7000-8000-000000000201";
const realFetch = globalThis.fetch;
const NOW = new Date("2026-03-09T15:30:00.000Z"); // 12:30 in Buenos Aires

const appt = (
  n: number,
  hhmm: string,
  status: CalendarAppointment["status"],
  client: string,
): CalendarAppointment => {
  const startsAt = `2026-03-09T${hhmm}:00.000Z`;
  return {
    id: `0198f5a0-7b1c-7000-8000-0000000000a${n}`,
    staffId: STAFF,
    clientId: "0198f5a0-7b1c-7000-8000-0000000000c1",
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    status,
    notes: null,
    version: 1,
    services: [
      {
        serviceId: null,
        name: "Haircut",
        durationMinutes: 60,
        bufferMinutes: 0,
        priceCents: 1_500_000,
        currency: "ARS",
      },
    ],
    createdAt: startsAt,
    updatedAt: startsAt,
    clientName: client,
    serviceNames: ["Haircut"],
  };
};

let appointments: CalendarAppointment[];
let failing = false;
let calls: string[];

beforeEach(() => {
  calls = [];
  failing = false;
  appointments = [
    appt(1, "14:00", "booked", "Paula"),
    appt(2, "17:00", "booked", "Romina"),
    appt(3, "12:00", "completed", "Sofia"),
  ];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (failing) return new Response("{}", { status: 500 });
    if (url.pathname === "/api/appointments/calendar") {
      return new Response(
        JSON.stringify({
          timezone: "America/Argentina/Buenos_Aires",
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
          staff: [{ id: STAFF, displayName: "Ana" }],
          appointments,
          timeOff: [],
          workingWindows: [],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      const id = url.pathname.split("/").pop();
      const saved = {
        ...(appointments.find((a) => a.id === id) as CalendarAppointment),
        status: body.status,
        version: 2,
      };
      appointments = appointments.map((a) => (a.id === id ? saved : a));
      return new Response(JSON.stringify(saved), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const view = () => renderApp(<TodayView role="staff" ownStaffId={STAFF} now={NOW} />);

describe("TodayView", () => {
  test("shows a skeleton first, then the day", async () => {
    view();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Next up" })).toBeInTheDocument();
  });

  test("quick stats count the day and sum the expected revenue", async () => {
    view();
    const stats = await screen.findByRole("group", { name: "Today in numbers" });
    expect(within(stats).getByText("Appointments").nextElementSibling).toHaveTextContent("3");
    expect(within(stats).getByText("Still to come").nextElementSibling).toHaveTextContent("1");
    expect(within(stats).getByText("Completed").nextElementSibling).toHaveTextContent("1");
  });

  test("next up names the client and time of the first appointment that has not started", async () => {
    view();
    const next = (await screen.findByRole("heading", { name: "Next up" })).closest(
      "section",
    ) as HTMLElement;
    expect(within(next).getByText("Romina")).toBeInTheDocument();
    expect(within(next).getByText(/2:00 PM/)).toBeInTheDocument();
  });

  test("pending actions list started appointments and complete them in place", async () => {
    view();
    const pending = (
      await screen.findByRole("heading", { name: "Waiting for an outcome" })
    ).closest("section") as HTMLElement;
    expect(within(pending).getByText("Paula")).toBeInTheDocument();
    fireEvent.click(within(pending).getByRole("button", { name: "Mark completed" }));
    await waitFor(() =>
      expect(calls).toContain("PATCH /api/appointments/0198f5a0-7b1c-7000-8000-0000000000a1"),
    );
    await waitFor(() => expect(within(pending).queryByText("Paula")).toBeNull());
  });

  test("the timeline lists every active appointment in order", async () => {
    view();
    const list = await screen.findByRole("list", { name: "Today's schedule" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining("Sofia"),
      expect.stringContaining("Paula"),
      expect.stringContaining("Romina"),
    ]);
  });

  test("an empty day is a designed state with a way forward", async () => {
    appointments = [];
    view();
    expect(await screen.findByText("No appointments today")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open calendar" })).toBeInTheDocument();
  });

  test("a failure shows an error with retry", async () => {
    failing = true;
    view();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Next up" })).toBeInTheDocument();
  });
});
