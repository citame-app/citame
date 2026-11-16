import {
  clientProfile,
  type Database,
  pgErrorCode,
  salonSettings,
  service,
  staffProfile,
  waitlistEntry,
  waitlistOffer,
} from "@sob/db";
import { and, asc, count, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { DomainError } from "../../errors";
import { lockCalendars, lockScheduling, type Tx } from "../../tx";
import { assertBookable } from "../appointments/service";
import { findAvailability } from "../availability/service";
import { repackStaff } from "../availability/staff-reservations";
import { serviceWorkWindows } from "../availability/work-windows";
import { getBookingPolicy } from "../booking-protection/policy";
import { assertClientCanBook } from "../clients/controls";
import { reserveResources } from "../resources/reservations";
import { getBookableServices, type ServiceRow } from "../services/service";
import { getSalonSettings } from "../settings/service";
import { staffQualifiedFor } from "../staff/service";
import { type EntryRow, getWaitlistPolicy, localToday, selectionHash } from "./service";

export function offerServices(services: ServiceRow[]) {
  return services.map((s) => ({
    id: s.id,
    name: s.name,
    durationMinutes: s.durationMinutes,
    bufferMinutes: s.bufferMinutes,
    ...(s.processing ? { processing: s.processing } : {}),
    priceCents: s.priceCents,
    currency: s.currency,
  }));
}
async function finishEntry(tx: Tx, entry: EntryRow, state: "expired" | "unavailable", now: Date) {
  await tx
    .update(waitlistEntry)
    .set({ state, version: entry.version + 1, lastScannedAt: now })
    .where(eq(waitlistEntry.id, entry.id));
  await recordAudit(tx, {
    actorUserId: null,
    action: `waitlist.${state}`,
    entity: "waitlist_entry",
    entityId: entry.id,
    metadata: {},
  });
}
export async function expireWaitlistOffers(db: Database, now: Date, limit = 100) {
  // Use normalized selections, not the JSON driver encoding, to find changed option rules.
  const invalidOptions = sql`exists (
    select 1 from unnest(${waitlistEntry.serviceIds}) with ordinality requested(id,pos)
    join service s on s.id=requested.id
    left join service parent on parent.id=s.parent_service_id
    left join lateral (
      select b.id,b.parent_service_id,b.currency from unnest(${waitlistEntry.serviceIds}) with ordinality prior(id,pos)
      join service b on b.id=prior.id where prior.pos<requested.pos and b.catalog_kind<>'addon'
      order by prior.pos desc limit 1
    ) base on true
    where (s.catalog_kind='variant' and (parent.id is null or parent.active=false or parent.deleted_at is not null))
      or (s.catalog_kind='addon' and (base.id is null or base.currency<>s.currency or not exists (
        select 1 from service_addon a where a.addon_id=s.id and (a.service_id=base.id or a.service_id=base.parent_service_id)
      )))
  )`;
  const candidates = await db
    .select({ offer: waitlistOffer })
    .from(waitlistOffer)
    .innerJoin(waitlistEntry, eq(waitlistEntry.id, waitlistOffer.entryId))
    .innerJoin(clientProfile, eq(clientProfile.id, waitlistEntry.clientId))
    .innerJoin(staffProfile, eq(staffProfile.id, waitlistOffer.staffId))
    .where(
      and(
        eq(waitlistOffer.state, "offered"),
        or(
          lte(waitlistOffer.expiresAt, now),
          invalidOptions,
          sql`${clientProfile.deletedAt} is not null`,
          sql`${clientProfile.mergedIntoId} is not null`,
          eq(clientProfile.bookingAccess, "blocked"),
          eq(staffProfile.active, false),
          sql`${staffProfile.deletedAt} is not null`,
          sql`exists (select 1 from unnest(${waitlistEntry.serviceIds}) requested(id) left join service s on s.id=requested.id where s.id is null or s.active=false or s.deleted_at is not null)`,
          sql`exists (select 1 from unnest(${waitlistEntry.serviceIds}) requested(id) where not exists (select 1 from service_staff ss where ss.service_id=requested.id and ss.staff_id=${waitlistOffer.staffId} and ss.deleted_at is null))`,
        ),
      ),
    )
    .orderBy(asc(waitlistOffer.expiresAt), asc(waitlistOffer.id))
    .limit(limit);
  let expired = 0;
  let withdrawn = 0;
  for (const { offer: candidate } of candidates) {
    const result = await db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(waitlistEntry)
        .where(eq(waitlistEntry.id, candidate.entryId))
        .for("update");
      if (!entry) return null;
      await lockScheduling(tx);
      await lockCalendars(tx, [candidate.staffId]);
      const [offer] = await tx
        .select()
        .from(waitlistOffer)
        .where(eq(waitlistOffer.id, candidate.id))
        .for("update");
      if (offer?.state !== "offered") return null;
      const [client] = await tx
        .select()
        .from(clientProfile)
        .where(eq(clientProfile.id, entry.clientId))
        .for("share");
      const [performer] = await tx
        .select()
        .from(staffProfile)
        .where(eq(staffProfile.id, offer.staffId));
      let validSelection = true;
      try {
        await getBookableServices(tx, entry.serviceIds);
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          !["not_found", "validation_error"].includes(error.code)
        )
          throw error;
        validSelection = false;
      }
      const qualified = await staffQualifiedFor(tx, entry.serviceIds);
      const unavailable =
        !client ||
        Boolean(client.deletedAt) ||
        Boolean(client.mergedIntoId) ||
        client.bookingAccess === "blocked" ||
        !performer?.active ||
        Boolean(performer.deletedAt) ||
        !validSelection ||
        !qualified.includes(offer.staffId);
      if (!unavailable && offer.expiresAt > now) return null;
      await tx
        .update(waitlistOffer)
        .set({ state: unavailable ? "cancelled" : "expired" })
        .where(eq(waitlistOffer.id, offer.id));
      if (entry.state === "offered")
        await tx
          .update(waitlistEntry)
          .set({
            state: unavailable
              ? "unavailable"
              : entry.toDate < localToday(now, entry.timezone)
                ? "expired"
                : "waiting",
            version: entry.version + 1,
            notBefore: new Date(now.getTime() + 15 * 60000),
            lastScannedAt: now,
          })
          .where(eq(waitlistEntry.id, entry.id));
      await recordAudit(tx, {
        actorUserId: null,
        action: unavailable ? "waitlist.offer_withdrawn" : "waitlist.offer_expired",
        entity: "waitlist_entry",
        entityId: entry.id,
        metadata: { offerId: offer.id },
      });
      return unavailable ? "withdrawn" : "expired";
    });
    if (result === "withdrawn") withdrawn++;
    else if (result === "expired") expired++;
  }
  return { expired, withdrawn };
}
async function matchEntry(db: Database, id: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(waitlistEntry)
      .where(
        and(
          eq(waitlistEntry.id, id),
          eq(waitlistEntry.state, "waiting"),
          lte(waitlistEntry.notBefore, now),
        ),
      )
      .for("update", { skipLocked: true });
    if (!entry) return false;
    await lockScheduling(tx);
    await tx.select().from(salonSettings).for("share");
    const settings = await getSalonSettings(tx);
    const today = localToday(now, settings.timezone);
    if (entry.toDate < today) {
      await finishEntry(tx, entry, "expired", now);
      return false;
    }
    const [client] = await tx
      .select()
      .from(clientProfile)
      .where(eq(clientProfile.id, entry.clientId));
    if (
      !client ||
      client.deletedAt ||
      client.mergedIntoId ||
      client.bookingAccess === "blocked" ||
      entry.timezone !== settings.timezone
    ) {
      await finishEntry(tx, entry, "unavailable", now);
      return false;
    }
    await tx.update(waitlistEntry).set({ lastScannedAt: now }).where(eq(waitlistEntry.id, id));
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('waitlist-policy',0))`);
    const policy = await getWaitlistPolicy(tx);
    if (!policy.enabled) return false;
    await tx
      .select()
      .from(service)
      .where(inArray(service.id, entry.serviceIds))
      .orderBy(asc(service.id))
      .for("share");
    let services: ServiceRow[];
    try {
      services = await getBookableServices(tx, entry.serviceIds);
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        !["not_found", "validation_error"].includes(error.code)
      )
        throw error;
      await finishEntry(tx, entry, "unavailable", now);
      return false;
    }
    const qualified = await staffQualifiedFor(tx, entry.serviceIds);
    if (
      !qualified.length ||
      (entry.staffId && !qualified.includes(entry.staffId)) ||
      new Set(services.map((s) => s.currency)).size !== 1
    ) {
      await finishEntry(tx, entry, "unavailable", now);
      return false;
    }
    const [existing] = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from waitlist_offer o join waitlist_entry e on e.id=o.entry_id where e.client_id=${entry.clientId} and o.state='offered' and o.expires_at>${now}`,
    );
    if ((existing?.n ?? 0) > 0) return false;
    const dayStart = new Date(
      Temporal.PlainDate.from(today).toZonedDateTime(settings.timezone).epochMilliseconds,
    );
    const [daily] = await tx
      .select({ n: count() })
      .from(waitlistOffer)
      .innerJoin(waitlistEntry, eq(waitlistEntry.id, waitlistOffer.entryId))
      .where(
        and(eq(waitlistEntry.clientId, entry.clientId), gte(waitlistOffer.createdAt, dayStart)),
      );
    if ((daily?.n ?? 0) >= 3) return false;
    const from = Temporal.PlainDate.compare(entry.fromDate, today) > 0 ? entry.fromDate : today;
    for (
      let date = Temporal.PlainDate.from(from);
      date.toString() <= entry.toDate;
      date = date.add({ days: 1 })
    ) {
      const found = await findAvailability(
        db,
        {
          date: date.toString(),
          serviceIds: entry.serviceIds,
          ...(entry.staffId ? { staffId: entry.staffId } : {}),
        },
        now,
      );
      for (const slot of found.slots) {
        const start = Temporal.Instant.from(slot.startsAt).toZonedDateTimeISO(settings.timezone);
        const end = Temporal.Instant.from(slot.endsAt).toZonedDateTimeISO(settings.timezone);
        const wall = (x: Temporal.ZonedDateTime) =>
          `${String(x.hour).padStart(2, "0")}:${String(x.minute).padStart(2, "0")}`;
        const expiresAt = new Date(
          Math.min(
            now.getTime() + policy.offerMinutes * 60000,
            Date.parse(slot.startsAt) - settings.minNoticeMinutes * 60000,
          ),
        );
        if (
          start.toPlainDate().toString() !== end.toPlainDate().toString() ||
          wall(start) < entry.fromTime ||
          wall(end) > entry.toTime ||
          expiresAt.getTime() < now.getTime() + 60000
        )
          continue;
        const [calendar] = await tx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${slot.staffId},0)) as locked`,
        );
        if (!calendar?.locked) continue;
        try {
          await assertBookable(tx, {
            staffId: slot.staffId,
            startsAt: new Date(slot.startsAt),
            endsAt: new Date(slot.endsAt),
            now,
            override: false,
            settings,
            workWindows: serviceWorkWindows(await getBookableServices(tx, entry.serviceIds)),
          });
        } catch (error) {
          if (
            error instanceof DomainError &&
            ["slot_unavailable", "slot_taken", "not_found"].includes(error.code)
          )
            continue;
          throw error;
        }
        // All accepted offers for this customer serialize with normal booking access controls.
        await assertClientCanBook(tx, entry.clientId);
        const [otherHold] = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from waitlist_offer o join waitlist_entry e on e.id=o.entry_id where e.client_id=${entry.clientId} and o.state='offered' and o.expires_at>${now}`,
        );
        if ((otherHold?.n ?? 0) > 0) return false;
        const [latestDaily] = await tx
          .select({ n: count() })
          .from(waitlistOffer)
          .innerJoin(waitlistEntry, eq(waitlistEntry.id, waitlistOffer.entryId))
          .where(
            and(eq(waitlistEntry.clientId, entry.clientId), gte(waitlistOffer.createdAt, dayStart)),
          );
        if ((latestDaily?.n ?? 0) >= 3) return false;
        const snapshots = offerServices(await getBookableServices(tx, entry.serviceIds));
        const bookingPolicy = await getBookingPolicy(tx);
        const priceCents = snapshots.reduce((n, s) => n + s.priceCents, 0);
        if (priceCents > 999999999) {
          await finishEntry(tx, entry, "unavailable", now);
          return false;
        }
        const [offer] = await tx
          .insert(waitlistOffer)
          .values({
            entryId: id,
            staffId: slot.staffId,
            startsAt: new Date(slot.startsAt),
            endsAt: new Date(slot.endsAt),
            expiresAt,
            services: snapshots,
            ...(snapshots.some((s) => s.processing)
              ? { workWindows: sql`${JSON.stringify(serviceWorkWindows(snapshots))}::jsonb` }
              : {}),
            policy: bookingPolicy,
            catalogHash: selectionHash({ services: snapshots, policy: bookingPolicy }),
            priceCents,
            currency: snapshots[0]?.currency ?? "EUR",
            createdAt: now,
          })
          .returning();
        if (!offer) throw new Error("Waitlist offer insert returned no row");
        await repackStaff(tx, offer.staffId, now, { offerId: offer.id });
        await reserveResources(
          tx,
          { offerId: offer.id, startsAt: offer.startsAt, endsAt: offer.endsAt },
          snapshots,
          now,
        );
        await tx
          .update(waitlistEntry)
          .set({ state: "offered", version: entry.version + 1 })
          .where(eq(waitlistEntry.id, id));
        await recordAudit(tx, {
          actorUserId: null,
          action: "waitlist.offered",
          entity: "waitlist_entry",
          entityId: id,
          metadata: {
            offerId: offer.id,
            staffId: slot.staffId,
            startsAt: slot.startsAt,
            expiresAt: expiresAt.toISOString(),
          },
        });
        return true;
      }
    }
    return false;
  });
}
/** Bounded round-robin batches; expiry continues while new offers are paused. */
export async function runWaitlist(db: Database, options: { now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const limit = Math.min(20, Math.max(1, Math.trunc(options.limit ?? 20)));
  const released = await expireWaitlistOffers(db, now);
  const rows = await db
    .select({ id: waitlistEntry.id })
    .from(waitlistEntry)
    .where(and(eq(waitlistEntry.state, "waiting"), lte(waitlistEntry.notBefore, now)))
    .orderBy(
      sql`${waitlistEntry.lastScannedAt} asc nulls first`,
      asc(waitlistEntry.createdAt),
      asc(waitlistEntry.id),
    )
    .limit(limit);
  let offersCreated = 0;
  for (const row of rows) {
    try {
      if (await matchEntry(db, row.id, now)) offersCreated++;
    } catch (error) {
      if (pgErrorCode(error) === "23P01") continue;
      throw error;
    }
  }
  return {
    offersExpired: released.expired,
    offersWithdrawn: released.withdrawn,
    offersCreated,
    entriesScanned: rows.length,
  };
}
