import { sql } from "drizzle-orm";
import { check, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { clientProfile } from "./client";
import { createdAt, primaryId } from "./helpers";
/** Immutable owner-reviewed identity correction; monetary and consent rows keep their owners. */
export const clientMerge = pgTable(
  "client_merge",
  {
    id: primaryId(),
    sourceId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    targetId: uuid()
      .notNull()
      .references(() => clientProfile.id),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    idempotencyKey: text().notNull(),
    requestFingerprint: text().notNull(),
    reviewHash: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("client_merge_source_unique").on(t.sourceId),
    unique("client_merge_actor_key_unique").on(t.createdBy, t.idempotencyKey),
    check(
      "client_merge_valid",
      sql`${t.sourceId}<>${t.targetId} and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ${t.reviewHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
