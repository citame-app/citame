import type { Service } from "@sob/contracts";
import { type Database, service } from "@sob/db";
import { and, asc, eq, isNull } from "drizzle-orm";

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
