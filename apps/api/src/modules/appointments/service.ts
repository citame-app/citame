import {
  APPOINTMENT_PAGE_SIZE_DEFAULT,
  type Appointment,
  type AppointmentListQuery,
  type AppointmentStatus,
  type AppointmentTransition,
  type CreateAppointmentRequest,
  type ListAppointmentsResponse,
  needsFinalPrice,
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
  staffProfile,
  timeOff,
  user,
  workingHours,
} from "@sob/db";
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { type McpAuditSource, recordAudit } from "../../audit";
import { clientIdentityIds, requireClientRoot } from "../../client-identity";
import { DomainError } from "../../errors";
import {
  closeAppointment,
  rescheduleAppointment,
  scheduleNewAppointment,
} from "../../notifications/outbox";
import { lockCalendars, lockScheduling, type Tx } from "../../tx";
import { totalBlockMinutes } from "../availability/compute";
import { type BookingViolation, bookingViolations } from "../availability/rules";
import { findAvailability } from "../availability/service";
import {
  releaseExpiredStaffOffers,
  repackStaff,
  staffOccupied,
} from "../availability/staff-reservations";
import {
  createStaffCapacityCalendar,
  serviceWorkWindows,
  type WorkWindow,
} from "../availability/work-windows";
import {
  createProtection,
  lockProtectionReceipt,
  protectionView,
  updateProtection,
} from "../booking-protection/value";
import { assertClientCanBook } from "../clients/controls";
import { prepareBookingIntake, recordBookingIntake } from "../clients/intake-booking";
import { refreshAppointmentCheckout } from "../commerce/service";
import { assertPeakReview, quotePeakSlot } from "../peak-prices/service";
import { reassignAppointmentResources, reserveResources } from "../resources/reservations";
import { applyBookingPromotion } from "../rewards/booking";
import { awardAppointmentStamp, reverseAppointmentStamp } from "../rewards/stamps";
import { assertPromotionReschedule } from "../rewards/timing";
import { releaseUnfulfilledAppointmentRewards } from "../rewards/value";
import { assertCombinationStaff, resolveBookingSelection } from "../services/combination-booking";
import { assertOnlineServices, getBookableServices } from "../services/service";
import { assertOnlineBookingEnabled, getSalonSettings } from "../settings/service";
import { loadDatedHours } from "../staff/date-hours";
import { assertStaffActive } from "../staff/guards";
import { assertStaffExists } from "../staff/service";
import { appointmentIntentFingerprint } from "./intent";
import { loadBookingPrices } from "./pricing";
import { loadSeriesReferences } from "./series-references";

const UNIQUE_VIOLATION = "23505";

const MS_PER_MINUTE = 60_000;

