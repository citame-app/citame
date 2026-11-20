import {
  appointment,
  appointmentContext,
  appointmentService,
  clientProfile,
  type Database,
  service,
  serviceAddon,
  serviceStaff,
  staffProfile,
  timeOff,
  workingHours,
} from "@sob/db";
import { eq, sql } from "drizzle-orm";
import { packBooksyJson } from "./jsonb-codec";
import {
  booksyAddonLinks,
  fingerprint,
  planBooksyTransfer,
  sourceUuid,
  type TransferPlan,
  targetFingerprint,
} from "./plan";
import { verifyBooksyAddonLinks } from "./verify";

/** This module has no production mode, client messages, account invitations or Booksy writes. */
export async function applyBooksyRehearsal(db: Database, raw: unknown, reviewHash: string) {
  const plan = planBooksyTransfer(raw);
  if (!plan.review.canRehearse || plan.review.reviewHash !== reviewHash)
    throw new Error("Import is invalid or differs from the reviewed document");
  const identity = await db.execute<{ name: string }>(sql`select current_database() as name`);
  if (
    !/^sob_(?:test_booksy_transfer\w*|booksy_rehearsal_\d{8}(?:_run[1-9]\d*)?)$/.test(
      identity[0]?.name ?? "",
    )
  )
    throw new Error("Only an isolated Booksy rehearsal database is accepted");
  await db.execute(sql`create schema if not exists booksy_rehearsal`);
  await db.execute(
    sql`create table if not exists booksy_rehearsal.entity (business_id text not null,kind text not null,source_id text not null,target_id uuid not null,source_hash text not null,target_hash text not null,raw jsonb not null,primary key(business_id,kind,source_id),unique(kind,target_id))`,
  );
  await db.execute(
    sql`create table if not exists booksy_rehearsal.run (document_hash text primary key,business_id text not null,review jsonb not null,document jsonb not null,created_at timestamptz not null default now())`,
  );
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('booksy-rehearsal-import-v1',0))`,
    );
    const input = plan.input;
    const id = (kind: string, ref: string) => sourceUuid(input.businessId, kind, ref);
    const insert = async (
      kind: string,
      sourceId: string,
      source: unknown,
      projected: Record<string, unknown>,
      table:
        | typeof staffProfile
        | typeof service
        | typeof clientProfile
        | typeof appointment
        | typeof timeOff
        | typeof workingHours
        | typeof appointmentService
        | typeof appointmentContext
        | typeof serviceStaff,
    ) => {
      const targetId = id(kind, sourceId);
      const previous = await tx.execute<{
        source_hash: string;
        target_hash: string;
        target_id: string;
      }>(
        sql`select source_hash,target_hash,target_id from booksy_rehearsal.entity where business_id=${input.businessId} and kind=${kind} and source_id=${sourceId}`,
      );
      const rows = await tx.select().from(table).where(eq(table.id, targetId));
      if (previous[0]) {
        if (previous[0].source_hash !== fingerprint(source))
          throw new Error(
            `Source changed for ${kind}:${sourceId}; retain the old run and build a fresh rehearsal for the new snapshot`,
          );
        if (!rows[0] || targetFingerprint(kind, rows[0]) !== previous[0].target_hash)
          throw new Error(`Local target changed for ${kind}:${sourceId}; no data was overwritten`);
        return;
      }
      if (rows.length) throw new Error(`Unmapped target collision for ${kind}:${sourceId}`);
      // Values are built from a validated, typed projection in the branches below.
      const written = await tx
        .insert(table)
        .values({ ...projected, id: targetId } as typeof table.$inferInsert)
        .returning();
      if (!written[0]) throw new Error("Projection returned no row");
      await tx.execute(
        sql`insert into booksy_rehearsal.entity(business_id,kind,source_id,target_id,source_hash,target_hash,raw) values(${input.businessId},${kind},${sourceId},${targetId}::uuid,${fingerprint(source)},${targetFingerprint(kind, written[0])},${packBooksyJson(source)}::jsonb)`,
      );
    };
    for (const row of input.staff)
      await insert(
        "staff",
        row.sourceId,
        row,
        {
          displayName: row.name,
          active: row.active,
          maxConcurrent: row.maxConcurrent ?? 1,
          userId: null,
        },
        staffProfile,
      );
    for (const row of input.services)
      await insert(
        "services",
        row.sourceId,
        row,
        {
          name: row.name,
          catalogKind: row.catalogKind ?? "service",
          description: row.description,
          category: row.category,
          color: row.color,
          durationMinutes: row.durationMinutes,
          bufferMinutes: row.bufferMinutes,
          priceCents: row.priceCents,
          currency: row.currency,
          active: row.active,
        },
        service,
      );
    for (const row of input.clients)
      await insert(
        "clients",
        row.sourceId,
        row,
        {
          name: row.name,
          phone: row.phone,
          email: row.email,
          notes: row.notes,
          userId: null,
          ...(row.contactDetails ? { contactDetails: row.contactDetails } : {}),
          ...(row.tags ? { tags: row.tags } : {}),
          ...(row.bookingAccess
            ? {
                bookingAccess: row.bookingAccess,
                bookingAccessReason: row.bookingAccess === "blocked" ? "Importado de Booksy" : null,
              }
            : {}),
        },
        clientProfile,
      );
    for (const row of input.assignments)
      await insert(
        "assignments",
        JSON.stringify([row.staffRef, row.serviceRef]),
        row,
        { staffId: id("staff", row.staffRef), serviceId: id("services", row.serviceRef) },
        serviceStaff,
      );
    for (const row of input.hours)
      await insert(
        "hours",
        row.sourceId,
        row,
        {
          staffId: id("staff", row.staffRef),
          weekday: row.weekday,
          startTime: row.start,
          endTime: row.end,
        },
        workingHours,
      );
    for (const row of input.timeOff)
      await insert(
        "timeOff",
        row.sourceId,
        row,
        {
          staffId: id("staff", row.staffRef),
          startsAt: new Date(row.startsAt),
          endsAt: new Date(row.endsAt),
          reason: row.reason,
        },
        timeOff,
      );
    for (const row of input.appointments) {
      const visitId = id("appointments", row.sourceId);
      await insert(
        "appointments",
        row.sourceId,
        row,
        {
          staffId: id("staff", row.staffRef),
          clientId: id("clients", row.clientRef),
          startsAt: new Date(row.startsAt),
          endsAt: new Date(row.endsAt),
          status: row.status,
          notes: null,
          customerComment: row.customerComment,
        },
        appointment,
      );
      for (const [position, segment] of row.services.entries()) {
        await insert(
          "appointmentServices",
          segment.sourceId,
          segment,
          {
            appointmentId: visitId,
            serviceId: id("services", segment.serviceRef),
            position,
            name: segment.name,
            durationMinutes: segment.durationMinutes,
            bufferMinutes: segment.bufferMinutes,
            priceCents: segment.priceCents,
            currency: segment.currency,
          },
          appointmentService,
        );
        await insert(
          "contexts",
          segment.sourceId,
          { segment, parentInternalNote: row.internalNote },
          {
            appointmentId: visitId,
            servicePosition: position,
            requestedStaffId: segment.requestedStaffRef
              ? id("staff", segment.requestedStaffRef)
              : null,
            internalNote: segment.internalNote ?? row.internalNote,
            customerComment: segment.customerComment,
            invoiced: segment.invoiced,
            paid: segment.paid,
            source: "booksy",
            sourceRef: `${input.businessId}:${segment.sourceId}`,
          },
          appointmentContext,
        );
      }
    }
    const newRun = await tx.execute(
      sql`insert into booksy_rehearsal.run(document_hash,business_id,review,document) values(${reviewHash},${input.businessId},${plan.review}::jsonb,${packBooksyJson(input)}::jsonb) on conflict do nothing returning document_hash`,
    );
    const addonLinks = booksyAddonLinks(input);
    if (newRun.length && addonLinks.length) await tx.insert(serviceAddon).values(addonLinks);
    await verifyBooksyAddonLinks(tx, input);
    const reconciled = await reconcile(tx, input);
    if (reconciled.length) throw new Error(`Reconciliation failed: ${reconciled.join(", ")}`);
    return {
      ...plan.review,
      database: identity[0]!.name,
      applied: true,
      reconciled: true,
      canCutOver: false,
    };
  });
}
async function reconcile(db: Pick<Database, "execute">, input: TransferPlan["input"]) {
  const issues: string[] = [];
  const expected = {
    staff: input.staff.length,
    services: input.services.length,
    clients: input.clients.length,
    appointments: input.appointments.length,
    hours: input.hours.length,
    timeOff: input.timeOff.length,
    assignments: input.assignments.length,
    appointmentServices: input.appointments.reduce((sum, row) => sum + row.services.length, 0),
    contexts: input.appointments.reduce((sum, row) => sum + row.services.length, 0),
  };
  const rows = await db.execute<{ kind: string; count: number }>(
    sql`select kind,count(*)::int as count from booksy_rehearsal.entity where business_id=${input.businessId} group by kind`,
  );
  const counts = new Map(rows.map((r) => [r.kind, r.count]));
  for (const [kind, count] of Object.entries(expected))
    if ((counts.get(kind) ?? 0) !== count) issues.push(`${kind} count`);
  const services = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from appointment_service s join booksy_rehearsal.entity e on e.target_id=s.appointment_id and e.kind='appointments' where e.business_id=${input.businessId}`,
  );
  if (services[0]?.count !== input.appointments.reduce((s, v) => s + v.services.length, 0))
    issues.push("booked service count");
  return issues;
}
