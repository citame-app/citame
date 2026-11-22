import type { PromotionCollection, SalesFamilyTotal } from "@sob/contracts";
import { useId } from "react";
import { useI18n } from "~/i18n/react";
import { formatMoney } from "~/lib/format";

type Heading = "h3" | "h4";
type MoneyRow = { key: string; label: string; amounts: number[] };

export function SalesFamilies({
  rows,
  headingLevel,
}: {
  rows: SalesFamilyTotal[];
  headingLevel: Heading;
}) {
  const { t } = useI18n();
  return (
    <FinancialBreakdown
      headingLevel={headingLevel}
      title={t("accounting.families.title")}
      basis={t("accounting.families.basis")}
      empty={t("accounting.families.empty")}
      labelColumn={t("accounting.families.family")}
      moneyColumns={[t("accounting.families.amount"), t("accounting.tax")]}
      rows={rows.map((row) => ({
        key: row.family,
        label: t(`accounting.families.${row.family}`),
        amounts: [row.amountCents, row.taxCents],
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
  const { t } = useI18n();
  return (
    <FinancialBreakdown
      headingLevel={headingLevel}
      title={t("accounting.promotions.title")}
      basis={t("accounting.promotions.basis")}
      empty={t("accounting.promotions.empty")}
      labelColumn={t("accounting.promotions.offer")}
      stackWhenNarrow
      moneyColumns={[t("accounting.collected"), t("accounting.refunded"), t("accounting.net")]}
      rows={rows.map((row) => ({
        key: JSON.stringify([row.name, row.code]),
        label: `${row.name} (${row.code})`,
        amounts: [row.collectedCents, row.refundedCents, row.netCents],
      }))}
    />
  );
}

function FinancialBreakdown({
  headingLevel: Heading,
  title,
  basis,
  empty,
  labelColumn,
  moneyColumns,
  rows,
  stackWhenNarrow = false,
}: {
  headingLevel: Heading;
  title: string;
  basis: string;
  empty: string;
  labelColumn: string;
  moneyColumns: string[];
  rows: MoneyRow[];
  stackWhenNarrow?: boolean;
}) {
  const { locale } = useI18n();
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
                  {moneyColumns.map((label) => (
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
                    {row.amounts.map((amount, index) => (
                      <td
                        key={moneyColumns[index]}
                        className="whitespace-nowrap border-t border-line px-3 py-2.5 text-end tabular-nums"
                      >
                        {formatMoney(amount, "EUR", locale)}
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
                    {row.amounts.map((amount, index) => (
                      <div key={moneyColumns[index]} className="space-y-0.5">
                        <dt className="text-xs text-muted">{moneyColumns[index]}</dt>
                        <dd className="text-sm tabular-nums">
                          {formatMoney(amount, "EUR", locale)}
                        </dd>
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
