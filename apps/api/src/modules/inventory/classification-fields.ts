import type { InventoryClassificationPatch } from "@sob/contracts";
import { inventoryClassification, type retailProduct } from "@sob/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

type Product = typeof retailProduct.$inferSelect;
type ProductFields = {
  classification?: InventoryClassificationPatch;
  category?: string | null;
  brand?: string | null;
};

export async function lockInventoryClassification(tx: Tx) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('inventory-classification', 0))`,
  );
}

export function hasClassificationChanges(fields: ProductFields) {
  return (
    fields.classification !== undefined ||
    fields.category !== undefined ||
    fields.brand !== undefined
  );
}

async function legacyClassificationId(tx: Tx, kind: "category" | "brand", name: string | null) {
  if (!name?.trim()) return null;
  await tx
    .insert(inventoryClassification)
    .values({ kind, name: name.trim() })
    .onConflictDoNothing();
  const [entry] = await tx
    .select()
    .from(inventoryClassification)
    .where(
      and(
        eq(inventoryClassification.kind, kind),
        isNull(inventoryClassification.parentId),
        sql`lower(${inventoryClassification.name}) = lower(${name.trim()})`,
      ),
    );
  return entry?.active ? entry.id : null;
}

export async function classificationFields(
  tx: Tx,
  fields: ProductFields,
  current?: Product,
): Promise<
  Partial<Pick<Product, "category" | "brand" | "categoryId" | "brandId" | "subcategoryId">>
> {
  const { classification, category, brand } = fields;
  if (!classification) {
    const categoryChanged = category !== undefined && category !== current?.category;
    const brandChanged = brand !== undefined && brand !== current?.brand;
    return {
      ...(categoryChanged
        ? {
            category,
            categoryId: await legacyClassificationId(tx, "category", category),
            subcategoryId: null,
          }
        : {}),
      ...(brandChanged ? { brand, brandId: await legacyClassificationId(tx, "brand", brand) } : {}),
    };
  }
  if (category !== undefined || brand !== undefined)
    throw new DomainError("invalid_state", "Use the catalogue assignment or the original labels");
  const categoryId =
    classification.categoryId === undefined
      ? (current?.categoryId ?? null)
      : classification.categoryId;
  const subcategoryId =
    classification.subcategoryId === undefined
      ? categoryId === current?.categoryId
        ? (current?.subcategoryId ?? null)
        : null
      : classification.subcategoryId;
  const brandId =
    classification.brandId === undefined ? (current?.brandId ?? null) : classification.brandId;
  const requested = [categoryId, subcategoryId, brandId].filter((id) => id !== null);
  const entries = requested.length
    ? await tx
        .select()
        .from(inventoryClassification)
        .where(inArray(inventoryClassification.id, requested))
    : [];
  const root = entries.find(
    (row) => row.id === categoryId && row.kind === "category" && row.parentId === null,
  );
  const child = entries.find(
    (row) =>
      row.id === subcategoryId &&
      row.kind === "category" &&
      row.parentId !== null &&
      row.parentId === categoryId,
  );
  const maker = entries.find((row) => row.id === brandId && row.kind === "brand");
  if (
    (categoryId !== null && (!root || (!root.active && categoryId !== current?.categoryId))) ||
    (subcategoryId !== null &&
      (!child || (!child.active && subcategoryId !== current?.subcategoryId))) ||
    (brandId !== null && (!maker || (!maker.active && brandId !== current?.brandId)))
  )
    throw new DomainError("invalid_state", "Choose active classifications from the catalogue");
  if (root && !root.active && subcategoryId !== current?.subcategoryId && subcategoryId !== null)
    throw new DomainError("invalid_state", "Choose an active parent category for the subcategory");
  return {
    categoryId,
    subcategoryId,
    brandId,
    category:
      classification.categoryId === undefined ||
      (categoryId !== null && categoryId === current?.categoryId)
        ? (current?.category ?? root?.name ?? null)
        : (root?.name ?? null),
    brand:
      classification.brandId === undefined || (brandId !== null && brandId === current?.brandId)
        ? (current?.brand ?? maker?.name ?? null)
        : (maker?.name ?? null),
  };
}
