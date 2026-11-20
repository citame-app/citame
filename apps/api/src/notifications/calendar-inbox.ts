import type { CalendarInboxQuery, CalendarNotice } from "@sob/contracts";
import { permissionsFor } from "@sob/contracts";
import {
  appointment,
  auditLog,
  calendarNoticeArchive,
  clientProfile,
  type Database,
} from "@sob/db";
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { requireRole } from "../auth/policy";
import type { Principal } from "../auth/principal";
import { DomainError } from "../errors";
import { loadSnapshots } from "../modules/appointments/service";

const actions = {
  new: "appointment.create",
  rescheduled: "appointment.reschedule",
  cancelled: "appointment.cancel",
} as const;

function visibleTo(p: Principal) {
  requireRole(p, "owner", "staff");
  if (!permissionsFor(p.role, p.accessPreset).allCalendars && !p.staffId)
    throw new DomainError("forbidden", "Your account has no calendar");
  return and(
    eq(auditLog.entity, "appointment"),
    inArray(auditLog.action, Object.values(actions)),
    isNull(appointment.deletedAt),
    isNull(clientProfile.deletedAt),
    permissionsFor(p.role, p.accessPreset).allCalendars
      ? undefined
      : eq(appointment.staffId, p.staffId as string),
  );
}

export async function calendarInbox(db: Database, p: Principal, query: CalendarInboxQuery) {
  const where = and(
    visibleTo(p),
    query.kind ? eq(auditLog.action, actions[query.kind]) : undefined,
    query.archived === "true"
      ? isNotNull(calendarNoticeArchive.auditId)
      : isNull(calendarNoticeArchive.auditId),
  );
  const page = query.page ?? 1;
  const pageSize = 25;
  return db.transaction(
    async (tx) => {
      const source = () =>
        tx
          .select({
            event: auditLog,
            booking: appointment,
            clientName: clientProfile.name,
          })
          .from(auditLog)
          .innerJoin(appointment, eq(auditLog.entityId, sql<string>`${appointment.id}::text`))
          .innerJoin(clientProfile, eq(appointment.clientId, clientProfile.id))
          .leftJoin(
            calendarNoticeArchive,
            and(
              eq(calendarNoticeArchive.auditId, auditLog.id),
              eq(calendarNoticeArchive.userId, p.userId),
            ),
          );
      const rows = await source()
        .where(where)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [total] = await tx
        .select({ n: count() })
        .from(auditLog)
        .innerJoin(appointment, eq(auditLog.entityId, sql<string>`${appointment.id}::text`))
        .innerJoin(clientProfile, eq(appointment.clientId, clientProfile.id))
        .leftJoin(
          calendarNoticeArchive,
          and(
            eq(calendarNoticeArchive.auditId, auditLog.id),
            eq(calendarNoticeArchive.userId, p.userId),
          ),
        )
        .where(where);
      const snapshots = await loadSnapshots(
        tx,
        rows.map(({ booking }) => booking.id),
      );
      const entries: CalendarNotice[] = rows.map(({ event, booking, clientName }) => {
        const scheduled =
          event.action === actions.new ? event.metadata.startsAt : event.metadata.to;
        const startsAt =
          typeof scheduled === "string" && Number.isFinite(Date.parse(scheduled))
            ? new Date(scheduled).toISOString()
            : booking.startsAt.toISOString();
        return {
          id: event.id,
          kind:
            event.action === actions.new
              ? "new"
              : event.action === actions.rescheduled
                ? "rescheduled"
                : "cancelled",
          createdAt: event.createdAt.toISOString(),
          appointmentId: booking.id,
          staffId: booking.staffId,
          startsAt,
          appointmentStartsAt: booking.startsAt.toISOString(),
          clientName,
          serviceNames: (snapshots.get(booking.id) ?? []).map((s) => s.name),
        };
      });
      return { entries, total: total?.n ?? 0, page, pageSize };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function archiveCalendarNotices(
  db: Database,
  p: Principal,
  input: { ids: string[]; archived: boolean },
) {
  const scope = visibleTo(p);
  const ids = [...new Set(input.ids)];
  await db.transaction(async (tx) => {
    const visible = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .innerJoin(appointment, eq(auditLog.entityId, sql<string>`${appointment.id}::text`))
      .innerJoin(clientProfile, eq(appointment.clientId, clientProfile.id))
      .where(and(scope, inArray(auditLog.id, ids)));
    if (visible.length !== ids.length)
      throw new DomainError("forbidden", "These notifications are not available to your account");
    if (input.archived) {
      await tx
        .insert(calendarNoticeArchive)
        .values(ids.map((auditId) => ({ auditId, userId: p.userId })))
        .onConflictDoNothing();
    } else {
      await tx
        .delete(calendarNoticeArchive)
        .where(
          and(
            eq(calendarNoticeArchive.userId, p.userId),
            inArray(calendarNoticeArchive.auditId, ids),
          ),
        );
    }
  });
  return { ok: true as const };
}
