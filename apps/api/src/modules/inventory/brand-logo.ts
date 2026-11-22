import type { InventoryBrandLogoInput } from "@sob/contracts";
import { type Database, inventoryBrandLogo, inventoryClassification } from "@sob/db";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { normalizeClientPhoto } from "../clients/photo-image";
import { requireCurrentInventoryWriter } from "./service";

export async function readInventoryBrandLogo(
  db: Database,
  id: string,
  version: string,
  principal: Principal,
) {
  requirePermission(principal, "readInventory");
  const [row] = await db
    .select({ image: inventoryBrandLogo.image })
    .from(inventoryBrandLogo)
    .where(and(eq(inventoryBrandLogo.brandId, id), eq(inventoryBrandLogo.version, version)));
  if (!row?.image) throw new DomainError("not_found", "Brand logo not found");
  return new Response(new Uint8Array(row.image), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" },
  });
}

export async function saveInventoryBrandLogo(
  db: Database | Tx,
  id: string,
  input: InventoryBrandLogoInput,
  principal: Principal,
  generation: string,
) {
  requirePermission(principal, "writeInventory");
  if (input.generation !== generation)
    throw new DomainError("sync_generation_changed", "Refresh the brand after a restore");
  const photo = input.imageBase64 ? await normalizeClientPhoto(input.imageBase64) : null;

  return db.transaction(async (tx) => {
    await requireCurrentInventoryWriter(tx, principal.userId);
    const [brand] = await tx
      .select({ id: inventoryClassification.id })
      .from(inventoryClassification)
      .where(and(eq(inventoryClassification.id, id), eq(inventoryClassification.kind, "brand")))
      .for("update");
    if (!brand) throw new DomainError("not_found", "Brand not found");
    const [current] = await tx
      .select({ version: inventoryBrandLogo.version })
      .from(inventoryBrandLogo)
      .where(eq(inventoryBrandLogo.brandId, id));
    if ((current?.version ?? null) !== input.version)
      throw new DomainError("version_conflict", "The brand logo changed. Reload before saving.");
    if (!photo && !current) return null;

    // Preserve a revision after removal so an older draft cannot recreate the logo.
    const version = crypto.randomUUID();
    const contents = { version, image: photo?.image ?? null };
    await tx
      .insert(inventoryBrandLogo)
      .values({ brandId: id, ...contents })
      .onConflictDoUpdate({ target: inventoryBrandLogo.brandId, set: contents });
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: photo ? "inventory.brand_logo_saved" : "inventory.brand_logo_removed",
      entity: "inventory_classification",
      entityId: id,
    });
    return { version, present: photo !== null };
  });
}
