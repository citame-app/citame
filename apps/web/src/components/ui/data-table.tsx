import { Popover } from "@base-ui/react/popover";
import {
  type ColumnDef,
  columnVisibilityFeature,
  flexRender,
  type RowData,
  rowSortingFeature,
  type SortingState,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { type ReactNode, useId } from "react";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { Button } from "./button";
import {
  ArrowUpDownIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ColumnsIcon,
} from "./icons";
import { Skeleton } from "./states";

/**
 * Admin grids sort and paginate on the server, so only the sorting and visibility features are
 * needed: no client-side row models (see ADR 0006).
 */
export const dataTableFeatures = tableFeatures({ rowSortingFeature, columnVisibilityFeature });
export type DataTableFeatures = typeof dataTableFeatures;

export interface DataTableColumnMeta {
  /** The cell that titles a row on the phone card layout and opens the row. */
  cardTitle?: boolean;
  /** Keep the column off the phone card layout. */
  hideOnCard?: boolean;
  /** Right-align numbers. */
  numeric?: boolean;
}

export interface DataTableProps<T extends RowData> {
  columns: ColumnDef<DataTableFeatures, T>[];
  data: T[];
  getRowId: (row: T) => string;
  /** Accessible name of the table and the card list. */
  label: string;
  total: number;
  page: number;
  pageSize: number;
  sorting: SortingState;
  onSortingChange: (sorting: SortingState) => void;
  onPageChange: (page: number) => void;
  onRowOpen?: (row: T) => void;
  loading?: boolean;
  /** Rendered instead of the grid when there are no rows. */
  empty?: ReactNode;
  /** Controls placed beside the column menu (search box, filters). */
  toolbar?: ReactNode;
  /** Hide the pager for short, fully loaded lists. */
  paginate?: boolean;
}

const metaOf = (meta: unknown): DataTableColumnMeta => (meta ?? {}) as DataTableColumnMeta;

export function DataTable<T extends RowData>({
  columns,
  data,
  getRowId,
  label,
  total,
  page,
  pageSize,
  sorting,
  onSortingChange,
  onPageChange,
  onRowOpen,
  loading = false,
  empty,
  toolbar,
  paginate = true,
}: DataTableProps<T>) {
  const { t } = useI18n();
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    getRowId,
    manualSorting: true,
    state: { sorting },
  });

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const visibleColumns = table.getVisibleLeafColumns();
  const titleColumn =
    visibleColumns.find((c) => metaOf(c.columnDef.meta).cardTitle) ?? visibleColumns[0];

  function toggleSort(columnId: string) {
    const current = sorting[0];
    onSortingChange([{ id: columnId, desc: current?.id === columnId ? !current.desc : false }]);
  }

  const showEmpty = !loading && data.length === 0 && empty;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">{toolbar}</div>
        <ColumnMenu table={table} />
      </div>

      {loading ? (
        <div role="status" aria-label={t("table.loadingRows")} className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : showEmpty ? (
        empty
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface md:block">
            <table aria-label={label} className="w-full border-collapse text-left text-[0.95rem]">
              <thead className="bg-sunken text-sm text-muted">
                <tr>
                  {table.getHeaderGroups()[0]?.headers.map((header) => {
                    const column = header.column;
                    const sortable = column.getCanSort();
                    const sorted = sorting.find((s) => s.id === column.id);
                    const text =
                      typeof column.columnDef.header === "string"
                        ? column.columnDef.header
                        : column.id;
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={sorted ? (sorted.desc ? "descending" : "ascending") : undefined}
                        className={cn(
                          "px-4 py-3 font-medium",
                          metaOf(column.columnDef.meta).numeric && "text-right",
                        )}
                      >
                        {sortable ? (
                          <button
                            type="button"
                            onClick={() => toggleSort(column.id)}
                            aria-label={t("table.sortBy", { column: text })}
                            className="-mx-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 hover:bg-line/50 hover:text-fg"
                          >
                            {flexRender(column.columnDef.header, header.getContext())}
                            {sorted ? (
                              sorted.desc ? (
                                <ChevronDownIcon width={16} height={16} />
                              ) : (
                                <ChevronUpIcon width={16} height={16} />
                              )
                            ) : (
                              <ArrowUpDownIcon width={16} height={16} className="opacity-60" />
                            )}
                          </button>
                        ) : (
                          flexRender(column.columnDef.header, header.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="border-t border-line hover:bg-sunken/60">
                    {row
                      .getAllCells()
                      .filter((cell) => cell.column.getIsVisible())
                      .map((cell) => {
                        const content = flexRender(cell.column.columnDef.cell, cell.getContext());
                        const isTitle = cell.column.id === titleColumn?.id;
                        return (
                          <td
                            key={cell.id}
                            className={cn(
                              "px-4 py-2.5 align-middle",
                              metaOf(cell.column.columnDef.meta).numeric &&
                                "text-right tabular-nums",
                            )}
                          >
                            {isTitle && onRowOpen ? (
                              <button
                                type="button"
                                onClick={() => onRowOpen(row.original)}
                                className="-mx-2 inline-flex min-h-11 items-center rounded-md px-2 text-left font-medium text-fg hover:text-accent-text hover:underline"
                              >
                                {content}
                              </button>
                            ) : (
                              content
                            )}
                          </td>
                        );
                      })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul aria-label={label} className="space-y-2 md:hidden">
            {table.getRowModel().rows.map((row) => {
              const cells = row.getAllCells().filter((cell) => cell.column.getIsVisible());
              const title = cells.find((cell) => cell.column.id === titleColumn?.id);
              return (
                <li key={row.id} className="rounded-xl border border-line bg-surface p-4">
                  <div className="font-medium">
                    {title && onRowOpen ? (
                      <button
                        type="button"
                        onClick={() => onRowOpen(row.original)}
                        className="-mx-2 inline-flex min-h-11 items-center rounded-md px-2 text-left hover:text-accent-text"
                      >
                        {flexRender(title.column.columnDef.cell, title.getContext())}
                      </button>
                    ) : (
                      title && flexRender(title.column.columnDef.cell, title.getContext())
                    )}
                  </div>
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {cells
                      .filter(
                        (cell) =>
                          cell.column.id !== titleColumn?.id &&
                          !metaOf(cell.column.columnDef.meta).hideOnCard,
                      )
                      .map((cell) => (
                        <div key={cell.id} className="contents">
                          <dt className="text-muted">
                            {typeof cell.column.columnDef.header === "string"
                              ? cell.column.columnDef.header
                              : cell.column.id}
                          </dt>
                          <dd className="min-w-0 break-words">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </dd>
                        </div>
                      ))}
                  </dl>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {paginate && (
        <nav
          aria-label={label}
          className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted"
        >
          <p>{t("table.showing", { from, to, total })}</p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              aria-label={t("table.previous")}
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            >
              <ChevronLeftIcon />
            </Button>
            <span aria-live="polite">{t("table.page", { page, pages })}</span>
            <Button
              variant="secondary"
              aria-label={t("table.next")}
              disabled={page >= pages}
              onClick={() => onPageChange(page + 1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}

function ColumnMenu<T extends RowData>({
  table,
}: {
  table: ReturnType<typeof useTable<DataTableFeatures, T>>;
}) {
  const { t } = useI18n();
  const groupId = useId();
  const hideable = table
    .getAllLeafColumns()
    .filter((c) => c.getCanHide() && typeof c.columnDef.header === "string");
  if (hideable.length === 0) return null;
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button variant="secondary" />}>
        <ColumnsIcon />
        {t("table.columns")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" className="z-50">
          <Popover.Popup className="min-w-52 rounded-lg border border-line bg-surface p-2 shadow-lg">
            <fieldset aria-labelledby={groupId} className="m-0 border-0 p-0">
              <legend
                id={groupId}
                className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted"
              >
                {t("table.columnsLabel")}
              </legend>
              {hideable.map((column) => (
                <label
                  key={column.id}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-sunken"
                >
                  <input
                    type="checkbox"
                    className="size-5 accent-[var(--accent)]"
                    checked={column.getIsVisible()}
                    onChange={column.getToggleVisibilityHandler()}
                  />
                  {column.columnDef.header as string}
                </label>
              ))}
            </fieldset>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
