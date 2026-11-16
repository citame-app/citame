import { type DateShiftDay, dateShiftRangeSchema, type WorkingRange } from "@sob/contracts";
import { type Database, dateShift } from "@sob/db";
import { and, asc, gte, inArray, lte } from "drizzle-orm";
import type { DatedWorkingHours } from "../availability/dated-hours";

type Reader = Pick<Database, "select">;
export async function loadShiftRows(db: Reader, staffIds: string[], from?: string, to?: string) {
  if (!staffIds.length) return [];
  return db
    .select()
    .from(dateShift)
    .where(
      and(
        inArray(dateShift.staffId, staffIds),
        from ? gte(dateShift.date, from) : undefined,
        to ? lte(dateShift.date, to) : undefined,
      ),
    )
    .orderBy(asc(dateShift.staffId), asc(dateShift.date), asc(dateShift.id));
}
export function asDatedHours(
  rows: Awaited<ReturnType<typeof loadShiftRows>>,
  staffId?: string,
): DatedWorkingHours[] {
  return rows
    .filter((row) => row.ranges !== null && (!staffId || row.staffId === staffId))
    .map((row) => ({
      date: row.date,
      ranges: dateShiftRangeSchema
        .array()
        .parse(row.ranges)
        .map((range) => ({ start: range.startTime, end: range.endTime })),
    }));
}
export async function loadDatedHours(db: Reader, staffId: string, date: string) {
  return asDatedHours(await loadShiftRows(db, [staffId], date, date));
}
export function shiftDay(
  date: string,
  hours: WorkingRange[],
  rows: Awaited<ReturnType<typeof loadShiftRows>>,
): DateShiftDay {
  const row = rows.find((row) => row.date === date);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const ranges =
    row?.ranges === undefined || row.ranges === null
      ? null
      : dateShiftRangeSchema.array().parse(row.ranges);
  return {
    date,
    version: row?.version ?? 0,
    ranges,
    effectiveRanges:
      ranges ??
      hours
        .filter((range) => range.weekday === weekday)
        .map((range) => ({ startTime: range.startTime, endTime: range.endTime }))
        .sort((a, b) => (a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0)),
  };
}
