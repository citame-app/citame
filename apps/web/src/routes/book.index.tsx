import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "~/components/ui/states";
import { CatalogChoices } from "~/features/booking/catalog-choices";
import { toggleCatalogSelection } from "~/features/booking/catalog-selection";
import { BookingFrame } from "~/features/booking/frame";
import { BookingSummary } from "~/features/booking/summary";
import { useBooking } from "~/features/booking/use-booking";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/book/")({ component: ServicesStep });

function ServicesStep() {
  const { t } = useI18n();
  const booking = useBooking();
  const { search, catalog, selectedServices, totals, salon } = booking;

  return (
    <BookingFrame
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
          ctaDisabled={totals.count === 0}
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
        <CatalogChoices
          catalog={catalog}
          selected={search.services}
          onChange={(services) => booking.go("services", { services }, { replace: true })}
        />
      )}
    </BookingFrame>
  );
}
