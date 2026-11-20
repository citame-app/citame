import type { Service, Staff } from "@sob/contracts";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext, useSearch } from "@tanstack/react-router";
import { useI18n } from "~/i18n/react";
import { salonQuery, servicesQuery, staffQuery } from "~/lib/queries";
import { normalizeCatalogSelection } from "./catalog-selection";
import { type BookingTotals, bookingTotals, eligibleStaff } from "./logic";
import {
  type BookingSearch,
  type BookingStep,
  parseBookingSearch,
  serializeBookingSearch,
} from "./search";

export const STEP_PATH = {
  services: "/book",
  professional: "/book/professional",
  time: "/book/time",
  review: "/book/review",
} as const satisfies Record<BookingStep, string>;

export interface BookingContext {
  search: BookingSearch;
  teamAccount: boolean;
  catalog: Service[];
  staff: Staff[];
  selectedServices: Service[];
  totals: BookingTotals;
  eligible: Staff[];
  /** Display name of the professional, resolved for "any" through the chosen slot. */
  staffName: string | undefined;
  salon: { name: string; timezone: string; maxDaysAhead: number; minNoticeMinutes: number };
  go: (step: BookingStep, next: BookingSearch, options?: { replace?: boolean }) => void;
}

/** Everything a booking step needs: the URL selection resolved against the catalog. */
export function useBooking(): BookingContext {
  const { t } = useI18n();
  const { session } = useRouteContext({ from: "/book" });
  const raw = useSearch({ from: "/book" });
  const search = parseBookingSearch(raw);
  const { data: catalog } = useSuspenseQuery(servicesQuery);
  const { data: staff } = useSuspenseQuery(staffQuery);
  const { data: salon } = useSuspenseQuery(salonQuery);
  const navigate = useNavigate();

  const serviceIds = normalizeCatalogSelection(search.services, catalog);
  const selectedServices = serviceIds
    .map((id) => catalog.find((service) => service.id === id))
    .filter((service): service is Service => service !== undefined);
  const resolvedStaffId = search.slotStaff ?? (search.staff !== "any" ? search.staff : undefined);
  const staffName =
    search.staff === "multiple"
      ? t("services.multiple")
      : resolvedStaffId
        ? staff.find((member) => member.id === resolvedStaffId)?.displayName
        : search.staff === "any"
          ? t("booking.professional.any")
          : undefined;

  return {
    teamAccount: Boolean(session && session.user.role !== "client"),
    search: { ...search, services: selectedServices.map((s) => s.id) },
    catalog,
    staff,
    selectedServices,
    totals: bookingTotals(catalog, serviceIds),
    eligible:
      new Set(selectedServices.map((s) => s.currency)).size > 1
        ? []
        : eligibleStaff(staff, serviceIds),
    staffName,
    salon,
    go(step, next, options) {
      void navigate({
        to: STEP_PATH[step],
        search: serializeBookingSearch(next),
        replace: options?.replace,
      });
    },
  };
}
