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

test("printed rewards preserve redeemed and returned points and render coupon names as text", () => {
  const id = "0198f5a0-7b1c-7000-8000-000000000100";
  for (const kind of ["points", "promotion"] as const) {
    const sale = checkoutSchema.parse({
      id,
      appointmentId: null,
      clientId: id,
      currency: "EUR",
      status: "partially_refunded",
      subtotalCents: 2500,
      discountCents: 1000,
      tipCents: 0,
      taxCents: 0,
      totalCents: 1500,
      paidCents: 1500,
      refundedCents: 750,
      balanceCents: 0,
      lines: [
        {
          id,
          kind: "custom",
          description: "Treatment",
          quantity: 1,
          unitAmountCents: 2500,
          taxBasisPoints: 0,
        },
      ],
      payments: [],
      createdAt: "2026-11-01T12:00:00.000Z",
      reward: {
        id,
        kind,
        name: '<svg onload="alert(1)">',
        code: kind === "promotion" ? "WELCOME10" : null,
        pointsUsed: kind === "points" ? 100 : 0,
        returnedPoints: kind === "points" ? 50 : 0,
        discountCents: 1000,
        state: "applied",
        expiresAt: "2026-11-01T12:30:00.000Z",
      },
    });
    const printed = printableReceipt(document, sale, "en", createTranslator("en"));
    if (kind === "points") {
      expect(printed.textContent).toContain("Points used: 100");
      expect(printed.textContent).toContain("Points returned: 50");
    } else {
      expect(printed.textContent).toContain("WELCOME10");
      expect(printed.textContent).toContain(sale.reward?.name ?? "");
    }
    expect(printed.querySelector("svg, script, form, input")).toBeNull();
  }
});
