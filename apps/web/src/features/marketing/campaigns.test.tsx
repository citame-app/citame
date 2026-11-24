import { afterEach, expect, mock, test } from "bun:test";
import type {
  Campaign,
  CampaignCreate,
  CampaignSmsTestReview,
  CampaignTestRequest,
} from "@sob/contracts";
import { onlineManager } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react";
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

test.each(["email", "sms"] as const)(
  "an owner can check a test %s without sending twice",
  async (channel) => {
    const sms = channel === "sms";
    const campaign: Campaign = {
      id: "0198f5a0-7b1c-7000-8000-000000000201",
      name: "Salon news",
      channel,
      subject: "Hi {{first_name}}",
      emailBody: "Salon news",
      smsBody: sms ? "Salon news" : "",
      audience: { tags: [], inactiveDays: null, noFutureAppointments: false },
      trigger: "manual",
      delayMinutes: 0,
      birthdayLeadDays: 0,
      status: "draft",
      version: 3,
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
      createdAt: "2026-11-22T08:00:00.000Z",
      updatedAt: "2026-11-22T08:00:00.000Z",
    };
    const attempts: CampaignTestRequest[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path.endsWith("/campaigns"))
        return Response.json({
          campaigns: [campaign],
          pagination: { total: 1, page: 1, pageSize: 20 },
        });
      if (path.endsWith("/capabilities"))
        return Response.json({
          email: true,
          sms,
          worker: false,
          canTestEmail: true,
        });
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
          ...(sms && {
            smsTest: {
              lastFour: "0006",
              message: "Saved SMS text",
              reviewToken: "b".repeat(64),
              generation: "reviewed-generation",
            },
          }),
        });
      if (path.endsWith(`/test-${channel}`)) {
        if (sms)
          expect(new Headers(init?.headers).get("x-citame-generation")).toBe("reviewed-generation");
        const packet: CampaignTestRequest = JSON.parse(String(init?.body));
        attempts.push(packet);
        if (attempts.length === 3)
          return Response.json(
            {
              error: {
                code: sms ? "sync_generation_changed" : "version_conflict",
                message: "The draft changed.",
              },
            },
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
    const label = sms ? "Send test SMS" : "Send test to my email";
    fireEvent.click(await screen.findByRole("button", { name: label }));
    if (sms) {
      expect(screen.getByText("Test SMS recipient ends in 0006")).toBeVisible();
      expect(screen.getByText("Saved SMS text")).toBeVisible();
    }
    expect(
      await screen.findByText(sms ? /test SMS is unconfirmed/ : /couldn't confirm the test email/),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: sms ? "Check test SMS" : "Check test delivery" }),
    );
    expect(
      await screen.findByText(
        sms
          ? "The SMS provider accepted the test. Check the test phone."
          : "Test email accepted. Check your inbox.",
      ),
    ).toBeVisible();
    expect(attempts).toHaveLength(2);
    const [firstAttempt, checkAttempt] = attempts;
    if (!firstAttempt || !checkAttempt) throw new Error("Expected a send and a status check");
    expect(firstAttempt).toMatchObject({ version: 3, requestId: expect.any(String), mode: "send" });
    if (sms) expect(firstAttempt).toMatchObject({ reviewToken: "b".repeat(64) });
    expect(checkAttempt).toEqual({ ...firstAttempt, mode: "check" });
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(
      await screen.findByText("The draft changed. Reopen it to test the current version."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: label })).toBeDisabled();
    if (sms) {
      act(() => {
        view.queryClient.setQueryData<{ smsTest?: CampaignSmsTestReview }>(
          ["marketing", "preview", "owner", campaign.id, campaign.version],
          (preview) => ({
            ...preview,
            smsTest: {
              lastFour: "0009",
              message: "Saved SMS text",
              reviewToken: "c".repeat(64),
              generation: "new-generation",
            },
          }),
        );
      });
      expect(await screen.findByText("Test SMS recipient ends in 0009")).toBeVisible();
      expect(screen.getByRole("button", { name: label })).toBeEnabled();
    }
    view.unmount();
    renderApp(<CampaignsView viewerId="manager" isOwner={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /Salon news/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review recipients" }));
    expect(await screen.findByText("0 eligible recipients now")).toBeVisible();
    expect(screen.queryByRole("button", { name: label })).toBeNull();
  },
);

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

  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  onlineManager.setOnline(false);
  try {
    fireEvent.click(screen.getByRole("button", { name: "Compare campaigns" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
    expect(requests).toEqual([expectedIds, expectedIds]);
  } finally {
    onlineManager.setOnline(true);
  }
});

test("a formatted email validates its blocks, saves their order and reopens with the same design", async () => {
  let saved: Campaign | undefined;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/campaigns") && init?.method === "POST") {
      const packet: CampaignCreate = JSON.parse(String(init.body));
      saved = {
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
      };
      return Response.json(saved);
    }
    if (url.pathname.endsWith("/campaigns")) {
      expect(url.searchParams.get("emailLayout")).toBe("1");
      return Response.json({
        campaigns: saved ? [saved] : [],
        pagination: { total: saved ? 1 : 0, page: 1, pageSize: 20 },
      });
    }
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  renderApp(<CampaignsView viewerId="owner" isOwner />);
  fireEvent.click(await screen.findByRole("button", { name: "New campaign" }));
  fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Seasonal offer" } });
  fireEvent.click(screen.getByRole("radio", { name: "With layout" }));
  fireEvent.change(screen.getByLabelText("Header (optional)"), {
    target: { value: "Hello {{first_name}}" },
  });
  fireEvent.change(screen.getByLabelText("Inbox preview text (optional)"), {
    target: { value: "Preview line" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add booking button" }));
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(screen.getByText("Enter text for this block.")).toBeVisible();
  expect(screen.getByText("Review the text of each content block.")).toHaveFocus();
  expect(saved).toBeUndefined();
  fireEvent.change(screen.getByLabelText("Booking button text"), {
    target: { value: "Plan your visit" },
  });
  fireEvent.change(screen.getByLabelText("Paragraph style"), { target: { value: "strong" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Move up" })[1] as HTMLElement);
  expect(screen.getByRole("heading", { name: "Hello Ana" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Draft saved");
  expect(saved).toMatchObject({
    emailLayout: {
      heading: "Hello {{first_name}}",
      preheader: "Preview line",
      blocks: [
        { kind: "booking", label: "Plan your visit" },
        { kind: "paragraph", emphasis: "strong" },
      ],
    },
    emailBody: expect.stringContaining("Plan your visit: {{booking_url}}"),
  });
  fireEvent.click(await screen.findByRole("button", { name: /Seasonal offer/ }));
  expect(screen.getByRole("radio", { name: "With layout" })).toBeChecked();
  expect(screen.getByLabelText("Booking button text")).toHaveValue("Plan your visit");
});
