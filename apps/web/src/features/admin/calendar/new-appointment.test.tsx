import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../../test/render";
import { type NewAppointmentInitial, NewAppointmentSheet } from "./new-appointment";

const ANA = "0198f5a0-7b1c-7000-8000-000000000201";
const BEA = "0198f5a0-7b1c-7000-8000-000000000202";
const CUT = "0198f5a0-7b1c-7000-8000-000000000101";
const COLOR = "0198f5a0-7b1c-7000-8000-000000000103";
const CLIENT = "0198f5a0-7b1c-7000-8000-0000000000c1";
const realFetch = globalThis.fetch;

let posts: unknown[];
let postReply: { status: number; body: unknown };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  posts = [];
  postReply = {
    status: 201,
    body: {
      id: "0198f5a0-7b1c-7000-8000-0000000000a9",
      staffId: ANA,
      clientId: CLIENT,
      startsAt: "2026-03-09T12:00:00.000Z",
      endsAt: "2026-03-09T12:45:00.000Z",
      status: "booked",
      notes: null,
      version: 1,
      services: [],
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
  };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/intake/requirements")
      return json({ forms: [], reviewHash: "1".repeat(64), readyResponses: [] });
    if (url.pathname === "/api/services") {
      return json({
        services: [
          {
            id: CUT,
            name: "Haircut",
            description: null,
            durationMinutes: 45,
            bufferMinutes: 15,
            priceCents: 1_500_000,
            currency: "ARS",
          },
          {
            id: COLOR,
            name: "Hair color",
            description: null,
            durationMinutes: 90,
            bufferMinutes: 15,
            priceCents: 4_500_000,
            currency: "ARS",
          },
        ],
      });
    }
    if (url.pathname === "/api/admin/staff") {
      return json({
        staff: [
          { id: ANA, displayName: "Ana", active: true, userId: null, serviceIds: [CUT, COLOR] },
          { id: BEA, displayName: "Bea", active: true, userId: null, serviceIds: [CUT] },
        ],
      });
    }
    if (url.pathname === "/api/admin/clients") {
      const q = url.searchParams.get("search") ?? "";
      const all = [
        {
          id: CLIENT,
          name: "Lucia Perez",
          phone: "+54 9 11 5555-0000",
          email: null,
          notes: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          appointmentCount: 2,
          lastVisitAt: null,
        },
      ];
      const clients = all.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
      return json({ clients, page: 1, pageSize: 8, total: clients.length });
    }
    if (url.pathname === "/api/appointments" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return json(postReply.body, postReply.status);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const open = (props: Partial<Parameters<typeof NewAppointmentSheet>[0]> = {}) =>
  renderApp(
    <NewAppointmentSheet
      open
      onOpenChange={() => {}}
      initial={{ staffId: ANA, date: "2026-03-09", minutesOfDay: 9 * 60 }}
      role="owner"
      ownStaffId={null}
      {...props}
    />,
  );

async function clickReady(name: string) {
  const button = screen.getByRole<HTMLButtonElement>("button", { name });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

describe("NewAppointmentSheet", () => {
  test("is prefilled from the clicked slot", async () => {
    open();
    expect(await screen.findByRole("dialog", { name: "New appointment" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Team member")).toHaveValue(ANA);
    expect(screen.getByLabelText("Date")).toHaveValue("2026-03-09");
    expect(screen.getByLabelText("Start time")).toHaveValue("09:00");
  });

  test("only offers the services the chosen team member performs", async () => {
    open({ initial: { staffId: BEA, date: "2026-03-09", minutesOfDay: 600 } });
    expect(await screen.findByRole("checkbox", { name: /Haircut/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Hair color/ })).toBeNull();
  });

  test("rerenders keep the draft for the same slot and a different slot starts a clean draft", async () => {
    const first = { staffId: ANA, date: "2026-03-09", minutesOfDay: 540 };
    let selectSlot: (slot: NewAppointmentInitial) => void = () => {};
    function CalendarSelection() {
      const [initial, select] = useState<NewAppointmentInitial>(first);
      selectSlot = select;
      return (
        <NewAppointmentSheet
          open
          onOpenChange={() => {}}
          initial={initial}
          role="owner"
          ownStaffId={null}
        />
      );
    }
    renderApp(<CalendarSelection />);
    fireEvent.click(await screen.findByRole("radio", { name: "New client" }));
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Private draft" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: /Haircut/ }));
    act(() => selectSlot({ ...first }));
    expect(screen.getByLabelText("Full name")).toHaveValue("Private draft");
    expect(screen.getByRole("checkbox", { name: /Haircut/ })).toBeChecked();

    act(() => selectSlot({ staffId: BEA, date: "2026-03-10", minutesOfDay: 615 }));
    expect(await screen.findByLabelText("Team member")).toHaveValue(BEA);
    expect(screen.getByLabelText("Date")).toHaveValue("2026-03-10");
    expect(screen.getByLabelText("Start time")).toHaveValue("10:15");
    expect(screen.queryByDisplayValue("Private draft")).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Haircut/ })).not.toBeChecked();
  });

  test("submitting an empty form lists what is missing and sends nothing", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Create appointment" }));
    expect(await screen.findByText("Choose a client or enter a name")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one service")).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  test("books an existing client found by search, with the notice override", async () => {
    const onCreated = mock();
    open({ onCreated });
    fireEvent.change(await screen.findByLabelText("Search by name, phone or email"), {
      target: { value: "lucia" },
    });
    fireEvent.click(await screen.findByRole("radio", { name: /Lucia Perez/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Haircut/ }));
    await clickReady("Create appointment");
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      id: expect.any(String),
      staffId: ANA,
      serviceIds: [CUT],
      startsAt: "2026-03-09T12:00:00.000Z",
      clientId: CLIENT,
      override: true,
      intakeReviewHash: "1".repeat(64),
      intakeSubmissionIds: [],
      intakeResponses: [],
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  test("books a brand new client inline", async () => {
    open();
    fireEvent.click(await screen.findByRole("radio", { name: "New client" }));
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Nora Diaz" } });
    fireEvent.change(screen.getByLabelText("Phone (optional)"), {
      target: { value: "+54 9 11 4444-1111" },
    });
    fireEvent.click(await screen.findByRole("checkbox", { name: /Hair color/ }));
    await clickReady("Create appointment");
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      client: { name: "Nora Diaz", phone: "+54 9 11 4444-1111" },
      serviceIds: [COLOR],
    });
  });

  test("a second form submission cannot create another visit while the first is pending", async () => {
    const fetch = globalThis.fetch;
    const reply = Promise.withResolvers<void>();
    const onCreated = mock();
    let requests = 0;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/appointments") && init?.method === "POST") {
        requests++;
        await reply.promise;
      }
      return fetch(input, init);
    }) as unknown as typeof fetch;
    open({ onCreated });
    fireEvent.click(await screen.findByRole("radio", { name: "New client" }));
    const name = screen.getByLabelText<HTMLInputElement>("Full name");
    fireEvent.change(name, { target: { value: "First draft" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: /Haircut/ }));
    await clickReady("Create appointment");
    await waitFor(() => expect(requests).toBe(1));
    fireEvent.change(screen.getByLabelText("Notes (optional)"), {
      target: { value: "Edited during request" },
    });
    fireEvent.submit(name.form!);
    reply.resolve();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(requests).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ client: { name: "First draft" } });
  });

  test("slot_taken keeps the form and explains how to recover", async () => {
    postReply = { status: 409, body: { error: { code: "slot_taken", message: "taken" } } };
    open();
    fireEvent.click(await screen.findByRole("radio", { name: "New client" }));
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Nora" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: /Haircut/ }));
    await clickReady("Create appointment");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Someone just took that time. Pick another time to continue.");
    expect(screen.getByLabelText("Full name")).toHaveValue("Nora");
    expect(screen.getByLabelText("Start time")).toHaveFocus();
  });

  test("staff book only into their own calendar", async () => {
    open({ role: "staff", ownStaffId: ANA });
    expect(await screen.findByLabelText("Team member")).toBeDisabled();
  });
});

