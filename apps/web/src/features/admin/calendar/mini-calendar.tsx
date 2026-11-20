import { useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "~/components/ui/icons";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { dayOfMonth, formatDateWithYear, weekdayShort } from "~/lib/format";
import { monthDates, shiftMonth } from "./logic";

export function MiniCalendar({
  date,
  today,
  onSelect,
  headingLevel = 3,
}: {
  headingLevel?: 2 | 3;
  date: string;
  today: string;
  onSelect: (date: string) => void;
}) {
  const { t, locale } = useI18n();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const [month, setMonth] = useState(date.slice(0, 7));
  useEffect(() => setMonth(date.slice(0, 7)), [date]);
  const days = monthDates(`${month}-01`);
  const title = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T12:00:00Z`));
  return (
    <section className="calendar-mini" aria-label={t("calendar.datePicker")}>
      <div className="flex items-center justify-between gap-1 pb-2">
        <Heading className="text-sm capitalize">{title}</Heading>
        <div className="flex">
          <button
            type="button"
            className="calendar-icon-button"
            aria-label={t("calendar.nav.previous", { unit: t("calendar.unit.month") })}
            onClick={() => setMonth(shiftMonth(`${month}-01`, -1).slice(0, 7))}
          >
            <ChevronLeftIcon width={16} />
          </button>
          <button
            type="button"
            className="calendar-icon-button"
            aria-label={t("calendar.nav.next", { unit: t("calendar.unit.month") })}
            onClick={() => setMonth(shiftMonth(`${month}-01`, 1).slice(0, 7))}
          >
            <ChevronRightIcon width={16} />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[0.65rem] text-muted" aria-hidden="true">
        {days.slice(0, 7).map((day) => (
          <span key={day} className="py-1">
            {weekdayShort(day, locale)}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-1">
        {days.map((day) => (
          <button
            key={day}
            type="button"
            onClick={() => onSelect(day)}
            aria-label={formatDateWithYear(day, locale)}
            aria-pressed={day === date}
            aria-current={day === today ? "date" : undefined}
            className={cn(
              "calendar-mini-day",
              day.slice(0, 7) !== month && "opacity-40",
              day === date && "is-selected",
              day === today && "is-today",
            )}
          >
            {dayOfMonth(day)}
          </button>
        ))}
      </div>
    </section>
  );
}
