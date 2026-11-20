import type { Service } from "@sob/contracts";
export const serviceFamily = (s: Service) =>
  s.catalog?.kind === "variant" ? s.catalog.parentServiceId : s.id;
export function eligibleAddon(addon: Service, base: Service) {
  return (
    addon.catalog?.kind === "addon" &&
    addon.currency === base.currency &&
    (addon.catalog.allowedServiceIds.includes(base.id) ||
      addon.catalog.allowedServiceIds.includes(serviceFamily(base)))
  );
}
type Segment = { base: Service; extras: Service[] };
export function catalogSegments(ids: string[], catalog: Service[]): Segment[] {
  const result: Segment[] = [];
  const families = new Set<string>();
  const seen = new Set<string>();
  const byId = new Map(catalog.map((s) => [s.id, s]));
  for (const id of ids) {
    const s = byId.get(id);
    if (!s || seen.has(id)) continue;
    seen.add(id);
    if (s.catalog?.kind === "addon") {
      const current = result.at(-1);
      if (current && eligibleAddon(s, current.base)) current.extras.push(s);
      continue;
    }
    const family = serviceFamily(s);
    if (families.has(family)) continue;
    families.add(family);
    result.push({ base: s, extras: [] });
  }
  return result;
}
const flatten = (items: Segment[]) =>
  items.flatMap((s) => [s.base.id, ...s.extras.map((s) => s.id)]);
export function normalizeCatalogSelection(ids: string[], catalog: Service[], max = 24) {
  return flatten(catalogSegments(ids, catalog)).slice(0, max);
}
export function toggleCatalogSelection(
  ids: string[],
  id: string,
  catalog: Service[],
  baseId?: string,
  max = 24,
) {
  const selected = catalogSegments(ids, catalog);
  const original = flatten(selected);
  const row = catalog.find((s) => s.id === id);
  if (!row) return original;
  if (row.catalog?.kind === "addon") {
    const existing = selected.find((s) => s.extras.some((e) => e.id === id));
    if (existing) existing.extras = existing.extras.filter((e) => e.id !== id);
    else {
      const target = selected.find(
        (s) => (!baseId || s.base.id === baseId) && eligibleAddon(row, s.base),
      );
      if (!target) return original;
      target.extras.push(row);
    }
  } else {
    const existing = selected.find((s) => serviceFamily(s.base) === serviceFamily(row));
    if (existing?.base.id === id) selected.splice(selected.indexOf(existing), 1);
    else if (existing) {
      existing.base = row;
      existing.extras = existing.extras.filter((e) => eligibleAddon(e, row));
    } else selected.push({ base: row, extras: [] });
  }
  const next = flatten(selected);
  return next.length <= max ? next : original;
}

export function catalogAddonOwners(ids: string[], catalog: Service[]) {
  return new Map(
    catalogSegments(ids, catalog).flatMap((s) => s.extras.map((e) => [e.id, s.base.id] as const)),
  );
}
