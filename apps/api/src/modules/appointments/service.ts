import type {
  Appointment,
  AppointmentListQuery,
  CreateAppointmentRequest,
  UpdateAppointmentRequest,
} from "@sob/contracts";
import {
  appointment,
  appointmentService,
  clientProfile,
  type Database,
  EXCLUSION_VIOLATION,
  pgErrorCode,
  serviceStaff,
  timeOff,
  workingHours,
} from "@sob/db";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { DomainError } from "../../errors";
import { lockCalendars, type Tx } from "../../tx";
import { totalBlockMinutes } from "../availability/compute";
import { type BookingViolation, bookingViolations } from "../availability/rules";
import { getServicesByIds } from "../services/service";
import { getSalonSettings } from "../settings/service";
import { assertStaffExists } from "../staff/service";

const UNIQUE_VIOLATION = "23505";

const MS_PER_MINUTE = 60_000;

/** The authenticated caller on whose behalf a write happens; recorded in the audit log. */
export interface Actor {
  userId: string;
}

type AppointmentRow = typeof appointment.$inferSelect;
type SnapshotRow = typeof appointmentService.$inferSelect;

function toAppointment(row: AppointmentRow, snapshots: SnapshotRow[]): Appointment {
  return {
    id: row.id,
    staffId: row.staffId,
    clientId: row.clientId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    notes: row.notes,
    version: row.version,
    services: snapshots
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        serviceId: s.serviceId,
        name: s.name,
        durationMinutes: s.durationMinutes,
        bufferMinutes: s.bufferMinutes,
        priceCents: s.priceCents,
        currency: s.currency,
      })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Translates Postgres constraint failures into domain errors; rethrows anything else. */
function mapWriteError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === EXCLUSION_VIOLATION) {
    throw new DomainError("slot_taken", "The selected time slot is no longer available");
  }
  if (code === UNIQUE_VIOLATION) {
    throw new DomainError("invalid_state", "An appointment with this id already exists");
  }
  throw error;
}

async function assertStaffPerforms(db: Database, staffId: string, serviceIds: string[]) {
  const links = await db
    .select({ serviceId: serviceStaff.serviceId })
    .from(serviceStaff)
    .where(
      and(
        eq(serviceStaff.staffId, staffId),
        inArray(serviceStaff.serviceId, serviceIds),
        isNull(serviceStaff.deletedAt),
      ),
    );
  if (new Set(links.map((l) => l.serviceId)).size !== new Set(serviceIds).size) {
    throw new DomainError(
      "validation_error",
      "The staff member does not perform every selected service",
    );
  }
}

async function loadSnapshots(db: Database, appointmentIds: string[]) {
  if (appointmentIds.length === 0) return new Map<string, SnapshotRow[]>();
  const rows = await db
    .select()
    .from(appointmentService)
    .where(inArray(appointmentService.appointmentId, appointmentIds));
  const grouped = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    grouped.set(row.appointmentId, [...(grouped.get(row.appointmentId) ?? []), row]);
  }
  return grouped;
}

/**
 * Books an appointment. Availability is advisory; the exclusion constraint on
 * `appointment` is what actually prevents double-booking, and its violation becomes
 * `slot_taken`. The client row, the appointment and the service snapshots are written in
 * one transaction so a rejected booking leaves nothing behind.
 */
export async function createAppointment(
  db: Database,
  request: CreateAppointmentRequest,
  actor?: Actor,
  options: { now?: Date } = {},
): Promise<Appointment> {
  const now = options.now ?? new Date();
  await assertStaffExists(db, request.staffId);
  const settings = await getSalonSettings(db);
  const services = await getServicesByIds(db, request.serviceIds);
  await assertStaffPerforms(
    db,
    request.staffId,
    services.map((s) => s.id),
  );

  const startsAt = new Date(request.startsAt);
  const endsAt = new Date(startsAt.getTime() + totalBlockMinutes(services) * MS_PER_MINUTE);

  try {
    return await db.transaction(async (tx) => {
      await lockCalendars(tx, [request.staffId]);
      const noticeOverridden = await assertBookable(tx, {
        staffId: request.staffId,
        startsAt,
        endsAt,
        now,
        override: request.override === true,
        settings,
      });
      const clientId = await resolveClient(tx, request);
      const [row] = await tx
        .insert(appointment)
        .values({
          id: request.id,
          staffId: request.staffId,
          clientId,
          startsAt,
          endsAt,
          notes: request.notes,
        })
        .returning();
      if (!row) throw new Error("Appointment insert returned no row");
      const snapshots = await tx
        .insert(appointmentService)
        .values(
          services.map((s, position) => ({
            appointmentId: row.id,
            serviceId: s.id,
            position,
            name: s.name,
            durationMinutes: s.durationMinutes,
            bufferMinutes: s.bufferMinutes,
            priceCents: s.priceCents,
            currency: s.currency,
          })),
        )
        .returning();
      if (actor) {
        await recordAudit(tx, {
          actorUserId: actor.userId,
          action: "appointment.create",
          entity: "appointment",
          entityId: row.id,
          metadata: {
            staffId: row.staffId,
            clientId: row.clientId,
            startsAt: row.startsAt.toISOString(),
            endsAt: row.endsAt.toISOString(),
            serviceIds: services.map((s) => s.id),
            ...(request.override ? { override: true, noticeOverridden } : {}),
          },
        });
      }
      return toAppointment(row, snapshots);
    });
  } catch (error) {
    return mapWriteError(error);
  }
}

