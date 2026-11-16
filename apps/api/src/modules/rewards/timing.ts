import type { PromotionTiming } from "@sob/contracts";
import { checkout, checkoutReward } from "@sob/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

/** Uses creation time, never checkout/payment time, to qualify a last-minute booking. */
export function appointmentMatchesPromotionTiming(
  timing: PromotionTiming,
  visit: { startsAt: Date; createdAt: Date } | null,
  timeZone: string,
): boolean {
  if (
    !visit ||
    !Number.isFinite(visit.startsAt.getTime()) ||
    !Number.isFinite(visit.createdAt.getTime())
  )
    return false;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(visit.startsAt);
    const part = (type: string) => parts.find((row) => row.type === type)?.value;
    const weekday =
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(part("weekday") ?? "") + 1;
    const minute = Number(part("hour")) * 60 + Number(part("minute"));
    const lead = visit.startsAt.getTime() - visit.createdAt.getTime();
    return (
      timing.weekdays.includes(weekday) &&
      minute >= timing.startMinute &&
      minute < timing.endMinute &&
      (timing.lastMinuteHours === null || (lead >= 0 && lead <= timing.lastMinuteHours * 3600000))
    );
  } catch {
    return false;
  }
}

/** Receipt locks precede scheduling/calendar locks in the appointment update path. */
export async function assertPromotionReschedule(
  tx: Tx,
  appointmentId: string,
  visit: { startsAt: Date; createdAt: Date },
) {
  const rows = await tx
    .select({ terms: checkoutReward.appointmentTiming })
    .from(checkoutReward)
    .innerJoin(checkout, eq(checkout.id, checkoutReward.checkoutId))
    .where(
      and(
        eq(checkout.appointmentId, appointmentId),
        ne(checkout.status, "void"),
        inArray(checkoutReward.state, ["held", "applied"]),
      ),
    );
  for (const { terms } of rows)
    if (terms && !appointmentMatchesPromotionTiming(terms.timing, visit, terms.timeZone))
      throw new DomainError(
        "promotion_timing_mismatch",
        "The proposed time does not meet this appointment's saved promotion conditions",
      );
}
