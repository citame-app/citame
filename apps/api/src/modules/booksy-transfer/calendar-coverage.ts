import { z } from "zod";
import { collectBookingAbsences } from "./absence-evidence";
import type { BooksySourceReadModel } from "./source-read-model";

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
  // Use the same resource-scope and original-response checks as the booking report reconciliation.
  const evidence = collectBookingAbsences(model, model, [], [from, to]);
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
        canCutOver: false as const,
        days,
      };
    },
  };
}
