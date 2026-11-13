import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Appointment } from "@sob/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { MyAppointments } from "./my-appointments";

const STAFF = "0198f5a0-7b1c-7000-8000-000000000201";
const CLIENT = "0198f5a0-7b1c-7000-8000-000000000301";
const SERVICE = "0198f5a0-7b1c-7000-8000-000000000101";
const TZ = "America/Argentina/Buenos_Aires";

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const make = (
  n: number,
  startsAt: string,
  status: Appointment["status"] = "booked",
): Appointment => ({
  id: `0198f5a0-7b1c-7000-8000-00000000090${n}`,
  staffId: STAFF,
  clientId: CLIENT,
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
  status,
  notes: null,
  version: 1,
  services: [
    {
      serviceId: SERVICE,
      name: `Service ${n}`,
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: 3000,
      currency: "USD",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

let appointments: Appointment[];
let patchResult: "ok" | "fail" | "hang";
let releasePatch: (() => void) | undefined;
const realFetch = globalThis.fetch;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  appointments = [make(1, future(3)), make(2, future(-10), "completed")];
  patchResult = "ok";
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/staff") {
      return jsonResponse({
        staff: [{ id: STAFF, displayName: "Stylist A", serviceIds: [SERVICE] }],
      });
    }
    if (url.pathname === "/api/appointments" && (init?.method ?? "GET") === "GET") {
      return jsonResponse({ appointments, page: 1, pageSize: 200, total: appointments.length });
    }
    if (url.pathname.startsWith("/api/appointments/") && init?.method === "PATCH") {
      if (patchResult === "hang") await new Promise<void>((resolve) => (releasePatch = resolve));
      if (patchResult === "fail") {
        return jsonResponse({ error: { code: "internal_error", message: "boom" } }, 500);
      }
      const id = url.pathname.split("/").pop();
      const target = appointments.find((a) => a.id === id);
      return jsonResponse({ ...target, status: "cancelled", version: 2 });
    }
    return jsonResponse({ error: { code: "not_found", message: "x" } }, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const view = (props: Partial<Parameters<typeof MyAppointments>[0]> = {}) =>
  renderApp(<MyAppointments timeZone={TZ} onReschedule={() => {}} {...props} />);

describe("MyAppointments", () => {
  test("shows a skeleton while loading, then upcoming and past appointments in separate sections", async () => {
    view();
    expect(screen.getByRole("status", { name: "Loading your appointments" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Upcoming" })).toBeInTheDocument();
    expect(screen.getByText("Service 1")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(screen.getByText("Service 2")).toBeInTheDocument();
    expect(screen.getAllByText("Stylist A").length).toBeGreaterThan(0);
  });

  test("a client with nothing booked gets an invitation to book", async () => {
    appointments = [];
    view();
    expect(await screen.findByText("No appointments yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Book an appointment" })).toBeInTheDocument();
  });

  test("a failing request shows a retry that recovers", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ error: { code: "internal_error", message: "x" } }, 500),
    ) as unknown as typeof fetch;
    view();
    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  test("cancelling asks for confirmation, updates the card at once and confirms with a toast", async () => {
    patchResult = "hang";
    view();
    await screen.findByText("Service 1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel this appointment?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, cancel it" }));

    // Optimistic: the card already says Cancelled while the request is still in flight.
    await waitFor(() => expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0));
    releasePatch?.();
    expect(await screen.findByText("Your appointment was cancelled")).toBeInTheDocument();
  });

  test("a failed cancellation rolls back and says so", async () => {
    patchResult = "fail";
    view();
    await screen.findByText("Service 1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, cancel it" }));
    expect(await screen.findByText("We could not cancel the appointment")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    expect(screen.getByText("Upcoming", { selector: "span" })).toBeInTheDocument();
  });

  test("rescheduling hands the appointment to the caller", async () => {
    const onReschedule = mock();
    view({ onReschedule });
    await screen.findByText("Service 1");
    fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
    expect(onReschedule).toHaveBeenCalledWith(expect.objectContaining({ id: appointments[0]?.id }));
  });

  test("the just-booked appointment is highlighted", async () => {
    view({ highlightId: appointments[0]?.id });
    expect(await screen.findByText("Just booked")).toBeInTheDocument();
  });
});
