import { z } from "zod";
import { collectBookingAbsences } from "./absence-evidence";
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
  type Interval = { startsAt: string; endsAt: string };
  const snapshotBookings = new Map<string, Map<string, Interval>>();
  for (const { sourceCopy, startsAt, endsAt } of model.appointments) {
    if (!sourceCopy) continue;
    const date = Temporal.Instant.from(startsAt)
      .toZonedDateTimeISO(timezone)
      .toPlainDate()
      .toString();
    if (date < fromInSnapshot || date > toInSnapshot) continue;
    const rows = snapshotBookings.get(date) ?? new Map<string, Interval>();
    rows.set(sourceCopy.itemRef, { startsAt, endsAt });
    snapshotBookings.set(date, rows);
  }
  const observedBookings = new Map<string, Map<string, Interval>>();
  // Use the same resource-scope and original-response checks as the booking report reconciliation.
  const evidence = collectBookingAbsences(
    model,
    model,
    [],
    [from, to],
    (calendar, updatedDates) => {
      const dates = new Set(
        updatedDates.filter((date) => date >= fromInSnapshot && date <= toInSnapshot),
      );
      if (!dates.size) return;
      for (const date of dates) observedBookings.set(date, new Map());
      for (const { id, booked_from, booked_till } of Object.values(calendar.bookings)) {
        if (!booked_from || !booked_till) throw new Error("Observed booking hours are missing");
        const rows = observedBookings.get(booked_from.slice(0, 10));
        if (!rows || !dates.has(booked_from.slice(0, 10))) continue;
        const ref = String(id);
        if (rows.has(ref))
          throw new Error("Calendar has more than one row for one booking reference");
        rows.set(ref, { startsAt: sourceInstant(booked_from), endsAt: sourceInstant(booked_till) });
      }
    },
  );
  function reconcile(date: string) {
    const observed = observedBookings.get(date);
    if (!observed) return undefined;
    const snapshot = snapshotBookings.get(date) ?? new Map<string, Interval>();
    const absent = [...snapshot.keys()].filter((ref) => !observed.has(ref)).sort();
    const unexpected = [...observed.keys()].filter((ref) => !snapshot.has(ref)).sort();
    const changedHours = [...observed]
      .flatMap(([ref, hours]) => {
        const saved = snapshot.get(ref);
        return saved &&
          (Temporal.Instant.compare(saved.startsAt, hours.startsAt) ||
            Temporal.Instant.compare(saved.endsAt, hours.endsAt))
          ? [ref]
          : [];
      })
      .sort();
    return { absent, unexpected, changedHours };
  }
  const cutoff = Temporal.Instant.from(atOrAfter);
  return {
    inspect: evidence.inspect,
    result() {
      const snapshotDays = evidence.coverage([fromInSnapshot, toInSnapshot]);
      const outsideObservedDays = evidence
        .observedCoverage()
        .filter(({ date }) => date < fromInSnapshot || date > toInSnapshot);
      const days = [...snapshotDays, ...outsideObservedDays]
        .map((day) => ({
          ...day,
          inSnapshot: day.date >= fromInSnapshot && day.date <= toInSnapshot,
          reconciliation: reconcile(day.date),
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
      const reviewed = days.flatMap(({ reconciliation }) =>
        reconciliation ? [reconciliation] : [],
      );
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
          daysCompared: reviewed.length,
          daysWithDifferences: reviewed.filter(
            ({ absent, unexpected, changedHours }) =>
              absent.length || unexpected.length || changedHours.length,
          ).length,
          absent: reviewed.reduce((total, day) => total + day.absent.length, 0),
          unexpected: reviewed.reduce((total, day) => total + day.unexpected.length, 0),
          changedHours: reviewed.reduce((total, day) => total + day.changedHours.length, 0),
        },
        canCutOver: false as const,
        days,
      };
    },
  };
}
