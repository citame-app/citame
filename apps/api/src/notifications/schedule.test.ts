import { describe, expect, test } from "bun:test";
import { planReminders } from "./schedule";

const NOW = new Date("2026-03-01T00:00:00Z");
const iso = (plans: { kind: string; scheduledFor: Date }[]) =>
  plans.map((p) => `${p.kind}@${p.scheduledFor.toISOString()}`);

describe("planReminders", () => {
  test("schedules the default 24h and 2h reminders before the start", () => {
    const plans = planReminders({
      startsAt: new Date("2026-03-10T15:00:00Z"),
      now: NOW,
      timeZone: "America/Argentina/Buenos_Aires",
      firstLeadMinutes: 1440,
      secondLeadMinutes: 120,
    });
    expect(iso(plans)).toEqual([
      "reminder_24h@2026-03-09T15:00:00.000Z",
      "reminder_2h@2026-03-10T13:00:00.000Z",
    ]);
  });

  test("skips reminders whose time has already passed", () => {
    const plans = planReminders({
      startsAt: new Date("2026-03-01T10:00:00Z"),
      now: new Date("2026-03-01T01:00:00Z"),
      timeZone: "UTC",
      firstLeadMinutes: 1440,
      secondLeadMinutes: 120,
    });
    expect(iso(plans)).toEqual(["reminder_2h@2026-03-01T08:00:00.000Z"]);
  });

  test("skips everything for an appointment in the past or starting now", () => {
    const plans = planReminders({
      startsAt: NOW,
      now: NOW,
      timeZone: "UTC",
      firstLeadMinutes: 1440,
      secondLeadMinutes: 120,
    });
    expect(plans).toEqual([]);
  });

  test("a null lead disables that reminder", () => {
    const plans = planReminders({
      startsAt: new Date("2026-03-10T15:00:00Z"),
      now: NOW,
      timeZone: "UTC",
      firstLeadMinutes: null,
      secondLeadMinutes: 120,
    });
    expect(iso(plans)).toEqual(["reminder_2h@2026-03-10T13:00:00.000Z"]);
  });

  test("whole-day leads keep the local wall-clock hour across spring-forward", () => {
    // 09:00 EDT on Sunday 8 March 2026 is the day DST starts in New York (13:00Z).
    // The previous day's 09:00 is still EST (14:00Z): 23 real hours earlier, not 24.
    const plans = planReminders({
      startsAt: new Date("2026-03-09T13:00:00Z"),
      now: NOW,
      timeZone: "America/New_York",
      firstLeadMinutes: 1440,
      secondLeadMinutes: null,
    });
    expect(iso(plans)).toEqual(["reminder_24h@2026-03-08T13:00:00.000Z"]);
    const across = planReminders({
      startsAt: new Date("2026-03-08T13:00:00Z"),
      now: NOW,
      timeZone: "America/New_York",
      firstLeadMinutes: 1440,
      secondLeadMinutes: null,
    });
    expect(iso(across)).toEqual(["reminder_24h@2026-03-07T14:00:00.000Z"]);
  });

  test("whole-day leads keep the wall-clock hour across fall-back", () => {
    // 09:00 EST on Sunday 1 Nov 2026 (14:00Z); Saturday 09:00 is still EDT (13:00Z).
    const plans = planReminders({
      startsAt: new Date("2026-11-01T14:00:00Z"),
      now: NOW,
      timeZone: "America/New_York",
      firstLeadMinutes: 1440,
      secondLeadMinutes: null,
    });
    expect(iso(plans)).toEqual(["reminder_24h@2026-10-31T13:00:00.000Z"]);
  });

  test("a wall-clock target inside the spring-forward gap moves forward", () => {
    // 03:30 EDT on 8 March (07:30Z) minus one day is 02:30 on 7 March, a normal EST time.
    // Reverse: 02:30 on 8 March does not exist, so a 1-day lead from 9 March 02:30 lands at 03:30.
    const plans = planReminders({
      startsAt: new Date("2026-03-09T06:30:00Z"), // 02:30 EDT on 9 March
      now: NOW,
      timeZone: "America/New_York",
      firstLeadMinutes: 1440,
      secondLeadMinutes: null,
    });
    expect(iso(plans)).toEqual(["reminder_24h@2026-03-08T07:30:00.000Z"]);
  });

  test("sub-day leads are plain elapsed minutes even across a DST change", () => {
    const plans = planReminders({
      startsAt: new Date("2026-03-08T12:00:00Z"), // 08:00 EDT
      now: NOW,
      timeZone: "America/New_York",
      firstLeadMinutes: null,
      secondLeadMinutes: 360,
    });
    expect(iso(plans)).toEqual(["reminder_2h@2026-03-08T06:00:00.000Z"]);
  });
});
