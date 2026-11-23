import { type AvailabilityQuery, permissionsFor } from "@sob/contracts";
import type { Database } from "@sob/db";
import { authorizeAppointmentChange } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { findAvailability } from "../availability/service";
import { getAppointmentOwnership, loadSnapshots } from "./service";

export async function getRescheduleAvailability(
  db: Database,
  id: string,
  query: AvailabilityQuery,
  principal: Principal,
  now: Date,
) {
  const ownership = await getAppointmentOwnership(db, id);
  authorizeAppointmentChange(principal, ownership, { version: 1, staffId: query.staffId }, now);
  const staffId =
    principal.role === "staff" &&
    !permissionsFor(principal.role, principal.accessPreset).allCalendars
      ? ownership.staffId
      : query.staffId;
  const snapshots = (await loadSnapshots(db, [id])).get(id) ?? [];
  snapshots.sort((a, b) => a.position - b.position);
  if (
    !snapshots.length ||
    snapshots.length !== query.serviceIds.length ||
    snapshots.some((line, index) => !line.serviceId || line.serviceId !== query.serviceIds[index])
  )
    throw new DomainError("validation_error", "Rescheduling must retain the booked services");

  return findAvailability(db, { ...query, staffId, combinationId: undefined }, now, {
    staffIds: ownership.combinationStaffIds ?? undefined,
    excludeAppointmentId: id,
    services: snapshots.map((line) => ({
      id: line.serviceId ?? line.id,
      durationMinutes: line.durationMinutes,
      bufferMinutes: line.bufferMinutes,
      ...(line.processingStartMinutes !== null && line.processingMinutes !== null
        ? {
            processing: {
              startsAfterMinutes: line.processingStartMinutes,
              minutes: line.processingMinutes,
            },
          }
        : {}),
    })),
  });
}
