import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
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
 * `ends_at` includes processing and cleanup. Frozen work windows feed internal staff reservations;
 * migration0037 protects active professional intervals, not the full client-presence span.
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
    workWindows: jsonb().$type<{ offsetMinutes: number; endOffsetMinutes: number }[]>(),
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
    processingStartMinutes: integer(),
    processingMinutes: integer(),
    priceCents: integer().notNull(),
    currency: text().notNull(),
  },
  (t) => [
    index("appointment_service_appointment_idx").on(t.appointmentId),
    check(
      "appointment_service_processing_valid",
      sql`(${t.processingStartMinutes} is null and ${t.processingMinutes} is null) or (${t.processingStartMinutes} is not null and ${t.processingMinutes} is not null and ${t.processingStartMinutes}>0 and ${t.processingMinutes}>0 and ${t.processingStartMinutes}+${t.processingMinutes}<${t.durationMinutes})`,
    ),
  ],
);
