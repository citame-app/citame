import type {
  AppointmentStatus,
  ReportBreakdownKind,
  ReportBreakdownRow,
  ReportQuery,
  ReportSummary,
} from "@sob/contracts";
import { type Database, staffProfile } from "@sob/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../tx";
import { confirmedBookingPromotionJoin } from "../rewards/booking-attribution";
import { getSalonSettings } from "../settings/service";
import { requireStaff } from "../staff/admin";
import { buildReportSummary, type DayStaffStatusRow, type ServiceRow } from "./aggregate";
import { reportStaffOccupancy } from "./occupancy";

type BucketRow = {
  day: string;
  staff_id: string;
  status: AppointmentStatus;
  n: number;
  revenue: string | number | bigint;
  unpriced: string | number | bigint;
};

type ServiceBucketRow = {
  service_id: string | null;
  name: string;
  n: number;
  revenue: string | number | bigint;
  unpriced: number;
};

type BreakdownBucketRow = {
  kind: ReportBreakdownKind | "promotion";
  key: string;
  label: string | null;
  appointments: number;
  booked: number;
  completed: number;
  cancelled: number;
  no_show: number;
};

/**
 * Builds the report. Grouping happens in SQL so Postgres, which owns the timezone database,
 * decides which local day an instant belongs to (`starts_at AT TIME ZONE <salon timezone>`);
 * the JavaScript side only sums and ranks the buckets (see `aggregate.ts`).
 */
