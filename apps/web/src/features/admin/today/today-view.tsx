import type { CalendarAppointment, UserRole } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge } from "~/components/ui/badge";
import { buttonClasses } from "~/components/ui/button";
import { CalendarIcon } from "~/components/ui/icons";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { calendarQuery } from "~/lib/admin-queries";
import { formatDuration, formatMoney, formatTime, localDateOf } from "~/lib/format";
import { localDayBounds } from "~/lib/zoned";
import { AppointmentActions } from "../calendar/appointment-actions";
import { StatusBadge } from "../calendar/status-badge";
import { useNow } from "../use-now";
import { buildOverview } from "./overview";

export function TodayView({
  role,
  ownStaffId,
  readOnly = false,
  now: fixedNow,
}: {
  role: UserRole;
  ownStaffId: string | null;
  readOnly?: boolean;
  /** Fixed clock for tests; defaults to a ticking clock. */
  now?: Date;
}) {
  const { t, locale, timeZone } = useI18n();
  const ticking = useNow();
  const now = fixedNow ?? ticking;
  const today = localDateOf(now.toISOString(), timeZone);
  const { from, to } = localDayBounds(today, timeZone);
  const query = useQuery(calendarQuery({ from, to }));

  if (query.isPending) {
    return (
      <div role="status" aria-label={t("admin.loading")} className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const calendar = query.data;
  const overview = buildOverview(calendar.appointments, now, timeZone);
  const staffName = (id: string) => calendar.staff.find((s) => s.id === id)?.displayName ?? "";
  const currency = calendar.appointments[0]?.services[0]?.currency ?? "ARS";
  const time = (instant: string) => formatTime(instant, timeZone, locale);
  const showStaff = role === "owner" && calendar.staff.length > 1;

  const stats = [
    { label: t("today.stat.total"), value: String(overview.stats.total) },
    { label: t("today.stat.remaining"), value: String(overview.stats.remaining) },
    { label: t("today.stat.completed"), value: String(overview.stats.completed) },
    { label: t("today.stat.noShow"), value: String(overview.stats.noShow) },
    {
      label: t("today.stat.revenue"),
      value: formatMoney(overview.stats.expectedRevenueCents, currency, locale),
    },
  ];

  if (overview.timeline.length === 0) {
    return (
      <EmptyState
        title={t("today.timeline.empty.title")}
        description={t("today.timeline.empty.body")}
        icon={<CalendarIcon width={24} height={24} />}
      >
        <Link to="/admin/calendar" className={buttonClasses({ variant: "primary" })}>
          {t("today.openCalendar")}
        </Link>
      </EmptyState>
    );
  }

  const summary = (a: CalendarAppointment) => (
    <>
      <p className="font-medium">{a.clientName}</p>
      <p className="text-sm text-muted">
        {a.serviceNames.join(", ")} ·{" "}
        {formatDuration(
          Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60_000),
          locale,
        )}
        {showStaff && ` · ${t("today.with", { staff: staffName(a.staffId) })}`}
      </p>
    </>
  );

  return (
    <div className="space-y-6">
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of figures, not a form fieldset */}
      <div role="group" aria-label={t("today.statsLabel")}>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl border border-line bg-surface p-4 max-sm:last:col-span-2"
            >
              <dt className="text-sm text-muted">{stat.label}</dt>
              <dd className="mt-1 font-display text-2xl font-semibold tabular-nums">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-surface p-5" aria-labelledby="next-up">
          <h2 id="next-up" className="text-heading">
            {t("today.nextUp.title")}
          </h2>
          {overview.nextUp ? (
            <div className="mt-3 flex items-start gap-4">
              <p className="font-display text-3xl font-semibold tabular-nums text-accent-text">
                {time(overview.nextUp.startsAt)}
              </p>
              <div>{summary(overview.nextUp)}</div>
            </div>
          ) : (
            <p className="mt-2 text-muted">{t("today.nextUp.none")}</p>
          )}
        </section>

        <section className="rounded-xl border border-line bg-surface p-5" aria-labelledby="pending">
          <div className="flex items-center justify-between gap-2">
            <h2 id="pending" className="text-heading">
              {t("today.pending.title")}
            </h2>
            {overview.pending.length > 0 && <Badge tone="warning">{overview.pending.length}</Badge>}
          </div>
          {overview.pending.length === 0 ? (
            <p className="mt-2 text-muted">{t("today.pending.empty")}</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted">{t("today.pending.hint")}</p>
              <ul className="mt-3 divide-y divide-line">
                {overview.pending.map((a) => (
                  <li key={a.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                    <div className="flex items-start gap-3">
                      <p className="w-16 shrink-0 font-semibold tabular-nums">{time(a.startsAt)}</p>
                      <div className="min-w-0">{summary(a)}</div>
                    </div>
                    <AppointmentActions
                      readOnly={readOnly}
                      appointment={a}
                      role={role}
                      ownStaffId={ownStaffId}
                      now={now}
                      timeZone={timeZone}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <section aria-labelledby="timeline">
        <h2 id="timeline" className="mb-3 text-heading">
          {t("today.timeline.title")}
        </h2>
        <ul
          aria-label={t("today.timeline.title")}
          className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface"
        >
          {overview.timeline.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <p className="w-20 shrink-0 font-semibold tabular-nums">{time(a.startsAt)}</p>
              <div className="min-w-0 flex-1">{summary(a)}</div>
              <StatusBadge status={a.status} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
