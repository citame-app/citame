import {
  type ReportOutcome,
  type ReportOutcomeRow,
  type ReportQuery,
  reportOutcomeSchema,
} from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { buttonClasses } from "~/components/ui/button";
import { DataTable, type DataTableFeatures } from "~/components/ui/data-table";
import { DownloadIcon } from "~/components/ui/icons";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatDateWithYear, formatTime, localDateOf } from "~/lib/format";

const columns = createColumnHelper<DataTableFeatures, ReportOutcomeRow>();

export function AppointmentOutcomes({ filters }: { filters: ReportQuery }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ReportOutcome>("cancelled");
  return (
    <details
      className="rounded-xl border border-line bg-surface p-4"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-heading">{t("reports.outcomes.title")}</summary>
      {open && (
        <OutcomeTable
          key={JSON.stringify([filters.from, filters.to, filters.staffId, filters.currency])}
          filters={filters}
          status={status}
          onStatusChange={setStatus}
        />
      )}
    </details>
  );
}

function OutcomeTable({
  filters,
  status,
  onStatusChange,
}: {
  filters: ReportQuery;
  status: ReportOutcome;
  onStatusChange: (status: ReportOutcome) => void;
}) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const params = { ...filters, status, page };
  const query = useQuery({
    queryKey: ["admin", "report", "outcomes", params],
    queryFn: () => api().admin.reportOutcomes(params),
  });
  const timezone = query.data?.timezone ?? "UTC";
  const fields = useMemo(
    () =>
      columns.columns([
        columns.accessor("startsAt", {
          header: t("reports.col.date"),
          enableSorting: false,
          meta: { cardTitle: true },
          cell: ({ getValue }) => {
            const start = getValue();
            const date = formatDateWithYear(localDateOf(start, timezone), locale);
            return `${date} · ${formatTime(start, timezone, locale)}`;
          },
        }),
        columns.accessor("client", {
          header: t("reports.outcomes.client"),
          enableSorting: false,
          cell: ({ getValue }) => getValue() ?? t("reports.outcomes.removedClient"),
        }),
        columns.accessor("staff", {
          header: t("reports.col.staff"),
          enableSorting: false,
        }),
        columns.accessor("services", {
          header: t("reports.outcomes.services"),
          enableSorting: false,
          cell: ({ getValue }) => getValue().join(" · "),
        }),
      ]),
    [locale, t, timezone],
  );
  const exportParams = new URLSearchParams({ from: filters.from, to: filters.to, status });
  if (filters.staffId) exportParams.set("staffId", filters.staffId);
  if (filters.currency) exportParams.set("currency", filters.currency);

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SelectField
          label={t("reports.outcomes.status")}
          value={status}
          options={reportOutcomeSchema.options.map((value) => ({
            value,
            label: t(`reports.outcomes.${value}`),
          }))}
          onChange={(value) => {
            const parsed = reportOutcomeSchema.safeParse(value);
            if (!parsed.success) return;
            onStatusChange(parsed.data);
            setPage(1);
          }}
        />
        {!!query.data?.total && (
          <a
            className={buttonClasses({ variant: "secondary" })}
            href={`/api/admin/reports/outcomes/export?${exportParams}`}
            download
          >
            <DownloadIcon />
            {t(`reports.outcomes.export.${status}`)}
          </a>
        )}
      </div>
      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <DataTable
          label={t(`reports.outcomes.${status}`)}
          columns={fields}
          data={query.data?.rows ?? []}
          getRowId={(row) => row.id}
          total={query.data?.total ?? 0}
          page={query.data?.page ?? 1}
          pageSize={query.data?.pageSize ?? 25}
          sorting={[]}
          onSortingChange={() => {}}
          onPageChange={setPage}
          loading={query.isPending}
          empty={<p className="text-muted">{t("reports.outcomes.empty")}</p>}
        />
      )}
    </div>
  );
}
