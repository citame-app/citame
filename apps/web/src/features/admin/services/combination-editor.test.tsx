import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { CombinationEditor } from "./combination-editor";

const first = "0198f5a0-7b1c-7000-8000-000000000001";
const second = "0198f5a0-7b1c-7000-8000-000000000002";
const oldFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = oldFetch;
});
test("an uncertain creation retains its reviewed terms and reuses the same creation key", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    throw new TypeError("Fixture lost response");
  }) as unknown as typeof fetch;
  renderApp(
    <CombinationEditor
      initial="new"
      catalog={[
        {
          id: first,
          name: "Cut",
          description: null,
          durationMinutes: 30,
          bufferMinutes: 0,
          priceCents: 2000,
          currency: "EUR",
        },
        {
          id: second,
          name: "Colour",
          description: null,
          durationMinutes: 60,
          bufferMinutes: 0,
          priceCents: 3000,
          currency: "EUR",
        },
      ]}
      staff={[{ id: first, displayName: "Ana", serviceIds: [first, second] }]}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Combination name"), {
    target: { value: "Cut and colour" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /Cut/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Colour/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save combination" }));
  await screen.findByText(
    "The response is uncertain. Retry the same submission or discard and reload before changing its terms.",
  );
  expect(screen.getByLabelText("Combination name")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry submission" }));
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1]).toEqual(bodies[0]);
});

test("an unavailable professional can be reviewed without losing archived fixed terms", async () => {
  const bodies: unknown[] = [];
  const fixedTerms = { pricesCents: [1200, 800], staffIds: [first], onlineBooking: false };
  const original = {
    id: first,
    name: "Internal appointment",
    description: null,
    serviceIds: [first, second],
    active: true,
    bookable: true,
    version: 1,
    updatedAt: "2026-11-16T12:00:00Z",
    fixedTerms,
  };
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ...original, active: false, bookable: false, version: 2 });
  }) as unknown as typeof fetch;
  renderApp(
    <CombinationEditor
      initial={original}
      catalog={[
        {
          id: first,
          name: "Cut",
          description: null,
          durationMinutes: 30,
          bufferMinutes: 0,
          priceCents: 2000,
          currency: "EUR",
        },
        {
          id: second,
          name: "Colour",
          description: null,
          durationMinutes: 60,
          bufferMinutes: 0,
          priceCents: 3000,
          currency: "EUR",
        },
      ]}
      staff={[]}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
  const unavailable = screen.getByRole("checkbox", { name: "Unavailable professional" });
  expect(unavailable).toBeChecked();
  expect(unavailable).toBeEnabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable this combination" }));
  fireEvent.click(screen.getByRole("button", { name: "Save combination" }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toMatchObject({ active: false, version: 1 });
  expect(bodies[0]).not.toHaveProperty("fixedTerms");
});
