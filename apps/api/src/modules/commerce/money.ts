import type { checkoutPayment } from "@sob/db";

export const recordedPaymentStatuses: ReadonlyArray<typeof checkoutPayment.$inferSelect.status> = [
  "succeeded",
  "reconciliation",
];
export const completedRefundStatus = "succeeded";

/** Integer floor of a*b/divisor without floating-point loss of minor currency units. */
export function multiplyDivide(a: number, b: number, divisor: number): number {
  if (![a, b, divisor].every(Number.isSafeInteger) || a < 0 || b < 0 || divisor <= 0)
    throw new RangeError("Invalid money ratio");
  const result = (BigInt(a) * BigInt(b)) / BigInt(divisor);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Money ratio overflow");
  return Number(result);
}
/** Sequential proportional allocation keeps every discount within its line's gross. */
export function allocateDiscount(gross: number[], discount: number): number[] {
  let remainingGross = gross.reduce((sum, value) => sum + value, 0);
  if (
    !gross.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !Number.isSafeInteger(remainingGross) ||
    !Number.isSafeInteger(discount) ||
    discount < 0 ||
    discount > remainingGross
  )
    throw new RangeError("Invalid discount allocation");
  let remaining = discount;
  return gross.map((value) => {
    const allocated = remainingGross === 0 ? 0 : multiplyDivide(remaining, value, remainingGross);
    remaining -= allocated;
    remainingGross -= value;
    return allocated;
  });
}
