import { idSchema, purchaseOrderCommandSchema, stockReceiptInputSchema } from "@sob/contracts";
import { z } from "zod";

function requestStorage() {
  return navigator.locks ? window.localStorage : window.sessionStorage;
}

function withStorage<T>(key: string, update: (storage: Storage) => T): Promise<T> {
  const storage = requestStorage();
  return navigator.locks
    ? navigator.locks.request(key, () => update(storage))
    : Promise.resolve(update(storage));
}

function inventoryRequests<T>(
  schema: { parse(value: unknown): T },
  identity: (request: T) => string,
) {
  function read(key: string, storage = requestStorage()) {
    const raw = storage.getItem(key);
    return raw === null ? null : schema.parse(JSON.parse(raw));
  }

  return {
    read,
    preserve: (key: string, request: T) =>
      withStorage(key, (storage) => {
        const existing = read(key, storage);
        if (existing) return existing;
        storage.setItem(key, JSON.stringify(request));
        return request;
      }),
    clear: (key: string, request: T) =>
      withStorage(key, (storage) => {
        const existing = read(key, storage);
        if (existing && identity(existing) === identity(request)) storage.removeItem(key);
      }),
  };
}

const orderRequestSchema = z.strictObject({ id: idSchema, command: purchaseOrderCommandSchema });
export type PendingOrder = z.infer<typeof orderRequestSchema>;
export const orderRequests = inventoryRequests(
  orderRequestSchema,
  (request) => request.command.idempotencyKey,
);
export const receiptRequests = inventoryRequests(
  stockReceiptInputSchema,
  (request) => request.idempotencyKey,
);
