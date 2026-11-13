import type { Database } from "@sob/db";
import { sql } from "drizzle-orm";

/** The transaction handle passed to `db.transaction` callbacks. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Serializes writers that touch the same staff calendars. The exclusion constraint alone is
 * enough for correctness, but concurrent inserts with partially overlapping ranges can
 * deadlock inside Postgres (each waits for the other's uncommitted row). A transaction-scoped
 * advisory lock per staff member makes them queue instead, and the constraint still has the
 * final say. Schedule edits (hours, time off, deactivation) take the same lock so a booking can
 * never race the rule it is validated against.
 */
export async function lockCalendars(tx: Tx, staffIds: string[]) {
  for (const id of [...new Set(staffIds)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
  }
}
