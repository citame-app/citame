import type { Service } from "@sob/contracts";
import { type Database, service } from "@sob/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DomainError } from "../../errors";
import {
  activeCatalogRows,
  assertCatalogSelection,
  catalogMetadata,
  publicService,
} from "./options";

export async function listServices(db: Database): Promise<Service[]> {
  const rows = await activeCatalogRows(
    db,
    await db
      .select()
      .from(service)
      .where(and(eq(service.active, true), isNull(service.deletedAt)))
      .orderBy(asc(service.name)),
  );
  const metadata = await catalogMetadata(db, rows);
  const activeBaseIds = new Set(
    rows.filter((row) => row.catalogKind !== "addon").map((row) => row.id),
  );
  return rows.flatMap((row) => {
    const catalog = metadata.get(row.id);
    if (catalog?.kind === "addon" && !catalog.allowedServiceIds.some((id) => activeBaseIds.has(id)))
      return [];
    return [publicService(row, catalog)];
  });
}

export type ServiceRow = Service;

/**
 * Loads the requested active services in request order (duplicates collapsed).
 * Throws `not_found` when any of them is missing, inactive or deleted.
 */
export async function getServicesByIds(
  db: Pick<Database, "select">,
  ids: string[],
): Promise<ServiceRow[]> {
  const unique = [...new Set(ids)];
  const rows = await activeCatalogRows(
    db,
    await db
      .select()
      .from(service)
      .where(and(inArray(service.id, unique), eq(service.active, true), isNull(service.deletedAt))),
  );
  const metadata = await catalogMetadata(db, rows);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result = unique.map((id) => {
    const row = byId.get(id);
    if (!row) throw new DomainError("not_found", `Service ${id} not found`);
    return publicService(row, metadata.get(id));
  });
  return result;
}

/** Catalog lookup plus booking-only family and add-on rules. Other readers may list arbitrary eligible services. */
export async function getBookableServices(
  db: Pick<Database, "select">,
  ids: string[],
  expectedQuotes?: Record<string, string>,
) {
  const rows = await getServicesByIds(db, ids);
  if (
    expectedQuotes &&
    (Object.keys(expectedQuotes).length !== rows.length ||
      rows.some((s) => expectedQuotes[s.id] !== s.quoteHash))
  )
    throw new DomainError(
      "version_conflict",
      "Service terms changed; review the current price and duration before booking",
    );
  assertCatalogSelection(rows);
  return rows;
}
