import { type Database, staffProfile, staffReservation, waitlistOffer } from "@sob/db";
import { and, asc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { repackResourceUnits } from "../resources/plan";

type Connection = Database | Tx;
/** Requires scheduling lock; does not lock waitlist queue entries. */
export async function releaseExpiredStaffOffers(tx: Tx, ids: string[], now: Date) {
  if (!ids.length) return;
  await tx
    .update(staffReservation)
    .set({ released: true })
    .where(
      and(
        inArray(staffReservation.staffId, ids),
        eq(staffReservation.active, true),
        sql`exists(select 1 from waitlist_offer o where o.id=${staffReservation.offerId} and o.expires_at<=${now})`,
      ),
    );
}
export async function staffOccupied(
  db: Connection,
  ids: string[],
  from: Date,
  to: Date,
  now: Date,
  excludeAppointmentId?: string,
) {
  if (!ids.length) return [];
  const rows = await db
    .select({ row: staffReservation })
    .from(staffReservation)
    .leftJoin(waitlistOffer, eq(waitlistOffer.id, staffReservation.offerId))
    .where(
      and(
        inArray(staffReservation.staffId, ids),
        eq(staffReservation.active, true),
        lt(staffReservation.startsAt, to),
        gt(staffReservation.endsAt, from),
        or(isNull(staffReservation.offerId), gt(waitlistOffer.expiresAt, now)),
        excludeAppointmentId
          ? or(
              isNull(staffReservation.appointmentId),
              ne(staffReservation.appointmentId, excludeAppointmentId),
            )
          : undefined,
      ),
    );
  return rows.map(({ row }) => row);
}
/** Unit numbers are bookkeeping, not physical seats; recolouring never moves a client or resource. */
export async function repackStaff(
  tx: Tx,
  staffId: string,
  now: Date,
  options: { capacity?: number; appointmentId?: string; offerId?: string } = {},
) {
  await releaseExpiredStaffOffers(tx, [staffId], now);
  const [staff] = await tx.select().from(staffProfile).where(eq(staffProfile.id, staffId));
  if (!staff) throw new DomainError("not_found", "Professional not found");
  const capacity = options.capacity ?? staff.maxConcurrent;
  let from = now;
  if (options.appointmentId || options.offerId) {
    const own = await tx
      .select()
      .from(staffReservation)
      .where(
        and(
          eq(staffReservation.staffId, staffId),
          options.appointmentId
            ? eq(staffReservation.appointmentId, options.appointmentId)
            : eq(staffReservation.offerId, options.offerId ?? ""),
        ),
      );
    for (const row of own) if (row.startsAt < from) from = row.startsAt;
  }
  const rows = await tx
    .select()
    .from(staffReservation)
    .where(
      and(
        eq(staffReservation.staffId, staffId),
        eq(staffReservation.active, true),
        gt(staffReservation.endsAt, from),
      ),
    )
    .orderBy(asc(staffReservation.startsAt), asc(staffReservation.id))
    .for("update");
  const plan = repackResourceUnits(
    capacity,
    rows.map((row) => ({ id: row.id, start: row.startsAt.getTime(), end: row.endsAt.getTime() })),
  );
  if (!plan)
    throw new DomainError(
      "slot_taken",
      "The professional has no capacity for the active work intervals",
    );
  const changed = plan.filter(
    (item) => rows.find((row) => row.id === item.id)?.unitIndex !== item.unitIndex,
  );
  if (!changed.length) return;
  const clauses = sql.join(
    changed.map((item) => sql`when ${item.id}::uuid then ${item.unitIndex}::int`),
    sql` `,
  );
  await tx
    .update(staffReservation)
    .set({
      unitIndex: sql`case ${staffReservation.id} ${clauses} else ${staffReservation.unitIndex} end`,
    })
    .where(
      inArray(
        staffReservation.id,
        changed.map((item) => item.id),
      ),
    );
}
