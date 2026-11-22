import { afterEach, expect, mock, test } from "bun:test";
import type { Campaign, CampaignCreate, CampaignTestEmail } from "@sob/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { renderApp } from "../../../test/render";
import { CampaignsView } from "./campaigns";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function Viewer({ onSwitch }: { onSwitch: () => void }) {
  const [viewerId, setViewerId] = useState("first");
  return (
    <>
      <button
        type="button"
        onClick={() => {
          onSwitch();
          setViewerId("second");
        }}
      >
        Switch viewer
      </button>
      <CampaignsView key={viewerId} viewerId={viewerId} isOwner={viewerId === "first"} />
    </>
  );
}

test("another signed-in viewer never renders campaigns cached for the previous viewer", async () => {
  const name = "Private campaign from the previous session";
  const campaign: Campaign = {
    id: "0198f5a0-7b1c-7000-8000-000000000201",
    name,
    channel: "email",
    subject: "Hi",
    emailBody: "Hello",
    smsBody: "",
    audience: { tags: [], inactiveDays: null, noFutureAppointments: false },
    trigger: "manual",
    delayMinutes: 0,
    birthdayLeadDays: 0,
    status: "draft",
    version: 1,
    counts: { pending: 0, processing: 0, sent: 0, skipped: 0, failed: 0, unknown: 0, cancelled: 0 },
    scheduledFor: null,
    activatedAt: null,
    createdAt: "2026-11-22T08:00:00.000Z",
    updatedAt: "2026-11-22T08:00:00.000Z",
  };
  let firstViewer = true;
  globalThis.fetch = mock(async () =>
    firstViewer
      ? Response.json({
          campaigns: [campaign],
          pagination: { total: 1, page: 1, pageSize: 20 },
        })
      : Response.json({ error: { code: "forbidden", message: "Access changed" } }, { status: 403 }),
  ) as unknown as typeof fetch;
  renderApp(
    <Viewer
      onSwitch={() => {
        firstViewer = false;
      }}
    />,
  );
  expect(await screen.findByText(name)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Switch viewer" }));
  expect(screen.queryByText(name)).toBeNull();
});

test("booking invitations require selected contacts before opening the recipient review", async () => {
  const contact = {
    id: "0198f5a0-7b1c-7000-8000-000000000202",
    name: "Synthetic contact",
    phone: null,
    email: "contact@example.com",
    notes: null,
    createdAt: "2026-11-22T08:00:00.000Z",
    updatedAt: "2026-11-22T08:00:00.000Z",
    appointmentCount: 0,
    lastVisitAt: null,
  };
  const drafts: CampaignCreate[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/campaigns") && init?.method === "POST") {
      const packet: CampaignCreate = JSON.parse(String(init.body));
      drafts.push(packet);
      return Response.json({
        ...packet,
        status: "draft",
        version: 1,
        counts: {
          pending: 0,
          processing: 0,
          sent: 0,
          skipped: 0,
          failed: 0,
          unknown: 0,
          cancelled: 0,
        },
        scheduledFor: null,
        activatedAt: null,
        createdAt: "2026-11-22T08:00:00Z",
        updatedAt: "2026-11-22T08:00:00Z",
        selectedContacts: [{ id: contact.id, name: contact.name }],
      });
    }
    if (path.endsWith("/campaigns"))
      return Response.json({
        campaigns: [],
        pagination: { total: 0, page: 1, pageSize: 20 },
        bookingInvitations: true,
      });
    if (path.endsWith("/clients"))
      return Response.json({ clients: [contact], total: 1, page: 1, pageSize: 10 });
    if (path.endsWith("/capabilities"))
      return Response.json({ email: false, sms: false, worker: false });
    if (path.endsWith("/preview"))
      return Response.json({
        campaignId: drafts[0]?.id,
        version: 1,
        audienceHash: "a".repeat(64),
        eligible: 0,
        email: 0,
        sms: 0,
        excluded: 1,
        sample: [],
      });
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  renderApp(<CampaignsView viewerId="owner" isOwner />);
  fireEvent.click(await screen.findByRole("button", { name: "Invite to book" }));
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(screen.getByText("Select at least one client.")).toBeVisible();
  expect(drafts).toHaveLength(0);
  fireEvent.click(await screen.findByRole("checkbox", { name: /Synthetic contact/ }));
  expect(screen.getByRole("button", { name: "Remove Synthetic contact" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Review recipients" }));
  await screen.findByText("0 eligible recipients now");
  expect(drafts).toHaveLength(1);
  expect(drafts[0]).toMatchObject({
    trigger: "manual",
    emailBody: expect.stringContaining("{{booking_url}}"),
    audience: { selectedClientIds: [contact.id] },
  });
});

test("an owner can retry a test email without creating another request", async () => {
  const campaign: Campaign = {
    id: "0198f5a0-7b1c-7000-8000-000000000201",
    name: "Salon news",
    channel: "email",
    subject: "Hi {{first_name}}",
    emailBody: "Salon news",
    smsBody: "",
    audience: { tags: [], inactiveDays: null, noFutureAppointments: false },
    trigger: "manual",
    delayMinutes: 0,
    birthdayLeadDays: 0,
    status: "draft",
    version: 3,
    counts: { pending: 0, processing: 0, sent: 0, skipped: 0, failed: 0, unknown: 0, cancelled: 0 },
    scheduledFor: null,
    activatedAt: null,
    createdAt: "2026-11-22T08:00:00.000Z",
    updatedAt: "2026-11-22T08:00:00.000Z",
  };
  const attempts: CampaignTestEmail[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/campaigns"))
      return Response.json({
        campaigns: [campaign],
        pagination: { total: 1, page: 1, pageSize: 20 },
      });
    if (path.endsWith("/capabilities"))
      return Response.json({ email: true, sms: false, worker: false, canTestEmail: true });
    if (path.endsWith("/preview"))
      return Response.json({
        campaignId: campaign.id,
        version: campaign.version,
        audienceHash: "a".repeat(64),
        eligible: 0,
        email: 0,
        sms: 0,
        excluded: 0,
        sample: [],
      });
    if (path.endsWith("/test-email")) {
      const packet: CampaignTestEmail = JSON.parse(String(init?.body));
      attempts.push(packet);
      if (attempts.length === 3)
        return Response.json(
          { error: { code: "version_conflict", message: "The draft changed." } },
          { status: 409 },
        );
      return attempts.length === 1
        ? Response.json({ error: { code: "invalid_state" } }, { status: 409 })
        : Response.json({ status: "accepted", requestId: packet.requestId });
    }
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  const view = renderApp(<CampaignsView viewerId="owner" isOwner />);
  fireEvent.click(await screen.findByRole("button", { name: /Salon news/ }));
  fireEvent.click(screen.getByRole("button", { name: "Review recipients" }));
  const label = "Send test to my email";
  fireEvent.click(await screen.findByRole("button", { name: label }));
  expect(await screen.findByText(/couldn't confirm the test email/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Check test delivery" }));
  expect(await screen.findByText("Test email accepted. Check your inbox.")).toBeVisible();
  expect(attempts).toHaveLength(2);
  const [firstAttempt, checkAttempt] = attempts;
  if (!firstAttempt || !checkAttempt) throw new Error("Expected a send and a status check");
  expect(firstAttempt).toMatchObject({ version: 3, requestId: expect.any(String), mode: "send" });
  expect(checkAttempt).toEqual({ ...firstAttempt, mode: "check" });
  fireEvent.click(screen.getByRole("button", { name: label }));
  expect(
    await screen.findByText("The draft changed. Reopen it to test the current version."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: label })).toBeDisabled();
  view.unmount();
  renderApp(<CampaignsView viewerId="manager" isOwner={false} />);
  fireEvent.click(await screen.findByRole("button", { name: /Salon news/ }));
  fireEvent.click(screen.getByRole("button", { name: "Review recipients" }));
  expect(await screen.findByText("0 eligible recipients now")).toBeVisible();
  expect(screen.queryByRole("button", { name: label })).toBeNull();
});

test("campaign comparison keeps selections across pages and shows separate delivery counts", async () => {
  const campaigns = ["First", "Second"].map((name, index) => ({
    id: `0198f5a0-7b1c-7000-8000-00000000031${index}`,
    name,
    channel: "email",
    subject: "Hi",
    emailBody: "Hello",
    smsBody: "",
    audience: { tags: [], inactiveDays: null, noFutureAppointments: false },
    trigger: "manual",
    delayMinutes: 0,
    birthdayLeadDays: 0,
    status: "active",
    version: 1,
    counts: {
      pending: index + 1,
      processing: 0,
      sent: index + 12,
      skipped: 0,
      failed: 0,
      unknown: 0,
      cancelled: 0,
    },
    scheduledFor: null,
    activatedAt: null,
    createdAt: "2026-11-22T08:00:00.000Z",
    updatedAt: "2026-11-22T08:00:00.000Z",
  }));
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/comparison")) {
      requests.push(url.searchParams.get("ids") ?? "");
      return Response.json({
        campaigns: campaigns.map(({ id, name, channel, status, counts }) => ({
          id,
          name,
          channel,
          status,
          counts,
        })),
      });
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    return Response.json({
      campaigns: [campaigns[page - 1]],
      pagination: { total: 21, page, pageSize: 20 },
    });
  }) as unknown as typeof fetch;
  renderApp(<CampaignsView viewerId="owner" isOwner />);
  const compare = screen.getByRole("button", { name: "Compare campaigns" });
  expect(compare).toBeDisabled();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select First for comparison" }));
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Second for comparison" }));
  fireEvent.click(compare);
  const table = await screen.findByRole("table", { name: "Campaign metrics" });
  expect(table.querySelector('thead th[scope="col"]:nth-child(2)')).toHaveTextContent("First");
  expect(table.querySelector('thead th[scope="col"]:nth-child(3)')).toHaveTextContent("Second");
  expect(table).toHaveTextContent("Accepted by provider");
  expect(screen.getByRole("cell", { name: "12" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "13" })).toBeVisible();
  const expectedIds = campaigns.map(({ id }) => id).join(",");
  expect(requests).toEqual([expectedIds]);

  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  if (!campaigns[0]) throw new Error("Expected the first campaign");
  campaigns[0].counts.sent = 14;
  fireEvent.click(screen.getByRole("button", { name: "Compare campaigns" }));
  expect(await screen.findByRole("cell", { name: "14" })).toBeVisible();
  expect(requests).toEqual([expectedIds, expectedIds]);
});
