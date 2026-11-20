import type { CheckoutPrices } from "@sob/contracts";
import { checkout, checkoutLine, checkoutPayment, checkoutReward, type Database } from "@sob/db";
import { and, eq, inArray } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { membershipDiscounts } from "../passes/value";
import { getCheckoutInTransaction, refreshStatus, requireOperator, saleRow } from "./service";

/** Only unresolved service lines can be priced. Captured receipts and fixed quotes stay immutable. */
export async function finalizeCheckoutPrices(
  db: Database,
  id: string,
  input: CheckoutPrices,
  p: Principal,
  now: Date,
) {
  requireOperator(p);
  return db.transaction(async (tx) => {
    const sale = await saleRow(tx, id, p, true);
    const current = await loadPrincipal(tx, p.userId);
    if (!current) throw new DomainError("forbidden", "Account unavailable");
    requireOperator(current);
    await saleRow(tx, id, current);
    if (sale.pricingVersion !== input.version)
      throw new DomainError(
        "version_conflict",
        "Receipt prices changed; reload before setting final amounts",
      );
    if (sale.status === "void" || sale.fulfilledAt)
      throw new DomainError("invalid_state", "A fulfilled or void receipt cannot be repriced");
    const lines = await tx.select().from(checkoutLine).where(eq(checkoutLine.checkoutId, id));
    const unresolved = lines.filter((l) => l.pricePending);
    if (
      !unresolved.length ||
      unresolved.length !== input.lines.length ||
      input.lines.some((l) => !unresolved.some((r) => r.id === l.id))
    )
      throw new DomainError(
        "invalid_state",
        "Review all unresolved prices; fixed lines cannot be changed",
      );
    const attempts = await tx
      .select({ id: checkoutPayment.id })
      .from(checkoutPayment)
      .where(
        and(
          eq(checkoutPayment.checkoutId, id),
          inArray(checkoutPayment.status, ["pending", "reconciliation"]),
        ),
      );
    if (attempts.length)
      throw new DomainError(
        "invalid_state",
        "Wait for pending bank operations before fixing the final price",
      );
    const rewards = await tx
      .select({ id: checkoutReward.id })
      .from(checkoutReward)
      .where(eq(checkoutReward.checkoutId, id));
    if (rewards.length)
      throw new DomainError("invalid_state", "Resolve prices before applying a promotion");
    const amounts = new Map(input.lines.map((l) => [l.id, l.unitAmountCents]));
    for (const line of unresolved)
      if ((amounts.get(line.id) ?? -1) < line.minimumUnitAmountCents)
        throw new DomainError(
          "validation_error",
          "The final price cannot be below the advertised minimum",
        );
    const updated = lines.map((l) => ({
      ...l,
      unitAmountCents: amounts.get(l.id) ?? l.unitAmountCents,
    }));
    const discounts = await membershipDiscounts(
      tx,
      sale.clientId,
      sale.appointmentId ?? undefined,
      updated,
    );
    let subtotalCents = 0,
      discountCents = 0,
      taxCents = 0;
    for (const [index, line] of updated.entries()) {
      const gross = line.quantity * line.unitAmountCents;
      const discount = line.pricePending
        ? Math.min(gross, discounts[index]?.amountCents ?? 0)
        : line.discountCents;
      const tax = Math.round(
        ((gross - discount) * line.taxBasisPoints) / (10000 + line.taxBasisPoints),
      );
      subtotalCents += gross;
      discountCents += discount;
      taxCents += tax;
      if (line.pricePending)
        await tx
          .update(checkoutLine)
          .set({
            unitAmountCents: line.unitAmountCents,
            pricePending: false,
            discountCents: discount,
            taxCents: tax,
            membershipPeriodId: discount ? (discounts[index]?.periodId ?? null) : null,
          })
          .where(eq(checkoutLine.id, line.id));
    }
    const totalCents = subtotalCents - discountCents + sale.tipCents;
    if (
      !Number.isSafeInteger(totalCents) ||
      totalCents < 0 ||
      totalCents > 999999999 ||
      subtotalCents > 2147483647
    )
      throw new DomainError("validation_error", "The reviewed receipt total is out of range");
    await tx
      .update(checkout)
      .set({
        subtotalCents,
        discountCents,
        taxCents,
        totalCents,
        pricingVersion: sale.pricingVersion + 1,
        status: "open",
      })
      .where(eq(checkout.id, id));
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "commerce.prices_finalized",
      entity: "checkout",
      entityId: id,
      metadata: { version: sale.pricingVersion + 1, lines: input.lines, totalCents },
    });
    await refreshStatus(tx, id, now);
    return getCheckoutInTransaction(tx, id, p);
  });
}
