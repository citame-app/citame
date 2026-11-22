import type {
  PromotionCollection,
  RevenueForecast,
  SalesFamilyTotal,
  SettledSaleItem,
} from "@sob/contracts";
import { type ReactNode, useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { useI18n } from "~/i18n/react";
import { formatDateWithYear, formatMoney, formatTime, localDateOf } from "~/lib/format";

type Heading = "h3" | "h4";
type BreakdownRow = { key: string; label: string; values: string[] };
const PAGE_SIZE = 24;

export function SalesFamilies({
  rows,
  headingLevel,
}: {
  rows: SalesFamilyTotal[];
  headingLevel: Heading;
}) {
  const { locale, t } = useI18n();
  return (
    <FinancialBreakdown
      headingLevel={headingLevel}
      title={t("accounting.families.title")}
      basis={t("accounting.families.basis")}
      empty={t("accounting.families.empty")}
      labelColumn={t("accounting.families.family")}
      columns={[t("accounting.families.amount"), t("accounting.tax")]}
      rows={rows.map((row) => ({
        key: row.family,
        label: t(`accounting.families.${row.family}`),
        values: [row.amountCents, row.taxCents].map((cents) => formatMoney(cents, "EUR", locale)),
      }))}
    />
  );
}

export function PromotionCollections({
  rows,
  headingLevel,
}: {
  rows: PromotionCollection[];
  headingLevel: Heading;
}) {
  const { locale, t } = useI18n();
  return (
    <FinancialBreakdown
      headingLevel={headingLevel}
      title={t("accounting.promotions.title")}
      basis={t("accounting.promotions.basis")}
      empty={t("accounting.promotions.empty")}
      labelColumn={t("accounting.promotions.offer")}
      stackWhenNarrow
      columns={[t("accounting.collected"), t("accounting.refunded"), t("accounting.net")]}
      rows={rows.map((row) => ({
        key: JSON.stringify([row.name, row.code]),
        label: `${row.name} (${row.code})`,
        values: [row.collectedCents, row.refundedCents, row.netCents].map((cents) =>
          formatMoney(cents, "EUR", locale),
        ),
      }))}
    />
  );
}

export function SalesItems({
  rows,
  headingLevel,
}: {
  rows: SettledSaleItem[];
  headingLevel: Heading;
}) {
  const { locale, t } = useI18n();
  const [requestedPage, setPage] = useState(0);
  const pageCount = Math.ceil(rows.length / PAGE_SIZE);
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
  const number = new Intl.NumberFormat(locale);
  return (
    <>
      <FinancialBreakdown
        headingLevel={headingLevel}
        title={t("accounting.items.title")}
        basis={t("accounting.items.basis")}
        empty={t("accounting.families.empty")}
        labelColumn={t("accounting.items.item")}
        columns={[
          t("accounting.items.quantity"),
          t("accounting.families.amount"),
          t("accounting.tax"),
        ]}
        stackWhenNarrow
        rows={rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row) => {
          const family = t(`accounting.families.${row.family}`);
          return {
            key: JSON.stringify([row.family, row.itemId, row.name]),
            label: row.name ? `${row.name} · ${family}` : family,
            values: [
              row.quantity === null ? "—" : number.format(row.quantity),
              formatMoney(row.amountCents, "EUR", locale),
              formatMoney(row.taxCents, "EUR", locale),
            ],
          };
        })}
      />
      <BreakdownPager
        page={page}
        pageCount={pageCount}
        setPage={setPage}
        previous={t("accounting.items.previous")}
        next={t("accounting.items.next")}
      />
    </>
  );
}

