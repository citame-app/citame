import type { ReportStaffWorkDay, ReportStaffWorkPeriod } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, type SortingState } from "@tanstack/react-table";
import { useId, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { DataTable, type DataTableFeatures } from "~/components/ui/data-table";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatDateWithYear, formatDuration, formatTime, localDateOf } from "~/lib/format";
import { formatRate, OCCUPANCY_MINUTES, sortBy } from "./logic";

const dayColumn = createColumnHelper<DataTableFeatures, ReportStaffWorkDay>();
const PAGE_SIZE = 15;
const dayOrder = {
  date: (day: ReportStaffWorkDay) => day.date,
  rate: (day: ReportStaffWorkDay) => day.occupancyRate ?? -1,
  ...Object.fromEntries(
    OCCUPANCY_MINUTES.map((field) => [field, (day: ReportStaffWorkDay) => day[field]]),
  ),
};

function WorkDays({ label, days }: { label: string; days: ReportStaffWorkDay[] }) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>([{ id: "date", desc: false }]);
  const columns = useMemo(
    () =>
      dayColumn.columns([
        dayColumn.accessor("date", {
          header: t("reports.work.date"),
          meta: { cardTitle: true },
          cell: ({ getValue }) => formatDateWithYear(getValue(), locale),
        }),
        ...OCCUPANCY_MINUTES.map((field) =>
          dayColumn.accessor(field, {
            header: t(`reports.occupancy.${field}`),
            meta: { numeric: true },
            cell: ({ getValue }) => formatDuration(getValue(), locale),
          }),
        ),
        dayColumn.accessor("occupancyRate", {
          id: "rate",
          header: t("reports.occupancy.rate"),
          meta: { numeric: true },
          cell: ({ getValue }) => formatRate(getValue(), locale),
        }),
      ]),
    [t, locale],
  );
  const rows = useMemo(() => sortBy(days, sorting, dayOrder), [days, sorting]);
  return (
    <DataTable
      columns={columns}
      data={rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)}
      getRowId={(row) => row.date}
      label={label}
      total={rows.length}
      page={page}
      pageSize={PAGE_SIZE}
      paginate={rows.length > PAGE_SIZE}
      sorting={sorting}
      onSortingChange={(next) => {
        setSorting(next);
        setPage(1);
      }}
      onPageChange={setPage}
    />
  );
}

function dailyCsv(period: ReportStaffWorkPeriod) {
  const header =
    "date,scheduled_minutes,blocked_minutes,reserved_minutes,completed_minutes,no_show_minutes,occupancy_rate";
  const rows = period.days.map((day) =>
    [day.date, ...OCCUPANCY_MINUTES.map((field) => day[field]), day.occupancyRate ?? ""].join(","),
  );
  return [header, ...rows].join("\r\n") + "\r\n";
}

export function StaffWorkReport({
  staffId,
  range,
  onDownload,
  viewerId,
  today,
}: {
  staffId: string;
  range: { from: string; to: string };
  onDownload: (data: string, filename: string) => void;
  viewerId?: string;
  today?: string;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const [period, setPeriod] = useState<"selected" | "upcoming">("selected");
  const query = useQuery({
    queryKey: ["admin", "report", "staff-work", viewerId, staffId, range, today],
    queryFn: ({ signal }) => api().admin.staffWorkReport({ ...range, staffId }, signal),
  });
  const denied =
    query.error instanceof ApiError && (query.error.status === 401 || query.error.status === 403);
  const detail = denied ? undefined : query.data?.[period];
  const timeZone = query.data?.timezone ?? "UTC";
  const stamp = (instant: string) =>
    `${formatDateWithYear(localDateOf(instant, timeZone), locale)} · ${formatTime(instant, timeZone, locale)}`;
  return (
    <section className="min-w-0 space-y-3" aria-labelledby={id}>
      <h2 id={id} className="text-heading">
        {t("reports.work.title")}
      </h2>
      <p className="text-sm text-muted">{t("reports.work.basis")}</p>
      <fieldset className="commerce-section-nav" aria-labelledby={id}>
        {(["selected", "upcoming"] as const).map((mode) => (
          <button
            type="button"
            key={mode}
            aria-pressed={period === mode}
            onClick={() => setPeriod(mode)}
          >
            {t(`reports.work.${mode}`)}
          </button>
        ))}
      </fieldset>
      {query.isPending && <Skeleton className="h-40" />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {detail && (
        <>
          <Button
            variant="secondary"
            onClick={() =>
              onDownload(dailyCsv(detail), `staff-work-${detail.from}-${detail.to}.csv`)
            }
          >
            {t("reports.work.export")}
          </Button>
          <WorkDays
            key={`${period}-${detail.from}-${detail.to}`}
            label={t(`reports.work.${period}`)}
            days={detail.days}
          />
          <h3 className="font-medium">{t("reports.work.unavailable")}</h3>
          {detail.unavailable.length ? (
            <ul className="max-h-48 list-disc space-y-1 overflow-auto ps-5 text-sm">
              {detail.unavailable.map(({ startsAt, endsAt }) => (
                <li key={startsAt}>
                  {stamp(startsAt)} – {stamp(endsAt)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">{t("reports.work.none")}</p>
          )}
        </>
      )}
    </section>
  );
}
