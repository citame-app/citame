import type { ReportQuery, ReportStaffWork } from "@sob/contracts";
import type { Database } from "@sob/db";
import { reportStaffOccupancy } from "./occupancy";
import { reportDateScope } from "./service";

export function reportStaffWork(
  db: Database,
  query: ReportQuery & { staffId: string },
  now: Date,
): Promise<ReportStaffWork> {
  return db.transaction(
    async (tx) => {
      const scope = await reportDateScope(tx, query);
      const today = Temporal.Instant.fromEpochMilliseconds(now.getTime())
        .toZonedDateTimeISO(scope.timezone)
        .toPlainDate();
      const reference = {
        ...query,
        from: today.toString(),
        to: today.add({ days: 13 }).toString(),
      };
      const [selected, upcoming] = await Promise.all([
        reportStaffOccupancy(tx, [query.staffId], query, scope, query.staffId),
        reportDateScope(tx, reference).then((upcomingScope) =>
          reportStaffOccupancy(tx, [query.staffId], reference, upcomingScope, query.staffId),
        ),
      ]);
      if (!selected.detail || !upcoming.detail)
        throw new Error("Staff work report was not measured");
      return {
        staffId: query.staffId,
        timezone: scope.timezone,
        selected: selected.detail,
        upcoming: upcoming.detail,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
