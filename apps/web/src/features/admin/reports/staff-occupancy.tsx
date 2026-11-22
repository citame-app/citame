import type { ReportSummary } from "@sob/contracts";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { DataTable, type DataTableFeatures } from "~/components/ui/data-table";
import { useI18n } from "~/i18n/react";
import { formatRate } from "./logic";

type StaffRow = ReportSummary["perStaff"][number];
const helper = createColumnHelper<DataTableFeatures, StaffRow>();
const minutes = [
  "scheduledMinutes",
  "blockedMinutes",
  "reservedMinutes",
  "completedMinutes",
  "noShowMinutes",
] as const;

export function StaffOccupancy({ staff }: { staff: StaffRow[] }) {
  const { t, locale } = useI18n();
  const columns = useMemo(() => {
    const value = new Intl.NumberFormat(locale);
    return helper.columns([
      helper.accessor("displayName", {
        header: t("reports.col.staff"),
        meta: { cardTitle: true },
        enableSorting: false,
      }),
      ...minutes.map((key) =>
        helper.accessor((row) => row.occupancy?.[key], {
          id: key,
          header: t(`reports.occupancy.${key}`),
          meta: { numeric: true },
          enableSorting: false,
          cell: ({ getValue }) => {
            const count = getValue();
            return count === undefined ? "—" : value.format(count);
          },
        }),
      ),
      helper.accessor((row) => row.occupancy?.occupancyRate, {
        id: "occupancyRate",
        header: t("reports.occupancy.rate"),
        meta: { numeric: true },
        enableSorting: false,
        cell: ({ getValue }) => formatRate(getValue() ?? null, locale),
      }),
    ]);
  }, [t, locale]);

  if (!staff.some((row) => row.occupancy)) return null;
  const title = t("reports.occupancy.title");
  return (
    <section className="space-y-2" aria-labelledby="staff-occupancy">
      <h2 id="staff-occupancy" className="text-heading">
        {title}
      </h2>
      <p className="text-sm text-muted">{t("reports.occupancy.help")}</p>
      <DataTable
        label={title}
        columns={columns}
        data={staff}
        getRowId={(row) => row.staffId}
        total={staff.length}
        page={1}
        pageSize={staff.length}
        paginate={false}
        onPageChange={() => {}}
        sorting={[]}
        onSortingChange={() => {}}
      />
    </section>
  );
}
