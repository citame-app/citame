import { index, pgTable, text, unique } from "drizzle-orm/pg-core";
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
    /** Preferred language for messages (`en` or `es-AR`); null falls back to the salon default. */
    locale: text(),
    /** Login account of this client, if any (walk-in clients have none). */
    userId: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("client_profile_email_idx").on(t.email),
    index("client_profile_phone_idx").on(t.phone),
    unique("client_profile_user_id_unique").on(t.userId),
  ],
);
