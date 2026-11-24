import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppointmentContextRow, CalendarAppointment } from "@sob/contracts";
import { useQueryClient } from "@tanstack/react-query";
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
let pendingPatch: Promise<void> | undefined;
let serviceContext: { rows: AppointmentContextRow[]; appointmentVersion: number };
let rejectServiceSave: boolean;
let patchReply: { status: number; body: unknown };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  patches = [];
  serviceContext = { rows: [], appointmentVersion: appointment.version };
  rejectServiceSave = false;
  pendingPatch = undefined;
  patchReply = { status: 200, body: { ...appointment, version: 4 } };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === `/api/appointments/${appointment.id}/context`) {
      if (init?.method === "PATCH") {
        const input = JSON.parse(String(init.body));
        patches.push(input);
        if (rejectServiceSave)
          return json({ error: { code: "version_conflict", message: "stale" } }, 409);
        return json({
          rows: [],
          customerComment: null,
          appointmentVersion: input.appointmentVersion + 1,
        });
      }
      return json(serviceContext);
    }
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
      if (pendingPatch) await pendingPatch;
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

function LiveUpdateHarness({
  remoteNotes = appointment.notes,
  remoteStaff = appointment.staffId,
}: {
  remoteNotes?: string | null;
  remoteStaff?: string;
}) {
  const [version, setVersion] = useState(appointment.version);
  const queries = useQueryClient();
  return (
    <>
      <AppointmentDrawer
        appointment={{
          ...appointment,
          version,
          staffId: version === 4 ? remoteStaff : appointment.staffId,
          notes: version === 4 ? remoteNotes : appointment.notes,
        }}
        staffName={version === 4 && remoteStaff !== appointment.staffId ? "Bea" : "Ana"}
        onClose={() => {}}
        role="owner"
        ownStaffId={null}
        now={NOW}
      />
      <button
        type="button"
        onClick={() => {
          setVersion(4);
          queries.setQueryData(["admin", "appointment-context", appointment.id], {
            ...serviceContext,
            appointmentVersion: 4,
          });
        }}
      >
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

  test("rescheduling and service annotation saves wait for the pending note save", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    pendingPatch = promise;
    try {
      open();
      fireEvent.change(await screen.findByLabelText("Appointment notes"), {
        target: { value: "Prefers fragrance-free products" },
      });
      fireEvent.change(await screen.findByLabelText("Internal notes"), {
        target: { value: "Confirm preferred styling" },
      });
      const serviceSave = () =>
        screen.getByRole<HTMLButtonElement>("button", { name: "Save service details" });
      expect(serviceSave().disabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
      const move = () => screen.getByRole<HTMLButtonElement>("button", { name: "Reschedule" });
      await waitFor(() => {
        expect(move().disabled).toBe(true);
        expect(serviceSave().disabled).toBe(true);
      });
      expect(patches).toEqual([{ version: 3, notes: "Prefers fragrance-free products" }]);
      resolve();
      await waitFor(() => {
        expect(move().disabled).toBe(false);
        expect(serviceSave().disabled).toBe(false);
      });
      expect(screen.getByLabelText("Internal notes")).toHaveValue("Confirm preferred styling");
    } finally {
      resolve();
    }
  });

  test("an unchanged service draft can use the newer appointment revision", async () => {
    renderApp(<LiveUpdateHarness />);
    const note = await screen.findByLabelText("Internal notes");
    fireEvent.change(note, { target: { value: "Confirm preferred styling" } });
    fireEvent.click(screen.getByText("Receive remote calendar update"));
    expect(note).toHaveValue("Confirm preferred styling");
    fireEvent.click(screen.getByRole("button", { name: "Save service details" }));
    await waitFor(() =>
      expect(patches).toEqual([
        {
          appointmentVersion: 4,
          servicePosition: 0,
          version: 0,
          internalNote: "Confirm preferred styling",
        },
      ]),
    );
  });

  test("a stale service save keeps the draft and requires explicit review before retrying", async () => {
    rejectServiceSave = true;
    open();
    const note = await screen.findByLabelText("Internal notes");
    const save = () =>
      screen.getByRole<HTMLButtonElement>("button", { name: "Save service details" });
    fireEvent.change(note, { target: { value: "Keep my colour notes" } });
    fireEvent.click(save());
    await screen.findByText(
      "This appointment changed. Load the saved details to review your draft.",
    );
    expect(note).toHaveValue("Keep my colour notes");
    expect(save().disabled).toBe(true);
    const latest: AppointmentContextRow = {
      servicePosition: 0,
      version: 1,
      requestedStaffId: STAFF,
      internalNote: "Latest note from Desktop",
      customerComment: null,
      paid: null,
      invoiced: null,
      source: "citame",
      sourceRef: null,
    };
    serviceContext = { appointmentVersion: 3, rows: [latest] };
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    await screen.findByText("Latest note from Desktop");
    expect(note).toHaveValue("Keep my colour notes");
    expect(
      screen.getByRole("checkbox", { name: "Client requested a specific professional" }),
    ).toBeChecked();
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
    expect(patches).toHaveLength(1);
    rejectServiceSave = false;
    fireEvent.click(save());
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({
      appointmentVersion: 3,
      servicePosition: 0,
      version: 1,
      internalNote: "Keep my colour notes",
    });
  });

  test("a new request must be confirmed again after reassignment", async () => {
    renderApp(<LiveUpdateHarness remoteStaff="0198f5a0-7b1c-7000-8000-000000000202" />);
    const requested = await screen.findByRole("checkbox", {
      name: "Client requested a specific professional",
    });
    fireEvent.click(requested);
    serviceContext.rows = [
      {
        servicePosition: 0,
        version: 1,
        requestedStaffId: STAFF,
        internalNote: null,
        customerComment: null,
        paid: null,
        invoiced: null,
        source: "citame",
        sourceRef: null,
      },
    ];
    fireEvent.click(screen.getByText("Receive remote calendar update"));
    expect(
      screen.getByText("The assigned professional changed. Confirm whom this request applies to."),
    ).toBeVisible();
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save service details" });
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
    fireEvent.click(save);
    await waitFor(() =>
      expect(patches).toEqual([
        {
          appointmentVersion: 4,
          servicePosition: 0,
          version: 1,
          requested: true,
          internalNote: "",
        },
      ]),
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

  test("a fresh revision clears the reload prompt while preserving notes", async () => {
    patchReply = { status: 409, body: { error: { code: "version_conflict", message: "stale" } } };
    renderApp(<LiveUpdateHarness />);
    const notes = await screen.findByLabelText("Appointment notes");
    fireEvent.change(notes, { target: { value: "Draft after conflict" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Reload latest" })).toBeVisible();
    fireEvent.click(screen.getByText("Receive remote calendar update"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(notes).toHaveValue("Draft after conflict");
    expect(screen.getByRole("button", { name: "Save notes" })).toBeEnabled();
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

  test("a newer note stays visible while the operator reviews a preserved draft", async () => {
    renderApp(<LiveUpdateHarness remoteNotes="Note saved in Desktop" />);
    const notes = await screen.findByLabelText("Appointment notes");
    fireEvent.change(notes, { target: { value: "My appointment draft" } });
    fireEvent.click(screen.getByText("Receive remote calendar update"));
    expect(notes).toHaveValue("My appointment draft");
    expect(screen.getByText("Note saved in Desktop")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save notes" })).toBeDisabled();
    expect(patches).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
    expect(notes).toHaveValue("My appointment draft");
    expect(patches).toHaveLength(0);
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
