import { createHash } from "node:crypto";
import {
  permissionsFor,
  type WaitlistEntry,
  type WaitlistInput,
  type WaitlistPolicy,
  type WaitlistQuery,
  type WaitlistSourceEntry,
} from "@sob/contracts";
import {
  appointment,
  clientProfile,
  type Database,
  staffProfile,
  waitlistEntry,
  waitlistOffer,
  waitlistPolicy,
  waitlistSourceEntry,
} from "@sob/db";
import { and, count, desc, eq, gte, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission, requireRole } from "../../auth/policy";
import { ownedClientIds, ownsClient, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockCalendars, lockScheduling, type Tx } from "../../tx";
import { totalBlockMinutes } from "../availability/compute";
import { assertClientCanBook } from "../clients/controls";
import { assertOnlineServices, getBookableServices } from "../services/service";
import { assertOnlineBookingEnabled, getSalonSettings } from "../settings/service";
import { staffQualifiedFor } from "../staff/service";

type Connection = Database | Tx;
export type EntryRow = typeof waitlistEntry.$inferSelect;
export type OfferRow = typeof waitlistOffer.$inferSelect;
export const DEFAULT_WAITLIST_POLICY: WaitlistPolicy = {
  enabled: false,
  offerMinutes: 30,
  version: 1,
};
export const localToday = (now: Date, timezone: string) =>
  Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toString();
