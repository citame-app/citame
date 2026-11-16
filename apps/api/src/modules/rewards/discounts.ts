import type { ApplyRewardInput, RewardChoice } from "@sob/contracts";
import {
  appointment,
  bookingProtection,
  checkout,
  checkoutLine,
  checkoutPayment,
  checkoutReward,
  checkoutRewardLot,
  loyaltyLot,
  loyaltyMovement,
  promotion,
} from "@sob/db";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { allocateDiscount } from "../commerce/money";
import { getCheckoutInTransaction, refreshStatus, saleRow } from "../commerce/service";
import { heldProducts } from "../inventory/reservations";
import { getSalonSettings } from "../settings/service";
import {
  availableRewardLots,
  getLoyaltyPolicy,
  lockRewardClient,
  type RewardConnection,
  rewardBalance,
  rewardHash,
} from "./accounts";
import { appointmentMatchesPromotionTiming } from "./timing";

const ordinary = (kind: string) => ["service", "product", "custom"].includes(kind);
export async function checkoutRewardView(db: RewardConnection, checkoutId: string) {
  const [r] = await db
    .select()
    .from(checkoutReward)
    .where(eq(checkoutReward.checkoutId, checkoutId));
  return r
    ? {
        id: r.id,
        kind: r.kind,
        name: r.name,
        code: r.code,
        pointsUsed: r.pointsUsed,
        returnedPoints: r.returnedPoints,
        discountCents: r.discountCents,
        state: r.state,
        expiresAt: r.expiresAt.toISOString(),
        ...(r.appointmentTiming ? { appointmentTiming: r.appointmentTiming } : {}),
      }
    : null;
}
export async function assertRewardPayment(
  tx: Tx,
  sale: typeof checkout.$inferSelect,
  method: string,
  now = new Date(),
) {
  // A booked visit reserves its benefit until completion/cancellation; counter sales expire.
  const [r] = await tx.select().from(checkoutReward).where(eq(checkoutReward.checkoutId, sale.id));
  if (!r || r.state === "released") return;
  if (["package", "membership"].includes(method))
    throw new DomainError(
      "invalid_state",
      "Choose a reward discount or a prepaid visit; a full visit cannot realize both savings",
    );
  if (sale.appointmentId || r.state !== "held" || r.expiresAt > now) return;
  const funded = await tx
    .select({ id: checkoutPayment.id })
    .from(checkoutPayment)
    .where(and(eq(checkoutPayment.checkoutId, sale.id), sql`${checkoutPayment.status} <> 'failed'`))
    .limit(1);
  if (!funded.length)
    throw new DomainError(
      "invalid_state",
      "The reward reservation expired; create another receipt",
    );
}
export type RewardPricingLine = Pick<
  typeof checkoutLine.$inferSelect,
  "id" | "kind" | "quantity" | "unitAmountCents" | "discountCents" | "serviceId" | "taxBasisPoints"
