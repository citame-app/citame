import type { Service, Staff } from "@sob/contracts";
import { catalogSegments, normalizeCatalogSelection } from "./catalog-selection";
import { eligibleStaff } from "./logic";
export const visitSegments = (ids: string[], catalog: Service[]) =>
  catalogSegments(ids, catalog).map((s) => [s.base, ...s.extras]);
export function canPlanVisit(ids: string[], catalog: Service[], staff: Staff[]) {
  if (
    !ids.length ||
    JSON.stringify(normalizeCatalogSelection(ids, catalog)) !== JSON.stringify(ids)
  )
    return false;
  const parts = visitSegments(ids, catalog);
  return (
    parts.length <= 8 &&
    new Set(parts.flat().map((s) => s.currency)).size === 1 &&
    parts.every(
      (part) =>
        eligibleStaff(
          staff,
          part.map((s) => s.id),
        ).length > 0,
    )
  );
}
