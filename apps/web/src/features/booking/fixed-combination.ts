import type { PeakPriceQuote, Service, ServiceCombination } from "@sob/contracts";
import { normalizeCatalogSelection } from "./catalog-selection";

export function fixedCombinationServices(combination: ServiceCombination, catalog: Service[]) {
  const terms = combination.fixedTerms;
  if (!combination.active || !combination.bookable || !terms) return;
  const ids = normalizeCatalogSelection(combination.serviceIds, catalog);
  if (
    ids.length !== combination.serviceIds.length ||
    ids.length !== terms.pricesCents.length ||
    ids.some((id, index) => id !== combination.serviceIds[index])
  )
    return;
  const byId = new Map(catalog.map((service) => [service.id, service]));
  const services: Service[] = [];
  for (const [index, id] of ids.entries()) {
    const service = byId.get(id);
    const priceCents = terms.pricesCents[index];
    if (service?.currency !== "EUR" || priceCents === undefined) return;
    services.push({ ...service, priceType: "fixed", priceCents });
  }
  return services;
}

export function matchesFixedCombinationQuote(
  combination: ServiceCombination | undefined,
  services: Service[],
  quote: PeakPriceQuote | undefined,
) {
  return Boolean(
    combination &&
      quote?.combination &&
      quote.combination.id === combination.id &&
      quote.combination.version === combination.version &&
      quote.services.length === services.length &&
      quote.services.every(
        (line, index) =>
          line.serviceId === services[index]?.id && line.priceCents === services[index]?.priceCents,
      ),
  );
}
