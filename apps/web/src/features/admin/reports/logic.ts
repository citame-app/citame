import { type ReportSummary, reportBreakdownKinds } from "@sob/contracts";
import type { SortingState } from "@tanstack/react-table";
import { addDaysLocal } from "~/lib/format";

export type ReportPreset = "today" | "last7" | "last30" | "thisMonth" | "lastMonth";
export const REPORT_PRESETS: readonly ReportPreset[] = [
  "today",
  "last7",
  "last30",
  "thisMonth",
  "lastMonth",
];

export const OCCUPANCY_MINUTES = [
  "scheduledMinutes",
  "blockedMinutes",
  "reservedMinutes",
  "completedMinutes",
  "noShowMinutes",
] as const;

export function hasOccupancyMinutes(staff: ReportSummary["perStaff"]): boolean {
  return staff.some(({ occupancy }) =>
    OCCUPANCY_MINUTES.some((field) => (occupancy?.[field] ?? 0) > 0),
  );
}

const lastDayOfMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");

/** Inclusive salon-local range for a preset, relative to `today` (a local date). */
export function presetRange(preset: ReportPreset, today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "last7":
      return { from: addDaysLocal(today, -6), to: today };
    case "last30":
      return { from: addDaysLocal(today, -29), to: today };
    case "thisMonth":
      return {
        from: `${year}-${pad(month)}-01`,
        to: `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`,
      };
    case "lastMonth": {
      const y = month === 1 ? year - 1 : year;
      const m = month === 1 ? 12 : month - 1;
      return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}` };
    }
  }
}

export function formatRate(rate: number | null, locale: string): string {
  if (rate === null) return "-";
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(rate);
}

export function sortBy<T>(
  rows: T[],
  sorting: SortingState,
  getters: Record<string, (row: T) => string | number>,
): T[] {
  const [sort] = sorting;
  const get = sort ? getters[sort.id] : undefined;
  if (!sort || !get) return rows;
  return [...rows].sort((a, b) => {
    const left = get(a);
    const right = get(b);
    return (left < right ? -1 : left > right ? 1 : 0) * (sort.desc ? -1 : 1);
  });
}

/** One CSV cell. Leading `= + - @` would run as a formula in spreadsheets, so it is neutralized. */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const money = (cents: number) => (cents / 100).toFixed(2);
const row = (cells: (string | number)[]) => cells.map(csvCell).join(",");

/** The visible report as CSV: machine-readable numbers (dot decimals, major currency units). */
export function reportToCsv(summary: ReportSummary): string {
  const includeUnpriced = Boolean(summary.totals.unpricedServices);
  const unpricedHeader = includeUnpriced ? ["unpriced_services"] : [];
  const unpricedCell = (count?: number) => (includeUnpriced ? [count ?? 0] : []);
  const lines: string[] = [
    row([
      "date",
      "appointments",
      "booked",
      "completed",
      "cancelled",
      "no_show",
      "revenue",
      ...(summary.currency ? ["currency"] : []),
      ...unpricedHeader,
    ]),
    ...summary.series.map((d) =>
      row([
        d.date,
        d.appointments,
        d.byStatus.booked,
        d.byStatus.completed,
        d.byStatus.cancelled,
        d.byStatus.no_show,
        money(d.revenueCents),
        ...(summary.currency ? [summary.currency] : []),
        ...unpricedCell(d.unpricedServices),
      ]),
    ),
    "",
    row([
      "service",
      "completed",
      "revenue",
      ...(summary.currency ? ["currency"] : []),
      ...unpricedHeader,
    ]),
    ...summary.topServices.map((s) =>
      row([
        s.name,
        s.count,
        money(s.revenueCents),
        ...(summary.currency ? [summary.currency] : []),
        ...unpricedCell(s.unpricedServices),
      ]),
    ),
    "",
    row([
      "staff",
      "appointments",
      "completed",
      "no_show",
      "no_show_rate",
      "revenue",
      ...(summary.currency ? ["currency"] : []),
      ...unpricedHeader,
    ]),
    ...summary.perStaff.map((s) =>
      row([
        s.displayName,
        s.appointments,
        s.byStatus.completed,
        s.byStatus.no_show,
        s.noShowRate === null ? "" : s.noShowRate.toFixed(4),
        money(s.revenueCents),
        ...(summary.currency ? [summary.currency] : []),
        ...unpricedCell(s.unpricedServices),
      ]),
    ),
  ];
  if (summary.perStaff.some((staff) => staff.occupancy)) {
    lines.push(
      "",
      row([
        "staff",
        "scheduled_minutes",
        "blocked_minutes",
        "reserved_minutes",
        "completed_visit_minutes",
        "no_show_minutes",
        "occupancy_rate",
      ]),
    );
    for (const staff of summary.perStaff) {
      if (!staff.occupancy) continue;
      const time = staff.occupancy;
      lines.push(
        row([
          staff.displayName,
          time.scheduledMinutes,
          time.blockedMinutes,
          time.reservedMinutes,
          time.completedMinutes,
          time.noShowMinutes,
          time.occupancyRate?.toFixed(4) ?? "",
        ]),
      );
    }
  }
  const breakdown = summary.appointmentBreakdown;
  if (breakdown) {
    lines.push(
      "",
      row(["group", "label", "appointments", "booked", "completed", "cancelled", "no_show"]),
    );
    const sections = reportBreakdownKinds.map((kind) => [kind, breakdown[kind]] as const);
    for (const [kind, entries] of [
      ...sections,
      ["promotion", summary.promotionBreakdown ?? []] as const,
    ]) {
      for (const entry of entries) {
        lines.push(
          row([
            kind,
            entry.label ?? "",
            entry.appointments,
            entry.byStatus.booked,
            entry.byStatus.completed,
            entry.byStatus.cancelled,
            entry.byStatus.no_show,
          ]),
        );
      }
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}
