import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { clientProfile } from "./client";
import { checkout } from "./commerce";
import { createdAt, primaryId, timestamptz, updatedAt } from "./helpers";
export type LoyaltyTerms = {
  enabled: boolean;
  earnEveryCents: number;
  pointsPerStep: number;
  redeemValueCents: number;
  maximumDiscountBasisPoints: number;
  expiryDays: number | null;
};
export const loyaltyProgram = pgTable(
  "loyalty_program",
  {
    id: integer().primaryKey().default(1),
    terms: jsonb().$type<LoyaltyTerms>().notNull(),
    version: integer().notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [check("loyalty_program_singleton", sql`${t.id}=1 and ${t.version}>0`)],
);
export const loyaltyLot = pgTable(
  "loyalty_lot",
  {
    id: primaryId(),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    checkoutId: uuid()
      .unique()
      .references(() => checkout.id),
    grantedPoints: integer().notNull(),
    remainingPoints: integer().notNull(),
    spentPoints: integer().notNull().default(0),
    expiredPoints: integer().notNull().default(0),
    revokedUnusedPoints: integer().notNull().default(0),
    revokedSpentPoints: integer().notNull().default(0),
    basisCents: bigint({ mode: "number" }).notNull().default(0),
    expiresAt: timestamptz(),
    policyVersion: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("loyalty_lot_client_idx").on(t.clientId),
    check(
      "loyalty_lot_conservation",
      sql`${t.grantedPoints} between 1 and 1000000000 and ${t.remainingPoints}>=0 and ${t.spentPoints}>=0 and ${t.expiredPoints}>=0 and ${t.revokedUnusedPoints}>=0 and ${t.revokedSpentPoints} between 0 and ${t.spentPoints} and ${t.grantedPoints}=${t.remainingPoints}+${t.spentPoints}+${t.expiredPoints}+${t.revokedUnusedPoints} and ${t.revokedUnusedPoints}+${t.revokedSpentPoints}<=${t.grantedPoints} and ${t.basisCents}>=0`,
    ),
  ],
);
export const loyaltyMovement = pgTable(
  "loyalty_movement",
  {
    id: primaryId(),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    lotId: uuid().references(() => loyaltyLot.id),
    checkoutId: uuid().references(() => checkout.id),
    kind: text().notNull(),
    points: integer().notNull(),
    reason: text(),
    eventKey: text().notNull().unique(),
    requestHash: text(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("loyalty_movement_client_idx").on(t.clientId, t.createdAt),
    check("loyalty_movement_nonzero", sql`${t.points} <> 0`),
  ],
);
export type PromotionTerms = {
  kind: "percent" | "fixed";
  value: number;
  minimumSpendCents: number;
  maximumDiscountCents: number | null;
  usageLimit: number | null;
  perClientLimit: number | null;
  startsAt: string | null;
  endsAt: string | null;
  eligibleKinds: ("service" | "product" | "custom")[];
  serviceIds: string[];
  active: boolean;
  timing?: {
    weekdays: number[];
    startMinute: number;
    endMinute: number;
    lastMinuteHours: number | null;
  };
};
export const promotion = pgTable(
  "promotion",
  {
    id: primaryId(),
    code: text().notNull().unique(),
    name: text().notNull(),
    terms: jsonb().$type<PromotionTerms>().notNull(),
    version: integer().notNull().default(1),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("promotion_version_positive", sql`${t.version}>0`)],
);
export const checkoutReward = pgTable(
  "checkout_reward",
  {
    id: primaryId(),
    checkoutId: uuid()
      .notNull()
      .unique()
      .references(() => checkout.id),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    promotionId: uuid().references(() => promotion.id),
    kind: text().$type<"points" | "promotion">().notNull(),
    appointmentTiming: jsonb().$type<{
      timing: NonNullable<PromotionTerms["timing"]>;
      timeZone: string;
    }>(),
    name: text().notNull(),
    code: text(),
    pointsUsed: integer().notNull().default(0),
    returnedPoints: integer().notNull().default(0),
    discountCents: integer().notNull(),
    state: text().$type<"held" | "applied" | "released">().notNull().default("held"),
    expiresAt: timestamptz().notNull(),
    policyVersion: integer(),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("checkout_reward_promotion_idx").on(t.promotionId, t.state),
    index("checkout_reward_expiry_idx").on(t.state, t.expiresAt),
    check(
      "checkout_reward_valid",
      sql`${t.pointsUsed}>=0 and ${t.returnedPoints} between 0 and ${t.pointsUsed} and ${t.discountCents}>0 and ${t.state} in ('held','applied','released') and ((${t.kind}='points' and ${t.pointsUsed}>0 and ${t.promotionId} is null) or (${t.kind}='promotion' and ${t.pointsUsed}=0 and ${t.promotionId} is not null))`,
    ),
  ],
);
export const checkoutRewardLot = pgTable(
  "checkout_reward_lot",
  {
    rewardId: uuid()
      .notNull()
      .references(() => checkoutReward.id),
    lotId: uuid()
      .notNull()
      .references(() => loyaltyLot.id),
    points: integer().notNull(),
    returnedPoints: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.rewardId, t.lotId] }),
    check(
      "checkout_reward_lot_points_positive",
      sql`${t.points}>0 and ${t.returnedPoints} between 0 and ${t.points}`,
    ),
  ],
);
