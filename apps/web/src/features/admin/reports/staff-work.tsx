import type { ReportStaffWorkPeriod } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatDateWithYear, formatDuration, formatTime, localDateOf } from "~/lib/format";
import { formatRate, OCCUPANCY_MINUTES } from "./logic";

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
}: {
  staffId: string;
  range: { from: string; to: string };
  onDownload: (data: string, filename: string) => void;
  viewerId?: string;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const [period, setPeriod] = useState<"selected" | "upcoming">("selected");
  const query = useQuery({
    queryKey: ["admin", "report", "staff-work", viewerId, staffId, range],
    queryFn: ({ signal }) => api().admin.staffWorkReport({ ...range, staffId }, signal),
  });
  const detail = query.data?.[period];
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
          <section
            aria-labelledby={`${id}-caption`}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the daily table on narrow screens.
            tabIndex={0}
            className="max-h-[26rem] max-w-full overflow-auto rounded-lg border border-line"
          >
            <table className="w-full border-separate border-spacing-0 text-sm">
              <caption id={`${id}-caption`} className="sr-only">
                {t(`reports.work.${period}`)}
              </caption>
              <thead className="sticky top-0 z-10 bg-surface text-left">
                <tr>
                  <th scope="col" className="sticky start-0 bg-surface p-3">
                    {t("reports.work.date")}
                  </th>
                  {OCCUPANCY_MINUTES.map((field) => (
                    <th key={field} scope="col" className="whitespace-nowrap p-3">
                      {t(`reports.occupancy.${field}`)}
                    </th>
                  ))}
                  <th scope="col" className="whitespace-nowrap p-3">
                    {t("reports.occupancy.rate")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.days.map((row) => (
                  <tr key={row.date}>
                    <th
                      scope="row"
                      className="sticky start-0 whitespace-nowrap border-t border-line bg-surface p-3 text-left font-medium"
                    >
                      {formatDateWithYear(row.date, locale)}
                    </th>
                    {OCCUPANCY_MINUTES.map((field) => (
                      <td
                        key={field}
                        className="whitespace-nowrap border-t border-line p-3 tabular-nums"
                      >
                        {formatDuration(row[field], locale)}
                      </td>
                    ))}
                    <td className="border-t border-line p-3 tabular-nums">
                      {formatRate(row.occupancyRate, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
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
