import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { checkout, checkoutPayment, checkoutRefund } from "./commerce";
import { giftCard } from "./gift-card";
import { createdAt, primaryId } from "./helpers";
export const giftCardMovement = pgTable(
  "gift_card_movement",
  {
    id: primaryId(),
    giftCardId: uuid()
      .notNull()
      .references(() => giftCard.id),
    checkoutId: uuid()
      .notNull()
      .references(() => checkout.id),
    paymentId: uuid().references(() => checkoutPayment.id),
    refundId: uuid().references(() => checkoutRefund.id),
    kind: text().notNull(),
    amountCents: integer().notNull(),
    eventKey: text().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("gift_card_movement_event_unique").on(t.giftCardId, t.eventKey),
    index("gift_card_movement_created_idx").on(t.giftCardId, t.createdAt),
    check(
      "gift_card_movement_kind_valid",
      sql`${t.kind} in ('activation', 'redemption', 'redemption_refund', 'purchase_refund', 'purchase_refund_reversal')`,
    ),
    check(
      "gift_card_movement_amount_valid",
      sql`${t.amountCents} between -999999999 and 999999999 and ${t.amountCents} <> 0`,
    ),
  ],
);
