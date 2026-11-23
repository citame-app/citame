import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CalendarAppointment } from "@sob/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../../test/render";
import { AppointmentDrawer } from "./appointment-drawer";

const STAFF = "0198f5a0-7b1c-7000-8000-000000000201";
const CLIENT = "0198f5a0-7b1c-7000-8000-0000000000c1";
const CUT = "0198f5a0-7b1c-7000-8000-000000000101";
const ID = "0198f5a0-7b1c-7000-8000-0000000000a1";
const realFetch = globalThis.fetch;
const NOW = new Date("2026-03-09T15:00:00.000Z");

const appointment: CalendarAppointment = {
  id: ID,
  staffId: STAFF,
  clientId: CLIENT,
  startsAt: "2026-03-09T14:00:00.000Z",
  endsAt: "2026-03-09T15:00:00.000Z",
  status: "booked",
  notes: "Allergic to ammonia",
  version: 3,
  services: [
    {
      serviceId: CUT,
      name: "Haircut",
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: 1_500_000,
      currency: "ARS",
    },
  ],
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  clientName: "Lucia Perez",
  serviceNames: ["Haircut"],
};

let patches: unknown[];
let patchReply: { status: number; body: unknown };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  patches = [];
  patchReply = { status: 200, body: { ...appointment, version: 4 } };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === `/api/appointments/${appointment.id}/context`)
      return json({ rows: [], customerComment: null });
    if (url.pathname === `/api/admin/clients/${CLIENT}`) {
      return json({
        client: {
          id: CLIENT,
          name: "Lucia Perez",
          phone: "+54 9 11 5555-0000",
          email: "lucia@example.com",
          notes: "Prefers mornings",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          appointmentCount: 4,
          lastVisitAt: null,
        },
        appointments: [],
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
    if (url.pathname === `/api/appointments/${appointment.id}/availability`) {
      return json({
        date: url.searchParams.get("date"),
        timezone: "America/Argentina/Buenos_Aires",
        slots: [
          {
            staffId: STAFF,
            startsAt: `${url.searchParams.get("date")}T18:00:00.000Z`,
            endsAt: `${url.searchParams.get("date")}T18:45:00.000Z`,
          },
        ],
      });
    }
    if (init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      return json(patchReply.body, patchReply.status);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const open = (props: Partial<Parameters<typeof AppointmentDrawer>[0]> = {}) =>
  renderApp(
    <AppointmentDrawer
      appointment={appointment}
      staffName="Ana"
      onClose={() => {}}
      role="owner"
      ownStaffId={null}
      now={NOW}
      {...props}
    />,
  );

function LiveUpdateHarness() {
  const [version, setVersion] = useState(appointment.version);
  return (
    <>
      <AppointmentDrawer
        appointment={{ ...appointment, version }}
        staffName="Ana"
        onClose={() => {}}
        role="owner"
        ownStaffId={null}
        now={NOW}
      />
      <button type="button" onClick={() => setVersion(4)}>
        Receive remote calendar update
      </button>
    </>
  );
}

describe("AppointmentDrawer", () => {
  test("shows who, when, what and the status", async () => {
    open();
    const dialog = await screen.findByRole("dialog", { name: "Lucia Perez" });
    expect(within(dialog).getByText("Ana")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Haircut").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Booked")).toBeInTheDocument();
    expect(within(dialog).getByText(/11:00 AM/)).toBeInTheDocument();
  });

  test("lets an owner review an unknown amount while retaining Booksy payment review", async () => {
    open({
      appointment: {
        ...appointment,
        importedFromBooksy: true,
        billingReviewReasons: ["unknown_amount", "invoiced_in_booksy"],
        services: appointment.services.map((line) => ({
          ...line,
          currency: "EUR",
          priceCents: 0,
          sourceUnpriced: true,
        })),
        unpricedServices: [{ id: CUT, name: "Haircut" }],
      },
    });
    const dialog = await screen.findByRole("dialog", { name: "Lucia Perez" });
    expect(
      within(dialog).getByRole("form", { name: "Confirm imported amounts" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("form", { name: "Reconcile Booksy payment" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Marked as invoiced in Booksy")).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("form", { name: "Reconcile partial Booksy payment" }),
    ).toBeNull();
  });

  test("loads the client's contact data and notes", async () => {
    open();
    expect(await screen.findByText("+54 9 11 5555-0000")).toBeInTheDocument();
    expect(screen.getByText("Prefers mornings")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open client profile" })).toBeInTheDocument();
  });

  test("saves appointment notes with the current version", async () => {
    open();
    const notes = await screen.findByLabelText("Appointment notes");
    expect(notes).toHaveValue("Allergic to ammonia");
    fireEvent.change(notes, { target: { value: "Allergic to ammonia; wants a trim" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() =>
      expect(patches).toEqual([{ version: 3, notes: "Allergic to ammonia; wants a trim" }]),
    );
  });

  test("a version conflict explains itself and offers to reload", async () => {
    patchReply = { status: 409, body: { error: { code: "version_conflict", message: "stale" } } };
    const onReload = mock();
    open({ onReload });
    fireEvent.change(await screen.findByLabelText("Appointment notes"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Someone changed this appointment");
    fireEvent.click(within(alert).getByRole("button", { name: "Reload latest" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  test("an unrelated live update keeps the draft and allows it to save on the latest revision", async () => {
    renderApp(<LiveUpdateHarness />);
    const notes = await screen.findByLabelText("Appointment notes");
    fireEvent.change(notes, { target: { value: "My appointment draft" } });
    fireEvent.click(screen.getByText("Receive remote calendar update"));
    expect(notes).toHaveValue("My appointment draft");
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(patches).toEqual([{ version: 4, notes: "My appointment draft" }]));
  });

  test("rescheduling picks a slot from availability and moves with version, time and staff", async () => {
    patchReply = {
      status: 200,
      body: { ...appointment, version: 4, startsAt: "2026-03-10T18:00:00.000Z" },
    };
    open();
    const reschedule = await screen.findByRole("button", { name: "Reschedule" });
    expect(reschedule.closest("section")).not.toHaveAttribute("aria-labelledby");
    fireEvent.click(reschedule);
    const region = screen.getByRole("region", { name: "Move appointment" });
    const heading = within(region).getByRole("heading", { name: "Move appointment" });
    expect(region).toHaveAttribute("aria-labelledby", heading.id);
    const slot = await screen.findByRole("radio", { name: /3:00 PM/ });
    fireEvent.click(slot);
    fireEvent.click(await screen.findByRole("button", { name: /^Move to / }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ version: 3, staffId: STAFF });
    expect((patches[0] as { startsAt: string }).startsAt).toMatch(/T18:00:00\.000Z$/);
  });

  test("a slot that was taken meanwhile keeps the picker open with a clear message", async () => {
    patchReply = { status: 409, body: { error: { code: "slot_taken", message: "taken" } } };
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Reschedule" }));
    fireEvent.click(await screen.findByRole("radio", { name: /3:00 PM/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Move to / }));
    expect(
      await screen.findByText("Someone just took that time. Pick another time to continue."),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /3:00 PM/ })).toBeInTheDocument();
  });

  test("completed appointments offer no reschedule", async () => {
    open({ appointment: { ...appointment, status: "completed" } });
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Reschedule" })).toBeNull();
  });
});
