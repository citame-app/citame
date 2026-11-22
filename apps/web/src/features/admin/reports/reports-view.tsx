import {
  type ReportBreakdownKind,
  type ReportBreakdownRow,
  type ReportSummary,
  reportBreakdownKinds,
  type UserRole,
} from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, type SortingState } from "@tanstack/react-table";
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
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
import { api } from "~/lib/api/instance";
import { formatDateWithYear, formatMoney, localDateOf } from "~/lib/format";
import { useNow } from "../use-now";
import { AppointmentOutcomes } from "./appointment-outcomes";
import {
  ClientReportView,
  clientCollectionsReportCsv,
  clientFrequencyReportCsv,
  clientGroupReportCsv,
  clientReportCsv,
} from "./client-report";
import { formatRate, REPORT_PRESETS, reportToCsv, sortBy } from "./logic";
import { type ReportsSearch, rangeError, resolveRange } from "./range";
import { StaffOccupancy } from "./staff-occupancy";

const topHelper = createColumnHelper<DataTableFeatures, ReportSummary["topServices"][number]>();
const staffHelper = createColumnHelper<DataTableFeatures, ReportSummary["perStaff"][number]>();
const breakdownHelper = createColumnHelper<DataTableFeatures, ReportBreakdownRow>();
const breakdownStatuses = ["booked", "completed", "cancelled", "no_show"] as const;
const BREAKDOWN_PAGE_SIZE = 15;
const RevenueChart = lazy(() =>
  import("./charts").then((module) => ({ default: module.RevenueChart })),
);
const StatusChart = lazy(() =>
  import("./charts").then((module) => ({ default: module.StatusChart })),
);

/** The summary and data table are independent of SVG plotting and remain immediately available. */
function ReportPlot({ children }: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!container.current || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: "80px" },
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={container} className="h-64 min-w-0">
      {visible && <Suspense fallback={null}>{children}</Suspense>}
    </div>
  );
}

