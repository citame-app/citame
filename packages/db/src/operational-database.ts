import { sql } from "drizzle-orm";
import type { Database } from "./client";

export const booksyDesktopTestDatabase = /^sob_booksy_desktop_test_\d{8}$/;
export const booksyRestoreDatabase = /^sob_booksy_restorecheck_\d{8}_\d+$/;

function assertOperationalName(name: string) {
  if (
    /^sob_booksy_(?:rehearsal|restorecheck|candidate)_/.test(name) ||
    booksyDesktopTestDatabase.test(name)
  )
    throw new Error("A private Booksy import database cannot run operational commands");
}

/** Private import databases must stay on the dedicated loopback entry point. */
export function assertNotBooksyReviewDatabase(databaseUrl: string) {
  assertOperationalName(decodeURIComponent(new URL(databaseUrl).pathname.slice(1)));
}

/** Renaming a database or restoring its full dump does not remove the review-only marker. */
export async function assertOperationalDatabase(db: Pick<Database, "execute">) {
  const [row] = await db.execute<{ name: string; review: boolean }>(sql`
    select current_database() as name, exists (
      select 1 from pg_catalog.pg_namespace where nspname = 'booksy_rehearsal'
    ) as review
  `);
  if (row?.review !== false)
    throw new Error(
      "This database contains a private Booksy review archive and cannot run operations",
    );
  assertOperationalName(row.name);
}
