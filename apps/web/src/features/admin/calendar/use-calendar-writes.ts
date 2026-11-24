import type { CalendarResponse } from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { describeProblem, type Problem } from "../problems";
import {
  type CalendarMove,
  calendarWriteKey,
  persistCalendarMove,
  startCalendarWrite,
  usePendingCalendarWrites,
} from "./appointment-writes";
import { invalidateCalendarData, mergeAppointment } from "./cache";

export interface Conflict {
  appointmentId: string;
  problem: Problem;
}

/** Projects pending writes over the current version of each appointment. */
export function useCalendarWrites() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const pendingById = usePendingCalendarWrites();

  const { mutate } = useMutation({
    mutationKey: calendarWriteKey,
    mutationFn: persistCalendarMove,
    onError: (error, { appointment }) => {
      setConflict({ appointmentId: appointment.id, problem: describeProblem(error) });
    },
    onSuccess: (saved) => {
      queryClient.setQueriesData<CalendarResponse>({ queryKey: ["admin", "calendar"] }, (data) =>
        data ? mergeAppointment(data, saved) : data,
      );
      toast.success(t("calendar.toast.rescheduled"));
    },
    onSettled: () => {
      void invalidateCalendarData(queryClient);
    },
  });

  const move = useCallback(
    (proposal: Omit<CalendarMove, "override">) =>
      startCalendarWrite(queryClient, { ...proposal, override: true }, (command) => {
        setConflict(null);
        mutate(command);
      }),
    [mutate, queryClient],
  );
  const projectPendingWrites = useCallback(
    (data: CalendarResponse | undefined) => {
      if (!data || data.importSnapshot || pendingById.size === 0) return data;
      return {
        ...data,
        appointments: data.appointments.map((appointment) => {
          const pending = pendingById.get(appointment.id);
          if (pending?.appointment.version !== appointment.version) return appointment;
          if ("status" in pending) return { ...appointment, status: pending.status };
          if (!("to" in pending)) return appointment;
          const duration = Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt);
          return {
            ...appointment,
            ...pending.to,
            endsAt: new Date(Date.parse(pending.to.startsAt) + duration).toISOString(),
          };
        }),
      };
    },
    [pendingById],
  );

  const isWritePending = useCallback((id: string) => pendingById.has(id), [pendingById]);
  return {
    move,
    projectPendingWrites,
    isWritePending,
    conflict,
    clearConflict: () => setConflict(null),
  };
}
