import type { Appointment } from "@sob/contracts";
import { Badge, statusTone } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ClockIcon, UserIcon } from "~/components/ui/icons";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { formatDateLong, formatMoney, formatTime, localDateOf } from "~/lib/format";

export interface AppointmentCardProps {
  appointment: Appointment;
  staffName: string;
  timeZone: string;
  past?: boolean;
  highlighted?: boolean;
  /** An optimistic update is in flight: actions are disabled. */
  pending?: boolean;
  onCancel?: (appointment: Appointment) => void;
  onReschedule?: (appointment: Appointment) => void;
}

export function AppointmentCard({
  appointment,
  staffName,
  timeZone,
  past = false,
  highlighted = false,
  pending = false,
  onCancel,
  onReschedule,
}: AppointmentCardProps) {
  const { t, locale } = useI18n();
  const total = appointment.services.reduce((sum, s) => sum + s.priceCents, 0);
  const currency = appointment.services[0]?.currency;
  const actionable = appointment.status === "booked" && !past;
  const statusLabel =
    appointment.status === "booked" && past ? t("status.past") : t(`status.${appointment.status}`);

  return (
    <article
      aria-label={formatDateLong(localDateOf(appointment.startsAt, timeZone), locale)}
      className={cn(
        "rounded-xl border bg-surface p-5 shadow-sm transition-colors",
        highlighted ? "border-accent ring-2 ring-accent/30" : "border-line",
        appointment.status === "cancelled" && "opacity-80",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          {highlighted && (
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent-text">
              {t("appointment.justBooked")}
            </p>
          )}
          <h3 className="text-heading">
            {formatDateLong(localDateOf(appointment.startsAt, timeZone), locale)}
          </h3>
          <p className="mt-0.5 flex items-center gap-1.5 text-muted">
            <ClockIcon width={16} height={16} />
            <span className="tabular-nums">
              {formatTime(appointment.startsAt, timeZone, locale)} –{" "}
              {formatTime(appointment.endsAt, timeZone, locale)}
            </span>
          </p>
        </div>
        <Badge tone={statusTone(appointment.status)}>{statusLabel}</Badge>
      </div>

      <ul className="mt-4 space-y-1">
        {appointment.services.map((service, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: a static list; a service can repeat
            key={`${service.serviceId ?? service.name}-${index}`}
            className="flex justify-between gap-3"
          >
            <span>{service.name}</span>
            <span className="text-muted">
              {formatMoney(service.priceCents, service.currency, locale)}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[0.95rem]">
        <span className="flex items-center gap-1.5 text-muted">
          <UserIcon width={16} height={16} />
          <span className="sr-only">{t("booking.summary.professional")}</span>
          <span className="text-fg">{staffName}</span>
        </span>
        {currency && (
          <span className="font-display text-lg font-semibold">
            {formatMoney(total, currency, locale)}
          </span>
        )}
      </div>

      {actionable && (onCancel || onReschedule) && (
        <div className="mt-4 flex flex-wrap gap-3">
          {onReschedule && (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => onReschedule(appointment)}
            >
              {t("appointment.reschedule")}
            </Button>
          )}
          {onCancel && (
            <Button variant="ghost" disabled={pending} onClick={() => onCancel(appointment)}>
              {t("appointment.cancel")}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
