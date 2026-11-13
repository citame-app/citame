import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  smallint,
  text,
  time,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, deletedAt, primaryId, timestamptz, updatedAt } from "./helpers";
import { service } from "./service";

export const staffProfile = pgTable(
  "staff_profile",
  {
    id: primaryId(),
    displayName: text().notNull(),
    /** Login account of this staff member, if any. One account links to at most one profile. */
    userId: text().references(() => user.id, { onDelete: "set null" }),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [unique("staff_profile_user_id_unique").on(t.userId)],
);

export const serviceStaff = pgTable(
  "service_staff",
  {
    id: primaryId(),
    serviceId: uuid()
      .notNull()
      .references(() => service.id),
    staffId: uuid()
      .notNull()
      .references(() => staffProfile.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [unique("service_staff_unique").on(t.serviceId, t.staffId)],
);

/**
 * Recurring weekly availability in the salon's local time. `weekday` is 0-6 with
 * 0 = Sunday (same as JavaScript's `Date#getDay`). A staff member can have several
 * ranges per weekday (for example a lunch break splits the day).
 */
export const workingHours = pgTable(
  "working_hours",
  {
    id: primaryId(),
    staffId: uuid()
      .notNull()
      .references(() => staffProfile.id),
    weekday: smallint().notNull(),
    startTime: time().notNull(),
    endTime: time().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    check("working_hours_weekday_range", sql`${t.weekday} between 0 and 6`),
    check("working_hours_end_after_start", sql`${t.endTime} > ${t.startTime}`),
    index("working_hours_staff_idx").on(t.staffId, t.weekday),
  ],
);

export const timeOff = pgTable(
  "time_off",
  {
    id: primaryId(),
    staffId: uuid()
      .notNull()
      .references(() => staffProfile.id),
    startsAt: timestamptz().notNull(),
    endsAt: timestamptz().notNull(),
    reason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    check("time_off_end_after_start", sql`${t.endsAt} > ${t.startsAt}`),
    index("time_off_staff_idx").on(t.staffId, t.startsAt),
  ],
);
