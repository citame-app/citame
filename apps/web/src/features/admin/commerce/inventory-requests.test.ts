import { expect, test } from "bun:test";
import { orderRequests, type PendingOrder } from "./inventory-requests";

test("an unconfirmed order keeps its identity and stale tabs cannot clear a newer request", async () => {
  const key = "citame:test:pending-order";
  const first: PendingOrder = {
    id: crypto.randomUUID(),
    command: {
      action: "order",
      generation: "initial",
      version: 2,
      idempotencyKey: crypto.randomUUID(),
    },
  };
  const next: PendingOrder = {
    ...first,
    command: { ...first.command, version: 3, idempotencyKey: crypto.randomUUID() },
  };
  try {
    expect(await orderRequests.preserve(key, first)).toEqual(first);
    expect(await orderRequests.preserve(key, next)).toEqual(first);
    expect(orderRequests.read(key)).toEqual(first);
    await orderRequests.clear(key, first);
    expect(await orderRequests.preserve(key, next)).toEqual(next);
    await orderRequests.clear(key, first);
    expect(orderRequests.read(key)).toEqual(next);
  } finally {
    await orderRequests.clear(key, next);
  }
  expect(orderRequests.read(key)).toBeNull();
});
