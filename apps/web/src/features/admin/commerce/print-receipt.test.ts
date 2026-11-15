import { expect, test } from "bun:test";
import { checkoutSchema } from "@sob/contracts";
import { createTranslator } from "~/i18n";
import { printableReceipt } from "./print-receipt";

test("the printed receipt contains only the selected sale and escapes user text", () => {
  const id = "0198f5a0-7b1c-7000-8000-000000000100";
  const sale = checkoutSchema.parse({
    id,
    appointmentId: null,
    clientId: null,
    currency: "EUR",
    status: "paid",
    subtotalCents: 2500,
    discountCents: 0,
    tipCents: 0,
    taxCents: 0,
    totalCents: 2500,
    paidCents: 2500,
    refundedCents: 0,
    balanceCents: 0,
    lines: [
      {
        id,
        kind: "custom",
        description: '<img src="x" onerror="alert(1)">',
        quantity: 1,
        unitAmountCents: 2500,
        taxBasisPoints: 0,
      },
    ],
    payments: [],
    createdAt: "2026-03-09T12:00:00.000Z",
  });
  const result = printableReceipt(document, sale, "en", createTranslator("en"));
  expect(result.textContent).toContain(sale.lines[0]?.description ?? "");
  expect(result.textContent).toContain(id);
  expect(result.textContent).toContain("€25");
  expect(result.querySelector("img")).toBeNull();
  expect(result.querySelector("form, input, button, script")).toBeNull();
  expect(result.textContent).not.toContain("Cash register");
  expect(result.textContent).not.toContain("Refund payment");
});
