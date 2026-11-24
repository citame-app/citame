import type { Appointment } from "@sob/contracts";
import { type Mutation, type QueryClient, useMutationState } from "@tanstack/react-query";
import { api } from "~/lib/api/instance";

export type MoveRequest = Pick<Appointment, "staffId" | "startsAt">;
export type CalendarMove = {
  appointment: Pick<Appointment, "id" | "version" | "staffId" | "startsAt" | "endsAt">;
  to: MoveRequest;
  override: boolean;
  includeStaff?: boolean;
};

export const calendarMoveKey = ["appointments", "calendar-move"] as const;
const moveFilter = { mutationKey: calendarMoveKey, exact: true };

// Only the grid and appointment drawer register this mutation, using the same input and output.
const requestFor = (mutation: Mutation) => mutation.state.variables as CalendarMove;

export function usePendingCalendarMoves() {
  return useMutationState({
    filters: { ...moveFilter, status: "pending" },
    select: requestFor,
  });
}

export function startCalendarMove(
  client: QueryClient,
  move: CalendarMove,
  submit: (move: CalendarMove) => void,
) {
  if (
    client.isMutating({
      ...moveFilter,
      predicate: (mutation) => requestFor(mutation).appointment.id === move.appointment.id,
    })
  )
    return;
  submit(move);
}

export function persistCalendarMove({ appointment, to, override, includeStaff }: CalendarMove) {
  return api().appointments.update(appointment.id, {
    version: appointment.version,
    startsAt: to.startsAt,
    ...(includeStaff || to.staffId !== appointment.staffId ? { staffId: to.staffId } : {}),
    ...(override ? { override: true } : {}),
  });
}

export function isLocalCalendarMove(
  client: QueryClient,
  appointment: Pick<Appointment, "id" | "version" | "staffId" | "startsAt">,
) {
  return client
    .getMutationCache()
    .findAll(moveFilter)
    .some((mutation) => {
      const { status, data } = mutation.state;
      const move = requestFor(mutation);
      if (!move || move.appointment.id !== appointment.id) return false;
      const committed = status === "success" ? (data as Appointment) : undefined;
      return (
        (status === "pending" || status === "success") &&
        (committed?.version ?? move.appointment.version + 1) === appointment.version &&
        (committed?.staffId ?? move.to.staffId) === appointment.staffId &&
        Date.parse(committed?.startsAt ?? move.to.startsAt) === Date.parse(appointment.startsAt)
      );
    });
}
