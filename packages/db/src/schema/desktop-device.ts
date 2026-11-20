import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { oauthConsent } from "./oauth";

export const desktopDevice = pgTable(
  "desktop_device",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    grantId: text()
      .notNull()
      .references(() => oauthConsent.id, { onDelete: "cascade" }),
    enrollmentId: text().notNull().unique(),
    publicKey: text().notNull(),
    label: text().notNull(),
    linkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("desktop_device_user_idx").on(t.userId),
    index("desktop_device_grant_idx").on(t.grantId),
  ],
);
