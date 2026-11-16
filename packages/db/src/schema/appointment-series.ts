import { sql } from "drizzle-orm";
import { check, integer, pgTable, primaryKey, text, unique, uuid } from "drizzle-orm/pg-core";
import { appointment } from "./appointment";
import { user } from "./auth";
import { clientProfile } from "./client";
import { createdAt, primaryId } from "./helpers";
import { staffProfile } from "./staff";

export const appointmentSeries = pgTable(
  "appointment_series",
  {
    id: primaryId(),
    clientId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    staffId: uuid()
      .notNull()
      .references(() => staffProfile.id),
    timezone: text().notNull(),
    cadence: text().$type<"weekly" | "monthly">().notNull(),
    interval: integer().notNull(),
    occurrenceCount: integer().notNull(),
    createdBy: text()
      .notNull()
      .references(() => user.id),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("appointment_series_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    check(
      "appointment_series_terms_valid",
      sql`${t.cadence} in ('weekly','monthly') and ${t.interval} between 1 and 12 and ${t.occurrenceCount} between 2 and 12`,
    ),
  ],
);
export const appointmentSeriesVisit = pgTable(
  "appointment_series_visit",
  {
    seriesId: uuid()
      .notNull()
      .references(() => appointmentSeries.id),
    position: integer().notNull(),
    appointmentId: uuid()
      .notNull()
      .unique()
      .references(() => appointment.id),
  },
  (t) => [
    primaryKey({ columns: [t.seriesId, t.position] }),
    check("appointment_series_position_valid", sql`${t.position} between 0 and 11`),
  ],
);