export function ScheduledRevenue({
  forecast,
  headingLevel,
  timezone,
}: {
  forecast: RevenueForecast;
  headingLevel: Heading;
  timezone: string;
}) {
  const { locale, t } = useI18n();
  const [requestedPage, setPage] = useState(0);
  const pageCount = Math.ceil(forecast.rows.length / PAGE_SIZE);
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
  const amounts = new Map<string, number>();
  let pending = 0;
  for (const row of forecast.rows) {
    if (row.currency === null) pending += row.appointmentLines;
    else amounts.set(row.currency, (amounts.get(row.currency) ?? 0) + row.amountCents);
  }
  const checkedAt = `${formatDateWithYear(localDateOf(forecast.asOf, timezone), locale)} · ${formatTime(forecast.asOf, timezone, locale)}`;
  return (
    <>
      <FinancialBreakdown
        headingLevel={headingLevel}
        title={t("accounting.forecast.title")}
        basis={t("accounting.forecast.basis")}
        empty={t("accounting.forecast.empty")}
        labelColumn={t("accounting.forecast.date")}
        columns={[t("accounting.forecast.lines"), t("accounting.forecast.value")]}
        stackWhenNarrow
        summary={
          <div className="space-y-2">
            <p className="text-sm text-muted">
              {t("accounting.forecast.checkedAt", { at: checkedAt })}
            </p>
            {forecast.rows.length > 0 && (
              <dl className="flex flex-wrap gap-x-6 gap-y-2 rounded-xl border border-line bg-surface p-3 text-sm">
                {[...amounts]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([currency, cents]) => (
                    <div key={currency}>
                      <dt className="text-muted">{t("accounting.forecast.total", { currency })}</dt>
                      <dd className="font-semibold tabular-nums">
                        {formatMoney(cents, currency, locale)}
                      </dd>
                    </div>
                  ))}
                <div>
                  <dt className="text-muted">{t("accounting.forecast.pendingLines")}</dt>
                  <dd className="font-semibold tabular-nums">{pending.toLocaleString(locale)}</dd>
                </div>
              </dl>
            )}
          </div>
        }
        rows={forecast.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row) => {
          const date = formatDateWithYear(row.date, locale);
          return {
            key: JSON.stringify([row.date, row.currency]),
            label: row.currency ? `${date} · ${row.currency}` : date,
            values: [
              row.appointmentLines.toLocaleString(locale),
              row.currency === null
                ? t("accounting.forecast.pending")
                : formatMoney(row.amountCents, row.currency, locale),
            ],
          };
        })}
      />
      <BreakdownPager
        page={page}
        pageCount={pageCount}
        setPage={setPage}
        previous={t("table.previous")}
        next={t("table.next")}
      />
    </>
  );
}

function BreakdownPager({
  page,
  pageCount,
  setPage,
  previous,
  next,
}: {
  page: number;
  pageCount: number;
  setPage: (page: number) => void;
  previous: string;
  next: string;
}) {
  if (pageCount < 2) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button type="button" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
        {previous}
      </Button>
      <span aria-live="polite" className="text-sm tabular-nums text-muted">
        {page + 1} / {pageCount}
      </span>
      <Button
        type="button"
        variant="ghost"
        disabled={page + 1 >= pageCount}
        onClick={() => setPage(page + 1)}
      >
        {next}
      </Button>
    </div>
  );
}

function FinancialBreakdown({
  headingLevel: Heading,
  title,
  basis,
  empty,
  labelColumn,
  columns,
  rows,
  summary,
  stackWhenNarrow = false,
}: {
  headingLevel: Heading;
  title: string;
  basis: string;
  empty: string;
  labelColumn: string;
  columns: string[];
  rows: BreakdownRow[];
  summary?: ReactNode;
  stackWhenNarrow?: boolean;
}) {
  const headingId = useId();
  const basisId = useId();
  return (
    <div className="@container min-w-0 space-y-2">
      <Heading id={headingId} className="font-semibold">
        {title}
      </Heading>
      <p id={basisId} className="max-w-prose text-sm text-muted">
        {basis}
      </p>
      {summary}
      {rows.length ? (
        <>
          <section
            aria-labelledby={headingId}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the table.
            tabIndex={0}
            className={`max-h-96 overflow-auto rounded-xl border border-line bg-surface focus-visible:outline-2 focus-visible:outline-ring ${stackWhenNarrow ? "hidden @lg:block" : ""}`}
          >
            <table
              aria-labelledby={headingId}
              aria-describedby={basisId}
              className="w-full border-separate border-spacing-0 text-sm"
            >
              <thead className="sticky top-0 z-20 bg-surface text-muted">
                <tr>
                  <th
                    scope="col"
                    className="sticky start-0 bg-surface px-3 py-3 text-start font-medium"
                  >
                    {labelColumn}
                  </th>
                  {columns.map((label) => (
                    <th key={label} scope="col" className="px-3 py-3 text-end font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <th
                      scope="row"
                      className="sticky start-0 z-10 max-w-48 border-t border-line bg-surface px-3 py-2.5 text-start font-medium [overflow-wrap:anywhere]"
                    >
                      {row.label}
                    </th>
                    {row.values.map((value, index) => (
                      <td
                        key={columns[index]}
                        className="whitespace-nowrap border-t border-line px-3 py-2.5 text-end tabular-nums"
                      >
                        {value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {stackWhenNarrow && (
            <ul
              aria-labelledby={headingId}
              aria-describedby={basisId}
              className="divide-y divide-line rounded-xl border border-line bg-surface @lg:hidden"
            >
              {rows.map((row) => (
                <li key={row.key} className="space-y-2 p-3">
                  <p className="text-sm font-semibold [overflow-wrap:anywhere]">{row.label}</p>
                  <dl className="flex flex-wrap gap-x-4 gap-y-2">
                    {row.values.map((value, index) => (
                      <div key={columns[index]} className="space-y-0.5">
                        <dt className="text-xs text-muted">{columns[index]}</dt>
                        <dd className="text-sm tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="text-sm text-muted">{empty}</p>
      )}
    </div>
  );
}
