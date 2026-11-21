import type { ReportClients } from "@sob/contracts";
import { useId } from "react";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { formatDateWithYear, formatMoney } from "~/lib/format";
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

const frequencyBands = ["one", "two", "threeOrMore"] as const;
type Frequency = NonNullable<ReportClients["frequency"]>;

export function clientFrequencyReportCsv(frequency: Frequency) {
  const rows = frequencyBands.map((band) => [band, frequency[band]].join(","));
  return ["visit_frequency,clients", ...rows, ""].join("\r\n");
}

export function clientCollectionsReportCsv(
  collections: NonNullable<ReportClients["topCollections"]>,
) {
  const rows = collections.map(({ name, netCents }) => [csvCell(name), netCents, "EUR"].join(","));
  return ["client,net_cents,currency", ...rows, ""].join("\r\n");
}

export function ClientReportView({
  report,
  onExportGroups,
  onExportFrequency,
  onExportCollections,
}: {
  report: ReportClients;
  onExportGroups: () => void;
  onExportFrequency: () => void;
  onExportCollections: () => void;
}) {
  const { t, locale } = useI18n();
  const captionId = useId();
  const numbers = new Intl.NumberFormat(locale);
  const frequency = report.frequency;

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
        <section
          aria-labelledby={captionId}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus this scroll region.
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
        </section>
      ) : (
        <EmptyState title={t("reports.clients.empty")} />
      )}
      {report.groups && (
        <ClientBreakdown
          title={t("reports.clients.groups")}
          basis={t("reports.clients.groupsBasis")}
          rowHeading={t("reports.clients.group")}
          empty={t("reports.clients.groupsEmpty")}
          exportLabel={t("reports.clients.exportGroups")}
          onExport={onExportGroups}
          valueHeading={t("reports.clients")}
          rows={report.groups.map(({ name, clients }) => ({
            key: name,
            name,
            value: numbers.format(clients),
          }))}
        />
      )}
      {frequency && (
        <ClientBreakdown
          title={t("reports.clients.frequency")}
          basis={t("reports.clients.frequencyBasis")}
          rowHeading={t("reports.clients.visits")}
          empty={t("reports.clients.empty")}
          exportLabel={t("reports.clients.exportFrequency")}
          onExport={onExportFrequency}
          valueHeading={t("reports.clients")}
          rows={frequencyBands.map((band) => ({
            key: band,
            name: t(`reports.clients.frequency.${band}`),
            value: numbers.format(frequency[band]),
          }))}
        />
      )}
      {report.topCollections && (
        <ClientBreakdown
          title={t("reports.clients.collections")}
          basis={t("reports.clients.collectionsBasis")}
          rowHeading={t("reports.clients.customer")}
          valueHeading={t("reports.clients.netCollections")}
          empty={t("reports.clients.collectionsEmpty")}
          exportLabel={t("reports.clients.exportCollections")}
          onExport={onExportCollections}
          rows={report.topCollections.map(({ clientId, name, netCents }) => ({
            key: clientId,
            name,
            value: formatMoney(netCents, "EUR", locale),
          }))}
        />
      )}
    </div>
  );
}

function ClientBreakdown({
  title,
  basis,
  rowHeading,
  valueHeading,
  empty,
  exportLabel,
  onExport,
  rows,
}: {
  title: string;
  basis: string;
  rowHeading: string;
  valueHeading: string;
  empty: string;
  exportLabel: string;
  onExport: () => void;
  rows: { key: string; name: string; value: string }[];
}) {
  const headingId = useId();
  const hasRows = rows.length > 0;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-heading">
          {title}
        </h2>
        {hasRows && (
          <Button variant="secondary" onClick={onExport}>
            {exportLabel}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted">{basis}</p>
      {hasRows ? (
        <section
          aria-labelledby={headingId}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus this scroll region.
          tabIndex={0}
          className="max-h-[28rem] overflow-auto rounded-xl border border-line bg-surface focus-visible:outline-2 focus-visible:outline-ring"
        >
          <table aria-labelledby={headingId} className="w-full text-sm">
            <thead className="sticky top-0 bg-surface text-muted">
              <tr>
                <th scope="col" className="px-3 py-3 text-start font-medium">
                  {rowHeading}
                </th>
                <th scope="col" className="px-3 py-3 text-end font-medium">
                  {valueHeading}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, name, value }) => (
                <tr key={key} className="border-t border-line">
                  <th scope="row" className="wrap-anywhere px-3 py-2.5 text-start font-medium">
                    {name}
                  </th>
                  <td className="whitespace-nowrap px-3 py-2.5 text-end tabular-nums">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <EmptyState title={empty} />
      )}
    </section>
  );
}
