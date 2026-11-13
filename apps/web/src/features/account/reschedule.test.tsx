import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Appointment } from "@sob/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { RescheduleView } from "./reschedule";

const STAFF = "0198f5a0-7b1c-7000-8000-000000000201";
const SERVICE = "0198f5a0-7b1c-7000-8000-000000000101";
const TZ = "America/Argentina/Buenos_Aires";
const realFetch = globalThis.fetch;
let patch: { url: string; body: Record<string, unknown> } | undefined;
let patchStatus: number;

const NOW = new Date();
const dayOffset = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const localDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

const appointment: Appointment = {
  id: "0198f5a0-7b1c-7000-8000-000000000901",
  staffId: STAFF,
  clientId: "0198f5a0-7b1c-7000-8000-000000000301",
  startsAt: dayOffset(3).toISOString(),
  endsAt: new Date(dayOffset(3).getTime() + 3_600_000).toISOString(),
  status: "booked",
  notes: null,
  version: 4,
  services: [
    {
      serviceId: SERVICE,
      name: "Haircut",
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: 3000,
      currency: "USD",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const salon = {
  name: "Salon",
  timezone: TZ,
  maxDaysAhead: 30,
  minNoticeMinutes: 60,
  slotGranularityMinutes: 15,
};

beforeEach(() => {
  patch = undefined;
  patchStatus = 200;
  const tomorrow = localDate(dayOffset(1));
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.startsWith("/api/appointments/") && init?.method === "PATCH") {
      patch = { url: url.pathname, body: JSON.parse(String(init.body)) };
      if (patchStatus === 409) {
        return new Response(JSON.stringify({ error: { code: "slot_taken", message: "taken" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ...appointment, version: 5 }), {
        headers: { "content-type": "application/json" },
      });
    }
    const date = url.searchParams.get("date") ?? "";
    const slots =
      date === tomorrow
        ? [
            {
              staffId: STAFF,
              startsAt: `${tomorrow}T15:00:00.000Z`,
              endsAt: `${tomorrow}T16:00:00.000Z`,
            },
          ]
        : [];
    return new Response(JSON.stringify({ date, timezone: TZ, slots }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const view = (props: Partial<Parameters<typeof RescheduleView>[0]> = {}) =>
  renderApp(
    <RescheduleView
      appointment={appointment}
      staffName="Stylist A"
      salon={salon}
      onDone={() => {}}
      {...props}
    />,
  );

describe("RescheduleView", () => {
  test("shows the current time and keeps the confirm button disabled until a new time is chosen", async () => {
    view();
    expect(screen.getByText("Current time")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm new time" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("radio", { name: /12:00/ }));
    expect(screen.getByRole("button", { name: "Confirm new time" })).toBeEnabled();
  });

  test("moves the appointment with its version and the same professional", async () => {
    const onDone = mock();
    view({ onDone });
    fireEvent.click(await screen.findByRole("radio", { name: /12:00/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm new time" }));
    expect(await screen.findByText("Your appointment was moved")).toBeInTheDocument();
    expect(patch?.url).toBe(`/api/appointments/${appointment.id}`);
    expect(patch?.body).toMatchObject({ version: 4, staffId: STAFF });
    expect(String(patch?.body.startsAt)).toContain("T15:00:00");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("a lost slot is explained and the choice is cleared", async () => {
    patchStatus = 409;
    view();
    fireEvent.click(await screen.findByRole("radio", { name: /12:00/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm new time" }));
    expect(
      await screen.findByText("That time is no longer available. Please pick another."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm new time" })).toBeDisabled(),
    );
  });

  test("an appointment whose service was removed cannot be rescheduled online", () => {
    view({
      appointment: { ...appointment, services: [{ ...appointment.services[0]!, serviceId: null }] },
    });
    expect(
      screen.getByText("This appointment can no longer be rescheduled online."),
    ).toBeInTheDocument();
  });
});
