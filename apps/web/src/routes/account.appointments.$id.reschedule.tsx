import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { buttonClasses } from "~/components/ui/button";
import { ChevronLeftIcon } from "~/components/ui/icons";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { RescheduleView } from "~/features/account/reschedule";
import { useI18n } from "~/i18n/react";
import { myAppointmentsQuery, staffQuery } from "~/lib/queries";

export const Route = createFileRoute("/account/appointments/$id/reschedule")({
  component: ReschedulePage,
});

function ReschedulePage() {
  const { t } = useI18n();
  const { id } = Route.useParams();
  const { salon } = Route.useRouteContext();
  const navigate = useNavigate();
  const mine = useQuery(myAppointmentsQuery);
  const staff = useQuery(staffQuery);
  const appointment = mine.data?.find((item) => item.id === id);

  return (
    <section aria-labelledby="reschedule-title">
      <Link to="/account" className={`${buttonClasses({ variant: "ghost" })} -ml-4 mb-2`}>
        <ChevronLeftIcon />
        {t("account.reschedule.back")}
      </Link>
      <h2 id="reschedule-title" className="text-title">
        {t("account.reschedule.title")}
      </h2>
      <div className="mt-6">
        {mine.isPending ? (
          <div role="status" aria-label={t("account.loading")} className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : mine.isError ? (
          <ErrorState error={mine.error} onRetry={() => mine.refetch()} />
        ) : appointment?.status !== "booked" ? (
          <ErrorState error={new Error("not found")} />
        ) : (
          <RescheduleView
            appointment={appointment}
            staffName={
              staff.data?.find((member) => member.id === appointment.staffId)?.displayName ??
              t("account.staffFallback")
            }
            salon={salon}
            onDone={() => void navigate({ to: "/account", search: { highlight: appointment.id } })}
          />
        )}
      </div>
    </section>
  );
}