test("a recurring appointment reviews dates and never submits a stale preview after an edit", async () => {
  const current = globalThis.fetch;
  const previews: unknown[] = [];
  const series: unknown[] = [];
  const refresh = Promise.withResolvers<void>();
  const onOpenChange = mock();
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/appointments/series/preview") {
      previews.push(JSON.parse(String(init?.body)));
      if (previews.length === 2) await refresh.promise;
      return json({
        reviewHash: "a".repeat(64),
        timezone: "America/Argentina/Buenos_Aires",
        perVisitCents: 1500000,
        currency: "ARS",
        policy: {
          enabled: false,
          depositKind: "percent",
          depositValue: 2500,
          holdMinutes: 15,
          cancellationWindowMinutes: 1440,
          lateCancellationBasisPoints: 0,
          noShowBasisPoints: 0,
          trustedExempt: true,
          version: 1,
        },
        occurrences: [
          {
            startsAt: "2026-03-09T12:00:00.000Z",
            endsAt: "2026-03-09T13:00:00.000Z",
            available: true,
          },
          {
            startsAt: "2026-03-16T12:00:00.000Z",
            endsAt: "2026-03-16T13:00:00.000Z",
            available: true,
          },
        ],
      });
    }
    if (path === "/api/appointments/series") {
      series.push(JSON.parse(String(init?.body)));
      return json(
        {
          id: crypto.randomUUID(),
          timezone: "America/Argentina/Buenos_Aires",
          cadence: "weekly",
          interval: 1,
          appointments: [postReply.body, postReply.body],
        },
        201,
      );
    }
    return current(input, init);
  }) as unknown as typeof fetch;
  open({ onOpenChange });
  fireEvent.click(await screen.findByRole("radio", { name: "New client" }));
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Recurring customer" } });
  fireEvent.click(await screen.findByRole("checkbox", { name: /Haircut/ }));
  fireEvent.change(screen.getByLabelText("Repeat appointment"), { target: { value: "weekly" } });
  fireEvent.change(screen.getByLabelText("Number of visits"), { target: { value: "2" } });
  await clickReady("Review recurring visits");
  expect(await screen.findByRole("button", { name: "Create 2 appointments" })).toBeInTheDocument();
  expect(previews).toHaveLength(1);
  expect(series).toHaveLength(0);
  await clickReady("Review availability again");
  await waitFor(() => expect(previews).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  expect(onOpenChange).not.toHaveBeenCalled();
  fireEvent.submit(screen.getByLabelText<HTMLInputElement>("Start time").form!);
  refresh.resolve();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Create 2 appointments" })).not.toBeDisabled(),
  );
  expect(series).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "10:00" } });
  expect(screen.queryByRole("button", { name: "Create 2 appointments" })).toBeNull();
  await clickReady("Review recurring visits");
  fireEvent.click(await screen.findByRole("button", { name: "Create 2 appointments" }));
  await waitFor(() => expect(series).toHaveLength(1));
  expect(series[0]).toMatchObject({
    cadence: "weekly",
    interval: 1,
    count: 2,
    reviewHash: "a".repeat(64),
    startsAt: "2026-03-09T13:00:00.000Z",
    client: { name: "Recurring customer" },
  });
  expect(posts).toHaveLength(0);
});

