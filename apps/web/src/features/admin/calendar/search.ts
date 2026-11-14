import { idSchema, localDateSchema } from "@sob/contracts";
import { addDaysLocal } from "~/lib/format";
import type { CalendarView } from "./logic";

export interface CalendarSearch {
  view: CalendarView;
  date: string;
  /** Owner filter: comma separated staff ids (exactly one in the week view); empty means everyone. */
  staff?: string;
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
    view: raw.view === "week" ? "week" : "day",
    date: date.success ? date.data : today,
    ...(staff.length > 0 ? { staff: staff.join(",") } : {}),
  };
}

export function shiftDate(date: string, view: CalendarView, direction: 1 | -1): string {
  return addDaysLocal(date, direction * (view === "week" ? 7 : 1));
}
