import type {
  AdminService,
  CreateServiceRequest,
  ReviewedService,
  ServiceCatalog,
  ServiceCatalogUpdate,
  ServiceConfiguration,
  SetServiceStaffRequest,
  UpdateServiceRequest,
} from "@sob/contracts";
import {
  type Database,
  service,
  serviceAddon,
  serviceResource,
  serviceStaff,
  staffProfile,
} from "@sob/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { DomainError } from "../../errors";
import { lockCalendars, lockScheduling, type Tx } from "../../tx";
import { catalogMetadata, catalogTargets } from "./options";

type CatalogConnection = Database | Tx;
type Executor = Pick<Database, "select">;
type ServiceRow = typeof service.$inferSelect;

export interface AdminActor {
  userId: string;
}

function toAdminService(
  row: ServiceRow,
  staffIds: string[],
  catalog?: ServiceCatalog,
): ReviewedService {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    color: row.color,
    sortOrder: row.sortOrder,
    onlineBooking: row.onlineBooking,
    clientInstructions: row.clientInstructions,
    bookingIntervalMinutes: row.bookingIntervalMinutes,
    durationMinutes: row.durationMinutes,
    bufferMinutes: row.bufferMinutes,
    ...(row.processingStartMinutes !== null && row.processingMinutes !== null
      ? {
          processing: {
            startsAfterMinutes: row.processingStartMinutes,
            minutes: row.processingMinutes,
          },
        }
      : {}),
    priceCents: row.priceCents,
    ...(row.priceType !== "fixed" ? { priceType: row.priceType } : {}),
    currency: row.currency,
    active: row.active,
    staffIds,
    version: row.catalogVersion,
    ...(catalog ? { catalog } : {}),
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
export async function listAdminServices(db: CatalogConnection): Promise<ReviewedService[]> {
  const rows = await db
    .select()
    .from(service)
    .where(isNull(service.deletedAt))
    .orderBy(asc(service.name), asc(service.id));
  const staff = await loadStaffIds(
    db,
    rows.map((r) => r.id),
  );
  const metadata = await catalogMetadata(db, rows);
  return rows.map((row) => toAdminService(row, staff.get(row.id) ?? [], metadata.get(row.id)));
}

export async function createService(
  db: Database,
  input: CreateServiceRequest,
  actor: AdminActor,
  id?: string,
): Promise<AdminService> {
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    if (
      input.processing &&
      input.processing.startsAfterMinutes + input.processing.minutes >= input.durationMinutes
    )
      throw new DomainError("validation_error", "Processing requires final hands-on work");
    const targets = input.catalog ? await catalogTargets(tx, input.catalog) : [];
    if (input.staffIds?.length) {
      const selected = await tx
        .select({ id: staffProfile.id })
        .from(staffProfile)
        .where(
          and(
            inArray(staffProfile.id, input.staffIds),
            eq(staffProfile.active, true),
            isNull(staffProfile.deletedAt),
          ),
        )
        .for("share");
      if (selected.length !== input.staffIds.length)
        throw new DomainError("not_found", "An assigned professional is unavailable");
    }
    const parent = input.catalog?.kind === "variant" ? targets[0] : undefined;
    const currency = input.currency ?? targets[0]?.currency ?? "ARS";
    if (input.catalog?.kind === "addon" && targets.some((r) => r.currency !== currency))
      throw new DomainError(
        "validation_error",
        "Add-ons and their eligible services must use the same currency",
      );
    const [row] = await tx
      .insert(service)
      .values({
        id,
        name: input.name,
        description: input.description ?? null,
        category: input.category === undefined ? (parent?.category ?? null) : input.category,
        sortOrder: input.sortOrder ?? 0,
        onlineBooking: input.onlineBooking ?? parent?.onlineBooking ?? true,
        clientInstructions:
          input.clientInstructions === undefined
            ? (parent?.clientInstructions ?? null)
            : input.clientInstructions,
        bookingIntervalMinutes:
          input.bookingIntervalMinutes === undefined
            ? (parent?.bookingIntervalMinutes ?? null)
            : input.bookingIntervalMinutes,
        processingStartMinutes: input.processing?.startsAfterMinutes ?? null,
        processingMinutes: input.processing?.minutes ?? null,
        color: input.color ?? parent?.color ?? null,
        durationMinutes: input.durationMinutes,
        bufferMinutes: input.bufferMinutes ?? parent?.bufferMinutes ?? 0,
        priceCents: input.priceCents ?? 0,
        priceType: input.priceType ?? "fixed",
        currency,
        catalogKind: input.catalog?.kind ?? "service",
        parentServiceId: input.catalog?.kind === "variant" ? input.catalog.parentServiceId : null,
        optionLabel: input.catalog?.kind === "variant" ? input.catalog.optionLabel : null,
      })
      .returning();
    if (!row) throw new Error("Service insert returned no row");
    const targetIds = targets.map((r) => r.id);
    if (input.catalog?.kind === "addon")
      await tx
        .insert(serviceAddon)
        .values(
          input.catalog.allowedServiceIds.map((serviceId) => ({ addonId: row.id, serviceId })),
        );
    const copied = targetIds.length
      ? await tx
          .select({ staffId: serviceStaff.staffId })
          .from(serviceStaff)
          .where(and(inArray(serviceStaff.serviceId, targetIds), isNull(serviceStaff.deletedAt)))
      : [];
    const staffIds = input.staffIds ?? [...new Set(copied.map((r) => r.staffId))];
    if (staffIds.length)
      await tx
        .insert(serviceStaff)
        .values(staffIds.map((staffId) => ({ serviceId: row.id, staffId })));
    if (parent) {
      const resources = await tx
        .select()
        .from(serviceResource)
        .where(eq(serviceResource.serviceId, parent.id));
      if (resources.length)
        await tx.insert(serviceResource).values(
          resources.map((r) => ({
            serviceId: row.id,
            resourceId: r.resourceId,
            quantity: r.quantity,
            alternative: r.alternative,
          })),
        );
    }
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "service.create",
      entity: "service",
      entityId: row.id,
      metadata: { name: row.name, priceCents: row.priceCents },
    });
    return toAdminService(row, staffIds, (await catalogMetadata(tx, [row])).get(row.id));
  });
}

