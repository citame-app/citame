import { z } from "zod";
import { collectBookingAbsences } from "./absence-evidence";
import { type CalendarSeen, latestByReference, sourceCalendarDate } from "./calendar-intervals";
import { stableJson } from "./plan";
import { type BooksySourceReadModel, sourceInstant } from "./source-read-model";

export const calendarAuditInput = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  atOrAfter: z.iso.datetime({ offset: true }),
});

/** A full-scope observation can prove calendar visibility, but not the last possible booking. */
export function auditCalendarCoverage(
  model: BooksySourceReadModel,
  input: z.infer<typeof calendarAuditInput>,
) {
  const { from, to, atOrAfter } = calendarAuditInput.parse(input);
  if (from > to) throw new Error("Calendar audit window is reversed");
  const timezone = z.literal("Europe/Madrid").parse(model.base.timezone);
  const daysRequested = Temporal.PlainDate.from(from).until(to).days + 1;
  const fromInSnapshot = from > model.fromDate ? from : model.fromDate;
  const toInSnapshot = to < model.throughDate ? to : model.throughDate;
  type Interval = { date: string; startsAt: string; endsAt: string };
  type RawBooking = { id: number; booked_from?: string; booked_till?: string };
  const snapshot = new Map<string, Interval>();
  for (const { sourceCopy, startsAt, endsAt } of model.appointments) {
    if (!sourceCopy) continue;
    const ref = sourceCopy.itemRef;
    if (snapshot.has(ref)) throw new Error("Snapshot has duplicate booking references");
    snapshot.set(ref, { date: sourceCalendarDate(startsAt, timezone), startsAt, endsAt });
  }

  const latest = new Map<string, { at: string; captures: Record<string, RawBooking>[] }>();
  // Defer parsing until the newest full-scope captures are known for every day.
  const evidence = collectBookingAbsences(
    model,
    model,
    [],
    [from, to],
    (calendar, date, { at }) => {
      if (date < fromInSnapshot || date > toInSnapshot) return;
      const current = latest.get(date);
      if (current?.at === at) current.captures.push(calendar.bookings);
      else latest.set(date, { at, captures: [calendar.bookings] });
    },
  );
  const localTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;
  function readBookings(date: string, bookings: Record<string, RawBooking>) {
    const rows = new Map<string, Interval>();
    for (const { id, booked_from, booked_till } of Object.values(bookings)) {
      if (
        !booked_from ||
        !localTime.test(booked_from) ||
        !calendarAuditInput.shape.from.safeParse(booked_from.slice(0, 10)).success
      )
        throw new Error("Calendar has an invalid local booking start");
      if (booked_from.slice(0, 10) !== date) continue;
      if (!booked_till || !localTime.test(booked_till))
        throw new Error("Calendar has an invalid local booking end");

      const ref = String(id);
      const startsAt = sourceInstant(booked_from);
      const endsAt = sourceInstant(booked_till);
      if (rows.has(ref) || Temporal.Instant.compare(startsAt, endsAt) >= 0)
        throw new Error("Calendar has a duplicate booking reference or a nonpositive interval");
      rows.set(ref, { date, startsAt, endsAt });
    }
    return rows;
  }

  function reconcile() {
    const comparisons = new Map<
      string,
      { absent: string[]; unexpected: string[]; changedHours: string[] }
    >();
    const observations: CalendarSeen<Interval>[] = [];
    for (const [date, { at, captures }] of latest) {
      comparisons.set(date, { absent: [], unexpected: [], changedHours: [] });
      const [first, ...rest] = captures;
      if (!first) continue;
      const rows = readBookings(date, first);
      const signature = stableJson(Object.fromEntries(rows));
      for (const other of rest)
        if (signature !== stableJson(Object.fromEntries(readBookings(date, other))))
          throw new Error("Simultaneous full calendars have different bookings for the same day");
      for (const [ref, row] of rows)
        observations.push({ ref, row, at, start: row.startsAt, end: row.endsAt });
    }
    const observed = latestByReference(observations);
    for (const [ref, { date }] of snapshot)
      if (!observed.has(ref)) comparisons.get(date)?.absent.push(ref);
    for (const [ref, { row }] of observed) {
      const saved = snapshot.get(ref);
      const comparison = comparisons.get(row.date);
      if (!saved) comparison?.unexpected.push(ref);
      else if (
        Temporal.Instant.compare(saved.startsAt, row.startsAt) ||
        Temporal.Instant.compare(saved.endsAt, row.endsAt)
      )
        comparison?.changedHours.push(ref);
    }
    for (const { absent, unexpected, changedHours } of comparisons.values()) {
      absent.sort();
      unexpected.sort();
      changedHours.sort();
    }
    return comparisons;
  }
  const cutoff = Temporal.Instant.from(atOrAfter);
  return {
    inspect: evidence.inspect,
    result() {
      const comparisons = reconcile();
      const snapshotDays = evidence.coverage([fromInSnapshot, toInSnapshot]);
      const outsideObservedDays = evidence
        .observedCoverage()
        .filter(({ date }) => date < fromInSnapshot || date > toInSnapshot);
      const days = [...snapshotDays, ...outsideObservedDays]
        .map((day) => ({
          ...day,
          inSnapshot: day.date >= fromInSnapshot && day.date <= toInSnapshot,
          reconciliation: comparisons.get(day.date),
          state: !day.lastFullObservation
            ? ("missing" as const)
            : Temporal.Instant.compare(day.lastFullObservation.at, cutoff) >= 0
              ? ("current" as const)
              : ("stale" as const),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const currentDays = days.filter((day) => day.inSnapshot && day.state === "current").length;
      const staleDays = days.filter((day) => day.inSnapshot && day.state === "stale").length;
      const missingDays = snapshotDays.length - currentDays - staleDays;
      const countReconciliation = (state?: "current" | "stale") => {
        const reviewed = days.flatMap((day) =>
          day.reconciliation && (!state || day.state === state) ? [day.reconciliation] : [],
        );
        return {
          daysCompared: reviewed.length,
          daysWithDifferences: reviewed.filter(
            ({ absent, unexpected, changedHours }) =>
              absent.length || unexpected.length || changedHours.length,
          ).length,
          absent: reviewed.reduce((total, day) => total + day.absent.length, 0),
          unexpected: reviewed.reduce((total, day) => total + day.unexpected.length, 0),
          changedHours: reviewed.reduce((total, day) => total + day.changedHours.length, 0),
        };
      };
      return {
        from,
        to,
        atOrAfter: cutoff.toString(),
        timezone,
        snapshotWindow: { from: model.fromDate, to: model.throughDate },
        daysRequested,
        currentDays,
        staleDays,
        missingDays,
        outsideSnapshotDays: daysRequested - snapshotDays.length,
        outsideSnapshotObservedDays: outsideObservedDays.length,
        outsideSnapshotObservedAtOrAfterCutoff: days.filter(
          (day) => !day.inSnapshot && day.state === "current",
        ).length,
        lastObservedAppointmentAt: model.lastObservedAppointmentAt,
        lastAppointmentProven: model.lastAppointmentProven,
        bookingReconciliation: {
          ...countReconciliation(),
          current: countReconciliation("current"),
          stale: countReconciliation("stale"),
        },
        canCutOver: false as const,
        days,
      };
    },
  };
}
