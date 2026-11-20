import type { CalendarAppointment, CalendarResponse, TimeOff, WorkingWindow } from "@sob/contracts";
import type { CSSProperties } from "react";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import {
  dayOfMonth,
  formatDateLong,
  formatDuration,
  formatMoney,
  formatTime,
  weekdayShort,
} from "~/lib/format";
import { AppointmentBadges } from "./appointment-badges";
import { type CalendarView, statusAppearance } from "./logic";
import { type indexCalendar, localMinuteRange, serviceHue } from "./presentation";

function Entry({
  appointment,
  timeZone,
  onOpen,
}: {
  appointment: CalendarAppointment;
  timeZone: string;
  onOpen: (appointment: CalendarAppointment) => void;
}) {
  const { t, locale } = useI18n();
  const status = t(statusAppearance(appointment.status).labelKey);
  return (
    <button
      type="button"
      className="calendar-summary-entry"
      data-status={appointment.status}
      style={{ "--service-hue": serviceHue(appointment.serviceNames[0] ?? "") } as CSSProperties}
      title={`${appointment.clientName} · ${appointment.serviceNames.join(", ")} · ${status}`}
      onClick={() => onOpen(appointment)}
    >
      <span className="block truncate font-semibold tabular-nums">
        {formatTime(appointment.startsAt, timeZone, locale)} –{" "}
        {formatTime(appointment.endsAt, timeZone, locale)}
      </span>
      <span className="block truncate">
        {appointment.clientName} · {appointment.serviceNames.join(", ")}
      </span>
      <AppointmentBadges badges={appointment.serviceBadges} />
      {appointment.status !== "booked" ? (
        <span className="block text-[0.65rem]">{status}</span>
      ) : (
        <span className="sr-only"> {status}</span>
      )}
    </button>
  );
}