const EDITABLE = [
  "bookingIntervalMinutes",
  "priceType",
  "category",
  "sortOrder",
  "onlineBooking",
  "clientInstructions",
  "name",
  "description",
  "category",
  "color",
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
  db: CatalogConnection,
  id: string,
  input: UpdateServiceRequest,
  actor: AdminActor,
  expectedVersion?: number,
): Promise<ReviewedService> {
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const current = await requireService(tx, id);
    if (expectedVersion !== undefined && current.catalogVersion !== expectedVersion)
      throw new DomainError("version_conflict", "Review the current service before saving");
    if (input.priceType === "variable" || input.priceType === "free")
      input = { ...input, priceCents: 0 };
    const priceType = input.priceType ?? current.priceType;
    if (
      (priceType === "variable" || priceType === "free") &&
      (input.priceCents ?? current.priceCents) !== 0
    )
      throw new DomainError(
        "validation_error",
        "Variable and free services cannot have a fixed price",
      );
    const processing =
      input.processing === undefined
        ? current.processingStartMinutes !== null && current.processingMinutes !== null
          ? {
              startsAfterMinutes: current.processingStartMinutes,
              minutes: current.processingMinutes,
            }
          : null
        : input.processing;
    if (
      processing &&
      processing.startsAfterMinutes + processing.minutes >=
        (input.durationMinutes ?? current.durationMinutes)
    )
      throw new DomainError(
        "validation_error",
        "Review or remove processing time before shortening the treatment",
      );
    if (input.durationMinutes === 0 && current.catalogKind !== "addon")
      throw new DomainError("validation_error", "A standalone service needs a positive duration");
    if (
      (input.durationMinutes ?? current.durationMinutes) +
        (input.bufferMinutes ?? current.bufferMinutes) ===
      0
    ) {
      const [required] = await tx
        .select({ id: serviceResource.id })
        .from(serviceResource)
        .where(eq(serviceResource.serviceId, id))
        .limit(1);
      if (required)
        throw new DomainError(
          "validation_error",
          "Remove resource requirements before making an add-on zero-time",
        );
    }
    const changes: Partial<Record<(typeof EDITABLE)[number], unknown>> = {};
    for (const key of EDITABLE) {
      const next = input[key];
      if (next !== undefined && next !== current[key]) changes[key] = next;
    }
    const processingChanges =
      input.processing !== undefined &&
      (current.processingStartMinutes !== (processing?.startsAfterMinutes ?? null) ||
        current.processingMinutes !== (processing?.minutes ?? null))
        ? {
            processingStartMinutes: processing?.startsAfterMinutes ?? null,
            processingMinutes: processing?.minutes ?? null,
          }
        : {};
    const changed = [...Object.keys(changes), ...Object.keys(processingChanges)].sort();
    const staffIds = (await loadStaffIds(tx, [id])).get(id) ?? [];
    if (changed.length === 0)
      return toAdminService(
        current,
        staffIds,
        (await catalogMetadata(tx, [current])).get(current.id),
      );

    const [updated] = await tx
      .update(service)
      .set({
        ...changes,
        ...processingChanges,
        catalogVersion: current.catalogVersion + 1,
      } as Partial<typeof service.$inferInsert>)
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
    return toAdminService(
      updated,
      staffIds,
      (await catalogMetadata(tx, [updated])).get(updated.id),
    );
  });
}

