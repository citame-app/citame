import { sql } from "drizzle-orm";
import { check, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { appointment } from "./appointment";
import { user } from "./auth";
import { clientProfile } from "./client";
import { createdAt } from "./helpers";

/** An atomic, ordered visit; each treatment retains its own calendar and financial history. */
export const appointmentVisit = pgTable("appointment_visit", {
  id: uuid().primaryKey(),
  clientId: uuid()
    .notNull()
    .references(() => clientProfile.id),
  createdBy: text()
    .notNull()
    .references(() => user.id),
  requestHash: text().notNull(),
  createdAt: createdAt(),
});
export const appointmentVisitPart = pgTable(
  "appointment_visit_part",
  {
    visitId: uuid()
      .notNull()
      .references(() => appointmentVisit.id),
    position: integer().notNull(),
    appointmentId: uuid()
      .notNull()
      .unique()
      .references(() => appointment.id),
  },
  (t) => [
    primaryKey({ columns: [t.visitId, t.position] }),
    check("appointment_visit_position_valid", sql`${t.position} between 0 and 7`),
  ],
);
