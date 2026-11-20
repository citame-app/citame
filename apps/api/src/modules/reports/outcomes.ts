import type { ReportOutcomeRow, ReportOutcomesQuery } from "@sob/contracts";
import type { Database } from "@sob/db";
import { sql } from "drizzle-orm";
import { streamCsv } from "../../csv";
import type { Tx } from "../../tx";
import { reportScope } from "./service";

const PAGE_SIZE = 25;

async function outcomeScope(db: Database | Tx, query: ReportOutcomesQuery) {
  const { timezone, fromAt, toAt, onlyStaff, currency, currencyAppointments } = await reportScope(
    db,
    query,
  );
  return {
    timezone,
    currency,
    filter: sql`a.deleted_at is null and a.status = ${query.status}
      and a.starts_at >= ${fromAt}::timestamptz and a.starts_at < ${toAt}::timestamptz
      ${onlyStaff} ${currencyAppointments}`,
  };
}

type OutcomeScope = Awaited<ReturnType<typeof outcomeScope>>;

async function readRows(
  tx: Tx,
  { filter, currency }: OutcomeScope,
  limit: number,
  offset: number,
  cursor?: ReportOutcomeRow,
): Promise<ReportOutcomeRow[]> {
  const before = cursor
    ? sql`and (a.starts_at, a.id) < (${cursor.startsAt}::timestamptz, ${cursor.id}::uuid)`
    : sql``;
  return (await tx.execute<ReportOutcomeRow>(sql`
    select a.id,
           to_char(a.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "startsAt",
           to_char(a.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "endsAt",
           c.name as client,
           s.display_name as staff,
           array(select aps.name from appointment_service aps
                 where aps.appointment_id = a.id and aps.currency = ${currency}
                 order by aps.position, aps.id) as services
    from appointment a
    join staff_profile s on s.id = a.staff_id
    left join client_profile c on c.id = a.client_id and c.deleted_at is null
    where ${filter} ${before}
    order by a.starts_at desc, a.id desc
    limit ${limit} offset ${offset}
  `)) as ReportOutcomeRow[];
}

export function reportOutcomes(db: Database, query: ReportOutcomesQuery) {
  return db.transaction(
    async (tx) => {
      const scope = await outcomeScope(tx, query);
      const [result] = await tx.execute<{ total: number }>(sql`
      select count(*)::int as total from appointment a where ${scope.filter}
    `);
      const total = Number(result?.total ?? 0);
      const page = Math.min(query.page, Math.max(1, Math.ceil(total / PAGE_SIZE)));
      const rows = await readRows(tx, scope, PAGE_SIZE, (page - 1) * PAGE_SIZE);
      return { rows, total, page, pageSize: PAGE_SIZE, timezone: scope.timezone };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function reportOutcomesCsv(
  db: Database,
  query: ReportOutcomesQuery,
  headOnly: boolean,
) {
  const scope = await outcomeScope(db, query);
  const localDateTime = (date: string) =>
    Temporal.Instant.from(date)
      .toZonedDateTimeISO(scope.timezone)
      .toString({ timeZoneName: "never", smallestUnit: "minute" });
  return streamCsv<ReportOutcomeRow>(db, {
    filename: `appointments-${query.status}-${query.from}-${query.to}.csv`,
    headOnly,
    columns: [
      "appointment_id",
      "status",
      "start_local",
      "end_local",
      "timezone",
      "client",
      "staff",
      "services",
    ],
    readBatch: (tx, cursor, limit) => readRows(tx, scope, limit, 0, cursor),
    cells: (row) => [
      row.id,
      query.status,
      localDateTime(row.startsAt),
      localDateTime(row.endsAt),
      scope.timezone,
      row.client,
      row.staff,
      row.services.join(" · "),
    ],
  });
}
