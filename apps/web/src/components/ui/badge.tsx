import type { AppointmentStatus } from "@sob/contracts";
import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-sunken text-muted",
  accent: "bg-accent-soft text-accent-soft-fg",
  success: "bg-success-soft text-success-fg",
  warning: "bg-warning-soft text-warning-fg",
  danger: "bg-danger-soft text-danger-fg",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function statusTone(status: AppointmentStatus): BadgeTone {
  switch (status) {
    case "booked":
      return "accent";
    case "completed":
      return "success";
    case "no_show":
      return "danger";
    case "cancelled":
      return "neutral";
  }
}
