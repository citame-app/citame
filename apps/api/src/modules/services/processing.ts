import type { ServiceProcessingInput } from "@sob/contracts";
import { type Database, service } from "@sob/db";
import { and, eq, isNull } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling } from "../../tx";
import { listAdminServices } from "./admin";
export async function setServiceProcessing(
  db: Database,
  id: string,
  input: ServiceProcessingInput,
  p: Principal,
) {
  requirePermission(p, "editCatalog");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const current = await loadPrincipal(tx, p.userId);
    if (!current) throw new DomainError("forbidden", "Account not available");
    requirePermission(current, "editCatalog");
    const [row] = await tx
      .select()
      .from(service)
      .where(and(eq(service.id, id), isNull(service.deletedAt)))
      .for("update");
    if (!row) throw new DomainError("not_found", "Treatment not found");
    if (row.catalogVersion !== input.version)
      throw new DomainError("version_conflict", "Treatment changed; reload before saving");
    if (
      input.processing &&
      input.processing.startsAfterMinutes + input.processing.minutes >= row.durationMinutes
    )
      throw new DomainError(
        "validation_error",
        "Processing requires work before and after the exposure time",
      );
    await tx
      .update(service)
      .set({
        processingStartMinutes: input.processing?.startsAfterMinutes ?? null,
        processingMinutes: input.processing?.minutes ?? null,
        catalogVersion: row.catalogVersion + 1,
      })
      .where(eq(service.id, id));
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "service.processing_updated",
      entity: "service",
      entityId: id,
      metadata: { version: row.catalogVersion + 1, processing: input.processing },
    });
    const result = (await listAdminServices(tx)).find((s) => s.id === id);
    if (!result) throw new Error("Missing treatment");
    return result;
  });
}
