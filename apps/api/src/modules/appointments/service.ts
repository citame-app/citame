import {
  APPOINTMENT_PAGE_SIZE_DEFAULT,
  type Appointment,
  type AppointmentListQuery,
  type AppointmentStatus,
  type AppointmentTransition,
  type CreateAppointmentRequest,
  type ListAppointmentsResponse,
  type UpdateAppointmentRequest,
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
  user,
  waitlistOffer,
  workingHours,
} from "@sob/db";
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { DomainError } from "../../errors";
import {
  closeAppointment,
  rescheduleAppointment,
  scheduleNewAppointment,
} from "../../notifications/outbox";
import { lockCalendars, lockScheduling, type Tx } from "../../tx";
import { totalBlockMinutes } from "../availability/compute";
import { type BookingViolation, bookingViolations } from "../availability/rules";
import {
  createProtection,
  lockProtectionReceipt,
  protectionView,
  updateProtection,
} from "../booking-protection/value";
import { assertClientCanBook } from "../clients/controls";
import { refreshAppointmentCheckout } from "../commerce/service";
import { reassignAppointmentResources, reserveResources } from "../resources/reservations";
import { releaseUnfulfilledAppointmentRewards } from "../rewards/value";
import { getBookableServices } from "../services/service";
import { getSalonSettings } from "../settings/service";
import { assertStaffActive } from "../staff/guards";
import { assertStaffExists } from "../staff/service";
import { appointmentIntentFingerprint } from "./intent";
import { loadSeriesReferences } from "./series-references";

const UNIQUE_VIOLATION = "23505";

const MS_PER_MINUTE = 60_000;

/** The authenticated caller on whose behalf a write happens; recorded in the audit log. */
export interface Actor {
  userId: string;
  /** Set when the change came through a delegated channel (an MCP client acting for the user). */
  via?: { channel: string; clientId: string };
}

type AppointmentRow = typeof appointment.$inferSelect;
type SnapshotRow = typeof appointmentService.$inferSelect;

