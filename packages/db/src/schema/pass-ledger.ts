import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { checkout, checkoutLine, checkoutPayment, checkoutRefund } from "./commerce";
import { createdAt, primaryId, timestamptz } from "./helpers";
import { passPeriod } from "./pass";
export const passUnit = pgTable(
  "pass_unit",
  {
    id: primaryId(),
    periodId: uuid()
      .notNull()
      .references(() => passPeriod.id),
    ordinal: integer().notNull(),
    allocatedCents: integer().notNull(),
    taxCents: integer().notNull(),
    status: text().notNull().default("available"),
    paymentId: uuid().references(() => checkoutPayment.id),
    refundId: uuid().references(() => checkoutRefund.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("pass_unit_period_ordinal_unique").on(t.periodId, t.ordinal),
    check(
      "pass_unit_valid",
      sql`${t.status} in ('available','used','held','retired') and ${t.ordinal}>=0 and ${t.allocatedCents} between 1 and 999999999 and ${t.taxCents} between 0 and ${t.allocatedCents}`,
    ),
  ],
);
export const passRedemption = pgTable(
  "pass_redemption",
  {
    id: primaryId(),
    unitId: uuid()
      .notNull()
      .references(() => passUnit.id),
    periodId: uuid()
      .notNull()
      .references(() => passPeriod.id),
    checkoutId: uuid()
      .notNull()
      .references(() => checkout.id),
    checkoutLineId: uuid()
      .notNull()
      .references(() => checkoutLine.id),
    paymentId: uuid()
      .notNull()
      .references(() => checkoutPayment.id)
      .unique(),
    amountCents: integer().notNull(),
    allocatedCents: integer().notNull(),
    taxCents: integer().notNull(),
    refundedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    index("pass_redemption_line_idx").on(t.checkoutLineId),
    index("pass_redemption_period_idx").on(t.periodId),
    check(
      "pass_redemption_money_valid",
      sql`${t.amountCents}>0 and ${t.allocatedCents}>0 and ${t.taxCents} between 0 and ${t.allocatedCents}`,
    ),
  ],
);
export const passRefundAllocation = pgTable(
  "pass_refund_allocation",
  {
    id: primaryId(),
    periodId: uuid()
      .notNull()
      .references(() => passPeriod.id),
    refundId: uuid()
      .notNull()
      .references(() => checkoutRefund.id)
      .unique(),
    unitIds: uuid().array().notNull(),
    excessCents: integer().notNull(),
    status: text().notNull().default("held"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "pass_refund_allocation_valid",
      sql`${t.excessCents}>=0 and ${t.status} in ('held','applied','released')`,
    ),
  ],
);
