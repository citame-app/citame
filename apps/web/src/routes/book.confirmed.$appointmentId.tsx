import type { Appointment } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import { PageContainer } from "~/components/pages";
import { Button, buttonClasses } from "~/components/ui/button";
import { CalendarIcon, CheckIcon, ClockIcon, DownloadIcon, UserIcon } from "~/components/ui/icons";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { buildIcs, icsFileName } from "~/features/booking/ics";
import { bookingStore } from "~/features/booking/store";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { formatDateLong, formatMoney, formatTime, localDateOf } from "~/lib/format";
import { myAppointmentsQuery, staffQuery } from "~/lib/queries";
import { pageMeta } from "~/lib/seo";

export const Route = createFileRoute("/book/confirmed/$appointmentId")({
  beforeLoad: ({ context }) => {
    if (!context.session) throw redirect({ to: "/sign-in", search: { redirect: "/account" } });
  },
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("booking.confirmed.title"),
        description: t("booking.confirmed.lead"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: Confirmed,
});

function Confirmed() {
  const { appointmentId } = Route.useParams();
  const { salon } = Route.useRouteContext();
  const justBooked = useStore(bookingStore, (state) => state.lastBooked);
  const known = justBooked?.id === appointmentId ? justBooked : undefined;
  const mine = useQuery({ ...myAppointmentsQuery, enabled: !known });
  const staff = useQuery(staffQuery);
  const appointment = known ?? mine.data?.find((item) => item.id === appointmentId);

  if (!appointment && mine.isPending) {
    return (
      <PageContainer width="max-w-xl">
        <div className="space-y-4 py-12" aria-busy="true">
          <Skeleton className="mx-auto size-16 rounded-full" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      </PageContainer>
    );
  }
  if (!appointment) {
    return (
      <PageContainer width="max-w-xl">
        <div className="py-12">
          <ErrorState error={mine.error ?? new Error("not found")} onRetry={() => mine.refetch()} />
        </div>
      </PageContainer>
    );
  }
  const staffName =
    staff.data?.find((member) => member.id === appointment.staffId)?.displayName ?? "";
  return (
    <ConfirmedView
      appointment={appointment}
      staffName={staffName}
      salonName={salon.name}
      timeZone={salon.timezone}
    />
  );
}

function ConfirmedView({
  appointment,
  staffName,
  salonName,
  timeZone,
}: {
  appointment: Appointment;
  staffName: string;
  salonName: string;
  timeZone: string;
}) {
  const { t, locale } = useI18n();
  const localDate = localDateOf(appointment.startsAt, timeZone);
  const total = appointment.services.reduce((sum, s) => sum + s.priceCents, 0);
  const currency = appointment.services[0]?.currency ?? "ARS";

  function downloadIcs() {
    const names = appointment.services.map((s) => s.name).join(", ");
    const ics = buildIcs({
      uid: appointment.id,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      summary: t("booking.ics.summary", { salon: salonName, services: names }),
      description: [names, staffName && t("booking.ics.with", { name: staffName })]
        .filter(Boolean)
        .join("\n"),
      location: salonName,
    });
    const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = icsFileName(localDate);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <PageContainer width="max-w-xl">
      <div className="py-10 sm:py-16">
        <div className="sob-rise text-center">
          <span className="mx-auto grid size-16 place-items-center rounded-full bg-success-soft text-success-fg">
            <CheckIcon width={32} height={32} strokeWidth={2.25} />
          </span>
          <h1 className="mt-5 text-title" tabIndex={-1}>
            {t("booking.confirmed.title")}
          </h1>
          <p className="mt-2 text-muted" role="status">
            {t("booking.confirmed.lead")}
          </p>
        </div>

        <div className="mt-8 rounded-xl border border-line bg-surface p-6 shadow-md">
          <dl className="space-y-3">
            <div className="flex items-start gap-3">
              <dt className="mt-0.5 text-muted">
                <CalendarIcon />
                <span className="sr-only">{t("booking.summary.when")}</span>
              </dt>
              <dd className="font-medium">{formatDateLong(localDate, locale)}</dd>
            </div>
            <div className="flex items-start gap-3">
              <dt className="mt-0.5 text-muted">
                <ClockIcon />
                <span className="sr-only">{t("booking.summary.when")}</span>
              </dt>
              <dd className="tabular-nums">
                {formatTime(appointment.startsAt, timeZone, locale)} –{" "}
                {formatTime(appointment.endsAt, timeZone, locale)}
              </dd>
            </div>
            {staffName && (
              <div className="flex items-start gap-3">
                <dt className="mt-0.5 text-muted">
                  <UserIcon />
                  <span className="sr-only">{t("booking.summary.professional")}</span>
                </dt>
                <dd>{staffName}</dd>
              </div>
            )}
          </dl>
          <ul className="mt-5 divide-y divide-line border-t border-line">
            {appointment.services.map((service, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: a static list; a service can repeat
                key={`${service.name}-${index}`}
                className="flex justify-between gap-3 py-2.5"
              >
                <span>{service.name}</span>
                <span className="text-muted">
                  {formatMoney(service.priceCents, service.currency, locale)}
                </span>
              </li>
            ))}
          </ul>
          <p className="flex justify-between border-t border-line pt-3 font-display text-xl font-semibold">
            <span>{t("booking.review.total")}</span>
            <span>{formatMoney(total, currency, locale)}</span>
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button variant="secondary" size="lg" onClick={downloadIcs}>
            <DownloadIcon />
            {t("booking.confirmed.calendar")}
          </Button>
          <Link
            to="/account"
            search={{ highlight: appointment.id }}
            className={buttonClasses({ size: "lg" })}
          >
            {t("booking.confirmed.manage")}
          </Link>
        </div>
        <p className="mt-6 text-center">
          <Link to="/book" className="font-medium text-accent-text underline underline-offset-4">
            {t("booking.confirmed.another")}
          </Link>
        </p>
      </div>
    </PageContainer>
  );
}