const VIOLATION_MESSAGES: Record<BookingViolation, (minNotice: number, maxDays: number) => string> =
  {
    max_days_ahead: (_minutes, days) => `Appointments can only be booked up to ${days} days ahead`,
    outside_working_hours: () => "The selected time is outside the staff member's working hours",
    time_off: () => "The staff member is on time off at the selected time",
    min_notice: (minutes) => `Appointments need at least ${minutes} minutes of notice`,
  };

/**
 * Enforces working hours, time off and the notice window for a new booking. The exclusion
 * constraint remains the source of truth for overlaps; these are the rules it cannot express.
 * Returns whether `override` actually bypassed the min-notice rule.
 */
async function assertBookable(
  tx: Tx,
  input: {
    staffId: string;
    startsAt: Date;
    endsAt: Date;
    now: Date;
    override: boolean;
    settings: Awaited<ReturnType<typeof getSalonSettings>>;
  },
): Promise<boolean> {
  const { staffId, startsAt, endsAt, settings } = input;
  const hours = await tx
    .select()
    .from(workingHours)
    .where(and(eq(workingHours.staffId, staffId), isNull(workingHours.deletedAt)));
  const offs = await tx
    .select()
    .from(timeOff)
    .where(
      and(
        eq(timeOff.staffId, staffId),
        isNull(timeOff.deletedAt),
        lt(timeOff.startsAt, endsAt),
        gt(timeOff.endsAt, startsAt),
      ),
    );
  const violations = bookingViolations({
    startsAt,
    endsAt,
    timeZone: settings.timezone,
    now: input.now,
    minNoticeMinutes: settings.minNoticeMinutes,
    maxDaysAhead: settings.maxDaysAhead,
    workingHours: hours.map((h) => ({ weekday: h.weekday, start: h.startTime, end: h.endTime })),
    timeOff: offs.map((o) => ({ start: o.startsAt, end: o.endsAt })),
  });
  const blocking = input.override ? violations.filter((v) => v !== "min_notice") : violations;
  const first = blocking[0];
  if (first) {
    throw new DomainError(
      "slot_unavailable",
      VIOLATION_MESSAGES[first](settings.minNoticeMinutes, settings.maxDaysAhead),
    );
  }
  return input.override && violations.includes("min_notice");
}

async function resolveClient(tx: Tx, request: CreateAppointmentRequest): Promise<string> {
  if (request.clientId) {
    const [existing] = await tx
      .select({ id: clientProfile.id })
      .from(clientProfile)
      .where(and(eq(clientProfile.id, request.clientId), isNull(clientProfile.deletedAt)));
    if (!existing) throw new DomainError("not_found", `Client ${request.clientId} not found`);
    return existing.id;
  }
  const inline = request.client;
  if (!inline)
    throw new DomainError("validation_error", "Provide exactly one of clientId or client");

  const matchers = [
    inline.email ? eq(clientProfile.email, inline.email) : undefined,
    inline.phone ? eq(clientProfile.phone, inline.phone) : undefined,
  ].filter((m) => m !== undefined);
  if (matchers.length > 0) {
    const [match] = await tx
      .select({ id: clientProfile.id })
      .from(clientProfile)
      .where(and(isNull(clientProfile.deletedAt), or(...matchers)))
      .limit(1);
    if (match) return match.id;
  }
  const [created] = await tx
    .insert(clientProfile)
    .values({ name: inline.name, email: inline.email, phone: inline.phone })
    .returning({ id: clientProfile.id });
  if (!created) throw new Error("Client insert returned no row");
  return created.id;
}

