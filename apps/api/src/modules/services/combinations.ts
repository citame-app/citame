import { createHash } from "node:crypto";
import type { CombinationCreate, CombinationUpdate } from "@sob/contracts";
import { type Database, serviceCombination } from "@sob/db";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling, type Tx } from "../../tx";
import { staffQualifiedFor } from "../staff/service";
import { getBookableServices } from "./service";

type Connection = Database | Tx;
type Row = typeof serviceCombination.$inferSelect;
async function validate(db: Connection, ids: string[]) {
  const services = await getBookableServices(db, ids);
  if (new Set(services.map((s) => s.currency)).size !== 1)
    throw new DomainError("validation_error", "Combined treatments must share a currency");
  if (!(await staffQualifiedFor(db, ids)).length)
    throw new DomainError(
      "validation_error",
      "A professional must perform every selected treatment and extra",
    );
}
async function view(db: Connection, row: Row) {
  let bookable = true;
  try {
    await validate(db, row.serviceIds);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    bookable = false;
  }
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
    const values = [];
    for (const row of rows) {
      const result = await view(tx, row);
      if (principal || result.bookable) values.push(result);
    }
    return { combinations: values };
  });
}
export async function saveCombination(
  db: Database,
  input: CombinationCreate | CombinationUpdate,
  p: Principal,
  now: Date,
  id?: string,
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
        await validate(tx, input.serviceIds);
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
        if (row.requestFingerprint !== fingerprint)
          throw new DomainError("invalid_state", "This identifier belongs to another submission");
        return view(tx, row);
      }
      const [total] = await tx.select({ total: count() }).from(serviceCombination);
      if ((total?.total ?? 0) >= 100)
        throw new DomainError("storage_limit", "The salon combination limit has been reached");
      await validate(tx, input.serviceIds);
      [row] = await tx
        .insert(serviceCombination)
        .values({
          ...fields,
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
    return view(tx, row);
  });
}
