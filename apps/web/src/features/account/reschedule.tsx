import type { Appointment } from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ClockIcon } from "~/components/ui/icons";
import { EmptyState } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { buildDateStrip } from "~/features/booking/logic";
import { SlotPicker } from "~/features/booking/slot-picker";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatDateLong, formatTime, localDateOf } from "~/lib/format";

const PAGE = 10;

export function RescheduleView({
  appointment,
  staffName,
  salon,
  onDone,
}: {
  appointment: Appointment;
  staffName: string;
  salon: { timezone: string; maxDaysAhead: number };
  onDone: () => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(PAGE);
  const [date, setDate] = useState<string | undefined>();
  const [slot, setSlot] = useState<{ startsAt: string; staffId: string } | undefined>();
  const [taken, setTaken] = useState(false);

  const serviceIds = appointment.services
    .map((service) => service.serviceId)
    .filter((id): id is string => id !== null);
  const reschedulable = serviceIds.length > 0 && serviceIds.length === appointment.services.length;

  const move = useMutation({
    mutationFn: () => {
      if (!slot) throw new Error("no slot");
      return api().appointments.reschedule(
        appointment.id,
        appointment.version,
        slot.startsAt,
        appointment.staffId,
      );
    },
    onSuccess: () => {
      toast.success(t("account.reschedule.success"));
      void queryClient.invalidateQueries({ queryKey: ["appointments"] });
      void queryClient.invalidateQueries({ queryKey: ["availability"] });
      onDone();
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        (error.code === "slot_taken" || error.code === "slot_unavailable")
      ) {
        setTaken(true);
        setSlot(undefined);
        void queryClient.invalidateQueries({ queryKey: ["availability"] });
        return;
      }
      if (error instanceof ApiError && error.code === "version_conflict") {
        void queryClient.invalidateQueries({ queryKey: ["appointments"] });
        toast.error(t("account.reschedule.conflict"));
        return;
      }
      toast.error(t("account.reschedule.failed"));
    },
  });

  if (!reschedulable) {
    return <EmptyState title={t("account.reschedule.unavailable")} />;
  }

  const today = localDateOf(new Date().toISOString(), salon.timezone);
  const dates = buildDateStrip(today, days, salon.maxDaysAhead);
  const currentDate = localDateOf(appointment.startsAt, salon.timezone);

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4">
        <ClockIcon className="mt-0.5 shrink-0 text-muted" />
        <div>
          <p className="text-sm font-medium text-muted">{t("account.reschedule.current")}</p>
          <p className="font-medium">
            {formatDateLong(currentDate, locale)} ·{" "}
            {formatTime(appointment.startsAt, salon.timezone, locale)}
          </p>
          <p className="text-sm text-muted">{staffName}</p>
        </div>
      </div>

      {taken && (
        <p role="alert" className="rounded-lg bg-warning-soft px-4 py-3 text-warning-fg">
          {t("account.reschedule.taken")}
        </p>
      )}

      <SlotPicker
        serviceIds={serviceIds}
        staffId={appointment.staffId}
        dates={dates}
        timeZone={salon.timezone}
        selectedDate={date}
        selectedSlot={slot?.startsAt}
        onMoreDates={
          days < salon.maxDaysAhead + 1 ? () => setDays((count) => count + PAGE) : undefined
        }
        onChange={({ date: nextDate, slot: nextSlot }) => {
          setDate(nextDate);
          setSlot(nextSlot);
          if (nextSlot) setTaken(false);
        }}
      />

      <div className="sticky bottom-0 -mx-4 border-t border-line bg-canvas/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
        <Button
          size="lg"
          fullWidth
          className="sm:w-auto"
          disabled={!slot}
          loading={move.isPending}
          onClick={() => move.mutate()}
        >
          {t("account.reschedule.confirm")}
        </Button>
      </div>
    </div>
  );
}