/** Who an appointment belongs to, for authorization decisions. */
export async function getAppointmentOwnership(
  db: Database,
  id: string,
): Promise<{ staffId: string; clientId: string }> {
  const [row] = await db
    .select({ staffId: appointment.staffId, clientId: appointment.clientId })
    .from(appointment)
    .where(and(eq(appointment.id, id), isNull(appointment.deletedAt)));
  if (!row) throw new DomainError("not_found", `Appointment ${id} not found`);
  return row;
}

export async function listAppointments(
  db: Database,
  query: AppointmentListQuery,
  scope: { clientId?: string } = {},
): Promise<Appointment[]> {
  const rows = await db
    .select()
    .from(appointment)
    .where(
      and(
        isNull(appointment.deletedAt),
        lt(appointment.startsAt, new Date(query.to)),
        gt(appointment.endsAt, new Date(query.from)),
        query.staffId ? eq(appointment.staffId, query.staffId) : undefined,
        scope.clientId ? eq(appointment.clientId, scope.clientId) : undefined,
      ),
    )
    .orderBy(asc(appointment.startsAt), asc(appointment.id));
  const snapshots = await loadSnapshots(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toAppointment(row, snapshots.get(row.id) ?? []));
}

/** Every appointment of one client, newest first (the CRM history view). */
export async function listClientAppointments(
  db: Database,
  clientId: string,
): Promise<Appointment[]> {
  const rows = await db
    .select()
    .from(appointment)
    .where(and(eq(appointment.clientId, clientId), isNull(appointment.deletedAt)))
    .orderBy(desc(appointment.startsAt), desc(appointment.id));
  const snapshots = await loadSnapshots(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toAppointment(row, snapshots.get(row.id) ?? []));
}

/**
 * Reschedules and/or cancels with optimistic concurrency: the UPDATE only matches when
 * `version` equals the caller's, otherwise the caller is told to refetch (409).
 */
export async function updateAppointment(
  db: Database,
  id: string,
  request: UpdateAppointmentRequest,
  actor?: Actor,
): Promise<Appointment> {
  const [current] = await db
    .select()
    .from(appointment)
    .where(and(eq(appointment.id, id), isNull(appointment.deletedAt)));
  if (!current) throw new DomainError("not_found", `Appointment ${id} not found`);
  if (current.version !== request.version) throw versionConflict();

  const snapshots = (await loadSnapshots(db, [id])).get(id) ?? [];
  const cancelling = request.status === "cancelled";
  const moving = request.startsAt !== undefined || request.staffId !== undefined;
  if ((cancelling || moving) && current.status !== "booked") {
    throw new DomainError("invalid_state", `A ${current.status} appointment cannot be changed`);
  }

  const staffId = request.staffId ?? current.staffId;
  if (request.staffId && request.staffId !== current.staffId) {
    await assertStaffExists(db, request.staffId);
    const serviceIds = snapshots.flatMap((s) => (s.serviceId ? [s.serviceId] : []));
    if (serviceIds.length > 0) await assertStaffPerforms(db, request.staffId, serviceIds);
  }

  const durationMs = current.endsAt.getTime() - current.startsAt.getTime();
  const startsAt = request.startsAt ? new Date(request.startsAt) : current.startsAt;

  try {
    const row = await db.transaction(async (tx) => {
      await lockCalendars(tx, [current.staffId, staffId]);
      const [updated] = await tx
        .update(appointment)
        .set({
          staffId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + durationMs),
          ...(cancelling ? { status: "cancelled" as const } : {}),
          ...(request.notes !== undefined ? { notes: request.notes } : {}),
          version: sql`${appointment.version} + 1`,
        })
        .where(and(eq(appointment.id, id), eq(appointment.version, request.version)))
        .returning();
      if (updated && actor) {
        await recordAudit(tx, {
          actorUserId: actor.userId,
          action: cancelling
            ? "appointment.cancel"
            : moving
              ? "appointment.reschedule"
              : "appointment.update",
          entity: "appointment",
          entityId: id,
          metadata: {
            from: current.startsAt.toISOString(),
            to: updated.startsAt.toISOString(),
            fromStaffId: current.staffId,
            toStaffId: updated.staffId,
            version: updated.version,
          },
        });
      }
      return updated;
    });
    if (!row) throw versionConflict();
    return toAppointment(row, snapshots);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    return mapWriteError(error);
  }
}

function versionConflict() {
  return new DomainError(
    "version_conflict",
    "The appointment was modified by someone else; reload and try again",
  );
}
