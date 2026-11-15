import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appointment } from "./appointment";
import { user } from "./auth";
import { clientProfile } from "./client";
import { createdAt, primaryId, timestamptz, updatedAt } from "./helpers";

export const checkoutStatus = pgEnum("checkout_status", [
  "open",
  "paid",
  "partially_refunded",
  "refunded",
  "void",
]);
export const paymentStatus = pgEnum("payment_status", [
  "pending",
  "succeeded",
  "failed",
  "reconciliation",
]);
export const refundStatus = pgEnum("refund_status", [
  "requested",
  "dispatched",
  "succeeded",
  "failed",
  "reconciliation",
]);
export const paymentMethod = pgEnum("payment_method", [
  "cash",
  "external_card",
  "redsys_card",
  "redsys_bizum",
  "gift_card",
]);
export const checkout = pgTable(
  "checkout",
  {
    id: primaryId(),
    appointmentId: uuid().references(() => appointment.id),
    clientId: uuid().references(() => clientProfile.id),
    currency: text().notNull().default("EUR"),
    status: checkoutStatus().notNull().default("open"),
    subtotalCents: integer().notNull(),
    discountCents: integer().notNull().default(0),
    tipCents: integer().notNull().default(0),
    taxCents: integer().notNull().default(0),
    totalCents: integer().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("checkout_actor_idempotency_unique").on(t.createdBy, t.idempotencyKey),
    unique("checkout_appointment_unique").on(t.appointmentId),
    index("checkout_client_idx").on(t.clientId),
    index("checkout_created_idx").on(t.createdAt),
    check(
      "checkout_money_valid",
      sql`${t.currency} = 'EUR' and ${t.subtotalCents} >= 0 and ${t.discountCents} between 0 and ${t.subtotalCents} and ${t.tipCents} >= 0 and ${t.taxCents} >= 0 and ${t.totalCents} = ${t.subtotalCents} - ${t.discountCents} + ${t.tipCents} and ${t.totalCents} <= 999999999`,
    ),
  ],
);
export const checkoutLine = pgTable(
  "checkout_line",
  {
    id: primaryId(),
    checkoutId: uuid()
      .notNull()
      .references(() => checkout.id),
    kind: text().notNull(),
    productId: uuid(),
    serviceId: uuid(),
    description: text().notNull(),
    quantity: integer().notNull(),
    unitAmountCents: integer().notNull(),
    taxBasisPoints: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("checkout_line_checkout_idx").on(t.checkoutId),
    check(
      "checkout_line_valid",
      sql`${t.quantity} between 1 and 1000 and ${t.unitAmountCents} between 0 and 999999999 and ${t.taxBasisPoints} between 0 and 10000`,
    ),
  ],
);
export const cashSession = pgTable(
  "cash_session",
  {
    id: primaryId(),
    openingCents: integer().notNull(),
    openedBy: text().references(() => user.id, { onDelete: "set null" }),
    openedAt: createdAt(),
    closedBy: text().references(() => user.id, { onDelete: "set null" }),
    closedAt: timestamptz(),
    countedCents: integer(),
    expectedCents: integer(),
  },
  (t) => [
    uniqueIndex("cash_session_one_open").on(sql`(true)`).where(sql`${t.closedAt} is null`),
    check(
      "cash_session_nonnegative",
      sql`${t.openingCents} >= 0 and (${t.countedCents} is null or ${t.countedCents} >= 0)`,
    ),
  ],
);
export const checkoutPayment = pgTable(
  "checkout_payment",
  {
    id: primaryId(),
    checkoutId: uuid()
      .notNull()
      .references(() => checkout.id),
    method: paymentMethod().notNull(),
    status: paymentStatus().notNull().default("pending"),
    amountCents: integer().notNull(),
    currency: text().notNull().default("EUR"),
    bankOrder: text().unique(),
    bankResponse: text(),
    authorizationCode: text(),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    cashSessionId: uuid().references(() => cashSession.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("checkout_payment_idempotency_unique").on(t.checkoutId, t.idempotencyKey),
    index("checkout_payment_checkout_idx").on(t.checkoutId),
    check(
      "checkout_payment_money_valid",
      sql`${t.amountCents} between 1 and 999999999 and ${t.currency} = 'EUR'`,
    ),
  ],
);
export const checkoutRefund = pgTable(
  "checkout_refund",
  {
    id: primaryId(),
    paymentId: uuid()
      .notNull()
      .references(() => checkoutPayment.id),
    amountCents: integer().notNull(),
    status: refundStatus().notNull().default("requested"),
    reason: text().notNull(),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("checkout_refund_idempotency_unique").on(t.paymentId, t.idempotencyKey),
    index("checkout_refund_payment_idx").on(t.paymentId),
    check("checkout_refund_amount_positive", sql`${t.amountCents} between 1 and 999999999`),
  ],
);
export const cashMovement = pgTable(
  "cash_movement",
  {
    id: primaryId(),
    sessionId: uuid()
      .notNull()
      .references(() => cashSession.id),
    amountCents: integer().notNull(),
    kind: text().notNull(),
    reason: text().notNull(),
    paymentId: uuid().references(() => checkoutPayment.id),
    refundId: uuid().references(() => checkoutRefund.id),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("cash_movement_idempotency_unique").on(t.sessionId, t.idempotencyKey),
    unique("cash_movement_payment_unique").on(t.paymentId),
    unique("cash_movement_refund_unique").on(t.refundId),
    check("cash_movement_nonzero", sql`${t.amountCents} <> 0`),
  ],
);
