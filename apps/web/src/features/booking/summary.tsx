import type { Service } from "@sob/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { CalendarIcon, ChevronUpIcon, ClockIcon, CloseIcon, UserIcon } from "~/components/ui/icons";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { formatDateLong, formatDuration, formatTime, localDateOf } from "~/lib/format";
import type { BookingTotals } from "./logic";
import { priceLabel, totalPriceLabel } from "./service-price";

export interface BookingSummaryProps {
  services: Service[];
  totals: BookingTotals;
  staffName?: string;
  slot?: { startsAt: string };
  timeZone: string;
  ctaLabel: string;
  onCta: () => void;
  ctaDisabled?: boolean;
  ctaLoading?: boolean;
  revealHiddenPrices?: boolean;
  onRemoveService?: (serviceId: string) => void;
}

/**
 * The running booking summary. A fixed bottom bar on phones (total and the primary action stay
 * within thumb reach, details expand upwards), a sticky side panel from the `lg` breakpoint.
 */
export function BookingSummary({
  services,
  totals,
  staffName,
  slot,
  timeZone,
  ctaLabel,
  onCta,
  ctaDisabled,
  ctaLoading,
  onRemoveService,
  revealHiddenPrices = false,
}: BookingSummaryProps) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const root = document.documentElement;
    const property = "--booking-summary-height";
    const previous = root.style.getPropertyValue(property);
    const mobile = window.matchMedia("(max-width:1023px)");
    const measure = () =>
      root.style.setProperty(
        property,
        mobile.matches ? `${Math.ceil(element.getBoundingClientRect().height)}px` : "0px",
      );
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    mobile.addEventListener("change", measure);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer?.disconnect();
      mobile.removeEventListener("change", measure);
      window.removeEventListener("resize", measure);
      if (previous) root.style.setProperty(property, previous);
      else root.style.removeProperty(property);
    };
  }, []);
  const total = totals.currency
    ? totalPriceLabel(t, locale, services, totals.priceCents, totals.currency, revealHiddenPrices)
    : null;

  return (
    <aside
      ref={panel}
      aria-label={t("booking.summary.title")}
      className={cn(
        "booking-summary fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface shadow-lg",
        "pb-[env(safe-area-inset-bottom)]",
        "lg:sticky lg:top-24 lg:inset-x-auto lg:bottom-auto lg:rounded-xl lg:border lg:pb-0 lg:shadow-md",
      )}
    >
      <div className="mx-auto max-w-3xl px-4 lg:max-w-none lg:p-6">
        <h2 className="mb-4 hidden text-heading lg:block">{t("booking.summary.title")}</h2>

        <div
          id={detailsId}
          className={cn(
            "max-h-[45dvh] overflow-y-auto pt-4 lg:max-h-none lg:overflow-visible lg:pt-0",
            !expanded && "max-lg:hidden",
          )}
        >
          {services.length === 0 ? (
            <p className="pb-3 text-muted">{t("booking.summary.empty")}</p>
          ) : (
            <ul className="divide-y divide-line">
              {services.map((service) => (
                <li key={service.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="font-medium wrap-anywhere">{service.name}</p>
                    <p className="text-sm text-muted">
                      {formatDuration(service.durationMinutes, locale)}
                    </p>
                    {service.processing && (
                      <p className="text-sm text-muted">
                        {t("timing.included", {
                          duration: formatDuration(service.processing.minutes, locale),
                        })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[0.95rem]">
                      {priceLabel(t, locale, service, revealHiddenPrices)}
                    </span>
                    {onRemoveService && (
                      <button
                        type="button"
                        onClick={() => onRemoveService(service.id)}
                        aria-label={t("booking.summary.remove", { name: service.name })}
                        className="-mr-2 inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-fg"
                      >
                        <CloseIcon width={18} height={18} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {(staffName || slot) && (
            <dl className="mt-3 space-y-2 border-t border-line pt-3 text-[0.95rem]">
              {staffName && (
                <div className="flex items-center gap-2.5">
                  <dt className="text-muted">
                    <UserIcon width={18} height={18} />
                    <span className="sr-only">{t("booking.summary.professional")}</span>
                  </dt>
                  <dd>{staffName}</dd>
                </div>
              )}
              {slot && (
                <div className="flex items-start gap-2.5">
                  <dt className="mt-0.5 text-muted">
                    <CalendarIcon width={18} height={18} />
                    <span className="sr-only">{t("booking.summary.when")}</span>
                  </dt>
                  <dd>
                    {formatDateLong(localDateOf(slot.startsAt, timeZone), locale)}
                    {" · "}
                    {formatTime(slot.startsAt, timeZone, locale)}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </div>

        <div className="flex items-center gap-3 py-3 lg:flex-col lg:items-stretch lg:border-t lg:border-line lg:pt-4 lg:pb-0 lg:mt-3">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((value) => !value)}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left lg:hidden"
          >
            <ChevronUpIcon
              width={18}
              height={18}
              className={cn("shrink-0 transition-transform", expanded && "rotate-180")}
            />
            <span className="min-w-0">
              <span className="block truncate text-xs text-muted">
                {t("booking.summary.details")} ·{" "}
                {t("booking.summary.services", { count: totals.count })}
              </span>
              <span className="block font-display text-lg font-semibold leading-tight">
                {total ?? "—"}
              </span>
            </span>
          </button>

          <div className="hidden lg:block">
            <p className="flex items-center gap-2 text-sm text-muted">
              {t("booking.summary.services", { count: totals.count })}
              {totals.count > 0 && (
                <span className="inline-flex items-center gap-1">
                  <ClockIcon width={16} height={16} />
                  {formatDuration(totals.durationMinutes, locale)}
                </span>
              )}
            </p>
            <p className="mt-1 flex items-baseline justify-between">
              <span className="text-muted">{t("booking.review.total")}</span>
              <span className="font-display text-2xl font-semibold">{total ?? "—"}</span>
            </p>
          </div>

          {/* Duration for the compact bar, readable by assistive tech as well. */}
          <span className="sr-only lg:hidden">
            {formatDuration(totals.durationMinutes, locale)}
          </span>

          <Button
            onClick={onCta}
            disabled={ctaDisabled}
            loading={ctaLoading}
            size="lg"
            className="shrink-0 lg:w-full"
          >
            {ctaLabel}
          </Button>
        </div>
      </div>
    </aside>
  );
}
