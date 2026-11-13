import type { Service, Slot, Staff } from "@sob/contracts";
import { addDaysLocal, hourOf } from "~/lib/format";

export interface BookingTotals {
  durationMinutes: number;
  priceCents: number;
  /** Null while nothing is selected. A salon sells in one currency, so the first one wins. */
  currency: string | null;
  count: number;
}

export function bookingTotals(catalog: Service[], selectedIds: string[]): BookingTotals {
  const selected = selectedIds
    .map((id) => catalog.find((service) => service.id === id))
    .filter((service): service is Service => service !== undefined);
  return {
    durationMinutes: selected.reduce((sum, s) => sum + s.durationMinutes, 0),
    priceCents: selected.reduce((sum, s) => sum + s.priceCents, 0),
    currency: selected[0]?.currency ?? null,
    count: selected.length,
  };
}

export function eligibleStaff(staff: Staff[], serviceIds: string[]): Staff[] {
  return staff.filter((member) => serviceIds.every((id) => member.serviceIds.includes(id)));
}

export type PartOfDay = "morning" | "afternoon" | "evening";

export function partOfDay(instant: string, timeZone: string): PartOfDay {
  const hour = hourOf(instant, timeZone);
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

export interface SlotGroup {
  part: PartOfDay;
  slots: Slot[];
}

const PART_ORDER: PartOfDay[] = ["morning", "afternoon", "evening"];

/**
 * Groups slots by part of the salon-local day. When several professionals can take the same
 * start time ("any available"), the start appears once, assigned to the first listed professional.
 */
export function groupSlots(slots: Slot[], timeZone: string): SlotGroup[] {
  const byStart = new Map<string, Slot>();
  for (const slot of slots) {
    const existing = byStart.get(slot.startsAt);
    if (!existing || slot.staffId < existing.staffId) byStart.set(slot.startsAt, slot);
  }
  const ordered = [...byStart.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return PART_ORDER.map((part) => ({
    part,
    slots: ordered.filter((slot) => partOfDay(slot.startsAt, timeZone) === part),
  })).filter((group) => group.slots.length > 0);
}

/** Consecutive salon-local dates starting at `today`, never past the booking horizon. */
export function buildDateStrip(today: string, count: number, maxDaysAhead: number): string[] {
  const length = Math.min(count, maxDaysAhead + 1);
  return Array.from({ length }, (_, index) => addDaysLocal(today, index));
}

/** Earliest date with at least one slot; days whose availability is still unknown are skipped. */
export function firstAvailableDate(
  dates: string[],
  slotCounts: Record<string, number | undefined>,
): string | undefined {
  return dates.find((date) => (slotCounts[date] ?? 0) > 0);
}

function offsetMinutes(timeZone: string, at: Date): number {
  const label =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(label);
  if (!match || !match[1]) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

export interface TimezoneDifference {
  visitorTimeZone: string;
  /** Visitor clock minus salon clock, in minutes (positive: visitor is ahead of the salon). */
  offsetMinutes: number;
}

/** Null when the visitor's clock matches the salon's at `at`, regardless of the zone alias. */
export function timezoneDifference(
  visitorTimeZone: string,
  salonTimeZone: string,
  at: Date,
): TimezoneDifference | null {
  const diff = offsetMinutes(visitorTimeZone, at) - offsetMinutes(salonTimeZone, at);
  return diff === 0 ? null : { visitorTimeZone, offsetMinutes: diff };
}
