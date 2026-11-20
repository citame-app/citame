import {
  localDateSchema,
  shiftDate,
  shiftWeekStart,
  teamShiftWeekStartSchema,
} from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ChevronLeftIcon, ChevronRightIcon } from "~/components/ui/icons";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useCalendarLive } from "~/features/admin/calendar/live-provider";
import { useNow } from "~/features/admin/use-now";
import { useI18n } from "~/i18n/react";
import { CALENDAR_POLL_MS, teamShiftWeekKey } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { dateFormatter, formatTime, localDateOf } from "~/lib/format";
import { salonQuery } from "~/lib/queries";

function absenceTimes(startsAt: string, endsAt: string, timeZone: string, locale: string) {
  const formatter = dateFormatter(locale, { timeZone, timeZoneName: "shortOffset" });
  const offset = (instant: string) =>
    formatter.formatToParts(new Date(instant)).find((part) => part.type === "timeZoneName")?.value;
  const start = formatTime(startsAt, timeZone, locale);
  const end = formatTime(endsAt, timeZone, locale);
  const startOffset = offset(startsAt);
  const endOffset = offset(endsAt);
  return startOffset && endOffset && startOffset !== endOffset
    ? { start: `${start} ${startOffset}`, end: `${end} ${endOffset}` }
    : { start, end };
}

export function TeamShifts({
  week: selectedWeek,
  onWeekChange,
  onOpenMember,
}: {
  week?: string;
  onWeekChange: (week: string) => void;
  onOpenMember: (id: string, week: string) => void;
}) {
  const { t, locale, timeZone } = useI18n();
  const salon = useQuery(salonQuery);
  const caption = useId();
  const now = useNow(60_000);
  const today = localDateOf(now.toISOString(), salon.data?.timezone ?? timeZone);
  const thisWeek = shiftWeekStart(today);
  const week = selectedWeek ?? thisWeek;
  const previous = teamShiftWeekStartSchema.safeParse(shiftDate(week, -7));
  const next = teamShiftWeekStartSchema.safeParse(shiftDate(week, 7));
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(week, index));
  const live = useCalendarLive();
  const schedule = useQuery({
    queryKey: [...teamShiftWeekKey, week],
    queryFn: ({ signal }) => api().dateShifts.teamWeek(week, signal),
    refetchInterval: live ? false : CALENDAR_POLL_MS,
  });
  const dayLabel = dateFormatter(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Button
          variant="secondary"
          aria-label={t("shifts.previousWeek")}
          disabled={!previous.success}
          onClick={() => {
            if (previous.success) onWeekChange(previous.data);
          }}
        >
          <ChevronLeftIcon width={18} height={18} />
        </Button>
        <TextField
          label={t("shifts.week")}
          type="date"
          value={week}
          onChange={(event) => {
            const date = localDateSchema.safeParse(event.target.value);
            const selection = date.success
              ? teamShiftWeekStartSchema.safeParse(shiftWeekStart(date.data))
              : undefined;
            if (selection?.success) onWeekChange(selection.data);
          }}
        />
        <Button
          variant="secondary"
          aria-label={t("shifts.nextWeek")}
          disabled={!next.success}
          onClick={() => {
            if (next.success) onWeekChange(next.data);
          }}
        >
          <ChevronRightIcon width={18} height={18} />
        </Button>
        <Button variant="secondary" onClick={() => onWeekChange(thisWeek)}>
          {t("shifts.thisWeek")}
        </Button>
      </div>
      {schedule.isPending ? (
        <Skeleton className="h-64" />
      ) : schedule.isError ? (
        <ErrorState error={schedule.error} onRetry={() => void schedule.refetch()} />
      ) : schedule.data.members.length === 0 ? (
        <p
          role="status"
          className="rounded-xl border border-line bg-surface p-4 text-sm text-muted"
        >
          {t("shifts.noTeam")}
        </p>
      ) : (
        <section
          aria-labelledby={caption}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus this scroll region.
          tabIndex={0}
          className="max-h-[65dvh] overflow-auto rounded-xl border border-line bg-surface focus-visible:outline-2 focus-visible:outline-ring"
        >
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption id={caption} className="sr-only">
              {t("shifts.teamWeek")}
            </caption>
            <thead className="sticky top-0 z-20 bg-sunken">
              <tr>
                <th
                  scope="col"
                  className="sticky start-0 z-10 border-b border-line bg-sunken px-3 py-3 text-start"
                >
                  {t("shifts.professional")}
                </th>
                {days.map((date) => (
                  <th
                    key={date}
                    scope="col"
                    className="whitespace-nowrap border-b border-line px-3 py-3 text-start"
                  >
                    <time
                      dateTime={date}
                      aria-current={date === today ? "date" : undefined}
                      className={date === today ? "text-accent" : undefined}
                    >
                      {dayLabel.format(new Date(`${date}T12:00:00Z`))}
                    </time>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schedule.data.members.map((member) => (
                <tr key={member.id}>
                  <th
                    scope="row"
                    className="sticky start-0 z-10 max-w-36 border-b border-line bg-surface px-2 py-2 align-top text-start"
                  >
                    <Button
                      variant="ghost"
                      className="h-auto min-h-11 max-w-full whitespace-normal text-start"
                      onClick={() => onOpenMember(member.id, week)}
                    >
                      {member.name}
                    </Button>
                  </th>
                  {member.days.map((day) => (
                    <td
                      key={day.date}
                      className="min-w-28 space-y-1 border-b border-s border-line px-3 py-3 align-top"
                    >
                      {day.ranges.length ? (
                        day.ranges.map((range) => (
                          <p
                            key={`${range.startTime}-${range.endTime}`}
                            className="whitespace-nowrap tabular-nums"
                          >
                            {range.startTime}–{range.endTime}
                          </p>
                        ))
                      ) : (
                        <p className="text-muted">{t("shifts.closed")}</p>
                      )}
                      {day.custom && <p className="text-xs text-muted">{t("shifts.custom")}</p>}
                      {day.absences.map((absence) => (
                        <p key={absence.id} className="rounded bg-sunken px-2 py-1 text-xs">
                          {absence.fullDay
                            ? t("shifts.absentAllDay")
                            : t(
                                "shifts.absenceHours",
                                absenceTimes(
                                  absence.startsAt,
                                  absence.endsAt,
                                  schedule.data.timezone,
                                  locale,
                                ),
                              )}
                        </p>
                      ))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </section>
  );
}
