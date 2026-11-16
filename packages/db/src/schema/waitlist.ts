import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
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
import { staffProfile } from "./staff";

type Policy = { enabled: boolean; offerMinutes: number };
type BookingTerms = {
  enabled: boolean;
  depositKind: "fixed" | "percent";
  depositValue: number;
  holdMinutes: number;
  cancellationWindowMinutes: number;
  lateCancellationBasisPoints: number;
  noShowBasisPoints: number;
  trustedExempt: boolean;
  version: number;
};
type ServiceSnapshot = {
  id: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  priceCents: number;
  currency: string;
};
export const waitlistPolicy = pgTable(
  "waitlist_policy",
  {
    id: integer().primaryKey().default(1),
    terms: jsonb().$type<Policy>().notNull(),
    version: integer().notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [check("waitlist_policy_singleton", sql`${t.id}=1 and ${t.version}>0`)],
);
export const waitlistEntry = pgTable(
  "waitlist_entry",
  {
    id: primaryId(),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    staffId: uuid().references(() => staffProfile.id),
    serviceIds: uuid().array().notNull(),
    serviceNames: text().array().notNull(),
    fromDate: date().notNull(),
    toDate: date().notNull(),
    fromTime: text().notNull(),
    toTime: text().notNull(),
    timezone: text().notNull(),
    state: text()
      .$type<"waiting" | "offered" | "booked" | "cancelled" | "expired" | "unavailable">()
      .notNull()
      .default("waiting"),
    version: integer().notNull().default(1),
    selectionHash: text().notNull(),
    requestHash: text().notNull(),
    createdBy: text()
      .notNull()
      .references(() => user.id),
    idempotencyKey: text().notNull(),
    notBefore: timestamptz().notNull(),
    lastScannedAt: timestamptz(),
    appointmentId: uuid().references(() => appointment.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("waitlist_entry_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    uniqueIndex("waitlist_entry_active_selection_unique")
      .on(t.clientId, t.selectionHash)
      .where(sql`${t.state} in ('waiting','offered')`),
    index("waitlist_entry_customer_idx").on(t.clientId, t.createdAt),
    index("waitlist_entry_pending_idx")
      .on(t.lastScannedAt, t.createdAt)
      .where(sql`${t.state}='waiting'`),
    check(
      "waitlist_entry_valid",
      sql`${t.version}>0 and ${t.state} in ('waiting','offered','booked','cancelled','expired','unavailable') and ${t.toDate}>=${t.fromDate} and ${t.toDate}-${t.fromDate}<30 and ${t.fromTime}~'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.toTime}~'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.fromTime}<${t.toTime} and cardinality(${t.serviceIds}) between 1 and 8`,
    ),
  ],
);
export const waitlistOffer = pgTable(
  "waitlist_offer",
  {
    id: primaryId(),
    entryId: uuid()
      .notNull()
      .references(() => waitlistEntry.id),
    staffId: uuid()
      .notNull()
      .references(() => staffProfile.id),
    startsAt: timestamptz().notNull(),
    endsAt: timestamptz().notNull(),
    expiresAt: timestamptz().notNull(),
    state: text()
      .$type<"offered" | "accepted" | "expired" | "declined" | "cancelled">()
      .notNull()
      .default("offered"),
    workWindows: jsonb().$type<{ offsetMinutes: number; endOffsetMinutes: number }[]>(),
    services: jsonb().$type<ServiceSnapshot[]>().notNull(),
    policy: jsonb().$type<BookingTerms>().notNull(),
    catalogHash: text().notNull(),
    priceCents: integer().notNull(),
    currency: text().notNull(),
    acceptedBy: text().references(() => user.id),
    acceptKey: text(),
    acceptHash: text(),
    appointmentId: uuid().references(() => appointment.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("waitlist_offer_active_entry_unique")
      .on(t.entryId)
      .where(sql`${t.state}='offered'`),
    index("waitlist_offer_expiry_idx").on(t.expiresAt).where(sql`${t.state}='offered'`),
    index("waitlist_offer_staff_time_idx").on(t.staffId, t.startsAt),
    check(
      "waitlist_offer_valid",
      sql`${t.endsAt}>${t.startsAt} and ${t.expiresAt}<=${t.startsAt} and ${t.priceCents} between 0 and 999999999 and ${t.state} in ('offered','accepted','expired','declined','cancelled')`,
    ),
  ],
);
