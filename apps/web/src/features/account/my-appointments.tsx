import type { Appointment } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { buttonClasses } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { CalendarIcon } from "~/components/ui/icons";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { myAppointmentsQuery, staffQuery } from "~/lib/queries";
import { AppointmentCard } from "./appointment-card";
import { applyOptimisticCancel, splitAppointments } from "./split";

export function MyAppointments({
  timeZone,
  highlightId,
  onReschedule,
}: {
  timeZone: string;
  highlightId?: string;
  onReschedule: (appointment: Appointment) => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery(myAppointmentsQuery);
  const staff = useQuery(staffQuery);
  const [toCancel, setToCancel] = useState<Appointment | null>(null);

  const split = useMemo(() => splitAppointments(query.data ?? [], new Date()), [query.data]);

  const cancel = useMutation({
    mutationFn: (appointment: Appointment) =>
      api().appointments.cancel(appointment.id, appointment.version),
    onMutate: async (appointment) => {
      await queryClient.cancelQueries({ queryKey: myAppointmentsQuery.queryKey });
      const previous = queryClient.getQueryData<Appointment[]>(myAppointmentsQuery.queryKey);
      queryClient.setQueryData<Appointment[]>(myAppointmentsQuery.queryKey, (list) =>
        list ? applyOptimisticCancel(list, appointment.id) : list,
      );
      setToCancel(null);
      return { previous };
    },
    onError: (error, _appointment, context) => {
      if (context?.previous) {
        queryClient.setQueryData(myAppointmentsQuery.queryKey, context.previous);
      }
      toast.error(
        error instanceof ApiError &&
          (error.code === "version_conflict" || error.code === "invalid_state")
          ? t("account.cancel.conflict")
          : t("account.cancel.failed"),
      );
    },
    onSuccess: () => toast.success(t("account.cancel.success")),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["appointments"] });
      void queryClient.invalidateQueries({ queryKey: ["availability"] });
    },
  });

  if (query.isPending) {
    return (
      <div role="status" aria-label={t("account.loading")} className="space-y-4">
        {[0, 1].map((key) => (
          <div key={key} className="rounded-xl border border-line bg-surface p-5">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="mt-3 h-4 w-32" />
            <Skeleton className="mt-5 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-2/3" />
          </div>
        ))}
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  if (split.upcoming.length === 0 && split.history.length === 0) {
    return (
      <EmptyState
        title={t("account.empty.title")}
        description={t("account.empty.body")}
        icon={<CalendarIcon width={24} height={24} />}
      >
        <Link to="/book" className={buttonClasses()}>
          {t("home.cta")}
        </Link>
      </EmptyState>
    );
  }

  const staffName = (id: string) =>
    staff.data?.find((member) => member.id === id)?.displayName ?? t("account.staffFallback");
  const pendingId = cancel.isPending ? cancel.variables?.id : undefined;

  return (
    <div className="space-y-10">
      <section aria-labelledby="upcoming-title">
        <h2 id="upcoming-title" className="mb-4 text-heading">
          {t("account.upcoming")}
        </h2>
        {split.upcoming.length === 0 ? (
          <EmptyState title={t("account.upcoming.none")}>
            <Link to="/book" className={buttonClasses({ variant: "secondary" })}>
              {t("home.cta")}
            </Link>
          </EmptyState>
        ) : (
          <ul className="space-y-4">
            {split.upcoming.map((appointment) => (
              <li key={appointment.id}>
                <AppointmentCard
                  appointment={appointment}
                  staffName={staffName(appointment.staffId)}
                  timeZone={timeZone}
                  highlighted={appointment.id === highlightId}
                  pending={pendingId === appointment.id}
                  onCancel={setToCancel}
                  onReschedule={onReschedule}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {split.history.length > 0 && (
        <section aria-labelledby="history-title">
          <h2 id="history-title" className="mb-4 text-heading">
            {t("account.history")}
          </h2>
          <ul className="space-y-4">
            {split.history.map((appointment) => (
              <li key={appointment.id}>
                <AppointmentCard
                  appointment={appointment}
                  staffName={staffName(appointment.staffId)}
                  timeZone={timeZone}
                  past
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={toCancel !== null}
        onOpenChange={(open) => !open && setToCancel(null)}
        onConfirm={() => toCancel && cancel.mutate(toCancel)}
        title={t("account.cancel.title")}
        description={
          toCancel?.protection
            ? t("protection.cancelWarning", {
                date: new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone,
                }).format(new Date(toCancel.protection.cancellationCutoff)),
                percent: toCancel.protection.lateCancellationBasisPoints / 100,
              })
            : t("account.cancel.body")
        }
        confirmLabel={t("account.cancel.confirm")}
        cancelLabel={t("account.cancel.keep")}
        destructive
      />
    </div>
  );
}
