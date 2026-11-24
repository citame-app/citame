import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { WaitlistSourceEntry } from "@sob/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { CalendarWaitlist } from "~/features/admin/calendar/waitlist";
import { calendarScope } from "~/lib/admin-queries";
import { calendarWaitlistQuery, waitlistQuery } from "~/lib/waitlist-queries";
import { renderApp } from "../../../test/render";
import { WaitlistView } from "./waitlist-view";

const realFetch = globalThis.fetch;
const serviceId = "0198f5a0-7b1c-7000-8000-000000000101";
const staffId = "0198f5a0-7b1c-7000-8000-000000000201";
const clientId = "0198f5a0-7b1c-7000-8000-0000000000c1";
let enabled = true;
let posts: unknown[];
let imports: WaitlistSourceEntry[];
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  enabled = true;
  posts = [];
  imports = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/me/waitlist" || url.pathname === "/api/admin/waitlist") {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        if (body.importedEntryId)
          imports = imports.filter((entry) => entry.id !== body.importedEntryId);
        return json(
          {
            id: crypto.randomUUID(),
            clientId,
            serviceIds: body.serviceIds,
            serviceNames: ["Haircut"],
            staffId: body.staffId ?? null,
            fromDate: body.fromDate,
            toDate: body.toDate,
            fromTime: body.fromTime,
            toTime: body.toTime,
            timezone: "America/Argentina/Buenos_Aires",
            state: "waiting",
            version: 1,
            offer: null,
            appointmentId: null,
            createdAt: new Date().toISOString(),
          },
          201,
        );
      }
      return json({
        policy: { enabled, offerMinutes: 30, version: 1 },
        entries: [],
        page: 1,
        pageSize: 10,
        total: 0,
        ...(url.pathname === "/api/admin/waitlist" ? { imported: imports } : {}),
      });
    }
    if (url.pathname === "/api/services")
      return json({
        services: [
          {
            id: serviceId,
            name: "Haircut",
            description: null,
            durationMinutes: 45,
            bufferMinutes: 15,
            priceCents: 2000,
            currency: "EUR",
          },
        ],
      });
    if (url.pathname === "/api/staff")
      return json({ staff: [{ id: staffId, displayName: "Ana", serviceIds: [serviceId] }] });
    if (url.pathname === "/api/salon")
      return json({
        name: "Test salon",
        timezone: "America/Argentina/Buenos_Aires",
        slotGranularityMinutes: 30,
        minNoticeMinutes: 60,
        maxDaysAhead: 90,
      });
    return json({}, 404);
  }) as unknown as typeof fetch;
});
function addImportedRequest(days = 1) {
  const requestedDate = Temporal.Now.plainDateISO("America/Argentina/Buenos_Aires")
    .add({ days })
    .toString();
  const id = "0198f5a0-7b1c-7000-8000-000000000301";
  imports = [
    {
      id,
      clientId,
      clientName: "Imported customer",
      requestedDate,
      durationMinutes: 60,
      flexible: false,
    },
  ];
  return { id, requestedDate };
}

