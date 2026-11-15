import type { AppointmentStatus, UserRole } from "@sob/contracts";
import { addDaysLocal } from "~/lib/format";
import { localDayBounds, minutesIntoLocalDay, weekDates } from "~/lib/zoned";

export type CalendarView = "day" | "week";

export function rangeFor(view: CalendarView, date: string, timeZone: string) {
  const dates = view === "day" ? [date] : weekDates(date);
  const first = dates[0] as string;
  const last = dates[dates.length - 1] as string;
  return {
    dates,
    from: localDayBounds(first, timeZone).from,
    to: localDayBounds(addDaysLocal(last, 0), timeZone).to,
  };
}

export interface TimedItem {
  id: string;
  startsAt: string;
  endsAt: string;
}

export interface Block extends TimedItem {
  /** Minutes from the first grid row. */
  startMinutes: number;
  durationMinutes: number;
  lane: number;
  lanes: number;
}

/** Positions items in one column; overlapping items split the width into lanes. */
export function layoutBlocks(
  items: TimedItem[],
  timeZone: string,
  gridStartMinutes: number,
): Block[] {
  const placed = items
    .map((item) => {
      const rawStart = minutesIntoLocalDay(item.startsAt, timeZone);
      const duration = Math.max(
        5,
        Math.round((Date.parse(item.endsAt) - Date.parse(item.startsAt)) / 60_000),
      );
      const start = Math.max(rawStart, gridStartMinutes);
      const end = rawStart + duration;
      return {
        ...item,
        startMinutes: start - gridStartMinutes,
        durationMinutes: Math.max(5, end - start),
        lane: 0,
        lanes: 1,
      };
    })
    .sort((a, b) => a.startMinutes - b.startMinutes || b.durationMinutes - a.durationMinutes);

  // Group transitively overlapping blocks, then give each the lane count of its group.
  let group: Block[] = [];
  let groupEnd = -1;
  const flush = () => {
    const lanes = group.reduce((max, b) => Math.max(max, b.lane + 1), 1);
    for (const b of group) b.lanes = lanes;
    group = [];
  };
  const laneEnds: number[] = [];
  for (const block of placed) {
    if (block.startMinutes >= groupEnd && group.length > 0) {
      flush();
      laneEnds.length = 0;
    }
    let lane = laneEnds.findIndex((end) => end <= block.startMinutes);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = block.startMinutes + block.durationMinutes;
    block.lane = lane;
    group.push(block);
    groupEnd = Math.max(groupEnd, block.startMinutes + block.durationMinutes);
  }
  flush();
  return placed;
}

/** Whole hours the grid shows: the business day, widened to hold every window and appointment. */
export function gridHours(
  windows: { startsAt: string; endsAt: string }[],
  appointments: { startsAt: string; endsAt: string }[],
  timeZone: string,
): { startHour: number; endHour: number } {
  let start = 8 * 60;
  let end = 20 * 60;
  for (const item of [...windows, ...appointments]) {
    const s = minutesIntoLocalDay(item.startsAt, timeZone);
    let e = minutesIntoLocalDay(item.endsAt, timeZone);
    if (e === 0 || e < s) e = 24 * 60;
    start = Math.min(start, s);
    end = Math.max(end, e);
  }
  return { startHour: Math.floor(start / 60), endHour: Math.min(24, Math.ceil(end / 60)) };
}

export const minutesToOffset = (minutes: number, pxPerMinute: number) => minutes * pxPerMinute;

/** Pointer offset inside the grid to minutes, snapped to the slot grid and never negative. */
export function offsetToSnappedMinutes(
  offsetPx: number,
  pxPerMinute: number,
  granularity: number,
): number {
  const minutes = Math.max(0, offsetPx / pxPerMinute);
  return Math.round(minutes / granularity) * granularity;
}

export function nowMarkerMinutes(now: Date, localDate: string, timeZone: string): number | null {
  const instant = now.toISOString();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return today === localDate ? minutesIntoLocalDay(instant, timeZone) : null;
}

export type StatusIcon = "clock" | "check" | "slash" | "alert";

export function statusAppearance(status: AppointmentStatus): {
  /** Tailwind classes for the block; colors come from tokens that pass contrast in both themes. */
  tone: "booked" | "completed" | "cancelled" | "no_show";
  icon: StatusIcon;
  labelKey: `calendar.status.${AppointmentStatus}`;
} {
  const icon: Record<AppointmentStatus, StatusIcon> = {
    booked: "clock",
    completed: "check",
    cancelled: "slash",
    no_show: "alert",
  };
  return { tone: status, icon: icon[status], labelKey: `calendar.status.${status}` };
}

export interface Actionable {
  status: AppointmentStatus;
  startsAt: string;
  staffId: string;
}

export interface AvailableActions {
  complete: boolean;
  noShow: boolean;
  cancel: boolean;
  reschedule: boolean;
  completeBlockedReason?: "notStarted";
}

/** Mirrors the transition table of ADR 0004; the API stays the authority. */
export function availableActions(
  role: UserRole,
  appointment: Actionable,
  now: Date,
  ownStaffId: string | null,
  canEdit = true,
): AvailableActions {
  const none: AvailableActions = {
    complete: false,
    noShow: false,
    cancel: false,
    reschedule: false,
  };
  if (!canEdit || role === "client") return none;
  if (role === "staff" && appointment.staffId !== ownStaffId) return none;
  const started = Date.parse(appointment.startsAt) <= now.getTime();
  switch (appointment.status) {
    case "booked":
      return {
        complete: started,
        noShow: started,
        cancel: true,
        reschedule: true,
        ...(started ? {} : { completeBlockedReason: "notStarted" as const }),
      };
    case "completed":
      return { ...none, noShow: role === "owner" };
    case "no_show":
      return { ...none, complete: role === "owner" };
    case "cancelled":
      return none;
  }
}
