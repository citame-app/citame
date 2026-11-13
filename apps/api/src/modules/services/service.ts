import type { Service } from "@sob/contracts";
import { type Database, service } from "@sob/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DomainError } from "../../errors";

export async function listServices(db: Database): Promise<Service[]> {
  return db
    .select({
      id: service.id,
      name: service.name,
      description: service.description,
      durationMinutes: service.durationMinutes,
      bufferMinutes: service.bufferMinutes,
      priceCents: service.priceCents,
      currency: service.currency,
    })
    .from(service)
    .where(and(eq(service.active, true), isNull(service.deletedAt)))
    .orderBy(asc(service.name));
}

export type ServiceRow = Service;

/**
 * Loads the requested active services in request order (duplicates collapsed).
 * Throws `not_found` when any of them is missing, inactive or deleted.
 */
export async function getServicesByIds(db: Database, ids: string[]): Promise<ServiceRow[]> {
  const unique = [...new Set(ids)];
  const rows = await db
    .select({
      id: service.id,
      name: service.name,
      description: service.description,
      durationMinutes: service.durationMinutes,
      bufferMinutes: service.bufferMinutes,
      priceCents: service.priceCents,
      currency: service.currency,
    })
    .from(service)
    .where(and(inArray(service.id, unique), eq(service.active, true), isNull(service.deletedAt)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return unique.map((id) => {
    const row = byId.get(id);
    if (!row) throw new DomainError("not_found", `Service ${id} not found`);
    return row;
  });
}
