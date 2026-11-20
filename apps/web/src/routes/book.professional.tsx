import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { buttonClasses } from "~/components/ui/button";
import { SelectField } from "~/components/ui/select-field";
import { EmptyState } from "~/components/ui/states";
import { ProfessionalChoice } from "~/features/booking/components";
import { BookingFrame } from "~/features/booking/frame";
import { eligibleStaff } from "~/features/booking/logic";
import {
  canEnterStep,
  parseBookingSearch,
  serializeBookingSearch,
} from "~/features/booking/search";
import { BookingSummary } from "~/features/booking/summary";
import { useBooking } from "~/features/booking/use-booking";
import { canPlanVisit, visitSegments } from "~/features/booking/visit-selection";
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

  const parts = visitSegments(search.services, booking.catalog);
  const multipleAvailable =
    parts.length > 1 && canPlanVisit(search.services, booking.catalog, booking.staff);

  function choose(staff: string) {
    // A different professional means different availability: forget date and slot.
    booking.go(
      "professional",
      {
        services: search.services,
        staff,
        ...(staff === "multiple" ? { professionals: parts.map(() => "any") } : {}),
      },
      { replace: true },
    );
  }

  return (
    <BookingFrame
      teamAccount={booking.teamAccount}
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
          ctaDisabled={!search.staff || (search.staff === "multiple" && !multipleAvailable)}
          onCta={() => booking.go("time", search)}
        />
      }
    >
      {eligible.length === 0 && !multipleAvailable ? (
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
        <fieldset hidden={eligible.length === 0}>
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
                  selected={search.staff === member.id}
                  onSelect={choose}
                />
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {multipleAvailable && (
        <div className="mt-4 space-y-4">
          <ProfessionalChoice
            value="multiple"
            name={t("services.multiple")}
            description={t("services.multipleHelp")}
            selected={search.staff === "multiple"}
            onSelect={choose}
          />
          {search.staff === "multiple" &&
            parts.map((part, index) => (
              <SelectField
                key={part[0]?.id}
                label={part.map((s) => s.name).join(" + ")}
                value={search.professionals?.[index] ?? "any"}
                options={[
                  { value: "any", label: t("booking.professional.any") },
                  ...eligibleStaff(
                    booking.staff,
                    part.map((s) => s.id),
                  ).map((s) => ({ value: s.id, label: s.displayName })),
                ]}
                onChange={(id) => {
                  const professionals = parts.map((_, i) =>
                    i === index ? id : (search.professionals?.[i] ?? "any"),
                  );
                  booking.go(
                    "professional",
                    { services: search.services, staff: "multiple", professionals },
                    { replace: true },
                  );
                }}
              />
            ))}
        </div>
      )}
    </BookingFrame>
  );
}
