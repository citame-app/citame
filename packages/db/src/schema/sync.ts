import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt } from "./helpers";

/** Entities the sync protocol announces, by their public (wire) name. */
export const SYNC_ENTITIES = [
  "appointment",
  "client",
  "service",
  "staff",
  "service_staff",
  "working_hours",
  "date_shift",
  "time_off",
  "salon_settings",
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/**
 * Append-only change log. Rows are written ONLY by the deferred database triggers installed in
 * the `sync_triggers` migration, never by application code, so every write path (REST, sync,
 * scripts, psql) is covered. `seq` is assigned while a global advisory lock is held until the
 * transaction commits, which makes seq order equal commit order (see ADR 0007): a reader that
 * has seen `seq = n` has seen every committed change below `n`.
 *
 * The log carries no payload: pull reads the current row state, so a stale entry can never
 * resurrect old data and the log stays small.
 */
export const syncChange = pgTable(
  "sync_change",
  {
    seq: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    entity: text().notNull(),
    rowId: text().notNull(),
    op: text().notNull().$type<"upsert" | "delete">(),
    createdAt: createdAt(),
  },
  (t) => [
    check("sync_change_op_valid", sql`${t.op} in ('upsert', 'delete')`),
    index("sync_change_entity_row_idx").on(t.entity, t.rowId, t.seq),
  ],
);

/**
 * Idempotency ledger: one row per client mutation, keyed by the client-generated UUIDv7. The
 * stored `result` is replayed verbatim when the same `mutation_id` arrives again. `applied_seq`
 * is filled in by the trigger at commit with the last seq written by the mutation (null for a
 * rejected or no-op mutation).
 */
export const syncMutation = pgTable(
  "sync_mutation",
  {
    mutationId: uuid().primaryKey(),
    deviceId: text().notNull(),
    userId: text().references(() => user.id, { onDelete: "set null" }),
    kind: text().notNull(),
    status: text().notNull().$type<"applied" | "rejected">(),
    result: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    appliedSeq: bigint({ mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [
    check("sync_mutation_status_valid", sql`${t.status} in ('applied', 'rejected')`),
    index("sync_mutation_created_idx").on(t.createdAt),
  ],
);
