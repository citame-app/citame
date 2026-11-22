import { isDeepStrictEqual } from "node:util";
import { type SyncChange, syncPullResponseSchema } from "@sob/contracts";
import {
  appointment,
  appointmentContext,
  appointmentService,
  appointmentVisitPart,
  type Database,
  service,
} from "@sob/db";
import { asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Principal } from "../../auth/principal";
import { pullChanges } from "../sync/pull";

type AppointmentChange = Extract<SyncChange, { entity: "appointment"; op: "upsert" }>;

export const recoveredReplicaEvidenceSchema = z.object({
  calendarLines: z.number().int().nonnegative(),
  reannouncedCalendarLines: z.number().int().nonnegative(),
  serviceIndicatorsVerified: z.number().int().nonnegative(),
  serviceColorsVerified: z.number().int().nonnegative(),
  reannouncedServiceColors: z.number().int().nonnegative(),
  // Earlier rehearsal receipts did not measure these fields.
  groupedCalendarLinesVerified: z.number().int().nonnegative().optional(),
  frozenServicesVerified: z.number().int().nonnegative().optional(),
});

const reviewer: Principal = {
  userId: "booksy-restore-probe",
  role: "owner",
  name: "Restoration probe",
  email: "recovery@example.test",
  staffId: null,
  clientId: null,
};

async function readReplicaChanges(db: Database, since: number) {
  const visits = new Map<string, AppointmentChange["data"]>();
  const serviceColors = new Map<string, string>();
  for (;;) {
    const page = await pullChanges(db, reviewer, { since, limit: 200, booksyPaymentReview: "1" });
    const validated = syncPullResponseSchema.parse(page);
    for (const [index, change] of validated.changes.entries()) {
      if (change.entity === "service") {
        if (change.op === "upsert" && change.data.color)
          serviceColors.set(change.id, change.data.color);
        else serviceColors.delete(change.id);
        continue;
      }
      if (change.entity !== "appointment") continue;
      if (change.op === "delete") {
        visits.delete(change.id);
        continue;
      }
      const raw = page.changes[index];
      if (
        raw?.entity !== "appointment" ||
        raw.op !== "upsert" ||
        change.data.sourceCopy ||
        !isDeepStrictEqual(raw.data, change.data)
      )
        throw new Error("Recovered sync feed contains undocumented or private appointment fields");
      visits.set(change.id, change.data);
    }
    if (!validated.hasMore) return { visits, serviceColors };
    if (validated.nextCursor <= since) throw new Error("Recovered sync cursor did not advance");
    since = validated.nextCursor;
  }
}

