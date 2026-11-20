import { type ReactNode, useId, useState } from "react";
import { useI18n } from "~/i18n/react";
import { Button } from "./button";

export interface ChartTable {
  caption: string;
  columns: string[];
  rows: string[][];
}

/**
 * Wraps a chart with everything a chart alone lacks: a heading, a one-sentence text summary for
 * screen readers (and everyone else), a clear empty state, and the same numbers as a real table.
 */
export function ChartFrame({
  title,
  summary,
  table,
  empty = false,
  children,
}: {
  title: string;
  summary: string;
  table: ChartTable;
  empty?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();
  const tableId = useId();
  return (
    <figure
      aria-labelledby={titleId}
      className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface p-4 sm:p-5"
    >
      <figcaption className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id={titleId} className="font-display text-lg font-semibold">
            {title}
          </h3>
          <p className="mt-0.5 text-sm text-muted">{summary}</p>
        </div>
        {!empty && (
          <Button
            variant="ghost"
            aria-expanded={showTable}
            aria-controls={tableId}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? t("chart.tableHide") : t("chart.tableToggle")}
          </Button>
        )}
      </figcaption>
      {empty ? (
        <p className="grid min-h-40 place-items-center rounded-lg border border-dashed border-line-strong text-muted">
          {t("chart.empty")}
        </p>
      ) : (
        <div role="img" aria-label={summary} className="min-w-0">
          {children}
        </div>
      )}
      <div id={tableId}>
        {showTable && !empty && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{table.caption}</caption>
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  {table.columns.map((column) => (
                    <th key={column} scope="col" className="px-2 py-2 font-medium">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.join("|")} className="border-b border-line/60 last:border-0">
                    {row.map((cell, index) => (
                      <td
                        key={`${table.columns[index]}-${cell}`}
                        className="px-2 py-2 tabular-nums"
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </figure>
  );
}
