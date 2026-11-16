import type { Service, ServiceCatalog, ServiceCatalogCreate } from "@sob/contracts";
import { type Database, service, serviceAddon } from "@sob/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

type Connection = Pick<Database, "select">;
export type CatalogRow = typeof service.$inferSelect;
export async function catalogMetadata(
  db: Connection,
  rows: CatalogRow[],
): Promise<Map<string, ServiceCatalog>> {
  const result = new Map<string, ServiceCatalog>();
  const addons = rows.filter((r) => r.catalogKind === "addon");
  const links = addons.length
    ? await db
        .select()
        .from(serviceAddon)
        .where(
          inArray(
            serviceAddon.addonId,
            addons.map((r) => r.id),
          ),
        )
        .orderBy(asc(serviceAddon.serviceId))
    : [];
  for (const row of rows) {
    if (row.catalogKind === "variant" && row.parentServiceId && row.optionLabel)
      result.set(row.id, {
        kind: "variant",
        version: row.catalogVersion,
        parentServiceId: row.parentServiceId,
        optionLabel: row.optionLabel,
      });
    if (row.catalogKind === "addon")
      result.set(row.id, {
        kind: "addon",
        version: row.catalogVersion,
        allowedServiceIds: links.filter((l) => l.addonId === row.id).map((l) => l.serviceId),
      });
  }
  return result;
}
export function publicService(row: CatalogRow, catalog?: ServiceCatalog): Service {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    durationMinutes: row.durationMinutes,
    bufferMinutes: row.bufferMinutes,
    priceCents: row.priceCents,
    currency: row.currency,
    ...(catalog ? { catalog } : {}),
  };
}
/** Variant roots must be active ordinary services. Add-ons never depend on other add-ons. */
export async function catalogTargets(tx: Tx, input: ServiceCatalogCreate) {
  const ids = input.kind === "variant" ? [input.parentServiceId] : input.allowedServiceIds;
  const rows = await tx
    .select()
    .from(service)
    .where(and(inArray(service.id, ids), eq(service.active, true), isNull(service.deletedAt)))
    .orderBy(asc(service.id))
    .for("share");
  if (
    rows.length !== ids.length ||
    rows.some((r) =>
      input.kind === "variant" ? r.catalogKind !== "service" : r.catalogKind === "addon",
    )
  )
    throw new DomainError(
      "validation_error",
      "Choose active standalone services or a single ordinary parent for a variant",
    );
  return rows;
}
/** Preserve request order: each extra follows its eligible base; families are mutually exclusive. */
export function assertCatalogSelection(rows: Service[]) {
  const families = new Set<string>();
  let base: Service | undefined;
  for (const row of rows) {
    if (row.catalog?.kind === "addon") {
      const allowed = row.catalog.allowedServiceIds;
      const family = base?.catalog?.kind === "variant" ? base.catalog.parentServiceId : base?.id;
      if (
        !base ||
        !family ||
        (!allowed.includes(base.id) && !allowed.includes(family)) ||
        row.currency !== base.currency
      )
        throw new DomainError(
          "validation_error",
          "This add-on requires an eligible preceding service in the same currency",
        );
      continue;
    }
    const family = row.catalog?.kind === "variant" ? row.catalog.parentServiceId : row.id;
    if (families.has(family))
      throw new DomainError("validation_error", "Choose only one option from each service family");
    families.add(family);
    base = row;
  }
  if (!base)
    throw new DomainError("validation_error", "Choose a standalone service before its add-ons");
}
/** Archived parents hide their variants from new bookings; snapshots remain usable for rescheduling. */
export async function activeCatalogRows(db: Connection, rows: CatalogRow[]) {
  const parentIds = [
    ...new Set(rows.flatMap((r) => (r.parentServiceId ? [r.parentServiceId] : []))),
  ];
  if (!parentIds.length) return rows;
  const parents = await db
    .select({ id: service.id })
    .from(service)
    .where(
      and(inArray(service.id, parentIds), eq(service.active, true), isNull(service.deletedAt)),
    );
  const active = new Set(parents.map((r) => r.id));
  return rows.filter((r) => !r.parentServiceId || active.has(r.parentServiceId));
}