export function deactivateService(db: Database, id: string, actor: AdminActor) {
  return updateService(db, id, { active: false }, actor);
}

/** Replaces who performs a service. Removed links are soft-deleted, returning ones revived. */
export async function setServiceStaff(
  db: CatalogConnection,
  id: string,
  request: SetServiceStaffRequest,
  actor: AdminActor,
  reviewedStaffIds?: readonly string[],
): Promise<AdminService> {
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const current = await requireService(tx, id);
    const desired = [...new Set(request.staffIds)];
    const existing = await tx.select().from(serviceStaff).where(eq(serviceStaff.serviceId, id));
    const assigned = new Set(
      existing.filter((link) => !link.deletedAt).map((link) => link.staffId),
    );
    if (
      reviewedStaffIds &&
      (assigned.size !== reviewedStaffIds.length ||
        reviewedStaffIds.some((id) => !assigned.has(id)))
    ) {
      throw new DomainError(
        "version_conflict",
        "Service assignments changed; review the current team",
      );
    }

    // A reviewed edit can preserve links to staff who are already assigned and inactive.
    const checked = reviewedStaffIds ? desired.filter((id) => !assigned.has(id)) : desired;
    if (checked.length > 0) {
      if (reviewedStaffIds) await lockCalendars(tx, checked);
      const found = await tx
        .select({ id: staffProfile.id })
        .from(staffProfile)
        .where(
          and(
            inArray(staffProfile.id, checked),
            eq(staffProfile.active, true),
            isNull(staffProfile.deletedAt),
          ),
        );
      const known = new Set(found.map((s) => s.id));
      const missing = checked.find((staffId) => !known.has(staffId));
      if (missing) throw new DomainError("not_found", `Staff member ${missing} not found`);
    }

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
      await tx
        .update(service)
        .set({ catalogVersion: current.catalogVersion + 1 })
        .where(eq(service.id, id));
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: "service.staff_set",
        entity: "service",
        entityId: id,
        metadata: { added, removed },
      });
    }
    const saved = {
      ...current,
      catalogVersion: current.catalogVersion + (added.length > 0 || removed.length > 0 ? 1 : 0),
    };
    return toAdminService(saved, desired, (await catalogMetadata(tx, [saved])).get(saved.id));
  });
}

