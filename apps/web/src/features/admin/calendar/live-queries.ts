import type { SyncEntity, SyncLiveView } from "@sob/contracts";
import { teamShiftWeekKey } from "~/lib/admin-queries";
import { intakeAdminQueryKey, intakeHistoryQueryKey } from "~/lib/api/intake-endpoints";
import { reviewRequestQueryKey } from "~/lib/api/review-endpoints";

const calendar = [["admin", "calendar"], ["availability"]] as const;
const moderation = ["reviews", "admin"] as const;
const commerce = [
  ["commerce"],
  ["inventory"],
  ["passes"],
  ["gift-cards"],
  ["rewards"],
  ["accounting"],
  ["admin", "report"],
] as const;
const shared: Record<SyncEntity | SyncLiveView, readonly (readonly string[])[]> = {
  appointment: [
    ...calendar,
    reviewRequestQueryKey,
    moderation,
    ["admin", "appointment-context"],
    ["admin", "client"],
    ["admin", "clients"],
    ["admin", "report"],
    ["commerce", "unpaid"],
    ["calendar-inbox"],
  ],
  client: [
    reviewRequestQueryKey,
    ["admin", "clients"],
    ["admin", "client"],
    ["admin", "calendar"],
    ["admin", "report", "outcomes"],
    ["admin", "report", "clients"],
    ["waitlist"],
  ],
  service: [
    ...calendar,
    ["admin", "services"],
    ["services"],
    ["staff"],
    ["admin", "staff"],
    ["admin", "report"],
    ["combinations"],
  ],
  service_staff: [...calendar, ["admin", "staff"], ["admin", "services"], ["services"], ["staff"]],
  staff: [
    ...calendar,
    teamShiftWeekKey,
    reviewRequestQueryKey,
    moderation,
    ["admin", "staff"],
    ["admin", "staff-capacity"],
    ["admin", "report"],
    ["staff"],
  ],
  working_hours: [...calendar, ["admin", "working-hours"], ["date-shifts"], teamShiftWeekKey],
  date_shift: [...calendar, ["admin", "working-hours"], ["date-shifts"], teamShiftWeekKey],
  time_off: [...calendar, ["admin", "time-off"], teamShiftWeekKey],
  salon_settings: [
    ...calendar,
    ["admin", "settings"],
    ["admin", "report"],
    ["salon"],
    teamShiftWeekKey,
  ],
  commerce: [...commerce, ["admin", "calendar"], ["admin", "appointment-context"]],
  waitlist: [["waitlist"]],
  inbox: [["calendar-inbox"]],
  review_requests: [reviewRequestQueryKey, moderation],
  intake_forms: [intakeAdminQueryKey],
  intake_records: [intakeHistoryQueryKey],
  booking_policy: [["booking-policy"], ["admin", "booking-policy"]],
};

export function liveQueryKeys(changes?: Iterable<SyncEntity | SyncLiveView>) {
  const unique = new Map<string, readonly string[]>();
  for (const entity of changes ?? (Object.keys(shared) as (SyncEntity | SyncLiveView)[]))
    for (const key of shared[entity]) unique.set(JSON.stringify(key), key);
  return unique.values();
}
