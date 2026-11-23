import type { CatalogPriceReview, CreateCheckoutInput } from "@sob/contracts";
import { type Database, retailProduct, service, serviceAddon } from "@sob/db";
import { asc, eq, inArray } from "drizzle-orm";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { activeCatalogRows } from "../services/options";

/** Lock variants and their parents in the same order before validating availability. */
export async function checkoutServices(tx: Tx, input: CreateCheckoutInput) {
  const ids = [
    ...new Set(
      input.lines.flatMap((line) =>
        line.kind === "service" && line.serviceId ? [line.serviceId] : [],
      ),
    ),
  ];
  const selected = ids.length
    ? await tx.select().from(service).where(inArray(service.id, ids))
    : [];
  const lockIds = [
    ...new Set([
      ...ids,
      ...selected.flatMap((row) => (row.parentServiceId ? [row.parentServiceId] : [])),
    ]),
  ];
  const rows = lockIds.length
    ? await tx
        .select()
        .from(service)
        .where(inArray(service.id, lockIds))
        .orderBy(asc(service.id))
        .for("share")
    : [];
  const catalog = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = catalog.get(id);
    const parent = row?.parentServiceId ? catalog.get(row.parentServiceId) : null;
    if (
      !row ||
      !row.active ||
      row.deletedAt ||
      row.currency !== input.currency ||
      (row.parentServiceId && (!parent || !parent.active || parent.deletedAt))
    )
      throw new DomainError(
        "validation_error",
        "Choose an active service in the checkout currency",
      );
    if (row.catalogKind === "addon") {
      const allowed = await tx.select().from(serviceAddon).where(eq(serviceAddon.addonId, id));
      if (
        !ids.some((baseId) => {
          const base = catalog.get(baseId);
          return (
            base &&
            base.catalogKind !== "addon" &&
            allowed.some(
              (link) => link.serviceId === base.id || link.serviceId === base.parentServiceId,
            )
          );
        })
      )
        throw new DomainError(
          "validation_error",
          "This extra requires a compatible service in the receipt",
        );
    }
  }
  return catalog;
}

/** Compare the operator's reviewed price with the locked catalog before accepting an adjustment. */
export function reviewedCatalogPrice(currentCents: number, review?: CatalogPriceReview): number {
  if (!review) return currentCents;
  if (review.expectedUnitAmountCents !== currentCents)
    throw new DomainError("version_conflict", "Catalog price changed. Review the item again.");
  return review.unitAmountCents;
}

/** The current comparator used when an operator explicitly reloads a draft price. */
export async function checkoutCatalogPrice(db: Database, kind: "service" | "product", id: string) {
  if (kind === "service") {
    const rows = await db.select().from(service).where(eq(service.id, id));
    const [current] = await activeCatalogRows(db, rows);
    if (
      current?.active &&
      !current.deletedAt &&
      current.currency === "EUR" &&
      current.priceType === "fixed"
    )
      return { unitAmountCents: current.priceCents };
  } else {
    const [current] = await db.select().from(retailProduct).where(eq(retailProduct.id, id));
    if (current?.active && current.resellable && current.currency === "EUR")
      return { unitAmountCents: current.priceCents };
  }
  throw new DomainError("not_found", "Catalog price is no longer available");
}
