import type { Appointment } from "@sob/contracts";
import { type Mutation, type QueryClient, useMutationState } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "~/lib/api/instance";

export type MoveRequest = Pick<Appointment, "staffId" | "startsAt">;
export type CalendarMove = {
  appointment: Pick<Appointment, "id" | "version" | "staffId" | "startsAt" | "endsAt">;
  to: MoveRequest;
  override: boolean;
  includeStaff?: boolean;
};

export type CalendarStatusChange = {
  appointment: Pick<Appointment, "id" | "version">;
  status: "completed" | "no_show" | "cancelled";
};

type CalendarWrite = CalendarMove | CalendarStatusChange;

export const calendarWriteKey = ["appointments", "calendar-write"] as const;
const writeFilter = { mutationKey: calendarWriteKey, exact: true };

// Writers sharing this key use one of the two reviewed commands.
const requestFor = (mutation: Mutation) => mutation.state.variables as CalendarWrite;

export function usePendingCalendarWrites() {
  const pending = useMutationState({
    filters: { ...writeFilter, status: "pending" },
    select: requestFor,
  });
  return useMemo(() => new Map(pending.map((write) => [write.appointment.id, write])), [pending]);
}

export function startCalendarWrite<Write extends CalendarWrite>(
  client: QueryClient,
  write: Write,
  submit: (write: Write) => void,
) {
  if (
    client.isMutating({
      ...writeFilter,
      predicate: (mutation) => requestFor(mutation).appointment.id === write.appointment.id,
    })
  )
    return;
  submit(write);
}

export function persistCalendarMove({ appointment, to, override, includeStaff }: CalendarMove) {
  return api().appointments.update(appointment.id, {
    version: appointment.version,
    startsAt: to.startsAt,
    ...(includeStaff || to.staffId !== appointment.staffId ? { staffId: to.staffId } : {}),
    ...(override ? { override: true } : {}),
  });
}

export function isLocalCalendarWrite(
  client: QueryClient,
  appointment: Pick<Appointment, "id" | "version" | "staffId" | "startsAt" | "status">,
  kind: "rescheduled" | "cancelled",
) {
  return client
    .getMutationCache()
    .findAll(writeFilter)
    .some((mutation) => {
      const { status, data } = mutation.state;
      const write = requestFor(mutation);
      if (write.appointment.id !== appointment.id || (status !== "pending" && status !== "success"))
        return false;
      const committed = status === "success" ? (data as Appointment) : undefined;
      if ((committed?.version ?? write.appointment.version + 1) !== appointment.version)
        return false;
      if ("status" in write)
        return kind === "cancelled" && committed?.status === appointment.status;
      return (
        kind === "rescheduled" &&
        (committed?.staffId ?? write.to.staffId) === appointment.staffId &&
        Date.parse(committed?.startsAt ?? write.to.startsAt) === Date.parse(appointment.startsAt)
      );
    });
}
