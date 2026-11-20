import { createHash } from "node:crypto";
import type {
  CreateTimeOffRequest,
  ListTimeOffQuery,
  ScheduleConflict,
  SetWorkingHoursRequest,
  TimeOff,
  TimeOffResponse,
  UpdateTimeOffRequest,
  WorkingHoursResponse,
  WorkingRange,
} from "@sob/contracts";
import {
  appointment,
  auditLog,
  type Database,
  staffProfile,
  timeOff,
  user,
  workingHours,
} from "@sob/db";
import { and, asc, eq, gt, isNull, lt, ne, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { authorizeStaffAdmin } from "../../auth/policy";
import { loadPrincipal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockCalendars } from "../../tx";
import { findConflicts } from "../availability/rules";
import { getSalonSettings } from "../settings/service";
import { type AdminActor, requireStaff } from "./admin";
import { asDatedHours, loadShiftRows, toWorkingRange } from "./date-hours";

type Executor = Pick<Database, "select">;
type TimeOffRow = typeof timeOff.$inferSelect;

function toTimeOff(row: TimeOffRow): TimeOff {
  return {
    id: row.id,
    staffId: row.staffId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
  };
}

const orderHours = (a: WorkingRange, b: WorkingRange) =>
  a.weekday - b.weekday ||
  a.startTime.localeCompare(b.startTime) ||
  a.endTime.localeCompare(b.endTime);

function sameHours(current: WorkingRange[], proposed: WorkingRange[]) {
  return (
    current.length === proposed.length &&
    [...proposed].sort(orderHours).every((range, index) => {
      const stored = current[index];
      return (
        stored?.weekday === range.weekday &&
        stored.startTime === range.startTime &&
        stored.endTime === range.endTime
      );
    })
  );
}

async function loadHours(db: Executor, staffId: string): Promise<WorkingRange[]> {
  const rows = await db
    .select()
    .from(workingHours)
    .where(and(eq(workingHours.staffId, staffId), isNull(workingHours.deletedAt)));
  return rows.map(toWorkingRange).sort(orderHours);
}

/**
 * Upcoming bookings of a staff member that do not fit their current schedule. Cancelled and
 * finished appointments never count. Read-only: schedule changes never move bookings.
 */
async function scheduleConflicts(
  db: Executor,
  staffId: string,
  now: Date,
): Promise<ScheduleConflict[]> {
  const settings = await getSalonSettings(db);
  const [appointments, hours, offs] = await Promise.all([
    db
      .select()
      .from(appointment)
      .where(
        and(
          eq(appointment.staffId, staffId),
          ne(appointment.status, "cancelled"),
          isNull(appointment.deletedAt),
          gt(appointment.endsAt, now),
        ),
      )
      .orderBy(asc(appointment.startsAt), asc(appointment.id)),
    db
      .select()
      .from(workingHours)
      .where(and(eq(workingHours.staffId, staffId), isNull(workingHours.deletedAt))),
    db
      .select()
      .from(timeOff)
      .where(and(eq(timeOff.staffId, staffId), isNull(timeOff.deletedAt), gt(timeOff.endsAt, now))),
  ]);
  const byId = new Map(appointments.map((a) => [a.id, a]));
  return findConflicts({
    now,
    timeZone: settings.timezone,
    appointments: appointments.map((a) => ({
      id: a.id,
      status: a.status,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
    })),
    workingHours: hours.map((h) => ({ weekday: h.weekday, start: h.startTime, end: h.endTime })),
    datedWorkingHours: asDatedHours(await loadShiftRows(db, [staffId])),
    timeOff: offs.map((o) => ({ start: o.startsAt, end: o.endsAt })),
  }).flatMap((conflict) => {
    const row = byId.get(conflict.id);
    if (!row) return [];
    return [
      {
        appointmentId: conflict.id,
        clientId: row.clientId,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        reasons: conflict.reasons,
      },
    ];
  });
}

async function hoursRevision(
  db: Executor,
  staffId: string,
  generation: string,
  hours: WorkingRange[],
): Promise<string> {
  // Audit entries are append-only. Include them all so returning to an earlier schedule
  // (including a fully closed week) still invalidates a draft made before the change.
  const [history] = await db
    .select({
      entries: sql<string>`coalesce(string_agg(${auditLog.id}::text, ',' order by ${auditLog.id}), '')`,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, "staff"),
        eq(auditLog.entityId, staffId),
        eq(auditLog.action, "working_hours.replace"),
      ),
    );
  return createHash("sha256")
    .update(JSON.stringify([staffId, generation, history?.entries ?? "", hours]))
    .digest("hex");
}

