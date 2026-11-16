import { expect, test } from "bun:test";
import {
  CLIENT_CSV_MAX_BYTES,
  clientImportInputSchema,
  clientImportPreviewInputSchema,
} from "./client-transfer";

test("CSV requests count UTF-8 bytes as well as characters", () => {
  expect(
    clientImportPreviewInputSchema.safeParse({ csv: "á".repeat(CLIENT_CSV_MAX_BYTES / 2 + 1) })
      .success,
  ).toBe(false);
});
test("import commits require reviewed terms and a bounded explicit unique row selection", () => {
  const input = {
    csv: "name,email\nNora,nora@example.com",
    reviewHash: "a".repeat(64),
    idempotencyKey: "0198f5a0-7b1c-7000-8000-0000000000a1",
    rows: [2],
  };
  expect(clientImportInputSchema.safeParse(input).success).toBe(true);
  for (const change of [
    { rows: [] },
    { rows: [2, 2] },
    { rows: [502] },
    { reviewHash: "old" },
    { idempotencyKey: "invalid" },
    { marketingConsent: true },
  ])
    expect(clientImportInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
});