/** The authenticated caller on whose behalf a write happens; recorded in the audit log. */
export interface Actor {
  userId: string;
  role?: "owner" | "staff" | "client";
  /** Set when the change came through a delegated channel (an MCP client acting for the user). */
  via?: McpAuditSource;
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
    ...(row.combinationId ? { combinationId: row.combinationId } : {}),
    services: snapshots
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
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
        ...(s.sourceUnpriced && s.reviewedPriceCents === null
          ? { sourceUnpriced: true as const }
          : {}),
        ...(s.priceType !== "fixed" ? { priceType: s.priceType } : {}),
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

export async function assertStaffPerforms(
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
  options: { now?: Date; sequentialContinuation?: boolean; desktopReviewed?: boolean } = {},
): Promise<Appointment> {
  const now = options.now ?? new Date();
  await assertStaffExists(db, request.staffId);
  if (!request.combination) {
    const services = await getBookableServices(db, request.serviceIds, request.serviceQuotes);
    await assertStaffPerforms(
      db,
      request.staffId,
      services.map((s) => s.id),
    );
  }

  const startsAt = new Date(request.startsAt);

  try {
    return await db.transaction(async (tx) => {
      await lockScheduling(tx);
      await lockCalendars(tx, [request.staffId]);
      const settings = await getSalonSettings(tx, actor?.role === "client" ? "share" : undefined);
      assertOnlineBookingEnabled(settings, actor?.role);
      const onlineCustomer = await assertOnlineServices(tx, request.serviceIds, actor?.userId);
      const { services, fixed } = await resolveBookingSelection(tx, request);
      if (fixed && onlineCustomer && !fixed.onlineBooking)
        throw new DomainError("not_found", "Combination unavailable for online booking");
      if (fixed) await assertCombinationStaff(tx, request.staffId, fixed.staffIds);
      else
        await assertStaffPerforms(
          tx,
          request.staffId,
          services.map((s) => s.id),
          true,
        );
      const peak = await quotePeakSlot(tx, services, startsAt, settings.timezone, fixed?.review);
      assertPeakReview(peak, request.peakPriceReview);
      const prices = new Map(peak.services.map((line) => [line.serviceId, line]));
      if (
        onlineCustomer &&
        services.some((s) => needsFinalPrice(s.priceType)) &&
        request.priceTermsAccepted !== true
      )
        throw new DomainError(
          "version_conflict",
          "Review and accept the pending-price terms before booking",
        );
      if (
        onlineCustomer &&
        services[0]?.bookingIntervalMinutes &&
        !options.sequentialContinuation
      ) {
        const date = Temporal.Instant.fromEpochMilliseconds(startsAt.getTime())
          .toZonedDateTimeISO(settings.timezone)
          .toPlainDate()
          .toString();
        const availability = await findAvailability(
          tx,
          { date, serviceIds: request.serviceIds, staffId: request.staffId },
          now,
          fixed ? { services, staffIds: fixed.staffIds } : undefined,
        );
        if (!availability.slots.some((slot) => Date.parse(slot.startsAt) === startsAt.getTime()))
          throw new DomainError("validation_error", "Choose a start time offered for this service");
      }
      const endsAt = new Date(startsAt.getTime() + totalBlockMinutes(services) * MS_PER_MINUTE);
      const noticeOverridden = await assertBookable(tx, {
        staffId: request.staffId,
        startsAt,
        endsAt,
        now,
        override: request.override === true,
        settings,
        workWindows: serviceWorkWindows(services),
      });
      const clientId = await resolveClient(tx, request, options.desktopReviewed === true);
      await assertClientCanBook(tx, clientId, true);
      const intake = await prepareBookingIntake(
        tx,
        request,
        clientId,
        actor?.userId,
        now,
        services,
        options.desktopReviewed === true,
      );
      const [row] = await tx
        .insert(appointment)
        .values({
          id: request.id,
          staffId: request.staffId,
          clientId,
          startsAt,
          endsAt,
          notes: request.notes,
          ...(fixed ? { combinationId: fixed.review.id, combinationStaffIds: fixed.staffIds } : {}),
          requestedStaffId: request.professionalPreference === "specific" ? request.staffId : null,
          customerComment: actor?.role === "client" ? request.notes?.trim() || null : null,
          ...(request.promotion ? { createdAt: now } : {}),
          ...(services.some((s) => s.processing)
            ? { workWindows: sql`${JSON.stringify(serviceWorkWindows(services))}::jsonb` }
            : {}),
        })
        .returning();
      if (!row) throw new Error("Appointment insert returned no row");
      await repackStaff(tx, row.staffId, now, { appointmentId: row.id });
      await recordBookingIntake(tx, intake, clientId, row.id, now);
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
            processingStartMinutes: s.processing?.startsAfterMinutes ?? null,
            processingMinutes: s.processing?.minutes ?? null,
            priceCents: prices.get(s.id)?.priceCents ?? s.priceCents,
            peakSurchargeCents: prices.get(s.id)?.surchargeCents || null,
            priceType: s.priceType ?? "fixed",
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
            ...(fixed ? { combination: fixed.review } : {}),
            ...(request.priceTermsAccepted
              ? {
                  priceTermsConfirmed: true,
                  ...(request.protectionAcceptedDepositCents !== undefined
                    ? { acceptedDepositCents: request.protectionAcceptedDepositCents }
                    : {}),
                }
              : {}),
            intakeConfirmed: Boolean(
              request.intakeResponses?.length || request.intakeSubmissionIds?.length,
            ),
            ...(request.promotion ? { promotionConfirmed: true } : {}),
            ...(peak.review
              ? {
                  peakPriceConfirmed: true,
                  peakPriceLines: peak.services.filter((line) => line.surchargeCents),
                }
              : {}),
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
      await applyBookingPromotion(tx, row, request, actor?.userId, now);
      const protection = await createProtection(tx, row, request, actor, now);
      // A zero-total promotional receipt cannot fulfill before its deposit policy exists.
      if (request.promotion) await refreshAppointmentCheckout(tx, row.id, now);
      if (!protection || protection.state === "waived") await scheduleNewAppointment(tx, row, now);
      const bookingPrice = (await loadBookingPrices(tx, [row.id])).get(row.id);
      return {
        ...toAppointment(row, snapshots),
        ...(protection ? { protection } : {}),
        ...(bookingPrice ? { bookingPrice } : {}),
      };
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
 * Checks capacity, working hours, time off and notice. Callers planning a write hold the
 * scheduling lock and release expired reservations. The preview only reads occupancy.
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
    workWindows?: WorkWindow[];
    excludeAppointmentId?: string;
    preview?: boolean;
  },
): Promise<boolean> {
  const { staffId, startsAt, endsAt, settings } = input;
  await assertStaffActive(tx, staffId);
  if (!input.preview) await releaseExpiredStaffOffers(tx, [staffId], input.now);
  const [member] = await tx
    .select({ capacity: staffProfile.maxConcurrent })
    .from(staffProfile)
    .where(eq(staffProfile.id, staffId));
  const work = input.workWindows ?? [
    { offsetMinutes: 0, endOffsetMinutes: (endsAt.getTime() - startsAt.getTime()) / 60000 },
  ];
  const candidate = work.map((w) => ({
    start: startsAt.getTime() + w.offsetMinutes * 60000,
    end: startsAt.getTime() + w.endOffsetMinutes * 60000,
  }));
  const busy = await staffOccupied(
    tx,
    [staffId],
    startsAt,
    endsAt,
    input.now,
    input.excludeAppointmentId,
  );
  const intervals = (rows: typeof busy) =>
    rows.map((r) => ({ start: r.startsAt.getTime(), end: r.endsAt.getTime() }));
  if (!createStaffCapacityCalendar(member?.capacity ?? 1, intervals(busy))(candidate)) {
    const bookings = busy.filter((r) => r.appointmentId !== null);
    if (!createStaffCapacityCalendar(member?.capacity ?? 1, intervals(bookings))(candidate))
      throw new DomainError(
        "slot_taken",
        "The professional has no remaining capacity at this time",
      );
    throw new DomainError(
      "slot_unavailable",
      "This time is temporarily reserved for a waitlist offer",
    );
  }
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
    datedWorkingHours: await loadDatedHours(
      tx,
      staffId,
      Temporal.Instant.fromEpochMilliseconds(startsAt.getTime())
        .toZonedDateTimeISO(settings.timezone)
        .toPlainDate()
        .toString(),
    ),
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

async function resolveClient(
  tx: Tx,
  request: CreateAppointmentRequest,
  createDistinctClient: boolean,
): Promise<string> {
  if (request.clientId) {
    const [existing] = await tx
      .select({ id: clientProfile.id, mergedIntoId: clientProfile.mergedIntoId })
      .from(clientProfile)
      .where(and(eq(clientProfile.id, request.clientId), isNull(clientProfile.deletedAt)));
    if (!existing) throw new DomainError("not_found", `Client ${request.clientId} not found`);
    requireClientRoot(existing);
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
  if (!createDistinctClient && candidates.length > 0) {
    const [match] = await tx
      .select({ id: clientProfile.id })
      .from(clientProfile)
      .leftJoin(user, eq(user.id, clientProfile.userId))
      .where(
        and(isNull(clientProfile.deletedAt), isNull(clientProfile.mergedIntoId), or(...candidates)),
      )
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
export async function getAppointmentOwnership(db: Database, id: string) {
  const [row] = await db
    .select({
      staffId: appointment.staffId,
      clientId: appointment.clientId,
      status: appointment.status,
      startsAt: appointment.startsAt,
      version: appointment.version,
      combinationStaffIds: appointment.combinationStaffIds,
    })
    .from(appointment)
    .where(and(eq(appointment.id, id), isNull(appointment.deletedAt)));
  if (!row) throw new DomainError("not_found", `Appointment ${id} not found`);
  return row;
}

export async function listAppointments(
  db: Database,
  query: AppointmentListQuery,
  scope: { clientId?: string; clientIds?: string[] } = {},
): Promise<ListAppointmentsResponse> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? APPOINTMENT_PAGE_SIZE_DEFAULT;
  const where = and(
    isNull(appointment.deletedAt),
    lt(appointment.startsAt, new Date(query.to)),
    gt(appointment.endsAt, new Date(query.from)),
    query.staffId ? eq(appointment.staffId, query.staffId) : undefined,
    query.status ? inArray(appointment.status, query.status) : undefined,
    scope.clientIds
      ? inArray(appointment.clientId, scope.clientIds)
      : scope.clientId
        ? eq(appointment.clientId, scope.clientId)
        : undefined,
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
  const prices = await loadBookingPrices(
    db,
    rows.map((row) => row.id),
  );
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
        ...(prices.has(row.id) ? { bookingPrice: prices.get(row.id) } : {}),
      })),
    ),
    page,
    pageSize,
    total: totals[0]?.total ?? 0,
  };
}

/** Every appointment of one client, newest first (the CRM history view). */
export async function listClientAppointments(
  db: Database | Tx,
  clientId: string,
): Promise<Appointment[]> {
  const identities = await clientIdentityIds(db, clientId);
  const rows = await db
    .select()
    .from(appointment)
    .where(and(inArray(appointment.clientId, identities), isNull(appointment.deletedAt)))
    .orderBy(desc(appointment.startsAt), desc(appointment.id));
  const prices = await loadBookingPrices(
    db,
    rows.map((row) => row.id),
  );
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
      ...(prices.has(row.id) ? { bookingPrice: prices.get(row.id) } : {}),
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
  db: Database | Tx,
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
  const serviceIds = snapshots.flatMap((s) => (s.serviceId ? [s.serviceId] : []));
  if (request.staffId && request.staffId !== current.staffId) {
    if (current.combinationStaffIds)
      await assertCombinationStaff(db, request.staffId, current.combinationStaffIds);
    else {
      await assertStaffExists(db, request.staffId);
      if (serviceIds.length > 0) await assertStaffPerforms(db, request.staffId, serviceIds);
    }
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
      if (slotChanges) {
        if (current.combinationStaffIds)
          await assertCombinationStaff(tx, staffId, current.combinationStaffIds);
        else await assertStaffPerforms(tx, staffId, serviceIds, true);
      }
      if (slotChanges) await assertClientCanBook(tx, current.clientId);
      if (slotChanges)
        await assertPromotionReschedule(tx, id, { startsAt, createdAt: current.createdAt });
      const noticeOverridden =
        settings !== undefined &&
        (await assertBookable(tx, {
          staffId,
          startsAt,
          endsAt,
          now,
          override: request.override === true,
          settings,
          workWindows: current.workWindows ?? undefined,
          excludeAppointmentId: current.id,
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
      if (updated && slotChanges) {
        await repackStaff(tx, updated.staffId, now, { appointmentId: id });
        await reassignAppointmentResources(tx, id, now);
      }
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
        if (updated.status === "completed") {
          await refreshAppointmentCheckout(tx, id, now);
          if (current.status !== "completed") await awardAppointmentStamp(tx, updated, now);
        } else if (current.status === "completed") {
          await reverseAppointmentStamp(tx, updated, now);
        }
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
    const bookingPrice = (await loadBookingPrices(db, [id])).get(id);
    return {
      ...toAppointment(row, snapshots, series),
      ...(protection ? { protection } : {}),
      ...(bookingPrice ? { bookingPrice } : {}),
    };
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
