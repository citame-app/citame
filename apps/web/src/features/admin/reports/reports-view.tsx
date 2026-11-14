import type { ReportSummary, UserRole } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, type SortingState } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { ChartFrame } from "~/components/ui/chart-frame";
import { DataTable, type DataTableFeatures } from "~/components/ui/data-table";
import { TextField } from "~/components/ui/field";
import { DownloadIcon } from "~/components/ui/icons";
import { SelectField } from "~/components/ui/select-field";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery, reportQuery } from "~/lib/admin-queries";
import { formatDateWithYear, formatMoney, localDateOf } from "~/lib/format";
import { useNow } from "../use-now";
import { RevenueChart, StatusChart } from "./charts";
import { formatRate, REPORT_PRESETS, reportToCsv } from "./logic";
import { type ReportsSearch, rangeError, resolveRange } from "./range";

const topHelper = createColumnHelper<DataTableFeatures, ReportSummary["topServices"][number]>();
const staffHelper = createColumnHelper<DataTableFeatures, ReportSummary["perStaff"][number]>();

export function ReportsView({
  search,
  onSearchChange,
  role,
  now: fixedNow,
}: {
  search: ReportsSearch;
  onSearchChange: (search: ReportsSearch) => void;
  role: UserRole;
  now?: Date;
}) {
  const { t, locale, timeZone } = useI18n();
  const toast = useToast();
  const ticking = useNow(60_000);
  const now = fixedNow ?? ticking;
  const today = localDateOf(now.toISOString(), timeZone);
  const range = resolveRange(search, today);
  const problem = rangeError(range);
  const staff = useQuery({ ...adminStaffQuery, enabled: role === "owner" });
  const query = useQuery({
    ...reportQuery({ ...range, ...(search.staff ? { staffId: search.staff } : {}) }),
    enabled: problem === null,
  });
  const [topSort, setTopSort] = useState<SortingState>([{ id: "count", desc: true }]);
  const [staffSort, setStaffSort] = useState<SortingState>([{ id: "revenue", desc: true }]);

  const report = query.data;
  const money = (cents: number) => formatMoney(cents, "ARS", locale);
  const day = (date: string) => formatDateWithYear(date, locale);

  const topRows = useMemo(
    () =>
      sortBy(report?.topServices ?? [], topSort, {
        count: (r) => r.count,
        revenue: (r) => r.revenueCents,
        name: (r) => r.name.toLowerCase(),
      }),
    [report, topSort],
  );
  const staffRows = useMemo(
    () =>
      sortBy(report?.perStaff ?? [], staffSort, {
        appointments: (r) => r.appointments,
        revenue: (r) => r.revenueCents,
        name: (r) => r.displayName.toLowerCase(),
        noShows: (r) => r.byStatus.no_show,
        rate: (r) => r.noShowRate ?? -1,
      }),
    [report, staffSort],
  );

  const topColumns = useMemo(
    () =>
      topHelper.columns([
        topHelper.accessor("name", {
          id: "name",
          header: t("reports.col.service"),
          meta: { cardTitle: true },
        }),
        topHelper.accessor("count", {
          id: "count",
          header: t("reports.col.count"),
          meta: { numeric: true },
        }),
        topHelper.accessor("revenueCents", {
          id: "revenue",
          header: t("reports.col.revenue"),
          meta: { numeric: true },
          cell: (c) => formatMoney(c.getValue(), "ARS", locale),
        }),
      ]),
    [t, locale],
  );
  const staffColumns = useMemo(
    () =>
      staffHelper.columns([
        staffHelper.accessor("displayName", {
          id: "name",
          header: t("reports.col.staff"),
          meta: { cardTitle: true },
        }),
        staffHelper.accessor("appointments", {
          id: "appointments",
          header: t("reports.col.appointments"),
          meta: { numeric: true },
        }),
        staffHelper.accessor((r) => r.byStatus.no_show, {
          id: "noShows",
          header: t("reports.col.noShows"),
          meta: { numeric: true },
        }),
        staffHelper.accessor("noShowRate", {
          id: "rate",
          header: t("reports.col.noShowRate"),
          meta: { numeric: true },
          cell: (c) => formatRate(c.getValue(), locale),
        }),
        staffHelper.accessor("revenueCents", {
          id: "revenue",
          header: t("reports.col.revenue"),
          meta: { numeric: true },
          cell: (c) => formatMoney(c.getValue(), "ARS", locale),
        }),
      ]),
    [t, locale],
  );

  function exportCsv() {
    if (!report) return;
    const blob = new Blob([reportToCsv(report)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `report-${report.from}-${report.to}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.success(t("reports.export.done"));
  }

  const setPreset = (preset: ReportsSearch["preset"]) => {
    const keep = search.staff ? { staff: search.staff } : {};
    onSearchChange(
      preset === "custom"
        ? { preset, from: range.from, to: range.to, ...keep }
        : { preset, ...keep },
    );
  };

  const totals = report?.totals;
  const tiles = totals
    ? [
        { label: t("reports.tile.appointments"), value: String(totals.appointments) },
        { label: t("reports.tile.completed"), value: String(totals.byStatus.completed) },
        { label: t("reports.tile.revenue"), value: money(totals.revenueCents) },
        {
          label: t("reports.tile.noShowRate"),
          value: formatRate(totals.noShowRate, locale),
          hint: totals.noShowRate === null ? t("reports.tile.noShowRate.none") : undefined,
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <fieldset className="inline-flex flex-wrap rounded-md border border-line p-0.5">
          <legend className="sr-only">{t("reports.preset.label")}</legend>
          {[...REPORT_PRESETS, "custom" as const].map((preset) => (
            <span key={preset} className="relative">
              <input
                type="radio"
                name="report-preset"
                aria-label={t(`reports.preset.${preset}`)}
                className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0"
                checked={search.preset === preset}
                onChange={() => setPreset(preset)}
              />
              <span className="flex min-h-11 items-center justify-center rounded px-3 text-sm font-medium text-muted peer-checked:bg-accent peer-checked:text-accent-fg peer-focus-visible:outline-3 peer-focus-visible:outline-ring">
                {t(`reports.preset.${preset}`)}
              </span>
            </span>
          ))}
        </fieldset>
        {search.preset === "custom" && (
          <>
            <TextField
              label={t("reports.from")}
              type="date"
              value={search.from ?? range.from}
              onChange={(e) => onSearchChange({ ...search, from: e.target.value })}
            />
            <TextField
              label={t("reports.to")}
              type="date"
              value={search.to ?? range.to}
              onChange={(e) => onSearchChange({ ...search, to: e.target.value })}
            />
          </>
        )}
        {role === "owner" && (
          <SelectField
            label={t("reports.staff")}
            value={search.staff ?? ""}
            options={[
              { value: "", label: t("reports.staff.all") },
              ...(staff.data ?? []).map((m) => ({ value: m.id, label: m.displayName })),
            ]}
            onChange={(value) => {
              const { staff: _drop, ...rest } = search;
              onSearchChange(value ? { ...rest, staff: value } : rest);
            }}
          />
        )}
        <Button
          variant="secondary"
          className="ml-auto"
          disabled={!report || report.totals.appointments === 0}
          onClick={exportCsv}
        >
          <DownloadIcon />
          {t("reports.export")}
        </Button>
      </div>

      {problem && (
        <p
          role="alert"
          className="rounded-lg border border-danger-fg/40 bg-danger-soft p-3 font-medium text-danger-fg"
        >
          {t(problem === "order" ? "reports.error.order" : "reports.error.tooLong")}
        </p>
      )}

      {!problem && query.isPending && (
        <div role="status" aria-label={t("admin.loading")} className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </div>
      )}
      {!problem && query.isError && (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      )}

      {report && !problem && (
        <>
          {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of figures, not a form fieldset */}
          <div role="group" aria-label={t("reports.tiles")}>
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {tiles.map((tile) => (
                <div key={tile.label} className="rounded-xl border border-line bg-surface p-4">
                  <dt className="text-sm text-muted">{tile.label}</dt>
                  <dd className="mt-1 font-display text-2xl font-semibold tabular-nums">
                    {tile.value}
                  </dd>
                  {tile.hint && <p className="mt-0.5 text-xs text-muted">{tile.hint}</p>}
                </div>
              ))}
            </dl>
          </div>

          {report.totals.appointments === 0 ? (
            <EmptyState title={t("reports.empty.title")} description={t("reports.empty.body")} />
          ) : (
            <>
              <div className="grid gap-4 xl:grid-cols-2">
                <ChartFrame
                  title={t("reports.chart.revenue")}
                  summary={t("reports.chart.revenue.summary", {
                    total: money(report.totals.revenueCents),
                    from: day(report.from),
                    to: day(report.to),
                  })}
                  table={{
                    caption: t("reports.chart.revenue"),
                    columns: [t("reports.col.date"), t("reports.col.revenue")],
                    rows: report.series.map((d) => [day(d.date), money(d.revenueCents)]),
                  }}
                >
                  <RevenueChart series={report.series} currency="ARS" />
                </ChartFrame>
                <ChartFrame
                  title={t("reports.chart.status")}
                  summary={t("reports.chart.status.summary", {
                    count: report.totals.appointments,
                    from: day(report.from),
                    to: day(report.to),
                    completed: report.totals.byStatus.completed,
                    noShow: report.totals.byStatus.no_show,
                    cancelled: report.totals.byStatus.cancelled,
                    booked: report.totals.byStatus.booked,
                  })}
                  table={{
                    caption: t("reports.chart.status"),
                    columns: [
                      t("reports.col.date"),
                      t("reports.status.completed"),
                      t("reports.status.booked"),
                      t("reports.status.no_show"),
                      t("reports.status.cancelled"),
                    ],
                    rows: report.series.map((d) => [
                      day(d.date),
                      String(d.byStatus.completed),
                      String(d.byStatus.booked),
                      String(d.byStatus.no_show),
                      String(d.byStatus.cancelled),
                    ]),
                  }}
                >
                  <StatusChart
                    series={report.series}
                    labels={{
                      completed: t("reports.status.completed"),
                      booked: t("reports.status.booked"),
                      no_show: t("reports.status.no_show"),
                      cancelled: t("reports.status.cancelled"),
                    }}
                  />
                </ChartFrame>
              </div>

              <section className="space-y-2" aria-labelledby="top-services">
                <h2 id="top-services" className="text-heading">
                  {t("reports.top.title")}
                </h2>
                <DataTable
                  label={t("reports.top.title")}
                  columns={topColumns}
                  data={topRows}
                  getRowId={(r) => r.name}
                  total={topRows.length}
                  page={1}
                  pageSize={Math.max(topRows.length, 1)}
                  paginate={false}
                  sorting={topSort}
                  onSortingChange={setTopSort}
                  onPageChange={() => {}}
                  empty={<p className="text-muted">{t("reports.top.empty")}</p>}
                />
              </section>

              <section className="space-y-2" aria-labelledby="by-staff">
                <h2 id="by-staff" className="text-heading">
                  {t("reports.staff.title")}
                </h2>
                <DataTable
                  label={t("reports.staff.title")}
                  columns={staffColumns}
                  data={staffRows}
                  getRowId={(r) => r.staffId}
                  total={staffRows.length}
                  page={1}
                  pageSize={Math.max(staffRows.length, 1)}
                  paginate={false}
                  sorting={staffSort}
                  onSortingChange={setStaffSort}
                  onPageChange={() => {}}
                  empty={<p className="text-muted">{t("reports.staff.empty")}</p>}
                />
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

function sortBy<T>(
  rows: T[],
  sorting: SortingState,
  getters: Record<string, (row: T) => string | number>,
): T[] {
  const [sort] = sorting;
  const get = sort ? getters[sort.id] : undefined;
  if (!sort || !get) return rows;
  return [...rows].sort(
    (a, b) => (get(a) < get(b) ? -1 : get(a) > get(b) ? 1 : 0) * (sort.desc ? -1 : 1),
  );
}
