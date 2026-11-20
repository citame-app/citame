import { expect, test } from "bun:test";
import { createTranslator } from "~/i18n";
import { priceLabel, totalPriceLabel } from "./service-price";

const t = createTranslator("en");
const fixed = { priceCents: 3000, currency: "EUR" };
test("Booksy price types distinguish a pending amount, a minimum, a hidden price and a free service", () => {
  expect(priceLabel(t, "en", { ...fixed, priceType: "variable", priceCents: 0 })).toBe(
    "Price varies",
  );
  expect(priceLabel(t, "en", { ...fixed, priceType: "from" })).toBe("From €30");
  expect(priceLabel(t, "en", { ...fixed, priceType: "hidden" })).toBe("Price on confirmation");
  expect(priceLabel(t, "en", { ...fixed, priceType: "hidden" }, true)).toBe("€30");
  expect(priceLabel(t, "en", { ...fixed, priceType: "free", priceCents: 0 })).toBe("Free");
  expect(totalPriceLabel(t, "en", [{ ...fixed, priceType: "variable" }], 3000, "EUR")).toBe(
    "Final price at the salon",
  );
});
