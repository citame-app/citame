import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "~/components/ui/states";
import { CatalogBrowser } from "~/features/booking/catalog-browser";
import { toggleCatalogSelection } from "~/features/booking/catalog-selection";
import { CombinationChoices } from "~/features/booking/combination-choices";
import { BookingFrame } from "~/features/booking/frame";
import { BookingSummary } from "~/features/booking/summary";
import { useBooking } from "~/features/booking/use-booking";
import { canPlanVisit } from "~/features/booking/visit-selection";
import { useI18n } from "~/i18n/react";
import { publicCombinationsQuery } from "~/lib/queries";

export const Route = createFileRoute("/book/")({
  loader: async ({ context }) => {
    await context.queryClient.prefetchQuery(publicCombinationsQuery);
  },
  component: ServicesStep,
});

function ServicesStep() {
  const { t } = useI18n();
  const booking = useBooking();
  const { search, catalog, selectedServices, totals, salon } = booking;

  return (
    <BookingFrame
      teamAccount={booking.teamAccount}
      step="services"
      search={search}
      title={t("booking.services.title")}
      lead={t("booking.services.lead")}
      summary={
        <BookingSummary
          services={selectedServices}
          totals={totals}
          timeZone={salon.timezone}
          ctaLabel={t("booking.cta.continue")}
          ctaDisabled={
            totals.count === 0 ||
            (booking.eligible.length === 0 &&
              !canPlanVisit(search.services, catalog, booking.staff))
          }
          onCta={() => booking.go("professional", search)}
          onRemoveService={(id) =>
            booking.go(
              "services",
              { services: toggleCatalogSelection(search.services, id, catalog) },
              { replace: true },
            )
          }
        />
      }
    >
      {catalog.length === 0 ? (
        <EmptyState
          title={t("booking.services.empty.title")}
          description={t("booking.services.empty.body")}
        />
      ) : (
        <div className="space-y-6">
          {totals.count > 0 && booking.eligible.length === 0 && (
            <p role="alert" className="rounded-lg border border-line p-4 text-sm">
              {t(
                canPlanVisit(search.services, catalog, booking.staff)
                  ? "services.multipleHelp"
                  : "services.incompatible",
              )}
            </p>
          )}
          <CombinationChoices
            catalog={catalog}
            staff={booking.staff}
            selected={search.services}
            onChange={(services) => booking.go("services", { services }, { replace: true })}
          />
          <CatalogBrowser
            allowMultipleProfessionals
            catalog={catalog}
            staff={booking.staff}
            selected={search.services}
            onChange={(services) => booking.go("services", { services }, { replace: true })}
          />
        </div>
      )}
    </BookingFrame>
  );
}
