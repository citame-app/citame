import { BOOKING_INVITATION_MAX_CONTACTS, type Campaign } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useDebounced } from "~/features/admin/use-debounced";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";

export function InvitationContacts({
  selected,
  contacts,
  viewerId,
  feedback,
  onChange,
}: {
  selected: string[];
  contacts?: Campaign["selectedContacts"];
  viewerId: string;
  feedback?: string;
  onChange: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const [names, setNames] = useState(() => new Map(contacts?.map(({ id, name }) => [id, name])));
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim(), 250);
  const id = useId();
  const pageSize = 10;
  const clients = useQuery({
    queryKey: ["admin", "clients", "booking-invitation", viewerId, term, page],
    queryFn: () => api().admin.clients.list({ search: term, page, pageSize }),
  });
  const limit = BOOKING_INVITATION_MAX_CONTACTS;
  const remove = (id: string) => onChange(selected.filter((client) => client !== id));
  if (clients.error instanceof ApiError && [401, 403].includes(clients.error.status)) {
    return <ErrorState error={clients.error} />;
  }
  return (
    <fieldset aria-describedby={id} className="space-y-3 rounded-xl border border-line p-4">
      <legend className="px-1 font-semibold">{t("marketing.invitationContacts")}</legend>
      <p className="text-sm text-muted" id={id}>
        {t("marketing.invitationHelp", { count: limit })}
      </p>
      <p role="status" className="text-sm font-medium">
        {t("marketing.invitationSelected", { count: selected.length })}
      </p>
      {selected.length > 0 && (
        <ul className="flex max-h-36 flex-wrap gap-2 overflow-y-auto">
          {selected.map((clientId) => (
            <li key={clientId} className="min-w-0">
              <Button variant="secondary" onClick={() => remove(clientId)}>
                {t("marketing.invitationRemove", {
                  name: names.get(clientId) ?? t("marketing.invitationUnavailable"),
                })}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <search>
        <TextField
          label={t("clients.search")}
          name="invitation-search"
          type="search"
          value={search}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
          }}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </search>
      {clients.isPending && <Skeleton className="h-20" />}
      {clients.isError && (
        <ErrorState error={clients.error} onRetry={() => void clients.refetch()} />
      )}
      {clients.data && (
        <>
          {clients.data.clients.length === 0 && (
            <p className="text-sm text-muted">{t("pos.noCustomers")}</p>
          )}
          <ul className="divide-y divide-line">
            {clients.data.clients.map((client) => {
              const checked = selected.includes(client.id);
              return (
                <li key={client.id}>
                  <label className="flex min-h-12 min-w-0 items-center gap-3">
                    <input
                      type="checkbox"
                      name="invitation-contacts"
                      value={client.id}
                      checked={checked}
                      disabled={!checked && selected.length >= limit}
                      className="size-5 shrink-0 accent-accent"
                      onChange={() => {
                        if (checked) {
                          remove(client.id);
                        } else if (selected.length < limit) {
                          setNames((previous) => new Map(previous).set(client.id, client.name));
                          onChange([...selected, client.id]);
                        }
                      }}
                    />
                    <span className="min-w-0 break-words">
                      {client.name}
                      <small className="block text-muted">{client.email ?? client.phone}</small>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {clients.data.total > pageSize && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                {t("inventory.previous")}
              </Button>
              <span className="text-sm">{page}</span>
              <Button
                variant="secondary"
                disabled={page * pageSize >= clients.data.total}
                onClick={() => setPage(page + 1)}
              >
                {t("inventory.next")}
              </Button>
            </div>
          )}
        </>
      )}
      {feedback && (
        <p role="alert" className="text-sm text-danger-fg">
          {feedback}
        </p>
      )}
    </fieldset>
  );
}
