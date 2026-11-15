import type { CalendarAppointment, Slot, UserRole } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextAreaField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { buildDateStrip } from "~/features/booking/logic";
import { SlotPicker } from "~/features/booking/slot-picker";
import { useI18n } from "~/i18n/react";
import { clientDetailQuery } from "~/lib/admin-queries";
import { api } from "~/lib/api/instance";
import { formatDateLong, formatDuration, formatMoney, formatTime, localDateOf } from "~/lib/format";
import { salonQuery } from "~/lib/queries";
import { AppointmentCheckout } from "../commerce/appointment-checkout";
import { describeProblem, type Problem } from "../problems";
import { AppointmentActions } from "./appointment-actions";
import { mergeAppointment } from "./cache";
import { availableActions } from "./logic";
import { StatusBadge } from "./status-badge";

const PAGE = 10;

export function AppointmentDrawer({
  appointment,
  staffName,
  onClose,
  role,
  ownStaffId,
  now,
  onReload,
  readOnly = false,
}: {
  appointment: CalendarAppointment | null;
  staffName: string;
  onClose: () => void;
  role: UserRole;
  ownStaffId: string | null;
  now: Date;
  /** Refetch the calendar so the drawer shows the latest version after a conflict. */
  onReload?: () => void;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Sheet
      open={appointment !== null}
      onOpenChange={(open) => !open && onClose()}
      title={appointment?.clientName ?? t("drawer.title")}
      size="lg"
    >
      {appointment && (
        <DrawerBody
          key={`${appointment.id}`}
          appointment={appointment}
          staffName={staffName}
          role={role}
          ownStaffId={ownStaffId}
          now={now}
          onClose={onClose}
          onReload={onReload}
          readOnly={readOnly}
        />
      )}
    </Sheet>
  );
}

