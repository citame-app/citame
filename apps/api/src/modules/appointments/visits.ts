import { createHash } from "node:crypto";
import {
  permissionsFor,
  type Visit,
  type VisitAvailability,
  type VisitCreate,
  type VisitSlots,
} from "@sob/contracts";
import { appointment, appointmentVisit, appointmentVisitPart, type Database } from "@sob/db";
import { asc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { authorizeAppointmentCreate } from "../../auth/policy";
import { loadPrincipal, ownsClient, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockCalendars, lockScheduling, type Tx } from "../../tx";
import { totalBlockMinutes } from "../availability/compute";
import { findAvailability } from "../availability/service";
import { protectionView } from "../booking-protection/value";
import { assertOnlineServices, getBookableServices } from "../services/service";
import { loadBookingPrices } from "./pricing";
import { createAppointment, loadSnapshots, toAppointment } from "./service";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
async function readVisit(db: Database | Tx, id: string, p: Principal): Promise<Visit> {
  const [visit] = await db.select().from(appointmentVisit).where(eq(appointmentVisit.id, id));
  if (!visit) throw new DomainError("not_found", "Visit not found");
  if (p.role === "client" && !ownsClient(p, visit.clientId))
    throw new DomainError("forbidden", "This visit belongs to another customer");
  const rows = await db
    .select({ booking: appointment })
    .from(appointmentVisitPart)
    .innerJoin(appointment, eq(appointment.id, appointmentVisitPart.appointmentId))
    .where(eq(appointmentVisitPart.visitId, id))
    .orderBy(asc(appointmentVisitPart.position));
  if (
    p.role === "staff" &&
    !permissionsFor(p.role, p.accessPreset).allCalendars &&
    rows.some(({ booking }) => booking.staffId !== p.staffId)
  )
    throw new DomainError("forbidden", "This visit includes another professional's calendar");
  const ids = rows.map(({ booking }) => booking.id);
  const snapshots = await loadSnapshots(db, ids);
  const prices = await loadBookingPrices(db, ids);
  const appointments = [];
  for (const { booking } of rows)
    appointments.push({
      ...toAppointment(booking, snapshots.get(booking.id) ?? []),
      protection: await protectionView(db, booking.id),
      ...(prices.has(booking.id) ? { bookingPrice: prices.get(booking.id) } : {}),
    });
  return { id, appointments };
}
export async function getVisit(db: Database, id: string, p: Principal) {
  return db.transaction(async (tx) => {
    await tx.execute(
      /* read a consistent group and its financial state */ sql`set transaction isolation level repeatable read read only`,
    );
    return readVisit(tx, id, p);
  });
}

export async function createVisit(
  db: Database,
  input: VisitCreate,
  principal: Principal,
  now: Date,
): Promise<Visit> {
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const p = await loadPrincipal(tx, principal.userId);
    if (!p) throw new DomainError("forbidden", "Account unavailable");
    if (p.role === "client" && input.clientId !== undefined)
      throw new DomainError("forbidden", "Customers book only for themselves");
    const clientId = p.role === "client" ? p.clientId : input.clientId;
    if (!clientId) throw new DomainError("validation_error", "Choose a customer");
    const requestHash = createHash("sha256")
      .update(JSON.stringify(canonical({ ...input, clientId })))
      .digest("hex");
    const [prior] = await tx
      .select()
      .from(appointmentVisit)
      .where(eq(appointmentVisit.id, input.id));
    if (prior) {
      if (prior.createdBy !== p.userId || prior.requestHash !== requestHash)
        throw new DomainError(
          "booking_intent_conflict",
          "This visit identifier already contains another reviewed request",
        );
      return readVisit(tx, input.id, p);
    }
    const all = await getBookableServices(
      tx,
      input.parts.flatMap((part) => part.serviceIds),
    );
    if (new Set(all.map((s) => s.currency)).size !== 1)
      throw new DomainError("validation_error", "A visit must use one currency");
    await lockCalendars(tx, [...new Set(input.parts.map((part) => part.staffId))].sort());
    await tx
      .insert(appointmentVisit)
      .values({ id: input.id, clientId, createdBy: p.userId, requestHash });
    let startsAt = input.startsAt;
    for (const [position, part] of input.parts.entries()) {
      const request = authorizeAppointmentCreate(p, {
        ...part,
        clientId,
        startsAt,
        ...(input.notes ? { notes: input.notes } : {}),
      });
      const created = await createAppointment(
        tx,
        request,
        { userId: p.userId, role: p.role },
        { now, sequentialContinuation: position > 0 },
      );
      await tx
        .insert(appointmentVisitPart)
        .values({ visitId: input.id, position, appointmentId: created.id });
      startsAt = created.endsAt;
    }
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "appointment.visit_create",
      entity: "appointment_visit",
      entityId: input.id,
      metadata: { count: input.parts.length },
    });
    return readVisit(tx, input.id, p);
  });
}

/** Sequential hand-offs can start off the first treatment's public booking grid. */
export async function findVisitAvailability(
  db: Database,
  input: VisitAvailability,
  now: Date,
): Promise<VisitSlots> {
  const ids = input.parts.flatMap((part) => part.serviceIds);
  await assertOnlineServices(db, ids);
  const all = await getBookableServices(db, ids);
  if (new Set(all.map((s) => s.currency)).size !== 1)
    throw new DomainError("validation_error", "A visit must use one currency");
  const choices = [];
  for (const [index, part] of input.parts.entries()) {
    const result = await findAvailability(
      db,
      { ...part, date: input.date },
      now,
      index ? { granularityMinutes: 1 } : {},
    );
    const byStart = new Map<string, typeof result.slots>();
    for (const slot of result.slots)
      byStart.set(slot.startsAt, [...(byStart.get(slot.startsAt) ?? []), slot]);
    choices.push({
      part,
      result,
      byStart,
      minutes: totalBlockMinutes(all.filter((s) => part.serviceIds.includes(s.id))),
    });
  }
  const slots: VisitSlots["slots"] = [];
  for (const first of choices[0]?.result.slots ?? []) {
    if (slots.some((s) => s.startsAt === first.startsAt)) continue;
    let nextStart = first.startsAt;
    const parts = [];
    for (const choice of choices) {
      const available = choice.byStart.get(nextStart)?.[0];
      if (!available) break;
      parts.push({
        staffId: available.staffId,
        startsAt: nextStart,
        serviceIds: choice.part.serviceIds,
      });
      nextStart = new Date(Date.parse(nextStart) + choice.minutes * 60000).toISOString();
    }
    if (parts.length === choices.length)
      slots.push({ startsAt: first.startsAt, endsAt: nextStart, parts });
  }
  return { slots };
}
