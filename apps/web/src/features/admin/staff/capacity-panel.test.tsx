import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { CapacityPanel } from "./capacity-panel";

const id = "0198f5a0-7b1c-7000-8000-000000000001";
const oldFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = oldFetch;
});
test("a capacity change needs a fresh explicit confirmation and a rejected reduction keeps the selected limit", async () => {
  const writes: unknown[] = [];
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)));
      return Response.json(
        { error: { code: "slot_taken", message: "Capacity occupied" } },
        { status: 409 },
      );
    }
    return Response.json({
      staffId: id,
      version: 1,
      maxConcurrent: 2,
      effectiveAt: "2026-11-16T12:00:00Z",
    });
  }) as unknown as typeof fetch;
  renderApp(<CapacityPanel staffId={id} editable />);
  const field = await screen.findByLabelText("Concurrent clients during active work");
  fireEvent.change(field, { target: { value: "1" } });
  expect(screen.getByRole("button", { name: "Save capacity" })).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText("I have reviewed this limit and can supervise these concurrent visits."),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save capacity" }));
  await screen.findByText(
    "The lower limit cannot accommodate existing active work or held offers. Your selected limit is preserved; review the calendar or choose another limit.",
  );
  expect(field).toHaveValue("1");
  expect(writes).toEqual([{ version: 1, maxConcurrent: 1, confirmed: true }]);
});
