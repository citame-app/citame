import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClientDetailResponse } from "@sob/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { ClientDetail } from "./client-detail";

const CLIENT = "0198f5a0-7b1c-7000-8000-0000000000c1";
const STAFF = "0198f5a0-7b1c-7000-8000-000000000201";
const realFetch = globalThis.fetch;
const NOW = new Date("2026-03-09T15:00:00.000Z");

const appt = (n: number, startsAt: string, status: string) => ({
  id: `0198f5a0-7b1c-7000-8000-0000000000a${n}`,
  staffId: STAFF,
  clientId: CLIENT,
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
  status,
  notes: null,
  version: 1,
  services: [
    {
      serviceId: null,
      name: n === 1 ? "Haircut" : "Manicure",
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: 1000,
      currency: "ARS",
    },
  ],
  createdAt: startsAt,
  updatedAt: startsAt,
});

let detail: {
  client: Record<string, unknown>;
  appointments: unknown[];
  identity?: ClientDetailResponse["identity"];
};
let patches: unknown[];
let deleteReply: { status: number; body: unknown };
let deletes: number;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  patches = [];
  deletes = 0;
  deleteReply = { status: 200, body: { id: CLIENT, deleted: true } };
  detail = {
    client: {
      id: CLIENT,
      name: "Lucia Perez",
      phone: "+54 9 11 5555-0000",
      email: "lucia@example.com",
      notes: "Prefers mornings",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      appointmentCount: 2,
      lastVisitAt: "2026-02-01T15:00:00.000Z",
    },
    appointments: [
      appt(2, "2026-03-20T15:00:00.000Z", "booked"),
      appt(1, "2026-02-01T15:00:00.000Z", "completed"),
    ],
  };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/intake")) return json({ submissions: [], nextCursor: null });
    if (url.pathname.endsWith("/controls"))
      return json({
        clientId: CLIENT,
        tags: [],
        bookingAccess: "normal",
        reason: null,
        version: 1,
        canManageBookingAccess: true,
      });
    if (url.pathname === `/api/admin/clients/${CLIENT}/photos`)
      return json({ photos: [], canEdit: true, limit: 20 });
    if (url.pathname === "/api/admin/staff")
      return json({
        staff: [{ id: STAFF, displayName: "Ana", active: true, userId: null, serviceIds: [] }],
      });
    if (url.pathname === `/api/admin/clients/${CLIENT}`) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        const { emailChange, ...fields } = body;
        detail = {
          ...detail,
          client: {
            ...detail.client,
            ...fields,
            ...(emailChange ? { email: emailChange.email, updatedAt: NOW.toISOString() } : {}),
          },
        };
        return json(detail.client);
      }
      if (init?.method === "DELETE") {
        deletes += 1;
        return json(deleteReply.body, deleteReply.status);
      }
      return json(detail);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const open = (role: "owner" | "staff" = "owner", onDeleted: () => void = () => {}) =>
  renderApp(
    <ClientDetail
      clientId={CLIENT}
      role={role}
      initialTab="profile"
      onDeleted={onDeleted}
      now={NOW}
    />,
  );

