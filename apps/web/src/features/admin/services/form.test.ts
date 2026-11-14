import { describe, expect, test } from "bun:test";
import { centsToInput, parsePrice, toServiceRequest, validateServiceForm } from "./form";

describe("parsePrice", () => {
  test("accepts dot or comma decimals and thousands separators", () => {
    expect(parsePrice("15000")).toBe(1_500_000);
    expect(parsePrice("12.50")).toBe(1250);
    expect(parsePrice("12,5")).toBe(1250);
    expect(parsePrice("1.234,50")).toBe(123_450);
    expect(parsePrice("1,234.50")).toBe(123_450);
    expect(parsePrice("0")).toBe(0);
    expect(parsePrice("12.345")).toBe(1_234_500); // a lone mark followed by three digits groups thousands
  });

  test("rejects blanks, negatives and junk", () => {
    for (const bad of ["", " ", "-5", "abc", "1.2.3,4", "12.3456", "1.23.4"])
      expect(parsePrice(bad)).toBeNull();
  });
});

describe("centsToInput", () => {
  test("renders cents as an editable decimal", () => {
    expect(centsToInput(1_500_000)).toBe("15000");
    expect(centsToInput(1250)).toBe("12.50");
  });
});

const valid = {
  name: " Haircut ",
  description: "",
  durationMinutes: "45",
  bufferMinutes: "15",
  price: "15000",
  currency: "ARS",
};

describe("validateServiceForm", () => {
  test("a valid form has no errors", () => {
    expect(validateServiceForm(valid)).toEqual({});
  });

  test("flags each invalid field with a stable code", () => {
    expect(
      validateServiceForm({
        ...valid,
        name: "  ",
        durationMinutes: "0",
        bufferMinutes: "-1",
        price: "x",
        currency: "AR",
      }),
    ).toEqual({
      name: "required",
      durationMinutes: "positive",
      bufferMinutes: "nonNegative",
      price: "invalid",
      currency: "currency",
    });
    expect(validateServiceForm({ ...valid, durationMinutes: "2000" }).durationMinutes).toBe(
      "tooLong",
    );
  });
});

describe("toServiceRequest", () => {
  test("produces the contract payload (trimmed, cents, null description)", () => {
    expect(toServiceRequest(valid)).toEqual({
      name: "Haircut",
      description: null,
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: 1_500_000,
      currency: "ARS",
    });
  });
});
