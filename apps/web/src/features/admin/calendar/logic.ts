import {
  type AppointmentStatus,
  type CalendarView,
  calendarViewSchema,
  type UserRole,
} from "@sob/contracts";
import { addDaysLocal, localDateOf } from "~/lib/format";
import { localDayBounds, minutesIntoLocalDay, startOfWeek, weekDates } from "~/lib/zoned";
import { localMinuteRange } from "./presentation";

export type { CalendarView };
export const calendarViews = calendarViewSchema.options;

export function shiftMonth(date: string, offset: number): string {
  const value = new Date(`${date.slice(0, 7)}-01T12:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + offset);
  const end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
  return `${value.toISOString().slice(0, 7)}-${String(Math.min(Number(date.slice(8)), end)).padStart(2, "0")}`;
}

/** Complete Monday-first weeks, including the adjoining days of the previous/next month. */
export function monthDates(date: string): string[] {
  const first = `${date.slice(0, 7)}-01`;
  const last = addDaysLocal(shiftMonth(first, 1), -1);
  const start = startOfWeek(first);
  const end = addDaysLocal(startOfWeek(last), 7);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);
  return Array.from({ length: days }, (_, i) => addDaysLocal(start, i));
}

export function rangeFor(view: CalendarView, date: string, timeZone: string) {
  const dates =
    view === "month"
      ? monthDates(date)
      : view === "list"
        ? Array.from({ length: 7 }, (_, i) => addDaysLocal(date, i))
        : view === "day" || view === "resources"
          ? [date]
          : weekDates(date);
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
  date?: string,
  minimumVisualMinutes = 0,
): Block[] {
  const placed = items
    .map((item) => {
      const clipped = date ? localMinuteRange(item, date, timeZone) : null;
      const rawStart = clipped?.start ?? minutesIntoLocalDay(item.startsAt, timeZone);
      const duration = clipped
        ? clipped.end - clipped.start
        : Math.max(5, Math.round((Date.parse(item.endsAt) - Date.parse(item.startsAt)) / 60_000));
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
    laneEnds[lane] = block.startMinutes + Math.max(block.durationMinutes, minimumVisualMinutes);
    block.lane = lane;
    group.push(block);
    groupEnd = Math.max(
      groupEnd,
      block.startMinutes + Math.max(block.durationMinutes, minimumVisualMinutes),
    );
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
  const today = localDateOf(instant, timeZone);
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
  sourceCopy?: { readOnly: boolean };
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
  if (!canEdit || role === "client" || appointment.sourceCopy?.readOnly) return none;
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
