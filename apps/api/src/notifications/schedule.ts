/** Reminder kinds that are scheduled ahead of time (the others are sent right away). */
export type ScheduledReminderKind = "reminder_24h" | "reminder_2h";

export interface ReminderPlan {
  kind: ScheduledReminderKind;
  scheduledFor: Date;
}

export interface PlanRemindersInput {
  startsAt: Date;
  now: Date;
  /** Salon IANA timezone. */
  timeZone: string;
  /** Lead of the first reminder in minutes (kind `reminder_24h`); null disables it. */
  firstLeadMinutes: number | null;
  /** Lead of the second reminder in minutes (kind `reminder_2h`); null disables it. */
  secondLeadMinutes: number | null;
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * Instant `leadMinutes` before `startsAt`. Whole-day leads count calendar days in the salon
 * timezone, so "the day before" stays at the same wall-clock hour across a DST change (a
 * client booked for 09:00 hears from us at 09:00, not at 08:00 or 10:00). A wall-clock time
 * that does not exist that day moves forward, an ambiguous one takes the earlier occurrence
 * (Temporal's `compatible` rule). Shorter leads are plain elapsed time.
 */
function leadInstant(startsAt: Date, leadMinutes: number, timeZone: string): Date {
  if (leadMinutes % MINUTES_PER_DAY === 0) {
    const zoned = Temporal.Instant.fromEpochMilliseconds(startsAt.getTime()).toZonedDateTimeISO(
      timeZone,
    );
    const earlier = zoned.subtract({ days: leadMinutes / MINUTES_PER_DAY });
    return new Date(earlier.epochMilliseconds);
  }
  return new Date(startsAt.getTime() - leadMinutes * 60_000);
}

/**
 * Pure planner: which reminders to schedule for an appointment and when. Reminders that are
 * already due at `now` are dropped (a booking made 3 hours ahead never gets a "24 hours"
 * reminder, and a late edit never fires something in the past).
 */
export function planReminders(input: PlanRemindersInput): ReminderPlan[] {
  const wanted: [ScheduledReminderKind, number | null][] = [
    ["reminder_24h", input.firstLeadMinutes],
    ["reminder_2h", input.secondLeadMinutes],
  ];
  const plans: ReminderPlan[] = [];
  for (const [kind, lead] of wanted) {
    if (lead === null) continue;
    const scheduledFor = leadInstant(input.startsAt, lead, input.timeZone);
    if (scheduledFor.getTime() <= input.now.getTime()) continue;
    if (scheduledFor.getTime() >= input.startsAt.getTime()) continue;
    plans.push({ kind, scheduledFor });
  }
  return plans;
}
