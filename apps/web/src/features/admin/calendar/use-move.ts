import type { CalendarResponse } from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { describeProblem, type Problem } from "../problems";
import { invalidateCalendarData, mergeAppointment } from "./cache";
import {
  type CalendarMove,
  calendarMoveKey,
  persistCalendarMove,
  startCalendarMove,
  usePendingCalendarMoves,
} from "./move-requests";

export interface Conflict {
  appointmentId: string;
  problem: Problem;
}

/** Projects reviewed moves over the latest calendar without rewriting the server cache. */
export function useMoveAppointment() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const pendingMoves = usePendingCalendarMoves();
  const pendingById = useMemo(
    () => new Map(pendingMoves.map((move) => [move.appointment.id, move])),
    [pendingMoves],
  );

  const { mutate } = useMutation({
    mutationKey: calendarMoveKey,
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
      startCalendarMove(queryClient, { ...proposal, override: true }, (command) => {
        setConflict(null);
        mutate(command);
      }),
    [mutate, queryClient],
  );
  const projectPendingMoves = useCallback(
    (data: CalendarResponse | undefined) => {
      if (!data || data.importSnapshot || pendingById.size === 0) return data;
      return {
        ...data,
        appointments: data.appointments.map((appointment) => {
          const pending = pendingById.get(appointment.id);
          if (pending?.appointment.version !== appointment.version) return appointment;
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

  const isMovePending = useCallback((id: string) => pendingById.has(id), [pendingById]);
  return {
    move,
    projectPendingMoves,
    isMovePending,
    conflict,
    clearConflict: () => setConflict(null),
  };
}