export async function reportSummary(db: Database, query: ReportQuery): Promise<ReportSummary> {
  return db.transaction((tx) => reportSummarySnapshot(tx, query), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

export async function reportDateScope(db: Database | Tx, query: ReportQuery) {
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
  return { timezone, fromAt, toAt, onlyStaff };
}

export async function reportScope(db: Database | Tx, query: ReportQuery) {
  const { timezone, fromAt, toAt, onlyStaff } = await reportDateScope(db, query);
  const currencyRows = await db.execute<{ currency: string }>(
    sql`select distinct aps.currency from appointment_service aps join appointment a on a.id=aps.appointment_id where a.deleted_at is null and a.starts_at>=${fromAt}::timestamptz and a.starts_at<${toAt}::timestamptz ${onlyStaff} order by aps.currency`,
  );
  const currencies = currencyRows.map((row) => row.currency);
  const currency =
    query.currency ?? (currencies.includes("EUR") ? "EUR" : (currencies[0] ?? "EUR"));
  const currencyAppointments = sql`and exists(select 1 from appointment_service currency_service where currency_service.appointment_id=a.id and currency_service.currency=${currency})`;
  return { timezone, fromAt, toAt, onlyStaff, currency, currencies, currencyAppointments };
}

async function reportSummarySnapshot(db: Tx, query: ReportQuery): Promise<ReportSummary> {
  const { timezone, fromAt, toAt, onlyStaff, currency, currencies, currencyAppointments } =
    await reportScope(db, query);
  const knownPrice = sql`case
    when aps.source_unpriced then aps.reviewed_price_cents
    else aps.price_cents
  end`;
  const [buckets, serviceBuckets, staff, breakdownBuckets] = await Promise.all([
    db.execute<BucketRow>(sql`
      select (a.starts_at at time zone ${timezone})::date::text as day,
             a.staff_id as staff_id,
             a.status::text as status,
             count(*)::int as n,
             coalesce(sum(ps.total) filter (where a.status = 'completed'), 0)::bigint as revenue,
             coalesce(sum(ps.unpriced) filter (where a.status = 'completed'), 0)::bigint as unpriced
      from appointment a
      left join (
        select aps.appointment_id, sum(${knownPrice}) as total,
               count(*) filter (where aps.source_unpriced and aps.reviewed_price_cents is null) as unpriced
        from appointment_service aps
        where aps.currency=${currency}
        group by aps.appointment_id
      ) ps on ps.appointment_id = a.id
      where a.deleted_at is null
        and a.starts_at >= ${fromAt}::timestamptz
        and a.starts_at < ${toAt}::timestamptz
        ${onlyStaff}
        ${currencyAppointments}
      group by 1, 2, 3
    `),
    db.execute<ServiceBucketRow>(sql`
      select aps.service_id as service_id,
             coalesce(max(s.name), max(aps.name)) as name,
             count(*)::int as n,
             coalesce(sum(${knownPrice}), 0)::bigint as revenue,
             (count(*) filter (where aps.source_unpriced and aps.reviewed_price_cents is null))::int as unpriced
      from appointment_service aps
      join appointment a on a.id = aps.appointment_id
      left join service s on s.id = aps.service_id
      where a.deleted_at is null
        and a.status = 'completed'
        and a.starts_at >= ${fromAt}::timestamptz
        and a.starts_at < ${toAt}::timestamptz
        ${onlyStaff}
        and aps.currency=${currency}
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
    db.execute<BreakdownBucketRow>(sql`
      with scoped as (
        select a.id, a.status, a.starts_at
        from appointment a
        where a.deleted_at is null
          and a.starts_at >= ${fromAt}::timestamptz
          and a.starts_at < ${toAt}::timestamptz
          ${onlyStaff}
          ${currencyAppointments}
      ), items as (
        select a.id, a.status, 'hour' as kind, hour.label as key, hour.label
        from scoped a
        cross join lateral (select to_char(a.starts_at at time zone ${timezone}, 'HH24:00') as label) hour
        union all
        select distinct a.id, a.status, bucket.kind, bucket.key, bucket.label
        from scoped a
        join appointment_service aps on aps.appointment_id = a.id and aps.currency = ${currency}
        left join service s on s.id = aps.service_id
        left join service parent on parent.id = s.parent_service_id
        cross join lateral (
          values
            (case when s.catalog_kind = 'addon' then 'addon' else 'service' end,
             coalesce(s.id::text, 'snapshot:' || aps.name), coalesce(s.name, aps.name)),
            (case when s.catalog_kind is distinct from 'addon' then 'category' end,
             coalesce('category:' || coalesce(parent.category, s.category), 'uncategorized'),
             coalesce(parent.category, s.category))
        ) bucket(kind, key, label)
        where bucket.kind is not null
        union all
        select distinct a.id, a.status, 'promotion',
               jsonb_build_array(promotion_reward.name, promotion_reward.code)::text,
               concat(promotion_reward.name, ' (', promotion_reward.code, ')')
        from scoped a
        join checkout c on c.appointment_id = a.id and c.currency = ${currency}
        ${confirmedBookingPromotionJoin}
      )
      select kind, key, label, count(*)::int as appointments,
             (count(*) filter (where status = 'booked'))::int as booked,
             (count(*) filter (where status = 'completed'))::int as completed,
             (count(*) filter (where status = 'cancelled'))::int as cancelled,
             (count(*) filter (where status = 'no_show'))::int as no_show
      from items
      group by kind, key, label
      order by kind, case when kind = 'hour' then 0 else count(*) end desc, label, key
    `),
  ]);

  const rows: DayStaffStatusRow[] = buckets.map((b) => ({
    date: b.day,
    staffId: b.staff_id,
    status: b.status,
    count: Number(b.n),
    revenueCents: Number(b.revenue),
    ...(Number(b.unpriced) > 0 ? { unpricedServices: Number(b.unpriced) } : {}),
  }));
  const serviceRows: ServiceRow[] = serviceBuckets.map((s) => ({
    serviceId: s.service_id,
    name: s.name,
    count: Number(s.n),
    revenueCents: Number(s.revenue),
    ...(s.unpriced > 0 ? { unpricedServices: s.unpriced } : {}),
  }));
  const appointmentBreakdown: NonNullable<ReportSummary["appointmentBreakdown"]> = {
    hour: [],
    service: [],
    category: [],
    addon: [],
  };
  const promotionBreakdown: ReportBreakdownRow[] = [];
  for (const row of breakdownBuckets as BreakdownBucketRow[]) {
    const { kind, key, label, appointments, booked, completed, cancelled, no_show } = row;
    const bucket = kind === "promotion" ? promotionBreakdown : appointmentBreakdown[kind];
    bucket.push({
      key,
      label,
      appointments,
      byStatus: { booked, completed, cancelled, no_show },
    });
  }

  const summary = buildReportSummary({
    from: query.from,
    to: query.to,
    timezone,
    staffId: query.staffId ?? null,
    rows,
    serviceRows,
    staff,
  });
  const occupancy = await reportStaffOccupancy(
    db,
    staff.map(({ id }) => id),
    query,
    {
      timezone,
      fromAt,
      toAt,
    },
  );
  return {
    ...summary,
    perStaff: summary.perStaff.map((member) => ({
      ...member,
      occupancy: occupancy.get(member.staffId),
    })),
    currency,
    currencies,
    appointmentBreakdown,
    promotionBreakdown,
  };
}
