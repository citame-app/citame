import { createHash } from "node:crypto";
import {
  type AppointmentSeries,
  type AppointmentSeriesCreate,
  type AppointmentSeriesInput,
  type AppointmentSeriesPreview,
  appointmentSeriesInputSchema,
} from "@sob/contracts";
import {
  appointment,
  appointmentSeries,
  appointmentSeriesVisit,
  type Database,
  salonSettings,
  service,
  serviceStaff,
} from "@sob/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { authorizeAppointmentList } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockCalendars, lockScheduling, type Tx } from "../../tx";
import { totalBlockMinutes } from "../availability/compute";
import { serviceWorkWindows } from "../availability/work-windows";
import { getBookingPolicy } from "../booking-protection/policy";
import { protectionView } from "../booking-protection/value";
import { applicableIntakeForms } from "../clients/intake";
import { assertPeakReviews, pricePeakSlot, readPeakPricePolicy } from "../peak-prices/service";
import { filterResourceAvailability } from "../resources/reservations";
import { getBookableServices } from "../services/service";
import { assertOnlineBookingEnabled, getSalonSettings } from "../settings/service";
import { staffQualifiedFor } from "../staff/service";
import { seriesStartsAt } from "./series-dates";
import { assertBookable, createAppointment, loadSnapshots, toAppointment } from "./service";

function hash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    v instanceof Date
      ? v.toISOString()
      : Array.isArray(v)
        ? v.map(canonical)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, x]) => [k, canonical(x)]),
            )
          : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
