import { type SQL, sql } from "drizzle-orm";

/** Reports alias the appointment as a. Count visits by current directory identity. */
export const visitedClientIdentity = sql`client_root_id(a.client_id)`;

export function completedClientVisitScope({
  fromAt,
  toAt,
  onlyStaff,
}: {
  fromAt: string;
  toAt: string;
  onlyStaff: SQL;
}) {
  return sql`a.deleted_at is null and a.status = 'completed'
    and a.starts_at >= ${fromAt}::timestamptz and a.starts_at < ${toAt}::timestamptz
    ${onlyStaff}`;
}
