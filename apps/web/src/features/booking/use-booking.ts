import type { Service, ServiceCombination, Staff } from "@sob/contracts";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext, useSearch } from "@tanstack/react-router";
import { useI18n } from "~/i18n/react";
import { publicCombinationsQuery, salonQuery, servicesQuery, staffQuery } from "~/lib/queries";
import { normalizeCatalogSelection } from "./catalog-selection";
import { fixedCombinationServices } from "./fixed-combination";
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
  combination?: ServiceCombination;
  combinationUnavailable: boolean;
  combinationLoad?: { error: unknown; retry: () => void };
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

  const combinations = useQuery({
    ...publicCombinationsQuery,
    enabled: Boolean(search.combinationId),
  });
  const row = combinations.data?.combinations.find((item) => item.id === search.combinationId);
  const fixed =
    row &&
    row.serviceIds.length === search.services.length &&
    row.serviceIds.every((id, index) => id === search.services[index])
      ? fixedCombinationServices(row, catalog)
      : undefined;
  const combination = fixed ? row : undefined;
  const serviceIds = search.combinationId
    ? (fixed?.map(({ id }) => id) ?? [])
    : normalizeCatalogSelection(search.services, catalog);
  const selectedServices =
    fixed ??
    serviceIds
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
    combination,
    combinationUnavailable: Boolean(search.combinationId && !combination && combinations.isSuccess),
    combinationLoad:
      search.combinationId && combinations.isError
        ? { error: combinations.error, retry: () => void combinations.refetch() }
        : undefined,
    search: { ...search, services: selectedServices.map((s) => s.id) },
    catalog,
    staff,
    selectedServices,
    totals: bookingTotals(selectedServices, serviceIds),
    eligible:
      new Set(selectedServices.map((s) => s.currency)).size > 1
        ? []
        : combination?.fixedTerms
          ? staff.filter(({ id }) => combination.fixedTerms?.staffIds.includes(id))
          : serviceIds.length
            ? eligibleStaff(staff, serviceIds)
            : [],
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