async function previewInTransaction(
  tx: Tx,
  input: AppointmentSeriesInput,
  role: Principal["role"],
  now: Date,
): Promise<AppointmentSeriesPreview> {
  const settings = await getSalonSettings(tx);
  assertOnlineBookingEnabled(settings, role);
  const services = await getBookableServices(tx, input.serviceIds, input.serviceQuotes);
  if (!(await staffQualifiedFor(tx, input.serviceIds)).includes(input.staffId))
    throw new DomainError(
      "validation_error",
      "The staff member does not perform every selected service",
    );
  const policy = await getBookingPolicy(tx);
  if (new Set(services.map((s) => s.currency)).size !== 1)
    throw new DomainError(
      "validation_error",
      "Every service in a series must use the same currency",
    );
  const starts = seriesStartsAt(input, settings.timezone);
  const peakPolicy = await readPeakPricePolicy(tx, "initial");
  const blockMs = totalBlockMinutes(services) * 60000;
  const workWindows = serviceWorkWindows(services);
  const occurrences: AppointmentSeriesPreview["occurrences"] = [];
  for (const value of starts) {
    const startsAt = new Date(value);
    const endsAt = new Date(startsAt.getTime() + blockMs);
    let available = true;
    try {
      await assertBookable(tx, {
        staffId: input.staffId,
        startsAt,
        endsAt,
        now,
        override: input.override === true,
        settings,
        workWindows,
        preview: true,
      });
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        (error.code !== "slot_unavailable" && error.code !== "slot_taken")
      )
        throw error;
      available = false;
    }
    const peak = pricePeakSlot(peakPolicy, services, startsAt, settings.timezone);
    occurrences.push({
      startsAt: value,
      endsAt: endsAt.toISOString(),
      available,
      ...(peak.review
        ? {
            peakPriceReview: peak.review,
            priceCents: peak.services.reduce((sum, item) => sum + item.priceCents, 0),
            peakSurchargeCents: peak.services.reduce((sum, item) => sum + item.surchargeCents, 0),
          }
        : {}),
    });
  }
  const resourceSlots = await filterResourceAvailability(
    tx,
    services,
    occurrences
      .filter((o) => o.available)
      .map((o) => ({ startsAt: new Date(o.startsAt), endsAt: new Date(o.endsAt) })),
    now,
  );
  const resourceStarts = new Set(resourceSlots.map((s) => s.startsAt.toISOString()));
  for (const occurrence of occurrences)
    occurrence.available &&= resourceStarts.has(occurrence.startsAt);
  return {
    timezone: settings.timezone,
    reviewHash: hash({
      input,
      services,
      settings,
      policy,
      starts,
      ...(occurrences.some((slot) => slot.peakPriceReview)
        ? {
            peakReviews: occurrences.map((slot) => slot.peakPriceReview ?? null),
          }
        : {}),
      intake: (await applicableIntakeForms(tx, services)).map((form) => [
        form.id,
        form.contentHash,
      ]),
    }),
    policy,
    occurrences,
    perVisitCents: services.reduce((n, s) => n + s.priceCents, 0),
    currency: services[0]?.currency ?? "EUR",
  };
}
export function previewAppointmentSeries(
  db: Database,
  input: AppointmentSeriesInput,
  role: Principal["role"],
  now: Date,
) {
  return db.transaction((tx) => previewInTransaction(tx, input, role, now), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
async function seriesView(db: Database | Tx, id: string): Promise<AppointmentSeries> {
  const [series] = await db.select().from(appointmentSeries).where(eq(appointmentSeries.id, id));
  if (!series) throw new DomainError("not_found", "Appointment series not found");
  const visits = await db
    .select({ appointment, position: appointmentSeriesVisit.position })
    .from(appointmentSeriesVisit)
    .innerJoin(appointment, eq(appointment.id, appointmentSeriesVisit.appointmentId))
    .where(and(eq(appointmentSeriesVisit.seriesId, id), isNull(appointment.deletedAt)))
    .orderBy(asc(appointmentSeriesVisit.position));
  const snapshots = await loadSnapshots(
    db,
    visits.map((v) => v.appointment.id),
  );
  return {
    id,
    timezone: series.timezone,
    cadence: series.cadence,
    interval: series.interval,
    appointments: await Promise.all(
      visits.map(async ({ appointment: a, position }) => ({
        ...toAppointment(a, snapshots.get(a.id) ?? [], {
          id,
          position,
          count: series.occurrenceCount,
        }),
        protection: await protectionView(db, a.id),
      })),
    ),
  };
}
export async function getAppointmentSeries(db: Database, id: string, principal: Principal) {
  const [series] = await db.select().from(appointmentSeries).where(eq(appointmentSeries.id, id));
  if (!series) throw new DomainError("not_found", "Appointment series not found");
  const scope = authorizeAppointmentList(principal, {
    from: new Date(0).toISOString(),
    to: new Date().toISOString(),
  });
  if (scope.clientId && scope.clientId !== series.clientId)
    throw new DomainError("forbidden", "This is not your appointment series");
  // A moved visit may now belong to another calendar. Never expose it through the original series.
  const view = await seriesView(db, id);
  const visible = view.appointments.filter(
    (a) =>
      (!scope.query.staffId || a.staffId === scope.query.staffId) &&
      (!scope.clientId || a.clientId === scope.clientId),
  );
  if (!visible.length)
    throw new DomainError("forbidden", "This series has no visits on your calendar");
  return { ...view, appointments: visible };
}
export async function createAppointmentSeries(
  db: Database,
  request: AppointmentSeriesCreate,
  principal: Principal,
  now: Date,
  options: { appointmentIds?: readonly string[] } = {},
) {
  const { reviewHash, idempotencyKey, peakPriceReviews, ...fields } = request;
  const input = appointmentSeriesInputSchema.parse(fields);
  const { appointmentIds } = options;
  const requestHash = hash({
    input,
    reviewHash,
    peakPriceReviews,
    ...(appointmentIds ? { appointmentIds } : {}),
  });
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`appointment-series:${principal.userId}:${idempotencyKey}`},0))`,
    );
    const [prior] = await tx
      .select()
      .from(appointmentSeries)
      .where(
        and(
          eq(appointmentSeries.createdBy, principal.userId),
          eq(appointmentSeries.idempotencyKey, idempotencyKey),
        ),
      );
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new DomainError("invalid_state", "This series request key has already been used");
      return getAppointmentSeriesFromTransaction(tx, prior.id, principal);
    }
    await lockScheduling(tx);
    await lockCalendars(tx, [input.staffId]);
    // Freeze exactly the reviewed catalog/settings while each visit is materialized.
    await tx
      .select()
      .from(service)
      .where(inArray(service.id, input.serviceIds))
      .orderBy(asc(service.id))
      .for("share");
    await tx
      .select()
      .from(serviceStaff)
      .where(
        and(
          eq(serviceStaff.staffId, input.staffId),
          inArray(serviceStaff.serviceId, input.serviceIds),
        ),
      )
      .orderBy(asc(serviceStaff.id))
      .for("share");
    await tx.select().from(salonSettings).for("share");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('booking-policy',0))`);
    const preview = await previewInTransaction(tx, input, principal.role, now);
    if (preview.reviewHash !== reviewHash)
      throw new DomainError(
        "version_conflict",
        "The series terms changed; review the visits again",
      );
    assertPeakReviews(
      preview.occurrences.map((slot) => slot.peakPriceReview),
      peakPriceReviews,
    );
    if (preview.occurrences.some((o) => !o.available))
      throw new DomainError(
        "slot_taken",
        "At least one recurring visit is unavailable; no appointments were created",
      );
    const appointments = [];
    for (const [index, occurrence] of preview.occurrences.entries()) {
      const { cadence: _cadence, interval: _interval, count: _count, ...booking } = input;
      const next = await createAppointment(
        tx,
        {
          ...booking,
          id: appointmentIds?.[index],
          startsAt: occurrence.startsAt,
          peakPriceReview: occurrence.peakPriceReview,
        },
        { userId: principal.userId, role: principal.role },
        { now, desktopReviewed: Boolean(appointmentIds) },
      );
      appointments.push(next);
      // Resolve an inline client only once, even when it has no phone or email.
      input.clientId = next.clientId;
      delete input.client;
    }
    const first = appointments[0];
    if (!first) throw new Error("Missing series visit");
    const [saved] = await tx
      .insert(appointmentSeries)
      .values({
        clientId: first.clientId,
        staffId: input.staffId,
        timezone: preview.timezone,
        cadence: input.cadence,
        interval: input.interval,
        occurrenceCount: input.count,
        createdBy: principal.userId,
        idempotencyKey,
        requestHash,
      })
      .returning();
    if (!saved) throw new Error("Missing appointment series");
    await tx
      .insert(appointmentSeriesVisit)
      .values(
        appointments.map((a, position) => ({ seriesId: saved.id, appointmentId: a.id, position })),
      );
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "appointment.series_created",
      entity: "appointment_series",
      entityId: saved.id,
      metadata: {
        count: appointments.length,
        cadence: input.cadence,
        interval: input.interval,
        timezone: preview.timezone,
      },
    });
    return {
      id: saved.id,
      timezone: saved.timezone,
      cadence: saved.cadence,
      interval: saved.interval,
      appointments: appointments.map((a, position) => ({
        ...a,
        series: { id: saved.id, position, count: appointments.length },
      })),
    };
  });
}
async function getAppointmentSeriesFromTransaction(tx: Tx, id: string, principal: Principal) {
  const view = await seriesView(tx, id);
  const scope = authorizeAppointmentList(principal, {
    from: new Date(0).toISOString(),
    to: new Date().toISOString(),
  });
  return {
    ...view,
    appointments: view.appointments.filter(
      (a) =>
        (!scope.query.staffId || a.staffId === scope.query.staffId) &&
        (!scope.clientId || a.clientId === scope.clientId),
    ),
  };
}