export function selectionHash(value: unknown) {
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
export async function getWaitlistPolicy(db: Connection): Promise<WaitlistPolicy> {
  const [row] = await db.select().from(waitlistPolicy).where(eq(waitlistPolicy.id, 1));
  return row ? { ...row.terms, version: row.version } : { ...DEFAULT_WAITLIST_POLICY };
}

function authorizeImportedWaitlist(principal: Principal) {
  requirePermission(principal, "clients");
  requirePermission(principal, "editCalendar");
  requirePermission(principal, "allCalendars");
}

export async function listImportedWaitlist(
  db: Database,
  principal: Principal,
  query: Pick<WaitlistQuery, "fromDate" | "toDate">,
): Promise<WaitlistSourceEntry[]> {
  if (!permissionsFor(principal.role, principal.accessPreset).allCalendars) return [];
  return db
    .select({
      id: waitlistSourceEntry.id,
      clientId: waitlistSourceEntry.clientId,
      clientName: clientProfile.name,
      requestedDate: waitlistSourceEntry.requestedDate,
      durationMinutes: waitlistSourceEntry.durationMinutes,
      flexible: waitlistSourceEntry.flexible,
    })
    .from(waitlistSourceEntry)
    .innerJoin(clientProfile, eq(waitlistSourceEntry.clientId, clientProfile.id))
    .where(
      and(
        isNull(waitlistSourceEntry.linkedEntryId),
        isNull(clientProfile.deletedAt),
        query.fromDate ? gte(waitlistSourceEntry.requestedDate, query.fromDate) : undefined,
        query.toDate ? lte(waitlistSourceEntry.requestedDate, query.toDate) : undefined,
      ),
    )
    .orderBy(
      waitlistSourceEntry.requestedDate,
      waitlistSourceEntry.sourceOrder,
      waitlistSourceEntry.id,
    )
    .limit(100);
}
export async function setWaitlistPolicy(db: Connection, input: WaitlistPolicy, p: Principal) {
  requireRole(p, "owner");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('waitlist-policy',0))`);
    const current = await getWaitlistPolicy(tx);
    if (current.version !== input.version)
      throw new DomainError(
        "version_conflict",
        "The waitlist policy changed; reload it before saving",
      );
    const { version: _, ...terms } = input;
    await tx
      .insert(waitlistPolicy)
      .values({ id: 1, terms, version: current.version + 1 })
      .onConflictDoUpdate({
        target: waitlistPolicy.id,
        set: { terms, version: current.version + 1, updatedAt: new Date() },
      });
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "waitlist.policy_updated",
      entity: "waitlist_policy",
      entityId: "1",
      metadata: { enabled: terms.enabled, version: current.version + 1 },
    });
    return { ...terms, version: current.version + 1 };
  });
}
export function waitlistScope(p: Principal): SQL | undefined {
  if (p.role === "client") {
    if (!p.clientId) throw new DomainError("forbidden", "Your account has no booking profile");
    return inArray(waitlistEntry.clientId, ownedClientIds(p));
  }
  requirePermission(p, "clients");
  requirePermission(p, "editCalendar");
  if (permissionsFor(p.role, p.accessPreset).allCalendars) return undefined;
  if (!p.staffId) throw new DomainError("forbidden", "Your account has no calendar");
  return or(
    eq(waitlistEntry.staffId, p.staffId),
    and(isNull(waitlistEntry.staffId), eq(waitlistEntry.state, "waiting")),
    sql`exists (select 1 from waitlist_offer o where o.entry_id=${waitlistEntry.id} and o.staff_id=${p.staffId} and o.state in ('offered','accepted'))`,
  );
}
export async function entryRow(db: Connection, id: string, p: Principal, lock = false) {
  const query = db
    .select()
    .from(waitlistEntry)
    .where(and(eq(waitlistEntry.id, id), waitlistScope(p)));
  const [entry] = await (lock ? query.for("update") : query);
  if (!entry)
    throw new DomainError("forbidden", "This waitlist entry is not available to your account");
  return entry;
}
export async function activeOffer(db: Connection, id: string) {
  const [offer] = await db
    .select()
    .from(waitlistOffer)
    .where(and(eq(waitlistOffer.entryId, id), eq(waitlistOffer.state, "offered")))
    .limit(1);
  return offer ?? null;
}
export async function entryView(
  db: Connection,
  entry: EntryRow,
  p: Principal,
): Promise<WaitlistEntry> {
  const offer = await activeOffer(db, entry.id);
  const [client] =
    p.role !== "client"
      ? await db
          .select({ name: clientProfile.name })
          .from(clientProfile)
          .where(eq(clientProfile.id, entry.clientId))
      : [];
  const visibleOffer =
    offer &&
    (p.role === "client" ||
      permissionsFor(p.role, p.accessPreset).allCalendars ||
      offer.staffId === p.staffId)
      ? offer
      : null;
  const [performer] = visibleOffer
    ? await db
        .select({ name: staffProfile.displayName })
        .from(staffProfile)
        .where(eq(staffProfile.id, visibleOffer.staffId))
    : [];
  const [booked] = entry.appointmentId
    ? await db
        .select()
        .from(appointment)
        .where(and(eq(appointment.id, entry.appointmentId), isNull(appointment.deletedAt)))
    : [];
  const visibleBooking =
    booked &&
    (p.role === "client"
      ? ownsClient(p, booked.clientId)
      : permissionsFor(p.role, p.accessPreset).allCalendars || booked.staffId === p.staffId)
      ? booked
      : null;
  const canManage =
    p.role === "client" ||
    permissionsFor(p.role, p.accessPreset).allCalendars ||
    Boolean(p.staffId && (entry.staffId === p.staffId || visibleOffer?.staffId === p.staffId));
  return {
    id: entry.id,
    clientId: entry.clientId,
    ...(client ? { clientName: client.name } : {}),
    serviceIds: entry.serviceIds,
    serviceNames: entry.serviceNames,
    staffId: entry.staffId,
    fromDate: entry.fromDate,
    toDate: entry.toDate,
    fromTime: entry.fromTime,
    toTime: entry.toTime,
    timezone: entry.timezone,
    state: entry.state,
    version: entry.version,
    createdAt: entry.createdAt.toISOString(),
    appointmentId: visibleBooking?.id ?? null,
    bookedAppointment: visibleBooking
      ? {
          id: visibleBooking.id,
          staffId: visibleBooking.staffId,
          startsAt: visibleBooking.startsAt.toISOString(),
          status: visibleBooking.status,
        }
      : null,
    canManage,
    offer: visibleOffer
      ? {
          id: visibleOffer.id,
          staffId: visibleOffer.staffId,
          ...(performer ? { staffName: performer.name } : {}),
          startsAt: visibleOffer.startsAt.toISOString(),
          endsAt: visibleOffer.endsAt.toISOString(),
          expiresAt: visibleOffer.expiresAt.toISOString(),
          priceCents: visibleOffer.priceCents,
          currency: visibleOffer.currency,
          services: visibleOffer.services,
          policy: visibleOffer.policy,
        }
      : null,
  };
}
export async function listWaitlist(db: Database, p: Principal, query: WaitlistQuery) {
  const page = query.page ?? 1,
    pageSize = query.pageSize ?? 10;
  const where = and(
    waitlistScope(p),
    query.state ? eq(waitlistEntry.state, query.state) : undefined,
    query.active === "true" ? inArray(waitlistEntry.state, ["waiting", "offered"]) : undefined,
    query.fromDate ? gte(waitlistEntry.toDate, query.fromDate) : undefined,
    query.toDate ? lte(waitlistEntry.fromDate, query.toDate) : undefined,
  );
  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select()
        .from(waitlistEntry)
        .where(where)
        .orderBy(desc(waitlistEntry.createdAt), desc(waitlistEntry.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [total] = await tx.select({ n: count() }).from(waitlistEntry).where(where);
      return {
        policy: await getWaitlistPolicy(tx),
        entries: await Promise.all(rows.map((e) => entryView(tx, e, p))),
        total: total?.n ?? 0,
        page,
        pageSize,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function joinWaitlist(
  db: Connection,
  input: WaitlistInput,
  p: Principal,
  now: Date,
  adminClientId?: string,
  importedEntryId?: string,
) {
  let staffId = input.staffId ?? null;
  if (p.role !== "client") {
    waitlistScope(p);
    if (!permissionsFor(p.role, p.accessPreset).allCalendars) {
      if (staffId && staffId !== p.staffId)
        throw new DomainError("forbidden", "You can only add entries for your own calendar");
      staffId = p.staffId;
    }
  }
  const clientId = p.role === "client" ? p.clientId : adminClientId;
  if (!clientId) throw new DomainError("validation_error", "Choose a customer for the waitlist");
  if (importedEntryId) authorizeImportedWaitlist(p);
  const requestHash = selectionHash({ input, clientId, staffId, importedEntryId });
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`waitlist-create:${p.userId}:${input.idempotencyKey}`},0))`,
    );
    const [prior] = await tx
      .select()
      .from(waitlistEntry)
      .where(
        and(
          eq(waitlistEntry.createdBy, p.userId),
          eq(waitlistEntry.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new DomainError("invalid_state", "This request key has already been used");
      return entryView(tx, prior, p);
    }
    let requestedDuration: number | undefined;
    if (importedEntryId) {
      const [source] = await tx
        .select()
        .from(waitlistSourceEntry)
        .where(eq(waitlistSourceEntry.id, importedEntryId))
        .for("update");
      if (!source || source.clientId !== clientId)
        throw new DomainError("not_found", "Imported waitlist request not found");
      if (source.linkedEntryId)
        throw new DomainError(
          "version_conflict",
          "The imported request is already in the waitlist",
        );
      if (source.requestedDate !== input.fromDate || source.requestedDate !== input.toDate)
        throw new DomainError("validation_error", "Use the date from the imported request");
      requestedDuration = source.durationMinutes;
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('waitlist-policy',0))`);
    const policy = await getWaitlistPolicy(tx);
    if (policy.enabled && importedEntryId)
      throw new DomainError(
        "invalid_state",
        "Pause automatic offers before importing a waitlist request",
      );
    if (importedEntryId && input.staffId === undefined)
      throw new DomainError("validation_error", "Confirm the imported request's staff preference");
    if (!policy.enabled && !importedEntryId)
      throw new DomainError("invalid_state", "The salon waitlist is currently paused");
    const settings = await getSalonSettings(tx, p.role === "client" ? "share" : undefined);
    assertOnlineBookingEnabled(settings, p.role);
    const today = localToday(now, settings.timezone);
    const last = Temporal.PlainDate.from(today).add({ days: settings.maxDaysAhead }).toString();
    if (input.fromDate < today || input.toDate > last)
      throw new DomainError(
        "validation_error",
        "The waitlist window must fit the salon booking horizon",
      );
    await assertOnlineServices(tx, input.serviceIds, p.userId);
    const services = await getBookableServices(tx, input.serviceIds);
    if (requestedDuration !== undefined && totalBlockMinutes(services) !== requestedDuration)
      throw new DomainError(
        "validation_error",
        "The selected services must match the imported slot duration",
      );
    const qualified = await staffQualifiedFor(tx, input.serviceIds);
    if (!qualified.length || (staffId && !qualified.includes(staffId)))
      throw new DomainError(
        "validation_error",
        "No active team member performs every selected service",
      );
    if (
      new Set(services.map((s) => s.currency)).size !== 1 ||
      services.reduce((n, s) => n + s.priceCents, 0) > 999999999
    )
      throw new DomainError(
        "validation_error",
        "Choose services with a supported total in one currency",
      );
    await assertClientCanBook(tx, clientId, true);
    const [active] = await tx
      .select({ n: count() })
      .from(waitlistEntry)
      .where(
        and(
          eq(waitlistEntry.clientId, clientId),
          inArray(waitlistEntry.state, ["waiting", "offered"]),
        ),
      );
    if ((active?.n ?? 0) >= 5)
      throw new DomainError(
        "invalid_state",
        "A customer can have at most five active waitlist requests",
      );
    const selection = selectionHash({
      serviceIds: input.serviceIds,
      staffId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      fromTime: input.fromTime,
      toTime: input.toTime,
    });
    const [duplicate] = await tx
      .select({ id: waitlistEntry.id })
      .from(waitlistEntry)
      .where(
        and(
          eq(waitlistEntry.clientId, clientId),
          eq(waitlistEntry.selectionHash, selection),
          inArray(waitlistEntry.state, ["waiting", "offered"]),
        ),
      );
    if (duplicate)
      throw new DomainError(
        "invalid_state",
        "This customer is already waiting for these services and times",
      );
    const [entry] = await tx
      .insert(waitlistEntry)
      .values({
        clientId,
        staffId,
        serviceIds: input.serviceIds,
        serviceNames: services.map((s) => s.name),
        fromDate: input.fromDate,
        toDate: input.toDate,
        fromTime: input.fromTime,
        toTime: input.toTime,
        timezone: settings.timezone,
        selectionHash: selection,
        requestHash,
        createdBy: p.userId,
        idempotencyKey: input.idempotencyKey,
        notBefore: now,
      })
      .returning();
    if (!entry) throw new Error("Waitlist insert returned no entry");
    if (importedEntryId)
      await tx
        .update(waitlistSourceEntry)
        .set({ linkedEntryId: entry.id })
        .where(eq(waitlistSourceEntry.id, importedEntryId));
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "waitlist.joined",
      entity: "waitlist_entry",
      entityId: entry.id,
      metadata: {
        clientId,
        staffId,
        serviceIds: entry.serviceIds,
        ...(importedEntryId ? { importedEntryId } : {}),
      },
    });
    return entryView(tx, entry, p);
  });
}
export function versionConflict() {
  return new DomainError(
    "version_conflict",
    "This waitlist entry changed; reload it before continuing",
  );
}
export async function endWaitlist(
  db: Database,
  id: string,
  input: { version: number; offerId?: string; requeue?: boolean },
  p: Principal,
  now: Date,
) {
  return db.transaction(async (tx) => {
    const entry = await entryRow(tx, id, p, true);
    await lockScheduling(tx);
    const offer = await activeOffer(tx, id);
    if (
      p.role !== "client" &&
      !permissionsFor(p.role, p.accessPreset).allCalendars &&
      entry.staffId !== p.staffId &&
      offer?.staffId !== p.staffId
    )
      throw new DomainError("forbidden", "This entry is not on your calendar");
    if (entry.version !== input.version) throw versionConflict();
    if (!["waiting", "offered"].includes(entry.state))
      throw new DomainError("invalid_state", "This waitlist request is already closed");
    if (input.offerId && offer?.id !== input.offerId) throw versionConflict();
    if (offer) {
      await lockCalendars(tx, [offer.staffId]);
      await tx
        .update(waitlistOffer)
        .set({ state: input.requeue ? "declined" : "cancelled" })
        .where(eq(waitlistOffer.id, offer.id));
    }
    const state = input.requeue
      ? entry.toDate < localToday(now, entry.timezone)
        ? "expired"
        : "waiting"
      : "cancelled";
    const [saved] = await tx
      .update(waitlistEntry)
      .set({
        state,
        version: entry.version + 1,
        notBefore: new Date(now.getTime() + (input.requeue ? 15 * 60000 : 0)),
      })
      .where(eq(waitlistEntry.id, id))
      .returning();
    if (!saved) throw new Error("Missing waitlist entry after closing");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: input.requeue ? "waitlist.offer_declined" : "waitlist.cancelled",
      entity: "waitlist_entry",
      entityId: id,
      metadata: { requeue: input.requeue === true },
    });
    return entryView(tx, saved, p);
  });
}
