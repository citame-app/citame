import { afterEach, expect, test } from "bun:test";
import { createTranslator } from "~/i18n";
import { printableGiftVoucher } from "./gift-voucher";

afterEach(() => {
  document.body.replaceChildren();
});
test("printed gift voucher contains the selected code and value as text without cloning other financial data", () => {
  document.body.innerHTML = "<aside>Private register balance</aside>";
  const voucher = printableGiftVoucher(
    document,
    {
      label: '<img src=x onerror="bad()">',
      amountCents: 2000,
      availableCents: 1500,
      currency: "EUR",
      status: "active",
      expiresAt: null,
    },
    "SOB-ABCD-1234-ABCD-1234-ABCD-1234",
    "en",
    createTranslator("en"),
    "Europe/Madrid",
  );
  expect(voucher.textContent).toContain("SOB-ABCD-1234");
  expect(voucher.textContent).toContain("€15");
  expect(voucher.querySelector("img")).toBeNull();
  expect(voucher.textContent).not.toContain("Private register balance");
});
