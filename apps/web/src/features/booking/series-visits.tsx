import type { Appointment } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatDateLong, formatTime, localDateOf } from "~/lib/format";

export function SeriesVisits({
  series,
  admin = false,
  onNavigate,
}: {
  series: NonNullable<Appointment["series"]>;
  admin?: boolean;
  onNavigate?: () => void;
}) {
  const { t, locale, timeZone } = useI18n();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["appointments", "series", series.id],
    queryFn: () => api().appointmentSeries.get(series.id),
    enabled: open,
  });
  return (
    <section
      aria-label={t("series.dates")}
      className="min-w-0 rounded-lg border border-line p-3 text-sm"
    >
      <p className="font-medium">
        {t("series.member", { position: series.position + 1, count: series.count })}
      </p>
      <Button variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {t("series.view")}
      </Button>
      {open && (
        <div className="space-y-3">
          <p className="text-muted">{t("series.singleEdit")}</p>
          {query.isPending ? (
            <Skeleton className="h-20" />
          ) : query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : (
            <ol className="divide-y divide-line">
              {query.data.appointments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {formatDateLong(
                      localDateOf(a.startsAt, query.data.timezone || timeZone),
                      locale,
                    )}{" "}
                    · {formatTime(a.startsAt, query.data.timezone || timeZone, locale)}
                  </span>
                  <span>{t(`status.${a.status}`)}</span>
                  {admin && (
                    <Link
                      to="/admin/calendar"
                      search={{
                        view: "day",
                        date: localDateOf(a.startsAt, query.data.timezone),
                        staff: a.staffId,
                      }}
                      onClick={onNavigate}
                      className="inline-flex min-h-11 items-center px-2 text-accent-text underline"
                    >
                      {t("admin.nav.calendar")}
                    </Link>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
