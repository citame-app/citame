import { randomBytes, randomInt } from "node:crypto";
import { MEMBERSHIP_RECURRING_CONSENT_VERSION } from "@sob/contracts";
import {
  checkoutLine,
  checkoutPayment,
  clientProfile,
  type Database,
  passContract,
  passMandate,
  passPeriod,
  service,
  user,
} from "@sob/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import type { AppConfig } from "../../config";
import { openMandate } from "../../payments/mandate-vault";
import { recurringSettings } from "../../payments/recurring-settings";
import type { PaymentGateway, RecurringPaymentSettings } from "../../payments/types";
import { settleVerifiedBankPayment } from "../commerce/service";
import { intentHash } from "./catalog";
import { createPassPeriodInvoice } from "./service";
import { membershipTermsHash } from "./terms";

async function claimRenewal(db: Database, settings: RecurringPaymentSettings, now: Date) {
  return db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(passContract)
      .where(
        and(
          eq(passContract.kind, "membership"),
          eq(passContract.status, "active"),
          eq(passContract.renewalMode, "automatic"),
          eq(passContract.autoPayReady, true),
          eq(passContract.cancelAtPeriodEnd, false),
          isNotNull(passContract.consent),
          sql`exists(select 1 from pass_period pp where pp.contract_id=${passContract.id} and pp.status='active' and pp.ends_at<=${now} and not exists(select 1 from pass_period newer where newer.contract_id=pp.contract_id and newer."index">pp."index"))`,
        ),
      )
      .orderBy(asc(passContract.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!contract) return null;
    const [last] = await tx
      .select()
      .from(passPeriod)
      .where(eq(passPeriod.contractId, contract.id))
      .orderBy(desc(passPeriod.index))
      .limit(1);
    if (last?.status !== "active" || !last.endsAt || last.endsAt > now || !contract.consent)
      return { unavailable: true as const };
    const [payer] = await tx
      .select()
      .from(clientProfile)
      .where(eq(clientProfile.id, contract.clientId));
    const [account] = payer?.userId
      ? await tx.select({ role: user.role }).from(user).where(eq(user.id, payer.userId))
      : [];
    const eligibleServices = await tx
      .select({ id: service.id })
      .from(service)
      .where(
        and(
          inArray(service.id, contract.serviceIds),
          eq(service.active, true),
          eq(service.currency, "EUR"),
          isNull(service.deletedAt),
        ),
      );
    if (
      eligibleServices.length !== contract.serviceIds.length ||
      account?.role !== "client" ||
      !payer?.userId ||
      payer.deletedAt ||
      payer.bookingAccess === "blocked" ||
      contract.consent.version !== MEMBERSHIP_RECURRING_CONSENT_VERSION ||
      contract.consent.actorUserId !== payer.userId ||
      contract.consent.termsHash !== membershipTermsHash(contract)
    ) {
      await tx
        .update(passContract)
        .set({ autoPayReady: false, version: contract.version + 1 })
        .where(eq(passContract.id, contract.id));
      await recordAudit(tx, {
        actorUserId: null,
        action: "membership.billing_requires_review",
        entity: "pass_contract",
        entityId: contract.id,
        metadata: { reason: "payer_agreement_or_services_unavailable" },
      });
      return { unavailable: true as const };
    }
    const [mandate] = await tx
      .select()
      .from(passMandate)
      .where(and(eq(passMandate.contractId, contract.id), isNull(passMandate.revokedAt)))
      .for("update");
    let reference: ReturnType<typeof openMandate>;
    try {
      if (
        !mandate?.encryptedPayload ||
        mandate.merchantCode !== settings.merchantCode ||
        mandate.terminal !== settings.terminal ||
        mandate.environment !== settings.environment ||
        mandate.currency !== "EUR"
      )
        throw new Error();
      reference = openMandate(
        settings.encryptionKey,
        {
          contractId: contract.id,
          merchantCode: settings.merchantCode,
          terminal: settings.terminal,
          environment: settings.environment,
          currency: "EUR",
        },
        mandate.encryptedPayload,
      );
      const month = Temporal.Instant.from(now.toISOString())
        .toZonedDateTimeISO("Europe/Madrid")
        .toPlainDate()
        .toString()
        .slice(2, 7)
        .replace("-", "");
      if (reference.expiry < month) throw new Error();
    } catch {
      await tx
        .update(passContract)
        .set({ autoPayReady: false, version: contract.version + 1 })
        .where(eq(passContract.id, contract.id));
      await recordAudit(tx, {
        actorUserId: null,
        action: "membership.mandate_unavailable",
        entity: "pass_contract",
        entityId: contract.id,
        metadata: { reason: "reference_unavailable_or_expired" },
      });
      return { unavailable: true as const };
    }
    if (!mandate) throw new Error("Missing claimed mandate");
    const period = await createPassPeriodInvoice(tx, contract, last.index + 1, null);
    const [line] = await tx
      .select({ checkoutId: checkoutLine.checkoutId })
      .from(checkoutLine)
      .where(eq(checkoutLine.passPeriodId, period.id));
    if (!line) throw new Error("Missing renewal invoice");
    let payment: typeof checkoutPayment.$inferSelect | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const order = `${randomInt(1000, 10000)}${randomBytes(4).toString("hex")}`;
      [payment] = await tx
        .insert(checkoutPayment)
        .values({
          checkoutId: line.checkoutId,
          method: "redsys_card",
          status: "pending",
          amountCents: period.priceCents,
          bankOrder: order,
          merchantInitiated: true,
          recurringMandateId: mandate.id,
          idempotencyKey: `auto-${period.id}`,
          requestHash: intentHash({
            periodId: period.id,
            mandateId: mandate.id,
            amountCents: period.priceCents,
            merchantInitiated: true,
          }),
          createdBy: null,
        })
        .onConflictDoNothing()
        .returning();
      if (payment) break;
    }
    if (!payment?.bankOrder) throw new Error("Could not reserve recurring bank order");
    await recordAudit(tx, {
      actorUserId: null,
      action: "membership.billing_dispatch_claimed",
      entity: "pass_contract",
      entityId: contract.id,
      metadata: { periodId: period.id, paymentId: payment.id, amountCents: payment.amountCents },
    });
    return {
      unavailable: false as const,
      contractId: contract.id,
      mandateId: mandate.id,
      encryptedPayload: mandate.encryptedPayload,
      payment,
      reference,
    };
  });
}
/** Claims commit before HTTP. A pending period prevents every subsequent automatic dispatch. */
export async function runMembershipBilling({
  db,
  config,
  gateway,
  now = () => new Date(),
  continueRunning = () => true,
}: {
  db: Database;
  config: AppConfig;
  gateway: PaymentGateway | null;
  now?: () => Date;
  continueRunning?: () => boolean;
}) {
  const result = { claimed: 0, succeeded: 0, declined: 0, uncertain: 0 };
  const settings = recurringSettings(config, gateway);
  if (!settings || !gateway?.chargeRecurring) return result;
  for (let index = 0; index < 10 && continueRunning(); index++) {
    const claim = await claimRenewal(db, settings, now());
    if (!claim) break;
    if (claim.unavailable) continue;
    result.claimed++;
    try {
      const bank = await gateway.chargeRecurring({
        order: claim.payment.bankOrder ?? "",
        amountCents: claim.payment.amountCents,
        currency: "EUR",
        mandate: claim.reference,
      });
      if (
        bank.order !== claim.payment.bankOrder ||
        bank.amountCents !== claim.payment.amountCents ||
        bank.currency !== "EUR" ||
        bank.transactionType !== "0"
      )
        throw new Error("Unexpected bank result");
      await settleVerifiedBankPayment(db, bank, settings);
      if (bank.success) result.succeeded++;
      else {
        result.declined++;
        await db.transaction(async (tx) => {
          const [contract] = await tx
            .select()
            .from(passContract)
            .where(eq(passContract.id, claim.contractId))
            .for("update");
          const [mandate] = await tx
            .select()
            .from(passMandate)
            .where(eq(passMandate.id, claim.mandateId));
          if (contract && mandate?.encryptedPayload === claim.encryptedPayload)
            await tx
              .update(passContract)
              .set({ autoPayReady: false, version: contract.version + 1 })
              .where(eq(passContract.id, contract.id));
        });
      }
    } catch {
      // Capture may have completed. Preserve the durable pending order and require callback/portal reconciliation.
      result.uncertain++;
    }
  }
  return result;
}
