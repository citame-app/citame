import { Popover } from "@base-ui/react/popover";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { PlusIcon, TrashIcon } from "~/components/ui/icons";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { teamShiftWeekKey, workingHoursQuery } from "~/lib/admin-queries";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { cn } from "~/lib/cn";
import { describeProblem } from "../problems";
import { UnsavedGuard } from "../unsaved-guard";
import { ConflictList } from "./conflict-list";
import {
  addRange,
  copyDay,
  fromRanges,
  hoursEqual,
  type TimeRange,
  toRanges,
  validateDay,
  WEEKDAY_ORDER,
  type WeekHours,
  weekIsValid,
} from "./hours";

interface HoursDraft {
  week: WeekHours;
  baseline: WeekHours;
  revision?: string;
}

const timeInput =
  "min-h-11 rounded-md border border-line-strong bg-surface px-3 text-base tabular-nums hover:border-fg/60 focus:border-ring disabled:opacity-60";

export function HoursEditor({ staffId, editable }: { staffId: string; editable: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery(workingHoursQuery(staffId));
  const saved = useMemo(() => (query.data ? fromRanges(query.data.hours) : null), [query.data]);
  const [draft, setDraft] = useState<HoursDraft | null>(null);
  const save = useMutation({
    mutationFn: (next: HoursDraft) =>
      api().admin.staff.setWorkingHours(staffId, {
        hours: toRanges(next.week),
        expectedRevision: next.revision,
      }),
    onSuccess: (result) => {
      toast.success(t("hours.saved"));
      queryClient.setQueryData(workingHoursQuery(staffId).queryKey, result);
      void queryClient.invalidateQueries({ queryKey: teamShiftWeekKey });
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "calendar"] });
      void queryClient.invalidateQueries({ queryKey: ["availability"] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "version_conflict") return;
      toast.error(`${t("hours.saveFailed")}. ${t(describeProblem(error).messageKey)}`);
    },
  });

  if (!saved || !query.data) {
    return query.isError ? (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : (
      <Skeleton className="h-96" />
    );
  }

  const week = draft?.week ?? saved;
  const revision = query.data.revision;
  const stale =
    draft !== null &&
    (draft.revision !== revision ||
      (save.error instanceof ApiError && save.error.code === "version_conflict"));
  const valid = weekIsValid(week);
  const locked = save.isPending || stale;
  const shownConflicts = query.data.conflicts;

  function setWeek(next: WeekHours) {
    if (locked) return;
    const baseline = draft?.baseline ?? saved;
    if (!baseline) return;
    setDraft(
      hoursEqual(next, baseline)
        ? null
        : {
            week: next,
            baseline,
            revision: draft?.revision ?? revision,
          },
    );
  }
  const setDay = (weekday: number, ranges: TimeRange[]) => setWeek({ ...week, [weekday]: ranges });
  const discard = () => {
    save.reset();
    setDraft(null);
  };

  return (
    <div className="space-y-5">
      <UnsavedGuard dirty={draft !== null} />
      <div>
        <h3 className="text-heading">{t("hours.title")}</h3>
        <p className="text-muted">{t("hours.lead")}</p>
        {!editable && <p className="mt-2 text-sm font-medium">{t("hours.readOnly")}</p>}
      </div>

      <ConflictList conflicts={shownConflicts} />

      <div className="space-y-3">
        {WEEKDAY_ORDER.map((weekday) => {
          const day = week[weekday] ?? [];
          const issues = validateDay(day);
          const name = t(`hours.day.${weekday}` as "hours.day.0");
          return (
            <fieldset key={weekday} className="rounded-xl border border-line bg-surface p-4">
              <legend className="px-1 font-medium">{name}</legend>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-x-6">
                <div className="min-w-0 flex-1 space-y-2">
                  {day.length === 0 && (
                    <p className="flex min-h-11 items-center text-muted">{t("hours.closed")}</p>
                  )}
                  {day.map((range, index) => {
                    const issue = issues.find((i) => i.index === index);
                    const n = index + 1;
                    const update = (patch: Partial<TimeRange>) =>
                      setDay(
                        weekday,
                        day.map((r, i) => (i === index ? { ...r, ...patch } : r)),
                      );
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: ranges have no identity of their own
                      <div key={index}>
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="time"
                            step={300}
                            aria-label={t("hours.start", { day: name, n })}
                            value={range.start}
                            disabled={!editable || locked}
                            onChange={(e) => update({ start: e.target.value })}
                            className={cn(timeInput, issue && "border-danger-fg")}
                          />
                          <span aria-hidden="true">-</span>
                          <input
                            type="time"
                            step={300}
                            aria-label={t("hours.end", { day: name, n })}
                            value={range.end}
                            disabled={!editable || locked}
                            onChange={(e) => update({ end: e.target.value })}
                            className={cn(timeInput, issue && "border-danger-fg")}
                          />
                          {editable && (
                            <button
                              type="button"
                              disabled={locked}
                              aria-label={t("hours.removeRange", { day: name, n })}
                              onClick={() =>
                                setDay(
                                  weekday,
                                  day.filter((_, i) => i !== index),
                                )
                              }
                              className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-danger-fg"
                            >
                              <TrashIcon />
                            </button>
                          )}
                        </div>
                        {issue && (
                          <p role="alert" className="mt-1 text-sm font-medium text-danger-fg">
                            {t(
                              issue.kind === "order" ? "hours.error.order" : "hours.error.overlap",
                            )}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                {editable && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      disabled={locked}
                      onClick={() => setDay(weekday, addRange(day))}
                    >
                      <PlusIcon />
                      {t("hours.addRange")}
                    </Button>
                    {day.length > 0 && (
                      <CopyMenu
                        sourceName={name}
                        source={weekday}
                        disabled={locked}
                        onApply={(targets) => setWeek(copyDay(week, weekday, targets))}
                      />
                    )}
                  </div>
                )}
              </div>
            </fieldset>
          );
        })}
      </div>

      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          {stale && (
            <>
              <p role="alert" className="basis-full text-sm text-warning-fg">
                {t("hours.stale")}
              </p>
              <Button
                variant="secondary"
                loading={query.isFetching}
                onClick={() =>
                  void query.refetch().then((result) => {
                    if (result.isSuccess) discard();
                    else toast.error(t("hours.reloadFailed"));
                  })
                }
              >
                {t("hours.discardReload")}
              </Button>
            </>
          )}
          <Button
            loading={save.isPending}
            disabled={!draft || !valid || stale}
            onClick={() => {
              if (draft && !stale && !save.isPending) save.mutate(draft);
            }}
          >
            {t("hours.save")}
          </Button>
          {draft && <span className="text-sm text-warning-fg">{t("admin.unsaved.badge")}</span>}
          {draft && !stale && (
            <Button variant="ghost" disabled={save.isPending} onClick={discard}>
              {t("admin.cancel")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function CopyMenu({
  source,
  sourceName,
  disabled,
  onApply,
}: {
  source: number;
  sourceName: string;
  disabled: boolean;
  onApply: (targets: number[]) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<number[]>([]);
  return (
    <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
      <Popover.Trigger render={<Button variant="secondary" disabled={disabled} />}>
        {t("hours.copy")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" className="z-50">
          <Popover.Popup className="min-w-56 rounded-lg border border-line bg-surface p-2 shadow-lg">
            <fieldset className="m-0 border-0 p-0">
              <legend className="px-2 py-1 text-sm font-medium">
                {t("hours.copy.label", { day: sourceName })}
              </legend>
              {WEEKDAY_ORDER.filter((d) => d !== source).map((d) => (
                <label
                  key={d}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-sunken"
                >
                  <input
                    type="checkbox"
                    className="size-5 accent-[var(--accent)]"
                    checked={targets.includes(d)}
                    onChange={(e) =>
                      setTargets(
                        e.target.checked ? [...targets, d] : targets.filter((x) => x !== d),
                      )
                    }
                  />
                  {t(`hours.day.${d}` as "hours.day.0")}
                </label>
              ))}
            </fieldset>
            <Button
              className="mt-2 w-full"
              disabled={targets.length === 0}
              onClick={() => {
                onApply(targets);
                setTargets([]);
                setOpen(false);
              }}
            >
              {t("hours.copy.apply")}
            </Button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