test("a nonexistent salon-local time is rejected instead of silently moving the requested visit", async () => {
  renderApp(
    <NewAppointmentSheet
      open
      onOpenChange={() => {}}
      initial={{ staffId: ANA, date: "2026-03-29", minutesOfDay: 150 }}
      role="owner"
      ownStaffId={null}
    />,
    { timeZone: "Europe/Madrid" },
  );
  fireEvent.click(await screen.findByRole("radio", { name: "New client" }));
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "DST customer" } });
  fireEvent.click(await screen.findByRole("checkbox", { name: /Haircut/ }));
  await clickReady("Create appointment");
  await waitFor(() =>
    expect(screen.getByLabelText("Date")).toHaveAttribute("aria-invalid", "true"),
  );
  expect(posts).toHaveLength(0);
});

test("a manager can choose any calendar without being pinned to their own", async () => {
  open({ role: "staff", ownStaffId: ANA, accessPreset: "manager" });
  expect(await screen.findByLabelText("Team member")).not.toBeDisabled();
});

test("a changed catalog quote refreshes the displayed terms and the next submission uses the new quote", async () => {
  const baseFetch = globalThis.fetch;
  let hash = "a".repeat(64);
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/services") {
      const response = await baseFetch(input, init);
      const body = (await response.json()) as { services: { id: string; priceCents: number }[] };
      return json({
        services: body.services.map((s) => ({
          ...s,
          quoteHash: hash,
          priceCents: s.id === CUT && hash.startsWith("b") ? 1_600_000 : s.priceCents,
        })),
      });
    }
    if (path === "/api/appointments" && init?.method === "POST") hash = "b".repeat(64);
    return baseFetch(input, init);
  }) as unknown as typeof fetch;
  postReply = {
    status: 409,
    body: { error: { code: "version_conflict", message: "Changed terms" } },
  };
  open();
  fireEvent.click(await screen.findByRole("radio", { name: "New client" }));
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Nora" } });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Haircut" }));
  await clickReady("Create appointment");
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "Haircut" }).parentElement?.textContent).toContain(
      "16,000",
    ),
  );
  expect(posts[0]).toMatchObject({ serviceQuotes: { [CUT]: "a".repeat(64) } });
  postReply = {
    status: 201,
    body: {
      id: crypto.randomUUID(),
      staffId: ANA,
      clientId: CLIENT,
      startsAt: "2026-03-09T12:00:00.000Z",
      endsAt: "2026-03-09T13:00:00.000Z",
      status: "booked",
      notes: null,
      version: 1,
      services: [],
      createdAt: "2026-03-02T12:00:00.000Z",
      updatedAt: "2026-03-02T12:00:00.000Z",
    },
  };
  await clickReady("Create appointment");
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1]).toMatchObject({ serviceQuotes: { [CUT]: "b".repeat(64) } });
  expect((posts[1] as { id: string }).id).toBe((posts[0] as { id: string }).id);
});