>;
export async function rewardPricing(
  tx: Tx,
  row: Pick<
    typeof checkout.$inferSelect,
    "id" | "clientId" | "status" | "fulfilledAt" | "appointmentId" | "totalCents" | "tipCents"
  >,
  choice: RewardChoice,
  now: Date,
  lock = false,
  booking?: {
    lines: RewardPricingLine[];
    visit: { startsAt: Date; createdAt: Date };
    timeZone: string;
  },
) {
  if (!row.clientId || row.status !== "open" || row.fulfilledAt)
    throw new DomainError("invalid_state", "Rewards need an open customer receipt");
  const attempts = booking
    ? []
    : await tx
        .select({ id: checkoutPayment.id })
        .from(checkoutPayment)
        .where(eq(checkoutPayment.checkoutId, row.id))
        .limit(1);
  const previous = booking
    ? []
    : await tx
        .select({ id: checkoutReward.id })
        .from(checkoutReward)
        .where(eq(checkoutReward.checkoutId, row.id))
        .limit(1);
  if (attempts.length || previous.length)
    throw new DomainError("invalid_state", "Apply a reward once before any payment attempt");
  const lines =
    booking?.lines ??
    (await tx
      .select()
      .from(checkoutLine)
      .where(eq(checkoutLine.checkoutId, row.id))
      .orderBy(asc(checkoutLine.createdAt), asc(checkoutLine.id)));
  let eligible = lines.filter((l) => ordinary(l.kind));
  const extra = new Map<string, number>();
  let promo: typeof promotion.$inferSelect | undefined;
  let name = "Loyalty points";
  let maximumPoints = 0;
  let policyVersion: number | null = null;
  let appointmentTiming: typeof checkoutReward.$inferInsert.appointmentTiming = null;
  if (choice.kind === "points") {
    const policy = await getLoyaltyPolicy(tx);
    if (!policy.enabled) throw new DomainError("invalid_state", "Loyalty redemption is disabled");
    const base = eligible.reduce(
      (sum, l) => sum + l.quantity * l.unitAmountCents - l.discountCents,
      0,
    );
    const available = await rewardBalance(tx, row.clientId, now);
    maximumPoints = Math.min(
      1000000000,
      available.availablePoints,
      Math.floor(
        Math.floor((base * policy.maximumDiscountBasisPoints) / 10000) / policy.redeemValueCents,
      ),
    );
    if (choice.points > maximumPoints)
      throw new DomainError(
        "invalid_state",
        "Insufficient points or redemption exceeds the program limit",
      );
    const amount = choice.points * policy.redeemValueCents;
    const parts = allocateDiscount(
      eligible.map((l) => l.quantity * l.unitAmountCents - l.discountCents),
      amount,
    );
    for (const [i, line] of eligible.entries()) extra.set(line.id, parts[i] ?? 0);
    policyVersion = policy.version;
  } else {
    const query = tx.select().from(promotion).where(eq(promotion.code, choice.code));
    [promo] = await (lock ? query.for("update") : query);
    if (
      !promo?.terms.active ||
      (promo.terms.startsAt && new Date(promo.terms.startsAt) > now) ||
      (promo.terms.endsAt && new Date(promo.terms.endsAt) <= now)
    )
      throw new DomainError("invalid_state", "This promotion is unavailable");
    const terms = promo.terms;
    if (terms.timing) {
      const [storedVisit] = row.appointmentId
        ? await tx.select().from(appointment).where(eq(appointment.id, row.appointmentId))
        : [];
      const timezone = booking?.timeZone ?? (await getSalonSettings(tx)).timezone;
      if (
        !appointmentMatchesPromotionTiming(
          terms.timing,
          booking?.visit ?? storedVisit ?? null,
          timezone,
        )
      )
        throw new DomainError(
          "promotion_timing_mismatch",
          "This appointment does not meet the promotion's local start or booking lead conditions",
        );
      appointmentTiming = { timing: terms.timing, timeZone: timezone };
    }
    eligible = eligible.filter(
      (l) =>
        terms.eligibleKinds.includes(l.kind as "service" | "product" | "custom") &&
        (l.kind !== "service" ||
          !terms.serviceIds.length ||
          (l.serviceId && terms.serviceIds.includes(l.serviceId))),
    );
    const base = eligible.reduce(
      (sum, l) => sum + l.quantity * l.unitAmountCents - l.discountCents,
      0,
    );
    if (!eligible.length || base < terms.minimumSpendCents)
      throw new DomainError(
        "invalid_state",
        "The receipt does not meet this promotion's conditions",
      );
    const [usage] = await tx
      .select({
        total: count(),
        own: sql<number>`count(*) filter (where ${checkoutReward.clientId} in(select client_identity_ids(${row.clientId}::uuid)))::int`,
      })
      .from(checkoutReward)
      .where(
        and(
          eq(checkoutReward.promotionId, promo.id),
          inArray(checkoutReward.state, ["held", "applied"]),
        ),
      );
    if (
      (terms.usageLimit !== null && (usage?.total ?? 0) >= terms.usageLimit) ||
      (terms.perClientLimit !== null && (usage?.own ?? 0) >= terms.perClientLimit)
    )
      throw new DomainError("invalid_state", "This promotion's usage limit has been reached");
    const gross = eligible.map((l) => l.quantity * l.unitAmountCents);
    const grossTotal = gross.reduce((a, b) => a + b, 0);
    const offerTotal = Math.min(
      terms.maximumDiscountCents ?? grossTotal,
      terms.kind === "fixed" ? terms.value : Math.floor((grossTotal * terms.value) / 10000),
    );
    const parts = allocateDiscount(gross, Math.min(offerTotal, grossTotal));
    for (const [i, line] of eligible.entries())
      extra.set(line.id, Math.max(0, (parts[i] ?? 0) - line.discountCents));
    name = promo.name;
  }
  const discountCents = [...extra.values()].reduce((sum, n) => sum + n, 0);
  if (discountCents < 1 || discountCents > row.totalCents - row.tipCents)
    throw new DomainError("invalid_state", "This reward provides no additional eligible discount");
  return {
    lines,
    extra,
    promo,
    policyVersion,
    appointmentTiming,
    quote: {
      name,
      kind: choice.kind,
      pointsUsed: choice.kind === "points" ? choice.points : 0,
      maximumPoints,
      discountCents,
      currentTotalCents: row.totalCents,
      newTotalCents: row.totalCents - discountCents,
      ...(appointmentTiming && promo ? { appointmentTiming, promotionVersion: promo.version } : {}),
    },
  };
}
export async function quoteCheckoutReward(
  tx: Tx,
  id: string,
  input: RewardChoice,
  principal: Principal,
) {
  const row = await saleRow(tx, id, principal);
  return (await rewardPricing(tx, row, input, new Date())).quote;
}
export async function applyCheckoutReward(
  tx: Tx,
  id: string,
  input: ApplyRewardInput,
  principal: Principal,
  now = new Date(),
  options: { deferFulfillment?: boolean } = {},
) {
  const row = await saleRow(tx, id, principal, true);
  if (!row.clientId) throw new DomainError("invalid_state", "A reward needs a customer account");
  const requestHash = rewardHash(input);
  const [prior] = await tx.select().from(checkoutReward).where(eq(checkoutReward.checkoutId, id));
  if (prior) {
    if (prior.idempotencyKey !== input.idempotencyKey || prior.requestHash !== requestHash)
      throw new DomainError("invalid_state", "This receipt already has a reward");
    return getCheckoutInTransaction(tx, id, principal);
  }
  // Keep the settlement lock order if the discount makes a retail receipt free.
  await heldProducts(tx, row.id);
  await lockRewardClient(tx, row.clientId);
  if (row.totalCents !== input.expectedTotalCents)
    throw new DomainError(
      "version_conflict",
      "Receipt total changed; review the reward quote again",
    );
  const choice: RewardChoice =
    input.kind === "points"
      ? { kind: "points", points: input.points }
      : { kind: "promotion", code: input.code };
  const priced = await rewardPricing(tx, row, choice, now, true);
  if (
    priced.appointmentTiming &&
    input.kind === "promotion" &&
    input.expectedPromotionVersion !== priced.promo?.version
  )
    throw new DomainError(
      "version_conflict",
      "Promotion conditions changed; review the quote again",
    );
  if (priced.quote.discountCents !== input.expectedDiscountCents)
    throw new DomainError("version_conflict", "Reward terms changed; review the discount again");
  const [reward] = await tx
    .insert(checkoutReward)
    .values({
      checkoutId: id,
      clientId: row.clientId,
      kind: input.kind,
      name: priced.quote.name,
      code: priced.promo?.code ?? null,
      promotionId: priced.promo?.id,
      pointsUsed: priced.quote.pointsUsed,
      discountCents: priced.quote.discountCents,
      policyVersion: priced.policyVersion,
      appointmentTiming: priced.appointmentTiming,
      expiresAt: new Date(now.getTime() + 30 * 60000),
      idempotencyKey: input.idempotencyKey,
      requestHash,
      createdBy: principal.userId,
    })
    .returning();
  if (!reward) throw new Error("Reward reservation insert failed");
  if (input.kind === "points") {
    let needed = input.points;
    for (const lot of await availableRewardLots(tx, row.clientId, now)) {
      const n = Math.min(needed, lot.remainingPoints);
      await tx
        .update(loyaltyLot)
        .set({ remainingPoints: lot.remainingPoints - n, spentPoints: lot.spentPoints + n })
        .where(eq(loyaltyLot.id, lot.id));
      await tx.insert(checkoutRewardLot).values({ rewardId: reward.id, lotId: lot.id, points: n });
      needed -= n;
      if (!needed) break;
    }
    if (needed)
      throw new DomainError("invalid_state", "The points balance changed; request another quote");
    await tx.insert(loyaltyMovement).values({
      clientId: row.clientId,
      checkoutId: id,
      kind: "redemption",
      points: -input.points,
      eventKey: `reward:${reward.id}`,
      createdBy: principal.userId,
    });
  }
  let taxCents = 0;
  for (const line of priced.lines) {
    const discountCents = line.discountCents + (priced.extra.get(line.id) ?? 0);
    const tax = Math.round(
      ((line.quantity * line.unitAmountCents - discountCents) * line.taxBasisPoints) /
        (10000 + line.taxBasisPoints),
    );
    taxCents += tax;
    if (discountCents !== line.discountCents)
      await tx
        .update(checkoutLine)
        .set({ discountCents, taxCents: tax })
        .where(eq(checkoutLine.id, line.id));
  }
  await tx
    .update(checkout)
    .set({
      discountCents: row.discountCents + priced.quote.discountCents,
      totalCents: priced.quote.newTotalCents,
      taxCents,
      ...(options.deferFulfillment && priced.quote.newTotalCents === 0
        ? { status: "paid" as const }
        : {}),
    })
    .where(eq(checkout.id, id));
  const [protectedBooking] = await tx
    .select()
    .from(bookingProtection)
    .where(eq(bookingProtection.checkoutId, id));
  if (protectedBooking && protectedBooking.state === "pending") {
    const terms = protectedBooking.terms;
    const depositCents = Math.min(
      priced.quote.newTotalCents,
      terms.depositKind === "fixed"
        ? terms.depositValue
        : Math.max(1, Math.ceil((priced.quote.newTotalCents * terms.depositValue) / 10000)),
    );
    await tx
      .update(bookingProtection)
      .set({ depositCents })
      .where(eq(bookingProtection.checkoutId, id));
  }
  await recordAudit(tx, {
    actorUserId: principal.userId,
    action: "rewards.applied",
    entity: "checkout",
    entityId: id,
    metadata: {
      rewardId: reward.id,
      kind: input.kind,
      points: priced.quote.pointsUsed,
      discountCents: priced.quote.discountCents,
    },
  });
  if (!options.deferFulfillment) await refreshStatus(tx, id, now);
  return getCheckoutInTransaction(tx, id, principal);
}
