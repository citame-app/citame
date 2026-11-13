import type { Slot } from "@sob/contracts";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Button } from "~/components/ui/button";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { formatDateLong } from "~/lib/format";
import { availabilityQuery } from "~/lib/queries";
import { DateStrip, TimeSlotGrid } from "./components";
import { firstAvailableDate, groupSlots } from "./logic";

export interface SlotPickerProps {
  serviceIds: string[];
  /** A specific professional, or undefined for "any available". */
  staffId: string | undefined;
  dates: string[];
  timeZone: string;
  selectedDate: string | undefined;
  selectedSlot: string | undefined;
  onChange: (change: { date: string; slot: Slot | undefined }) => void;
  /** The chosen slot is not offered any more (somebody took it, or hours changed). */
  onSelectionLost?: () => void;
  onMoreDates: (() => void) | undefined;
}

/** Date strip plus grouped time slots, shared by the booking flow and rescheduling. */
export function SlotPicker({
  serviceIds,
  staffId,
  dates,
  timeZone,
  selectedDate,
  selectedSlot,
  onChange,
  onSelectionLost,
  onMoreDates,
}: SlotPickerProps) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const results = useQueries({
    queries: dates.map((date) => availabilityQuery({ serviceIds, staffId, date })),
  });

  const slotCounts: Record<string, number | undefined> = {};
  dates.forEach((date, index) => {
    const data = results[index]?.data;
    slotCounts[date] = data ? new Set(data.slots.map((slot) => slot.startsAt)).size : undefined;
  });

  const nextAvailable = firstAvailableDate(dates, slotCounts);
  const activeDate = selectedDate ?? nextAvailable;
  const activeIndex = activeDate ? dates.indexOf(activeDate) : -1;
  const active = activeIndex >= 0 ? results[activeIndex] : undefined;
  const groups = useMemo(
    () => (active?.data ? groupSlots(active.data.slots, timeZone) : []),
    [active?.data, timeZone],
  );

  const offered = groups.some((group) =>
    group.slots.some((slot) => slot.startsAt === selectedSlot),
  );
  const lost = Boolean(selectedSlot && active?.data && !offered && selectedDate === activeDate);
  useEffect(() => {
    if (lost) onSelectionLost?.();
  }, [lost, onSelectionLost]);

  const stillLoading = !activeDate && results.some((r) => r.isPending);

  return (
    <div className="space-y-6">
      <section aria-labelledby="date-label">
        <h2 id="date-label" className="mb-3 text-heading">
          {t("slots.date")}
        </h2>
        <DateStrip
          label={t("slots.dateLabel")}
          dates={dates}
          selected={activeDate}
          slotCounts={slotCounts}
          nextAvailable={nextAvailable}
          onSelect={(date) => onChange({ date, slot: undefined })}
        />
        {onMoreDates && (
          <Button variant="ghost" className="mt-2" onClick={onMoreDates}>
            {t("slots.moreDates")}
          </Button>
        )}
      </section>

      <section aria-labelledby="time-label">
        <h2 id="time-label" className="mb-3 text-heading">
          {t("slots.time")}
        </h2>
        {stillLoading || active?.isPending ? (
          <div
            role="status"
            aria-label={t("slots.loading")}
            className="grid grid-cols-3 gap-2 sm:grid-cols-4"
          >
            {Array.from({ length: 8 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : active?.isError ? (
          <ErrorState
            error={active.error}
            onRetry={() => {
              void queryClient.invalidateQueries({ queryKey: ["availability"] });
            }}
          />
        ) : !activeDate || groups.length === 0 ? (
          <EmptyState title={t("slots.none.title")} description={t("slots.none.body")}>
            {nextAvailable && nextAvailable !== activeDate && (
              <Button
                variant="secondary"
                onClick={() => onChange({ date: nextAvailable, slot: undefined })}
              >
                {t("slots.jump", { date: formatDateLong(nextAvailable, locale) })}
              </Button>
            )}
          </EmptyState>
        ) : (
          <TimeSlotGrid
            groups={groups}
            selected={offered ? selectedSlot : undefined}
            timeZone={timeZone}
            onSelect={(slot) => onChange({ date: activeDate, slot })}
          />
        )}
      </section>
    </div>
  );
}
