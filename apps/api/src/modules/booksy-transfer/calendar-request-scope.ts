// A retained calendar can confirm that a row was seen. Only an explicit,
// unfiltered request for the returned dates can support absence or replacement.
const calendarParameters = new Set([
  "start_date",
  "end_date",
  "include_unconfirmed",
  "resources_per_page",
  "version",
]);

export function coversBooksyCalendarRequest(
  source: URL,
  interval: { start_date: string; end_date: string },
): boolean {
  const query = source.searchParams;
  const distinct = new Set(query.keys());
  if (distinct.size !== query.size || [...distinct].some((key) => !calendarParameters.has(key)))
    return false;
  return (
    query.get("include_unconfirmed") === "true" &&
    query.get("start_date") === interval.start_date &&
    query.get("end_date") === interval.end_date
  );
}
