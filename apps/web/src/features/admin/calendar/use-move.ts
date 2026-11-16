import type { CalendarAppointment, CalendarResponse } from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { describeProblem, type Problem } from "../problems";
import { invalidateCalendarData, mergeAppointment, patchAppointment } from "./cache";

export interface Conflict {
  appointmentId: string;
  problem: Problem;
}

/**
 * Moves an appointment (drag, keyboard or drawer). The block moves at once, and a failure puts
 * it back and records a conflict so the page can say what happened and how to recover.
 * Staff and owners move with `override` so a walk-in can be shifted close to now; hours, time off
 * and the horizon are still enforced by the API.
 */
export function useMoveAppointment() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const mutation = useMutation({
    mutationFn: ({
      appointment,
      to,
    }: {
      appointment: CalendarAppointment;
      to: { staffId: string; startsAt: string };
    }) =>
      api().appointments.update(appointment.id, {
        version: appointment.version,
        startsAt: to.startsAt,
        ...(to.staffId !== appointment.staffId ? { staffId: to.staffId } : {}),
        override: true,
      }),
    onMutate: async ({ appointment, to }) => {
      setConflict(null);
      await queryClient.cancelQueries({ queryKey: ["admin", "calendar"] });
      const previous = queryClient.getQueriesData<CalendarResponse>({
        queryKey: ["admin", "calendar"],
      });
      const length = Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt);
      queryClient.setQueriesData<CalendarResponse>({ queryKey: ["admin", "calendar"] }, (data) =>
        data
          ? patchAppointment(data, appointment.id, {
              staffId: to.staffId,
              startsAt: to.startsAt,
              endsAt: new Date(Date.parse(to.startsAt) + length).toISOString(),
            })
          : data,
      );
      return { previous };
    },
    onError: (error, { appointment }, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
      setConflict({ appointmentId: appointment.id, problem: describeProblem(error) });
    },
    onSuccess: (saved) => {
      queryClient.setQueriesData<CalendarResponse>({ queryKey: ["admin", "calendar"] }, (data) =>
        data ? mergeAppointment(data, saved) : data,
      );
      toast.success(t("calendar.toast.rescheduled"));
    },
    onSettled: () => invalidateCalendarData(queryClient),
  });

  return {
    move: mutation.mutate,
    conflict,
    clearConflict: () => setConflict(null),
    pending: mutation.isPending,
  };
}
