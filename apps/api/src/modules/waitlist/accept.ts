import type { WaitlistAccept } from "@sob/contracts";
import {
  appointment,
  type Database,
  salonSettings,
  service,
  serviceStaff,
  waitlistEntry,
  waitlistOffer,
} from "@sob/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { authorizeAppointmentCreate, authorizeAppointmentList } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockCalendars, lockScheduling, type Tx } from "../../tx";
import { createAppointment, loadSnapshots, toAppointment } from "../appointments/service";
import { getBookingPolicy } from "../booking-protection/policy";
import { protectionView } from "../booking-protection/value";
import { getBookableServices } from "../services/service";
import { getSalonSettings } from "../settings/service";
import { offerServices } from "./matching";
import { entryRow, entryView, selectionHash, versionConflict } from "./service";

async function bookedView(tx: Tx, id: string, p: Principal) {
  const [row] = await tx
    .select()
    .from(appointment)
    .where(and(eq(appointment.id, id), isNull(appointment.deletedAt)));
  if (!row)
    throw new DomainError("not_found", "The original waitlist appointment is no longer available");
  const scope = authorizeAppointmentList(p, {
    from: new Date(0).toISOString(),
    to: new Date().toISOString(),
  });
  if (
    (scope.query.staffId && scope.query.staffId !== row.staffId) ||
    (scope.clientId && scope.clientId !== row.clientId)
  )
    throw new DomainError("forbidden", "This appointment is not available on your calendar");
  const snapshots = (await loadSnapshots(tx, [id])).get(id) ?? [];
  return { ...toAppointment(row, snapshots), protection: await protectionView(tx, id) };
}
export async function acceptWaitlist(
  db: Database,
  id: string,
  input: WaitlistAccept,
  p: Principal,
  now: Date,
) {
  if (p.role === "client" && input.protectionWaiverReason)
    throw new DomainError("forbidden", "Customers cannot waive deposits");
  const hash = selectionHash(input);
  return db.transaction(async (tx) => {
    const entry = await entryRow(tx, id, p, true);
    await lockScheduling(tx);
    const [offer] = await tx
      .select()
      .from(waitlistOffer)
      .where(and(eq(waitlistOffer.id, input.offerId), eq(waitlistOffer.entryId, id)))
      .for("update");
    if (!offer) throw versionConflict();
    const booking = authorizeAppointmentCreate(p, {
      staffId: offer.staffId,
      clientId: entry.clientId,
      serviceIds: entry.serviceIds,
      startsAt: offer.startsAt.toISOString(),
      ...(input.protectionAcceptedVersion
        ? { protectionAcceptedVersion: input.protectionAcceptedVersion }
        : {}),
      ...(input.protectionAcceptedTotalCents !== undefined
        ? { protectionAcceptedTotalCents: input.protectionAcceptedTotalCents }
        : {}),
      ...(input.protectionWaiverReason
        ? { protectionWaiverReason: input.protectionWaiverReason }
        : {}),
    });
    if (offer.state === "accepted") {
      if (
        offer.acceptedBy !== p.userId ||
        offer.acceptKey !== input.idempotencyKey ||
        offer.acceptHash !== hash ||
        !offer.appointmentId
      )
        throw new DomainError("invalid_state", "This offer has already been accepted");
      return {
        entry: await entryView(tx, entry, p),
        appointment: await bookedView(tx, offer.appointmentId, p),
      };
    }
    if (entry.version !== input.version || entry.state !== "offered" || offer.state !== "offered")
      throw versionConflict();
    if (offer.expiresAt <= now)
      throw new DomainError("invalid_state", "This waitlist offer has expired");
    await lockCalendars(tx, [offer.staffId]);
    await tx
      .select()
      .from(service)
      .where(inArray(service.id, entry.serviceIds))
      .orderBy(asc(service.id))
      .for("share");
    await tx
      .select()
      .from(serviceStaff)
      .where(
        and(
          eq(serviceStaff.staffId, offer.staffId),
          inArray(serviceStaff.serviceId, entry.serviceIds),
        ),
      )
      .orderBy(asc(serviceStaff.id))
      .for("share");
    await tx.select().from(salonSettings).for("share");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('booking-policy',0))`);
    const settings = await getSalonSettings(tx);
    const current = offerServices(await getBookableServices(tx, entry.serviceIds));
    const policy = await getBookingPolicy(tx);
    if (
      settings.timezone !== entry.timezone ||
      input.expectedTotalCents !== offer.priceCents ||
      selectionHash({ services: current, policy }) !== offer.catalogHash
    )
      throw new DomainError(
        "version_conflict",
        "These offer terms changed; decline the old offer and request another",
      );
    // Withdraw our own hold inside this transaction before normal booking rules are checked.
    await tx
      .update(waitlistOffer)
      .set({ state: "cancelled" })
      .where(eq(waitlistOffer.id, offer.id));
    const created = await createAppointment(tx, booking, { userId: p.userId }, { now });
    await tx
      .update(waitlistOffer)
      .set({
        state: "accepted",
        acceptedBy: p.userId,
        acceptKey: input.idempotencyKey,
        acceptHash: hash,
        appointmentId: created.id,
      })
      .where(eq(waitlistOffer.id, offer.id));
    const [saved] = await tx
      .update(waitlistEntry)
      .set({ state: "booked", version: entry.version + 1, appointmentId: created.id })
      .where(eq(waitlistEntry.id, id))
      .returning();
    if (!saved) throw new Error("Missing accepted waitlist entry");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "waitlist.offer_accepted",
      entity: "waitlist_entry",
      entityId: id,
      metadata: { offerId: offer.id, appointmentId: created.id },
    });
    return { entry: await entryView(tx, saved, p), appointment: created };
  });
}
