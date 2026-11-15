import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { checkout, checkoutLine } from "./commerce";
import { createdAt, primaryId, updatedAt } from "./helpers";
import { staffProfile } from "./staff";
export const commissionPolicy = pgTable(
  "commission_policy",
  {
    staffId: uuid()
      .primaryKey()
      .references(() => staffProfile.id),
    serviceBasisPoints: integer().notNull(),
    productBasisPoints: integer().notNull(),
    version: integer().notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "commission_policy_rates_valid",
      sql`${t.serviceBasisPoints} between 0 and 10000 and ${t.productBasisPoints} between 0 and 10000 and ${t.version} > 0`,
    ),
  ],
);
export const commissionAccrual = pgTable(
  "commission_accrual",
  {
    id: primaryId(),
    staffId: uuid()
      .notNull()
      .references(() => staffProfile.id),
    checkoutId: uuid()
      .notNull()
      .references(() => checkout.id),
    checkoutLineId: uuid()
      .notNull()
      .references(() => checkoutLine.id)
      .unique(),
    basisCents: integer().notNull(),
    rateBasisPoints: integer().notNull(),
    earnedCents: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("commission_accrual_staff_created_idx").on(t.staffId, t.createdAt),
    check(
      "commission_accrual_money_valid",
      sql`${t.basisCents} between 0 and 999999999 and ${t.rateBasisPoints} between 0 and 10000 and ${t.earnedCents} between 0 and ${t.basisCents}`,
    ),
  ],
);
export const commissionPayout = pgTable(
  "commission_payout",
  {
    id: primaryId(),
    staffId: uuid()
      .notNull()
      .references(() => staffProfile.id),
    amountCents: integer().notNull(),
    reference: text().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("commission_payout_staff_key_unique").on(t.staffId, t.idempotencyKey),
    index("commission_payout_staff_created_idx").on(t.staffId, t.createdAt),
    check("commission_payout_positive", sql`${t.amountCents} between 1 and 999999999`),
  ],
);
