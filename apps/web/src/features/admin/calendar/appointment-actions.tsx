import type { CalendarAppointment, CalendarResponse, UserRole } from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatTime } from "~/lib/format";
import { describeProblem } from "../problems";
import { mergeAppointment, patchAppointment } from "./cache";
import { availableActions } from "./logic";

type Transition = "completed" | "no_show" | "cancelled";

const CALENDAR_KEY = ["admin", "calendar"] as const;

/** Every cached calendar window, so an edit shows up in the day, week and today views at once. */
function snapshot(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.getQueriesData<CalendarResponse>({ queryKey: CALENDAR_KEY });
}

/** Changes an appointment status with an optimistic update, rollback and a friendly error. */
export function useStatusChange() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  return useMutation({
    mutationFn: ({
      appointment,
      status,
    }: {
      appointment: CalendarAppointment;
      status: Transition;
    }) => api().appointments.update(appointment.id, { version: appointment.version, status }),
    onMutate: async ({ appointment, status }) => {
      await queryClient.cancelQueries({ queryKey: CALENDAR_KEY });
      const previous = snapshot(queryClient);
      queryClient.setQueriesData<CalendarResponse>({ queryKey: CALENDAR_KEY }, (data) =>
        data ? patchAppointment(data, appointment.id, { status }) : data,
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
      toast.error(t(describeProblem(error).messageKey));
    },
    onSuccess: (saved, { status }) => {
      queryClient.setQueriesData<CalendarResponse>({ queryKey: CALENDAR_KEY }, (data) =>
        data ? mergeAppointment(data, saved) : data,
      );
      toast.success(
        t(
          status === "completed"
            ? "calendar.toast.completed"
            : status === "no_show"
              ? "calendar.toast.noShow"
              : "calendar.toast.cancelled",
        ),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["admin"] }),
  });
}

export function AppointmentActions({
  appointment,
  role,
  ownStaffId,
  now,
  timeZone = "America/Argentina/Buenos_Aires",
  onChanged,
  layout = "row",
}: {
  appointment: CalendarAppointment;
  role: UserRole;
  ownStaffId: string | null;
  now: Date;
  timeZone?: string;
  onChanged?: () => void;
  layout?: "row" | "stack";
}) {
  const { t, locale } = useI18n();
  const change = useStatusChange();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const actions = availableActions(role, appointment, now, ownStaffId);

  const run = (status: Transition) =>
    change.mutate({ appointment, status }, { onSuccess: onChanged });

  return (
    <div className={layout === "stack" ? "flex flex-col gap-2" : "flex flex-wrap gap-2"}>
      {actions.complete && (
        <Button variant="primary" loading={change.isPending} onClick={() => run("completed")}>
          {t("calendar.action.complete")}
        </Button>
      )}
      {actions.noShow && (
        <Button variant="secondary" loading={change.isPending} onClick={() => run("no_show")}>
          {t("calendar.action.noShow")}
        </Button>
      )}
      {actions.cancel && (
        <Button
          variant="secondary"
          disabled={change.isPending}
          onClick={() => setConfirmingCancel(true)}
        >
          {t("calendar.action.cancel")}
        </Button>
      )}
      {actions.completeBlockedReason === "notStarted" && (
        <p className="basis-full text-sm text-muted">{t("calendar.action.notStarted")}</p>
      )}
      <ConfirmDialog
        open={confirmingCancel}
        onOpenChange={setConfirmingCancel}
        destructive
        pending={change.isPending}
        title={t("calendar.cancel.title")}
        description={t("calendar.cancel.body", {
          client: appointment.clientName,
          time: formatTime(appointment.startsAt, timeZone, locale),
        })}
        confirmLabel={t("calendar.cancel.confirm")}
        cancelLabel={t("calendar.cancel.keep")}
        onConfirm={() => {
          change.mutate(
            { appointment, status: "cancelled" },
            {
              onSuccess: () => {
                setConfirmingCancel(false);
                onChanged?.();
              },
              onError: () => setConfirmingCancel(false),
            },
          );
        }}
      />
    </div>
  );
}
