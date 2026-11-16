import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, deletedAt, primaryId, updatedAt } from "./helpers";

export const clientProfile = pgTable(
  "client_profile",
  {
    id: primaryId(),
    name: text().notNull(),
    phone: text(),
    email: text(),
    notes: text(),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    bookingAccess: text().notNull().default("normal"),
    bookingAccessReason: text(),
    controlsVersion: integer().notNull().default(1),
    /** Preferred language for messages (`en` or `es-AR`); null falls back to the salon default. */
    locale: text(),
    /** Login account of this client, if any (walk-in clients have none). */
    userId: text().references(() => user.id, { onDelete: "set null" }),
    mergedIntoId: uuid().references((): AnyPgColumn => clientProfile.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    check(
      "client_profile_controls_valid",
      sql`${t.bookingAccess} in ('normal','blocked','trusted') and ${t.controlsVersion}>0 and cardinality(${t.tags})<=20`,
    ),
    index("client_profile_email_idx").on(t.email),
    index("client_profile_merged_into_idx").on(t.mergedIntoId),
    check(
      "client_profile_identity_valid",
      sql`${t.mergedIntoId} is null or (${t.mergedIntoId}<>${t.id} and ${t.userId} is null)`,
    ),
    index("client_profile_phone_idx").on(t.phone),
    unique("client_profile_user_id_unique").on(t.userId),
  ],
);