async function weeklyHoursSnapshot(
  db: Executor,
  staffId: string,
  now: Date,
  generation: string,
): Promise<WorkingHoursResponse> {
  await requireStaff(db, staffId);
  const hours = await loadHours(db, staffId);
  const revision = await hoursRevision(db, staffId, generation, hours);
  const conflicts = (await scheduleConflicts(db, staffId, now)).filter((c) =>
    c.reasons.includes("outside_working_hours"),
  );
  return { staffId, revision, hours, conflicts };
}

export function getWorkingHours(db: Database, staffId: string, now: Date, generation: string) {
  return db.transaction((tx) => weeklyHoursSnapshot(tx, staffId, now, generation), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/**
 * Replaces the whole weekly schedule. Old rows are soft-deleted (they are sync tombstones), the
 * new ones inserted, all under the calendar lock and in one transaction with the audit entry.
 */
export async function replaceWorkingHours(
  db: Database,
  staffId: string,
  request: SetWorkingHoursRequest,
  actor: AdminActor,
  now: Date,
  { generation, requireRevision }: { generation: string; requireRevision: boolean },
): Promise<WorkingHoursResponse> {
  if (requireRevision && request.expectedRevision === undefined)
    throw new DomainError("validation_error", "Load the current weekly hours before saving");
  return db.transaction(async (tx) => {
    await lockCalendars(tx, [staffId]);
    const [account] = await tx
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, actor.userId))
      .for("share");
    if (account?.role === "staff")
      await tx
        .select({ id: staffProfile.id })
        .from(staffProfile)
        .where(and(eq(staffProfile.userId, actor.userId), isNull(staffProfile.deletedAt)))
        .for("share");
    const current = await loadPrincipal(tx, actor.userId);
    if (!current) throw new DomainError("forbidden", "This account is no longer available");
    authorizeStaffAdmin(current);
    await requireStaff(tx, staffId);
    if (request.expectedRevision !== undefined) {
      const saved = await loadHours(tx, staffId);
      if (sameHours(saved, request.hours)) return weeklyHoursSnapshot(tx, staffId, now, generation);
      if ((await hoursRevision(tx, staffId, generation, saved)) !== request.expectedRevision)
        throw new DomainError(
          "version_conflict",
          "The weekly schedule changed. Load the current hours before saving.",
        );
    }
    const replaced = await tx
      .update(workingHours)
      .set({ deletedAt: now })
      .where(and(eq(workingHours.staffId, staffId), isNull(workingHours.deletedAt)))
      .returning({ id: workingHours.id });
    if (request.hours.length > 0) {
      await tx.insert(workingHours).values(
        request.hours.map((range) => ({
          staffId,
          weekday: range.weekday,
          startTime: range.startTime,
          endTime: range.endTime,
        })),
      );
    }
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "working_hours.replace",
      entity: "staff",
      entityId: staffId,
      metadata: { ranges: request.hours.length, replacedRanges: replaced.length },
    });
    return weeklyHoursSnapshot(tx, staffId, now, generation);
  });
}

