import type { Service } from "@sob/contracts";
/** Older catalogs may omit quote identities; current interactive flows submit every reviewed quote. */
export function acceptedServiceQuotes(services: Service[]): Record<string, string> | undefined {
  if (!services.length) return undefined;
  const result: Record<string, string> = {};
  for (const service of services) {
    if (!service.quoteHash) return undefined;
    result[service.id] = service.quoteHash;
  }
  return result;
}