describe("ClientDetail", () => {
  test("edits a standalone email with its reviewed revision and defers validation until save", async () => {
    detail.client.emailEditable = true;
    open();
    const email = await screen.findByLabelText("Contact email");
    const submit = screen.getByRole("button", { name: "Save changes" });
    fireEvent.change(email, { target: { value: "invalid" } });
    expect(screen.queryByText("Enter a valid email address.")).toBeNull();
    fireEvent.click(submit);
    expect(await screen.findByText("Enter a valid email address.")).toBeVisible();
    expect(patches).toHaveLength(0);
    fireEvent.change(email, { target: { value: "corrected@example.org" } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(patches).toEqual([
        {
          emailChange: {
            email: "corrected@example.org",
            expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ]),
    );
    await waitFor(() => expect(submit).toBeDisabled());
    expect(email).toHaveValue("corrected@example.org");
    fireEvent.change(email, { target: { value: "" } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(patches[1]).toEqual({
        emailChange: { email: null, expectedUpdatedAt: NOW.toISOString() },
      }),
    );
  });

  test("keeps an email draft when the reviewed revision changes until the operator resets it", async () => {
    detail.client.emailEditable = true;
    const { queryClient } = open();
    const email = await screen.findByLabelText("Contact email");
    fireEvent.change(email, { target: { value: "draft@example.org" } });
    detail.client = { ...detail.client, email: "server@example.org", updatedAt: NOW.toISOString() };
    await act(() => queryClient.invalidateQueries({ queryKey: ["admin", "client", CLIENT] }));
    const reset = await screen.findByRole("button", { name: "Use current email" });
    expect(email).toHaveValue("draft@example.org");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.click(reset);
    expect(email).toHaveValue("server@example.org");
    expect(patches).toHaveLength(0);
  });

  test("shows the contact form prefilled, with the email read-only", async () => {
    open();
    expect(await screen.findByRole("heading", { name: "Lucia Perez" })).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toHaveValue("Lucia Perez");
    expect(screen.getByLabelText("Phone")).toHaveValue("+54 9 11 5555-0000");
    expect(screen.getByLabelText("Private notes")).toHaveValue("Prefers mornings");
    expect(screen.getByLabelText("Email (read only)")).toHaveAttribute("readonly");
  });

  test("lists upcoming and past appointments with their status", async () => {
    open();
    await screen.findByRole("heading", { name: "Lucia Perez" });
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    const upcoming = (await screen.findByRole("heading", { name: "Upcoming" })).closest(
      "section",
    ) as HTMLElement;
    expect(within(upcoming).getByText("Manicure")).toBeInTheDocument();
    expect(within(upcoming).getByText("Booked")).toBeInTheDocument();
    const past = screen.getByRole("heading", { name: "Past" }).closest("section") as HTMLElement;
    expect(within(past).getByText("Haircut")).toBeInTheDocument();
    expect(within(past).getByText("Completed")).toBeInTheDocument();
  });

  test("saving sends only what changed and confirms with a toast", async () => {
    open();
    const save = await screen.findByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Private notes"), {
      target: { value: "Prefers mornings; allergic to latex" },
    });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(patches).toEqual([{ notes: "Prefers mornings; allergic to latex" }]),
    );
    expect(await screen.findByText("Client updated")).toBeInTheDocument();
  });

  test("an invalid phone is explained and nothing is sent", async () => {
    open();
    fireEvent.change(await screen.findByLabelText("Phone"), { target: { value: "12" } });
    fireEvent.click(
      within(screen.getByRole("form", { name: "Contact" })).getByRole("button", {
        name: "Save changes",
      }),
    );
    expect(
      await screen.findByText("Enter a valid phone number or leave it empty"),
    ).toBeInTheDocument();
    expect(patches).toHaveLength(0);
  });

  test("clearing the phone sends null", async () => {
    open();
    fireEvent.change(await screen.findByLabelText("Phone"), { target: { value: "" } });
    fireEvent.click(
      within(screen.getByRole("form", { name: "Contact" })).getByRole("button", {
        name: "Save changes",
      }),
    );
    await waitFor(() => expect(patches).toEqual([{ phone: null }]));
  });

  test("only the owner can delete; the click asks for confirmation first", async () => {
    const onDeleted = mock();
    const { unmount } = open("owner", onDeleted);
    fireEvent.click(await screen.findByRole("button", { name: "Delete client" }));
    expect(await screen.findByRole("dialog", { name: "Delete Lucia Perez?" })).toBeInTheDocument();
    expect(deletes).toBe(0);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete client" }),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    unmount();
    open("staff");
    await screen.findByRole("heading", { name: "Lucia Perez" });
    expect(screen.queryByRole("button", { name: "Delete client" })).toBeNull();
  });

  test("a client with upcoming appointments cannot be deleted and the blocking ones are listed", async () => {
    deleteReply = {
      status: 409,
      body: { error: { code: "has_future_appointments", message: "blocked" } },
    };
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Delete client" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete client" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This client has upcoming appointments");
    expect(within(alert).getByText(/Manicure/)).toBeInTheDocument();
  });
});

test("a controls-only timestamp update preserves an unsaved contact draft", async () => {
  const view = open();
  await screen.findByLabelText("Full name");
  fireEvent.change(screen.getByLabelText("Full name"), {
    target: { value: "Unsaved contact draft" },
  });
  detail = { ...detail, client: { ...detail.client, updatedAt: "2026-03-10T12:00:00.000Z" } };
  await act(async () => {
    await view.queryClient.invalidateQueries({ queryKey: ["admin", "client", CLIENT] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Full name")).toHaveValue("Unsaved contact draft"),
  );
});

test("a newly linked historical profile freezes its edits and preserves the user's contact draft", async () => {
  const view = open();
  fireEvent.change(await screen.findByLabelText("Full name"), {
    target: { value: "Original unsaved name" },
  });
  detail = {
    ...detail,
    identity: {
      rootId: "0198f5a0-7b1c-7000-8000-0000000000c2",
      profiles: [
        {
          id: CLIENT,
          name: "Lucia Perez",
          email: null,
          phone: null,
          notes: "Original private note",
        },
      ],
    },
  };
  await act(async () => {
    await view.queryClient.invalidateQueries({ queryKey: ["admin", "client", CLIENT] });
  });
  await screen.findByText(/This is a historical profile/);
  expect(screen.getByLabelText("Full name")).toHaveValue("Original unsaved name");
  expect(screen.getByLabelText("Full name")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Review duplicate profiles" })).toBeDisabled();
});
