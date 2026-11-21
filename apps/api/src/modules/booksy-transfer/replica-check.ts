import { type SyncChange, syncPullResponseSchema } from "@sob/contracts";
import { appointment, appointmentContext, type Database, service } from "@sob/db";
import { eq, isNull, sql } from "drizzle-orm";
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
    const page = await pullChanges(db, reviewer, { since, limit: 200 });
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
        Object.keys(raw.data).length !== Object.keys(change.data).length ||
        raw.data.serviceBadges?.some((badge, position) => {
          const projected = change.data.serviceBadges?.[position];
          return !projected || Object.keys(badge).length !== Object.keys(projected).length;
        })
      )
        throw new Error("Recovered sync feed contains undocumented appointment fields");
      visits.set(change.id, change.data);
    }
    if (!validated.hasMore) return { visits, serviceColors };
    if (validated.nextCursor <= since) throw new Error("Recovered sync cursor did not advance");
    since = validated.nextCursor;
  }
}

/** Verify the actual sync feed without keeping another copy of client data on disk. */
export async function rehearseRecoveredReplica(db: Database, originalHead: number) {
  const [expected, contexts, catalogue, replica, replay] = await Promise.all([
    db
      .select({
        id: appointment.id,
        staffId: appointment.staffId,
        clientId: appointment.clientId,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        version: appointment.version,
        customerComment: appointment.customerComment,
      })
      .from(appointment)
      .where(isNull(appointment.deletedAt)),
    db
      .select({
        appointmentId: appointmentContext.appointmentId,
        position: appointmentContext.servicePosition,
        requestedStaffId: appointmentContext.requestedStaffId,
        invoiced: appointmentContext.invoiced,
        paid: appointmentContext.paid,
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
  const expectedById = new Map(expected.map((visit) => [visit.id, visit]));
  for (const visit of expected) {
    const row = replica.visits.get(visit.id);
    if (
      !row ||
      row.staffId !== visit.staffId ||
      row.clientId !== visit.clientId ||
      Date.parse(row.startsAt) !== +visit.startsAt ||
      Date.parse(row.endsAt) !== +visit.endsAt ||
      row.version !== visit.version
    )
      throw new Error("Recovered sync appointment differs");
  }
  let serviceIndicatorsVerified = 0;
  for (const context of contexts) {
    const visit = replica.visits.get(context.appointmentId);
    if (!visit?.importedFromBooksy) throw new Error("Imported origin is missing from sync");
    const badge = visit.serviceBadges?.find((entry) => entry.servicePosition === context.position);
    const requested = Boolean(context.requestedStaffId);
    const invoiced = Boolean(context.invoiced);
    const paid = Boolean(context.paid);
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
  return {
    calendarLines: replica.visits.size,
    reannouncedCalendarLines: replay.visits.size,
    serviceIndicatorsVerified,
    serviceColorsVerified: replica.serviceColors.size,
    reannouncedServiceColors: replay.serviceColors.size,
  } satisfies z.infer<typeof recoveredReplicaEvidenceSchema>;
}
