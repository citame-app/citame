import type { BookingPromotionQuoteRequest, CreateAppointmentRequest } from "@sob/contracts";
import { needsFinalPrice } from "@sob/contracts";
import type { Database } from "@sob/db";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { assertStaffPerforms } from "../appointments/service";
import { createCheckoutInTransaction } from "../commerce/service";
import { membershipDiscounts } from "../passes/value";
import { getBookableServices } from "../services/service";
import { getSalonSettings } from "../settings/service";
import { assertStaffExists } from "../staff/service";
import { rewardHash } from "./accounts";
import { BOOKING_PROMOTION_KEY_PREFIX } from "./booking-attribution";
import { applyCheckoutReward, type RewardPricingLine, rewardPricing } from "./discounts";

async function quoteInTransaction(
  tx: Tx,
  input: BookingPromotionQuoteRequest,
  principal: Principal,
  now: Date,
  lock = false,
) {
  const p = await loadPrincipal(tx, principal.userId);
  if (p?.role !== "client" || !p.clientId)
    throw new DomainError("forbidden", "A customer booking account is required");
  const services = await getBookableServices(tx, input.serviceIds, input.serviceQuotes);
  if (services.some((s) => needsFinalPrice(s.priceType)))
    throw new DomainError(
      "invalid_state",
      "Apply promotions in checkout after the final price has been set",
    );
  if (services.some((s) => s.currency !== "EUR"))
    throw new DomainError("validation_error", "Booking promotions require EUR services");
  await assertStaffExists(tx, input.staffId);
  await assertStaffPerforms(
    tx,
    input.staffId,
    services.map((s) => s.id),
    lock,
  );
  const { timezone } = await getSalonSettings(tx);
  const source = services.map((s) => ({
    kind: "service",
    serviceId: s.id,
    quantity: 1,
    unitAmountCents: s.priceCents,
  }));
  const discounts = await membershipDiscounts(
    tx,
    p.clientId,
    undefined,
    source,
    new Date(input.startsAt),
  );
  const lines: RewardPricingLine[] = services.map((s, index) => ({
    id: s.id,
    kind: "service",
    serviceId: s.id,
    quantity: 1,
    unitAmountCents: s.priceCents,
    discountCents: discounts[index]?.amountCents ?? 0,
    taxBasisPoints: 0,
  }));
  const subtotalCents = services.reduce((sum, s) => sum + s.priceCents, 0);
  if (subtotalCents > 999999999)
    throw new DomainError("validation_error", "The booking total exceeds the supported amount");
  const totalCents = subtotalCents - lines.reduce((sum, line) => sum + line.discountCents, 0);
  const priced = await rewardPricing(
    tx,
    {
      id: "00000000-0000-4000-8000-000000000000",
      clientId: p.clientId,
      appointmentId: null,
      status: "open",
      fulfilledAt: null,
      totalCents,
      tipCents: 0,
    },
    { kind: "promotion", code: input.code },
    now,
    lock,
    { lines, visit: { startsAt: new Date(input.startsAt), createdAt: now }, timeZone: timezone },
  );
  if (!priced.promo) throw new Error("Missing promotion quote");
  const reviewHash = rewardHash({
    clientId: p.clientId,
    staffId: input.staffId,
    startsAt: new Date(input.startsAt).toISOString(),
    services: services.map((s) => [s.id, s.quoteHash]),
    promotionId: priced.promo.id,
    promotionVersion: priced.promo.version,
    timezone,
    lines: lines.map((line) => [
      line.id,
      line.unitAmountCents,
      line.discountCents,
      priced.extra.get(line.id),
    ]),
    totalCents: priced.quote.newTotalCents,
  });
  return {
    ...priced.quote,
    promotionVersion: priced.promo.version,
    subtotalCents,
    currency: "EUR" as const,
    reviewHash,
  };
}
export async function quoteBookingPromotion(
  db: Database,
  input: BookingPromotionQuoteRequest,
  principal: Principal,
  now: Date,
) {
  return db.transaction((tx) => quoteInTransaction(tx, input, principal, now), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
/** Called within creation, after client/calendar locks; every write rolls back with the visit. */
export async function applyBookingPromotion(
  tx: Tx,
  booking: { id: string; clientId: string },
  input: CreateAppointmentRequest,
  actorUserId: string | undefined,
  now: Date,
) {
  if (!input.promotion) return;
  const p = actorUserId ? await loadPrincipal(tx, actorUserId) : null;
  if (p?.role !== "client" || p.clientId !== booking.clientId)
    throw new DomainError(
      "forbidden",
      "Review the promotion from the customer's own booking account",
    );
  if (!input.serviceQuotes)
    throw new DomainError("version_conflict", "Review the current service prices and promotion");
  const quote = await quoteInTransaction(
    tx,
    {
      code: input.promotion.code,
      staffId: input.staffId,
      serviceIds: input.serviceIds,
      serviceQuotes: input.serviceQuotes,
      startsAt: input.startsAt,
    },
    p,
    now,
    true,
  ).catch((error: unknown) => {
    if (
      error instanceof DomainError &&
      (error.code === "invalid_state" || error.code === "promotion_timing_mismatch")
    )
      throw new DomainError(
        "booking_promotion_changed",
        "This offer is no longer available for the reviewed booking; review or remove it explicitly",
      );
    throw error;
  });
  if (quote.reviewHash !== input.promotion.reviewHash)
    throw new DomainError(
      "booking_promotion_changed",
      "Booking promotion terms changed; review the current offer",
    );
  const idempotencyKey = `${BOOKING_PROMOTION_KEY_PREFIX}${booking.id}`;
  const sale = await createCheckoutInTransaction(
    tx,
    {
      appointmentId: booking.id,
      currency: "EUR",
      lines: [],
      discountCents: 0,
      tipCents: 0,
      idempotencyKey,
    },
    p,
  );
  await applyCheckoutReward(
    tx,
    sale.id,
    {
      kind: "promotion",
      code: input.promotion.code,
      expectedPromotionVersion: quote.promotionVersion,
      expectedTotalCents: quote.currentTotalCents,
      expectedDiscountCents: quote.discountCents,
      idempotencyKey,
    },
    p,
    now,
    { deferFulfillment: true },
  );
}
