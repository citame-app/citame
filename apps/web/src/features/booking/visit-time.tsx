import { localDateSchema } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { TextField } from "~/components/ui/field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatTime, localDateOf } from "~/lib/format";
import { BookingFrame } from "./frame";
import { buildDateStrip } from "./logic";
import { BookingSummary } from "./summary";
import type { BookingContext } from "./use-booking";
import { canPlanVisit, visitSegments } from "./visit-selection";

export function VisitTime({ booking }: { booking: BookingContext }) {
  const { t, locale } = useI18n();
  const { search, selectedServices, totals, salon } = booking;
  const today = localDateOf(new Date().toISOString(), salon.timezone);
  const date = search.date ?? today;
  const parts = visitSegments(search.services, booking.catalog).map((services, i) => ({
    serviceIds: services.map((s) => s.id),
    ...(search.professionals?.[i] && search.professionals[i] !== "any"
      ? { staffId: search.professionals[i] }
      : {}),
  }));
  const query = useQuery({
    queryKey: ["visit-availability", date, parts],
    queryFn: () => api().visits.availability({ date, parts }),
    enabled:
      localDateSchema.safeParse(date).success &&
      canPlanVisit(search.services, booking.catalog, booking.staff),
    refetchInterval: 30000,
  });
  const chosen = query.data?.slots.find(
    (slot) =>
      slot.startsAt === search.slot &&
      slot.parts.length === parts.length &&
      slot.parts.every((p, i) => p.staffId === search.visitStaff?.[i]),
  );
  return (
    <BookingFrame
      teamAccount={booking.teamAccount}
      step="time"
      search={search}
      title={t("booking.time.title")}
      lead={t("booking.time.lead", { timezone: salon.timezone.replaceAll("_", " ") })}
      summary={
        <BookingSummary
          services={selectedServices}
          totals={totals}
          staffName={t("services.multiple")}
          timeZone={salon.timezone}
          slot={chosen ? { startsAt: chosen.startsAt } : undefined}
          ctaLabel={t("booking.cta.continue")}
          ctaDisabled={!chosen || query.isError || query.isFetching}
          onCta={() => {
            if (chosen)
              booking.go("review", {
                ...search,
                date,
                slot: chosen.startsAt,
                slotStaff: chosen.parts[0]?.staffId,
                visitStaff: chosen.parts.map((p) => p.staffId),
              });
          }}
        />
      }
    >
      <div className="space-y-5">
        <TextField
          type="date"
          label={t("services.visitDate")}
          value={date}
          min={today}
          max={buildDateStrip(today, salon.maxDaysAhead + 1, salon.maxDaysAhead).at(-1)}
          onChange={(e) =>
            booking.go(
              "time",
              {
                services: search.services,
                staff: "multiple",
                professionals: search.professionals,
                date: e.target.value,
              },
              { replace: true },
            )
          }
        />
        {query.isPending ? (
          <Skeleton className="h-32" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : !query.data?.slots.length ? (
          <p role="status">{t("services.visitNoTimes")}</p>
        ) : (
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-3 font-medium">{t("services.visitTimes")}</legend>
            {query.data.slots.map((slot) => (
              <label
                key={slot.startsAt}
                className="flex min-h-11 cursor-pointer gap-3 rounded-lg border border-line p-4 has-checked:border-accent has-checked:bg-accent-soft"
              >
                <input
                  type="radio"
                  name="visit-slot"
                  className="mt-1 shrink-0"
                  checked={chosen?.startsAt === slot.startsAt}
                  onChange={() =>
                    booking.go(
                      "time",
                      {
                        ...search,
                        date,
                        slot: slot.startsAt,
                        slotStaff: slot.parts[0]?.staffId,
                        visitStaff: slot.parts.map((p) => p.staffId),
                      },
                      { replace: true },
                    )
                  }
                />
                <span className="min-w-0">
                  <span className="block font-semibold">
                    {formatTime(slot.startsAt, salon.timezone, locale)}–
                    {formatTime(slot.endsAt, salon.timezone, locale)}
                  </span>
                  {slot.parts.map((part) => (
                    <span key={part.serviceIds.join(",")} className="mt-1 block text-sm text-muted">
                      {formatTime(part.startsAt, salon.timezone, locale)} ·{" "}
                      {part.serviceIds
                        .map((id) => booking.catalog.find((s) => s.id === id)?.name)
                        .join(" + ")}{" "}
                      · {booking.staff.find((s) => s.id === part.staffId)?.displayName}
                    </span>
                  ))}
                </span>
              </label>
            ))}
          </fieldset>
        )}
      </div>
    </BookingFrame>
  );
}
