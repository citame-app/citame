import { createHash } from "node:crypto";
import type { CombinationCreate, CombinationUpdate, Service } from "@sob/contracts";
import { type Database, serviceCombination } from "@sob/db";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling, type Tx } from "../../tx";
import { activeServiceAssignments } from "../staff/service";
import { assertCatalogSelection } from "./options";
import { assertOnlineServices, getBookableServices, onlineServicesByIds } from "./service";

type Connection = Database | Tx;
type Row = typeof serviceCombination.$inferSelect;
type ActiveAssignments = Map<string, Set<string>>;

async function activeAssignments(
  db: Connection,
  ids: readonly string[],
): Promise<ActiveAssignments> {
  const byService: ActiveAssignments = new Map();
  for (const { serviceId, staffId } of await activeServiceAssignments(db, ids)) {
    const assigned = byService.get(serviceId) ?? new Set<string>();
    assigned.add(staffId);
    byService.set(serviceId, assigned);
  }
  return byService;
}

function hasQualifiedTeam(services: Service[], assignments: ActiveAssignments): boolean {
  const qualified = (ids: string[]) =>
    [...(assignments.get(ids[0] ?? "") ?? [])].some((staff) =>
      ids.every((id) => assignments.get(id)?.has(staff)),
    );
  if (qualified(services.map((row) => row.id))) return true;
  const parts: string[][] = [];
  for (const row of services) {
    if (row.catalog?.kind === "addon") parts.at(-1)?.push(row.id);
    else parts.push([row.id]);
  }
  return parts.length <= 8 && parts.every(qualified);
}

async function validate(db: Connection, ids: string[], requireOnline = false) {
  const services = await getBookableServices(db, ids);
  if (requireOnline) {
    try {
      await assertOnlineServices(db, ids);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "forbidden") throw error;
      throw new DomainError("validation_error", "Choose treatments available for online booking");
    }
  }
  if (!hasQualifiedTeam(services, await activeAssignments(db, ids)))
    throw new DomainError(
      "validation_error",
      "Each treatment and its extras need a qualified professional",
    );
}
async function writtenView(db: Connection, row: Row) {
  try {
    await validate(db, row.serviceIds, true);
    return view(row, true);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return view(row, false);
  }
}

function view(row: Row, bookable: boolean) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    serviceIds: row.serviceIds,
    active: row.active,
    version: row.version,
    bookable,
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function listCombinations(db: Database, principal?: Principal) {
  if (principal) requirePermission(principal, "editCatalog");
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    const rows = await tx
      .select()
      .from(serviceCombination)
      .where(principal ? undefined : eq(serviceCombination.active, true))
      .orderBy(asc(serviceCombination.name), asc(serviceCombination.id))
      .limit(100);
    if (!rows.length) return { combinations: [] };
    const ids = [...new Set(rows.flatMap((row) => row.serviceIds))];
    const services = new Map((await onlineServicesByIds(tx, ids)).map((row) => [row.id, row]));
    const assignments = await activeAssignments(tx, ids);
    return {
      combinations: rows.flatMap((row) => {
        const selected: Service[] = [];
        for (const id of row.serviceIds) {
          const service = services.get(id);
          if (!service) return principal ? [view(row, false)] : [];
          selected.push(service);
        }
        let bookable = false;
        try {
          assertCatalogSelection(selected);
          bookable = hasQualifiedTeam(selected, assignments);
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
        }
        return principal || bookable ? [view(row, bookable)] : [];
      }),
    };
  });
}
export async function saveCombination(
  db: Database,
  input: CombinationCreate | CombinationUpdate,
  p: Principal,
  now: Date,
  target?: { kind: "create" | "update"; id: string; reviewOnline?: true },
) {
  requirePermission(p, "editCatalog");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const current = await loadPrincipal(tx, p.userId);
    if (!current) throw new DomainError("forbidden", "This account is no longer available");
    requirePermission(current, "editCatalog");
    const fields = {
      name: input.name,
      description: input.description,
      serviceIds: input.serviceIds,
      active: input.active,
    };
    let row: Row | undefined;
    const id = target?.kind === "update" ? target.id : undefined;
    if (id) {
      [row] = await tx
        .select()
        .from(serviceCombination)
        .where(eq(serviceCombination.id, id))
        .for("update");
      if (!row) throw new DomainError("not_found", "Combination not found");
      if (!("version" in input) || input.version !== row.version)
        throw new DomainError("version_conflict", "Combination changed; reload before saving");
      if (input.active || JSON.stringify(input.serviceIds) !== JSON.stringify(row.serviceIds))
        await validate(tx, input.serviceIds, target?.reviewOnline);
      [row] = await tx
        .update(serviceCombination)
        .set({ ...fields, version: row.version + 1, updatedAt: now })
        .where(eq(serviceCombination.id, id))
        .returning();
    } else {
      if (!("idempotencyKey" in input))
        throw new DomainError("validation_error", "A creation identifier is required");
      const fingerprint = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
      [row] = await tx
        .select()
        .from(serviceCombination)
        .where(
          and(
            eq(serviceCombination.createdBy, p.userId),
            eq(serviceCombination.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (row) {
        if (row.requestFingerprint !== fingerprint || (target && row.id !== target.id))
          throw new DomainError("invalid_state", "This identifier belongs to another submission");
        return writtenView(tx, row);
      }
      if (target) {
        const [existing] = await tx
          .select({ id: serviceCombination.id })
          .from(serviceCombination)
          .where(eq(serviceCombination.id, target.id));
        if (existing)
          throw new DomainError("invalid_state", "This combination identifier already exists");
      }
      const [total] = await tx.select({ total: count() }).from(serviceCombination);
      if ((total?.total ?? 0) >= 100)
        throw new DomainError("storage_limit", "The salon combination limit has been reached");
      await validate(tx, input.serviceIds, target?.reviewOnline);
      [row] = await tx
        .insert(serviceCombination)
        .values({
          ...fields,
          ...(target ? { id: target.id } : {}),
          createdBy: p.userId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    }
    if (!row) throw new Error("Combination write returned no row");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: id ? "service_combination.update" : "service_combination.create",
      entity: "service_combination",
      entityId: row.id,
      metadata: { version: row.version, active: row.active, serviceIds: row.serviceIds },
    });
    return writtenView(tx, row);
  });
}
