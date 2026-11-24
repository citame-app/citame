import type { AdminStaff, CalendarAppointment, CalendarResponse } from "@sob/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { SelectField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { calendarQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { formatDateLong, formatTime, localDateOf } from "~/lib/format";
import { salonQuery } from "~/lib/queries";
import { useStatusChange } from "../calendar/appointment-actions";
import {
  type CalendarMove,
  calendarWriteKey,
  startCalendarWrite,
  usePendingCalendarWrites,
} from "../calendar/appointment-writes";
import { mergeAppointment } from "../calendar/cache";
import { describeProblem } from "../problems";
import { chunkWindows, eligibleTargets } from "./blocking";

/**
 * Shown when deactivating a calendar is refused (409 has_future_appointments): lists what blocks
 * it and lets the owner move each appointment to a colleague or cancel it, in place.
 */
export function BlockedPanel({
  member,
  allStaff,
  pending,
  onRetry,
  onClose,
}: {
  member: AdminStaff;
  allStaff: AdminStaff[];
  pending: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t, locale, timeZone } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const salon = useQuery(salonQuery);
  const [from] = useState(() => new Date().toISOString());
  const windows = useMemo(
    () => chunkWindows(from, (salon.data?.maxDaysAhead ?? 60) + 1),
    [from, salon.data?.maxDaysAhead],
  );
  const results = useQueries({
    queries: windows.map((w) => ({
      ...calendarQuery({ ...w, staffIds: [member.id] }),
      refetchInterval: false as const,
    })),
  });
  const loading = results.some((r) => r.isPending);
  // An appointment that straddles two windows is returned by both: keep one.
  const unique = new Map(results.flatMap((r) => r.data?.appointments ?? []).map((a) => [a.id, a]));
  const blocking = [...unique.values()]
    .filter(
      (a) => a.staffId === member.id && a.status === "booked" && Date.parse(a.endsAt) > Date.now(),
    )
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  const [targets, setTargets] = useState<Record<string, string>>({});
  const [cancelling, setCancelling] = useState<CalendarAppointment | null>(null);
  const cancel = useStatusChange();
  const pendingWrites = usePendingCalendarWrites();
  const reviewedCancellation =
    cancelling && blocking.some((a) => a.id === cancelling.id && a.version === cancelling.version)
      ? cancelling
      : null;

  const move = useMutation({
    mutationKey: calendarWriteKey,
    mutationFn: ({ appointment, to }: CalendarMove) =>
      api().appointments.update(appointment.id, {
        version: appointment.version,
        staffId: to.staffId,
        override: true,
      }),
    onSuccess: (saved) => {
      queryClient.setQueriesData<CalendarResponse>({ queryKey: ["admin", "calendar"] }, (data) =>
        data ? mergeAppointment(data, saved) : data,
      );
      toast.success(t("blocked.moved"));
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error) => toast.error(t(describeProblem(error).messageKey)),
  });

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("blocked.title", { name: member.displayName })}
      description={t("blocked.body")}
      size="lg"
      footer={
        <div className="flex justify-end">
          <Button disabled={loading || blocking.length > 0} loading={pending} onClick={onRetry}>
            {t("blocked.retry")}
          </Button>
        </div>
      }
    >
      {loading ? (
        <Skeleton className="h-40" />
      ) : blocking.length === 0 ? (
        <p className="rounded-lg bg-success-soft p-4 font-medium text-success-fg">
          {t("blocked.empty")}
        </p>
      ) : (
        <ul className="space-y-3">
          {blocking.map((a) => {
            const options = eligibleTargets(a, allStaff);
            const chosen = targets[a.id] ?? "";
            return (
              <li key={a.id} className="space-y-3 rounded-xl border border-line bg-surface p-4">
                <div>
                  <p className="font-medium">{a.clientName}</p>
                  <p className="text-sm text-muted">
                    {formatDateLong(localDateOf(a.startsAt, timeZone), locale)},{" "}
                    {formatTime(a.startsAt, timeZone, locale)} · {a.serviceNames.join(", ")}
                  </p>
                </div>
                {options.length === 0 ? (
                  <p className="text-sm text-muted">{t("blocked.reassign.none")}</p>
                ) : (
                  <div className="flex flex-wrap items-end gap-2">
                    <SelectField
                      className="min-w-48 flex-1"
                      label={t("blocked.reassign")}
                      value={chosen}
                      options={[
                        { value: "", label: "-" },
                        ...options.map((o) => ({ value: o.id, label: o.displayName })),
                      ]}
                      onChange={(value) => setTargets({ ...targets, [a.id]: value })}
                    />
                    <Button
                      variant="secondary"
                      disabled={!chosen || pendingWrites.has(a.id)}
                      loading={move.isPending && move.variables?.appointment.id === a.id}
                      onClick={() =>
                        startCalendarWrite(
                          queryClient,
                          {
                            appointment: a,
                            to: { staffId: chosen, startsAt: a.startsAt },
                            override: true,
                          },
                          move.mutate,
                        )
                      }
                    >
                      {t("blocked.reassign.action")}
                    </Button>
                  </div>
                )}
                <Button
                  variant="secondary"
                  disabled={pendingWrites.has(a.id)}
                  onClick={() => setCancelling(a)}
                >
                  {t("blocked.cancel")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
        destructive
        pending={cancel.isPending}
        confirmDisabled={!reviewedCancellation || pendingWrites.has(reviewedCancellation.id)}
        title={t("calendar.cancel.title")}
        description={
          cancelling
            ? t("calendar.cancel.body", {
                client: cancelling.clientName,
                time: formatTime(cancelling.startsAt, timeZone, locale),
              })
            : ""
        }
        confirmLabel={t("calendar.cancel.confirm")}
        cancelLabel={t("calendar.cancel.keep")}
        onConfirm={() =>
          reviewedCancellation &&
          cancel.mutate(
            { appointment: reviewedCancellation, status: "cancelled" },
            {
              onSettled: () => setCancelling(null),
              onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin"] }),
            },
          )
        }
      >
        {cancelling && !reviewedCancellation && (
          <p role="status" className="mt-3 text-sm text-danger-fg">
            {t("problem.versionConflict")}
          </p>
        )}
      </ConfirmDialog>
    </Sheet>
  );
}
