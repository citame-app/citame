import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { buttonClasses } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";
import { ProfessionalChoice } from "~/features/booking/components";
import { BookingFrame } from "~/features/booking/frame";
import {
  canEnterStep,
  parseBookingSearch,
  serializeBookingSearch,
} from "~/features/booking/search";
import { BookingSummary } from "~/features/booking/summary";
import { useBooking } from "~/features/booking/use-booking";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/book/professional")({
  beforeLoad: ({ search }) => {
    const parsed = parseBookingSearch(search);
    if (!canEnterStep(parsed, "professional")) {
      throw redirect({ to: "/book", search: serializeBookingSearch(parsed), replace: true });
    }
  },
  component: ProfessionalStep,
});

function ProfessionalStep() {
  const { t } = useI18n();
  const booking = useBooking();
  const { search, selectedServices, totals, salon, eligible } = booking;

  function choose(staff: string) {
    // A different professional means different availability: forget date and slot.
    booking.go("professional", { services: search.services, staff }, { replace: true });
  }

  return (
    <BookingFrame
      step="professional"
      search={search}
      title={t("booking.professional.title")}
      lead={t("booking.professional.lead")}
      summary={
        <BookingSummary
          services={selectedServices}
          totals={totals}
          staffName={booking.staffName}
          timeZone={salon.timezone}
          ctaLabel={t("booking.cta.continue")}
          ctaDisabled={!search.staff}
          onCta={() => booking.go("time", search)}
        />
      }
    >
      {eligible.length === 0 ? (
        <EmptyState
          title={t("booking.professional.none.title")}
          description={t("booking.professional.none.body")}
        >
          <Link
            to="/book"
            search={serializeBookingSearch(search)}
            className={buttonClasses({ variant: "secondary" })}
          >
            {t("booking.professional.none.back")}
          </Link>
        </EmptyState>
      ) : (
        <fieldset>
          <legend className="sr-only">{t("booking.professional.title")}</legend>
          <ul className="space-y-3">
            <li>
              <ProfessionalChoice
                value="any"
                name={t("booking.professional.any")}
                description={t("booking.professional.anyDesc")}
                selected={search.staff === "any"}
                onSelect={choose}
              />
            </li>
            {eligible.map((member) => (
              <li key={member.id}>
                <ProfessionalChoice
                  value={member.id}
                  name={member.displayName}
                  portraitUrl={
                    member.portraitVersion
                      ? `/api/staff/${member.id}/portrait/${member.portraitVersion}`
                      : undefined
                  }
                  selected={search.staff === member.id}
                  onSelect={choose}
                />
              </li>
            ))}
          </ul>
        </fieldset>
      )}
    </BookingFrame>
  );
}