export function ReportsView({
  search,
  onSearchChange,
  role,
  now: fixedNow,
  showClients = false,
}: {
  search: ReportsSearch;
  onSearchChange: (search: ReportsSearch) => void;
  role: UserRole;
  now?: Date;
  showClients?: boolean;
}) {
  const { t, locale, timeZone } = useI18n();
  const toast = useToast();
  const ticking = useNow(60_000);
  const now = fixedNow ?? ticking;
  const today = localDateOf(now.toISOString(), timeZone);
  const range = resolveRange(search, today);
  const problem = rangeError(range);
  const staff = useQuery({ ...adminStaffQuery, enabled: role === "owner" });
  const scoped = { ...range, ...(search.staff ? { staffId: search.staff } : {}) };
  const query = useQuery({
    ...reportQuery({
      ...scoped,
      currency: search.currency,
    }),
    enabled: problem === null && !showClients,
  });
  const clients = useQuery({
    queryKey: ["admin", "report", "clients", scoped],
    queryFn: () => api().admin.clientReport(scoped),
    enabled: problem === null && showClients,
  });
  const [topSort, setTopSort] = useState<SortingState>([{ id: "count", desc: true }]);
  const [staffSort, setStaffSort] = useState<SortingState>([{ id: "revenue", desc: true }]);

  const report = showClients ? undefined : query.data;
  const canExportSummary =
    report &&
    (report.totals.appointments > 0 || report.perStaff.some(({ occupancy }) => occupancy));
  const currency = report?.currency ?? "ARS";
  const money = (cents: number) => formatMoney(cents, currency, locale);
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
          cell: (c) => {
            const { count, unpricedServices } = c.row.original;
            if (unpricedServices === count) return t("reports.revenue.noKnownPrice");
            const amount = formatMoney(c.getValue(), currency, locale);
            return unpricedServices
              ? `${amount} · ${t("reports.revenue.pendingCount", { count: unpricedServices })}`
              : amount;
          },
        }),
      ]),
    [t, locale, currency],
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
          cell: (c) => formatMoney(c.getValue(), currency, locale),
        }),
      ]),
    [t, locale, currency],
  );

  function exportCsv() {
    const data =
      showClients && clients.data
        ? clientReportCsv(clients.data)
        : report
          ? reportToCsv(report)
          : undefined;
    if (!data) return;
    downloadCsv(data, showClients ? "clients" : "report");
  }

  function downloadCsv(data: string, name: string) {
    const blob = new Blob([data], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-${range.from}-${range.to}.csv`;
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
        {
          label: t("reports.tile.revenue"),
          value: money(totals.revenueCents),
          hint: totals.unpricedServices
            ? t("reports.revenue.pending", { count: totals.unpricedServices })
            : undefined,
        },
        {
          label: t("reports.tile.noShowRate"),
          value: formatRate(totals.noShowRate, locale),
          hint: totals.noShowRate === null ? t("reports.tile.noShowRate.none") : undefined,
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="reports-toolbar flex flex-wrap items-end gap-3">
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
            className="w-52 max-w-full"
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
        {!showClients && (
          <SelectField
            className="w-28 max-w-full"
            label={t("services.field.currency")}
            value={report ? currency : ""}
            disabled={!report?.currencies?.length}
            options={
              report
                ? [...new Set([currency, ...(report.currencies ?? [])])].map((value) => ({
                    value,
                    label: value,
                  }))
                : [{ value: "", label: "—" }]
            }
            onChange={(value) => onSearchChange({ ...search, currency: value })}
          />
        )}
        <Button
          variant="secondary"
          className="ml-auto"
          disabled={
            Boolean(problem) || (showClients ? !clients.data?.rows.length : !canExportSummary)
          }
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

      {showClients &&
        !problem &&
        (clients.isPending ? (
          <Skeleton className="h-48" />
        ) : clients.isError ? (
          <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />
        ) : (
          <ClientReportView
            report={clients.data}
            onExportGroups={() => {
              const groups = clients.data?.groups;
              if (groups?.length) downloadCsv(clientGroupReportCsv(groups), "client-groups");
            }}
            onExportFrequency={() => {
              const frequency = clients.data?.frequency;
              if (frequency) downloadCsv(clientFrequencyReportCsv(frequency), "client-frequency");
            }}
            onExportCollections={() => {
              const collections = clients.data?.topCollections;
              if (collections?.length)
                downloadCsv(clientCollectionsReportCsv(collections), "client-net-collections");
            }}
          />
        ))}
      {!showClients && !problem && query.isPending && (
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
      {!showClients && !problem && query.isError && (
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
                  {tile.hint && (
                    <dd className="mt-0.5 font-sans text-xs text-muted">{tile.hint}</dd>
                  )}
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
                  <ReportPlot>
                    <RevenueChart series={report.series} currency={currency} />
                  </ReportPlot>
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
                  <ReportPlot>
                    <StatusChart
                      series={report.series}
                      labels={{
                        completed: t("reports.status.completed"),
                        booked: t("reports.status.booked"),
                        no_show: t("reports.status.no_show"),
                        cancelled: t("reports.status.cancelled"),
                      }}
                    />
                  </ReportPlot>
                </ChartFrame>
              </div>

              {report.appointmentBreakdown && (
                <AppointmentBreakdown breakdown={report.appointmentBreakdown} />
              )}

              <AppointmentOutcomes
                filters={{ ...range, staffId: search.staff, currency: report.currency }}
              />

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
          <StaffOccupancy staff={report.perStaff} />
        </>
      )}
    </div>
  );
}

function AppointmentBreakdown({
  breakdown,
}: {
  breakdown: NonNullable<ReportSummary["appointmentBreakdown"]>;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<ReportBreakdownKind>("hour");
  const [requestedPage, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>([]);
  const columns = useMemo(
    () =>
      breakdownHelper.columns([
        breakdownHelper.accessor((row) => row.label ?? t("reports.breakdown.uncategorized"), {
          id: "label",
          header: t(`reports.breakdown.${kind}`),
          meta: { cardTitle: true },
        }),
        breakdownHelper.accessor("appointments", {
          header: t("reports.col.appointments"),
          meta: { numeric: true },
        }),
        ...breakdownStatuses.map((status) =>
          breakdownHelper.accessor((row) => row.byStatus[status], {
            id: status,
            header: t(`reports.status.${status}`),
            meta: { numeric: true },
          }),
        ),
      ]),
    [kind, t],
  );
  const rows = useMemo(
    () =>
      sortBy(breakdown[kind], sorting, {
        label: (row) => (row.label ?? t("reports.breakdown.uncategorized")).toLowerCase(),
        appointments: (row) => row.appointments,
        booked: (row) => row.byStatus.booked,
        completed: (row) => row.byStatus.completed,
        cancelled: (row) => row.byStatus.cancelled,
        no_show: (row) => row.byStatus.no_show,
      }),
    [breakdown, kind, sorting, t],
  );
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(rows.length / BREAKDOWN_PAGE_SIZE)));
  return (
    <section className="space-y-2" aria-labelledby="appointments-breakdown">
      <h2 id="appointments-breakdown" className="text-heading">
        {t("reports.breakdown.title")}
      </h2>
      <DataTable
        label={t("reports.breakdown.title")}
        columns={columns}
        data={rows.slice((page - 1) * BREAKDOWN_PAGE_SIZE, page * BREAKDOWN_PAGE_SIZE)}
        getRowId={(row) => row.key}
        total={rows.length}
        page={page}
        pageSize={BREAKDOWN_PAGE_SIZE}
        paginate={rows.length > BREAKDOWN_PAGE_SIZE}
        sorting={sorting}
        onSortingChange={(next) => {
          setSorting(next);
          setPage(1);
        }}
        onPageChange={setPage}
        empty={<p className="text-muted">{t("reports.breakdown.empty")}</p>}
        toolbar={
          <SelectField
            className="w-52 max-w-full"
            label={t("reports.breakdown.group")}
            value={kind}
            options={reportBreakdownKinds.map((value) => ({
              value,
              label: t(`reports.breakdown.${value}`),
            }))}
            onChange={(value) => {
              const next = reportBreakdownKinds.find((option) => option === value);
              if (!next) return;
              setKind(next);
              setSorting([]);
              setPage(1);
            }}
          />
        }
      />
    </section>
  );
}
