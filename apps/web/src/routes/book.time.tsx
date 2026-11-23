import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import { useEffect, useState } from "react";
import { buttonClasses } from "~/components/ui/button";
import { AlertIcon, ClockIcon } from "~/components/ui/icons";
import { BookingFrame } from "~/features/booking/frame";
import { buildDateStrip, timezoneDifference } from "~/features/booking/logic";
import {
  canEnterStep,
  parseBookingSearch,
  serializeBookingSearch,
} from "~/features/booking/search";
import { SlotPicker } from "~/features/booking/slot-picker";
import { bookingActions, bookingStore } from "~/features/booking/store";
import { BookingSummary } from "~/features/booking/summary";
import { useBooking } from "~/features/booking/use-booking";
import { VisitTime } from "~/features/booking/visit-time";
import { useI18n } from "~/i18n/react";
import { localDateOf } from "~/lib/format";
import { availabilityQuery } from "~/lib/queries";

const PAGE = 10;

export const Route = createFileRoute("/book/time")({
  beforeLoad: ({ search }) => {
    const parsed = parseBookingSearch(search);
    if (!canEnterStep(parsed, "time")) {
      throw redirect({
        to: parsed.services.length === 0 ? "/book" : "/book/professional",
        search: serializeBookingSearch(parsed),
        replace: true,
      });
    }
  },
  // Prefetch the visible days on the server so the first paint already shows times.
  loaderDeps: ({ search }) => ({
    services: search.services,
    staff: search.staff,
    combinationId: search.combinationId,
  }),
  loader: async ({ context, deps }) => {
    const parsed = parseBookingSearch(deps);
    if (parsed.services.length === 0) return;
    const today = localDateOf(new Date().toISOString(), context.salon.timezone);
    const dates = buildDateStrip(today, PAGE, context.salon.maxDaysAhead);
    const staffId = parsed.staff === "any" ? undefined : parsed.staff;
    await Promise.all(
      dates.map((date) =>
        context.queryClient
          .ensureQueryData(
            availabilityQuery({
              serviceIds: parsed.services,
              staffId,
              date,
              combinationId: parsed.combinationId,
            }),
          )
          .catch(() => undefined),
      ),
    );
  },
  component: TimeStep,
});

function TimeStep() {
  const booking = useBooking();
  return booking.search.staff === "multiple" ? <VisitTime booking={booking} /> : <SingleTimeStep />;
}

function SingleTimeStep() {
  const { t } = useI18n();
  const { session } = Route.useRouteContext();
  const booking = useBooking();
  const { search, selectedServices, totals, salon } = booking;
  const takenSlot = useStore(bookingStore, (state) => state.takenSlot);
  const [days, setDays] = useState(PAGE);
  const [visitorZone, setVisitorZone] = useState<string | null>(null);
  useEffect(() => {
    setVisitorZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  const today = localDateOf(new Date().toISOString(), salon.timezone);
  const dates = buildDateStrip(today, days, salon.maxDaysAhead);
  const difference = visitorZone
    ? timezoneDifference(visitorZone, salon.timezone, new Date())
    : null;
  const staffId = search.staff === "any" ? undefined : search.staff;

  return (
    <BookingFrame
      teamAccount={booking.teamAccount}
      combinationUnavailable={booking.combinationUnavailable}
      combinationLoad={booking.combinationLoad}
      step="time"
      search={search}
      title={t("booking.time.title")}
      lead={t("booking.time.lead", { timezone: salon.timezone.replaceAll("_", " ") })}
      summary={
        <BookingSummary
          services={selectedServices}
          combinationName={booking.combination?.name}
          totals={totals}
          staffName={booking.staffName}
          slot={search.slot ? { startsAt: search.slot } : undefined}
          timeZone={salon.timezone}
          ctaLabel={t("booking.cta.continue")}
          ctaDisabled={!search.slot || !search.slotStaff || selectedServices.length === 0}
          onCta={() => booking.go("review", search)}
        />
      }
    >
      <div className="space-y-4">
        {takenSlot && (
          <p
            role="alert"
            className="flex items-start gap-2.5 rounded-lg bg-warning-soft px-4 py-3 text-warning-fg"
          >
            <AlertIcon className="mt-0.5 shrink-0" />
            <span>{t("booking.time.taken")}</span>
          </p>
        )}
        <SlotPicker
          serviceIds={search.services}
          combinationId={search.combinationId}
          staffId={staffId}
          dates={dates}
          timeZone={salon.timezone}
          selectedDate={search.date}
          selectedSlot={search.slot}
          onMoreDates={
            days < salon.maxDaysAhead + 1 ? () => setDays((count) => count + PAGE) : undefined
          }
          onSelectionLost={() => {
            if (search.slot) {
              bookingActions.markSlotTaken(search.slot);
              booking.go(
                "time",
                { ...search, slot: undefined, slotStaff: undefined },
                { replace: true },
              );
            }
          }}
          onChange={({ date, slot }) => {
            if (slot) bookingActions.clearSlotTaken();
            booking.go(
              "time",
              slot
                ? { ...search, date, slot: slot.startsAt, slotStaff: slot.staffId }
                : { ...search, date, slot: undefined, slotStaff: undefined },
              { replace: true },
            );
          }}
        />
        {!search.combinationId && (!session || session.user.role === "client") && (
          <Link
            to="/account/waitlist"
            search={{
              services: search.services.join(","),
              staff: search.staff === "any" ? undefined : search.staff,
              date: search.date ?? today,
            }}
            className={`${buttonClasses({ variant: "secondary" })} max-w-full whitespace-normal! text-center`}
          >
            {t("waitlist.join")}
          </Link>
        )}
        {difference && (
          <p className="flex items-start gap-2 text-sm text-muted">
            <ClockIcon width={16} height={16} className="mt-0.5 shrink-0" />
            <span>
              {t("booking.time.tzDifference", {
                zone: difference.visitorTimeZone.replaceAll("_", " "),
                salonZone: salon.timezone.replaceAll("_", " "),
              })}
            </span>
          </p>
        )}
      </div>
    </BookingFrame>
  );
}
