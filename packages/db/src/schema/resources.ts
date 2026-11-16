import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appointment } from "./appointment";
import { user } from "./auth";
import { createdAt, primaryId, timestamptz, updatedAt } from "./helpers";
import { service } from "./service";
import { waitlistOffer } from "./waitlist";
export const resourcePool = pgTable(
  "resource_pool",
  {
    id: primaryId(),
    name: text().notNull(),
    kind: text().$type<"room" | "equipment" | "station" | "other">().notNull(),
    capacity: integer().notNull(),
    active: boolean().notNull().default(true),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
  },
  (t) => [
    unique("resource_pool_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    uniqueIndex("resource_pool_active_name_unique")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.active}`),
    check(
      "resource_pool_valid",
      sql`${t.capacity} between 1 and 20 and ${t.version}>0 and ${t.kind} in ('room','equipment','station','other') and length(${t.name}) between 1 and 80`,
    ),
  ],
);
export const serviceResource = pgTable(
  "service_resource",
  {
    id: primaryId(),
    serviceId: uuid()
      .notNull()
      .references(() => service.id),
    resourceId: uuid()
      .notNull()
      .references(() => resourcePool.id),
    quantity: integer().notNull(),
  },
  (t) => [
    unique("service_resource_unique").on(t.serviceId, t.resourceId),
    check("service_resource_quantity_valid", sql`${t.quantity} between 1 and 20`),
  ],
);
/** The deferred exclusion constraint and owner-window triggers live in the SQL migration. */
export const resourceReservation = pgTable(
  "resource_reservation",
  {
    id: primaryId(),
    resourceId: uuid()
      .notNull()
      .references(() => resourcePool.id),
    appointmentId: uuid().references(() => appointment.id),
    offerId: uuid().references(() => waitlistOffer.id),
    servicePosition: integer().notNull(),
    unitIndex: integer().notNull(),
    offsetMinutes: integer().notNull(),
    endOffsetMinutes: integer().notNull(),
    startsAt: timestamptz().notNull(),
    endsAt: timestamptz().notNull(),
    name: text().notNull(),
    active: boolean().notNull().default(true),
    released: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    check("resource_reservation_release_owner", sql`not ${t.released} or ${t.offerId} is not null`),
    index("resource_reservation_appointment_idx").on(t.appointmentId),
    index("resource_reservation_offer_idx").on(t.offerId),
    index("resource_reservation_pool_time_idx")
      .on(t.resourceId, t.startsAt)
      .where(sql`${t.active}`),
    check(
      "resource_reservation_valid",
      sql`num_nonnulls(${t.appointmentId},${t.offerId})=1 and ${t.servicePosition}>=0 and ${t.unitIndex} between 0 and 19 and ${t.offsetMinutes}>=0 and ${t.endOffsetMinutes}>${t.offsetMinutes} and ${t.endOffsetMinutes}<=100000 and ${t.endsAt}>${t.startsAt}`,
    ),
  ],
);