test("the imported review explains why the request cannot be saved while offers are enabled", async () => {
  addImportedRequest();
  renderApp(<WaitlistView viewer={{ userId: "viewer" }} mode="admin" role="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: "Complete request" }));
  const save = await screen.findByRole("button", { name: "Save waitlist request" });
  expect(save).toBeDisabled();
  expect(save).toHaveAccessibleDescription(/an owner must pause automatic offers/i);
  fireEvent.click(screen.getByRole("checkbox", { name: /Haircut/ }));
  fireEvent.change(screen.getByLabelText("Preferred team member"), { target: { value: staffId } });
  fireEvent.change(screen.getByLabelText("Earliest start"), { target: { value: "10:00" } });
  fireEvent.change(screen.getByLabelText("Latest finish"), { target: { value: "13:00" } });
  await act(async () => {
    fireEvent.submit(screen.getByRole("form", { name: "New waitlist request" }));
  });
  expect(posts).toHaveLength(0);
});

test("the previous salon date remains visible as a past Booksy request", async () => {
  addImportedRequest(-1);
  renderApp(<WaitlistView viewer={{ userId: "viewer" }} mode="admin" role="owner" />);
  expect(await screen.findByText("Imported customer")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Past Booksy requests" })).toBeInTheDocument();
  expect(screen.getByText("The requested date has passed.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Complete request" })).toBeNull();
});

test("an operator can complete a Booksy request while automatic offers are paused", async () => {
  enabled = false;
  const { id, requestedDate } = addImportedRequest();
  renderApp(
    <WaitlistView
      viewer={{ userId: "viewer" }}
      mode="admin"
      role="owner"
      initialServices={[serviceId]}
    />,
  );
  expect(await screen.findByText("Imported customer")).toBeInTheDocument();
  expect(screen.getByText(/while automatic offers are paused/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Complete request" }));
  const from = await screen.findByLabelText("Earliest start");
  expect(from).toHaveValue("");
  expect(screen.getByLabelText("From date")).toHaveValue(requestedDate);
  expect(screen.getByLabelText("From date")).toHaveProperty("readOnly", true);
  fireEvent.click(screen.getByRole("checkbox", { name: /Haircut/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save waitlist request" }));
  expect(posts).toHaveLength(0);
  fireEvent.change(from, { target: { value: "10:00" } });
  fireEvent.change(screen.getByLabelText("Latest finish"), { target: { value: "13:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save waitlist request" }));
  expect(posts).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Preferred team member"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save waitlist request" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({
    clientId,
    importedEntryId: id,
    staffId: null,
    fromDate: requestedDate,
    toDate: requestedDate,
    fromTime: "10:00",
    toTime: "13:00",
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("a paused waitlist explains the state without offering a join action", async () => {
  enabled = false;
  renderApp(<WaitlistView viewer={{ userId: "viewer" }} mode="client" role="client" />);
  expect(
    await screen.findByText("The salon has paused new waitlist requests."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Join the waitlist" })).toBeNull();
});
test("a customer joins with explicit services and a preferred window without sending another customer's identity", async () => {
  const today = Temporal.Now.plainDateISO("America/Argentina/Buenos_Aires");
  const fromDate = today.add({ days: 7 }).toString();
  const toDate = today.add({ days: 20 }).toString();
  renderApp(
    <WaitlistView
      viewer={{ userId: "viewer" }}
      mode="client"
      role="client"
      initialServices={[serviceId]}
      initialStaff={staffId}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Join the waitlist" }));
  fireEvent.change(await screen.findByLabelText("From date"), { target: { value: fromDate } });
  fireEvent.change(screen.getByLabelText("Until date"), { target: { value: toDate } });
  fireEvent.change(screen.getByLabelText("Earliest start"), { target: { value: "10:00" } });
  fireEvent.change(screen.getByLabelText("Latest finish"), { target: { value: "13:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save waitlist request" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({
    serviceIds: [serviceId],
    staffId,
    fromDate,
    toDate,
    fromTime: "10:00",
    toTime: "13:00",
  });
  expect(posts[0]).not.toHaveProperty("clientId");
  expect(await screen.findByText("Waitlist request saved")).toBeInTheDocument();
});

test("a professional can read an unassigned request without being offered a forbidden cancellation action", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input), "http://localhost").pathname === "/api/admin/waitlist")
      return json({
        policy: { enabled: true, offerMinutes: 30, version: 1 },
        entries: [
          {
            id: crypto.randomUUID(),
            clientId,
            serviceIds: [serviceId],
            serviceNames: ["Unassigned haircut"],
            staffId: null,
            fromDate: "2026-12-01",
            toDate: "2026-12-14",
            fromTime: "09:00",
            toTime: "18:00",
            timezone: "America/Argentina/Buenos_Aires",
            state: "waiting",
            version: 1,
            offer: null,
            appointmentId: null,
            createdAt: new Date().toISOString(),
            canManage: false,
          },
        ],
        page: 1,
        pageSize: 10,
        total: 1,
      });
    return previous(input, init);
  }) as unknown as typeof fetch;
  renderApp(
    <WaitlistView
      viewer={{ userId: "viewer" }}
      mode="admin"
      role="staff"
      accessPreset="professional"
      ownStaffId={staffId}
    />,
  );
  expect(await screen.findByRole("heading", { name: "Unassigned haircut" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel waitlist request" })).toBeNull();
});

test("an uncertain waitlist booking keeps the reviewed request through a list refresh", async () => {
  const entryId = crypto.randomUUID();
  const offerId = crypto.randomUUID();
  const appointmentId = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30000).toISOString();
  const entry = {
    id: entryId,
    clientId,
    clientName: "Synthetic guest",
    serviceIds: [serviceId],
    serviceNames: ["Haircut"],
    staffId,
    fromDate: now.slice(0, 10),
    toDate: now.slice(0, 10),
    fromTime: "10:00",
    toTime: "12:00",
    timezone: "America/Argentina/Buenos_Aires",
    state: "offered",
    version: 2,
    createdAt: now,
    canManage: true,
    appointmentId: null,
    offer: {
      id: offerId,
      staffId,
      staffName: "Ana",
      startsAt: now,
      endsAt: expiresAt,
      expiresAt,
      priceCents: 2000,
      currency: "EUR",
      services: [
        {
          id: serviceId,
          name: "Haircut",
          durationMinutes: 45,
          bufferMinutes: 15,
          priceCents: 2000,
          priceType: "from",
          currency: "EUR",
        },
      ],
      policy: {
        enabled: true,
        version: 1,
        depositKind: "fixed",
        depositValue: 500,
        holdMinutes: 30,
        cancellationWindowMinutes: 0,
        lateCancellationBasisPoints: 0,
        noShowBasisPoints: 0,
        trustedExempt: false,
      },
    },
  };
  const defaultFetch = globalThis.fetch;
  const attempts: string[] = [];
  let listOffline = false;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/intake/requirements")
      return json({ reviewHash: "b".repeat(64), forms: [], readyResponses: [] });
    if (path === "/api/admin/waitlist") {
      if (listOffline) throw new Error("Connection lost during list refresh");
      return json({
        entries: [entry],
        policy: { enabled: true, offerMinutes: 30, version: 1 },
        page: 1,
        pageSize: 10,
        total: 1,
      });
    }
    if (path === `/api/admin/waitlist/${entryId}/accept`) {
      attempts.push(String(init?.body));
      if (attempts.length === 1)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new TypeError("Connection closed while reading the acknowledgement"),
              );
            },
          }),
          { status: 201 },
        );
      if (attempts.length === 2)
        return new Response(
          JSON.stringify({ error: { code: "rate_limited", message: "Please wait" } }),
          { status: 429, headers: { "retry-after": "1" } },
        );
      if (attempts.length === 3)
        return json({ error: { code: "forbidden", message: "Temporarily unable to verify" } }, 403);
      return json({
        entry: { ...entry, state: "booked", offer: null, version: 3, appointmentId },
        appointment: {
          id: appointmentId,
          staffId,
          clientId,
          startsAt: now,
          endsAt: expiresAt,
          status: "booked",
          notes: null,
          version: 1,
          services: [],
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    return defaultFetch(input, init);
  }) as unknown as typeof fetch;
  const { queryClient } = renderApp(
    <WaitlistView viewer={{ userId: "viewer" }} mode="admin" role="owner" />,
  );
  expect(await screen.findByText(/^Services: From/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Review this offer" }));
  const waiver = await screen.findByLabelText(/Deposit waiver reason/);
  fireEvent.change(waiver, { target: { value: "Synthetic owner approved waiver" } });
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  expect(await screen.findByRole("button", { name: "Discard and leave" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(waiver).toHaveValue("Synthetic owner approved waiver");

  const accept = screen.getByRole("button", { name: "Accept and book this time" });
  await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(accept);
  const retry = await screen.findByRole("button", { name: "Verify or retry booking" });
  expect(waiver).toBeDisabled();
  expect(JSON.parse(attempts[0] ?? "{}")).toMatchObject({
    version: 2,
    offerId,
    protectionWaiverReason: "Synthetic owner approved waiver",
    intakeReviewHash: "b".repeat(64),
  });

  listOffline = true;
  await act(() => queryClient.invalidateQueries({ queryKey: ["waitlist"] }));
  expect(retry).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  expect(await screen.findByText(/The appointment may already be booked/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

  listOffline = false;
  fireEvent.click(retry);
  await waitFor(() => expect(attempts).toHaveLength(2));
  expect(retry).toBeDisabled();
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
  expect(waiver).toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() => {
    expect(attempts).toHaveLength(3);
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });
  expect(waiver).toBeDisabled();
  fireEvent.click(retry);
  expect(await screen.findAllByText("Your waitlist appointment is booked")).not.toHaveLength(0);
  expect(attempts).toHaveLength(4);
  expect(new Set(attempts).size).toBe(1);
});

function TeamWaitlist() {
  const [accessScope, setAccessScope] = useState("reception");
  const role = "staff";
  return (
    <>
      <button
        type="button"
        onClick={() => {
          imports = [];
          setAccessScope("professional");
        }}
      >
        Use own calendar
      </button>
      <WaitlistView
        key={accessScope}
        viewer={{ userId: "team-member", accessScope }}
        mode="admin"
        role={role}
        accessPreset={accessScope === "reception" ? "manager" : "professional"}
        ownStaffId={staffId}
      />
    </>
  );
}

test("permission changes isolate previously cached requests on the same staff account", async () => {
  addImportedRequest();
  renderApp(<TeamWaitlist />);
  expect(await screen.findByText("Imported customer")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Complete request" }));
  expect(await screen.findByRole("form", { name: "New waitlist request" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Use own calendar" }));
  expect(screen.queryByText("Imported customer")).toBeNull();
  expect(screen.queryByRole("form", { name: "New waitlist request" })).toBeNull();
  expect(await screen.findByText("No waitlist requests yet")).toBeVisible();
});

test("a denied calendar count clears cached waitlist pages and cancels an earlier read", async () => {
  const { requestedDate } = addImportedRequest();
  const range = { fromDate: requestedDate, toDate: requestedDate };
  const viewer = { userId: "team-member", accessScope: "reception" };
  const list = waitlistQuery("admin", viewer, { page: 1, pageSize: 10 });
  const count = calendarWaitlistQuery(viewer, range);
  const anotherAccount = calendarWaitlistQuery({ ...viewer, userId: "colleague" }, range);
  const pending = Promise.withResolvers<Response>();
  let countDenied = false;
  let staleSignal: AbortSignal | null | undefined;
  const defaultFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/admin/waitlist") {
      if (url.searchParams.get("pageSize") === "1") {
        return countDenied
          ? json({ error: { code: "forbidden", message: "Access changed" } }, 403)
          : json({
              entries: [],
              total: 2,
              page: 1,
              pageSize: 1,
              policy: { enabled, offerMinutes: 30, version: 1 },
            });
      }
      if (countDenied) {
        staleSignal = init?.signal;
        return pending.promise;
      }
    }
    return defaultFetch(input, init);
  }) as unknown as typeof fetch;
  const { queryClient } = renderApp(
    <>
      <WaitlistView viewer={viewer} mode="admin" role="owner" />
      <CalendarWaitlist viewer={viewer} {...range} role="owner" ownStaffId={null} />
    </>,
  );
  try {
    expect(await screen.findByText("Imported customer")).toBeVisible();
    expect(await screen.findByRole("button", { name: "View waitlist (2)" })).toBeVisible();
    queryClient.setQueryData(anotherAccount.queryKey, 8);
    countDenied = true;
    void queryClient.invalidateQueries({ queryKey: list.queryKey });
    await waitFor(() => expect(staleSignal).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: count.queryKey }));
    expect(await screen.findByRole("button", { name: "Waitlist" })).toBeVisible();
    expect(screen.queryByText("Imported customer")).toBeNull();
    expect(staleSignal?.aborted).toBe(true);
    expect(queryClient.getQueryData(list.queryKey)).toBeNull();
    expect(queryClient.getQueryData(anotherAccount.queryKey)).toBe(8);
  } finally {
    pending.resolve(
      json({
        entries: [],
        total: 4,
        page: 1,
        pageSize: 10,
        policy: { enabled, offerMinutes: 30, version: 1 },
      }),
    );
  }
  await waitFor(() => expect(queryClient.getQueryData(list.queryKey)).toBeNull());
});

test("retry checks the current session before requesting a previously denied waitlist", async () => {
  const session = {
    user: {
      id: "viewer",
      role: "client" as const,
      name: "Test customer",
      email: "viewer@fixture.test",
    },
    staffId: null,
    clientId,
    phone: null,
  };
  const requests: string[] = [];
  const defaultFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/me") {
      requests.push(path);
      return json(session);
    }
    if (path === "/api/me/waitlist") {
      requests.push(path);
      if (requests.length === 1)
        return json({ error: { code: "forbidden", message: "Access changed" } }, 403);
    }
    return defaultFetch(input, init);
  }) as unknown as typeof fetch;
  renderApp(
    <WaitlistView
      mode="client"
      role="client"
      viewer={{ userId: "viewer", accessScope: calendarScope(session) }}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No waitlist requests yet")).toBeVisible();
  expect(requests).toEqual(["/api/me/waitlist", "/api/me", "/api/me/waitlist"]);
});
