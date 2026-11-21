import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { TeamList } from "./team-list";

const ANA = "0198f5a0-7b1c-7000-8000-000000000201";
const BEA = "0198f5a0-7b1c-7000-8000-000000000202";
const CUT = "0198f5a0-7b1c-7000-8000-000000000101";
const APPT = "0198f5a0-7b1c-7000-8000-0000000000a1";
const CLIENT = "0198f5a0-7b1c-7000-8000-0000000000c1";
const realFetch = globalThis.fetch;

type Member = {
  id: string;
  displayName: string;
  active: boolean;
  userId: string | null;
  serviceIds: string[];
};
let staff: Member[];
let writes: { method: string; path: string; body: unknown }[];
let deactivateReply: { status: number; body: unknown };
const INVITE = "Email an invitation so they choose their own password";

let createReply: { status: number; body: unknown };
let upcoming: unknown[];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const upcomingAppt = {
  id: APPT,
  staffId: ANA,
  clientId: CLIENT,
  startsAt: "2099-03-10T15:00:00.000Z",
  endsAt: "2099-03-10T16:00:00.000Z",
  status: "booked",
  notes: null,
  version: 2,
  services: [
    {
      serviceId: CUT,
      name: "Haircut",
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: 1000,
      currency: "ARS",
    },
  ],
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  clientName: "Lucia Perez",
  serviceNames: ["Haircut"],
};