export function CalendarOverview({
  view,
  dates,
  date,
  today,
  staff,
  index,
  timeOff = [],
  workingWindows = [],
  timeZone,
  onDay,
  onOpen,
}: {
  view: Exclude<CalendarView, "day">;
  dates: string[];
  date: string;
  today: string;
  staff: CalendarResponse["staff"];
  index: ReturnType<typeof indexCalendar>;
  timeOff?: TimeOff[];
  workingWindows?: WorkingWindow[];
  timeZone: string;
  onDay: (date: string, staffId?: string) => void;
  onOpen: (appointment: CalendarAppointment) => void;
}) {
  const { t, locale } = useI18n();
  const count = (n: number) => t("calendar.appointmentCount", { count: n });
  if (view === "list")
    return (
      <section className="calendar-agenda" aria-label={t("calendar.view.list")}>
        {dates.map((day) => {
          const rows = index.byDay.get(day) ?? [];
          const currencies = new Map<string, number>();
          for (const appointment of rows) {
            if (appointment.status === "cancelled") continue;
            for (const service of appointment.services)
              currencies.set(
                service.currency,
                (currencies.get(service.currency) ?? 0) + service.priceCents,
              );
          }
          return (
            <section key={day} className="calendar-agenda-day">
              <button
                type="button"
                className={cn("calendar-agenda-date", day === today && "is-today")}
                onClick={() => onDay(day)}
              >
                {day === today ? t("calendar.nav.today") : formatDateLong(day, locale)}
              </button>
              <div className="min-w-0">
                <div className="calendar-day-summary">
                  <span>{count(rows.length)}</span>
                  <span>
                    {t("calendar.scheduledValue")}{" "}
                    <strong>
                      {[...currencies]
                        .map(([currency, cents]) => formatMoney(cents, currency, locale))
                        .join(" · ") || "—"}
                    </strong>
                  </span>
                </div>
                {rows.length === 0 ? (
                  <p className="px-4 py-8 text-sm text-muted">{t("calendar.noAppointments")}</p>
                ) : (
                  rows.map((appointment) => (
                    <div key={appointment.id} className="calendar-agenda-row">
                      <div className="text-xs text-muted">
                        <span className="block font-semibold text-fg">
                          {formatTime(appointment.startsAt, timeZone, locale)}
                        </span>
                        {formatDuration(
                          Math.round(
                            (Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) /
                              60000,
                          ),
                          locale,
                        )}
                      </div>
                      <Entry appointment={appointment} timeZone={timeZone} onOpen={onOpen} />
                      <span className="hidden text-xs text-muted sm:block">
                        {staff.find((s) => s.id === appointment.staffId)?.displayName}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </section>
    );

  if (view === "week")
    return (
      // biome-ignore lint/a11y/noNoninteractiveTabindex: scroll region must be keyboard reachable
      <section className="calendar-overview" aria-label={t("calendar.view.week")} tabIndex={0}>
        <div
          className="calendar-week-table"
          style={{ gridTemplateColumns: "8rem repeat(7, minmax(9rem, 1fr))" }}
        >
          <div className="calendar-overview-corner" />
          {dates.map((day) => (
            <button
              type="button"
              key={day}
              className={cn("calendar-overview-heading", day === today && "is-today")}
              onClick={() => onDay(day)}
            >
              <strong>
                {weekdayShort(day, locale)} {dayOfMonth(day)}
              </strong>
              <span>{count((index.byDay.get(day) ?? []).length)}</span>
            </button>
          ))}
          {staff.map((member) => (
            <WeekRow
              key={member.id}
              member={member}
              dates={dates}
              index={index}
              timeOff={timeOff}
              workingWindows={workingWindows}
              timeZone={timeZone}
              onDay={onDay}
              onOpen={onOpen}
            />
          ))}
        </div>
      </section>
    );

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: scroll region must be keyboard reachable
    <section className="calendar-overview" aria-label={t("calendar.view.month")} tabIndex={0}>
      <div className="calendar-month-table">
        {dates.slice(0, 7).map((day) => (
          <div key={day} className="calendar-overview-heading">
            {weekdayShort(day, locale)}
          </div>
        ))}
        {dates.map((day) => {
          const rows = index.byDay.get(day) ?? [];
          return (
            <div
              key={day}
              className={cn(
                "calendar-month-cell",
                day.slice(0, 7) !== date.slice(0, 7) && "is-outside",
              )}
            >
              <button
                type="button"
                className={cn("calendar-month-date", day === today && "is-today")}
                onClick={() => onDay(day)}
                aria-label={`${day === today ? `${t("calendar.nav.today")}, ` : ""}${formatDateLong(day, locale)}`}
              >
                {day === today ? t("calendar.nav.today") : dayOfMonth(day)}
              </button>
              <button type="button" className="calendar-count" onClick={() => onDay(day)}>
                {count(rows.length)} ›
              </button>
              {rows.slice(0, 3).map((appointment) => (
                <Entry
                  key={appointment.id}
                  appointment={appointment}
                  timeZone={timeZone}
                  onOpen={onOpen}
                />
              ))}
              {rows.length > 3 && (
                <button type="button" className="calendar-count" onClick={() => onDay(day)}>
                  {t("calendar.showAll", { count: rows.length })} ›
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function WeekRow({
  member,
  dates,
  index,
  timeOff,
  workingWindows,
  timeZone,
  onDay,
  onOpen,
}: {
  member: CalendarResponse["staff"][number];
  dates: string[];
  index: ReturnType<typeof indexCalendar>;
  timeOff: TimeOff[];
  workingWindows: WorkingWindow[];
  timeZone: string;
  onDay: (date: string, staffId?: string) => void;
  onOpen: (appointment: CalendarAppointment) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <>
      <div className="calendar-week-person">
        <span className="calendar-avatar" aria-hidden="true">
          {member.displayName.slice(0, 2)}
        </span>
        <strong>{member.displayName}</strong>
      </div>
      {dates.map((day) => {
        const rows = [
          ...new Map(
            (index.byColumn.get(`${member.id}:${day}`) ?? []).map((entry) => [
              entry.appointment.id,
              entry.appointment,
            ]),
          ).values(),
        ];
        const off = timeOff.filter(
          (row) => row.staffId === member.id && localMinuteRange(row, day, timeZone),
        );
        const working = workingWindows.some(
          (row) => row.staffId === member.id && localMinuteRange(row, day, timeZone),
        );
        return (
          <div key={day} className="calendar-week-cell" data-working={working}>
            <div className="calendar-week-entries">
              {off.slice(0, 1).map((row) => (
                <div key={row.id} className="calendar-summary-time-off">
                  <strong>
                    {formatTime(row.startsAt, timeZone, locale)} –{" "}
                    {formatTime(row.endsAt, timeZone, locale)}
                  </strong>
                  <span>
                    {t("calendar.grid.timeOff", { reason: row.reason ? `: ${row.reason}` : "" })}
                  </span>
                </div>
              ))}
              {rows.slice(0, off.length ? 3 : 4).map((appointment) => (
                <Entry
                  key={appointment.id}
                  appointment={appointment}
                  timeZone={timeZone}
                  onOpen={onOpen}
                />
              ))}
            </div>
            <button
              type="button"
              className="calendar-show-all"
              onClick={() => onDay(day, member.id)}
              aria-label={`${member.displayName}, ${day}: ${t("calendar.showAll", { count: rows.length })}`}
            >
              {t("calendar.showAll", { count: rows.length })} ›
            </button>
          </div>
        );
      })}
    </>
  );
}
