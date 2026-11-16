import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { appointment } from "./appointment";
import { user } from "./auth";
import { checkout, checkoutRefund } from "./commerce";
import { createdAt, primaryId, timestamptz, updatedAt } from "./helpers";

export type BookingPolicyTerms = {
  enabled: boolean;
  depositKind: "percent" | "fixed";
  depositValue: number;
  holdMinutes: number;
  cancellationWindowMinutes: number;
  lateCancellationBasisPoints: number;
  noShowBasisPoints: number;
  trustedExempt: boolean;
};
export const bookingPolicy = pgTable(
  "booking_policy",
  {
    id: integer().primaryKey().default(1),
    terms: jsonb().$type<BookingPolicyTerms>().notNull(),
    version: integer().notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [check("booking_policy_singleton", sql`${t.id} = 1 and ${t.version} > 0`)],
);
export const bookingProtection = pgTable(
  "booking_protection",
  {
    appointmentId: uuid()
      .primaryKey()
      .references(() => appointment.id),
    checkoutId: uuid()
      .notNull()
      .unique()
      .references(() => checkout.id),
    state: text()
      .$type<
        "pending" | "confirmed" | "waived" | "completed" | "cancelled" | "expired" | "no_show"
      >()
      .notNull(),
    terms: jsonb().$type<BookingPolicyTerms>().notNull(),
    policyVersion: integer().notNull(),
    depositCents: integer().notNull(),
    feeCents: integer().notNull().default(0),
    expiresAt: timestamptz().notNull(),
    cancellationCutoff: timestamptz().notNull(),
    acceptedBy: text().references(() => user.id, { onDelete: "set null" }),
    acceptedAt: timestamptz(),
    waiverReason: text(),
    finalisedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "booking_protection_money_valid",
      sql`${t.depositCents} between 0 and 999999999 and ${t.feeCents} between 0 and ${t.depositCents}`,
    ),
    check(
      "booking_protection_state_valid",
      sql`${t.state} in ('pending','confirmed','waived','completed','cancelled','expired','no_show')`,
    ),
    index("booking_protection_expiry_idx").on(t.state, t.expiresAt),
  ],
);
export const bookingFeeMovement = pgTable(
  "booking_fee_movement",
  {
    id: primaryId(),
    appointmentId: uuid()
      .notNull()
      .references(() => appointment.id),
    checkoutId: uuid()
      .notNull()
      .references(() => checkout.id),
    refundId: uuid()
      .unique()
      .references(() => checkoutRefund.id),
    amountCents: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("booking_fee_movement_checkout_idx").on(t.checkoutId),
    check("booking_fee_movement_nonzero", sql`${t.amountCents} <> 0`),
  ],
);
