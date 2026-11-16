import { expect, test } from "bun:test";
import { appointmentMatchesPromotionTiming } from "./timing";

const happyHour = {
  weekdays: [1, 2, 3, 4, 5],
  startMinute: 10 * 60,
  endMinute: 13 * 60,
  lastMinuteHours: null,
};
const visit = (startsAt: string, createdAt = "2026-03-01T12:00:00Z") => ({
  startsAt: new Date(startsAt),
  createdAt: new Date(createdAt),
});
test("happy-hour eligibility uses the salon's local weekday and a half-open start window", () => {
  expect(
    appointmentMatchesPromotionTiming(happyHour, visit("2026-03-09T09:00:00Z"), "Europe/Madrid"),
  ).toBe(true);
  expect(
    appointmentMatchesPromotionTiming(happyHour, visit("2026-03-09T08:59:59Z"), "Europe/Madrid"),
  ).toBe(false);
  expect(
    appointmentMatchesPromotionTiming(happyHour, visit("2026-03-09T12:00:00Z"), "Europe/Madrid"),
  ).toBe(false);
  expect(
    appointmentMatchesPromotionTiming(happyHour, visit("2026-03-08T10:00:00Z"), "Europe/Madrid"),
  ).toBe(false);
  expect(
    appointmentMatchesPromotionTiming(
      happyHour,
      visit("2026-03-09T09:00:00Z"),
      "America/Argentina/Buenos_Aires",
    ),
  ).toBe(false);
});
test("last-minute qualification binds when the booking was created rather than when its receipt is discounted", () => {
  const timing = { ...happyHour, lastMinuteHours: 24 };
  expect(
    appointmentMatchesPromotionTiming(
      timing,
      visit("2026-03-09T09:00:00Z", "2026-03-08T09:00:00Z"),
      "Europe/Madrid",
    ),
  ).toBe(true);
  expect(
    appointmentMatchesPromotionTiming(
      timing,
      visit("2026-03-09T09:00:00Z", "2026-03-08T08:59:59Z"),
      "Europe/Madrid",
    ),
  ).toBe(false);
  expect(
    appointmentMatchesPromotionTiming(
      timing,
      visit("2026-03-09T09:00:00Z", "2026-03-09T09:00:01Z"),
      "Europe/Madrid",
    ),
  ).toBe(false);
});
test("both repeated DST instants use the same local start and a skipped hour cannot be invented", () => {
  const sunday = { ...happyHour, weekdays: [7], startMinute: 120, endMinute: 180 };
  expect(
    appointmentMatchesPromotionTiming(sunday, visit("2026-10-25T00:30:00Z"), "Europe/Madrid"),
  ).toBe(true);
  expect(
    appointmentMatchesPromotionTiming(sunday, visit("2026-10-25T01:30:00Z"), "Europe/Madrid"),
  ).toBe(true);
  expect(
    appointmentMatchesPromotionTiming(sunday, visit("2026-03-29T01:30:00Z"), "Europe/Madrid"),
  ).toBe(false);
});
test("timed offers require an appointment and invalid persisted data fails closed", () => {
  expect(appointmentMatchesPromotionTiming(happyHour, null, "Europe/Madrid")).toBe(false);
  expect(appointmentMatchesPromotionTiming(happyHour, visit("bad"), "Europe/Madrid")).toBe(false);
  expect(
    appointmentMatchesPromotionTiming(happyHour, visit("2026-03-09T09:00:00Z"), "bad-zone"),
  ).toBe(false);
});
