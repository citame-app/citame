import type { CreateCheckoutInput } from "@sob/contracts";
import { service, serviceAddon } from "@sob/db";
import { asc, eq, inArray } from "drizzle-orm";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

/** Walk-in receipts use current canonical catalog prices, never browser supplied prices.
 * Lock variants and their parents in the same order before validating availability. */
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
