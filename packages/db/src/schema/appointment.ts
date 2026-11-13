import { sql } from "drizzle-orm";
import { check, index, integer, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { clientProfile } from "./client";
import { createdAt, deletedAt, primaryId, timestamptz, updatedAt } from "./helpers";
import { service } from "./service";
import { staffProfile } from "./staff";

export const appointmentStatus = pgEnum("appointment_status", [
  "booked",
  "completed",
  "cancelled",
  "no_show",
]);

/**
 * `ends_at` already includes the buffer of every booked service (see ADR 0002), so the
 * exclusion constraint in the hand-written migration protects the whole blocked window.
 * The constraint itself is not expressible in Drizzle: see drizzle/*_appointment_no_overlap.sql.
 */
export const appointment = pgTable(
  "appointment",
  {
    id: primaryId(),
    staffId: uuid()
      .notNull()
      .references(() => staffProfile.id),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    startsAt: timestamptz().notNull(),
    endsAt: timestamptz().notNull(),
    status: appointmentStatus().notNull().default("booked"),
    notes: text(),
    /** Optimistic-concurrency counter, incremented on every update. */
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    check("appointment_ends_after_starts", sql`${t.endsAt} > ${t.startsAt}`),
    index("appointment_staff_starts_idx").on(t.staffId, t.startsAt),
    index("appointment_client_idx").on(t.clientId),
  ],
);

/** Snapshot of each booked service so later catalog edits do not rewrite history. */
export const appointmentService = pgTable(
  "appointment_service",
  {
    id: primaryId(),
    appointmentId: uuid()
      .notNull()
      .references(() => appointment.id, { onDelete: "cascade" }),
    serviceId: uuid().references(() => service.id, { onDelete: "set null" }),
    position: integer().notNull(),
    name: text().notNull(),
    durationMinutes: integer().notNull(),
    bufferMinutes: integer().notNull(),
    priceCents: integer().notNull(),
    currency: text().notNull(),
  },
  (t) => [index("appointment_service_appointment_idx").on(t.appointmentId)],
);