function DrawerBody({
  appointment,
  staffName,
  role,
  ownStaffId,
  now,
  onClose,
  onReload,
  readOnly = false,
}: {
  appointment: CalendarAppointment;
  staffName: string;
  role: UserRole;
  ownStaffId: string | null;
  now: Date;
  onClose: () => void;
  onReload?: () => void;
  readOnly?: boolean;
}) {
  const { t, locale, timeZone } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useQuery({ ...clientDetailQuery(appointment.clientId), enabled: !readOnly });
  const salon = useQuery(salonQuery);
  const [notes, setNotes] = useState(appointment.notes ?? "");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [moving, setMoving] = useState(false);
  const [days, setDays] = useState(PAGE);
  const [date, setDate] = useState<string | undefined>();
  const [slot, setSlot] = useState<Slot | undefined>();
  const [override, setOverride] = useState(false);
  const actions = availableActions(role, appointment, now, ownStaffId, !readOnly);
  const totalCents = appointment.services.reduce((sum, s) => sum + s.priceCents, 0);
  const currency = appointment.services[0]?.currency ?? "ARS";
  const minutes = Math.round(
    (Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) / 60_000,
  );

  // The calendar refetches in the background; a fresh version resets the draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the version marks a fresh server copy
  useEffect(() => setNotes(appointment.notes ?? ""), [appointment.notes, appointment.version]);

  const afterSave = (saved: Parameters<typeof mergeAppointment>[1]) => {
    queryClient.setQueriesData<import("@sob/contracts").CalendarResponse>(
      { queryKey: ["admin", "calendar"] },
      (data) => (data ? mergeAppointment(data, saved) : data),
    );
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
  };

  const saveNotes = useMutation({
    mutationFn: () =>
      api().appointments.update(appointment.id, { version: appointment.version, notes }),
    onSuccess: (saved) => {
      setProblem(null);
      toast.success(t("calendar.toast.notesSaved"));
      afterSave(saved);
    },
    onError: (error) => setProblem(describeProblem(error)),
  });

  const move = useMutation({
    mutationFn: () => {
      if (!slot) throw new Error("no slot");
      return api().appointments.update(appointment.id, {
        version: appointment.version,
        startsAt: slot.startsAt,
        staffId: slot.staffId,
        ...(override ? { override: true } : {}),
      });
    },
    onSuccess: (saved) => {
      setProblem(null);
      toast.success(t("calendar.toast.rescheduled"));
      afterSave(saved);
      void queryClient.invalidateQueries({ queryKey: ["availability"] });
      onClose();
    },
    onError: (error) => {
      const next = describeProblem(error);
      setProblem(next);
      if (next.recovery === "pickAnotherTime") {
        setSlot(undefined);
        void queryClient.invalidateQueries({ queryKey: ["availability"] });
      }
    },
  });

  const serviceIds = appointment.services
    .map((s) => s.serviceId)
    .filter((id): id is string => id !== null);
  const reschedulable = serviceIds.length > 0 && serviceIds.length === appointment.services.length;
  const tz = salon.data?.timezone ?? timeZone;
  const dates = buildDateStrip(
    localDateOf(now.toISOString(), tz),
    days,
    salon.data?.maxDaysAhead ?? 60,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <StatusBadge status={appointment.status} />
      </div>

      {problem && (
        <div
          role="alert"
          className="rounded-lg border border-danger-fg/40 bg-danger-soft p-4 text-danger-fg"
        >
          {problem.recovery === "reload" ? (
            <>
              <p className="font-medium">{t("drawer.conflict.title")}</p>
              <p className="mt-1 text-sm">{t(problem.messageKey)}</p>
              <Button
                variant="secondary"
                className="mt-3"
                onClick={() => {
                  setProblem(null);
                  onReload?.();
                  void queryClient.invalidateQueries({ queryKey: ["admin"] });
                }}
              >
                {t("problem.reload")}
              </Button>
            </>
          ) : (
            <p className="font-medium">{t(problem.messageKey)}</p>
          )}
        </div>
      )}

      <dl className="grid grid-cols-[7.5rem_1fr] gap-x-4 gap-y-3 text-[0.95rem]">
        <dt className="text-muted">{t("drawer.when")}</dt>
        <dd>
          {formatDateLong(localDateOf(appointment.startsAt, timeZone), locale)},{" "}
          {formatTime(appointment.startsAt, timeZone, locale)} -{" "}
          {formatTime(appointment.endsAt, timeZone, locale)}
          <span className="block text-sm text-muted">{formatDuration(minutes, locale)}</span>
        </dd>
        <dt className="text-muted">{t("drawer.staff")}</dt>
        <dd>{staffName}</dd>
        <dt className="text-muted">{t("drawer.services")}</dt>
        <dd>
          <ul className="space-y-0.5">
            {appointment.services.map((s) => (
              <li key={`${s.serviceId}-${s.name}`} className="flex justify-between gap-3">
                <span>{s.name}</span>
                <span className="tabular-nums text-muted">
                  {formatMoney(s.priceCents, s.currency, locale)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 flex justify-between gap-3 border-t border-line pt-1 font-medium">
            <span>{t("drawer.total")}</span>
            <span className="tabular-nums">{formatMoney(totalCents, currency, locale)}</span>
          </p>
        </dd>
      </dl>

      {!readOnly && (
        <section
          aria-labelledby="drawer-client"
          className="rounded-xl border border-line bg-sunken p-4"
        >
          <h3 id="drawer-client" className="mb-2 font-medium">
            {t("drawer.client")}
          </h3>
          {client.isPending ? (
            <Skeleton className="h-16" />
          ) : client.data ? (
            <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">{t("drawer.client.phone")}</dt>
              <dd>{client.data.client.phone ?? "-"}</dd>
              <dt className="text-muted">{t("drawer.client.email")}</dt>
              <dd className="break-all">{client.data.client.email ?? "-"}</dd>
              <dt className="text-muted">{t("drawer.client.notes")}</dt>
              <dd className="whitespace-pre-wrap">{client.data.client.notes ?? "-"}</dd>
            </dl>
          ) : null}
          <Link
            to="/admin/clients/$id"
            params={{ id: appointment.clientId }}
            className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-accent-text hover:underline"
          >
            {t("drawer.client.open")}
          </Link>
        </section>
      )}

      <div className="space-y-3">
        <TextAreaField
          label={t("drawer.notes")}
          value={notes}
          readOnly={readOnly}
          onChange={(e) => setNotes(e.target.value)}
        />
        <Button
          variant="secondary"
          loading={saveNotes.isPending}
          disabled={readOnly || notes === (appointment.notes ?? "")}
          onClick={() => saveNotes.mutate()}
        >
          {t("drawer.notes.save")}
        </Button>
      </div>

      {!readOnly &&
        appointment.status !== "cancelled" &&
        appointment.services.length > 0 &&
        appointment.services.every((service) => service.currency === "EUR") && (
          <AppointmentCheckout appointmentId={appointment.id} mode="admin" role={role} />
        )}
      <AppointmentActions
        readOnly={readOnly}
        appointment={appointment}
        role={role}
        ownStaffId={ownStaffId}
        now={now}
        timeZone={timeZone}
        onChanged={onClose}
      />

      {actions.reschedule && (
        <section aria-labelledby="drawer-move" className="border-t border-line pt-5">
          {!moving ? (
            <Button variant="secondary" onClick={() => setMoving(true)}>
              {t("drawer.reschedule.open")}
            </Button>
          ) : !reschedulable ? (
            <p className="text-sm text-muted">{t("drawer.reschedule.unavailable")}</p>
          ) : (
            <div className="space-y-4">
              <div>
                <h3 id="drawer-move" className="text-heading">
                  {t("drawer.reschedule.title")}
                </h3>
                <p className="text-sm text-muted">{t("drawer.reschedule.hint")}</p>
              </div>
              <SlotPicker
                serviceIds={serviceIds}
                staffId={appointment.staffId}
                dates={dates}
                timeZone={tz}
                selectedDate={date}
                selectedSlot={slot?.startsAt}
                onMoreDates={
                  days < (salon.data?.maxDaysAhead ?? 60) + 1
                    ? () => setDays((n) => n + PAGE)
                    : undefined
                }
                onChange={({ date: nextDate, slot: nextSlot }) => {
                  setDate(nextDate);
                  setSlot(nextSlot);
                  if (nextSlot) setProblem(null);
                }}
              />
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-5 accent-[var(--accent)]"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                />
                <span className="font-medium">{t("drawer.reschedule.override")}</span>
              </label>
              <Button disabled={!slot} loading={move.isPending} onClick={() => move.mutate()}>
                {slot
                  ? t("drawer.reschedule.confirm", {
                      when: `${formatDateLong(localDateOf(slot.startsAt, tz), locale)}, ${formatTime(slot.startsAt, tz, locale)}`,
                    })
                  : t("drawer.reschedule.open")}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
