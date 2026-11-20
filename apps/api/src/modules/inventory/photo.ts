import type { ProductPhotoInput } from "@sob/contracts";
import { type Database, retailProductPhoto } from "@sob/db";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { normalizeClientPhoto } from "../clients/photo-image";
import { productRow } from "./service";

export async function readProductPhoto(
  db: Database,
  productId: string,
  version: string,
  principal: Principal,
) {
  requirePermission(principal, "readInventory");
  const [row] = await db
    .select({ image: retailProductPhoto.image })
    .from(retailProductPhoto)
    .where(
      and(eq(retailProductPhoto.productId, productId), eq(retailProductPhoto.version, version)),
    );
  if (!row) throw new DomainError("not_found", "Product photo not found");
  return new Response(new Uint8Array(row.image), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" },
  });
}

export async function saveProductPhoto(
  db: Database,
  productId: string,
  input: ProductPhotoInput,
  principal: Principal,
) {
  requirePermission(principal, "writeInventory");
  await productRow(db, productId);
  const photo = input.imageBase64 ? await normalizeClientPhoto(input.imageBase64) : null;
  return db.transaction(async (tx) => {
    await productRow(tx, productId, true);
    const live = await loadPrincipal(tx, principal.userId);
    if (!live) throw new DomainError("forbidden", "This account is no longer available");
    requirePermission(live, "writeInventory");
    const [current] = await tx
      .select({ version: retailProductPhoto.version })
      .from(retailProductPhoto)
      .where(eq(retailProductPhoto.productId, productId));
    if ((current?.version ?? null) !== input.version)
      throw new DomainError("version_conflict", "The product photo changed. Reload before saving.");
    if (!photo && !current) return { version: null };

    let version: string | null = null;
    if (photo) {
      version = crypto.randomUUID();
      const contents = { version, image: photo.image };
      await tx
        .insert(retailProductPhoto)
        .values({ productId, ...contents })
        .onConflictDoUpdate({ target: retailProductPhoto.productId, set: contents });
    } else {
      await tx.delete(retailProductPhoto).where(eq(retailProductPhoto.productId, productId));
    }
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: photo ? "inventory.product_photo_saved" : "inventory.product_photo_removed",
      entity: "retail_product",
      entityId: productId,
    });
    return { version };
  });
}
