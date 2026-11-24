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
import {
  type CalendarStatusChange,
  calendarWriteKey,
  startCalendarWrite,
  usePendingCalendarWrites,
} from "./appointment-writes";
import { invalidateCalendarData, mergeAppointment } from "./cache";
import { availableActions } from "./logic";

type Transition = CalendarStatusChange["status"];
const CALENDAR_KEY = ["admin", "calendar"] as const;

export function useStatusChange() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  const change = useMutation({
    mutationKey: calendarWriteKey,
    mutationFn: ({ appointment, status }: CalendarStatusChange) =>
      api().appointments.update(appointment.id, { version: appointment.version, status }),
    onError: (error) => toast.error(t(describeProblem(error).messageKey)),
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
    onSettled: () => {
      void invalidateCalendarData(queryClient);
    },
  });
  return {
    ...change,
    mutate: (request: CalendarStatusChange, options?: Parameters<typeof change.mutate>[1]) =>
      startCalendarWrite(queryClient, request, (command) => change.mutate(command, options)),
  };
}

export function AppointmentActions({
  appointment,
  role,
  ownStaffId,
  now,
  timeZone = "America/Argentina/Buenos_Aires",
  onChanged,
  layout = "row",
  readOnly = false,
}: {
  appointment: CalendarAppointment;
  role: UserRole;
  ownStaffId: string | null;
  now: Date;
  timeZone?: string;
  onChanged?: () => void;
  layout?: "row" | "stack";
  readOnly?: boolean;
}) {
  const { t, locale } = useI18n();
  const change = useStatusChange();
  const writePending = usePendingCalendarWrites().has(appointment.id);
  const [cancelReview, setCancelReview] = useState<CalendarAppointment | null>(null);
  const actions = availableActions(role, appointment, now, ownStaffId, !readOnly);
  const reviewedCancellation =
    cancelReview?.id === appointment.id && cancelReview.version === appointment.version
      ? cancelReview
      : null;

  const run = (status: Transition) =>
    change.mutate({ appointment, status }, { onSuccess: onChanged });

  return (
    <div className={layout === "stack" ? "flex flex-col gap-2" : "flex flex-wrap gap-2"}>
      {actions.complete && (
        <Button
          variant="primary"
          disabled={writePending}
          loading={change.isPending}
          onClick={() => run("completed")}
        >
          {t("calendar.action.complete")}
        </Button>
      )}
      {actions.noShow && (
        <Button
          variant="secondary"
          disabled={writePending}
          loading={change.isPending}
          onClick={() => run("no_show")}
        >
          {t("calendar.action.noShow")}
        </Button>
      )}
      {actions.cancel && (
        <Button
          variant="secondary"
          disabled={writePending}
          onClick={() => setCancelReview(appointment)}
        >
          {t("calendar.action.cancel")}
        </Button>
      )}
      {actions.completeBlockedReason === "notStarted" && (
        <p className="basis-full text-sm text-muted">{t("calendar.action.notStarted")}</p>
      )}
      <ConfirmDialog
        open={cancelReview !== null}
        onOpenChange={(open) => !open && setCancelReview(null)}
        destructive
        pending={change.isPending}
        confirmDisabled={writePending || !actions.cancel || !reviewedCancellation}
        title={t("calendar.cancel.title")}
        description={t("calendar.cancel.body", {
          client: cancelReview?.clientName ?? appointment.clientName,
          time: formatTime(cancelReview?.startsAt ?? appointment.startsAt, timeZone, locale),
        })}
        confirmLabel={t("calendar.cancel.confirm")}
        cancelLabel={t("calendar.cancel.keep")}
        onConfirm={() => {
          if (!reviewedCancellation || !actions.cancel) return;
          change.mutate(
            { appointment: reviewedCancellation, status: "cancelled" },
            {
              onSuccess: () => {
                setCancelReview(null);
                onChanged?.();
              },
              onError: () => setCancelReview(null),
            },
          );
        }}
      >
        {cancelReview && !reviewedCancellation && (
          <p role="status" className="mt-3 text-sm text-danger-fg">
            {t("problem.versionConflict")}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
