import { expect, test } from "bun:test";
import { createBookingIntent } from "./intent";

test("a retried submission keeps its identity across refreshed prices and policy consent", () => {
  let next = 0;
  const intent = createBookingIntent(() => `intent-${++next}`);
  const core = {
    staffId: "ana",
    serviceIds: ["cut", "extra"],
    startsAt: "2026-03-09T12:00:00.000Z",
    notes: "Please call",
  };
  const first = intent({ ...core, serviceQuotes: { cut: "old" }, protectionAcceptedVersion: 1 });
  expect(intent({ ...core, serviceQuotes: { cut: "new" }, protectionAcceptedVersion: 2 })).toBe(
    first,
  );
  expect(intent({ ...core, startsAt: "2026-03-09T13:00:00.000Z" })).not.toBe(first);
  expect(intent(core)).toBe(first);
  expect(intent({ ...core, notes: "Different" })).not.toBe(first);
  expect(intent({ ...core, serviceIds: ["extra", "cut"] })).not.toBe(first);
});

test("walk-in identity binds supplied contact details without depending on object key order", () => {
  let next = 0;
  const intent = createBookingIntent(() => String(++next));
  const core = { staffId: "ana", serviceIds: ["cut"], startsAt: "2026-03-09T12:00:00.000Z" };
  const first = intent({ ...core, client: { name: "Nora", phone: "+34600000000" } });
  expect(intent({ ...core, client: { phone: "+34600000000", name: "Nora" } })).toBe(first);
  expect(intent({ ...core, client: { name: "Someone else", phone: "+34600000000" } })).not.toBe(
    first,
  );
  expect(intent({ ...core, clientId: "saved-client" })).not.toBe(first);
});

test("a fixed combination uses a distinct booking identifier and keeps it when its terms refresh", () => {
  let next = 0;
  const intent = createBookingIntent(() => String(++next));
  const core = {
    staffId: "ana",
    serviceIds: ["cut", "colour"],
    startsAt: "2026-03-09T12:00:00.000Z",
  };
  const first = intent(core);
  const combination = { id: "cut-and-colour", version: 1, reviewHash: "a".repeat(64) };
  const fixed = intent({ ...core, combination });
  expect(fixed).not.toBe(first);
  expect(
    intent({ ...core, combination: { ...combination, version: 2, reviewHash: "b".repeat(64) } }),
  ).toBe(fixed);
  expect(intent({ ...core, combination: { ...combination, id: "another-combination" } })).not.toBe(
    fixed,
  );
});
