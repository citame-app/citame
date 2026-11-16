import type { ServiceCombination } from "@sob/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { servicesQuery, staffQuery } from "~/lib/queries";
import { CombinationEditor } from "./combination-editor";
export function CombinationsPanel() {
  const { t } = useI18n();
  const client = useQueryClient();
  const [editing, setEditing] = useState<ServiceCombination | "new" | null>(null);
  const [revision, setRevision] = useState(0);
  const query = useQuery({
    queryKey: ["combinations", "admin"],
    queryFn: () => api().combinations.admin(),
    gcTime: 0,
  });
  const catalog = useQuery(servicesQuery);
  const staff = useQuery(staffQuery);
  const reload = () => {
    void client.invalidateQueries({ queryKey: ["combinations"] });
    void client.invalidateQueries({ queryKey: ["services"] });
    void client.invalidateQueries({ queryKey: ["staff"] });
  };
  const ready = catalog.isSuccess && staff.isSuccess && query.isSuccess;
  return (
    <section
      aria-label={t("combinations.title")}
      className="mt-10 space-y-5 border-t border-line pt-8"
    >
      <h2 className="text-heading">{t("combinations.title")}</h2>
      <p className="max-w-prose text-muted">{t("combinations.lead")}</p>
      <Button
        disabled={!ready || (query.data?.combinations.length ?? 0) >= 100}
        onClick={() => {
          setRevision((v) => v + 1);
          setEditing("new");
        }}
      >
        {t("combinations.new")}
      </Button>
      {(query.data?.combinations.length ?? 0) >= 100 && (
        <p role="status" className="text-sm text-muted">
          {t("combinations.limit")}
        </p>
      )}
      {(query.isPending || catalog.isPending || staff.isPending) && <Skeleton className="h-24" />}
      {(query.isError || catalog.isError || staff.isError) && (
        <ErrorState error={query.error ?? catalog.error ?? staff.error} onRetry={reload} />
      )}
      {query.data?.combinations.length === 0 && (
        <p className="text-muted">{t("combinations.empty")}</p>
      )}
      <ul className="grid gap-4 md:grid-cols-2">
        {query.data?.combinations.map((row) => (
          <li key={row.id} className="min-w-0 space-y-3 rounded-lg border border-line p-4">
            <h3 className="font-medium wrap-anywhere">{row.name}</h3>
            {row.description && (
              <p className="text-sm text-muted wrap-anywhere">{row.description}</p>
            )}
            <Badge tone={!row.active ? "neutral" : row.bookable ? "success" : "warning"}>
              {t(
                !row.active
                  ? "combinations.inactive"
                  : row.bookable
                    ? "combinations.live"
                    : "combinations.unavailable",
              )}
            </Badge>
            <ol className="list-decimal space-y-1 pl-5">
              {row.serviceIds.map((id) => (
                <li key={id}>
                  {catalog.data?.find((s) => s.id === id)?.name ?? t("combinations.unavailable")}
                </li>
              ))}
            </ol>
            <Button
              variant="secondary"
              className="max-w-full py-2 whitespace-normal! wrap-anywhere"
              aria-label={`${t("combinations.editAction")}: ${row.name}`}
              disabled={!ready}
              onClick={() => {
                setRevision((v) => v + 1);
                setEditing(row);
              }}
            >
              {t("combinations.editAction")}
            </Button>
          </li>
        ))}
      </ul>
      {editing && ready && (
        <CombinationEditor
          key={revision}
          initial={editing}
          catalog={catalog.data}
          staff={staff.data}
          onClose={() => {
            setEditing(null);
            reload();
          }}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </section>
  );
}
