import { expect, test } from "bun:test";
import { openMandate, sealMandate } from "./mandate-vault";

const key = Buffer.alloc(32, 7).toString("base64");
const binding = {
  contractId: "0198f5a0-7b1c-7000-8000-000000000100",
  merchantCode: "999008881",
  terminal: "001",
  environment: "test" as const,
  currency: "EUR" as const,
};
const token = {
  reference: "120c14ed9f7264383434fc1154559f1e2bcc2b1c",
  transactionId: "2006031152000",
  expiry: "3412",
  last4: "0003",
};
test("opaque references are encrypted with distinct nonces and bound to the exact contract and merchant", () => {
  const first = sealMandate(key, binding, token);
  const second = sealMandate(key, binding, token);
  expect(first).not.toBe(second);
  expect(first).not.toContain(token.reference);
  expect(openMandate(key, binding, first)).toEqual(token);
  for (const context of [
    { ...binding, contractId: crypto.randomUUID() },
    { ...binding, merchantCode: "999008882" },
    { ...binding, terminal: "002" },
    { ...binding, environment: "live" as const },
  ])
    expect(() => openMandate(key, context, first)).toThrow("Payment reference unavailable");
});
test("malformed keys, tampered ciphertext and unsupported token data fail without reflecting secrets", () => {
  expect(() => sealMandate("not-a-key", binding, token)).toThrow(
    "Payment encryption key unavailable",
  );
  const ciphertext = sealMandate(key, binding, token);
  expect(() => openMandate(Buffer.alloc(32, 8).toString("base64"), binding, ciphertext)).toThrow(
    "Payment reference unavailable",
  );
  expect(() => openMandate(key, binding, `${ciphertext.slice(0, -3)}xyz`)).toThrow(
    "Payment reference unavailable",
  );
  expect(() => sealMandate(key, binding, { ...token, reference: "<private bank token>" })).toThrow(
    "Invalid payment reference",
  );
});
