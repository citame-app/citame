import { afterEach, expect, mock, test } from "bun:test";
import type { CalendarAppointment } from "@sob/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { AppointmentContext } from "./appointment-context";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const id = "0198f5a0-7b1c-7000-8000-000000000201";
const visit: CalendarAppointment = {
  id,
  staffId: id,
  clientId: id,
  startsAt: "2026-11-18T12:00:00Z",
  endsAt: "2026-11-18T13:00:00Z",
  status: "booked",
  notes: null,
  version: 1,
  createdAt: "2026-11-17T12:00:00Z",
  updatedAt: "2026-11-17T12:00:00Z",
  clientName: "Synthetic client",
  serviceNames: ["Synthetic service"],
  services: [
    {
      serviceId: id,
      name: "Synthetic service",
      durationMinutes: 60,
      bufferMinutes: 0,
      priceCents: 1000,
      currency: "EUR",
    },
  ],
};

test("a reassigned booking keeps its original preference selected until explicitly cleared", async () => {
  let requestedStaffId: string | null = "0198f5a0-7b1c-7000-8000-000000000202";
  const patches: unknown[] = [];
  globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      patches.push(body);
      if (body.requested === false) requestedStaffId = null;
    }
    return Response.json({
      appointmentVersion: 1 + patches.length,
      rows: [
        {
          servicePosition: 0,
          requestedStaffId,
          internalNote: "Saved note",
          customerComment: null,
          invoiced: null,
          paid: null,
          source: "citame",
          sourceRef: null,
          version: 1 + patches.length,
        },
      ],
    });
  }) as unknown as typeof fetch;

  renderApp(<AppointmentContext appointment={visit} staffName="Ana" />);
  const preference = await screen.findByRole("checkbox", {
    name: "Client requested a specific professional",
  });
  expect(preference).toBeChecked();
  fireEvent.click(preference);
  expect(patches).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Save service details" }));
  await waitFor(() =>
    expect(patches).toEqual([
      {
        appointmentVersion: 1,
        servicePosition: 0,
        version: 1,
        internalNote: "Saved note",
        requested: false,
      },
    ]),
  );
});

test("live notes refresh until edited and a retry uses the explicitly reviewed version", async () => {
  let remoteVersion = 1;
  const patches: unknown[] = [];
  globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          error: { code: "version_conflict", message: "Changed remotely" },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        appointmentVersion: remoteVersion,
        rows: [
          {
            servicePosition: 0,
            requestedStaffId: null,
            internalNote: `Saved note ${remoteVersion}`,
            customerComment: null,
            invoiced: null,
            paid: null,
            source: "citame",
            sourceRef: null,
            version: remoteVersion,
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const rendered = renderApp(<AppointmentContext appointment={visit} staffName="Ana" />);
  const field = await screen.findByRole("textbox", { name: "Internal notes" });
  const updateFromServer = (version: number) => {
    remoteVersion = version;
    return act(async () => {
      await rendered.queryClient.invalidateQueries({
        queryKey: ["admin", "appointment-context"],
      });
    });
  };
  expect(field).toHaveValue("Saved note 1");
  await updateFromServer(2);
  await waitFor(() => expect(field).toHaveValue("Saved note 2"));
  fireEvent.change(field, { target: { value: "My unsaved private draft" } });
  await updateFromServer(3);
  expect(field).toHaveValue("My unsaved private draft");
  expect(await screen.findByText("Saved note 3")).toBeVisible();
  const save = () =>
    screen.getByRole<HTMLButtonElement>("button", { name: "Save service details" });
  expect(save().disabled).toBe(true);
  expect(patches).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
  fireEvent.click(save());
  await screen.findByText("This appointment changed. Load the saved details to review your draft.");
  expect(patches).toEqual([
    {
      appointmentVersion: 3,
      servicePosition: 0,
      version: 3,
      internalNote: "My unsaved private draft",
    },
  ]);
  expect(field).toHaveValue("My unsaved private draft");
  fireEvent.click(
    screen.getByRole("button", {
      name: "Discard draft and load saved details",
    }),
  );
  await waitFor(() => expect(field).toHaveValue("Saved note 3"));
});
