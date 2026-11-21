import type { Service } from "@sob/contracts";
import { type Database, service, user } from "@sob/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DomainError } from "../../errors";
import {
  activeCatalogRows,
  assertCatalogSelection,
  catalogMetadata,
  publicService,
} from "./options";

export async function listServices(db: Database, includeInternal = false): Promise<Service[]> {
  const rows = await activeCatalogRows(
    db,
    await db
      .select()
      .from(service)
      .where(
        and(
          eq(service.active, true),
          includeInternal ? undefined : eq(service.onlineBooking, true),
          isNull(service.deletedAt),
        ),
      )
      .orderBy(asc(service.sortOrder), asc(service.name)),
  );
  const visible = includeInternal ? rows : await onlineCatalogRows(db, rows);
  const metadata = await catalogMetadata(db, visible);
  const activeBaseIds = new Set(
    visible.filter((row) => row.catalogKind !== "addon").map((row) => row.id),
  );
  return visible.flatMap((row) => {
    const catalog = metadata.get(row.id);
    if (catalog?.kind === "addon" && !catalog.allowedServiceIds.some((id) => activeBaseIds.has(id)))
      return [];
    return [publicService(row, catalog)];
  });
}

export async function onlineServicesByIds(db: Pick<Database, "select">, ids: string[]) {
  if (!ids.length) return [];
  const active = await loadActiveCatalogRows(db, ids);
  const visible = await onlineCatalogRows(db, active);
  const metadata = await catalogMetadata(db, visible);
  return visible.map((row) => publicService(row, metadata.get(row.id)));
}

async function onlineCatalogRows(
  db: Pick<Database, "select">,
  rows: (typeof service.$inferSelect)[],
) {
  const parents = [...new Set(rows.flatMap((r) => (r.parentServiceId ? [r.parentServiceId] : [])))];
  const hidden = parents.length
    ? await db
        .select({ id: service.id })
        .from(service)
        .where(and(inArray(service.id, parents), eq(service.onlineBooking, false)))
    : [];
  const hiddenIds = new Set(hidden.map((r) => r.id));
  return rows.filter(
    (r) => r.onlineBooking && (!r.parentServiceId || !hiddenIds.has(r.parentServiceId)),
  );
}

/** Enforced inside the scheduling transaction, including MCP and offline replay. */
export async function assertOnlineServices(
  db: Pick<Database, "select">,
  ids: string[],
  actorUserId?: string,
) {
  if (actorUserId) {
    const [actor] = await db.select({ role: user.role }).from(user).where(eq(user.id, actorUserId));
    if (actor && actor.role !== "client") return false;
  }
  const rows = await db.select().from(service).where(inArray(service.id, ids));
  if ((await onlineCatalogRows(db, rows)).length !== new Set(ids).size)
    throw new DomainError("forbidden", "These services can only be booked by the salon team");
  return Boolean(actorUserId);
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
  return (await readServiceTerms(db, ids)).map(({ row, catalog }) => publicService(row, catalog));
}

async function loadActiveCatalogRows(db: Pick<Database, "select">, ids: string[]) {
  return activeCatalogRows(
    db,
    await db
      .select()
      .from(service)
      .where(and(inArray(service.id, ids), eq(service.active, true), isNull(service.deletedAt))),
  );
}

async function readServiceTerms(db: Pick<Database, "select">, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = await loadActiveCatalogRows(db, unique);
  const metadata = await catalogMetadata(db, rows);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result = unique.map((id) => {
    const row = byId.get(id);
    if (!row) throw new DomainError("not_found", `Service ${id} not found`);
    return { row, catalog: metadata.get(id) };
  });
  return result;
}

/** Catalog lookup plus booking-only family and add-on rules. Other readers may list arbitrary eligible services. */
export async function getBookableServices(
  db: Pick<Database, "select">,
  ids: string[],
  expectedQuotes?: Record<string, string>,
) {
  const terms = await readServiceTerms(db, ids);
  const rows = terms.map(({ row, catalog }) => publicService(row, catalog));
  if (
    expectedQuotes &&
    (Object.keys(expectedQuotes).length !== rows.length ||
      rows.some((s, index) => {
        if (expectedQuotes[s.id] === s.quoteHash) return false;
        const option = terms[index];
        return (
          !option?.catalog ||
          expectedQuotes[s.id] !== publicService(option.row, option.catalog, "legacy").quoteHash
        );
      }))
  )
    throw new DomainError(
      "version_conflict",
      "Service terms changed; review the current price and duration before booking",
    );
  assertCatalogSelection(rows);
  return rows;
}
