import type { AppointmentStatus, ReportQuery, ReportSummary } from "@sob/contracts";
import { type Database, staffProfile } from "@sob/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getSalonSettings } from "../settings/service";
import { requireStaff } from "../staff/admin";
import { buildReportSummary, type DayStaffStatusRow, type ServiceRow } from "./aggregate";

type BucketRow = {
  day: string;
  staff_id: string;
  status: AppointmentStatus;
  n: number;
  revenue: string | number | bigint;
};

type ServiceBucketRow = {
  service_id: string | null;
  name: string;
  n: number;
  revenue: string | number | bigint;
};

/**
 * Builds the report. Grouping happens in SQL so Postgres, which owns the timezone database,
 * decides which local day an instant belongs to (`starts_at AT TIME ZONE <salon timezone>`);
 * the JavaScript side only sums and ranks the buckets (see `aggregate.ts`).
 */
export async function reportSummary(db: Database, query: ReportQuery): Promise<ReportSummary> {
  const settings = await getSalonSettings(db);
  const timezone = settings.timezone;
  if (query.staffId) await requireStaff(db, query.staffId);

  // [from 00:00, to+1 00:00) in salon time, as absolute instants.
  const fromAt = new Date(
    Temporal.PlainDate.from(query.from).toZonedDateTime(timezone).epochMilliseconds,
  ).toISOString();
  const toAt = new Date(
    Temporal.PlainDate.from(query.to).add({ days: 1 }).toZonedDateTime(timezone).epochMilliseconds,
  ).toISOString();
  const onlyStaff = query.staffId ? sql`and a.staff_id = ${query.staffId}` : sql``;

  const [buckets, serviceBuckets, staff] = await Promise.all([
    db.execute<BucketRow>(sql`
      select (a.starts_at at time zone ${timezone})::date::text as day,
             a.staff_id as staff_id,
             a.status::text as status,
             count(*)::int as n,
             coalesce(sum(case when a.status = 'completed' then ps.total else 0 end), 0)::bigint as revenue
      from appointment a
      left join (
        select appointment_id, sum(price_cents) as total
        from appointment_service
        group by appointment_id
      ) ps on ps.appointment_id = a.id
      where a.deleted_at is null
        and a.starts_at >= ${fromAt}::timestamptz
        and a.starts_at < ${toAt}::timestamptz
        ${onlyStaff}
      group by 1, 2, 3
    `),
    db.execute<ServiceBucketRow>(sql`
      select aps.service_id as service_id,
             coalesce(max(s.name), max(aps.name)) as name,
             count(*)::int as n,
             coalesce(sum(aps.price_cents), 0)::bigint as revenue
      from appointment_service aps
      join appointment a on a.id = aps.appointment_id
      left join service s on s.id = aps.service_id
      where a.deleted_at is null
        and a.status = 'completed'
        and a.starts_at >= ${fromAt}::timestamptz
        and a.starts_at < ${toAt}::timestamptz
        ${onlyStaff}
      group by aps.service_id
    `),
    db
      .select({ id: staffProfile.id, displayName: staffProfile.displayName })
      .from(staffProfile)
      .where(
        and(
          isNull(staffProfile.deletedAt),
          query.staffId ? eq(staffProfile.id, query.staffId) : undefined,
        ),
      )
      .orderBy(asc(staffProfile.displayName)),
  ]);

  const rows: DayStaffStatusRow[] = buckets.map((b) => ({
    date: b.day,
    staffId: b.staff_id,
    status: b.status,
    count: Number(b.n),
    revenueCents: Number(b.revenue),
  }));
  const serviceRows: ServiceRow[] = serviceBuckets.map((s) => ({
    serviceId: s.service_id,
    name: s.name,
    count: Number(s.n),
    revenueCents: Number(s.revenue),
  }));

  return buildReportSummary({
    from: query.from,
    to: query.to,
    timezone,
    staffId: query.staffId ?? null,
    rows,
    serviceRows,
    staff,
  });
}
