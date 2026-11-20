import { shiftDate, type TeamShiftWeek } from "@sob/contracts";
import { type Database, staffProfile, timeOff, workingHours } from "@sob/db";
import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { getSalonSettings } from "../settings/service";
import { loadShiftRows, shiftDay, toWorkingRange } from "./date-hours";

function byStaff<T extends { staffId: string }>(rows: T[]) {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const group = result.get(row.staffId);
    if (group) group.push(row);
    else result.set(row.staffId, [row]);
  }
  return result;
}

/** Read the roster and its schedule from one snapshot, with queries bounded by the week. */
export function getTeamShiftWeek(db: Database, week: string): Promise<TeamShiftWeek> {
  return db.transaction(
    async (tx) => {
      const { timezone } = await getSalonSettings(tx);
      const staff = await tx
        .select({ id: staffProfile.id, name: staffProfile.displayName })
        .from(staffProfile)
        .where(and(eq(staffProfile.active, true), isNull(staffProfile.deletedAt)))
        .orderBy(asc(staffProfile.displayName), asc(staffProfile.id));
      if (!staff.length) return { timezone, members: [] };

      const localStart = (date: string) =>
        Temporal.PlainDate.from(date).toZonedDateTime(timezone).epochMilliseconds;
      const days = Array.from({ length: 7 }, (_, offset) => {
        const date = shiftDate(week, offset);
        return { date, start: localStart(date), end: localStart(shiftDate(date, 1)) };
      });
      const ids = staff.map(({ id }) => id);
      const [weekly, changes, absences] = await Promise.all([
        tx
          .select()
          .from(workingHours)
          .where(and(inArray(workingHours.staffId, ids), isNull(workingHours.deletedAt))),
        loadShiftRows(tx, ids, week, shiftDate(week, 6)),
        tx
          .select({
            id: timeOff.id,
            staffId: timeOff.staffId,
            startsAt: timeOff.startsAt,
            endsAt: timeOff.endsAt,
          })
          .from(timeOff)
          .where(
            and(
              inArray(timeOff.staffId, ids),
              isNull(timeOff.deletedAt),
              lt(timeOff.startsAt, new Date(localStart(shiftDate(week, 7)))),
              gt(timeOff.endsAt, new Date(localStart(week))),
            ),
          )
          .orderBy(asc(timeOff.startsAt), asc(timeOff.id)),
      ]);
      const hoursByStaff = byStaff(weekly);
      const changesByStaff = byStaff(changes);
      const absencesByStaff = byStaff(absences);
      return {
        timezone,
        members: staff.map((member) => {
          const hours = (hoursByStaff.get(member.id) ?? []).map(toWorkingRange);
          const staffChanges = changesByStaff.get(member.id) ?? [];
          const staffAbsences = absencesByStaff.get(member.id) ?? [];
          return {
            ...member,
            days: days.map(({ date, start, end }) => {
              const day = shiftDay(date, hours, staffChanges);
              return {
                date,
                custom: day.ranges !== null,
                ranges: day.effectiveRanges,
                absences: staffAbsences.flatMap(({ id, startsAt, endsAt }) => {
                  const clippedStart = Math.max(startsAt.getTime(), start);
                  const clippedEnd = Math.min(endsAt.getTime(), end);
                  if (clippedStart >= clippedEnd) return [];
                  return [
                    {
                      id,
                      startsAt: new Date(clippedStart).toISOString(),
                      endsAt: new Date(clippedEnd).toISOString(),
                      fullDay: clippedStart === start && clippedEnd === end,
                    },
                  ];
                }),
              };
            }),
          };
        }),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
