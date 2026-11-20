import { z } from "zod";
import type { BooksySourceReadModel } from "./source-read-model";

const id = z.string().regex(/^\d+$/);
const row = z.object({
  id,
  date: z.string().regex(/^\d{2}\/\d{2}\/\d{2}(?:\d{2})? \d{2}:\d{2}$/),
  status: z.enum(["Confirmadas", "Canceladas"]),
});
const observedInterval = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d\s*-\s*(?:[01]\d|2[0-3]):[0-5]\d$/)
  .refine((value) => value.slice(0, 5) < value.slice(-5), "Expected a positive same-day interval");
export const bookingReportEvidence = z.object({
  version: z.literal(1),
  type: z.literal("booksy_visible_future_booking_report_comparison"),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  timezone: z.string(),
  window: z.tuple([z.iso.date(), z.iso.date()]),
  reportGeneratedAt: z.iso.datetime({ offset: true }),
  pagesInspected: z.object({
    first: z.number().int().positive(),
    last: z.number().int().positive(),
    total: z.number().int().positive(),
  }),
  followingMonthSelectable: z.boolean(),
  evidence: z.object({
    reportRows: z.array(row),
    calendar: z
      .object({
        date: z.iso.date(),
        capturedAt: z.iso.datetime({ offset: true }).optional(),
        filter: z.enum(["working", "all"]),
        observedItemRefs: z.array(id),
        confirmedExtra: row.extend({ interval: observedInterval }).optional(),
      })
      .optional(),
  }),
});

type Report = z.infer<typeof bookingReportEvidence>;

function localMinute(value: string) {
  const [date, minute] = value.split(" ");
  const [day, month, year] = date!.split("/");
  const isoYear = year!.length === 2 ? `20${year}` : year;
  return Temporal.PlainDateTime.from(`${isoYear}-${month}-${day}T${minute}`);
}

/** The observed report is evidence at minute precision. It does not change reservation state. */
export function reconcileBooksyBookingReport(model: BooksySourceReadModel, report: Report) {
  const [from, through] = report.window;
  const { first, last, total } = report.pagesInspected;
  const timezone = model.base.timezone;
  if (
    report.timezone !== timezone ||
    from < model.fromDate ||
    through > model.throughDate ||
    from > through ||
    first > last ||
    last > total
  ) {
    throw new Error("The report scope does not match the archived calendar");
  }
  const inWindow = (date: string) => date >= from && date <= through;
  const archived = new Map<string, { minute: string; date: string; status: string }>();
  for (const booking of model.appointments) {
    const ref = booking.sourceCopy?.itemRef;
    if (!ref || booking.sourceCopy?.businessId !== model.businessId || archived.has(ref))
      throw new Error("A captured appointment has no unique source identity");
    const local = Temporal.Instant.from(booking.startsAt)
      .toZonedDateTimeISO(timezone)
      .toPlainDateTime();
    archived.set(ref, {
      date: local.toPlainDate().toString(),
      minute: local.toString({ smallestUnit: "minute" }),
      status:
        booking.status === "booked"
          ? "Confirmadas"
          : booking.status === "cancelled"
            ? "Canceladas"
            : booking.status,
    });
  }

  const rows = new Map<
    string,
    Map<string, { minute: string; status: string; ambiguous: boolean }>
  >();
  let repeatedRows = 0;
  for (const observation of report.evidence.reportRows) {
    const local = localMinute(observation.date);
    if (!inWindow(local.toPlainDate().toString()))
      throw new Error("A report row falls outside its declared interval");
    const minute = local.toString({ smallestUnit: "minute" });
    const key = `${minute}:${observation.status}`;
    const variants = rows.get(observation.id) ?? new Map();
    if (variants.has(key)) repeatedRows++;
    else
      variants.set(key, {
        minute,
        status: observation.status,
        ambiguous: !local
          .toZonedDateTime(timezone, { disambiguation: "earlier" })
          .equals(local.toZonedDateTime(timezone, { disambiguation: "later" })),
      });
    rows.set(observation.id, variants);
  }

  const calendar = report.evidence.calendar;
  const observedCalendarRefs = new Set(calendar?.observedItemRefs);
  if (
    calendar &&
    (!inWindow(calendar.date) || observedCalendarRefs.size !== calendar.observedItemRefs.length)
  )
    throw new Error("Calendar cross-check has invalid scope or duplicate identities");
  const matching: string[] = [];
  const reportOnlyConfirmed: { ref: string; minute: string; corroboratedByCalendar: boolean }[] =
    [];
  const reportOnlyCancelled: { ref: string; minute: string }[] = [];
  const contradictoryRows: string[] = [];
  const ambiguousMinutes: string[] = [];
  const changed: { ref: string; fields: string[] }[] = [];
  for (const [ref, variants] of rows) {
    if (variants.size !== 1) {
      contradictoryRows.push(ref);
      continue;
    }
    const { minute, status, ambiguous } = variants.values().next().value!;
    if (ambiguous) {
      ambiguousMinutes.push(ref);
      continue;
    }
    const saved = archived.get(ref);
    if (saved) {
      const fields = [
        ...(saved.minute !== minute ? ["minute"] : []),
        ...(saved.status !== status ? ["status"] : []),
      ];
      if (fields.length) changed.push({ ref, fields });
      else matching.push(ref);
    } else if (status === "Confirmadas") {
      const extra = calendar?.confirmedExtra;
      reportOnlyConfirmed.push({
        ref,
        minute,
        corroboratedByCalendar:
          extra?.id === ref &&
          extra.status === status &&
          minute === localMinute(extra.date).toString({ smallestUnit: "minute" }) &&
          calendar?.date === minute.slice(0, 10) &&
          extra.interval.slice(0, 5) === minute.slice(11) &&
          observedCalendarRefs.has(ref),
      });
    } else reportOnlyCancelled.push({ ref, minute });
  }

  const archivedInWindow = [...archived].filter(([, booking]) => inWindow(booking.date));
  const archivedNotInInspectedRows = archivedInWindow
    .filter(([ref]) => !rows.has(ref))
    .map(([ref, saved]) => ({
      ref,
      date: saved.date,
      visibleInCalendarObservation: calendar?.date === saved.date && observedCalendarRefs.has(ref),
    }));
  return {
    window: report.window,
    reportGeneratedAt: report.reportGeneratedAt,
    pagesInspected: report.pagesInspected,
    allReportPagesInspected: first === 1 && last === total,
    calendarObservation: calendar
      ? { date: calendar.date, filter: calendar.filter, capturedAt: calendar.capturedAt ?? null }
      : null,
    followingMonthSelectable: report.followingMonthSelectable,
    rows: report.evidence.reportRows.length,
    distinctReferences: rows.size,
    repeatedRows,
    archivedInWindow: archivedInWindow.length,
    matching,
    reportOnlyConfirmed,
    reportOnlyCancelled,
    contradictoryRows,
    ambiguousMinutes,
    changed,
    archivedNotInInspectedRows,
    lastAppointmentProven: false as const,
    canCutOver: false as const,
  };
}
