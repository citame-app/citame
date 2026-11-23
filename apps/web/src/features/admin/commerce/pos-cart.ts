import type { CatalogPriceReview, CreateCheckoutInput, Service } from "@sob/contracts";
import { inputCents } from "./money";

export interface ReceiptItem {
  key: string;
  kind: "service" | "product" | "custom";
  id?: string;
  name: string;
  priceCents: number;
  catalogPriceReview?: CatalogPriceReview;
  quantity: string;
  available?: number;
  service?: Service;
}

export function extraIsEligible(extra: Service, items: ReceiptItem[]) {
  if (extra.catalog?.kind !== "addon") return true;
  const allowed = extra.catalog.allowedServiceIds;
  return items.some((item) => {
    const base = item.service;
    return (
      base &&
      base.catalog?.kind !== "addon" &&
      (allowed.includes(base.id) ||
        (base.catalog?.kind === "variant" && allowed.includes(base.catalog.parentServiceId)))
    );
  });
}

export function receiptUnitPrice(item: ReceiptItem): number {
  return item.catalogPriceReview?.unitAmountCents ?? item.priceCents;
}

/** Catalog reviews carry the exact price the operator saw before adjusting the item. */
export function receiptInput(
  items: ReceiptItem[],
  discount: string,
  discountType: "fixed" | "percent",
  tip: string,
) {
  const subtotal = items.reduce(
    (sum, item) => sum + receiptUnitPrice(item) * Number(item.quantity),
    0,
  );
  const parsedDiscount = inputCents(discount);
  const tipCents = inputCents(tip);
  const discountCents =
    parsedDiscount === null
      ? null
      : discountType === "percent"
        ? Math.round((subtotal * parsedDiscount) / 10000)
        : parsedDiscount;
  const valid =
    items.length > 0 &&
    items.length <= 100 &&
    Number.isSafeInteger(subtotal) &&
    subtotal <= 2_147_483_647 &&
    items.every(
      (item) =>
        Number.isInteger(Number(item.quantity)) &&
        Number(item.quantity) >= 1 &&
        Number(item.quantity) <= Math.min(1000, item.available ?? 1000) &&
        (!item.service || extraIsEligible(item.service, items)),
    ) &&
    parsedDiscount !== null &&
    (discountType !== "percent" || parsedDiscount <= 10000) &&
    discountCents !== null &&
    discountCents <= subtotal &&
    tipCents !== null &&
    subtotal - discountCents + tipCents <= 999999999;
  const lines: CreateCheckoutInput["lines"] = items.map((item) => {
    const quantity = Number(item.quantity);
    const common = { quantity, taxBasisPoints: 0 };
    if (item.kind === "custom")
      return {
        ...common,
        kind: "custom",
        description: item.name,
        unitAmountCents: item.priceCents,
      };
    const priceReview = item.catalogPriceReview && { catalogPriceReview: item.catalogPriceReview };
    return item.kind === "product"
      ? { ...common, ...priceReview, kind: "product", productId: item.id }
      : { ...common, ...priceReview, kind: "service", serviceId: item.id };
  });
  return {
    valid,
    subtotal,
    discountCents: discountCents ?? 0,
    tipCents: tipCents ?? 0,
    total: subtotal - (discountCents ?? 0) + (tipCents ?? 0),
    lines,
  };
}
