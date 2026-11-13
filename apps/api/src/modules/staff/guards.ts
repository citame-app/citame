import { appointment, type Database } from "@sob/db";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { DomainError } from "../../errors";

/**
 * Refuses an operation that would take a calendar out of service while bookings are still
 * ahead of us (anything not cancelled that has not finished yet). Nothing is changed by the
 * caller in that case: the owner has to reassign or cancel those appointments first.
 */
export async function assertNoFutureAppointments(
  db: Pick<Database, "select">,
  staffId: string,
  now: Date,
): Promise<void> {
  const [row] = await db
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        eq(appointment.staffId, staffId),
        ne(appointment.status, "cancelled"),
        isNull(appointment.deletedAt),
        gt(appointment.endsAt, now),
      ),
    )
    .limit(1);
  if (row) {
    throw new DomainError(
      "has_future_appointments",
      "This staff member has upcoming appointments; reassign or cancel them first",
    );
  }
}
