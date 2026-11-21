import type { Checkout, CheckoutHistoryGroup, CheckoutListQuery } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ChevronLeftIcon, ChevronRightIcon } from "~/components/ui/icons";
import { SelectField } from "~/components/ui/select-field";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { addDaysLocal, formatDateLong, formatMoney, formatTime, localDateOf } from "~/lib/format";
import { localDayBounds } from "~/lib/zoned";
import { useDebounced } from "../use-debounced";

export function Transactions({
  onOpen,
  clientId,
}: {
  onOpen: (id: string) => void;
  clientId?: string;
}) {
  const { t, locale, timeZone } = useI18n();
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim(), 250);
  const [status, setStatus] = useState<CheckoutListQuery["status"]>();
  const [method, setMethod] = useState<CheckoutListQuery["method"]>();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState<CheckoutHistoryGroup>("day");
  const invalidRange = Boolean(from && to && from > to);
  const result = useQuery({
    queryKey: [
      "commerce",
      "transactions",
      term,
      status,
      method,
      from,
      to,
      page,
      clientId,
      group,
      timeZone,
    ],
    queryFn: ({ signal }) =>
      api().commerce.list(
        {
          page,
          pageSize: 25,
          search: term || undefined,
          status,
          method,
          clientId,
          groupBy: group,
          ...(from ? { from: localDayBounds(from, timeZone).from } : {}),
          ...(to ? { to: localDayBounds(addDaysLocal(to, 1), timeZone).from } : {}),
        },
        signal,
      ),
    enabled: !invalidRange,
  });
  const rows = result.data?.checkouts ?? [];
  const total = result.data?.total ?? rows.length;
  const groupTotals = result.data?.groupTotals;
  const receiptTimezone = groupTotals?.timezone ?? timeZone;
  const totalsByPeriod = new Map(groupTotals?.rows.map((row) => [row.period, row]));
  const grouped = new Map<string, Checkout[]>();
  for (const row of rows) {
    const date = localDateOf(row.createdAt, receiptTimezone);
    const period = group === "day" ? date : `${date.slice(0, 7)}-01`;
    const receipts = grouped.get(period);
    if (receipts) receipts.push(row);
    else grouped.set(period, [row]);
  }
  return (
    <section className="commerce-transactions space-y-5" aria-label={t("pos.transactions")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-heading">{t("commerce.history")}</h2>
          <p className="mt-1 text-sm text-muted">{t("pos.transactionsHelp")}</p>
        </div>
        <div
          className="commerce-section-nav commerce-transaction-grouping"
          role="group"
          aria-label={t("pos.transactionGrouping")}
        >
          <button type="button" aria-pressed={group === "day"} onClick={() => setGroup("day")}>
            {t("pos.days")}
          </button>
          <button type="button" aria-pressed={group === "month"} onClick={() => setGroup("month")}>
            {t("pos.months")}
          </button>
        </div>
      </div>
      <div className="commerce-transaction-filters">
        <TextField
          label={t("pos.transactionSearch")}
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <SelectField
          label={t("pos.transactionStatus")}
          value={status ?? ""}
          options={[
            { value: "", label: t("pos.allStatuses") },
            ...(["open", "paid", "partially_refunded", "refunded", "void"] as const).map(
              (value) => ({ value, label: t(`commerce.status.${value}`) }),
            ),
          ]}
          onChange={(value) => {
            setStatus((value || undefined) as typeof status);
            setPage(1);
          }}
        />
        <SelectField
          label={t("commerce.method")}
          value={method ?? ""}
          options={[
            { value: "", label: t("pos.allMethods") },
            ...(
              [
                "cash",
                "external_card",
                "redsys_card",
                "redsys_bizum",
                "gift_card",
                "package",
                "membership",
              ] as const
            ).map((value) => ({ value, label: t(`commerce.${value}`) })),
          ]}
          onChange={(value) => {
            setMethod((value || undefined) as typeof method);
            setPage(1);
          }}
        />
        <TextField
          label={t("pos.dateFrom")}
          type="date"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setPage(1);
          }}
        />
        <TextField
          label={t("pos.dateTo")}
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => {
            setTo(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {invalidRange ? (
        <p role="alert" className="text-danger-fg">
          {t("pos.validation")}
        </p>
      ) : result.isPending ? (
        <Skeleton className="h-48" />
      ) : result.isError ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : !rows.length ? (
        <EmptyState title={t("commerce.noSales")} description={t("commerce.noSalesHelp")} />
      ) : (
        <div className="space-y-5">
          {groupTotals && <p className="text-sm text-muted">{t("pos.transactionTotalsHelp")}</p>}
          {[...grouped].map(([date, sales]) => {
            const totals = totalsByPeriod.get(date);
            return (
              <section className="commerce-transaction-group" key={date}>
                <h3>
                  {group === "day"
                    ? formatDateLong(date, locale)
                    : new Intl.DateTimeFormat(locale, {
                        month: "long",
                        year: "numeric",
                        timeZone: "UTC",
                      }).format(new Date(`${date}T12:00:00Z`))}
                </h3>
                {totals && (
                  <dl className="commerce-transaction-totals">
                    <div>
                      <dt>{t("pos.transactionReceipts")}</dt>
                      <dd>{totals.receipts.toLocaleString(locale)}</dd>
                    </div>
                    {(
                      [
                        ["pos.transactionPaid", totals.paidCents],
                        ["pos.transactionRefunded", totals.refundedCents],
                        ["pos.transactionNet", totals.paidCents - totals.refundedCents],
                      ] as const
                    ).map(([label, amount]) => (
                      <div key={label}>
                        <dt>{t(label)}</dt>
                        <dd>{formatMoney(amount, "EUR", locale)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {/* biome-ignore lint/a11y/noRedundantRoles: Safari needs this role when list markers are hidden. */}
                <ol role="list">
                  {sales.map((sale) => (
                    <li key={sale.id}>
                      <button
                        type="button"
                        className="commerce-transaction-row"
                        onClick={() => onOpen(sale.id)}
                      >
                        <div>
                          <span className="text-xs text-muted">
                            {formatTime(sale.createdAt, receiptTimezone, locale)} ·{" "}
                            {sale.id.slice(-8).toUpperCase()}
                          </span>
                          <strong>{sale.lines.map((line) => line.description).join(", ")}</strong>
                        </div>
                        <span className="commerce-transaction-status">
                          {t(`commerce.status.${sale.status}`)}
                        </span>
                        <strong className="tabular-nums">
                          {formatMoney(sale.totalCents, sale.currency, locale)}
                        </strong>
                        <ChevronRightIcon width={18} height={18} />
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      )}
      {total > 0 && !invalidRange && (
        <nav className="flex items-center justify-between gap-3" aria-label={t("pos.transactions")}>
          <p className="text-sm text-muted">
            {t("table.showing", {
              from: (page - 1) * 25 + 1,
              to: Math.min(page * 25, total),
              total,
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              aria-label={t("table.previous")}
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="secondary"
              aria-label={t("table.next")}
              disabled={page * 25 >= total}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </nav>
      )}
    </section>
  );
}
