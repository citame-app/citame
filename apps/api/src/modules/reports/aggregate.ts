import type { AppointmentStatus, ReportSummary, StatusCounts } from "@sob/contracts";

/** One bucket of the SQL result: appointments of one status, on one local day, for one staff member. */
export interface DayStaffStatusRow {
  date: string;
  staffId: string;
  status: AppointmentStatus;
  count: number;
  /** Price snapshots of completed appointments; zero for every other status. */
  revenueCents: number;
}

export interface ServiceRow {
  serviceId: string | null;
  name: string;
  count: number;
  revenueCents: number;
}

export interface AggregateInput {
  from: string;
  to: string;
  timezone: string;
  staffId: string | null;
  rows: DayStaffStatusRow[];
  serviceRows: ServiceRow[];
  staff: { id: string; displayName: string }[];
}

const TOP_SERVICES = 10;

const emptyCounts = (): StatusCounts => ({ booked: 0, completed: 0, cancelled: 0, no_show: 0 });

interface Slice {
  appointments: number;
  byStatus: StatusCounts;
  revenueCents: number;
}

const emptySlice = (): Slice => ({ appointments: 0, byStatus: emptyCounts(), revenueCents: 0 });

function add(slice: Slice, row: DayStaffStatusRow) {
  slice.appointments += row.count;
  slice.byStatus[row.status] += row.count;
  slice.revenueCents += row.revenueCents;
}

/**
 * Share of no-shows among appointments that should already have happened (completed or
 * no-show). Booked ones are still in the future and cancelled ones were never going to happen,
 * so neither belongs in the denominator. Rounded to four decimals; null with no basis.
 */
function noShowRate(counts: StatusCounts): number | null {
  const due = counts.completed + counts.no_show;
  return due === 0 ? null : Math.round((counts.no_show / due) * 10_000) / 10_000;
}

function* localDates(from: string, to: string) {
  const end = Temporal.PlainDate.from(to);
  for (let day = Temporal.PlainDate.from(from); Temporal.PlainDate.compare(day, end) <= 0; ) {
    yield day.toString();
    day = day.add({ days: 1 });
  }
}

/**
 * Turns the SQL buckets into the report. Pure: all grouping by timezone already happened in the
 * query, so this only sums, zero-fills and ranks, which is what the fixtures pin down.
 */
export function buildReportSummary(input: AggregateInput): ReportSummary {
  const totals = emptySlice();
  const byDay = new Map<string, Slice>();
  const byStaff = new Map<string, Slice>();
  for (const date of localDates(input.from, input.to)) byDay.set(date, emptySlice());
  for (const member of input.staff) byStaff.set(member.id, emptySlice());

  for (const row of input.rows) {
    add(totals, row);
    const day = byDay.get(row.date);
    if (day) add(day, row);
    const staff = byStaff.get(row.staffId);
    if (staff) add(staff, row);
  }

  return {
    from: input.from,
    to: input.to,
    timezone: input.timezone,
    staffId: input.staffId,
    totals: { ...totals, noShowRate: noShowRate(totals.byStatus) },
    series: [...byDay].map(([date, slice]) => ({ date, ...slice })),
    topServices: [...input.serviceRows]
      .sort(
        (a, b) =>
          b.count - a.count || b.revenueCents - a.revenueCents || a.name.localeCompare(b.name),
      )
      .slice(0, TOP_SERVICES),
    perStaff: input.staff
      .map((member) => {
        const slice = byStaff.get(member.id) ?? emptySlice();
        return {
          staffId: member.id,
          displayName: member.displayName,
          ...slice,
          noShowRate: noShowRate(slice.byStatus),
        };
      })
      .sort(
        (a, b) => b.revenueCents - a.revenueCents || a.displayName.localeCompare(b.displayName),
      ),
  };
}
