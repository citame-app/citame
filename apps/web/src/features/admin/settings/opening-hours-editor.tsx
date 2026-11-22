import { type DateShiftRange, OPENING_EXCEPTION_LIMIT, type OpeningSchedule } from "@sob/contracts";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { useI18n } from "~/i18n/react";
import { WEEKDAY_ORDER } from "../staff/hours";

const emptyWeek = () => Array.from({ length: 7 }, (): DateShiftRange[] => []);

function useRowKeys(count: number) {
  const [keys, setKeys] = useState(() =>
    Array.from({ length: count }, (_, index) => String(index)),
  );
  return {
    keys,
    append() {
      const id = crypto.randomUUID();
      setKeys((current) => [...current, id]);
    },
    remove(index: number) {
      setKeys((current) => current.filter((_, item) => item !== index));
    },
  };
}

export function OpeningHoursEditor({
  schedule,
  onChange,
  invalid,
}: {
  schedule: OpeningSchedule;
  onChange: (schedule: OpeningSchedule) => void;
  invalid: boolean;
}) {
  const { t } = useI18n();
  const { weekly, exceptions } = schedule;
  const hiddenWeek = useRef<OpeningSchedule["weekly"]>(null);
  const dateKeys = useRowKeys(exceptions.length);
  return (
    <fieldset className="space-y-4 rounded-xl border border-line p-4">
      <legend className="px-1 text-sm font-medium">{t("settings.opening.title")}</legend>
      <p className="text-sm text-muted">{t("settings.opening.help")}</p>
      {invalid && (
        <p role="alert" className="text-sm text-danger-fg">
          {t("settings.opening.invalid")}
        </p>
      )}
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="show-weekly-hours"
          checked={weekly !== null}
          onChange={(event) => {
            if (!event.currentTarget.checked) {
              hiddenWeek.current = weekly;
              onChange({ ...schedule, weekly: null });
            } else onChange({ ...schedule, weekly: hiddenWeek.current ?? emptyWeek() });
          }}
        />
        {t("settings.opening.showWeekly")}
      </label>
      {weekly &&
        WEEKDAY_ORDER.map((day) => (
          <fieldset key={day} className="border-t border-line pt-2">
            <legend className="pr-2 text-sm font-medium">{t(`hours.day.${day}`)}</legend>
            <OpeningRanges
              name={`opening-${day}`}
              ranges={weekly[day] ?? []}
              onChange={(ranges) =>
                onChange({
                  ...schedule,
                  weekly: weekly.map((previous, index) => (index === day ? ranges : previous)),
                })
              }
            />
          </fieldset>
        ))}
      <fieldset className="space-y-3 border-t border-line pt-2">
        <legend className="pr-2 text-sm font-medium">{t("settings.opening.exceptions")}</legend>
        {exceptions.map((exception, index) => (
          <div key={dateKeys.keys[index]} className="space-y-2 rounded-lg border border-line p-3">
            <TextField
              name={`exception-${index}-date`}
              type="date"
              label={t("settings.opening.date")}
              value={exception.date}
              onChange={(event) => {
                const date = event.currentTarget.value;
                onChange({
                  ...schedule,
                  exceptions: exceptions.map((row, item) =>
                    item === index ? { ...row, date } : row,
                  ),
                });
              }}
            />
            <OpeningRanges
              name={`exception-${index}`}
              ranges={exception.ranges}
              onChange={(ranges) =>
                onChange({
                  ...schedule,
                  exceptions: exceptions.map((row, item) =>
                    item === index ? { ...row, ranges } : row,
                  ),
                })
              }
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                dateKeys.remove(index);
                onChange({
                  ...schedule,
                  exceptions: exceptions.filter((_, item) => item !== index),
                });
              }}
            >
              {t("settings.opening.removeDate")}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          disabled={exceptions.length >= OPENING_EXCEPTION_LIMIT}
          onClick={() => {
            dateKeys.append();
            onChange({ ...schedule, exceptions: [...exceptions, { date: "", ranges: [] }] });
          }}
        >
          {t("settings.opening.addDate")}
        </Button>
      </fieldset>
    </fieldset>
  );
}

function OpeningRanges({
  name,
  ranges,
  onChange,
}: {
  name: string;
  ranges: DateShiftRange[];
  onChange: (ranges: DateShiftRange[]) => void;
}) {
  const { t } = useI18n();
  const rangeKeys = useRowKeys(ranges.length);
  return (
    <div className="space-y-2">
      {ranges.length === 0 && <p className="text-sm text-muted">{t("settings.opening.closed")}</p>}
      {ranges.map((range, index) => (
        <div key={rangeKeys.keys[index]} className="flex flex-wrap items-end gap-2">
          {(["startTime", "endTime"] as const).map((key) => (
            <TextField
              key={key}
              className="min-w-0 flex-1"
              type="time"
              name={`${name}-${index}-${key}`}
              label={t(`settings.opening.${key}`)}
              value={range[key]}
              onChange={(event) => {
                const value = event.currentTarget.value;
                onChange(
                  ranges.map((row, item) => (item === index ? { ...row, [key]: value } : row)),
                );
              }}
            />
          ))}
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              rangeKeys.remove(index);
              onChange(ranges.filter((_, item) => item !== index));
            }}
          >
            {t("settings.opening.removeRange")}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        disabled={ranges.length >= 8}
        onClick={() => {
          rangeKeys.append();
          onChange([...ranges, { startTime: "", endTime: "" }]);
        }}
      >
        {t("settings.opening.addRange")}
      </Button>
    </div>
  );
}
