import type { CalendarQuery, CalendarResponse } from "@sob/contracts";
import {
  appointment,
  appointmentService,
  clientProfile,
  type Database,
  staffProfile,
  timeOff,
  workingHours,
} from "@sob/db";
import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { DomainError } from "../../errors";
import { workingWindows } from "../availability/windows";
import { protectionView } from "../booking-protection/value";
import { calendarResources } from "../resources/reservations";
import { getSalonSettings } from "../settings/service";
import { loadSeriesReferences } from "./series-references";

/**
 * Everything a day/week calendar draws, in one round of queries: the columns (staff), the
 * appointments with client and service names already joined, time off, and the recurring hours
 * resolved to concrete windows in the salon timezone. `scope.staffIds` is whatever the policy
 * allowed; without it the calendar covers every active staff member.
 */
export async function getCalendar(
  db: Database,
  query: CalendarQuery,
  scope: { staffIds?: string[] },
): Promise<CalendarResponse> {
  const settings = await getSalonSettings(db);
  const from = new Date(query.from);
  const to = new Date(query.to);

  const requested = scope.staffIds;
  const columns = await db
    .select({ id: staffProfile.id, displayName: staffProfile.displayName })
    .from(staffProfile)
    .where(
      and(
        isNull(staffProfile.deletedAt),
        requested ? inArray(staffProfile.id, requested) : eq(staffProfile.active, true),
      ),
    )
    .orderBy(asc(staffProfile.displayName), asc(staffProfile.id));
  const missing = requested?.find((id) => !columns.some((c) => c.id === id));
  if (missing) throw new DomainError("not_found", `Staff member ${missing} not found`);

  const staffIds = columns.map((c) => c.id);
  if (staffIds.length === 0) {
    return {
      timezone: settings.timezone,
      from: query.from,
      to: query.to,
      staff: [],
      appointments: [],
      timeOff: [],
      workingWindows: [],
    };
  }

  const [rows, offs, hours] = await Promise.all([
    db
      .select({ row: appointment, clientName: clientProfile.name })
      .from(appointment)
      .innerJoin(clientProfile, eq(clientProfile.id, appointment.clientId))
      .where(
        and(
          inArray(appointment.staffId, staffIds),
          isNull(appointment.deletedAt),
          lt(appointment.startsAt, to),
          gt(appointment.endsAt, from),
        ),
      )
      .orderBy(asc(appointment.startsAt), asc(appointment.id)),
    db
      .select()
      .from(timeOff)
      .where(
        and(
          inArray(timeOff.staffId, staffIds),
          isNull(timeOff.deletedAt),
          lt(timeOff.startsAt, to),
          gt(timeOff.endsAt, from),
        ),
      )
      .orderBy(asc(timeOff.startsAt), asc(timeOff.id)),
    db
      .select()
      .from(workingHours)
      .where(and(inArray(workingHours.staffId, staffIds), isNull(workingHours.deletedAt))),
  ]);

  const snapshots = rows.length
    ? await db
        .select()
        .from(appointmentService)
        .where(
          inArray(
            appointmentService.appointmentId,
            rows.map((r) => r.row.id),
          ),
        )
    : [];

  const resources = await calendarResources(
    db,
    rows.map((r) => r.row.id),
  );
  const series = await loadSeriesReferences(
    db,
    rows.map((r) => r.row.id),
  );
  return {
    timezone: settings.timezone,
    from: query.from,
    to: query.to,
    staff: columns,
    appointments: await Promise.all(
      rows.map(async ({ row, clientName }) => {
        const own = snapshots
          .filter((s) => s.appointmentId === row.id)
          .sort((a, b) => a.position - b.position);
        return {
          ...(series.has(row.id) ? { series: series.get(row.id) } : {}),
          id: row.id,
          staffId: row.staffId,
          clientId: row.clientId,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          status: row.status,
          notes: row.notes,
          version: row.version,
          services: own.map((s) => ({
            serviceId: s.serviceId,
            name: s.name,
            durationMinutes: s.durationMinutes,
            bufferMinutes: s.bufferMinutes,
            priceCents: s.priceCents,
            currency: s.currency,
          })),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          protection: await protectionView(db, row.id),
          resources: resources.get(row.id) ?? [],
          clientName,
          serviceNames: own.map((s) => s.name),
        };
      }),
    ),
    timeOff: offs.map((o) => ({
      id: o.id,
      staffId: o.staffId,
      startsAt: o.startsAt.toISOString(),
      endsAt: o.endsAt.toISOString(),
      reason: o.reason,
    })),
    workingWindows: workingWindows({
      from,
      to,
      timeZone: settings.timezone,
      staff: staffIds.map((staffId) => ({
        staffId,
        workingHours: hours
          .filter((h) => h.staffId === staffId)
          .map((h) => ({ weekday: h.weekday, start: h.startTime, end: h.endTime })),
      })),
    }).map((w) => ({
      staffId: w.staffId,
      startsAt: w.startsAt.toISOString(),
      endsAt: w.endsAt.toISOString(),
    })),
  };
}
