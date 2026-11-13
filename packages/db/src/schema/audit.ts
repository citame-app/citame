import { index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, primaryId } from "./helpers";

/**
 * Append-only record of security- and business-relevant actions. `metadata` must never hold
 * passwords, tokens or other secrets. The actor link is nulled (not cascaded) when a user is
 * removed so history survives.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: primaryId(),
    actorUserId: text().references(() => user.id, { onDelete: "set null" }),
    /** Dotted verb, for example `appointment.create` or `user.role_change`. */
    action: text().notNull(),
    entity: text().notNull(),
    entityId: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entity, t.entityId),
    index("audit_log_actor_idx").on(t.actorUserId, t.createdAt),
  ],
);
