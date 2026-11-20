import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { formatDuration, formatMoney, localDateOf } from "~/lib/format";
import { servicesQuery } from "~/lib/queries";

export function StaffServices({
  staffId,
  serviceIds,
  canEdit,
}: {
  staffId: string;
  serviceIds: string[];
  canEdit: boolean;
}) {
  const { t, locale, timeZone } = useI18n();
  const services = useQuery(servicesQuery);
  const rows = (services.data ?? []).filter((row) => serviceIds.includes(row.id));
  return (
    <section className="space-y-4" aria-label={t("pos.services")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-heading">{t("pos.services")}</h3>
        <Link
          to="/admin/calendar"
          search={{
            view: "day",
            date: localDateOf(new Date().toISOString(), timeZone),
            staff: staffId,
          }}
          className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold text-accent-text hover:bg-sunken"
        >
          {t("pos.showCalendar")}
        </Link>
      </div>
      {services.isPending ? (
        <Skeleton className="h-24" />
      ) : services.isError ? (
        <ErrorState error={services.error} onRetry={() => void services.refetch()} />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <strong className="break-words text-sm">{row.name}</strong>
                <p className="text-sm text-muted">
                  {row.category} · {formatDuration(row.durationMinutes, locale)} ·{" "}
                  {formatMoney(row.priceCents, row.currency, locale)}
                </p>
              </div>
              {canEdit && (
                <Link
                  to="/admin/services"
                  search={{ service: row.id }}
                  className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-accent-text"
                >
                  {t("pos.editService")}
                </Link>
              )}
            </li>
          ))}
          {!rows.length && (
            <li className="p-4 text-sm text-muted">{t("services.field.staff.none")}</li>
          )}
        </ul>
      )}
      {canEdit && (
        <Link
          to="/admin/services"
          className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-accent-text"
        >
          {t("pos.assignServices")}
        </Link>
      )}
    </section>
  );
}
