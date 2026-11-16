import type { Appointment } from "@sob/contracts";
import { appointmentSeries, appointmentSeriesVisit, type Database } from "@sob/db";
import { eq, inArray } from "drizzle-orm";

export async function loadSeriesReferences(db: Pick<Database, "select">, ids: string[]) {
  const result = new Map<string, NonNullable<Appointment["series"]>>();
  if (!ids.length) return result;
  const rows = await db
    .select({
      appointmentId: appointmentSeriesVisit.appointmentId,
      id: appointmentSeries.id,
      position: appointmentSeriesVisit.position,
      count: appointmentSeries.occurrenceCount,
    })
    .from(appointmentSeriesVisit)
    .innerJoin(appointmentSeries, eq(appointmentSeries.id, appointmentSeriesVisit.seriesId))
    .where(inArray(appointmentSeriesVisit.appointmentId, ids));
  for (const row of rows)
    result.set(row.appointmentId, { id: row.id, position: row.position, count: row.count });
  return result;
}
