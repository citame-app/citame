import type { ReportClients } from "@sob/contracts";
import { useId } from "react";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { formatDateWithYear } from "~/lib/format";
import { csvCell } from "./logic";

export function clientReportCsv(report: ReportClients) {
  const rows = report.rows.map(({ date, newClients, returningClients }) =>
    [date, newClients, returningClients].join(","),
  );
  return ["date,new_clients,returning_clients", ...rows, ""].join("\r\n");
}

export function clientGroupReportCsv(groups: NonNullable<ReportClients["groups"]>) {
  const rows = groups.map(({ name, clients }) => [csvCell(name), clients].join(","));
  return ["group,clients", ...rows, ""].join("\r\n");
}

export function ClientReportView({
  report,
  onExportGroups,
}: {
  report: ReportClients;
  onExportGroups: () => void;
}) {
  const { t, locale } = useI18n();
  const captionId = useId();
  const groupsId = useId();
  const numbers = new Intl.NumberFormat(locale);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-heading">{t("reports.clients.title")}</h2>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("reports.clients.basis")}</p>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-line bg-surface p-4">
          <dt className="text-sm text-muted">{t("reports.clients.new")}</dt>
          <dd className="mt-1 font-display text-2xl font-semibold tabular-nums">
            {numbers.format(report.totals.newClients)}
          </dd>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <dt className="text-sm text-muted">{t("reports.clients.returning")}</dt>
          <dd className="mt-1 font-display text-2xl font-semibold tabular-nums">
            {numbers.format(report.totals.returningClients)}
          </dd>
        </div>
      </dl>
      {report.rows.length ? (
        <div
          role="region"
          aria-labelledby={captionId}
          tabIndex={0}
          className="max-h-[28rem] overflow-auto rounded-xl border border-line bg-surface focus-visible:outline-2 focus-visible:outline-ring"
        >
          <table className="w-full text-sm">
            <caption id={captionId} className="sr-only">
              {t("reports.clients.daily")}
            </caption>
            <thead className="sticky top-0 bg-surface text-muted">
              <tr>
                <th scope="col" className="px-3 py-3 text-start font-medium">
                  {t("reports.col.date")}
                </th>
                <th scope="col" className="px-3 py-3 text-end font-medium">
                  {t("reports.clients.new")}
                </th>
                <th scope="col" className="px-3 py-3 text-end font-medium">
                  {t("reports.clients.returning")}
                </th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.date} className="border-t border-line">
                  <th scope="row" className="px-3 py-2.5 text-start font-medium">
                    <time dateTime={row.date}>{formatDateWithYear(row.date, locale)}</time>
                  </th>
                  <td className="px-3 py-2.5 text-end tabular-nums">
                    {numbers.format(row.newClients)}
                  </td>
                  <td className="px-3 py-2.5 text-end tabular-nums">
                    {numbers.format(row.returningClients)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title={t("reports.clients.empty")} />
      )}
      {report.groups && (
        <section aria-labelledby={groupsId} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={groupsId} className="text-heading">
              {t("reports.clients.groups")}
            </h2>
            {report.groups.length > 0 && (
              <Button variant="secondary" onClick={onExportGroups}>
                {t("reports.clients.exportGroups")}
              </Button>
            )}
          </div>
          <p className="text-sm text-muted">{t("reports.clients.groupsBasis")}</p>
          {report.groups.length > 0 ? (
            <div
              role="region"
              aria-labelledby={groupsId}
              tabIndex={0}
              className="max-h-[28rem] overflow-auto rounded-xl border border-line bg-surface focus-visible:outline-2 focus-visible:outline-ring"
            >
              <table aria-labelledby={groupsId} className="w-full text-sm">
                <thead className="sticky top-0 bg-surface text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-3 text-start font-medium">
                      {t("reports.clients.group")}
                    </th>
                    <th scope="col" className="px-3 py-3 text-end font-medium">
                      {t("reports.clients")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.groups.map(({ name, clients }) => (
                    <tr key={name} className="border-t border-line">
                      <th scope="row" className="wrap-anywhere px-3 py-2.5 text-start font-medium">
                        {name}
                      </th>
                      <td className="px-3 py-2.5 text-end tabular-nums">
                        {numbers.format(clients)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title={t("reports.clients.groupsEmpty")} />
          )}
        </section>
      )}
    </div>
  );
}
