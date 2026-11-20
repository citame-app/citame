import type { Service, Slot, Staff } from "@sob/contracts";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { CheckIcon, ClockIcon } from "~/components/ui/icons";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import {
  dayOfMonth,
  formatDateLong,
  formatDuration,
  formatTime,
  monthShort,
  weekdayShort,
} from "~/lib/format";
import type { SlotGroup } from "./logic";
import { priceLabel } from "./service-price";

/** A native input stretched over its label: clicks, taps and assistive tech hit the real control. */
const HIDDEN_INPUT =
  "peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed";

const choiceCard =
  "booking-choice relative flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-lg border bg-surface p-4 " +
  "transition-[border-color,background-color,box-shadow] duration-150 " +
  "border-line hover:border-line-strong peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 " +
  "peer-focus-visible:outline-ring peer-checked:border-accent peer-checked:bg-accent-soft " +
  "peer-checked:shadow-sm";

export function ServiceChoice({
  service,
  selected,
  onToggle,
  type = "checkbox",
  group,
  label,
  disabled = false,
  disabledReason,
}: {
  service: Service;
  selected: boolean;
  onToggle: (serviceId: string) => void;
  type?: "checkbox" | "radio";
  group?: string;
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const { locale, t } = useI18n();
  const inputId = useId();
  return (
    <div className="relative">
      <input
        id={inputId}
        type={type}
        name={group}
        disabled={disabled}
        aria-label={label ?? service.name}
        className={HIDDEN_INPUT}
        checked={selected}
        onChange={() => onToggle(service.id)}
        aria-describedby={`${inputId}-meta${disabledReason ? ` ${inputId}-reason` : ""}`}
      />
      <label
        htmlFor={inputId}
        className={cn(choiceCard, disabled && "opacity-65 cursor-not-allowed")}
      >
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border transition-colors",
            selected ? "border-accent bg-accent text-accent-fg" : "border-line-strong bg-surface",
          )}
        >
          {selected && <CheckIcon width={16} height={16} strokeWidth={2.5} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-fg">{label ?? service.name}</span>
          {service.description && (
            <span className="mt-0.5 block text-sm text-muted">{service.description}</span>
          )}
          <span
            id={`${inputId}-meta`}
            className="mt-1.5 flex items-center gap-1.5 text-sm text-muted"
          >
            <ClockIcon width={16} height={16} />
            {service.durationMinutes === 0
              ? t("booking.options.noTime")
              : formatDuration(service.durationMinutes, locale)}
          </span>
          {service.processing && (
            <span className="mt-1 block text-sm text-muted">
              {t("timing.included", {
                duration: formatDuration(service.processing.minutes, locale),
              })}
            </span>
          )}
        </span>
        <span className="max-w-[45%] shrink-0 text-right font-display text-lg font-semibold text-fg wrap-anywhere">
          {priceLabel(t, locale, service)}
        </span>
      </label>
      {disabledReason && (
        <p id={`${inputId}-reason`} className="mt-2 text-sm text-muted">
          {disabledReason}
        </p>
      )}
    </div>
  );
}

export function ProfessionalChoice({
  value,
  name,
  description,
  selected,
  onSelect,
  initial,
  portraitUrl,
}: {
  value: string;
  name: string;
  description?: string;
  selected: boolean;
  onSelect: (value: string) => void;
  initial?: ReactNode;
  portraitUrl?: string;
}) {
  const [unavailable, setUnavailable] = useState<string>();
  return (
    <div className="relative">
      <input
        id={`staff-${value}`}
        type="radio"
        name="professional"
        className={HIDDEN_INPUT}
        checked={selected}
        onChange={() => onSelect(value)}
      />
      <label htmlFor={`staff-${value}`} className={cn(choiceCard, "items-center")}>
        <span
          aria-hidden="true"
          className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-full bg-accent-soft font-display text-lg font-semibold text-accent-soft-fg"
        >
          {portraitUrl && portraitUrl !== unavailable ? (
            <img
              src={portraitUrl}
              alt=""
              width={44}
              height={44}
              className="size-full object-cover"
              onError={() => setUnavailable(portraitUrl)}
            />
          ) : (
            (initial ?? name.slice(0, 1).toUpperCase())
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{name}</span>
          {description && <span className="block text-sm text-muted">{description}</span>}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-full border",
            selected ? "border-accent bg-accent text-accent-fg" : "border-line-strong",
          )}
        >
          {selected && <CheckIcon width={14} height={14} strokeWidth={3} />}
        </span>
      </label>
    </div>
  );
}

export interface StepperStep {
  id: string;
  label: string;
  status: "complete" | "current" | "upcoming";
}

