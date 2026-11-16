import type { PromotionTiming } from "@sob/contracts";
import { createTranslator, type Locale } from "~/i18n";
export function promotionWeekday(day: number, locale: Locale) {
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, 2, 2 + day - 1)),
  );
}
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export function promotionTimingConditions(
  timing: PromotionTiming,
  timeZone: string,
  locale: Locale,
): string[] {
  const t = createTranslator(locale);
  const days = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
    [...timing.weekdays].sort((a, b) => a - b).map((day) => promotionWeekday(day, locale)),
  );
  return [
    t("timedPromotions.conditions", {
      days,
      from: clock(timing.startMinute),
      before: clock(timing.endMinute),
      zone: timeZone,
    }),
    ...(timing.lastMinuteHours === null
      ? []
      : [t("timedPromotions.lead", { hours: timing.lastMinuteHours })]),
    t("timedPromotions.move"),
  ];
}
