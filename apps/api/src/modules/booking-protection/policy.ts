import type { BookingPolicy, ReviewedBookingPolicy } from "@sob/contracts";
import { bookingPolicy, type Database, service } from "@sob/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requireRole } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

export const DEFAULT_BOOKING_POLICY: BookingPolicy = {
  enabled: false,
  depositKind: "percent",
  depositValue: 2500,
  holdMinutes: 15,
  cancellationWindowMinutes: 1440,
  lateCancellationBasisPoints: 0,
  noShowBasisPoints: 0,
  trustedExempt: true,
  version: 1,
};
export async function getBookingPolicy(db: Database | Tx): Promise<BookingPolicy> {
  const [row] = await db.select().from(bookingPolicy).where(eq(bookingPolicy.id, 1));
  return row ? { ...row.terms, version: row.version } : { ...DEFAULT_BOOKING_POLICY };
}

export async function publishBookingPolicy(
  db: Database,
  reviewed: ReviewedBookingPolicy,
  principal: Principal,
  generation: string,
): Promise<ReviewedBookingPolicy> {
  requireRole(principal, "owner");
  if (reviewed.generation !== generation) {
    throw new DomainError("sync_generation_changed", "Review booking protection after the restore");
  }
  return { generation, policy: await setBookingPolicy(db, reviewed.policy, principal) };
}
async function setBookingPolicy(db: Database, input: BookingPolicy, principal: Principal) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('booking-policy', 0))`);
    const current = await getBookingPolicy(tx);
    if (current.version !== input.version)
      throw new DomainError("version_conflict", "Booking policy changed; review it again");
    if (input.enabled) {
      const wrongCurrency = await tx
        .select({ id: service.id })
        .from(service)
        .where(
          and(eq(service.active, true), isNull(service.deletedAt), ne(service.currency, "EUR")),
        )
        .limit(1);
      if (wrongCurrency.length)
        throw new DomainError(
          "invalid_state",
          "All active services must use EUR before enabling deposits",
        );
    }
    const { version: _, ...terms } = input;
    await tx
      .insert(bookingPolicy)
      .values({ id: 1, terms, version: current.version + 1 })
      .onConflictDoUpdate({
        target: bookingPolicy.id,
        set: { terms, version: current.version + 1, updatedAt: new Date() },
      });
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "booking.policy_updated",
      entity: "booking_policy",
      entityId: "1",
      metadata: { version: current.version + 1, enabled: input.enabled },
    });
    return { ...terms, version: current.version + 1 };
  });
}
