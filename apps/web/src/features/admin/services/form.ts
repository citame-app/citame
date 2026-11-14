import type { CreateServiceRequest } from "@sob/contracts";

export interface ServiceFormValues {
  name: string;
  description: string;
  durationMinutes: string;
  bufferMinutes: string;
  price: string;
  currency: string;
}

/** Parses a decimal price typed with either "." or "," as decimal mark. Returns cents or null. */
export function parsePrice(input: string): number | null {
  const text = input.trim();
  if (!/^\d[\d.,]*$/.test(text)) return null;
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  const decimalAt = Math.max(lastDot, lastComma);
  let whole = text;
  let fraction = "";
  if (decimalAt !== -1) {
    const after = text.slice(decimalAt + 1);
    const mixed = lastDot !== -1 && lastComma !== -1;
    // "1.234" is a thousands group unless it is the only mark and has 1-2 digits after it.
    const isDecimal = mixed || after.length <= 2;
    if (isDecimal) {
      if (after.length > 2) return null;
      const before = text.slice(0, decimalAt);
      // Several marks of the same kind before the decimal are invalid unless they are groups of 3.
      if (!/^\d{1,3}([.,]\d{3})*$|^\d+$/.test(before)) return null;
      whole = before.replace(/[.,]/g, "");
      fraction = after;
    } else {
      if (!/^\d{1,3}([.,]\d{3})+$/.test(text)) return null;
      whole = text.replace(/[.,]/g, "");
    }
  }
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0") || 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function centsToInput(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export type FieldCode =
  | "required"
  | "positive"
  | "nonNegative"
  | "tooLong"
  | "invalid"
  | "currency";
export type ServiceFormErrors = Partial<Record<keyof ServiceFormValues, FieldCode>>;

const MAX_MINUTES = 24 * 60;

export function validateServiceForm(values: ServiceFormValues): ServiceFormErrors {
  const errors: ServiceFormErrors = {};
  if (values.name.trim().length === 0) errors.name = "required";
  const duration = Number(values.durationMinutes);
  if (!Number.isInteger(duration) || duration <= 0) errors.durationMinutes = "positive";
  else if (duration > MAX_MINUTES) errors.durationMinutes = "tooLong";
  const buffer = Number(values.bufferMinutes === "" ? 0 : values.bufferMinutes);
  if (!Number.isInteger(buffer) || buffer < 0) errors.bufferMinutes = "nonNegative";
  else if (buffer > MAX_MINUTES) errors.bufferMinutes = "tooLong";
  if (parsePrice(values.price) === null) errors.price = "invalid";
  if (!/^[A-Za-z]{3}$/.test(values.currency.trim())) errors.currency = "currency";
  return errors;
}

export function toServiceRequest(
  values: ServiceFormValues,
): CreateServiceRequest & { description: string | null; bufferMinutes: number; currency: string } {
  return {
    name: values.name.trim(),
    description: values.description.trim() === "" ? null : values.description.trim(),
    durationMinutes: Number(values.durationMinutes),
    bufferMinutes: Number(values.bufferMinutes === "" ? 0 : values.bufferMinutes),
    priceCents: parsePrice(values.price) ?? 0,
    currency: values.currency.trim().toUpperCase(),
  };
}
