import type { SyncEntity, SyncLiveView } from "@sob/contracts";
import { inventoryNumberingQueryKey, teamShiftWeekKey } from "~/lib/admin-queries";
import { intakeAdminQueryKey, intakeHistoryQueryKey } from "~/lib/api/intake-endpoints";
import { reviewRequestQueryKey } from "~/lib/api/review-endpoints";
import {
  loyaltyPolicyQueryKey,
  stampCardsQueryKey,
  stampNoticesQueryKey,
  stampProgramQueryKey,
} from "~/lib/api/reward-endpoints";

const calendar = [["admin", "calendar"], ["availability"]] as const;
const report = ["admin", "report"] as const;
const staffSchedule = [
  ...calendar,
  ["admin", "working-hours"],
  ["date-shifts"],
  teamShiftWeekKey,
  report,
] as const;
const moderation = ["reviews", "admin"] as const;
const commerce = [
  inventoryNumberingQueryKey,
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
    ["marketing-consent", "admin"],
    ["admin", "clients"],
    ["admin", "client"],
    ["admin", "calendar"],
    report,
    ["waitlist"],
  ],
  service: [
    ...calendar,
    ["admin", "services"],
    ["appointment-catalog"],
    ["services"],
    ["staff"],
    ["admin", "staff"],
    ["admin", "report"],
    ["combinations"],
  ],
  service_staff: [
    ...calendar,
    ["admin", "staff"],
    ["admin", "services"],
    ["appointment-catalog"],
    ["services"],
    ["staff"],
    ["combinations"],
  ],
  staff: [
    ...calendar,
    teamShiftWeekKey,
    reviewRequestQueryKey,
    moderation,
    ["admin", "staff"],
    ["admin", "staff-access"],
    ["admin", "staff-capacity"],
    ["admin", "report"],
    ["staff"],
    ["combinations"],
  ],
  working_hours: staffSchedule,
  date_shift: staffSchedule,
  time_off: [...calendar, ["admin", "time-off"], teamShiftWeekKey, report],
  salon_settings: [
    ...calendar,
    ["admin", "settings"],
    ["admin", "report"],
    ["salon"],
    ["commerce", "transactions"],
    teamShiftWeekKey,
  ],
  commerce: [...commerce, ["admin", "calendar"], ["admin", "appointment-context"]],
  waitlist: [["waitlist"]],
  inbox: [["calendar-inbox"]],
  review_requests: [reviewRequestQueryKey, moderation],
  portfolio: [["portfolio"]],
  marketing: [["marketing"]],
  promotions: [
    ["rewards", "promotions"],
    ["creative", "promotions"],
  ],
  loyalty: [
    loyaltyPolicyQueryKey,
    ["rewards", "admin"],
    stampProgramQueryKey,
    stampCardsQueryKey,
    stampNoticesQueryKey,
  ],
  intake_forms: [intakeAdminQueryKey],
  intake_records: [intakeHistoryQueryKey],
  booking_policy: [["booking-policy"], ["admin", "booking-policy"]],
  email_delivery: [["admin", "email-delivery"]],
  whatsapp_desk: [["admin", "whatsapp", "deliveries"]],
  whatsapp_settings: [["admin", "whatsapp", "connection"]],
  resource_catalogue: [...calendar, ["appointments"], ["admin", "resources"]],
  service_combinations: [["combinations"]],
};

export function liveQueryKeys(changes?: Iterable<SyncEntity | SyncLiveView>) {
  const unique = new Map<string, readonly string[]>();
  for (const entity of changes ?? (Object.keys(shared) as (SyncEntity | SyncLiveView)[]))
    for (const key of shared[entity]) unique.set(JSON.stringify(key), key);
  if (unique.has(JSON.stringify(["commerce"]))) {
    unique.delete(JSON.stringify(["commerce", "transactions"]));
  }
  return unique.values();
}
