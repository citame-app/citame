import type { AdminClient } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { DataTable, type DataTableFeatures } from "~/components/ui/data-table";
import { TextField } from "~/components/ui/field";
import { UserIcon } from "~/components/ui/icons";
import { EmptyState, ErrorState } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { clientsQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
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
  const [tab, setTab] = useState<"list" | "groups">("list");
  const groups = useQuery({
    queryKey: ["admin", "clients", "groups"],
    queryFn: () => api().admin.clients.groups(),
    enabled: tab === "groups",
  });
  const [text, setText] = useState(search.q ?? "");
  const debounced = useDebounced(text.trim(), 300);

  // Only a changed text draft navigates; other URL filters retain their current state.
  const previousTerm = useRef(debounced);
  useEffect(() => {
    if (previousTerm.current === debounced) return;
    previousTerm.current = debounced;
    if (debounced === (search.q ?? "")) return;
    const { q: _drop, ...rest } = search;
    onSearchChange({ ...rest, ...(debounced ? { q: debounced } : {}), page: 1 });
  }, [debounced, search, onSearchChange]);

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

  return (
    <>
      <nav className="commerce-section-nav" aria-label={t("clients.title")}>
        <button type="button" aria-pressed={tab === "list"} onClick={() => setTab("list")}>
          {t("clients.table")}
        </button>
        <button type="button" aria-pressed={tab === "groups"} onClick={() => setTab("groups")}>
          {t("pos.clientGroups")}
        </button>
      </nav>
      {tab === "list" && search.group && (
        <div className="mb-4 flex items-center gap-3">
          <span className="font-semibold">{search.group}</span>
          <Button
            variant="ghost"
            onClick={() => {
              const { group: _, ...rest } = search;
              onSearchChange({ ...rest, page: 1 });
            }}
          >
            {t("pos.allCustomers")}
          </Button>
        </div>
      )}
      {tab === "groups" ? (
        groups.isError ? (
          <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />
        ) : groups.isPending ? (
          <p role="status" className="p-4 text-muted">
            {t("admin.loading")}
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {groups.data.groups.map((group) => (
              <li key={group.name}>
                <button
                  type="button"
                  className="w-full rounded-xl border border-line bg-surface p-5 text-left hover:bg-sunken"
                  onClick={() => {
                    const { q: _q, ...rest } = search;
                    setText("");
                    onSearchChange({ ...rest, group: group.name, page: 1 });
                    setTab("list");
                  }}
                >
                  <strong className="break-words">{group.name}</strong>
                  <span className="mt-2 block text-sm text-muted">{group.count}</span>
                </button>
              </li>
            ))}
            {!groups.data.groups.length && <li className="p-4 text-muted">{t("pos.noGroups")}</li>}
          </ul>
        )
      ) : query.isError ? (
        <div className="space-y-3">
          {toolbar}
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : (
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
      )}
    </>
  );
}
