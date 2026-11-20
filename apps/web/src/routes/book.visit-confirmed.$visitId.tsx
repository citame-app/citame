import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { PageContainer } from "~/components/pages";
import { buttonClasses } from "~/components/ui/button";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { BookingProtectionNotice } from "~/features/booking/protection";
import { totalPriceLabel } from "~/features/booking/service-price";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatDateLong, formatMoney, formatTime, localDateOf } from "~/lib/format";
import { staffQuery } from "~/lib/queries";

export const Route = createFileRoute("/book/visit-confirmed/$visitId")({
  beforeLoad: ({ context, params }) => {
    if (!context.session)
      throw redirect({
        to: "/sign-in",
        search: { redirect: `/book/visit-confirmed/${params.visitId}` },
      });
  },
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  component: ConfirmedVisit,
});
function ConfirmedVisit() {
  const { visitId } = Route.useParams();
  const { salon } = Route.useRouteContext();
  const { t, locale } = useI18n();
  const query = useQuery({
    queryKey: ["visit", visitId],
    queryFn: () => api().visits.get(visitId),
    refetchInterval: 5000,
  });
  const staff = useQuery(staffQuery);
  return (
    <PageContainer width="max-w-3xl">
      <div className="space-y-6 py-10">
        <h1 className="text-title">{t("services.visitConfirmed")}</h1>
        {query.isPending ? (
          <Skeleton className="h-48" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <p>
              {query.data.appointments[0] &&
                formatDateLong(
                  localDateOf(query.data.appointments[0].startsAt, salon.timezone),
                  locale,
                )}
            </p>
            {query.data.appointments.some((a) => a.protection?.state === "pending") && (
              <p role="status" className="rounded-lg border border-line bg-sunken p-4">
                {t("services.visitPayments")}
              </p>
            )}
            <ol className="space-y-4">
              {query.data.appointments.map((appointment) => (
                <li key={appointment.id} className="space-y-3 rounded-lg border border-line p-5">
                  <h2 className="text-heading">
                    {appointment.services.map((s) => s.name).join(" + ")}
                  </h2>
                  <p>
                    {formatTime(appointment.startsAt, salon.timezone, locale)}–
                    {formatTime(appointment.endsAt, salon.timezone, locale)} ·{" "}
                    {staff.data?.find((s) => s.id === appointment.staffId)?.displayName}
                  </p>
                  <p>
                    {appointment.bookingPrice?.finalized
                      ? formatMoney(
                          appointment.bookingPrice.totalCents,
                          appointment.services[0]?.currency ?? "EUR",
                          locale,
                        )
                      : totalPriceLabel(
                          t,
                          locale,
                          appointment.services,
                          appointment.bookingPrice?.totalCents ??
                            appointment.services.reduce((sum, s) => sum + s.priceCents, 0),
                          appointment.services[0]?.currency ?? "EUR",
                          true,
                        )}
                  </p>
                  <p className="text-sm text-muted">{t(`status.${appointment.status}`)}</p>
                  {appointment.protection && (
                    <BookingProtectionNotice protection={appointment.protection} />
                  )}
                </li>
              ))}
            </ol>
            <p className="text-sm text-muted">{t("services.visitSeparate")}</p>
          </>
        )}
        <Link to="/account" className={buttonClasses({ variant: "primary" })}>
          {t("services.visitManage")}
        </Link>
      </div>
    </PageContainer>
  );
}
