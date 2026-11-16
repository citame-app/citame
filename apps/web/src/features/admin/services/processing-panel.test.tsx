import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { ProcessingEditor } from "./processing-panel";

const id = "0198f5a0-7b1c-7000-8000-000000000001";
const oldFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = oldFetch;
});
test("an exposure must leave final work and an uncertain save freezes its original reviewed duration", async () => {
  const writes: unknown[] = [];
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    writes.push(JSON.parse(String(init?.body)));
    throw new TypeError("Fixture connection lost");
  }) as unknown as typeof fetch;
  renderApp(
    <ProcessingEditor
      service={{
        id,
        name: "Colour",
        description: null,
        durationMinutes: 90,
        bufferMinutes: 10,
        priceCents: 2000,
        currency: "EUR",
        active: true,
        staffIds: [],
        version: 1,
      }}
      onReload={async () => {}}
      onSaved={async () => {}}
    />,
  );
  fireEvent.click(screen.getByLabelText("Release the professional during a processing interval"));
  fireEvent.change(screen.getByLabelText("Active work before processing (minutes)"), {
    target: { value: "30" },
  });
  fireEvent.change(screen.getByLabelText("Processing time (minutes)"), { target: { value: "60" } });
  expect(screen.getByRole("button", { name: "Save processing time" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Processing time (minutes)"), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "Save processing time" }));
  await screen.findByText(
    "The response is uncertain. Retry the same change or reload the saved policy before editing again.",
  );
  expect(screen.getByLabelText("Processing time (minutes)")).toBeDisabled();
  expect(writes).toEqual([{ version: 1, processing: { startsAfterMinutes: 30, minutes: 30 } }]);
});