beforeEach(() => {
  writes = [];
  upcoming = [upcomingAppt];
  staff = [
    { id: ANA, displayName: "Ana", active: true, userId: "u1", serviceIds: [CUT] },
    { id: BEA, displayName: "Bea", active: true, userId: "u2", serviceIds: [CUT] },
  ];
  deactivateReply = { status: 200, body: null };
  createReply = {
    status: 201,
    body: {
      userId: "u3",
      staffId: "0198f5a0-7b1c-7000-8000-000000000203",
      email: "nora@example.com",
      role: "staff",
    },
  };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/api/admin/staff" && method === "GET") return json({ staff });
    if (url.pathname === "/api/admin/staff-accounts") {
      writes.push({ method, path: url.pathname, body });
      return json(createReply.body, createReply.status);
    }
    if (url.pathname.startsWith("/api/admin/staff/") && method === "PATCH") {
      writes.push({ method, path: url.pathname, body });
      if (body.active === false && deactivateReply.status !== 200)
        return json(deactivateReply.body, deactivateReply.status);
      const id = url.pathname.split("/")[4];
      staff = staff.map((m) => (m.id === id ? { ...m, ...body } : m));
      return json(staff.find((m) => m.id === id));
    }
    if (url.pathname === "/api/appointments/calendar") {
      return json({
        timezone: "America/Argentina/Buenos_Aires",
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
        staff: [{ id: ANA, displayName: "Ana" }],
        appointments: upcoming,
        timeOff: [],
        workingWindows: [],
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
    if (url.pathname === `/api/appointments/${APPT}` && method === "PATCH") {
      writes.push({ method, path: url.pathname, body });
      upcoming = [];
      return json({ ...upcomingAppt, ...body, version: 3 });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const open = (onOpenMember: (id: string) => void = () => {}) =>
  renderApp(<TeamList onOpenMember={onOpenMember} />);
const staffWrites = () => writes.filter((w) => w.path.startsWith("/api/admin/staff"));

describe("TeamList", () => {
  test("lists members with status, services and login", async () => {
    staff[1] = { ...(staff[1] as Member), active: false, userId: null };
    open();
    const table = await screen.findByRole("table", { name: "Team members" });
    expect(within(table).getByText("Ana")).toBeInTheDocument();
    expect(within(table).getAllByText("1 service").length).toBe(2);
    expect(within(table).getByText("Inactive")).toBeInTheDocument();
    expect(within(table).getByText("No login")).toBeInTheDocument();
  });

  test("opening a member reports its id", async () => {
    const onOpenMember = mock();
    open(onOpenMember);
    const table = await screen.findByRole("table", { name: "Team members" });
    fireEvent.click(within(table).getByRole("button", { name: "Ana" }));
    expect(onOpenMember).toHaveBeenCalledWith(ANA);
  });

  test("creating a staff account validates, then posts the owner-only payload", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "New team member" }));
    const dialog = await screen.findByRole("dialog", { name: "New staff account" });
    fireEvent.click(within(dialog).getByLabelText(INVITE));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create account" }));
    expect(await within(dialog).findByText("Enter a name")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter a valid email")).toBeInTheDocument();
    expect(within(dialog).getByText("Use at least 8 characters")).toBeInTheDocument();
    expect(writes).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText("Full name"), {
      target: { value: "Nora Diaz" },
    });
    fireEvent.change(within(dialog).getByLabelText("Email"), {
      target: { value: "nora@example.com" },
    });
    fireEvent.change(within(dialog).getByLabelText("Temporary password"), {
      target: { value: "a long enough password" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toEqual({
      email: "nora@example.com",
      name: "Nora Diaz",
      password: "a long enough password",
    });
    expect(await screen.findByText("Staff account created")).toBeInTheDocument();
  });

  test("by default the owner invites by email: no password field, no password sent", async () => {
    createReply = {
      status: 201,
      body: { userId: "u", staffId: ANA, email: "nora@example.com", role: "staff", invited: true },
    };
    open();
    fireEvent.click(await screen.findByRole("button", { name: "New team member" }));
    const dialog = await screen.findByRole("dialog", { name: "New staff account" });
    expect(within(dialog).getByLabelText(INVITE)).toBeChecked();
    expect(within(dialog).queryByLabelText("Temporary password")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Full name"), {
      target: { value: "Nora Diaz" },
    });
    fireEvent.change(within(dialog).getByLabelText("Email"), {
      target: { value: "nora@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toEqual({ email: "nora@example.com", name: "Nora Diaz" });
    expect(
      await screen.findByText("Invitation queued. They will set their own password."),
    ).toBeInTheDocument();
  });

  test("a duplicate email is a field error, not a crash", async () => {
    createReply = { status: 409, body: { error: { code: "invalid_state", message: "exists" } } };
    open();
    fireEvent.click(await screen.findByRole("button", { name: "New team member" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText(INVITE));
    fireEvent.change(within(dialog).getByLabelText("Full name"), { target: { value: "Nora" } });
    fireEvent.change(within(dialog).getByLabelText("Email"), {
      target: { value: "nora@example.com" },
    });
    fireEvent.change(within(dialog).getByLabelText("Temporary password"), {
      target: { value: "a long enough password" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create account" }));
    expect(
      await within(dialog).findByText("That email is already registered."),
    ).toBeInTheDocument();
  });

  test("deactivating confirms, then patches active=false", async () => {
    open();
    const table = await screen.findByRole("table", { name: "Team members" });
    fireEvent.click(within(table).getAllByRole("button", { name: "Deactivate" })[0] as HTMLElement);
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Deactivate Ana?" })).getByRole("button", {
        name: "Deactivate",
      }),
    );
    await waitFor(() =>
      expect(staffWrites()).toEqual([
        { method: "PATCH", path: `/api/admin/staff/${ANA}`, body: { active: false } },
      ]),
    );
    expect(await screen.findByText("Team member deactivated")).toBeInTheDocument();
  });

  test("future appointments block deactivation and are listed with reassign and cancel", async () => {
    deactivateReply = {
      status: 409,
      body: { error: { code: "has_future_appointments", message: "blocked" } },
    };
    open();
    const table = await screen.findByRole("table", { name: "Team members" });
    fireEvent.click(within(table).getAllByRole("button", { name: "Deactivate" })[0] as HTMLElement);
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Deactivate Ana?" })).getByRole("button", {
        name: "Deactivate",
      }),
    );
    const panel = await screen.findByRole("dialog", {
      name: "Ana still has upcoming appointments",
    });
    expect(within(panel).getByText("Lucia Perez")).toBeInTheDocument();
    expect(within(panel).getByText(/Haircut/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(panel).getByLabelText("Move to")).toBeInTheDocument();
  });

  test("moving a blocking appointment to a colleague unblocks the deactivation", async () => {
    deactivateReply = {
      status: 409,
      body: { error: { code: "has_future_appointments", message: "blocked" } },
    };
    open();
    const table = await screen.findByRole("table", { name: "Team members" });
    fireEvent.click(within(table).getAllByRole("button", { name: "Deactivate" })[0] as HTMLElement);
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Deactivate Ana?" })).getByRole("button", {
        name: "Deactivate",
      }),
    );
    const panel = await screen.findByRole("dialog", {
      name: "Ana still has upcoming appointments",
    });
    fireEvent.change(within(panel).getByLabelText("Move to"), { target: { value: BEA } });
    fireEvent.click(within(panel).getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(writes.some((w) => w.path === `/api/appointments/${APPT}`)).toBe(true),
    );
    expect(writes.find((w) => w.path === `/api/appointments/${APPT}`)?.body).toEqual({
      version: 2,
      staffId: BEA,
      override: true,
    });
    expect(
      await within(panel).findByText("No upcoming appointments are left. You can deactivate now."),
    ).toBeInTheDocument();
    deactivateReply = { status: 200, body: null };
    fireEvent.click(within(panel).getByRole("button", { name: "Deactivate now" }));
    await waitFor(() =>
      expect(
        staffWrites().filter((w) => w.body && (w.body as { active?: boolean }).active === false),
      ).toHaveLength(2),
    );
  });

  test("cancelling a blocking appointment also unblocks it", async () => {
    deactivateReply = {
      status: 409,
      body: { error: { code: "has_future_appointments", message: "blocked" } },
    };
    open();
    const table = await screen.findByRole("table", { name: "Team members" });
    fireEvent.click(within(table).getAllByRole("button", { name: "Deactivate" })[0] as HTMLElement);
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Deactivate Ana?" })).getByRole("button", {
        name: "Deactivate",
      }),
    );
    const panel = await screen.findByRole("dialog", {
      name: "Ana still has upcoming appointments",
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Cancel this appointment?" })).getByRole(
        "button",
        { name: "Yes, cancel it" },
      ),
    );
    await waitFor(() =>
      expect(writes.find((w) => w.path === `/api/appointments/${APPT}`)?.body).toEqual({
        version: 2,
        status: "cancelled",
      }),
    );
  });

  test("an inactive member can be activated", async () => {
    staff[0] = { ...(staff[0] as Member), active: false };
    open();
    const table = await screen.findByRole("table", { name: "Team members" });
    fireEvent.click(within(table).getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(staffWrites()).toEqual([
        { method: "PATCH", path: `/api/admin/staff/${ANA}`, body: { active: true } },
      ]),
    );
  });
});
