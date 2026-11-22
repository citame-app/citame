import { afterEach, expect, mock, test } from "bun:test";
import type { Campaign, CampaignTestEmail } from "@sob/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { CampaignsView } from "./campaigns";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
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
