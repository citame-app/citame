import { type StockReceiptInput, stockReceiptInputSchema } from "@sob/contracts";

export function readReceiptRequest(storage: Pick<Storage, "getItem">, key: string) {
  const raw = storage.getItem(key);
  return raw === null ? null : stockReceiptInputSchema.parse(JSON.parse(raw));
}

export const receiptRequestStorage = () =>
  navigator.locks ? window.localStorage : window.sessionStorage;

function withReceiptStorage<T>(key: string, update: (storage: Storage) => T): Promise<T> {
  const storage = receiptRequestStorage();
  return navigator.locks
    ? navigator.locks.request(key, () => update(storage))
    : Promise.resolve(update(storage));
}

export function preserveReceiptRequest(key: string, command: StockReceiptInput) {
  return withReceiptStorage(key, (storage) => {
    const existing = readReceiptRequest(storage, key);
    if (existing) return existing;
    storage.setItem(key, JSON.stringify(command));
    return command;
  });
}

export function clearReceiptRequest(key: string, command: StockReceiptInput) {
  return withReceiptStorage(key, (storage) => {
    if (readReceiptRequest(storage, key)?.idempotencyKey === command.idempotencyKey)
      storage.removeItem(key);
  });
}
