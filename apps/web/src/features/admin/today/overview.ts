import type { CalendarAppointment } from "@sob/contracts";

export interface Overview {
  /** Everything that is not cancelled, in time order. */
  timeline: CalendarAppointment[];
  nextUp: CalendarAppointment | null;
  /** Booked appointments that already started: somebody has to mark the outcome. */
  pending: CalendarAppointment[];
  stats: {
    total: number;
    remaining: number;
    completed: number;
    noShow: number;
    expectedRevenueCents: number;
  };
}

const price = (a: CalendarAppointment) => a.services.reduce((sum, s) => sum + s.priceCents, 0);

/** Derives the "today" screen from one calendar response for the salon-local day. */
export function buildOverview(
  appointments: CalendarAppointment[],
  now: Date,
  _timeZone: string,
): Overview {
  const timeline = appointments
    .filter((a) => a.status !== "cancelled")
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const started = (a: CalendarAppointment) => Date.parse(a.startsAt) <= now.getTime();
  const pending = timeline.filter((a) => a.status === "booked" && started(a));
  const upcoming = timeline.filter((a) => a.status === "booked" && !started(a));
  return {
    timeline,
    nextUp: upcoming[0] ?? null,
    pending,
    stats: {
      total: timeline.length,
      remaining: upcoming.length,
      completed: timeline.filter((a) => a.status === "completed").length,
      noShow: timeline.filter((a) => a.status === "no_show").length,
      expectedRevenueCents: timeline.reduce((sum, a) => sum + price(a), 0),
    },
  };
}
