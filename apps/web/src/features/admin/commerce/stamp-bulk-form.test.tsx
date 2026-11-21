import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { StampBulkForm } from "./stamp-bulk-form";

const originalFetch = globalThis.fetch;
const preview = {
  scope: "expired",
  generation: "tested",
  reviewFingerprint: "a".repeat(64),
  total: 2,
  counts: { active: 0, expired: 2, completed: 0, issued: 0 },
};
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("preview has no write effect and an uncertain request reuses the reviewed packet", async () => {
  const packets: Record<string, unknown>[] = [];
  const fetch = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json(preview);
    const packet = JSON.parse(String(init.body)) as Record<string, unknown>;
    packets.push(packet);
    if (packets.length === 1)
      return Response.json({ error: { code: "internal_error" } }, { status: 503 });
    if (packets.length === 2)
      return Response.json({ error: { code: "rate_limited" } }, { status: 429 });
    return Response.json({
      scope: packet.scope,
      generation: packet.generation,
      idempotencyKey: packet.idempotencyKey,
      total: 2,
      voidedAt: "2026-11-21T15:00:00.000Z",
    });
  });
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  renderApp(<StampBulkForm />);
  fireEvent.click(screen.getByText("Manage stamp cards"));
  fireEvent.click(screen.getByRole("button", { name: "Review cards" }));
  const reason = await screen.findByRole("textbox", { name: "Reason for the annulment" });
  expect(packets).toHaveLength(0);
  fireEvent.change(reason, { target: { value: "Review of expired loyalty rewards" } });
  fireEvent.click(screen.getByRole("button", { name: "Void reviewed cards" }));
  const retry = await screen.findByRole("button", { name: "Retry the same request" });
  expect(reason).toBeDisabled();
  fireEvent.click(retry);
  await screen.findByText(/too many|rate limit/i);
  fireEvent.click(screen.getByRole("button", { name: "Retry the same request" }));
  expect(await screen.findByText("Cards voided · 2")).toBeVisible();
  expect(packets).toHaveLength(3);
  expect(packets[1]).toEqual(packets[0]);
  expect(packets[2]).toEqual(packets[0]);
  expect(packets[0]).toMatchObject({
    scope: "expired",
    generation: "tested",
    reviewFingerprint: preview.reviewFingerprint,
    reason: "Review of expired loyalty rewards",
  });
});
