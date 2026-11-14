import type { AdminStaff } from "@sob/contracts";
import { CALENDAR_MAX_DAYS } from "@sob/contracts";

const DAY_MS = 86_400_000;

/** Consecutive `[from, to)` windows covering `days` days, each within the calendar API's limit. */
export function chunkWindows(from: string, days: number, chunkDays = CALENDAR_MAX_DAYS) {
  const windows: { from: string; to: string }[] = [];
  const end = Date.parse(from) + days * DAY_MS;
  for (let start = Date.parse(from); start < end; start += chunkDays * DAY_MS) {
    windows.push({
      from: new Date(start).toISOString(),
      to: new Date(Math.min(start + chunkDays * DAY_MS, end)).toISOString(),
    });
  }
  return windows;
}

/** Who can take over an appointment: another active member who performs all of its services. */
export function eligibleTargets(
  appointment: { staffId: string; services: { serviceId: string | null }[] },
  staff: AdminStaff[],
): AdminStaff[] {
  const ids = appointment.services.map((s) => s.serviceId);
  if (ids.length === 0 || ids.some((id) => id === null)) return [];
  return staff.filter(
    (member) =>
      member.active &&
      member.id !== appointment.staffId &&
      ids.every((id) => id !== null && member.serviceIds.includes(id)),
  );
}
