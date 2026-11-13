import { index, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, deletedAt, primaryId, updatedAt } from "./helpers";

export const clientProfile = pgTable(
  "client_profile",
  {
    id: primaryId(),
    name: text().notNull(),
    phone: text(),
    email: text(),
    notes: text(),
    /** Phase 2 links this to a Better Auth user; intentionally no foreign key yet. */
    userId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("client_profile_email_idx").on(t.email),
    index("client_profile_phone_idx").on(t.phone),
  ],
);
