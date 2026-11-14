import type { AppointmentStatus } from "@sob/contracts";
import { AlertIcon, CheckIcon, ClockIcon, SlashIcon } from "~/components/ui/icons";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { type StatusIcon, statusAppearance } from "./logic";

const ICONS = {
  clock: ClockIcon,
  check: CheckIcon,
  slash: SlashIcon,
  alert: AlertIcon,
} satisfies Record<StatusIcon, unknown>;

/**
 * Status classes for chips and calendar blocks. Colors come from the contrast-checked tokens;
 * each status also has its own icon, label and border style so color is never the only cue
 * (blue-rose, green, amber and grey stay distinct for the common color-vision deficiencies).
 */
export const STATUS_CLASSES: Record<AppointmentStatus, string> = {
  booked: "border-accent/60 bg-accent-soft text-accent-soft-fg",
  completed: "border-success-fg/50 bg-success-soft text-success-fg",
  no_show: "border-dashed border-warning-fg/70 bg-warning-soft text-warning-fg",
  cancelled: "border-line-strong bg-sunken text-muted line-through decoration-1",
};

export function StatusBadge({
  status,
  className,
}: {
  status: AppointmentStatus;
  className?: string;
}) {
  const { t } = useI18n();
  const look = statusAppearance(status);
  const Icon = ICONS[look.icon];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        STATUS_CLASSES[status],
        status === "cancelled" && "no-underline",
        className,
      )}
    >
      <Icon width={14} height={14} />
      <span className={status === "cancelled" ? "line-through" : undefined}>
        {t(look.labelKey)}
      </span>
    </span>
  );
}
