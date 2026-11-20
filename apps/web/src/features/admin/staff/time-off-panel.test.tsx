import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { TimeOffPanel, TimeOffSheet } from "./time-off-panel";

const STAFF = "0198f5a0-7b1c-7000-8000-000000000201";
const CLIENT = "0198f5a0-7b1c-7000-8000-0000000000c1";
const ENTRY = "0198f5a0-7b1c-7000-8000-0000000000b1";
const realFetch = globalThis.fetch;

type Entry = {
  id: string;
  staffId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
};
let entries: Entry[];
let writes: { method: string; path: string; body: unknown }[];
let writeConflicts: unknown[];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a full-day absence uses the next local midnight, including Madrid's 25-hour autumn day", async () => {
  renderApp(
    <TimeOffSheet
      staffId={STAFF}
      entry={null}
      onClose={() => {}}
      onSaved={() => {}}
      initialAllDay
      initialForm={{
        startDate: "2026-10-25",
        endDate: "2026-10-25",
        startTime: "09:00",
        endTime: "09:30",
      }}
    />,
    { timeZone: "Europe/Madrid" },
  );
  expect(await screen.findByLabelText("All day")).toBeChecked();
  expect(screen.queryByLabelText("Start time")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save time off" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.body).toEqual({
    startsAt: "2026-10-24T22:00:00.000Z",
    endsAt: "2026-10-25T23:00:00.000Z",
  });
});

beforeEach(() => {
  writes = [];
  writeConflicts = [];
  entries = [
    {
      id: ENTRY,
      staffId: STAFF,
      startsAt: "2026-04-10T12:00:00.000Z",
      endsAt: "2026-04-10T21:00:00.000Z",
      reason: "Dentist",
    },
  ];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
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
    if (url.pathname.startsWith(`/api/admin/staff/${STAFF}/time-off`)) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === "GET") return json({ timeOff: entries });
      writes.push({ method, path: url.pathname, body });
      if (method === "POST") {
        const created = {
          id: "0198f5a0-7b1c-7000-8000-0000000000b2",
          staffId: STAFF,
          reason: null,
          ...body,
        };
        entries = [...entries, created];
        return json({ timeOff: created, conflicts: writeConflicts }, 201);
      }
      if (method === "PATCH") {
        entries = entries.map((e) => ({ ...e, ...body }));
        return json({ timeOff: entries[0], conflicts: writeConflicts });
      }
      if (method === "DELETE") {
        const removed = entries[0] as Entry;
        entries = [];
        return json({ timeOff: removed, conflicts: [] });
      }
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const open = (editable = true) => renderApp(<TimeOffPanel staffId={STAFF} editable={editable} />);
const conflict = {
  appointmentId: "0198f5a0-7b1c-7000-8000-0000000000a1",
  clientId: CLIENT,
  startsAt: "2026-04-10T15:00:00.000Z",
  endsAt: "2026-04-10T16:00:00.000Z",
  reasons: ["time_off"],
};

describe("TimeOffPanel", () => {
  test("lists entries with their dates and reason", async () => {
    open();
    const list = await screen.findByRole("list", { name: "Time off" });
    expect(within(list).getByText("Dentist")).toBeInTheDocument();
    expect(within(list).getByText(/Apr/)).toBeInTheDocument();
  });

  test("shows a designed empty state", async () => {
    entries = [];
    open();
    expect(await screen.findByText("No time off scheduled")).toBeInTheDocument();
  });

  test("adding sends salon-local times as instants and lists the conflicts it causes", async () => {
    writeConflicts = [conflict];
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Add time off" }));
    const dialog = await screen.findByRole("dialog", { name: "Add time off" });
    fireEvent.change(within(dialog).getByLabelText("Start date"), {
      target: { value: "2026-04-20" },
    });
    fireEvent.change(within(dialog).getByLabelText("Start time"), { target: { value: "09:00" } });
    fireEvent.change(within(dialog).getByLabelText("End date"), {
      target: { value: "2026-04-20" },
    });
    fireEvent.change(within(dialog).getByLabelText("End time"), { target: { value: "13:00" } });
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), {
      target: { value: "Training" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save time off" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: "POST",
      path: `/api/admin/staff/${STAFF}/time-off`,
      body: {
        startsAt: "2026-04-20T12:00:00.000Z",
        endsAt: "2026-04-20T16:00:00.000Z",
        reason: "Training",
      },
    });
    const warning = await screen.findByRole("region", {
      name: "1 existing appointment no longer fits",
    });
    expect(await within(warning).findByText("Lucia Perez")).toBeInTheDocument();
  });

  test("an end that is not after the start is rejected before sending", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Add time off" }));
    const dialog = await screen.findByRole("dialog");
    for (const [label, value] of [
      ["Start date", "2026-04-20"],
      ["Start time", "12:00"],
      ["End date", "2026-04-20"],
      ["End time", "12:00"],
    ] as const) {
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Save time off" }));
    expect(await within(dialog).findByText("The end must be after the start")).toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  test("editing sends only what changed", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Edit time off: Dentist" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit time off" });
    expect(within(dialog).getByLabelText("Start time")).toHaveValue("09:00");
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), {
      target: { value: "Dentist and lunch" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save time off" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ method: "PATCH", body: { reason: "Dentist and lunch" } });
  });

  test("removing asks first, then deletes", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Remove time off: Dentist" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove this time off?" });
    expect(writes).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(writes[0]).toMatchObject({ method: "DELETE" }));
    expect(await screen.findByText("Time off removed")).toBeInTheDocument();
  });

  test("read-only viewers see entries but no controls", async () => {
    open(false);
    await screen.findByText("Dentist");
    expect(screen.queryByRole("button", { name: "Add time off" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit time off/ })).toBeNull();
  });
});
