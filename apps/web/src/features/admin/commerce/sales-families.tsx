import type { SalesFamilyTotal } from "@sob/contracts";
import { useId } from "react";
import { useI18n } from "~/i18n/react";
import { formatMoney } from "~/lib/format";

export function SalesFamilies({ rows }: { rows: SalesFamilyTotal[] }) {
  const { t, locale } = useI18n();
  const heading = useId();
  const basis = useId();
  return (
    <div className="space-y-2">
      <h4 id={heading} className="font-semibold">
        {t("accounting.families.title")}
      </h4>
      <p id={basis} className="max-w-prose text-sm text-muted">
        {t("accounting.families.basis")}
      </p>
      {rows.length ? (
        <section
          aria-labelledby={heading}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The table can scroll horizontally on narrow screens.
          tabIndex={0}
          className="overflow-x-auto rounded-xl border border-line bg-surface focus-visible:outline-2 focus-visible:outline-ring"
        >
          <table aria-labelledby={heading} aria-describedby={basis} className="w-full text-sm">
            <thead className="text-muted">
              <tr>
                <th scope="col" className="px-3 py-3 text-start font-medium">
                  {t("accounting.families.family")}
                </th>
                <th scope="col" className="px-3 py-3 text-end font-medium">
                  {t("accounting.families.amount")}
                </th>
                <th scope="col" className="px-3 py-3 text-end font-medium">
                  {t("accounting.tax")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.family} className="border-t border-line">
                  <th scope="row" className="px-3 py-2.5 text-start font-medium">
                    {t(`accounting.families.${row.family}`)}
                  </th>
                  <td className="whitespace-nowrap px-3 py-2.5 text-end tabular-nums">
                    {formatMoney(row.amountCents, "EUR", locale)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-end tabular-nums">
                    {formatMoney(row.taxCents, "EUR", locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <p className="text-sm text-muted">{t("accounting.families.empty")}</p>
      )}
    </div>
  );
}
