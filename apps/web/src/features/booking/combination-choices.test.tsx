import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { CombinationChoices } from "./combination-choices";

const first = "0198f5a0-7b1c-7000-8000-000000000001";
const second = "0198f5a0-7b1c-7000-8000-000000000002";
const oldFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = oldFetch;
});
test("a curated sequence replaces the selection in its original order and shows current totals", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({
      combinations: [
        {
          id: first,
          name: "Cut and colour",
          description: null,
          serviceIds: [second, first],
          active: true,
          version: 1,
          bookable: true,
          updatedAt: "2026-11-16T12:00:00Z",
        },
      ],
    }),
  ) as unknown as typeof fetch;
  const onChange = mock(() => {});
  renderApp(
    <CombinationChoices
      catalog={[
        {
          id: first,
          name: "Cut",
          description: null,
          durationMinutes: 30,
          bufferMinutes: 5,
          priceCents: 2000,
          currency: "EUR",
        },
        {
          id: second,
          name: "Colour",
          description: null,
          durationMinutes: 60,
          bufferMinutes: 10,
          priceCents: 3000,
          currency: "EUR",
        },
      ]}
      staff={[{ id: first, displayName: "Ana", serviceIds: [first, second] }]}
      selected={[]}
      onChange={onChange}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose combination: Cut and colour" }),
  );
  expect(onChange).toHaveBeenCalledWith([second, first]);
  expect(screen.getByText(/€50/)).toBeVisible();
  expect(screen.getByText("Colour → Cut")).toBeVisible();
});