export function toAppointment(
  row: AppointmentRow,
  snapshots: SnapshotRow[],
  series?: Appointment["series"],
): Appointment {
  return {
    ...(series ? { series } : {}),
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

async function assertStaffPerforms(
  db: Pick<Database, "select">,
  staffId: string,
  serviceIds: string[],
  lock = false,
) {
  const query = db
    .select({ serviceId: serviceStaff.serviceId })
    .from(serviceStaff)
    .where(
      and(
        eq(serviceStaff.staffId, staffId),
        inArray(serviceStaff.serviceId, serviceIds),
        isNull(serviceStaff.deletedAt),
      ),
    );
  const links = await (lock ? query.for("share") : query);
  if (new Set(links.map((l) => l.serviceId)).size !== new Set(serviceIds).size) {
    throw new DomainError(
      "validation_error",
      "The staff member does not perform every selected service",
    );
  }
}

export async function loadSnapshots(db: Pick<Database, "select">, appointmentIds: string[]) {
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
  db: Database | Tx,
  request: CreateAppointmentRequest,
  actor?: Actor,
  options: { now?: Date } = {},
): Promise<Appointment> {
  const now = options.now ?? new Date();
  await assertStaffExists(db, request.staffId);
  const services = await getBookableServices(db, request.serviceIds, request.serviceQuotes);
  await assertStaffPerforms(
    db,
    request.staffId,
    services.map((s) => s.id),
  );

  const startsAt = new Date(request.startsAt);

  try {
    return await db.transaction(async (tx) => {
      await lockScheduling(tx);
      await lockCalendars(tx, [request.staffId]);
      const settings = await getSalonSettings(tx);
      const services = await getBookableServices(tx, request.serviceIds, request.serviceQuotes);
      const endsAt = new Date(startsAt.getTime() + totalBlockMinutes(services) * MS_PER_MINUTE);
      await assertStaffPerforms(
        tx,
        request.staffId,
        services.map((s) => s.id),
        true,
      );
      const noticeOverridden = await assertBookable(tx, {
        staffId: request.staffId,
        startsAt,
        endsAt,
        now,
        override: request.override === true,
        settings,
      });
      const clientId = await resolveClient(tx, request);
      await assertClientCanBook(tx, clientId);
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
      await reserveResources(
        tx,
        { appointmentId: row.id, startsAt: row.startsAt, endsAt: row.endsAt },
        services,
        now,
      );
      if (actor) {
        await recordAudit(tx, {
          actorUserId: actor.userId,
          action: "appointment.create",
          entity: "appointment",
          entityId: row.id,
          metadata: {
            requestFingerprint: appointmentIntentFingerprint(request),
            staffId: row.staffId,
            clientId: row.clientId,
            startsAt: row.startsAt.toISOString(),
            endsAt: row.endsAt.toISOString(),
            serviceIds: services.map((s) => s.id),
            ...(request.override ? { override: true, noticeOverridden } : {}),
            ...(actor.via ? { via: actor.via } : {}),
          },
        });
      }
      const protection = await createProtection(tx, row, request, actor, now);
      if (!protection || protection.state === "waived") await scheduleNewAppointment(tx, row, now);
      return { ...toAppointment(row, snapshots), ...(protection ? { protection } : {}) };
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
export async function assertBookable(
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
  await assertStaffActive(tx, staffId);
  const [heldOffer] = await tx
    .select({ id: waitlistOffer.id })
    .from(waitlistOffer)
    .where(
      and(
        eq(waitlistOffer.staffId, staffId),
        eq(waitlistOffer.state, "offered"),
        gt(waitlistOffer.expiresAt, input.now),
        lt(waitlistOffer.startsAt, endsAt),
        gt(waitlistOffer.endsAt, startsAt),
      ),
    )
    .limit(1);
  if (heldOffer)
    throw new DomainError(
      "slot_unavailable",
      "This time is temporarily reserved for a waitlist offer",
    );
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

  // Walk-in profiles (no login) match by email or phone. A profile with a login carries a phone
  // its owner typed and nobody verified, so it never matches by phone, and by email only when
  // the login has verified that address: otherwise a booking could land on someone else's account.
  const candidates = [
    inline.email
      ? or(
          and(isNull(clientProfile.userId), eq(clientProfile.email, inline.email)),
          and(eq(clientProfile.email, inline.email), eq(user.emailVerified, true)),
        )
      : undefined,
    inline.phone
      ? and(isNull(clientProfile.userId), eq(clientProfile.phone, inline.phone))
      : undefined,
  ].filter((m) => m !== undefined);
  if (candidates.length > 0) {
    const [match] = await tx
      .select({ id: clientProfile.id })
      .from(clientProfile)
      .leftJoin(user, eq(user.id, clientProfile.userId))
      .where(and(isNull(clientProfile.deletedAt), or(...candidates)))
      // Several duplicates are possible; always pick the oldest so the result is repeatable.
      .orderBy(asc(clientProfile.createdAt), asc(clientProfile.id))
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
): Promise<{ staffId: string; clientId: string; status: AppointmentStatus; startsAt: Date }> {
  const [row] = await db
    .select({
      staffId: appointment.staffId,
      clientId: appointment.clientId,
      status: appointment.status,
      startsAt: appointment.startsAt,
    })
    .from(appointment)
    .where(and(eq(appointment.id, id), isNull(appointment.deletedAt)));
  if (!row) throw new DomainError("not_found", `Appointment ${id} not found`);
  return row;
}

export async function listAppointments(
  db: Database,
  query: AppointmentListQuery,
  scope: { clientId?: string } = {},
): Promise<ListAppointmentsResponse> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? APPOINTMENT_PAGE_SIZE_DEFAULT;
  const where = and(
    isNull(appointment.deletedAt),
    lt(appointment.startsAt, new Date(query.to)),
    gt(appointment.endsAt, new Date(query.from)),
    query.staffId ? eq(appointment.staffId, query.staffId) : undefined,
    query.status ? inArray(appointment.status, query.status) : undefined,
    scope.clientId ? eq(appointment.clientId, scope.clientId) : undefined,
  );
  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(appointment)
      .where(where)
      .orderBy(asc(appointment.startsAt), asc(appointment.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(appointment).where(where),
  ]);
  const snapshots = await loadSnapshots(
    db,
    rows.map((r) => r.id),
  );
  const series = await loadSeriesReferences(
    db,
    rows.map((r) => r.id),
  );
  return {
    appointments: await Promise.all(
      rows.map(async (row) => ({
        ...toAppointment(row, snapshots.get(row.id) ?? [], series.get(row.id)),
        protection: await protectionView(db, row.id),
      })),
    ),
    page,
    pageSize,
    total: totals[0]?.total ?? 0,
  };
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
  const series = await loadSeriesReferences(
    db,
    rows.map((r) => r.id),
  );
  return Promise.all(
    rows.map(async (row) => ({
      ...toAppointment(row, snapshots.get(row.id) ?? [], series.get(row.id)),
      protection: await protectionView(db, row.id),
    })),
  );
}

type TransitionAction =
  | "appointment.cancel"
  | "appointment.complete"
  | "appointment.no_show"
  | "appointment.status_correct";

/**
 * The status state machine (ADR 0004):
 *
 *   booked -> completed | no_show   only once the appointment has started
 *   booked -> cancelled             any time
 *   completed <-> no_show           a correction (the policy restricts it to the owner)
 *   cancelled                       terminal
 *
 * Returns the audit action for the transition, or throws `invalid_state`.
 */
export function planTransition(
  current: { status: AppointmentStatus; startsAt: Date },
  target: AppointmentTransition,
  now: Date,
): TransitionAction {
  const { status } = current;
  if (status === "cancelled") {
    throw new DomainError("invalid_state", "A cancelled appointment cannot be changed");
  }
  if (target === "cancelled") {
    if (status !== "booked") {
      throw new DomainError("invalid_state", `A ${status} appointment cannot be cancelled`);
    }
    return "appointment.cancel";
  }
  if (status === target) {
    throw new DomainError("invalid_state", `The appointment is already ${target}`);
  }
  if (status === "booked") {
    if (current.startsAt.getTime() > now.getTime()) {
      throw new DomainError("invalid_state", "An appointment cannot be closed before it starts");
    }
    return target === "completed" ? "appointment.complete" : "appointment.no_show";
  }
  return "appointment.status_correct";
}

/**
 * Applies one change with optimistic concurrency: the UPDATE only matches when `version` equals
 * the caller's, otherwise the caller is told to refetch (409). A request either moves the
 * appointment (reschedule, validated like a new booking) or changes its status.
 */
export async function updateAppointment(
  db: Database,
  id: string,
  request: UpdateAppointmentRequest,
  actor?: Actor,
  options: { now?: Date } = {},
): Promise<Appointment> {
  const now = options.now ?? new Date();
  const [current] = await db
    .select()
    .from(appointment)
    .where(and(eq(appointment.id, id), isNull(appointment.deletedAt)));
  if (!current) throw new DomainError("not_found", `Appointment ${id} not found`);
  if (current.version !== request.version) throw versionConflict();

  const snapshots = (await loadSnapshots(db, [id])).get(id) ?? [];
  const moving = request.startsAt !== undefined || request.staffId !== undefined;
  const transitionAction = request.status
    ? planTransition(current, request.status, now)
    : undefined;
  if (moving && current.status !== "booked") {
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
  const endsAt = new Date(startsAt.getTime() + durationMs);
  // Re-sending the current start and staff is not a move, so it is not re-validated.
  const slotChanges =
    staffId !== current.staffId || startsAt.getTime() !== current.startsAt.getTime();
  const settings = slotChanges ? await getSalonSettings(db) : undefined;

  try {
    const row = await db.transaction(async (tx) => {
      await lockProtectionReceipt(tx, id);
      await lockScheduling(tx);
      await lockCalendars(tx, [current.staffId, staffId]);
      if (slotChanges)
        await assertStaffPerforms(
          tx,
          staffId,
          snapshots.flatMap((s) => (s.serviceId ? [s.serviceId] : [])),
          true,
        );
      if (slotChanges) await assertClientCanBook(tx, current.clientId);
      const noticeOverridden =
        settings !== undefined &&
        (await assertBookable(tx, {
          staffId,
          startsAt,
          endsAt,
          now,
          override: request.override === true,
          settings,
        }));
      const [updated] = await tx
        .update(appointment)
        .set({
          staffId,
          startsAt,
          endsAt,
          ...(request.status ? { status: request.status } : {}),
          ...(request.notes !== undefined ? { notes: request.notes } : {}),
          version: sql`${appointment.version} + 1`,
        })
        .where(and(eq(appointment.id, id), eq(appointment.version, request.version)))
        .returning();
      if (updated && slotChanges) await reassignAppointmentResources(tx, id, now);
      if (updated && actor) {
        await recordAudit(tx, {
          actorUserId: actor.userId,
          action: transitionAction ?? (moving ? "appointment.reschedule" : "appointment.update"),
          entity: "appointment",
          entityId: id,
          metadata: {
            from: current.startsAt.toISOString(),
            to: updated.startsAt.toISOString(),
            fromStaffId: current.staffId,
            toStaffId: updated.staffId,
            version: updated.version,
            ...(transitionAction ? { fromStatus: current.status, toStatus: updated.status } : {}),
            ...(slotChanges && request.override ? { override: true, noticeOverridden } : {}),
            ...(actor.via ? { via: actor.via } : {}),
          },
        });
      }
      if (updated) {
        await updateProtection(tx, current, updated, now, actor);
        if (updated.status === "cancelled" || updated.status === "no_show")
          await releaseUnfulfilledAppointmentRewards(tx, id, actor?.userId ?? null);
        if (updated.status === "completed") await refreshAppointmentCheckout(tx, id, now);
        if (updated.status === "cancelled" && current.status !== "cancelled") {
          await closeAppointment(tx, updated, now, { notify: true });
        } else if (updated.status !== "booked" && current.status === "booked") {
          await closeAppointment(tx, updated, now, { notify: false });
        } else if (
          updated.status === "booked" &&
          slotChanges &&
          (await protectionView(tx, id))?.state !== "pending"
        ) {
          await rescheduleAppointment(tx, updated, now);
        }
      }
      return updated;
    });
    if (!row) throw versionConflict();
    const protection = await protectionView(db, id);
    const series = (await loadSeriesReferences(db, [id])).get(id);
    return { ...toAppointment(row, snapshots, series), ...(protection ? { protection } : {}) };
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
