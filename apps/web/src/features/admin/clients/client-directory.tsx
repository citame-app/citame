import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { personInitials } from "../calendar/presentation";
import { useDebounced } from "../use-debounced";

/** A paginated directory stays beside the selected profile. Route changes retain unsaved guards. */
export function ClientDirectory({ selected }: { selected: string }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim(), 200);
  const clients = useQuery({
    queryKey: ["admin", "clients", "directory", term, page],
    queryFn: () =>
      api().admin.clients.list({ search: term, page, pageSize: 20, sort: "name", order: "asc" }),
  });
  return (
    <aside className="client-directory" aria-label={t("clients.table")}>
      <TextField
        label={t("clients.search")}
        type="search"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
      />
      {clients.isPending ? (
        <Skeleton className="h-40" />
      ) : clients.isError ? (
        <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />
      ) : (
        <>
          <ul>
            {clients.data.clients.map((client) => (
              <li key={client.id}>
                <Link
                  to="/admin/clients/$id"
                  params={{ id: client.id }}
                  aria-current={client.id === selected ? "page" : undefined}
                >
                  <span aria-hidden="true" className="client-directory-avatar">
                    {personInitials(client.name)}
                  </span>
                  <span className="min-w-0">
                    <strong>{client.name}</strong>
                    <span className="block truncate text-xs text-muted">
                      {client.phone ?? client.email}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {!clients.data.clients.length && (
            <p className="py-5 text-sm text-muted">{t("pos.noCustomers")}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>
              {t("inventory.previous")}
            </Button>
            <span className="text-sm">{page}</span>
            <Button
              variant="ghost"
              disabled={page * 20 >= clients.data.total}
              onClick={() => setPage(page + 1)}
            >
              {t("inventory.next")}
            </Button>
          </div>
        </>
      )}
    </aside>
  );
}