export function Stepper({
  steps,
  label,
  renderStep,
}: {
  steps: StepperStep[];
  label: string;
  /** Lets the caller wrap reachable steps in links. */
  renderStep?: (step: StepperStep, content: ReactNode) => ReactNode;
}) {
  return (
    <nav className="booking-progress" aria-label={label}>
      <ol className="flex items-center gap-2">
        {steps.map((step, index) => {
          const content = (
            <span className="flex min-h-11 items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full border text-sm font-semibold",
                  step.status === "complete" && "border-accent bg-accent text-accent-fg",
                  step.status === "current" && "border-accent bg-accent-soft text-accent-soft-fg",
                  step.status === "upcoming" && "border-line-strong text-muted",
                )}
              >
                {step.status === "complete" ? (
                  <CheckIcon width={14} height={14} strokeWidth={3} />
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={cn(
                  "text-sm font-medium",
                  step.status === "current" ? "text-fg" : "text-muted max-sm:sr-only",
                )}
              >
                {step.label}
              </span>
            </span>
          );
          return (
            <li
              key={step.id}
              aria-current={step.status === "current" ? "step" : undefined}
              className={cn("flex items-center gap-2", index < steps.length - 1 && "flex-none")}
            >
              {renderStep ? renderStep(step, content) : content}
              {index < steps.length - 1 && (
                <span aria-hidden="true" className="h-px w-4 bg-line-strong sm:w-8" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function DateStrip({
  dates,
  selected,
  slotCounts,
  nextAvailable,
  onSelect,
  label,
}: {
  dates: string[];
  selected: string | undefined;
  /** Number of free slots per date; `undefined` while that day is still loading. */
  slotCounts: Record<string, number | undefined>;
  nextAvailable?: string;
  onSelect: (date: string) => void;
  label: string;
}) {
  const { locale, t } = useI18n();
  const selectedRef = useRef<HTMLLabelElement | null>(null);
  useEffect(() => {
    // Keep the chosen day in view when arriving on a deep link.
    selectedRef.current?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, []);

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pt-3 pb-2 snap-x sm:mx-0 sm:px-0"
    >
      {dates.map((date, index) => {
        const count = slotCounts[date];
        const unavailable = count === 0;
        const isSelected = date === selected;
        return (
          <div key={date} className="relative snap-start">
            <input
              id={`date-${date}`}
              type="radio"
              name="date"
              className={HIDDEN_INPUT}
              checked={isSelected}
              disabled={unavailable}
              onChange={() => onSelect(date)}
            />
            <label
              htmlFor={`date-${date}`}
              ref={isSelected ? selectedRef : undefined}
              className={cn(
                "relative flex min-h-[5.25rem] w-[4.5rem] cursor-pointer flex-col items-center justify-center rounded-lg border px-2 py-2 text-center",
                "border-line bg-surface transition-colors hover:border-line-strong",
                "peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
                "peer-checked:border-accent peer-checked:bg-accent peer-checked:text-accent-fg",
                "[&_.sub]:text-muted peer-checked:[&_.sub]:text-accent-fg",
                "peer-disabled:cursor-not-allowed peer-disabled:border-transparent peer-disabled:bg-sunken peer-disabled:text-muted peer-disabled:opacity-70",
              )}
            >
              <span className="sr-only">{formatDateLong(date, locale)}</span>
              <span aria-hidden="true" className="sub text-xs font-medium uppercase tracking-wide">
                {weekdayShort(date, locale)}
              </span>
              <span aria-hidden="true" className="font-display text-2xl font-semibold leading-none">
                {dayOfMonth(date)}
              </span>
              <span aria-hidden="true" className="sub text-xs">
                {monthShort(date, locale)}
              </span>
              {date === nextAvailable && !unavailable && (
                <span
                  className={cn(
                    "absolute -top-2.5 whitespace-nowrap rounded-full border border-accent/40 bg-accent-soft px-2 text-[0.65rem] font-semibold leading-4 text-accent-soft-fg",
                    index === 0
                      ? "left-0"
                      : index === dates.length - 1
                        ? "right-0"
                        : "left-1/2 -translate-x-1/2",
                  )}
                >
                  {t("booking.date.nextAvailable")}
                </span>
              )}
            </label>
          </div>
        );
      })}
    </div>
  );
}

export function TimeSlotGrid({
  groups,
  selected,
  onSelect,
  timeZone,
}: {
  groups: SlotGroup[];
  selected: string | undefined;
  onSelect: (slot: Slot) => void;
  timeZone: string;
}) {
  const { locale, t } = useI18n();
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <fieldset key={group.part} aria-label={t(`booking.part.${group.part}`)}>
          <legend className="mb-2.5 text-sm font-semibold uppercase tracking-wide text-muted">
            {t(`booking.part.${group.part}`)}
          </legend>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
            {group.slots.map((slot) => {
              const id = `slot-${slot.startsAt}`;
              return (
                <div key={slot.startsAt} className="relative">
                  <input
                    id={id}
                    type="radio"
                    name="slot"
                    className={HIDDEN_INPUT}
                    checked={selected === slot.startsAt}
                    onChange={() => onSelect(slot)}
                  />
                  <label
                    htmlFor={id}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-2 py-2.5 text-[0.95rem] font-medium tabular-nums",
                      "border-line-strong bg-surface transition-colors hover:border-accent",
                      "peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
                      "peer-checked:border-accent peer-checked:bg-accent peer-checked:text-accent-fg",
                    )}
                  >
                    {formatTime(slot.startsAt, timeZone, locale)}
                  </label>
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

export type { Staff };
