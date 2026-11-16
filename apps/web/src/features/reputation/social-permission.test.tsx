import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { OwnReviews } from "./reviews";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("revoking social permission keeps the published website review visible", async () => {
  const id = "0198f5a0-7b1c-7000-8000-000000000001";
  const at = "2026-03-02T12:00:00.000Z";
  let revoked = false;
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") revoked = true;
    const review = {
      id,
      appointmentId: id,
      publicName: "A.",
      rating: 5,
      body: "My published feedback",
      shareServices: false,
      services: [],
      status: "published",
      moderationReason: null,
      reply: null,
      sourceEligible: true,
      version: revoked ? 3 : 2,
      createdAt: at,
      updatedAt: at,
      allowSocialUse: !revoked,
      socialPermissionVersion: revoked ? null : "public-review-social-v1",
    };
    return Response.json(
      init?.method === "POST"
        ? review
        : { visits: [{ appointmentId: id, startsAt: at, services: [], review }], nextBefore: null },
    );
  }) as unknown as typeof fetch;
  renderApp(<OwnReviews />);
  fireEvent.click(await screen.findByRole("button", { name: "Withdraw social permission" }));
  const dialog = await screen.findByRole("dialog", { name: "Withdraw social permission" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw social permission" }));
  await screen.findByText("Social reuse is not allowed");
  expect(screen.getByText("My published feedback")).toBeInTheDocument();
  expect(screen.getByText("Published")).toBeInTheDocument();
  expect(revoked).toBe(true);
});
