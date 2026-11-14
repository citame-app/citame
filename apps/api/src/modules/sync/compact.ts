import type { Database } from "@sob/db";
import { sql } from "drizzle-orm";

/**
 * Removes change-log entries that a later entry for the same row has superseded, if they are
 * older than `olderThan`. Because pull reads current row state, dropping a superseded entry
 * loses no information: a client at any older cursor still sees the row's latest entry (a
 * tombstone included) and converges. The newest entry of every row is kept, so `headSeq` and
 * all issued cursors stay valid; compaction only leaves gaps in `seq`, which clients ignore.
 *
 * Tombstones themselves are NOT purged here: deleting them would let a client that was offline
 * for longer than the retention keep a ghost row (see ADR 0007). Returns the rows removed.
 */
export async function compactSyncLog(db: Database, options: { olderThan: Date }): Promise<number> {
  const removed = await db.execute<{ seq: string }>(sql`
    delete from sync_change c
    where c.created_at < ${options.olderThan}
      and exists (
        select 1 from sync_change n
        where n.entity = c.entity and n.row_id = c.row_id and n.seq > c.seq
      )
    returning c.seq
  `);
  return removed.length;
}
