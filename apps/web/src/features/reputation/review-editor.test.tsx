import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { ReviewEditor } from "./review-editor";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("publication is opt-in and an uncertain response retains the exact reviewed packet and retry key", async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    throw new TypeError("Lost response");
  }) as unknown as typeof fetch;
  renderApp(
    <ReviewEditor
      appointmentId="0198f5a0-7b1c-7000-8000-000000000001"
      review={null}
      onSaved={() => {}}
      onDirtyChange={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Public name"), { target: { value: "A." } });
  fireEvent.change(screen.getByLabelText("Your review"), { target: { value: "A lovely visit" } });
  expect(screen.getByLabelText("Show the booked treatments publicly")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Send for moderation" })).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText("I agree to publish this name, rating and review on the salon website."),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send for moderation" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Your review")).toHaveValue("A lovely visit");
  expect(screen.getByLabelText("Your review")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Send for moderation" }));
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({
    publicName: "A.",
    shareServices: false,
    publicationConfirmed: true,
  });
});
