import { relations, sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text } from "drizzle-orm/pg-core";
import { timestamptz } from "./helpers";

/**
 * Better Auth core tables. The column set comes from `bunx auth generate --adapter drizzle`
 * (Better Auth 1.7.23); names, timestamptz and the role constraint follow this repo's
 * conventions. Ids are text because Better Auth owns them; the API generates UUIDv7 values
 * (`advanced.database.generateId`). Sessions live in Valkey (secondary storage), the
 * `session` table is the durable fallback the adapter requires.
 */

export const USER_ROLES = ["owner", "staff", "client"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const user = pgTable(
  "user",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    email: text().notNull().unique(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Authorization role. Never writable from sign-up input; changed only by an owner. */
    role: text().notNull().default("client").$type<UserRole>(),
  },
  (t) => [check("user_role_valid", sql`${t.role} in ('owner', 'staff', 'client')`)],
);

export const session = pgTable(
  "session",
  {
    id: text().primaryKey(),
    expiresAt: timestamptz().notNull(),
    token: text().notNull().unique(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamptz(),
    refreshTokenExpiresAt: timestamptz(),
    scope: text(),
    password: text(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamptz().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));