test("a connection failure keeps the submitted visit id until the operator changes the intent", async () => {
  const baseFetch = globalThis.fetch;
  let failed = false;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    if (
      new URL(String(input), "http://localhost").pathname === "/api/appointments" &&
      init?.method === "POST"
    ) {
      const response = await baseFetch(input, init);
      if (!failed) {
        failed = true;
        throw new TypeError("Connection lost after commit");
      }
      return response;
    }
    return baseFetch(input, init);
  }) as unknown as typeof fetch;
  const created = mock();
  open({ onCreated: created });
  fireEvent.click(await screen.findByRole("radio", { name: "New client" }));
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Retry customer" } });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Haircut" }));
  await clickReady("Create appointment");
  await screen.findByRole("alert");
  expect(created).not.toHaveBeenCalled();
  await clickReady("Create appointment");
  await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
  expect(posts).toHaveLength(2);
  expect((posts[0] as { id: string }).id).toMatch(/^[a-f0-9-]{36}$/);
  expect(posts[1]).toEqual(posts[0]);
});

test("closing a booking with a private answer asks before discarding it", async () => {
  const baseFetch = globalThis.fetch;
  const question = "0198f5a0-7b1c-7000-8000-000000000001";
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input), "http://localhost").pathname === "/api/intake/requirements")
      return json({
        reviewHash: "1".repeat(64),
        readyResponses: [],
        forms: [
          {
            id: "0198f5a0-7b1c-7000-8000-000000000002",
            formId: "0198f5a0-7b1c-7000-8000-000000000003",
            number: 1,
            contentHash: "1".repeat(64),
            createdAt: "2026-03-02T12:00:00.000Z",
            definition: {
              title: "Preferences",
              fields: [{ id: question, kind: "text", label: "Style preference", required: true }],
              requiredAtBooking: true,
              allowTeamResponses: true,
            },
          },
        ],
      });
    return baseFetch(input, init);
  }) as unknown as typeof fetch;
  const closed = mock();
  open({ onOpenChange: closed });
  fireEvent.click(await screen.findByRole("radio", { name: "New client" }));
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Customer" } });
  fireEvent.click(await screen.findByRole("checkbox", { name: /Haircut/ }));
  fireEvent.change(await screen.findByLabelText("Style preference"), {
    target: { value: "Keep my private draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByRole("dialog", { name: "Discard draft changes" });
  expect(closed).not.toHaveBeenCalled();
});
