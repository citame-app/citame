import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { WaitlistView } from "./waitlist-view";

const realFetch = globalThis.fetch;
const serviceId = "0198f5a0-7b1c-7000-8000-000000000101";
const staffId = "0198f5a0-7b1c-7000-8000-000000000201";
const clientId = "0198f5a0-7b1c-7000-8000-0000000000c1";
let enabled = true;
let posts: unknown[];
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  enabled = true;
  posts = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/me/waitlist") {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push(body);
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
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("a paused waitlist explains the state without offering a join action", async () => {
  enabled = false;
  renderApp(<WaitlistView mode="client" role="client" clientId={clientId} />);
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
      mode="client"
      role="client"
      clientId={clientId}
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
    <WaitlistView mode="admin" role="staff" accessPreset="professional" ownStaffId={staffId} />,
  );
  expect(await screen.findByRole("heading", { name: "Unassigned haircut" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel waitlist request" })).toBeNull();
});
