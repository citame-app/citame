import {
  type checkout,
  checkoutLine,
  type checkoutPayment,
  passContract,
  passMandate,
  passPeriod,
} from "@sob/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { recordAudit } from "../../audit";
import type { Principal } from "../../auth/principal";
import type { MandateReference } from "../../payments/mandate-types";
import { sealMandate } from "../../payments/mandate-vault";
import type { RecurringPaymentSettings } from "../../payments/types";
import type { Tx } from "../../tx";
export async function needsCardMandate(
  tx: Tx,
  sale: typeof checkout.$inferSelect,
  amountCents: number,
  p: Principal,
) {
  if (p.role !== "client") return false;
  const [row] = await tx
    .select({ contract: passContract, period: passPeriod })
    .from(checkoutLine)
    .innerJoin(passPeriod, eq(passPeriod.id, checkoutLine.passPeriodId))
    .innerJoin(passContract, eq(passContract.id, passPeriod.contractId))
    .where(eq(checkoutLine.checkoutId, sale.id));
  return Boolean(
    row &&
      row.contract.clientId === p.clientId &&
      row.contract.kind === "membership" &&
      row.contract.renewalMode === "automatic" &&
      !row.contract.cancelAtPeriodEnd &&
      row.contract.consent &&
      row.period.priceCents === amountCents &&
      sale.totalCents === amountCents,
  );
}
export async function storeCardMandate(
  tx: Tx,
  saleId: string,
  payment: typeof checkoutPayment.$inferSelect,
  reference: MandateReference,
  settings: RecurringPaymentSettings,
) {
  if (!payment.mandateRequested || payment.method !== "redsys_card") return;
  const [row] = await tx
    .select({ contract: passContract, period: passPeriod })
    .from(checkoutLine)
    .innerJoin(passPeriod, eq(passPeriod.id, checkoutLine.passPeriodId))
    .innerJoin(passContract, eq(passContract.id, passPeriod.contractId))
    .where(and(eq(checkoutLine.checkoutId, saleId), isNotNull(checkoutLine.passPeriodId)));
  if (
    row?.contract.kind !== "membership" ||
    row.contract.renewalMode !== "automatic" ||
    row.contract.cancelAtPeriodEnd ||
    !row.contract.consent ||
    row.period.status !== "active" ||
    row.period.priceCents !== payment.amountCents
  )
    return;
  const binding = {
    contractId: row.contract.id,
    merchantCode: settings.merchantCode,
    terminal: settings.terminal,
    environment: settings.environment,
    currency: "EUR" as const,
  };
  let encryptedPayload: string;
  try {
    encryptedPayload = sealMandate(settings.encryptionKey, binding, reference);
  } catch {
    await recordAudit(tx, {
      actorUserId: null,
      action: "membership.mandate_unavailable",
      entity: "pass_contract",
      entityId: row.contract.id,
      metadata: { reason: "reference_encryption_unavailable" },
    });
    return;
  }
  await tx
    .insert(passMandate)
    .values({ ...binding, encryptedPayload, expiry: reference.expiry, last4: reference.last4 })
    .onConflictDoUpdate({
      target: passMandate.contractId,
      set: {
        merchantCode: binding.merchantCode,
        terminal: binding.terminal,
        environment: binding.environment,
        currency: "EUR",
        encryptedPayload,
        expiry: reference.expiry,
        last4: reference.last4,
        revokedAt: null,
      },
    });
  await tx
    .update(passContract)
    .set({ autoPayReady: true, version: row.contract.version + 1 })
    .where(eq(passContract.id, row.contract.id));
  await recordAudit(tx, {
    actorUserId: payment.createdBy,
    action: "membership.mandate_recorded",
    entity: "pass_contract",
    entityId: row.contract.id,
    metadata: { paymentId: payment.id },
  });
}
export async function revokeCardMandate(tx: Tx, id: string) {
  await tx
    .update(passMandate)
    .set({ encryptedPayload: null, revokedAt: new Date() })
    .where(eq(passMandate.contractId, id));
}
