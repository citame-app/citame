import type { CalendarQuery, CalendarResponse } from "@sob/contracts";
import {
  appointment,
  appointmentService,
  clientProfile,
  type Database,
  service,
  staffProfile,
  timeOff,
  workingHours,
} from "@sob/db";
import { and, asc, eq, getTableColumns, gt, inArray, isNull, lt } from "drizzle-orm";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { workingWindows } from "../availability/windows";
import { calendarProtections } from "../booking-protection/value";
import { calendarResources } from "../resources/reservations";
import { getSalonSettings } from "../settings/service";
import { asDatedHours, loadShiftRows } from "../staff/date-hours";
import { calendarBadges } from "./context";
import { loadBookingPrices } from "./pricing";
import { loadSeriesReferences } from "./series-references";

/**
 * Everything a day/week calendar draws, in one round of queries: the columns (staff), the
 * appointments with client and service names already joined, time off, and the recurring hours
 * resolved to concrete windows in the salon timezone. `scope.staffIds` is whatever the policy
 * allowed. Without it the calendar covers active staff unless a historical view includes
 * inactive staff explicitly.
 */
export async function getCalendar(
  db: Database | Tx,
  query: CalendarQuery,
  scope: { staffIds?: string[]; includeBilling: boolean; includeInactiveStaff?: boolean },
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
        requested
          ? inArray(staffProfile.id, requested)
          : scope.includeInactiveStaff
            ? undefined
            : eq(staffProfile.active, true),
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

  const [rows, offs, hours, dated] = await Promise.all([
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
    loadShiftRows(
      db,
      staffIds,
      Temporal.Instant.fromEpochMilliseconds(from.getTime())
        .toZonedDateTimeISO(settings.timezone)
        .toPlainDate()
        .toString(),
      Temporal.Instant.fromEpochMilliseconds(to.getTime())
        .toZonedDateTimeISO(settings.timezone)
        .toPlainDate()
        .toString(),
    ),
  ]);

  const snapshots = rows.length
    ? await db
        .select({ ...getTableColumns(appointmentService), color: service.color })
        .from(appointmentService)
        .leftJoin(service, eq(appointmentService.serviceId, service.id))
        .where(
          inArray(
            appointmentService.appointmentId,
            rows.map((r) => r.row.id),
          ),
        )
    : [];

  const appointmentIds = rows.map((r) => r.row.id);
  const [resources, series, protections, prices, badges] = await Promise.all([
    calendarResources(db, appointmentIds),
    loadSeriesReferences(db, appointmentIds),
    calendarProtections(db, appointmentIds),
    loadBookingPrices(db, scope.includeBilling ? appointmentIds : []),
    calendarBadges(
      db,
      rows.map((r) => r.row),
      snapshots,
      { includeBilling: scope.includeBilling },
    ),
  ]);
  const serviceSnapshots = new Map<string, typeof snapshots>();
  for (const snapshot of snapshots) {
    const own = serviceSnapshots.get(snapshot.appointmentId) ?? [];
    own.push(snapshot);
    serviceSnapshots.set(snapshot.appointmentId, own);
  }
  return {
    timezone: settings.timezone,
    from: query.from,
    to: query.to,
    staff: columns,
    appointments: rows.map(({ row, clientName }) => {
      const own = (serviceSnapshots.get(row.id) ?? []).sort((a, b) => a.position - b.position);
      const context = badges.get(row.id);
      const unresolved = own.filter((s) => s.sourceUnpriced && s.reviewedPriceCents === null);
      return {
        ...(prices.has(row.id) ? { bookingPrice: prices.get(row.id) } : {}),
        ...(series.has(row.id) ? { series: series.get(row.id) } : {}),
        ...(row.visitGroupId ? { visitGroupId: row.visitGroupId } : {}),
        id: row.id,
        staffId: row.staffId,
        clientId: row.clientId,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        status: row.status,
        notes: row.notes,
        version: row.version,
        ...(row.workWindows ? { workWindows: row.workWindows } : {}),
        services: own.map((s) => ({
          serviceId: s.serviceId,
          name: s.name,
          durationMinutes: s.durationMinutes,
          bufferMinutes: s.bufferMinutes,
          ...(s.processingStartMinutes !== null && s.processingMinutes !== null
            ? {
                processing: {
                  startsAfterMinutes: s.processingStartMinutes,
                  minutes: s.processingMinutes,
                },
              }
            : {}),
          priceCents: s.reviewedPriceCents ?? s.priceCents,
          ...(s.peakSurchargeCents ? { peakSurchargeCents: s.peakSurchargeCents } : {}),
          ...(s.priceType !== "fixed" ? { priceType: s.priceType } : {}),
          ...(s.sourceUnpriced && s.reviewedPriceCents === null
            ? { sourceUnpriced: true as const }
            : {}),
          currency: s.currency,
        })),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        protection: protections.get(row.id) ?? null,
        resources: resources.get(row.id) ?? [],
        clientName,
        serviceBadges: context?.badges ?? [],
        ...(context?.reasons.length ? { billingReviewReasons: context.reasons } : {}),
        ...(context?.externallySettled ? { externallySettled: true as const } : {}),
        ...(context?.importedFromBooksy ? { importedFromBooksy: true as const } : {}),
        ...(context?.booksyUnpaidConfirmed ? { booksyUnpaidConfirmed: true as const } : {}),
        ...(context?.externalBalance ? { externalBalance: context.externalBalance } : {}),
        ...(scope.includeBilling && unresolved.length && own.every((s) => s.currency === "EUR")
          ? { unpricedServices: unresolved.map(({ id, name }) => ({ id, name })) }
          : {}),
        serviceNames: own.map((s) => s.name),
        serviceColors: Object.fromEntries(
          own.flatMap((s) => (s.serviceId && s.color ? [[s.serviceId, s.color]] : [])),
        ),
      };
    }),
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
        datedWorkingHours: asDatedHours(dated, staffId),
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
