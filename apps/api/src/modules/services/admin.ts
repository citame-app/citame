import type {
  AdminService,
  CreateServiceRequest,
  SetServiceStaffRequest,
  UpdateServiceRequest,
} from "@sob/contracts";
import { type Database, service, serviceStaff, staffProfile } from "@sob/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { DomainError } from "../../errors";

type Executor = Pick<Database, "select">;
type ServiceRow = typeof service.$inferSelect;

export interface AdminActor {
  userId: string;
}

function toAdminService(row: ServiceRow, staffIds: string[]): AdminService {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    durationMinutes: row.durationMinutes,
    bufferMinutes: row.bufferMinutes,
    priceCents: row.priceCents,
    currency: row.currency,
    active: row.active,
    staffIds,
  };
}

async function loadStaffIds(db: Executor, serviceIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (serviceIds.length === 0) return map;
  const links = await db
    .select({ serviceId: serviceStaff.serviceId, staffId: serviceStaff.staffId })
    .from(serviceStaff)
    .where(and(inArray(serviceStaff.serviceId, serviceIds), isNull(serviceStaff.deletedAt)));
  for (const link of links) {
    map.set(link.serviceId, [...(map.get(link.serviceId) ?? []), link.staffId]);
  }
  return map;
}

async function requireService(db: Executor, id: string): Promise<ServiceRow> {
  const [row] = await db
    .select()
    .from(service)
    .where(and(eq(service.id, id), isNull(service.deletedAt)));
  if (!row) throw new DomainError("not_found", `Service ${id} not found`);
  return row;
}

export async function getAdminService(db: Executor, id: string): Promise<AdminService> {
  const row = await requireService(db, id);
  const staffIds = (await loadStaffIds(db, [id])).get(id) ?? [];
  return toAdminService(row, staffIds);
}

/** Every non-deleted service, inactive ones included. */
export async function listAdminServices(db: Database): Promise<AdminService[]> {
  const rows = await db
    .select()
    .from(service)
    .where(isNull(service.deletedAt))
    .orderBy(asc(service.name), asc(service.id));
  const staff = await loadStaffIds(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toAdminService(row, staff.get(row.id) ?? []));
}

export async function createService(
  db: Database,
  input: CreateServiceRequest,
  actor: AdminActor,
): Promise<AdminService> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(service)
      .values({
        name: input.name,
        description: input.description ?? null,
        durationMinutes: input.durationMinutes,
        bufferMinutes: input.bufferMinutes ?? 0,
        priceCents: input.priceCents,
        ...(input.currency ? { currency: input.currency } : {}),
      })
      .returning();
    if (!row) throw new Error("Service insert returned no row");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "service.create",
      entity: "service",
      entityId: row.id,
      metadata: { name: row.name, priceCents: row.priceCents },
    });
    return toAdminService(row, []);
  });
}

const EDITABLE = [
  "name",
  "description",
  "durationMinutes",
  "bufferMinutes",
  "priceCents",
  "currency",
  "active",
] as const;

/**
 * Applies a partial edit. Only fields whose value actually changes are written and audited, so
 * repeating a request is a harmless no-op (no row touched, no audit entry).
 */
export async function updateService(
  db: Database,
  id: string,
  input: UpdateServiceRequest,
  actor: AdminActor,
): Promise<AdminService> {
  return db.transaction(async (tx) => {
    const current = await requireService(tx, id);
    const changes: Partial<Record<(typeof EDITABLE)[number], unknown>> = {};
    for (const key of EDITABLE) {
      const next = input[key];
      if (next !== undefined && next !== current[key]) changes[key] = next;
    }
    const changed = Object.keys(changes).sort();
    const staffIds = (await loadStaffIds(tx, [id])).get(id) ?? [];
    if (changed.length === 0) return toAdminService(current, staffIds);

    const [updated] = await tx
      .update(service)
      .set(changes as Partial<typeof service.$inferInsert>)
      .where(eq(service.id, id))
      .returning();
    if (!updated) throw new Error("Service update returned no row");

    const action =
      "active" in changes
        ? updated.active
          ? "service.activate"
          : "service.deactivate"
        : "service.update";
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action,
      entity: "service",
      entityId: id,
      metadata: { changed },
    });
    return toAdminService(updated, staffIds);
  });
}

export function deactivateService(db: Database, id: string, actor: AdminActor) {
  return updateService(db, id, { active: false }, actor);
}

/** Replaces who performs a service. Removed links are soft-deleted, returning ones revived. */
export async function setServiceStaff(
  db: Database,
  id: string,
  request: SetServiceStaffRequest,
  actor: AdminActor,
): Promise<AdminService> {
  return db.transaction(async (tx) => {
    const current = await requireService(tx, id);
    const desired = [...new Set(request.staffIds)];

    if (desired.length > 0) {
      const found = await tx
        .select({ id: staffProfile.id })
        .from(staffProfile)
        .where(
          and(
            inArray(staffProfile.id, desired),
            eq(staffProfile.active, true),
            isNull(staffProfile.deletedAt),
          ),
        );
      const known = new Set(found.map((s) => s.id));
      const missing = desired.find((staffId) => !known.has(staffId));
      if (missing) throw new DomainError("not_found", `Staff member ${missing} not found`);
    }

    const existing = await tx.select().from(serviceStaff).where(eq(serviceStaff.serviceId, id));
    const byStaff = new Map(existing.map((link) => [link.staffId, link]));
    const added: string[] = [];
    const removed: string[] = [];
    const now = new Date();

    for (const staffId of desired) {
      const link = byStaff.get(staffId);
      if (!link) {
        await tx.insert(serviceStaff).values({ serviceId: id, staffId });
        added.push(staffId);
      } else if (link.deletedAt) {
        await tx.update(serviceStaff).set({ deletedAt: null }).where(eq(serviceStaff.id, link.id));
        added.push(staffId);
      }
    }
    for (const link of existing) {
      if (!link.deletedAt && !desired.includes(link.staffId)) {
        await tx.update(serviceStaff).set({ deletedAt: now }).where(eq(serviceStaff.id, link.id));
        removed.push(link.staffId);
      }
    }

    if (added.length > 0 || removed.length > 0) {
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: "service.staff_set",
        entity: "service",
        entityId: id,
        metadata: { added, removed },
      });
    }
    return toAdminService(current, desired);
  });
}
