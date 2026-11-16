import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { ReviewModeration } from "./reviews";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("a late publication from a closed panel leaves the newly opened review intact", async () => {
  const at = "2026-03-02T12:00:00.000Z";
  const row = {
    id: "0198f5a0-7b1c-7000-8000-000000000001",
    appointmentId: "0198f5a0-7b1c-7000-8000-000000000002",
    publicName: "A.",
    body: "First client feedback",
    rating: 5,
    shareServices: false,
    services: [],
    status: "pending",
    moderationReason: null,
    reply: null,
    version: 1,
    sourceEligible: true,
    createdAt: at,
    updatedAt: at,
  };
  const second = {
    ...row,
    id: "0198f5a0-7b1c-7000-8000-000000000003",
    body: "Second client feedback",
  };
  let settle = (_response: Response) => {};
  const pending = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  let sent = false;
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    if (!init?.body) return Response.json({ reviews: [row, second], nextBefore: null });
    sent = true;
    return pending;
  }) as unknown as typeof fetch;
  const view = renderApp(<ReviewModeration />);
  const firstText = await screen.findByText("First client feedback");
  const firstCard = firstText.closest("li");
  if (!firstCard) throw new Error("Missing first card");
  fireEvent.click(within(firstCard).getByRole("button", { name: "Review and moderate" }));
  fireEvent.click(
    within(await screen.findByRole("dialog", { name: "Review and moderate" })).getByRole("button", {
      name: "Publish reviewed content",
    }),
  );
  await waitFor(() => expect(sent).toBe(true));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Review and moderate" })).getByRole("button", {
      name: /^Close$/,
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Review and moderate" })).toBeNull(),
  );
  const secondCard = screen.getByText("Second client feedback").closest("li");
  if (!secondCard) throw new Error("Missing second card");
  fireEvent.click(within(secondCard).getByRole("button", { name: "Review and moderate" }));
  await screen.findByRole("dialog", { name: "Review and moderate" });
  await act(async () => {
    settle(Response.json({ ...row, status: "published", version: 2 }));
  });
  await waitFor(() =>
    expect(view.queryClient.getMutationCache().getAll().at(-1)?.state.status).toBe("success"),
  );
  expect(
    within(screen.getByRole("dialog", { name: "Review and moderate" })).getByText(
      "Second client feedback",
    ),
  ).toBeInTheDocument();
});