async function validateAddonCurrency(tx: Tx, currency: string, allowedServiceIds: string[]) {
  const targets = await catalogTargets(tx, { kind: "addon", allowedServiceIds });
  if (targets.some((row) => row.currency !== currency))
    throw new DomainError(
      "validation_error",
      "Add-ons and eligible services must use the same currency",
    );
}

export async function updateServiceCatalog(
  db: CatalogConnection,
  id: string,
  input: ServiceCatalogUpdate,
  actor: AdminActor,
) {
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const [row] = await tx
      .select()
      .from(service)
      .where(and(eq(service.id, id), isNull(service.deletedAt)))
      .for("update");
    if (!row) throw new DomainError("not_found", "Service not found");
    if (row.catalogKind !== input.kind)
      throw new DomainError("validation_error", "The service catalog kind cannot be changed");
    if (row.catalogVersion !== input.version)
      throw new DomainError("version_conflict", "Service options changed; reload before saving");
    if (input.kind === "addon") {
      await validateAddonCurrency(tx, row.currency, input.allowedServiceIds);
      await tx.delete(serviceAddon).where(eq(serviceAddon.addonId, id));
      await tx
        .insert(serviceAddon)
        .values(input.allowedServiceIds.map((serviceId) => ({ addonId: id, serviceId })));
    }
    const [saved] = await tx
      .update(service)
      .set({
        catalogVersion: row.catalogVersion + 1,
        ...(input.kind === "variant" ? { optionLabel: input.optionLabel } : {}),
      })
      .where(eq(service.id, id))
      .returning();
    if (!saved) throw new Error("Missing service options after update");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "service.catalog_updated",
      entity: "service",
      entityId: id,
      metadata: { kind: input.kind, version: saved.catalogVersion },
    });
    const staffIds = (await loadStaffIds(tx, [id])).get(id) ?? [];
    return toAdminService(saved, staffIds, (await catalogMetadata(tx, [saved])).get(id));
  });
}

/** One reviewed editor submission: details, performers and option terms commit or roll back together. */
export async function updateServiceConfiguration(
  db: CatalogConnection,
  id: string,
  input: Pick<ServiceConfiguration, "version" | "catalog"> & {
    service?: UpdateServiceRequest;
    staffIds?: string[];
    reviewedStaffIds?: readonly string[];
  },
  actor: AdminActor,
) {
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const current = await requireService(tx, id);
    if (current.catalogVersion !== input.version)
      throw new DomainError(
        "version_conflict",
        "Service configuration changed; reload before saving",
      );
    if (input.catalog && input.catalog.version !== input.version)
      throw new DomainError("validation_error", "Review all service options at the same revision");
    const currency = input.service?.currency;
    if (
      !input.catalog &&
      current.catalogKind === "addon" &&
      currency &&
      currency !== current.currency
    ) {
      const addon = (await catalogMetadata(tx, [current])).get(id);
      if (addon?.kind === "addon" && addon.allowedServiceIds.length > 0)
        await validateAddonCurrency(tx, currency, addon.allowedServiceIds);
    }
    let saved: AdminService | undefined;
    if (input.service) saved = await updateService(tx, id, input.service, actor);
    if (input.staffIds) {
      const reviewedStaffIds =
        input.reviewedStaffIds ?? (await loadStaffIds(tx, [id])).get(id) ?? [];
      saved = await setServiceStaff(tx, id, { staffIds: input.staffIds }, actor, reviewedStaffIds);
    }
    if (input.catalog)
      saved = await updateServiceCatalog(
        tx,
        id,
        { ...input.catalog, version: saved?.version ?? input.version },
        actor,
      );
    if (!saved) throw new DomainError("validation_error", "Provide at least one change");
    return saved;
  });
}
