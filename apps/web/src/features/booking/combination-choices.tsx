import type { Service, Staff } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatDuration, formatMoney } from "~/lib/format";
import { normalizeCatalogSelection } from "./catalog-selection";
import { bookingTotals, eligibleStaff } from "./logic";
export function combinationAvailable(ids: string[], catalog: Service[], staff: Staff[]) {
  return (
    ids.length >= 2 &&
    JSON.stringify(ids) === JSON.stringify(normalizeCatalogSelection(ids, catalog)) &&
    new Set(catalog.filter((row) => ids.includes(row.id)).map((row) => row.currency)).size === 1 &&
    eligibleStaff(staff, ids).length > 0
  );
}
export function CombinationChoices({
  catalog,
  staff,
  selected,
  onChange,
}: {
  catalog: Service[];
  staff: Staff[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t, locale } = useI18n();
  const query = useQuery({
    queryKey: ["combinations", "public"],
    queryFn: () => api().combinations.list(),
    staleTime: 30000,
  });
  if (query.isPending) return <Skeleton className="h-20" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const combinations = query.data.combinations.filter(
    (row) => row.active && row.bookable && combinationAvailable(row.serviceIds, catalog, staff),
  );
  if (!combinations.length) return null;
  return (
    <section
      aria-label={t("combinations.title")}
      className="space-y-4 rounded-xl border border-line bg-sunken p-4"
    >
      <h2 className="text-heading">{t("combinations.title")}</h2>
      <p className="text-sm text-muted">{t("combinations.chooseHelp")}</p>
      <ul className="grid gap-4 sm:grid-cols-2">
        {combinations.map((row) => {
          const totals = bookingTotals(catalog, row.serviceIds);
          return (
            <li
              key={row.id}
              className="min-w-0 space-y-3 rounded-lg border border-line bg-surface p-4"
            >
              <h3 className="font-medium wrap-anywhere">{row.name}</h3>
              {row.description && (
                <p className="text-sm text-muted wrap-anywhere">{row.description}</p>
              )}
              <p className="text-sm wrap-anywhere">
                {row.serviceIds.map((id) => catalog.find((s) => s.id === id)?.name).join(" → ")}
              </p>
              <p className="font-medium">
                {formatMoney(totals.priceCents, totals.currency ?? "EUR", locale)} ·{" "}
                {formatDuration(totals.durationMinutes, locale)}
              </p>
              <Button
                variant="secondary"
                className="max-w-full py-2 whitespace-normal! wrap-anywhere aria-pressed:border-accent aria-pressed:bg-accent-soft"
                aria-label={t("combinations.choose", { name: row.name })}
                aria-pressed={JSON.stringify(selected) === JSON.stringify(row.serviceIds)}
                onClick={() => onChange([...row.serviceIds])}
              >
                {t("combinations.chooseAction")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
