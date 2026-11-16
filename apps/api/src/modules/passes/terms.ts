import { createHash } from "node:crypto";
/** Immutable allocation per visit; the first remainder visits receive one extra cent. */
export function allocatedUnits(amountCents: number, includedUses: number): number[] {
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents < 1 ||
    amountCents > 999999999 ||
    !Number.isInteger(includedUses) ||
    includedUses < 0 ||
    includedUses > 1000 ||
    amountCents < includedUses
  )
    throw new RangeError("Invalid prepaid visit allocation");
  if (includedUses === 0) return [];
  const base = Math.floor(amountCents / includedUses);
  const extra = amountCents % includedUses;
  return Array.from({ length: includedUses }, (_, index) => base + (index < extra ? 1 : 0));
}
export function membershipCycle(
  anchor: Date,
  timezone: string,
  periodMonths: number,
  index: number,
) {
  if (
    !Number.isInteger(periodMonths) ||
    periodMonths < 1 ||
    periodMonths > 12 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > 10000
  )
    throw new RangeError("Invalid membership cycle");
  const original = Temporal.Instant.from(anchor.toISOString()).toZonedDateTimeISO(timezone);
  return {
    startsAt: new Date(original.add({ months: periodMonths * index }).epochMilliseconds),
    endsAt: new Date(original.add({ months: periodMonths * (index + 1) }).epochMilliseconds),
  };
}
export function packageExpiry(paidAt: Date, timezone: string, validityDays: number | null) {
  if (validityDays === null) return null;
  if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 3650)
    throw new RangeError("Invalid package validity");
  return new Date(
    Temporal.Instant.from(paidAt.toISOString())
      .toZonedDateTimeISO(timezone)
      .add({ days: validityDays }).epochMilliseconds,
  );
}
/** The first live cycle at now, retaining the original end-of-month/local-time anchor. */
export function currentMembershipIndex(
  anchor: Date,
  timezone: string,
  periodMonths: number,
  minimum: number,
  now: Date,
) {
  const origin = Temporal.Instant.from(anchor.toISOString()).toZonedDateTimeISO(timezone);
  const current = Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(timezone);
  let index = Math.max(
    minimum,
    Math.floor(((current.year - origin.year) * 12 + current.month - origin.month) / periodMonths),
  );
  if (index > minimum && membershipCycle(anchor, timezone, periodMonths, index).startsAt > now)
    index--;
  return index;
}

export function membershipTermsHash(value: {
  name: string;
  priceCents: number;
  taxBasisPoints: number;
  includedUses: number;
  discountBasisPoints: number;
  serviceIds: string[];
  periodMonths: number | null;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: value.name,
        priceCents: value.priceCents,
        taxBasisPoints: value.taxBasisPoints,
        includedUses: value.includedUses,
        discountBasisPoints: value.discountBasisPoints,
        serviceIds: value.serviceIds,
        periodMonths: value.periodMonths,
      }),
    )
    .digest("hex");
}