/** Verify the actual sync feed without keeping another copy of client data on disk. */
export async function rehearseRecoveredReplica(
  db: Database,
  originalHead: number,
  { expectPaymentReannouncement }: { expectPaymentReannouncement: boolean },
) {
  const [expected, frozenServices, contexts, catalogue, replica, replay] = await Promise.all([
    db
      .select({
        id: appointment.id,
        staffId: appointment.staffId,
        clientId: appointment.clientId,
        visitGroupId: appointment.visitGroupId,
        itineraryId: appointmentVisitPart.visitId,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        status: appointment.status,
        notes: appointment.notes,
        version: appointment.version,
        workWindows: appointment.workWindows,
        customerComment: appointment.customerComment,
      })
      .from(appointment)
      .leftJoin(appointmentVisitPart, eq(appointmentVisitPart.appointmentId, appointment.id))
      .where(isNull(appointment.deletedAt)),
    db
      .select({ snapshot: appointmentService })
      .from(appointmentService)
      .innerJoin(appointment, eq(appointment.id, appointmentService.appointmentId))
      .where(isNull(appointment.deletedAt))
      .orderBy(asc(appointmentService.appointmentId), asc(appointmentService.position)),
    db
      .select({
        appointmentId: appointmentContext.appointmentId,
        position: appointmentContext.servicePosition,
        requestedStaffId: appointmentContext.requestedStaffId,
        invoiced: appointmentContext.invoiced,
        paid: appointmentContext.paid,
        sourcePaymentUnverified: appointmentContext.sourcePaymentUnverified,
        internalNote: sql<boolean>`coalesce(length(btrim(${appointmentContext.internalNote})) > 0, false)`,
        customerComment: sql<boolean>`coalesce(length(btrim(${appointmentContext.customerComment})) > 0, false)`,
      })
      .from(appointmentContext)
      .where(eq(appointmentContext.source, "booksy")),
    db
      .select({ id: service.id, color: service.color })
      .from(service)
      .where(isNull(service.deletedAt)),
    readReplicaChanges(db, 0),
    readReplicaChanges(db, originalHead),
  ]);
  if (expected.length !== replica.visits.size)
    throw new Error("Recovered sync calendar count differs");
  const expectedColors = new Map(
    catalogue.flatMap(({ id, color }) => (color ? [[id, color]] : [])),
  );
  if (
    expectedColors.size !== replica.serviceColors.size ||
    [...expectedColors].some(([id, color]) => replica.serviceColors.get(id) !== color) ||
    [...replay.serviceColors].some(([id, color]) => expectedColors.get(id) !== color)
  )
    throw new Error("Recovered sync catalogue colors differ");
  const servicesByAppointment = new Map<string, (typeof appointmentService.$inferSelect)[]>();
  for (const { snapshot } of frozenServices) {
    const snapshots = servicesByAppointment.get(snapshot.appointmentId) ?? [];
    if (snapshots.at(-1)?.position === snapshot.position)
      throw new Error("Recovered appointment has ambiguous frozen service order");
    snapshots.push(snapshot);
    servicesByAppointment.set(snapshot.appointmentId, snapshots);
  }
  const expectedById = new Map(expected.map((visit) => [visit.id, visit]));
  function verifyVisit(
    visit: (typeof expected)[number],
    row: AppointmentChange["data"] | undefined,
  ) {
    if (
      !row ||
      row.id !== visit.id ||
      row.staffId !== visit.staffId ||
      row.clientId !== visit.clientId ||
      (row.visitGroupId ?? null) !== visit.visitGroupId ||
      (row.itineraryId ?? null) !== visit.itineraryId ||
      Date.parse(row.startsAt) !== +visit.startsAt ||
      Date.parse(row.endsAt) !== +visit.endsAt ||
      row.status !== visit.status ||
      row.notes !== visit.notes ||
      row.version !== visit.version ||
      !isDeepStrictEqual(row.workWindows ?? null, visit.workWindows)
    )
      throw new Error("Recovered sync appointment differs");
    // Read the stored snapshots independently of the serialization used by sync.
    const snapshots = servicesByAppointment.get(visit.id) ?? [];
    if (
      row.services.length !== snapshots.length ||
      snapshots.some((snapshot, index) => {
        const booked = row.services[index];
        return (
          !booked ||
          booked.serviceId !== snapshot.serviceId ||
          booked.name !== snapshot.name ||
          booked.durationMinutes !== snapshot.durationMinutes ||
          booked.bufferMinutes !== snapshot.bufferMinutes ||
          (booked.processing?.startsAfterMinutes ?? null) !== snapshot.processingStartMinutes ||
          (booked.processing?.minutes ?? null) !== snapshot.processingMinutes ||
          booked.priceCents !== (snapshot.reviewedPriceCents ?? snapshot.priceCents) ||
          Boolean(booked.sourceUnpriced) !==
            (snapshot.sourceUnpriced && snapshot.reviewedPriceCents === null) ||
          (booked.priceType ?? "fixed") !== snapshot.priceType ||
          booked.currency !== snapshot.currency
        );
      })
    )
      throw new Error("Recovered sync frozen services differ");
  }
  let groupedCalendarLinesVerified = 0;
  for (const visit of expected) {
    verifyVisit(visit, replica.visits.get(visit.id));
    if (visit.visitGroupId || visit.itineraryId) groupedCalendarLinesVerified++;
    const replayed = replay.visits.get(visit.id);
    if (replayed) verifyVisit(visit, replayed);
  }
  let serviceIndicatorsVerified = 0;
  const undocumentedPayments = new Set<string>();
  const positivePaymentEvidence = new Set<string>();
  for (const context of contexts) {
    const visit = replica.visits.get(context.appointmentId);
    if (!visit?.importedFromBooksy) throw new Error("Imported origin is missing from sync");
    const badge = visit.serviceBadges?.find((entry) => entry.servicePosition === context.position);
    const requested = Boolean(context.requestedStaffId);
    const invoiced = Boolean(context.invoiced);
    const paid = Boolean(context.paid);
    if (context.paid === null || context.sourcePaymentUnverified)
      undocumentedPayments.add(context.appointmentId);
    if (paid || invoiced) positivePaymentEvidence.add(context.appointmentId);
    const customerComment =
      context.customerComment ||
      Boolean(expectedById.get(context.appointmentId)?.customerComment?.trim());
    if (!requested && !invoiced && !paid && !context.internalNote && !customerComment) continue;
    if (
      !badge ||
      badge.requested !== requested ||
      badge.invoiced !== invoiced ||
      badge.paid !== paid ||
      badge.billingSource !== (paid || invoiced ? "booksy" : null) ||
      badge.internalNote !== context.internalNote ||
      badge.customerComment !== customerComment
    )
      throw new Error("Recovered sync service indicator differs from the archived appointment");
    serviceIndicatorsVerified++;
  }
  for (const [id, row] of replica.visits) {
    const expectedReview = undocumentedPayments.has(id) && !positivePaymentEvidence.has(id);
    const reason = "unknown_booksy_payment";
    const replayed = replay.visits.get(id);
    if (
      Boolean(row.billingReviewReasons?.includes(reason)) !== expectedReview ||
      (expectedReview && expectPaymentReannouncement && !replayed) ||
      (replayed && Boolean(replayed.billingReviewReasons?.includes(reason)) !== expectedReview)
    )
      throw new Error("Recovered sync payment review differs from the archived appointment");
  }
  return {
    calendarLines: replica.visits.size,
    reannouncedCalendarLines: replay.visits.size,
    serviceIndicatorsVerified,
    serviceColorsVerified: replica.serviceColors.size,
    reannouncedServiceColors: replay.serviceColors.size,
    groupedCalendarLinesVerified,
    frozenServicesVerified: frozenServices.length,
  } satisfies z.infer<typeof recoveredReplicaEvidenceSchema>;
}
