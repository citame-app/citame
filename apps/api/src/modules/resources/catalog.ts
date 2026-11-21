import { createHash } from "node:crypto";
import type { ResourceCreate, ResourceUpdate, ServiceResourceInput } from "@sob/contracts";
import {
  type Database,
  pgErrorCode,
  resourcePool,
  resourceReservation,
  service,
  serviceResource,
} from "@sob/db";
import { and, asc, count, eq, gt, inArray, isNull } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling, type Tx } from "../../tx";
import { releaseExpiredResourceOffers, repackFutureResources } from "./reservations";
import { reconfigureScheduledResources } from "./upgrade";

type Connection = Database | Tx;
const view = (row: typeof resourcePool.$inferSelect) => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  capacity: row.capacity,
  active: row.active,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
});
const versionConflict = () =>
  new DomainError("version_conflict", "Resource settings changed; reload before saving");
function mapError(error: unknown): never {
  if (pgErrorCode(error) === "23505")
    throw new DomainError("invalid_state", "An active resource with that name already exists");
  throw error;
}
export async function listResources(db: Connection, p: Principal) {
  requirePermission(p, "editCatalog");
  const rows = await db
    .select()
    .from(resourcePool)
    .orderBy(asc(resourcePool.name), asc(resourcePool.id));
  return { resources: rows.map(view) };
}
export async function createResource(db: Database, input: ResourceCreate, p: Principal) {
  requirePermission(p, "editCatalog");
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ name: input.name, kind: input.kind, capacity: input.capacity }))
    .digest("hex");
  try {
    return await db.transaction(async (tx) => {
      await lockScheduling(tx);
      const [prior] = await tx
        .select()
        .from(resourcePool)
        .where(
          and(
            eq(resourcePool.createdBy, p.userId),
            eq(resourcePool.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new DomainError("invalid_state", "This resource request key has already been used");
        return view(prior);
      }
      const [total] = await tx.select({ n: count() }).from(resourcePool);
      if ((total?.n ?? 0) >= 50)
        throw new DomainError(
          "invalid_state",
          "The salon can configure at most 50 resource pools; reuse an existing inactive pool",
        );
      const [row] = await tx
        .insert(resourcePool)
        .values({ ...input, createdBy: p.userId, requestHash })
        .returning();
      if (!row) throw new Error("Missing resource after creation");
      await recordAudit(tx, {
        actorUserId: p.userId,
        action: "resource.created",
        entity: "resource_pool",
        entityId: row.id,
        metadata: { name: row.name, kind: row.kind, capacity: row.capacity },
      });
      return view(row);
    });
  } catch (error) {
    return mapError(error);
  }
}
export async function updateResource(
  db: Database,
  id: string,
  input: ResourceUpdate,
  p: Principal,
  now: Date,
) {
  requirePermission(p, "editCatalog");
  try {
    return await db.transaction(async (tx) => {
      await lockScheduling(tx);
      const [current] = await tx
        .select()
        .from(resourcePool)
        .where(eq(resourcePool.id, id))
        .for("update");
      if (!current) throw new DomainError("not_found", "Resource not found");
      if (current.version !== input.version) throw versionConflict();
      await releaseExpiredResourceOffers(tx, [id], now);
      const reserved = await tx
        .select()
        .from(resourceReservation)
        .where(
          and(
            eq(resourceReservation.resourceId, id),
            eq(resourceReservation.active, true),
            gt(resourceReservation.endsAt, now),
          ),
        )
        .orderBy(asc(resourceReservation.startsAt), asc(resourceReservation.id))
        .for("update");
      if (!input.active && reserved.length)
        throw new DomainError(
          "invalid_state",
          "This resource still has active or future visits/offers; release or move them before deactivating it",
        );
      if (input.capacity < current.capacity)
        await repackFutureResources(tx, [id], now, { capacities: new Map([[id, input.capacity]]) });
      if (input.name !== current.name)
        await tx
          .update(resourceReservation)
          .set({ name: input.name })
          .where(
            and(
              eq(resourceReservation.resourceId, id),
              eq(resourceReservation.active, true),
              gt(resourceReservation.endsAt, now),
            ),
          );
      const [saved] = await tx
        .update(resourcePool)
        .set({
          name: input.name,
          kind: input.kind,
          capacity: input.capacity,
          active: input.active,
          version: current.version + 1,
        })
        .where(eq(resourcePool.id, id))
        .returning();
      if (!saved) throw new Error("Missing updated resource");
      await recordAudit(tx, {
        actorUserId: p.userId,
        action: "resource.updated",
        entity: "resource_pool",
        entityId: id,
        metadata: { version: saved.version, capacity: saved.capacity, active: saved.active },
      });
      return view(saved);
    });
  } catch (error) {
    return mapError(error);
  }
}
async function serviceRow(db: Connection, id: string, lock = false) {
  const query = db
    .select()
    .from(service)
    .where(and(eq(service.id, id), isNull(service.deletedAt)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new DomainError("not_found", "Service not found");
  return row;
}
async function requirementsView(db: Connection, id: string, version: number) {
  const rows = await db
    .select({ link: serviceResource, pool: resourcePool })
    .from(serviceResource)
    .innerJoin(resourcePool, eq(resourcePool.id, serviceResource.resourceId))
    .where(eq(serviceResource.serviceId, id))
    .orderBy(asc(resourcePool.name), asc(resourcePool.id));
  return {
    serviceId: id,
    version,
    ...(rows.some((r) => r.link.alternative) ? { selectionMode: "one_of" as const } : {}),
    requirements: rows.map((r) => ({
      resourceId: r.pool.id,
      name: r.pool.name,
      quantity: r.link.quantity,
      capacity: r.pool.capacity,
      active: r.pool.active,
    })),
  };
}
export async function getServiceResources(db: Database, id: string, p: Principal) {
  requirePermission(p, "editCatalog");
  return db.transaction(
    async (tx) => {
      const row = await serviceRow(tx, id);
      return requirementsView(tx, id, row.resourceVersion);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function getReviewedServiceResources(
  db: Database,
  id: string,
  p: Principal,
  generation: string,
) {
  requirePermission(p, "editCatalog");
  return db.transaction(
    async (tx) => {
      const row = await serviceRow(tx, id);
      const { resources } = await listResources(tx, p);
      return {
        generation,
        resources,
        service: await requirementsView(tx, id, row.resourceVersion),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function setServiceResources(
  db: Connection,
  id: string,
  input: ServiceResourceInput,
  p: Principal,
  now: Date = new Date(),
) {
  requirePermission(p, "editCatalog");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const row = await serviceRow(tx, id, true);
    if (row.resourceVersion !== input.version) throw versionConflict();
    if (input.requirements.length && row.durationMinutes + row.bufferMinutes === 0)
      throw new DomainError(
        "validation_error",
        "A zero-time add-on cannot reserve a room or equipment",
      );
    const ids = input.requirements.map((r) => r.resourceId);
    const alternative =
      (input.selectionMode ??
        (await requirementsView(tx, id, row.resourceVersion)).selectionMode) === "one_of";
    const pools = ids.length
      ? await tx.select().from(resourcePool).where(inArray(resourcePool.id, ids))
      : [];
    for (const requirement of input.requirements) {
      const pool = pools.find((r) => r.id === requirement.resourceId);
      if (!pool) throw new DomainError("not_found", "Required resource not found");
      if (!pool.active)
        throw new DomainError("validation_error", "Choose active resources for this service");
      if (alternative && requirement.quantity !== 1)
        throw new DomainError("validation_error", "Each alternative must represent one resource");
      if (requirement.quantity > pool.capacity)
        throw new DomainError(
          "validation_error",
          "A service cannot require more units than the resource capacity",
        );
    }
    await tx.delete(serviceResource).where(eq(serviceResource.serviceId, id));
    if (input.requirements.length)
      await tx
        .insert(serviceResource)
        .values(input.requirements.map((r) => ({ ...r, serviceId: id, alternative })));
    await tx
      .update(service)
      .set({ resourceVersion: row.resourceVersion + 1 })
      .where(eq(service.id, id));
    const affected = await reconfigureScheduledResources(tx, id, now);
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "service.resources_updated",
      entity: "service",
      entityId: id,
      metadata: {
        version: row.resourceVersion + 1,
        requirements: input.requirements,
        alternative,
        affected,
      },
    });
    return requirementsView(tx, id, row.resourceVersion + 1);
  });
}
