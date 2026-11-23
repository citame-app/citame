import { idSchema, localDateSchema } from "@sob/contracts";
import { addDaysLocal } from "~/lib/format";
import { type CalendarView, calendarViews, shiftMonth } from "./logic";

export interface CalendarSearch {
  view: CalendarView;
  date: string;
  /** Comma separated staff ids; empty means everyone the caller may see. */
  staff?: string;
  working?: boolean;
  appointment?: string;
}

/** The URL is the calendar state, so views are deep-linkable and survive a reload. */
export function validateCalendarSearch(
  raw: Record<string, unknown>,
  today: string,
): CalendarSearch {
  const date = localDateSchema.safeParse(raw.date);
  const staff =
    typeof raw.staff === "string"
      ? [...new Set(raw.staff.split(",").filter((id) => idSchema.safeParse(id).success))]
      : [];
  return {
    view: calendarViews.find((view) => view === raw.view) ?? "day",
    date: date.success ? date.data : today,
    ...(staff.length > 0 ? { staff: staff.join(",") } : {}),
    ...(raw.working === true || raw.working === "true" ? { working: true } : {}),
    ...(idSchema.safeParse(raw.appointment).success
      ? { appointment: raw.appointment as string }
      : {}),
  };
}

export function shiftDate(date: string, view: CalendarView, direction: 1 | -1): string {
  if (view === "month") return shiftMonth(date, direction);
  return addDaysLocal(date, direction * (view === "week" || view === "list" ? 7 : 1));
}