export async function listTimeOff(
  db: Database,
  staffId: string,
  query: ListTimeOffQuery,
): Promise<TimeOff[]> {
  await requireStaff(db, staffId);
  const rows = await db
    .select()
    .from(timeOff)
    .where(
      and(
        eq(timeOff.staffId, staffId),
        isNull(timeOff.deletedAt),
        query.from ? gt(timeOff.endsAt, new Date(query.from)) : undefined,
        query.to ? lt(timeOff.startsAt, new Date(query.to)) : undefined,
      ),
    )
    .orderBy(asc(timeOff.startsAt), asc(timeOff.id));
  return rows.map(toTimeOff);
}

/** Conflicts caused by one time-off entry: upcoming bookings that overlap it. */
async function conflictsFor(db: Executor, row: TimeOffRow, now: Date) {
  return (await scheduleConflicts(db, row.staffId, now)).filter(
    (c) =>
      c.reasons.includes("time_off") &&
      Date.parse(c.startsAt) < row.endsAt.getTime() &&
      Date.parse(c.endsAt) > row.startsAt.getTime(),
  );
}

export async function createTimeOff(
  db: Database,
  staffId: string,
  request: CreateTimeOffRequest,
  actor: AdminActor,
  now: Date,
  options: { id?: string } = {},
): Promise<TimeOffResponse> {
  return db.transaction(async (tx) => {
    await lockCalendars(tx, [staffId]);
    await requireStaff(tx, staffId);
    const [row] = await tx
      .insert(timeOff)
      .values({
        id: options.id,
        staffId,
        startsAt: new Date(request.startsAt),
        endsAt: new Date(request.endsAt),
        reason: request.reason ?? null,
      })
      .returning();
    if (!row) throw new Error("Time off insert returned no row");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "time_off.create",
      entity: "time_off",
      entityId: row.id,
      metadata: { staffId, startsAt: request.startsAt, endsAt: request.endsAt },
    });
    return { timeOff: toTimeOff(row), conflicts: await conflictsFor(tx, row, now) };
  });
}

async function requireTimeOff(db: Executor, staffId: string, id: string): Promise<TimeOffRow> {
  const [row] = await db
    .select()
    .from(timeOff)
    .where(and(eq(timeOff.id, id), eq(timeOff.staffId, staffId), isNull(timeOff.deletedAt)));
  if (!row) throw new DomainError("not_found", `Time off ${id} not found`);
  return row;
}

export async function updateTimeOff(
  db: Database,
  staffId: string,
  id: string,
  request: UpdateTimeOffRequest,
  actor: AdminActor,
  now: Date,
): Promise<TimeOffResponse> {
  return db.transaction(async (tx) => {
    await lockCalendars(tx, [staffId]);
    const current = await requireTimeOff(tx, staffId, id);
    const startsAt = request.startsAt ? new Date(request.startsAt) : current.startsAt;
    const endsAt = request.endsAt ? new Date(request.endsAt) : current.endsAt;
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new DomainError("validation_error", "endsAt: must be after startsAt");
    }
    const [row] = await tx
      .update(timeOff)
      .set({
        startsAt,
        endsAt,
        ...(request.reason !== undefined ? { reason: request.reason } : {}),
      })
      .where(eq(timeOff.id, id))
      .returning();
    if (!row) throw new Error("Time off update returned no row");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "time_off.update",
      entity: "time_off",
      entityId: id,
      metadata: {
        staffId,
        changed: Object.keys(request).sort(),
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
      },
    });
    return { timeOff: toTimeOff(row), conflicts: await conflictsFor(tx, row, now) };
  });
}

export async function deleteTimeOff(
  db: Database,
  staffId: string,
  id: string,
  actor: AdminActor,
  now: Date,
): Promise<TimeOffResponse> {
  return db.transaction(async (tx) => {
    await lockCalendars(tx, [staffId]);
    await requireTimeOff(tx, staffId, id);
    const [row] = await tx
      .update(timeOff)
      .set({ deletedAt: now })
      .where(eq(timeOff.id, id))
      .returning();
    if (!row) throw new Error("Time off delete returned no row");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "time_off.delete",
      entity: "time_off",
      entityId: id,
      metadata: { staffId },
    });
    return { timeOff: toTimeOff(row), conflicts: [] };
  });
}
