import { z } from "zod";
import { coversBooksyCalendarRequest } from "./calendar-request-scope";
import { fingerprint } from "./plan";
import type { BooksySourceReadModel } from "./source-read-model";

const calendar = z.object({
  start_date: z.iso.date(),
  end_date: z.iso.date(),
  resources_count: z.number().int().nonnegative(),
  resources: z.array(z.object({ id: z.number().int() })),
  bookings: z.record(z.string(), z.object({ id: z.number().int() })),
});
const detail = z.object({
  appointment: z.object({ appointment_uid: z.number().int(), status: z.string().optional() }),
});
const retainedResponse = z.object({
  capturedAt: z.iso.datetime({ offset: true }),
  data: z.object({ body: z.string(), data: z.unknown() }),
});

type Evidence = { at: string; sha256: string };
type CoverageWindow = readonly [string, string];

function* datesIn([from, to]: CoverageWindow) {
  for (
    let day = Temporal.PlainDate.from(from);
    Temporal.PlainDate.compare(day, to) <= 0;
    day = day.add({ days: 1 })
  )
    yield day.toString();
}
type Line = {
  itemRef: string;
  groupRef: string;
  date: string;
  presence?: Evidence;
  absence?: Evidence;
  groupDetail?: Evidence & { status?: string };
};

function isNewer(candidate: Evidence, previous: Evidence | null | undefined) {
  if (!previous) return true;
  const order = Temporal.Instant.compare(candidate.at, previous.at);
  return order > 0 || (order === 0 && candidate.sha256 < previous.sha256);
}

/** Attach dated evidence to missing lines without inferring a reservation state. */
export function collectBookingAbsences(
  previous: BooksySourceReadModel,
  current: BooksySourceReadModel,
  refs: string[],
  coverageWindow?: CoverageWindow,
) {
  const wanted = new Set(refs);
  const lines: Line[] = previous.appointments.flatMap((row) => {
    if (!row.sourceCopy || !wanted.has(row.sourceCopy.itemRef)) return [];
    return [
      {
        itemRef: row.sourceCopy.itemRef,
        groupRef: row.sourceCopy.groupRef,
        date: Temporal.Instant.from(row.startsAt)
          .toZonedDateTimeISO(previous.base.timezone)
          .toPlainDate()
          .toString(),
      },
    ];
  });
  const expectedResources = new Set([
    ...current.base.staff.map((row) => row.sourceId),
    ...current.resources.map((row) => String(row.id)),
  ]);
  const prefix = `/core/v2/business_api/me/businesses/${current.businessId}/`;
  const seen = new Set<string>();
  const calendarDays = new Map<string, Evidence>();
  return {
    inspect(document: unknown, sha256: string) {
      if (
        (!lines.length && !coverageWindow) ||
        seen.has(sha256) ||
        !document ||
        typeof document !== "object" ||
        !("kind" in document) ||
        document.kind !== "booksy-api-response" ||
        !("businessId" in document) ||
        document.businessId !== current.businessId ||
        !("source" in document) ||
        typeof document.source !== "string"
      )
        return;
      seen.add(sha256);
      const source = new URL(document.source);
      if (source.origin !== "https://es.booksy.com" || !source.pathname.startsWith(prefix)) return;
      const route = source.pathname.slice(prefix.length);
      const group = /^appointments\/(\d+)\/$/.exec(route)?.[1];
      const groupLines = group ? lines.filter((row) => row.groupRef === group) : [];
      if (route !== "calendar" && !groupLines.length) return;
      const capture = retainedResponse.parse(document);
      const payload: unknown = JSON.parse(capture.data.body);
      if (fingerprint(payload) !== fingerprint(capture.data.data))
        throw new Error("Retained calendar evidence differs from the original response");
      const evidence = { at: Temporal.Instant.from(capture.capturedAt).toString(), sha256 };
      if (route !== "calendar") {
        const row = detail.parse(payload).appointment;
        if (String(row.appointment_uid) !== group)
          throw new Error("Reservation evidence identity differs");
        for (const line of groupLines) {
          if (isNewer(evidence, line.groupDetail))
            line.groupDetail = { ...evidence, status: row.status };
        }
        return;
      }
      const observed = calendar.parse(payload);
      if (observed.start_date > observed.end_date)
        throw new Error("Retained calendar evidence has a reversed interval");
      const resources = new Set(observed.resources.map((row) => String(row.id)));
      const fullScope =
        coversBooksyCalendarRequest(source, observed) &&
        observed.resources_count === observed.resources.length &&
        resources.size === observed.resources.length &&
        expectedResources.size > 0 &&
        resources.size === expectedResources.size &&
        [...expectedResources].every((id) => resources.has(id));
      if (fullScope && coverageWindow) {
        const [from, to] = coverageWindow;
        for (const date of datesIn([
          observed.start_date > from ? observed.start_date : from,
          observed.end_date < to ? observed.end_date : to,
        ])) {
          if (isNewer(evidence, calendarDays.get(date))) calendarDays.set(date, evidence);
        }
      }
      const present = new Set(Object.values(observed.bookings).map((row) => String(row.id)));
      for (const line of lines) {
        if (present.has(line.itemRef)) {
          if (isNewer(evidence, line.presence)) line.presence = evidence;
        } else if (
          fullScope &&
          line.date >= observed.start_date &&
          line.date <= observed.end_date &&
          isNewer(evidence, line.absence)
        ) {
          line.absence = evidence;
        }
      }
    },
    result: () => lines.sort((a, b) => a.itemRef.localeCompare(b.itemRef)),
    coverage: (window = coverageWindow) =>
      window
        ? [...datesIn(window)].map((date) => ({
            date,
            lastFullObservation: calendarDays.get(date) ?? null,
          }))
        : [],
    observedCoverage: () =>
      [...calendarDays].map(([date, lastFullObservation]) => ({ date, lastFullObservation })),
  };
}
