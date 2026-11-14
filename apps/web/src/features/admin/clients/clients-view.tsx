import type { AdminClient } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { DataTable, type DataTableFeatures } from "~/components/ui/data-table";
import { TextField } from "~/components/ui/field";
import { UserIcon } from "~/components/ui/icons";
import { EmptyState, ErrorState } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { clientsQuery } from "~/lib/admin-queries";
import { formatDateWithYear, localDateOf } from "~/lib/format";
import { useDebounced } from "../use-debounced";
import { type ClientsSearch, searchToQuery, sortingToSearch } from "./search";

const helper = createColumnHelper<DataTableFeatures, AdminClient>();

export function ClientsView({
  search,
  onSearchChange,
  onOpenClient,
}: {
  search: ClientsSearch;
  onSearchChange: (search: ClientsSearch) => void;
  onOpenClient: (id: string) => void;
}) {
  const { t, locale, timeZone } = useI18n();
  const query = useQuery(clientsQuery(searchToQuery(search)));
  const [text, setText] = useState(search.q ?? "");
  const debounced = useDebounced(text.trim(), 300);

  // The URL is the source of truth: push the debounced text into it, never the other way round
  // while the user is typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a changed search text navigates
  useEffect(() => {
    if (debounced === (search.q ?? "")) return;
    const { q: _drop, ...rest } = search;
    onSearchChange({ ...rest, ...(debounced ? { q: debounced } : {}), page: 1 });
  }, [debounced]);

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          id: "name",
          header: t("clients.col.name"),
          meta: { cardTitle: true },
        }),
        helper.accessor("phone", {
          id: "phone",
          header: t("clients.col.phone"),
          enableSorting: false,
          cell: (c) => c.getValue() ?? "-",
        }),
        helper.accessor("email", {
          id: "email",
          header: t("clients.col.email"),
          enableSorting: false,
          cell: (c) => c.getValue() ?? "-",
        }),
        helper.accessor("appointmentCount", {
          id: "visits",
          header: t("clients.col.visits"),
          enableSorting: false,
          meta: { numeric: true },
        }),
        helper.accessor("lastVisitAt", {
          id: "lastVisitAt",
          header: t("clients.col.lastVisit"),
          cell: (c) => {
            const value = c.getValue();
            return value ? (
              formatDateWithYear(localDateOf(value, timeZone), locale)
            ) : (
              <span className="text-muted">{t("clients.never")}</span>
            );
          },
        }),
        helper.accessor("createdAt", {
          id: "createdAt",
          header: t("clients.col.since"),
          cell: (c) => formatDateWithYear(localDateOf(c.getValue(), timeZone), locale),
        }),
      ]),
    [t, locale, timeZone],
  );

  const hasSearch = Boolean(search.q);
  const data = query.data;

  const toolbar = (
    <TextField
      label={t("clients.search")}
      type="search"
      value={text}
      onChange={(e) => setText(e.target.value)}
      hint={t("clients.search.hint")}
      autoComplete="off"
      className="max-w-sm"
    />
  );

  if (query.isError) {
    return (
      <div className="space-y-3">
        {toolbar}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  return (
    <DataTable
      label={t("clients.table")}
      columns={columns}
      data={data?.clients ?? []}
      getRowId={(c) => c.id}
      total={data?.total ?? 0}
      page={search.page}
      pageSize={20}
      loading={query.isPending}
      sorting={[{ id: search.sort, desc: search.order === "desc" }]}
      onSortingChange={(sorting) => {
        const next = sortingToSearch(sorting);
        onSearchChange({ ...search, ...next });
      }}
      onPageChange={(page) => onSearchChange({ ...search, page })}
      onRowOpen={(row) => onOpenClient(row.id)}
      toolbar={toolbar}
      empty={
        hasSearch ? (
          <EmptyState
            title={t("clients.noMatch.title", { query: search.q ?? "" })}
            description={t("clients.noMatch.body")}
            icon={<UserIcon width={24} height={24} />}
          >
            <Button
              variant="secondary"
              onClick={() => {
                const { q: _q, ...rest } = search;
                setText("");
                onSearchChange({ ...rest, page: 1 });
              }}
            >
              {t("clients.noMatch.clear")}
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            title={t("clients.empty.title")}
            description={t("clients.empty.body")}
            icon={<UserIcon width={24} height={24} />}
          />
        )
      }
    />
  );
}
