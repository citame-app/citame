import {
  type DateShiftInput,
  type DateShiftPreview,
  type DateShiftRange,
  dateShiftInputSchema,
  dateShiftRangesSchema,
  localDateSchema,
  shiftDate,
  shiftWeekStart,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { teamShiftWeekKey } from "~/lib/admin-queries";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatDateLong, localDateOf } from "~/lib/format";
import { UnsavedGuard } from "../unsaved-guard";
import { ConflictList } from "./conflict-list";

type Review = { input: DateShiftInput; data: DateShiftPreview; key: string; stale: boolean };
export function DateShiftEditor({
  staffId,
  editable,
  now,
  initialWeek,
}: {
  staffId: string;
  editable: boolean;
  now?: Date;
  initialWeek?: string;
}) {
  const { t, locale, timeZone } = useI18n();
  const today = localDateOf((now ?? new Date()).toISOString(), timeZone);
  const online = useOnline();
  const toast = useToast();
  const queries = useQueryClient();
  const [week, setWeek] = useState(() =>
    shiftWeekStart(initialWeek ?? localDateOf((now ?? new Date()).toISOString(), timeZone)),
  );
  const validWeek = localDateSchema.safeParse(week).success;
  const query = useQuery({
    queryKey: ["date-shifts", staffId, week],
    queryFn: () => api().dateShifts.get(staffId, week, shiftDate(week, 6)),
    enabled: validWeek,
  });
  const [patch, setPatch] = useState<Record<string, DateShiftRange[] | null>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [copy, setCopy] = useState(false);
  const [source, setSource] = useState(week);
  const [days, setDays] = useState("7");
  const [target, setTarget] = useState(() => shiftDate(week, 7));
  const [weeks, setWeeks] = useState("1");
  const [invalid, setInvalid] = useState(false);
  const [discard, setDiscard] = useState<null | (() => void)>(null);
  const keys = useRef(new Map<string, string>());
  const dirty = Object.keys(patch).length > 0;
  const selection: DateShiftInput = {
    mode: "edit",
    changes: Object.entries(patch)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, ranges]) => ({ date, ranges })),
  };
  const preview = useMutation({
    mutationFn: async (input: DateShiftInput) => {
      const parsed = dateShiftInputSchema.parse(input);
      const signature = JSON.stringify(parsed);
      let key = keys.current.get(signature);
      if (!key) {
        key = crypto.randomUUID();
        keys.current.set(signature, key);
      }
      return {
        input: parsed,
        data: await api().dateShifts.preview(staffId, parsed),
        key,
        stale: false,
      };
    },
    onSuccess: (value) => {
      setCopy(false);
      setReview(value);
    },
  });
  const apply = useMutation({
    mutationFn: () => {
      if (!review || review.stale) throw new Error("Review the current schedule before applying");
      return api().dateShifts.apply(staffId, {
        selection: review.input,
        reviewHash: review.data.reviewHash,
        idempotencyKey: review.key,
      });
    },
    onSuccess: () => {
      setPatch({});
      setReview(null);
      keys.current.clear();
      toast.success(t("shifts.saved"));
      void queries.invalidateQueries({ queryKey: ["date-shifts", staffId] });
      void queries.invalidateQueries({ queryKey: teamShiftWeekKey });
      void queries.invalidateQueries({ queryKey: ["admin", "working-hours", staffId] });
      void queries.invalidateQueries({ queryKey: ["admin", "calendar"] });
      void queries.invalidateQueries({ queryKey: ["availability"] });
    },
    onError: (error) => {
      if (error instanceof ApiError && ["version_conflict", "invalid_state"].includes(error.code))
        setReview((value) => (value ? { ...value, stale: true } : null));
    },
  });
  const busy = preview.isPending || apply.isPending;
  const navigate = (next: string) => {
    const action = () => {
      setPatch({});
      setWeek(next);
      setReview(null);
      preview.reset();
      apply.reset();
      keys.current.clear();
    };
    if (dirty) setDiscard(() => action);
    else action();
  };
  const reload = () => {
    const action = () => {
      setPatch({});
      setReview(null);
      keys.current.clear();
      preview.reset();
      apply.reset();
      void query.refetch();
    };
    if (dirty) setDiscard(() => action);
    else action();
  };
  const setDay = (date: string, ranges: DateShiftRange[] | null) => {
    setPatch((previous) => ({ ...previous, [date]: ranges }));
    setInvalid(false);
  };
  const validateAndPreview = (input: unknown) => {
    const parsed = dateShiftInputSchema.safeParse(input);
    setInvalid(!parsed.success);
    if (parsed.success) {
      apply.reset();
      preview.mutate(parsed.data);
    }
  };
  const rangeText = (ranges: DateShiftRange[]) =>
    ranges.length
      ? ranges.map((range) => `${range.startTime}–${range.endTime}`).join(", ")
      : t("shifts.closed");
  const failure = (error: unknown) =>
    error instanceof ApiError && error.code === "validation_error" ? (
      <p role="alert" className="text-danger-fg">
        {t("shifts.invalid")}
      </p>
    ) : error instanceof ApiError && error.code === "version_conflict" ? (
      <p role="alert" className="text-danger-fg">
        {t("shifts.stale")}
      </p>
    ) : error instanceof ApiError && error.code === "invalid_state" ? (
      <p role="alert" className="text-danger-fg">
        {t("shifts.intentConflict")}
      </p>
    ) : (
      <ErrorState error={error} />
    );
  return (
    <section aria-label={t("shifts.title")} className="space-y-5">
      <UnsavedGuard dirty={dirty || apply.isPending} />
      <div>
        <h3 className="text-heading">{t("shifts.title")}</h3>
        <p className="text-muted">{t("shifts.lead")}</p>
        <p className="mt-1 text-sm text-muted">
          {t("shifts.timezone", { timezone: query.data?.timezone ?? timeZone })}
        </p>
        {!editable && <p className="mt-2 text-sm font-medium">{t("shifts.readOnly")}</p>}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Button
          variant="secondary"
          disabled={busy || !validWeek}
          onClick={() => navigate(shiftDate(week, -7))}
        >
          {t("shifts.previousWeek")}
        </Button>
        <TextField
          label={t("shifts.week")}
          type="date"
          value={week}
          disabled={busy}
          onChange={(event) => navigate(event.target.value)}
        />
        <Button
          variant="secondary"
          disabled={busy || !validWeek}
          onClick={() => navigate(shiftDate(week, 7))}
        >
          {t("shifts.nextWeek")}
        </Button>
      </div>
      {query.isPending && validWeek && !query.data && <Skeleton className="h-48" />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data && (
        <>
          <ConflictList conflicts={query.data.conflicts} />
          <div className="space-y-3">
            {query.data.days.map((day) => {
              const ranges = Object.hasOwn(patch, day.date)
                ? (patch[day.date] ?? null)
                : day.ranges;
              const mode = ranges === null ? "weekly" : ranges.length ? "custom" : "closed";
              const valid = ranges === null || dateShiftRangesSchema.safeParse(ranges).success;
              return (
                <fieldset
                  key={day.date}
                  disabled={!editable || busy || day.date < today}
                  className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-4"
                >
                  <legend className="px-1 font-medium">{formatDateLong(day.date, locale)}</legend>
                  <SelectField
                    label={t("shifts.mode")}
                    value={mode}
                    options={[
                      { value: "weekly", label: t("shifts.weekly") },
                      { value: "custom", label: t("shifts.custom") },
                      { value: "closed", label: t("shifts.closed") },
                    ]}
                    onChange={(value) =>
                      setDay(
                        day.date,
                        value === "weekly"
                          ? null
                          : value === "closed"
                            ? []
                            : day.effectiveRanges.length
                              ? [...day.effectiveRanges]
                              : [{ startTime: "09:00", endTime: "18:00" }],
                      )
                    }
                  />
                  {ranges === null ? (
                    <p className="text-sm text-muted">
                      {t("shifts.inherited")} · {rangeText(day.effectiveRanges)}
                    </p>
                  ) : ranges.length === 0 ? (
                    <p className="text-sm text-muted">{t("shifts.closed")}</p>
                  ) : (
                    <div className="space-y-3">
                      {ranges.map((range, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: controlled positional ranges have no independent child state
                        <div key={index}>
                          <div className="flex flex-wrap items-end gap-3">
                            <TextField
                              type="time"
                              step={300}
                              label={t("shifts.start", { number: index + 1 })}
                              value={range.startTime}
                              onChange={(event) =>
                                setDay(
                                  day.date,
                                  ranges.map((item, i) =>
                                    i === index ? { ...item, startTime: event.target.value } : item,
                                  ),
                                )
                              }
                            />
                            <TextField
                              type="time"
                              step={300}
                              label={t("shifts.end", { number: index + 1 })}
                              value={range.endTime}
                              onChange={(event) =>
                                setDay(
                                  day.date,
                                  ranges.map((item, i) =>
                                    i === index ? { ...item, endTime: event.target.value } : item,
                                  ),
                                )
                              }
                            />
                            <Button
                              variant="ghost"
                              onClick={() =>
                                setDay(
                                  day.date,
                                  ranges.filter((_, i) => i !== index),
                                )
                              }
                            >
                              {t("shifts.removeRange", { number: index + 1 })}
                            </Button>
                          </div>
                        </div>
                      ))}
                      {editable && (
                        <Button
                          variant="secondary"
                          disabled={ranges.length >= 8}
                          onClick={() =>
                            setDay(day.date, [
                              ...ranges,
                              { startTime: ranges.at(-1)?.endTime ?? "09:00", endTime: "18:00" },
                            ])
                          }
                        >
                          {t("shifts.addRange")}
                        </Button>
                      )}
                    </div>
                  )}
                  {!valid && (
                    <p role="alert" className="text-sm text-danger-fg">
                      {t("shifts.invalid")}
                    </p>
                  )}
                </fieldset>
              );
            })}
          </div>
          {editable && (
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={
                  !online || !dirty || busy || !dateShiftInputSchema.safeParse(selection).success
                }
                loading={preview.isPending}
                onClick={() => validateAndPreview(selection)}
              >
                {t("shifts.review")}
              </Button>
              <Button
                variant="secondary"
                disabled={!online || dirty || busy || !validWeek}
                onClick={() => {
                  setSource(week);
                  setTarget(shiftDate(week, 7));
                  setCopy(true);
                  setInvalid(false);
                }}
              >
                {t("shifts.copy")}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={reload}>
                {t("shifts.reload")}
              </Button>
            </div>
          )}
        </>
      )}
      {invalid && (
        <p role="alert" className="text-danger-fg">
          {t("shifts.invalid")}
        </p>
      )}
      {preview.isError && !review && !copy && failure(preview.error)}
      <Sheet
        open={copy}
        onOpenChange={(open) => {
          if (!busy) setCopy(open);
        }}
        title={t("shifts.copy")}
        description={t("shifts.copyHelp")}
        footer={
          <Button
            loading={preview.isPending}
            disabled={!online || busy}
            onClick={() => {
              const count = Number(weeks);
              validateAndPreview({
                mode: "copy",
                sourceFrom: source,
                days: Number(days),
                targetStarts:
                  localDateSchema.safeParse(target).success &&
                  Number.isInteger(count) &&
                  count >= 1 &&
                  count <= 12
                    ? Array.from({ length: count }, (_, index) => shiftDate(target, index * 7))
                    : [],
              });
            }}
          >
            {t("shifts.copyReview")}
          </Button>
        }
      >
        <fieldset disabled={busy} className="space-y-4">
          <TextField
            label={t("shifts.source")}
            type="date"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          <TextField
            label={t("shifts.days")}
            type="number"
            min={1}
            max={7}
            step={1}
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
          <TextField
            label={t("shifts.target")}
            type="date"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
          <TextField
            label={t("shifts.weeks")}
            type="number"
            min={1}
            max={12}
            step={1}
            value={weeks}
            onChange={(event) => setWeeks(event.target.value)}
          />
          {invalid && (
            <p role="alert" className="text-danger-fg">
              {t("shifts.invalid")}
            </p>
          )}
          {preview.isError && failure(preview.error)}
        </fieldset>
      </Sheet>
      <Sheet
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(null);
        }}
        title={t("shifts.reviewTitle")}
        description={t("shifts.reviewHelp")}
        footer={
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              disabled={busy || !online}
              onClick={() => {
                if (review) {
                  apply.reset();
                  preview.mutate(review.input);
                }
              }}
            >
              {t("shifts.refresh")}
            </Button>
            <Button
              loading={apply.isPending}
              disabled={busy || !online || review?.stale}
              onClick={() => apply.mutate()}
            >
              {t("shifts.apply")}
            </Button>
          </div>
        }
      >
        {review && (
          <div className="space-y-4">
            <ConflictList conflicts={review.data.conflicts} />
            {review.data.withdrawnOffers > 0 && (
              <p className="rounded-lg border border-line bg-sunken p-3 text-sm">
                {t("shifts.offers", { count: review.data.withdrawnOffers })}
              </p>
            )}
            <ol className="space-y-3">
              {review.data.changes.map((change) => (
                <li key={change.date} className="space-y-2 rounded-lg border border-line p-3">
                  <p className="font-semibold">
                    {formatDateLong(change.date, locale)} · {change.date}
                  </p>
                  <p className="text-sm">
                    <span className="font-medium">{t("shifts.before")}:</span>{" "}
                    {rangeText(change.previous.effectiveRanges)}
                    {change.previous.ranges === null ? ` · ${t("shifts.inherited")}` : ""}
                  </p>
                  <p className="text-sm">
                    <span className="font-medium">{t("shifts.after")}:</span>{" "}
                    {rangeText(change.next.effectiveRanges)}
                    {change.next.ranges === null ? ` · ${t("shifts.inherited")}` : ""}
                  </p>
                  {change.previous.version === change.next.version && (
                    <p className="text-sm text-muted">{t("shifts.noChange")}</p>
                  )}
                </li>
              ))}
            </ol>
            {apply.isError && failure(apply.error)}
            {preview.isError && failure(preview.error)}
          </div>
        )}
      </Sheet>
      <ConfirmDialog
        open={Boolean(discard)}
        onOpenChange={(open) => {
          if (!open) setDiscard(null);
        }}
        title={t("shifts.discard")}
        description={t("admin.unsaved.body")}
        confirmLabel={t("shifts.discard")}
        cancelLabel={t("admin.cancel")}
        destructive
        onConfirm={() => {
          discard?.();
          setDiscard(null);
        }}
      />
    </section>
  );
}
