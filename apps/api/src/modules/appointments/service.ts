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
} from "@sob/db";
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { DomainError } from "../../errors";
import { totalBlockMinutes } from "../availability/compute";
import { getServicesByIds } from "../services/service";
import { assertStaffExists } from "../staff/service";

const UNIQUE_VIOLATION = "23505";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Serializes writers that touch the same staff calendars. The exclusion constraint alone is
 * enough for correctness, but concurrent inserts with partially overlapping ranges can
 * deadlock inside Postgres (each waits for the other's uncommitted row). A transaction-scoped
 * advisory lock per staff member makes them queue instead, and the constraint still has the
 * final say.
 */
async function lockCalendars(tx: Tx, staffIds: string[]) {
  for (const id of [...new Set(staffIds)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
  }
}
const MS_PER_MINUTE = 60_000;

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
): Promise<Appointment> {
  await assertStaffExists(db, request.staffId);
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
      return toAppointment(row, snapshots);
    });
  } catch (error) {
    return mapWriteError(error);
  }
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

/**
 * Reschedules and/or cancels with optimistic concurrency: the UPDATE only matches when
 * `version` equals the caller's, otherwise the caller is told to refetch (409).
 */
export async function updateAppointment(
  db: Database,
  id: string,
  request: UpdateAppointmentRequest,
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
