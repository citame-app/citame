import type { InventoryClassificationInput, InventoryClassificationReorder } from "@sob/contracts";
import {
  type Database,
  inventoryBrandLogo,
  inventoryClassification,
  pgErrorCode,
  retailProduct,
} from "@sob/db";
import { and, asc, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockInventoryClassification } from "./classification-fields";
import { requireCurrentInventoryWriter } from "./service";

const classificationOrder = [
  asc(inventoryClassification.position),
  asc(sql`lower(${inventoryClassification.name})`),
  asc(inventoryClassification.id),
] as const;

export async function listInventoryClassifications(
  db: Database,
  principal: Principal,
  generation: string,
) {
  requirePermission(principal, "readInventory");
  const rows = await db
    .select({
      ...getTableColumns(inventoryClassification),
      logoVersion: inventoryBrandLogo.version,
      logoPresent: sql<boolean>`${inventoryBrandLogo.image} is not null`,
    })
    .from(inventoryClassification)
    .leftJoin(inventoryBrandLogo, eq(inventoryBrandLogo.brandId, inventoryClassification.id))
    .orderBy(
      asc(inventoryClassification.kind),
      asc(inventoryClassification.parentId),
      ...classificationOrder,
    );
  const entries = rows.map(({ logoVersion, logoPresent, ...entry }) =>
    logoVersion ? { ...entry, logo: { version: logoVersion, present: logoPresent } } : entry,
  );
  return { entries, generation };
}

export async function saveInventoryClassification(
  db: Database,
  id: string,
  input: InventoryClassificationInput,
  principal: Principal,
  generation: string,
) {
  if (input.generation !== generation)
    throw new DomainError("sync_generation_changed", "Refresh classifications after a restore");
  const { kind, name, parentId, active, position, version } = input;
  try {
    return await db.transaction(async (tx) => {
      const writer = await requireCurrentInventoryWriter(tx, principal.userId);
      await lockInventoryClassification(tx);
      const [current] = await tx
        .select()
        .from(inventoryClassification)
        .where(eq(inventoryClassification.id, id));
      if (
        current?.version === version + 1 &&
        current.kind === kind &&
        current.name === name &&
        current.parentId === parentId &&
        current.active === active &&
        current.position === position
      )
        return current;
      if ((current?.version ?? 0) !== version)
        throw new DomainError(
          "version_conflict",
          "Classification changed; review its current details",
        );
      if (current && current.kind !== kind)
        throw new DomainError("invalid_state", "A category cannot be converted into a brand");
      const parent = parentId
        ? (
            await tx
              .select()
              .from(inventoryClassification)
              .where(eq(inventoryClassification.id, parentId))
          )[0]
        : undefined;
      if (
        parentId &&
        (parentId === id ||
          kind !== "category" ||
          !parent ||
          parent.kind !== "category" ||
          parent.parentId ||
          (active && !parent.active))
      )
        throw new DomainError("invalid_state", "Choose an active top-level category");
      if (current && (parentId !== null || !active)) {
        const [dependent] = await tx
          .select({ id: inventoryClassification.id })
          .from(inventoryClassification)
          .where(
            and(
              eq(inventoryClassification.parentId, id),
              parentId ? undefined : eq(inventoryClassification.active, true),
            ),
          )
          .limit(1);
        if (dependent)
          throw new DomainError("invalid_state", "Move or archive the subcategories first");
      }
      if (current && (current.parentId !== parentId || (current.name !== name && !parentId))) {
        const byCategory = eq(retailProduct.categoryId, id);
        const bySubcategory = eq(retailProduct.subcategoryId, id);
        const byBrand = eq(retailProduct.brandId, id);
        const linked = await tx
          .select({ id: retailProduct.id })
          .from(retailProduct)
          .where(or(byCategory, bySubcategory, byBrand))
          .orderBy(asc(retailProduct.id))
          .for("update");
        if (linked.length && (current.parentId === null) !== (parentId === null))
          throw new DomainError(
            "invalid_state",
            "Reassign linked products before changing category level",
          );
        if (linked.length) {
          const labels =
            kind === "brand"
              ? { brand: name }
              : parent
                ? { categoryId: parent.id, category: parent.name }
                : { category: name };
          await tx
            .update(retailProduct)
            .set({ ...labels, version: sql`${retailProduct.version} + 1` })
            .where(kind === "brand" ? byBrand : parent ? bySubcategory : byCategory);
        }
      }
      const fields = { kind, name, parentId, active, position, version: version + 1 };
      const [saved] = current
        ? await tx
            .update(inventoryClassification)
            .set(fields)
            .where(eq(inventoryClassification.id, id))
            .returning()
        : await tx
            .insert(inventoryClassification)
            .values({ id, ...fields })
            .returning();
      if (!saved) throw new Error("Classification save returned no row");
      await recordAudit(tx, {
        actorUserId: writer.userId,
        action: "inventory.classification_saved",
        entity: "inventory_classification",
        entityId: id,
      });
      return saved;
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505")
      throw new DomainError(
        "invalid_state",
        "This name already exists in the selected catalogue group",
      );
    throw error;
  }
}

export async function reorderInventoryClassifications(
  db: Database,
  input: InventoryClassificationReorder,
  principal: Principal,
  generation: string,
) {
  if (input.generation !== generation)
    throw new DomainError("sync_generation_changed", "Refresh classifications after a restore");
  const { kind, parentId, entries } = input;
  if (
    (kind === "brand" && parentId) ||
    new Set(entries.map(({ id }) => id)).size !== entries.length
  )
    throw new DomainError("validation_error", "Choose distinct classifications in the same group");

  return db.transaction(async (tx) => {
    const writer = await requireCurrentInventoryWriter(tx, principal.userId);
    await lockInventoryClassification(tx);
    const siblings = await tx
      .select({
        id: inventoryClassification.id,
        version: inventoryClassification.version,
        position: inventoryClassification.position,
      })
      .from(inventoryClassification)
      .where(
        and(
          eq(inventoryClassification.kind, kind),
          parentId
            ? eq(inventoryClassification.parentId, parentId)
            : isNull(inventoryClassification.parentId),
        ),
      )
      .orderBy(...classificationOrder);
    const byId = new Map(siblings.map((row) => [row.id, row]));
    if (
      siblings.length !== entries.length ||
      entries.some(({ id, version }) => byId.get(id)?.version !== version)
    )
      throw new DomainError("version_conflict", "The group changed. Review the current order.");
    if (siblings.every(({ id }, index) => entries[index]?.id === id)) return { ok: true as const };
    const changes = entries.flatMap(({ id, version }, position) => {
      if (byId.get(id)?.position === position) return [];
      if (version === 2147483647)
        throw new DomainError("version_conflict", "A classification is at its revision limit");
      return [{ id, position }];
    });
    await tx.execute(sql`
      update inventory_classification as entry
      set position = next.position, version = entry.version + 1
      from jsonb_to_recordset(${JSON.stringify(changes)}::text::jsonb) as next(id uuid, position integer)
      where entry.id = next.id
    `);
    await recordAudit(tx, {
      actorUserId: writer.userId,
      action: "inventory.classifications_reordered",
      entity: "inventory_classification",
      entityId: parentId ?? kind,
      metadata: { kind, moved: changes.length },
    });
    return { ok: true as const };
  });
}
