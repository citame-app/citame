import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { appointment } from "./appointment";
import { primaryId, timestamptz } from "./helpers";
import { staffProfile } from "./staff";
import { waitlistOffer } from "./waitlist";
/** Internal interchangeable capacity slots. SQL owner triggers and a deferred GiST constraint are authoritative. */
export const staffReservation = pgTable(
  "staff_reservation",
  {
    id: primaryId(),
    staffId: uuid()
      .notNull()
      .references(() => staffProfile.id),
    appointmentId: uuid().references(() => appointment.id, { onDelete: "cascade" }),
    offerId: uuid().references(() => waitlistOffer.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    unitIndex: integer().notNull(),
    offsetMinutes: integer().notNull(),
    endOffsetMinutes: integer(),
    startsAt: timestamptz().notNull(),
    endsAt: timestamptz().notNull(),
    active: boolean().notNull().default(true),
    released: boolean().notNull().default(false),
  },
  (t) => [
    check(
      "staff_reservation_valid",
      sql`num_nonnulls(${t.appointmentId},${t.offerId})=1 and ${t.position}>=0 and ${t.unitIndex} between 0 and 5 and ${t.offsetMinutes}>=0 and (${t.endOffsetMinutes} is null or ${t.endOffsetMinutes}>${t.offsetMinutes}) and ${t.endsAt}>${t.startsAt} and (not ${t.released} or ${t.offerId} is not null)`,
    ),
    uniqueIndex("staff_reservation_appointment_position")
      .on(t.appointmentId, t.position)
      .where(sql`${t.appointmentId} is not null`),
    uniqueIndex("staff_reservation_offer_position")
      .on(t.offerId, t.position)
      .where(sql`${t.offerId} is not null`),
    index("staff_reservation_calendar_idx").on(t.staffId, t.startsAt).where(sql`${t.active}`),
  ],
);
